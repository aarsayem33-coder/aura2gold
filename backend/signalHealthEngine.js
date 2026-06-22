// signalHealthEngine.js — pure, deterministic live-trade health for the Signal Tracker.
//
// Given a signal (entry/SL/TP + direction) and live candles, compute where the trade
// stands (pips / R / MFE / MAE / TP-SL touches) and assess its HEALTH — surfacing an
// early "manage" or "close now" recommendation BEFORE the stop is hit. Balanced
// sensitivity. Advisory only — markets gap; this is early warning, not a guarantee.
//
// Pure: no I/O. The server passes in the live `systemDecision`, `breaker`, `newsRisk`,
// and pip size; this module just does math + rules so it can be unit-tested.

const BUY = new Set(['BUY', 'STRONG_BUY']);
const SELL = new Set(['SELL', 'STRONG_SELL']);
function isBuyDir(d) { return BUY.has(String(d || '').toUpperCase()); }
function isSellDir(d) { return SELL.has(String(d || '').toUpperCase()); }
function num(v) { return Number.isFinite(Number(v)) ? Number(v) : null; }
function r2(v) { return v === null ? null : Math.round(v * 100) / 100; }

export const DEFAULT_HEALTH_CONFIG = {
  slProximityR: 0.25,   // within this much of the stop (in R) → CLOSE_NOW
  maxLossR: 0.7,        // unrealized loss at/below -this R → CLOSE_NOW
  givebackMfeR: 1.0,    // had reached at least +this R ...
  givebackNowR: 0.3,    // ... but pulled back to ≤ +this R → protect profit
  horizonHours: 72,
};

// Snapshot: price math + MFE/MAE + which targets/stop were touched since signalTime.
export function computeSnapshot({ direction, entryPrice, stopLoss, takeProfit1, takeProfit2, takeProfit3, candles, pip, signalMs, nowMs = Date.now(), horizonHours = 72 }) {
  const entry = num(entryPrice), sl = num(stopLoss), p = num(pip);
  const buy = isBuyDir(direction);
  const tps = [num(takeProfit1), num(takeProfit2), num(takeProfit3)];
  const list = Array.isArray(candles) ? candles : [];
  const cur = list.length ? num(list[list.length - 1].close) : null;
  if (entry === null || cur === null || !p) {
    return { valid: false, currentPrice: cur };
  }
  const horizonMs = Math.max(1, horizonHours) * 3600 * 1000;
  const fwd = list
    .map((c) => ({ h: num(c.high), l: num(c.low), t: Date.parse(c.time || '') }))
    .filter((c) => c.h !== null && c.l !== null && Number.isFinite(c.t) && c.t >= signalMs && c.t <= signalMs + horizonMs);

  const dir = buy ? 1 : -1;
  const currentPips = ((cur - entry) * dir) / p;
  const riskPips = sl !== null ? Math.abs(entry - sl) / p : null;
  const currentR = riskPips ? currentPips / riskPips : null;

  let mfePips = 0, maePips = 0, tpHit = 0, slHit = false;
  for (const c of fwd) {
    const fav = buy ? (c.h - entry) / p : (entry - c.l) / p;     // favorable excursion
    const adv = buy ? (c.l - entry) / p : (entry - c.h) / p;     // adverse excursion (≤0)
    if (fav > mfePips) mfePips = fav;
    if (adv < maePips) maePips = adv;
    for (let i = 0; i < 3; i++) {
      if (tps[i] === null) continue;
      const hit = buy ? c.h >= tps[i] : c.l <= tps[i];
      if (hit && i + 1 > tpHit) tpHit = i + 1;
    }
    if (sl !== null && (buy ? c.l <= sl : c.h >= sl)) slHit = true;
  }
  const mfeR = riskPips ? mfePips / riskPips : null;
  const maeR = riskPips ? maePips / riskPips : null;

  const distToSlPips = sl !== null ? (buy ? (cur - sl) : (sl - cur)) / p : null;
  const distToTp = tps.map((tp) => tp === null ? null : (buy ? (tp - cur) : (cur - tp)) / p);

  return {
    valid: true,
    currentPrice: cur,
    currentPips: r2(currentPips),
    currentR: r2(currentR),
    riskPips: r2(riskPips),
    mfePips: r2(mfePips), maePips: r2(maePips), mfeR: r2(mfeR), maeR: r2(maeR),
    tpHit, slHit,
    distToSlPips: r2(distToSlPips),
    distToTp1Pips: r2(distToTp[0]), distToTp2Pips: r2(distToTp[1]), distToTp3Pips: r2(distToTp[2]),
  };
}

// Estimated unrealized money (advisory) from pips × pip-value × lots. If lots/pipValue
// are unknown, returns null (we never fake a dollar figure).
export function estimateProfit({ currentPips, pipValuePerLot = null, lots = null }) {
  if (currentPips === null || pipValuePerLot === null || lots === null) return null;
  return Math.round(currentPips * pipValuePerLot * lots * 100) / 100;
}

