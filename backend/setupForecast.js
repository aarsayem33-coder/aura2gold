// Scenario builder for conditional setup forecasts.
//
// A forecast is not "here is a signal". It is: IF price arrives at this level and behaves
// this specific way, WHICH strategies would call it, by their own rules? To ask that, we
// hand each strategy the real candle history plus a small synthetic continuation shaped to
// the scenario, and read what it returns. No strategy is modified, reimplemented or
// approximated — strategyLab.js is never touched, and evaluateStrategy() is a pure read.
//
// The synthetic bars are the one invented part of the whole feature, so they are built
// deterministically from the level and ATR alone, kept to a small number of canonical
// shapes, and reported alongside every forecast. If the assumed bar is wrong, everything
// downstream is wrong, so it has to be inspectable rather than hidden.
//
// Nothing here is ever stored as a candle or a signal. The bars exist as a function
// argument for the duration of one evaluation.

const n = (v) => Number(v);

/** Bar interval in minutes for a timeframe label. 0 = unknown. */
export function barMinutes(tf) {
  const m = /^([MH])(\d+)$/.exec(String(tf || '').toUpperCase());
  if (!m) return 0;
  return m[1] === 'H' ? Number(m[2]) * 60 : Number(m[2]);
}

export const SCENARIOS = ['SWEEP_REJECT', 'BREAK_HOLD', 'TOUCH_REJECT'];

// Bar geometry, in fractions of ATR, measured from the level.
//
// These are NOT free parameters. They are calibrated so the resulting candle satisfies the
// numeric gates the real detectors already apply, which were read out of the code rather
// than guessed:
//
//   detectLiquidityPinRejection (liquidityEngine.js) is the strictest:
//     range >= 0.60 ATR · bodyRatio <= 0.40 · wickRatio >= 0.45 · closePosition >= 0.60
//     sweep depth >= 0.08 ATR · and crucially cl > o for a buy (cl < o for a sell)
//   liquiditySweepPro (strategyLab.js) adds: depth <= 0.90 ATR, ZONE_REJECT needs wick >= 0.30
//   the pinbar classifier (signalEngine.js) wants: bodyRatio <= 0.35, lower wick >= 2x body,
//     upper wick <= max(body, 0.15 x range)
//   ict-breaker's reclaim wants a conviction close: bodyRatio >= 0.60 (bonus at 0.75)
//
// The first draft of this had the rejection body closing the WRONG WAY (close below open on a
// bullish sweep), which every one of those detectors rejects on the cl > o test. The shape has
// to be a legitimate example of the pattern or the whole forecast is vacuous, so the geometry
// tests assert these ratios directly — if a detector threshold moves, they should fail.
const GEO = {
  // The bar that takes the liquidity: small body sitting high in the range, long pierce wick.
  sweep: { pierce: 0.35, gap: 0.10, close: 0.30, tail: 0.07 },
  // The bar that reclaims and displaces away — needs a big body for ict-breaker's reclaim test.
  displace: { body: 0.55, wick: 0.06 },
  // Decisive acceptance through the level, then a holding continuation.
  breakBar: { gap: 0.10, close: 0.55, wick: 0.08 },
  holdBar: { body: 0.35, wick: 0.08 },
  // Reaches the level to the tick and leaves: no pierce, so this is a ZONE_REJECT not a sweep.
  touch: { gap: 0.15, close: 0.36, tail: 0.06 },
};

/**
 * Which way a scenario at a level points.
 *
 * `side` is where the liquidity rests: 'below' means sell-side stops sit under the level.
 *  - SWEEP_REJECT runs the stops and fails, so price turns AWAY from the level.
 *  - BREAK_HOLD accepts through it, so price CONTINUES past the level.
 *  - TOUCH_REJECT never trades through, and turns away like a sweep.
 */
export function scenarioDirection(scenario, side) {
  const below = side === 'below';
  if (scenario === 'BREAK_HOLD') return below ? 'SELL' : 'BUY';
  return below ? 'BUY' : 'SELL';           // sweep or touch: reject away from the level
}

/**
 * Build the synthetic continuation for one level × scenario.
 *
 * Returns 1–2 bars. Two is deliberate: a sweep is a two-bar event (the bar that takes the
 * liquidity, then the bar that reclaims and displaces), and strategies looking for a
 * breaker or a reclaim cannot see it in a single bar. Timestamps continue the real series
 * so bar spacing stays consistent with the timeframe.
 */
