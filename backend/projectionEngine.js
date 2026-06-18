// ─────────────────────────────────────────────────────────────────────────
// projectionEngine.js — Pullback Level & Timing Projection (deterministic math)
//
// This engine answers a forward-looking question the other engines don't:
//   "Where is the next high-probability pullback ENTRY zone, and roughly WHEN
//    will price reach it?"
//
// It is 100% deterministic (no AI). It scans for unmitigated Order Blocks (OB)
// and open Fair Value Gaps (FVG), measures the distance from current price to
// the proximal edge of each zone, and divides by the per-candle volatility
// (ATR) to estimate how many candles — and therefore how many minutes — it
// should take for price to travel there.
//
//   N (candles) = Distance / ATR
//   Minutes     = N × timeframe-minutes
//   TargetTime  = now + Minutes
//
// The optional Gemini layer (geminiEngine.analyzeProjectionWithGemini) is the
// ONLY place AI is involved, and it only runs when the user explicitly asks
// for it. This module never calls out to anything.
// ─────────────────────────────────────────────────────────────────────────

import {
  calculateATR,
  calculateEMA,
  detectFVGs,
  detectOrderBlocks,
  timeframeToMs,
} from './signalEngine.js';

/** Map an MT5 timeframe label to its bar length in minutes. */
function timeframeToMinutes(tf) {
  return timeframeToMs(tf) / 60000;
}

/** Pip / point size used to express distances in human-friendly "pips". */
function pipSize(symbol) {
  const s = String(symbol).toUpperCase();
  if (/XAU|GOLD/.test(s)) return 0.1;   // 1.00 move = 10 pips
  if (/XAG/.test(s)) return 0.01;
  if (/JPY/.test(s)) return 0.01;
  if (/BTC|ETH/.test(s)) return 1.0;
  return 0.0001;
}

function digitsFor(symbol) {
  const s = String(symbol).toUpperCase();
  return /XAU|GOLD|XAG/.test(s) ? 2 : /JPY/.test(s) ? 3 : 5;
}

/** Sensible ATR fallback when a series is too short to compute one. */
function fallbackAtr(symbol) {
  const s = String(symbol).toUpperCase();
  if (/XAU|GOLD/.test(s)) return 2.5;
  if (/JPY/.test(s)) return 0.25;
  return 0.0015;
}

/**
 * Higher-timeframe directional bias from EMA stacking.
 * Returns 'BULLISH' | 'BEARISH' | 'NEUTRAL'.
 */
function trendFrom(candles) {
  if (!candles || candles.length < 15) return 'NEUTRAL';
  if (candles.length >= 50) {
    const fast = calculateEMA(candles, 20);
    const slow = calculateEMA(candles, 50);
    if (fast !== null && slow !== null) {
      return fast > slow ? 'BULLISH' : fast < slow ? 'BEARISH' : 'NEUTRAL';
    }
  }
  const fast = calculateEMA(candles, 5);
  const slow = calculateEMA(candles, 15);
  if (fast !== null && slow !== null) {
    return fast > slow ? 'BULLISH' : fast < slow ? 'BEARISH' : 'NEUTRAL';
  }
  return 'NEUTRAL';
}

/** Candles that formed strictly after `zoneTime`. */
function candlesAfter(candles, zoneTime) {
  const t0 = Date.parse(zoneTime);
  if (Number.isNaN(t0)) return [];
  return candles.filter((c) => Date.parse(c.time) > t0);
}

/**
 * A zone is "unmitigated" if, since it formed, price has NOT yet traded back
 * into it. That makes it a *future* target — the basis of a pullback entry.
 *   • Bullish zone (sits below price): mitigated once a later low pierces its top edge.
 *   • Bearish zone (sits above price): mitigated once a later high pierces its bottom edge.
 */
function isUnmitigated(zone, candles) {
  const later = candlesAfter(candles, zone.time);
  if (!later.length) return true; // just formed — nothing has touched it yet
  if (zone.type === 'BULLISH') {
    const minLow = Math.min(...later.map((c) => Number(c.low)).filter((v) => !Number.isNaN(v)));
    return minLow > zone.top;
  }
  const maxHigh = Math.max(...later.map((c) => Number(c.high)).filter((v) => !Number.isNaN(v)));
  return maxHigh < zone.bottom;
}

