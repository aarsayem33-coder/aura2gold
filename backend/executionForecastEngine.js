// Execution Forecast engine (deterministic, no I/O, no AI).
//
// Predicts WHEN a favorable-but-not-yet-executable setup is likely to become
// executable. It consumes the `systemDecision` produced by aggregateSignals()
// (the same brain the live scanner uses) so there is zero scoring drift between
// the live path and this forecaster.
//
// Honesty contract (see memory: execution-forecast-engine / quality-not-quantity):
//   * Every ETA traces to a NAMED cause (forecast_basis) — no black box.
//   * forecast_confidence is an explicit *model estimate* here. Phase 5's
//     calibration layer is what replaces it with a measured number. Until then
//     the UI must label it "uncalibrated".
//   * No "100%" / guarantee anywhere.

export const FORECAST_TIMEFRAMES = ['M5', 'M15', 'M30', 'H1', 'H4', 'D1'];

// Composite score (0-100) below which a symbol/tf is not even worth forecasting.
export const WATCH_FLOOR = 45;
// Composite score at/above which a setup is considered executable-grade.
export const EXECUTABLE_SCORE = 70;

export function timeframeSeconds(tf) {
  const t = String(tf || '').toUpperCase();
  const map = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 };
  return map[t] || 300;
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const round1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);

// ── Sub-scores (0-100), all null-safe ──────────────────────────────────────

// Trend strength from ADX (ADX rarely exceeds ~50 in FX/gold; map 0..50 -> 0..100).
export function trendStrengthScore(systemDecision) {
  const adx = systemDecision?.adxValue;
  if (!Number.isFinite(adx)) return null;
  return round1(clamp((adx / 50) * 100, 0, 100));
}

// Momentum: how decisively the latest candle is pushing in the signal direction.
// Built from body dominance, close position within range, and EMA distance.
export function momentumScore(systemDecision) {
  const f = systemDecision?.features;
  if (!f || !f.valid) return null;
  const body = Number.isFinite(f.bodyPct) ? f.bodyPct : 0;                 // 0..100
  const closePos = Number.isFinite(f.closePosition) ? f.closePosition : 0.5; // 0..1
  const emaDist = Number.isFinite(f.emaDistanceAtr) ? Math.abs(f.emaDistanceAtr) : 0; // ATR units
  // Weighted blend; emaDist saturates around 2 ATR.
  const blended = body * 0.4 + Math.abs(closePos - 0.5) * 2 * 100 * 0.3 + clamp(emaDist / 2, 0, 1) * 100 * 0.3;
  return round1(clamp(blended, 0, 100));
}

// Volatility: current candle range vs ATR. ~1.0 is normal; >1.6 is expansion.
export function volatilityScore(systemDecision) {
  const f = systemDecision?.features;
  if (!f || !f.valid || !Number.isFinite(f.rangeVsAtr)) return null;
  return round1(clamp((f.rangeVsAtr / 2) * 100, 0, 100));
}

// Liquidity proxy: current volume vs trailing-20 average. Null when no volume feed.
export function liquidityScore(systemDecision) {
  const f = systemDecision?.features;
  if (!f || !f.valid || !Number.isFinite(f.volumeRatio)) return null;
  return round1(clamp((f.volumeRatio / 2) * 100, 0, 100));
}

// ── Session helpers (UTC). Used when a setup is waiting on session liquidity. ──

const SESSION_OPENS_UTC = [
  { name: 'London', hour: 7 },
  { name: 'New York', hour: 12 },
];

export function nextSessionOpen(nowMs) {
  let best = null;
  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    for (const s of SESSION_OPENS_UTC) {
      const d = new Date(nowMs);
      d.setUTCHours(s.hour, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() + dayOffset);
      const ms = d.getTime();
      if (ms > nowMs && (!best || ms < best.ms)) best = { ms, name: s.name };
    }
  }
  return best;
}

// ── Execution classification ────────────────────────────────────────────────

export function classifyExecution(systemDecision) {
  const score = Number(systemDecision?.confidence) || 0;       // 0-100
  const decision = String(systemDecision?.decision || 'HOLD').toUpperCase();
  const instruction = systemDecision?.entryTimingInstruction;

  let currentStatus;
  if (score >= EXECUTABLE_SCORE) currentStatus = 'Good Condition';
  else if (score >= WATCH_FLOOR) currentStatus = 'Building';
  else currentStatus = 'Weak';

  const executableNow = decision !== 'HOLD' && instruction === 'IMMEDIATE_ENTRY' && score >= EXECUTABLE_SCORE;
  return {
    currentStatus,
    executionStatus: executableNow ? 'EXECUTABLE' : 'NOT_EXECUTABLE',
    isCandidate: score >= WATCH_FLOOR, // below the watch floor we don't forecast at all
  };
}