export function buildScenarioBars({ level, side, scenario, atr, lastCandle, timeframe, geo = GEO }) {
  const L = n(level);
  const a = n(atr);
  const mins = barMinutes(timeframe);
  if (!Number.isFinite(L) || !(a > 0) || !(mins > 0) || !lastCandle) return null;
  if (!SCENARIOS.includes(scenario)) return null;

  const lastMs = Date.parse(lastCandle.time);
  if (!Number.isFinite(lastMs)) return null;
  const t = (i) => new Date(lastMs + (i + 1) * mins * 60000).toISOString();
  const below = side === 'below';
  const bar = (i, open, high, low, close) => ({
    time: t(i),
    open: r5(open), high: r5(high), low: r5(low), close: r5(close),
    volume: n(lastCandle.volume) || 0,
    synthetic: true,
  });
  // `sign` mirrors the whole construction: +1 works away from a level below price (a bullish
  // rejection), -1 away from a level above it. Building one shape and reflecting it is what
  // keeps the two sides from drifting apart as the geometry is tuned.
  const s = below ? 1 : -1;
  const at = (f) => L + s * a * f;               // a point f ATR on the reaction side
  const beyond = (f) => L - s * a * f;           // a point f ATR past the level
  // Reflection: on the reaction side the extreme is the high for a buy and the low for a sell.
  const mk = (i, open, close, reactExtreme, pastExtreme) => (below
    ? bar(i, open, reactExtreme, pastExtreme, close)
    : bar(i, open, pastExtreme, reactExtreme, close));

  if (scenario === 'SWEEP_REJECT') {
    const g = geo.sweep;
    // Bar 1 takes the liquidity beyond the level, then closes back across it in the reaction
    // direction — the close MUST finish beyond its own open, which is what every rejection
    // detector tests. Bar 2 displaces away, giving reclaim/breaker logic something to see.
    const b1 = mk(0, at(g.gap), at(g.close), at(g.close + g.tail), beyond(g.pierce));
    const d = geo.displace;
    const c2 = b1.close + s * a * d.body;
    const b2 = mk(1, b1.close, c2, c2 + s * a * d.wick, b1.close - s * a * d.wick);
    return [b1, b2];
  }

  if (scenario === 'BREAK_HOLD') {
    const g = geo.breakBar;
    // A break travels PAST the level rather than turning at it, so the close and the dominant
    // extreme both sit on the `beyond` side. Reusing the same mk() reflection is what keeps the
    // two sides mirrored — hand-rolling this branch is exactly how it broke the first time.
    const b1 = mk(0, at(g.gap), beyond(g.close), at(g.gap + g.wick), beyond(g.close + g.wick));
    const h = geo.holdBar;
    const c2 = b1.close - s * a * h.body;          // extends further past the level
    const b2 = mk(1, b1.close, c2, b1.close + s * a * h.wick, c2 - s * a * h.wick);
    return [b1, b2];
  }

  // TOUCH_REJECT: reaches the level to the tick without trading through. With no pierce this is
  // a zone rejection rather than a sweep, and the detectors classify it as exactly that.
  const g = geo.touch;
  const b1 = mk(0, at(g.gap), at(g.close), at(g.close + g.tail), L);
  const d = geo.displace;
  const c2 = b1.close + s * a * d.body;
  const b2 = mk(1, b1.close, c2, c2 + s * a * d.wick, b1.close - s * a * d.wick);
  return [b1, b2];
}

export { GEO as SCENARIO_GEOMETRY };

function r5(v) { return Math.round(Number(v) * 1e5) / 1e5; }

/** Every synthetic bar must be a valid candle, or the charting and the strategies both lie. */
export function barsAreValid(bars) {
  if (!Array.isArray(bars) || !bars.length) return false;
  return bars.every((b) => {
    const { open, high, low, close } = b;
    return [open, high, low, close].every((v) => Number.isFinite(v) && v > 0)
      && low <= open && open <= high
      && low <= close && close <= high
      && low <= high;
  });
}

/**
 * A context for the what-if evaluation: the REAL history with the synthetic bars appended.
 *
 * Higher-timeframe fields are passed through untouched, so every HTF gate a strategy applies
 * is still judged against actual market state rather than an invented one.
 */
export function scenarioContext(baseCtx, bars) {
  if (!baseCtx || !Array.isArray(baseCtx.candles) || !barsAreValid(bars)) return null;
  return { ...baseCtx, candles: [...baseCtx.candles, ...bars], scenarioBars: bars.length };
}

/** How far price has to travel to reach the level, in pips and ATR. */
export function distanceTo({ price, level, atr, pip }) {
  const p = n(price), l = n(level), a = n(atr), pv = n(pip);
  if (![p, l].every(Number.isFinite)) return null;
  const d = Math.abs(l - p);
  return {
    price: r5(d),
    pips: pv > 0 ? Math.round((d / pv) * 10) / 10 : null,
    atr: a > 0 ? Math.round((d / a) * 100) / 100 : null,
  };
}

/**
 * Rough time for price to reach the level, as a RANGE rather than a point.
 *
 * Price does not travel at a constant rate, so a single number would imply precision that
 * does not exist. The band is half to double the central estimate, which is honest about
 * the uncertainty without being useless.
 */
export function etaBand({ distanceAtr, timeframe, atrPerBar = 0.5 }) {
  const d = n(distanceAtr);
  const mins = barMinutes(timeframe);
  if (!Number.isFinite(d) || !(mins > 0) || !(atrPerBar > 0)) return null;
  if (d <= 0) return { minMinutes: 0, midMinutes: 0, maxMinutes: 0 };
  const mid = Math.round((d / atrPerBar) * mins);
  return { minMinutes: Math.max(1, Math.round(mid / 2)), midMinutes: mid, maxMinutes: mid * 2 };
}

export const HORIZON_BUCKETS = [
  { key: 'lte30m', label: '≤30m', maxMinutes: 30 },
  { key: 'lte1h', label: '≤1h', maxMinutes: 60 },
  { key: '1to3h', label: '1–3h', maxMinutes: 180 },
  { key: '3to6h', label: '3–6h', maxMinutes: 360 },
  { key: '6to12h', label: '6–12h', maxMinutes: 720 },
  { key: 'gt12h', label: '12h+', maxMinutes: Infinity },
];

/** Which horizon bucket a central ETA falls in. */
export function horizonBucket(midMinutes) {
  const m = n(midMinutes);
  if (!Number.isFinite(m)) return null;
  return HORIZON_BUCKETS.find((b) => m <= b.maxMinutes) || HORIZON_BUCKETS[HORIZON_BUCKETS.length - 1];
}