/** Recommend an FTT expiry bucket large enough to cover the projected travel time. */
const FTT_LADDER = [
  { min: 2, label: '2m' },
  { min: 3, label: '3m' },
  { min: 5, label: '5m' },
  { min: 15, label: '15m' },
  { min: 30, label: '30m' },
  { min: 60, label: '1h' },
];
function recommendFttExpiry(minutesToReach) {
  // Need time to REACH the zone plus a little room for the reversal to play out.
  const needed = minutesToReach * 1.25;
  for (const bucket of FTT_LADDER) {
    if (bucket.min >= needed) return bucket.label;
  }
  return '1h';
}

/**
 * Build a single deterministic projection from a candidate zone.
 * Returns null if the zone isn't a valid forward pullback target.
 */
function buildProjection({ zone, source, currentClose, atr, symbol, timeframe, htfTrend, nowMs }) {
  const digits = digitsFor(symbol);
  const pip = pipSize(symbol);
  const tfMinutes = timeframeToMinutes(timeframe);

  let entryPrice;
  let bias;          // BULLISH = expect bounce UP, BEARISH = expect reversal DOWN
  let orderType;
  let directionAfterTouch;

  if (zone.type === 'BULLISH') {
    // Bullish zone must sit BELOW current price to be a buy-limit pullback target.
    if (!(zone.top < currentClose)) return null;
    entryPrice = zone.top;            // proximal edge price reaches first on the way down
    bias = 'BULLISH';
    orderType = 'BUY_LIMIT';
    directionAfterTouch = 'UP';
  } else {
    // Bearish zone must sit ABOVE current price to be a sell-limit pullback target.
    if (!(zone.bottom > currentClose)) return null;
    entryPrice = zone.bottom;
    bias = 'BEARISH';
    orderType = 'SELL_LIMIT';
    directionAfterTouch = 'DOWN';
  }

  const distance = Math.abs(currentClose - entryPrice);
  if (distance <= 0) return null;

  const candlesToReach = distance / atr;
  // Ignore zones that are absurdly far away (noise) — keep within a tradable horizon.
  if (candlesToReach > 200) return null;

  const minutesToReach = candlesToReach * tfMinutes;
  const projectedTouchMs = nowMs + minutesToReach * 60 * 1000;

  // Risk model: stop just beyond the far edge of the zone; targets at fixed R multiples.
  let stopLoss;
  let risk;
  if (bias === 'BULLISH') {
    stopLoss = zone.bottom - 0.3 * atr;
    risk = entryPrice - stopLoss;
  } else {
    stopLoss = zone.top + 0.3 * atr;
    risk = stopLoss - entryPrice;
  }
  const takeProfit1 = bias === 'BULLISH' ? entryPrice + risk : entryPrice - risk;
  const takeProfit2 = bias === 'BULLISH' ? entryPrice + 2 * risk : entryPrice - 2 * risk;
  const riskReward = 2.0;

  // Forex limit order makes sense when the higher-timeframe bias agrees with the bounce.
  const forexSuitable =
    (bias === 'BULLISH' && htfTrend === 'BULLISH') ||
    (bias === 'BEARISH' && htfTrend === 'BEARISH');

  // ── Deterministic confidence ──
  let mathConfidence = 40;
  if (forexSuitable) mathConfidence += 25;          // aligned with the trend
  else if (htfTrend === 'NEUTRAL') mathConfidence += 8;
  mathConfidence += source === 'OB' ? 12 : 6;        // OBs are stronger than raw FVGs
  if (candlesToReach >= 0.5 && candlesToReach <= 20) mathConfidence += 15; // reachable soon
  else if (candlesToReach > 60) mathConfidence -= 12;                       // too far out
  mathConfidence = Math.max(5, Math.min(95, Math.round(mathConfidence)));

  let grade = 'C Setup';
  if (mathConfidence >= 80) grade = 'A+ Setup';
  else if (mathConfidence >= 70) grade = 'A Setup';
  else if (mathConfidence >= 55) grade = 'B Setup';

  const rationale =
    `${source === 'OB' ? 'Unmitigated Order Block' : 'Open Fair Value Gap'} ` +
    `(${bias}) at ${entryPrice.toFixed(digits)}. Price is ${(distance / pip).toFixed(1)} pips away; ` +
    `at ${atr.toFixed(digits)} ATR/candle that is ~${candlesToReach.toFixed(1)} ${timeframe} candles ` +
    `(~${Math.round(minutesToReach)} min). Higher-timeframe bias is ${htfTrend}` +
    `${forexSuitable ? ' (aligned — valid Forex limit).' : ' (use caution / FTT only).'}`;

  return {
    id: `${symbol}|${timeframe}|${source}|${bias}|${entryPrice.toFixed(digits)}`,
    symbol,
    timeframe,
    source,                       // 'OB' | 'FVG'
    bias,                         // 'BULLISH' | 'BEARISH'
    orderType,                    // 'BUY_LIMIT' | 'SELL_LIMIT'
    directionAfterTouch,          // 'UP' | 'DOWN'
    currentPrice: currentClose,
    entryPrice,
    zoneTop: zone.top,
    zoneBottom: zone.bottom,
    formedAt: zone.time,
    distance,
    distancePips: distance / pip,
    atr,
    candlesToReach,
    minutesToReach,
    projectedTouchMs,
    projectedTouchIso: new Date(projectedTouchMs).toISOString(),
    stopLoss,
    takeProfit1,
    takeProfit2,
    riskReward,
    suitability: {
      forex: forexSuitable,
      ftt: true,
      fttExpiry: recommendFttExpiry(minutesToReach),
    },
    mathConfidence,
    grade,
    rationale,
  };
}