// ── ETA forecasting — always returns a named basis ───────────────────────────
//
// prevForecast (optional) is the same engine's previous output for this
// symbol|tf; it lets us measure score slope for the SCORE_SLOPE basis.
export function forecastEta({ systemDecision, timeframe, nowMs, prevForecast = null, scanIntervalMs = null, newsEvent = null, newsPreWindowMs = 15 * 60 * 1000 }) {
  const score = Number(systemDecision?.confidence) || 0;
  const instruction = systemDecision?.entryTimingInstruction;
  const trigger = systemDecision?.entryTrigger;
  const tfSec = timeframeSeconds(timeframe);
  const remainingSec = Number.isFinite(systemDecision?.remainingSeconds) ? systemDecision.remainingSeconds : null;

  // 0. High-impact news imminent → anchor the ETA to the event time. A looming
  //    release dominates timing (you don't enter blind into it), so this takes
  //    priority over the candle/score bases below.
  if (newsEvent && Number.isFinite(newsEvent.timestampUtc)) {
    const dt = newsEvent.timestampUtc - nowMs;
    if (dt >= 0 && dt <= newsPreWindowMs) {
      return { etaMs: newsEvent.timestampUtc, basis: 'NEWS', reason: `${newsEvent.currency} ${newsEvent.title} at event time — volatility expected; trade the reaction, not a pre-guess.` };
    }
  }

  // 1. Already executable → now.
  if (instruction === 'IMMEDIATE_ENTRY' && score >= EXECUTABLE_SCORE) {
    return { etaMs: nowMs, basis: 'IMMEDIATE', reason: 'Entry window is open now.' };
  }

  // 2. Waiting for the current candle to close.
  if (instruction === 'WAIT_FOR_NEXT_CANDLE') {
    const ms = nowMs + (remainingSec !== null ? remainingSec * 1000 : tfSec * 1000);
    return { etaMs: ms, basis: 'NEXT_CANDLE', reason: `Next ${timeframe} candle open in ~${Math.round((ms - nowMs) / 1000)}s.` };
  }

  // 3. Awaiting a pullback to the entry zone (limit-style). Pullbacks on the
  //    signal timeframe typically resolve within ~1-2 bars; estimate 1.5 bars.
  if (instruction === 'WAIT_FOR_PULLBACK' || trigger === 'LIMIT_PULLBACK') {
    const ms = nowMs + Math.round(tfSec * 1.5) * 1000;
    return { etaMs: ms, basis: 'PULLBACK', reason: `Awaiting pullback to entry zone (~1-2 ${timeframe} bars).` };
  }

  // 4. Score is climbing toward the executable threshold — project the crossing.
  if (prevForecast && Number.isFinite(prevForecast.setupScore)) {
    const slope = score - prevForecast.setupScore; // points per scan interval
    if (slope > 0.5 && score < EXECUTABLE_SCORE) {
      const intervalMs = scanIntervalMs || (prevForecast.scanTimeMs ? Math.max(60000, nowMs - prevForecast.scanTimeMs) : 3600000);
      const scansNeeded = (EXECUTABLE_SCORE - score) / slope;
      const ms = nowMs + Math.round(scansNeeded * intervalMs);
      return { etaMs: ms, basis: 'SCORE_SLOPE', reason: `Setup score rising (+${round1(slope)}/scan); projected to cross ${EXECUTABLE_SCORE} threshold.` };
    }
  }

  // 5. Favorable but flat/below — wait for the next session's liquidity.
  const sess = nextSessionOpen(nowMs);
  if (sess) {
    return { etaMs: sess.ms, basis: 'SESSION', reason: `Awaiting ${sess.name} session liquidity.` };
  }

  return { etaMs: null, basis: 'UNKNOWN', reason: 'No deterministic execution path yet.' };
}

// ── Confidence model (HONEST: model estimate, uncalibrated) ──────────────────

// How likely the setup is to actually fire (not timing — readiness).
export function executionProbability(systemDecision) {
  const score = Number(systemDecision?.confidence) || 0;
  const trend = trendStrengthScore(systemDecision);
  const mom = momentumScore(systemDecision);
  const parts = [score];
  if (trend !== null) parts.push(trend);
  if (mom !== null) parts.push(mom);
  return round1(parts.reduce((s, v) => s + v, 0) / parts.length);
}

// Confidence in the TIMING estimate, keyed off how deterministic the basis is.
export function timingConfidence(basis) {
  switch (basis) {
    case 'IMMEDIATE': return 95;
    case 'NEXT_CANDLE': return 85;
    case 'NEWS': return 80;   // event time is a known clock fact (timing only — NOT direction)
    case 'PULLBACK': return 60;
    case 'SCORE_SLOPE': return 55;
    case 'SESSION': return 45;
    default: return 25;
  }
}

