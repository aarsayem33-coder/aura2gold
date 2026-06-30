// newsReactionTracker.js — PURE, additive, ISOLATED.
//
// After a high-impact release, measure the ACTUAL market reaction mathematically
// from live candles since the event — NOT the textbook fundamental. This answers
// "which pair is actually moving which way right now, after the surprise?" using
// real price, recomputed live (the server calls this every few seconds).
//
// computeNewsReactionTrend returns a deterministic, explainable read:
//   • netMove (pips / %, ATR-normalized) since the release price
//   • linear-regression slope + R² over post-release closes (trend direction + quality)
//   • candle momentum (up vs down candles since release)
//   • fade-from-extreme (how much of the spike has been given back = reversal risk)
//   • a derived live direction (UP / DOWN / NEUTRAL), strength, and confidence
//
// Pure: no I/O. The engine never predicts pre-release; it only reads what already
// happened on the chart.

const round = (v, dp = 2) => {
  const m = 10 ** dp;
  return Math.round(Number(v) * m) / m;
};

// Ordinary least-squares slope + R² of ys against x = 0..k-1.
function linreg(ys) {
  const k = ys.length;
  if (k < 2) return { slope: 0, r2: 0 };
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < k; i++) { sx += i; sy += ys[i]; sxx += i * i; sxy += i * ys[i]; }
  const denom = k * sxx - sx * sx;
  if (denom === 0) return { slope: 0, r2: 0 };
  const slope = (k * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / k;
  const my = sy / k;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < k; i++) {
    const yh = intercept + slope * i;
    ssRes += (ys[i] - yh) ** 2;
    ssTot += (ys[i] - my) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);
  return { slope, r2 };
}

/**
 * @param {object}   p
 * @param {object[]} p.candles  ascending OHLC with ISO `time` (use the finest TF, e.g. M1)
 * @param {number}   p.eventMs  release timestamp (ms)
 * @param {number}   [p.pip]    pip size for the symbol (for pip conversion)
 * @param {number}   [p.atr]    ATR for ATR-normalisation (falls back to a post-release proxy)
 * @param {number}   [p.nowMs]  current time (for elapsed); defaults to Date.now()
 * @param {number}   [p.neutralAtrFrac] move below this × ATR = NEUTRAL (default 0.1)
 * @returns reading | null
 */
export function computeNewsReactionTrend({ candles, eventMs, pip = 0.0001, atr = null, nowMs = Date.now(), neutralAtrFrac = 0.1 }) {
  if (!Array.isArray(candles) || !Number.isFinite(eventMs)) return null;
  const bars = candles
    .map((c) => ({ t: Date.parse(c.time), o: +c.open, h: +c.high, l: +c.low, c: +c.close }))
    .filter((c) => Number.isFinite(c.t) && c.t >= eventMs && [c.o, c.h, c.l, c.c].every(Number.isFinite))
    .sort((a, b) => a.t - b.t);
  if (bars.length < 1) return null;

  // Price at the release ≈ the open of the first post-release candle.
  const releaseClose = bars[0].o;
  const lastClose = bars[bars.length - 1].c;
  const closes = bars.map((b) => b.c);

  // ATR: prefer caller's; else a simple true-range proxy over the post-release bars.
  let atrVal = Number.isFinite(atr) && atr > 0 ? atr : null;
  if (!atrVal) {
    const trs = [];
    for (let i = 1; i < bars.length; i++) {
      trs.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c)));
    }
    atrVal = trs.length ? trs.reduce((a, b) => a + b, 0) / trs.length : (Math.abs(lastClose - releaseClose) || pip * 10);
  }

  const netMove = lastClose - releaseClose;
  const netMovePips = pip > 0 ? netMove / pip : netMove;
  const netMovePct = releaseClose !== 0 ? (netMove / Math.abs(releaseClose)) * 100 : 0;
  const moveAtr = atrVal > 0 ? Math.abs(netMove) / atrVal : 0;

  const { slope, r2 } = linreg(closes);
  const slopeDir = slope > 0 ? 'UP' : slope < 0 ? 'DOWN' : 'FLAT';

  let upCandles = 0, downCandles = 0;
  for (const b of bars) { if (b.c > b.o) upCandles++; else if (b.c < b.o) downCandles++; }

  const high = Math.max(...bars.map((b) => b.h));
  const low = Math.min(...bars.map((b) => b.l));
  const netDir = netMove > 0 ? 'UP' : netMove < 0 ? 'DOWN' : 'FLAT';

  // Fade-from-extreme: how much of the peak move has been retraced (reversal risk).
  let retraceFromExtremePct = 0;
  if (netDir === 'UP' && high > releaseClose) retraceFromExtremePct = ((high - lastClose) / (high - releaseClose)) * 100;
  else if (netDir === 'DOWN' && low < releaseClose) retraceFromExtremePct = ((lastClose - low) / (releaseClose - low)) * 100;
  retraceFromExtremePct = Math.max(0, Math.min(100, retraceFromExtremePct));

  // Direction: NEUTRAL until the move clears a fraction of ATR (filters chop/noise).
  let direction = 'NEUTRAL';
  if (moveAtr >= neutralAtrFrac && netDir !== 'FLAT') direction = netDir;

  let strength = 'WEAK';
  if (moveAtr >= 1.5) strength = 'STRONG';
  else if (moveAtr >= 0.6) strength = 'MODERATE';

  // Confidence: agreement of slope + candle majority, scaled by magnitude and trend
  // quality (R²), penalised when the spike is heavily faded.
  let confidence;
  if (direction !== 'NEUTRAL') {
    confidence = 30;
    if (slopeDir === direction) confidence += 20;
    const candleMajority = direction === 'UP' ? upCandles > downCandles : downCandles > upCandles;
    if (candleMajority) confidence += 15;
    confidence += Math.min(20, Math.round(moveAtr * 10));
    confidence += Math.round(r2 * 15);
    if (retraceFromExtremePct >= 60) confidence -= 15;   // big give-back = unreliable
    confidence = Math.max(10, Math.min(95, confidence));
  } else {
    confidence = Math.max(5, 20 - Math.round(moveAtr * 10));
  }

  const elapsedSec = Math.max(0, Math.round((nowMs - eventMs) / 1000));

  return {
    direction,
    strength,
    confidence,
    netMovePips: round(netMovePips, 1),
    netMovePct: round(netMovePct, 3),
    moveAtr: round(moveAtr, 2),
    slope: round(slope, 6),
    slopeR2: round(r2, 2),
    slopeDir,
    upCandles,
    downCandles,
    totalCandles: bars.length,
    highSinceRelease: round(high, 6),
    lowSinceRelease: round(low, 6),
    retraceFromExtremePct: round(retraceFromExtremePct, 1),
    releaseClose: round(releaseClose, 6),
    lastClose: round(lastClose, 6),
    elapsedSec,
  };
}