// Health assessment. Returns the highest-severity finding plus the overall status.
// severity: 0 healthy · 1 caution · 2 danger · 3 close-now. `freshDecision` is the live
// systemDecision for the symbol/TF; `breaker` from liquidityEngine.detectBreaker; newsRisk
// from the signal engine ({ block, caution, reason }).
export function evaluateSignalHealth({ snapshot, direction, freshDecision = null, breaker = null, newsRisk = null, config = DEFAULT_HEALTH_CONFIG }) {
  const cfg = { ...DEFAULT_HEALTH_CONFIG, ...config };
  const buy = isBuyDir(direction);
  const findings = [];
  const add = (severity, alertType, reason, action) => findings.push({ severity, alertType, reason, action });

  if (!snapshot || !snapshot.valid) {
    return { status: 'OPEN', riskState: 'UNKNOWN', severity: 0, warningReason: 'Insufficient data', suggestedAction: 'Monitor', alertType: null, findings: [] };
  }
  const { currentR, mfeR, tpHit, slHit } = snapshot;

  // Terminal states first.
  if (slHit) add(3, 'stopped', 'Stop loss has been hit', 'Trade is closed at the stop');
  if (tpHit >= 1) add(tpHit >= 2 ? 1 : 1, 'tp_hit', `Take-profit ${tpHit} reached`, 'Take partial / move stop to break-even / trail');

  // ── Danger rules (Balanced) ─────────────────────────────────────────────────
  // CLOSE-NOW tier
  if (currentR !== null && currentR <= -(1 - cfg.slProximityR)) {
    add(3, 'sl_proximity', `Price within ${cfg.slProximityR}R of the stop (now ${currentR}R)`, 'Close now or let the stop do its job — do not widen it');
  }
  if (currentR !== null && currentR <= -cfg.maxLossR && currentR > -(1 - cfg.slProximityR)) {
    add(3, 'max_loss', `Unrealized loss reached ${currentR}R`, 'Cut the trade — it is past the loss budget');
  }
  if (freshDecision) {
    const dec = String(freshDecision.decision || 'HOLD').toUpperCase();
    if ((buy && isSellDir(dec)) || (!buy && isBuyDir(dec))) {
      add(3, 'opposite_signal', `System is now signalling ${dec} against your ${buy ? 'BUY' : 'SELL'}`, 'Strong reversal signal — close the trade');
    }
  }
  if (newsRisk && newsRisk.block) {
    add(3, 'news_block', `High-impact news imminent${newsRisk.reason ? `: ${newsRisk.reason}` : ''}`, 'Close or de-risk before the release (whipsaw risk)');
  }
  if (breaker && breaker.type && breaker.displacement && breaker.displacement.present) {
    const counter = (buy && breaker.type === 'BEARISH') || (!buy && breaker.type === 'BULLISH');
    if (counter) add(3, 'counter_breaker', `Opposite breaker with displacement (${breaker.type})`, 'Institutional momentum flipped against you — close');
  }

  // DANGER tier
  if (mfeR !== null && currentR !== null && mfeR >= cfg.givebackMfeR && currentR <= cfg.givebackNowR && currentR > -cfg.maxLossR) {
    add(2, 'giveback', `Gave back profit — peaked +${mfeR}R, now ${currentR}R`, 'Protect profit: move stop to break-even or take partial');
  }
  if (freshDecision && freshDecision.htfBias) {
    const htf = String(freshDecision.htfBias).toUpperCase();
    if ((buy && htf === 'BEARISH') || (!buy && htf === 'BULLISH')) {
      add(2, 'htf_flip', `Higher-timeframe bias flipped ${htf} against the trade`, 'Tighten stop or scale out');
    }
  }

  // CAUTION tier
  if (freshDecision && freshDecision.premiumDiscount && freshDecision.premiumDiscount.zone) {
    const z = freshDecision.premiumDiscount.zone;
    if ((buy && z === 'PREMIUM') || (!buy && z === 'DISCOUNT')) {
      add(1, 'pd_unfavorable', `Price now in ${z} (against ${buy ? 'a long' : 'a short'})`, 'Be cautious — do not add; consider partial');
    }
  }
  if (freshDecision && Array.isArray(freshDecision.candlePatterns)) {
    const against = freshDecision.candlePatterns.find((c) => {
      const d = String(c.direction || '').toLowerCase();
      return (c.strength >= 0.75) && ((buy && d === 'bearish') || (!buy && d === 'bullish'));
    });
    if (against) add(1, 'reversal_candle', `Reversal candle against the trade (${against.name})`, 'Watch closely; tighten risk');
  }

  // Resolve the highest-severity finding.
  findings.sort((a, b) => b.severity - a.severity);
  const top = findings[0] || { severity: 0, alertType: null, reason: 'On track', action: 'Hold and let it work' };

  let status;
  if (slHit) status = 'STOPPED';
  else if (tpHit >= 3) status = 'TP3_HIT';
  else if (tpHit === 2) status = 'TP2_HIT';
  else if (tpHit === 1) status = 'TP1_HIT';
  else if (top.severity >= 3) status = 'CLOSE_NOW';
  else if (top.severity === 2) status = 'DANGER';
  else status = 'OPEN';

  const riskState = top.severity >= 3 ? 'CLOSE_NOW' : top.severity === 2 ? 'DANGER' : top.severity === 1 ? 'CAUTION' : 'HEALTHY';

  return {
    status,
    riskState,
    severity: top.severity,
    warningReason: top.reason,
    suggestedAction: top.action,
    alertType: top.alertType,
    findings,
  };
}