// ── Top-level builder ────────────────────────────────────────────────────────
//
// Returns a plain forecast object, or null if the symbol/tf isn't worth a
// forecast right now. prevForecast is this engine's previous output for the
// same symbol|tf (for score_change + slope).
export function buildForecast({ symbol, timeframe, systemDecision, nowMs = Date.now(), prevForecast = null, scanIntervalMs = null, newsEvent = null, newsPreWindowMs = 15 * 60 * 1000 }) {
  if (!systemDecision) return null;
  const cls = classifyExecution(systemDecision);
  if (!cls.isCandidate) return null;

  const score = round1(Number(systemDecision.confidence) || 0);
  const eta = forecastEta({ systemDecision, timeframe, nowMs, prevForecast, scanIntervalMs, newsEvent, newsPreWindowMs });
  const newsImminent = !!(newsEvent && Number.isFinite(newsEvent.timestampUtc) && (newsEvent.timestampUtc - nowMs) >= 0 && (newsEvent.timestampUtc - nowMs) <= newsPreWindowMs);
  const prevScore = prevForecast && Number.isFinite(prevForecast.setupScore) ? prevForecast.setupScore : null;
  const scoreChange = prevScore !== null ? round1(score - prevScore) : null;

  // Directional lean: the committed decision once gates pass, otherwise the
  // raw buyScore-vs-sellScore tilt so the UI can show which way a still-Building
  // setup is leaning BEFORE it is executable. This is a LEAN, not a signal.
  const decision = String(systemDecision.decision || 'HOLD').toUpperCase();
  const buyScore = Number(systemDecision.buyScore) || 0;
  const sellScore = Number(systemDecision.sellScore) || 0;
  const lean = decision !== 'HOLD'
    ? (decision.includes('SELL') ? 'SELL' : 'BUY')
    : (buyScore > sellScore ? 'BUY' : sellScore > buyScore ? 'SELL' : 'NEUTRAL');
  const leanConviction = Number.isFinite(systemDecision.netConviction)
    ? round1(systemDecision.netConviction)
    : round1(Math.abs(buyScore - sellScore));

  return {
    id: `fc:${String(symbol).toUpperCase()}|${String(timeframe).toUpperCase()}`,
    symbol: String(symbol).toUpperCase(),
    timeframe: String(timeframe).toUpperCase(),
    scanTimeMs: nowMs,
    currentStatus: cls.currentStatus,
    executionStatus: cls.executionStatus,
    decision,
    lean,
    leanConviction,
    regime: systemDecision.regime || null,
    setupScore: score,
    scoreChange,
    trendStrength: trendStrengthScore(systemDecision),
    momentum: momentumScore(systemDecision),
    volatility: volatilityScore(systemDecision),
    liquidity: liquidityScore(systemDecision),
    executionProbability: executionProbability(systemDecision),
    forecastConfidence: timingConfidence(eta.basis),
    forecastBasis: eta.basis,
    expectedExecutionMs: eta.etaMs,
    reason: eta.reason,
    entryPrice: Number.isFinite(systemDecision.entryPrice) ? systemDecision.entryPrice : null,
    stopLoss: Number.isFinite(systemDecision.stopLoss) ? systemDecision.stopLoss : null,
    takeProfit1: Number.isFinite(systemDecision.takeProfit1) ? systemDecision.takeProfit1 : null,
    // News awareness (timing only): is a high-impact event imminent for this symbol?
    newsImminent,
    newsEvent: newsEvent ? { title: newsEvent.title, currency: newsEvent.currency, impact: newsEvent.impact, timeIso: newsEvent.timeIso || (Number.isFinite(newsEvent.timestampUtc) ? new Date(newsEvent.timestampUtc).toISOString() : null) } : null,
    newsTier: null,
    // Calibration is NOT done here — this confidence is a labeled model estimate.
    calibrated: false,
  };
}