/**
 * Compute deterministic pullback projections for one symbol/timeframe.
 *
 * @returns {{
 *   symbol: string, timeframe: string, currentPrice: number|null,
 *   atr: number, htfTrend: string, generatedAt: string,
 *   projections: Array<object>, note?: string
 * }}
 */
export function computeProjections({
  symbol,
  timeframe = 'M15',
  candles = [],
  h4Candles = [],
  h1Candles = [],
  nowMs = Date.now(),
  maxProjections = 6,
}) {
  const base = {
    symbol,
    timeframe,
    currentPrice: null,
    atr: 0,
    htfTrend: 'NEUTRAL',
    generatedAt: new Date(nowMs).toISOString(),
    projections: [],
  };

  if (!candles || candles.length < 20) {
    return { ...base, note: 'Insufficient candle history for projection.' };
  }

  const sorted = [...candles].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const latest = sorted[sorted.length - 1];
  const currentClose = Number(latest?.close);
  if (!Number.isFinite(currentClose)) {
    return { ...base, note: 'No valid current price.' };
  }

  let atr = calculateATR(sorted, 14);
  if (atr === null || atr <= 0) atr = fallbackAtr(symbol);

  // Prefer H4 for bias, fall back to H1, then to the working timeframe itself.
  let htfTrend = trendFrom(h4Candles);
  if (htfTrend === 'NEUTRAL') htfTrend = trendFrom(h1Candles);
  if (htfTrend === 'NEUTRAL') htfTrend = trendFrom(sorted);

  // Gather candidate zones, tagging their source so the UI can label them.
  const obs = detectOrderBlocks(sorted).map((z) => ({ ...z, _source: 'OB' }));
  const fvgs = detectFVGs(sorted).map((z) => ({ ...z, _source: 'FVG' }));
  const zones = [...obs, ...fvgs].filter((z) => isUnmitigated(z, sorted));

  const projections = [];
  for (const zone of zones) {
    const proj = buildProjection({
      zone,
      source: zone._source,
      currentClose,
      atr,
      symbol,
      timeframe,
      htfTrend,
      nowMs,
    });
    if (proj) projections.push(proj);
  }

  // De-duplicate near-identical entries (same side, entry within a tick), keep the
  // higher-confidence one, then surface the soonest-to-reach projections first.
  const byKey = new Map();
  for (const p of projections) {
    const key = `${p.bias}|${p.entryPrice.toFixed(digitsFor(symbol))}`;
    const existing = byKey.get(key);
    if (!existing || p.mathConfidence > existing.mathConfidence) byKey.set(key, p);
  }
  const deduped = [...byKey.values()].sort((a, b) => a.minutesToReach - b.minutesToReach);

  return {
    ...base,
    currentPrice: currentClose,
    atr,
    htfTrend,
    projections: deduped.slice(0, maxProjections),
  };
}