// ── Reforecast: compare a fresh forecast against the stored one ──────────────
//
// Returns { status, reason, prevExecutionMs, reforecastCount } describing the
// transition. Pure — the caller persists the result.
export function reforecast(stored, fresh) {
  const prevEta = stored?.expectedExecutionMs ?? null;
  const newEta = fresh?.expectedExecutionMs ?? null;
  const count = (stored?.reforecastCount || 0);

  // Setup decayed below the watch floor / no path → cancelled.
  if (!fresh || newEta === null) {
    return { status: 'CANCELLED', reason: 'Execution conditions no longer achievable.', prevExecutionMs: prevEta, reforecastCount: count + 1 };
  }
  // Became executable / score crossed threshold → ready — but ONLY with a
  // committed BUY/SELL direction. A high score with decision=HOLD (a precision
  // gate still blocking) is NOT actionable, so it must not be announced READY.
  const hasDirection = fresh.decision && fresh.decision !== 'HOLD';
  if (hasDirection && (fresh.executionStatus === 'EXECUTABLE' || fresh.setupScore >= EXECUTABLE_SCORE)) {
    return { status: 'READY', reason: 'Setup is ready to execute.', prevExecutionMs: prevEta, reforecastCount: count };
  }
  // ETA pushed materially later (> 1 bar of the timeframe) → delayed.
  if (prevEta !== null && newEta - prevEta > timeframeSeconds(fresh.timeframe) * 1000) {
    return { status: 'DELAYED', reason: fresh.reason || 'Conditions weakened; execution pushed later.', prevExecutionMs: prevEta, reforecastCount: count + 1 };
  }
  // Otherwise still on track.
  return { status: 'FORECASTED', reason: fresh.reason, prevExecutionMs: prevEta, reforecastCount: count };
}

// ── News reaction detector (two-tier) ────────────────────────────────────────
//
// HONEST: this reacts to ACTUAL post-release price, it never predicts the number.
//   Tier A = the first decisive closed candle after the event (the spike) —
//            aggressive, exposed to spread/whipsaw.
//   Tier B = 2+ candles confirming the same direction (the follow-through) —
//            higher quality. Direction comes from PRICE, not a guess.
// `surpriseBias` (optional 'BULLISH'|'BEARISH'|null) only upgrades confidence
// when it agrees with the price reaction; it is never required.
export function detectNewsReaction({ candles, eventMs, postWindowMs = 10 * 60 * 1000, minBodyPct = 0.5, surpriseBias = null }) {
  if (!candles || !candles.length || !Number.isFinite(eventMs)) return null;
  const bars = candles
    .map((c) => ({ t: Date.parse(c.time), o: +c.open, h: +c.high, l: +c.low, c: +c.close }))
    .filter((c) => Number.isFinite(c.t) && c.t >= eventMs && c.t <= eventMs + postWindowMs && [c.o, c.h, c.l, c.c].every(Number.isFinite))
    .sort((a, b) => a.t - b.t);
  if (!bars.length) return null;

  const decisiveDir = (c) => {
    const rng = c.h - c.l;
    if (rng <= 0) return null;
    if (Math.abs(c.c - c.o) / rng < minBodyPct) return null; // not decisive enough
    return c.c > c.o ? 'BUY' : 'SELL';
  };
  const first = bars[0];
  const firstDir = decisiveDir(first);
  if (!firstDir) return null; // no decisive reaction yet

  const surpriseAgrees = (surpriseBias === 'BULLISH' && firstDir === 'BUY') || (surpriseBias === 'BEARISH' && firstDir === 'SELL');

  // Tier B — 2+ confirming candles in the same direction, last close extends the move.
  if (bars.length >= 2) {
    const sameDir = bars.filter((c) => (c.c - c.o > 0 ? 'BUY' : 'SELL') === firstDir).length;
    const last = bars[bars.length - 1];
    const extended = firstDir === 'BUY' ? last.c >= first.c : last.c <= first.c;
    if (sameDir >= 2 && extended) {
      return { tier: 'B', direction: firstDir, reactionMs: first.t, candles: bars.length, surpriseAgrees };
    }
  }
  // Tier A — decisive first candle only (the spike).
  return { tier: 'A', direction: firstDir, reactionMs: first.t, candles: bars.length, surpriseAgrees };
}

function atr14(candles) {
  const d = (candles || []).slice(-15).map((c) => ({ h: +c.high, l: +c.low, c: +c.close })).filter((c) => [c.h, c.l, c.c].every(Number.isFinite));
  if (d.length < 2) return null;
  let sum = 0, n = 0;
  for (let i = 1; i < d.length; i++) {
    const tr = Math.max(d[i].h - d[i].l, Math.abs(d[i].h - d[i - 1].c), Math.abs(d[i].l - d[i - 1].c));
    sum += tr; n++;
  }
  return n ? sum / n : null;
}

// ATR-based trade levels for a news-reaction entry (the live engine refuses to
// trade into news, so the reaction needs its own volatility-scaled plan).
export function buildNewsReactionLevels({ candles, direction }) {
  if (!candles || !candles.length) return null;
  const entry = Number(candles[candles.length - 1].close);
  const atr = atr14(candles);
  if (!Number.isFinite(entry) || !atr || atr <= 0) return null;
  const dir = direction === 'BUY' ? 1 : -1;
  const r = (n) => Math.round((entry + dir * n * atr) * 1e6) / 1e6;
  return { entry, stopLoss: r(-1.5), takeProfit1: r(1.5), takeProfit2: r(3), takeProfit3: r(4.5), riskRewardRatio: 1, atr: Math.round(atr * 1e6) / 1e6 };
}
