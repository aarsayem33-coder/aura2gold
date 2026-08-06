// Everything the strategies look at, assembled for the AI reviewer.
//
// The model used to receive six closing prices, which made it structurally incapable of seeing
// a wick, a body, an order block or a retest — so any pattern it "noticed" was invention. This
// module hands it the same evidence the deterministic engines use:
//
//   real OHLC bars · candlestick patterns · long wicks / rejections · order blocks · fair value
//   gaps · market structure · liquidity sweeps · support & resistance · key levels with their
//   swept/fresh status · retests of the forecast level
//
// Detection stays where it belongs: in the engines that are tested against real outcomes. The
// model is TOLD what was found and reasons about it. It is never asked to detect, because a
// language model guessing at candle shapes from numbers is strictly worse than the code that
// already measures them.

import {
  detectCandlestickPatterns, detectOrderBlocks, detectFVGs,
  detectMarketStructure, detectLiquiditySweeps, detectSupportResistance,
} from './signalEngine.js';
import { detectBreaker, atr14 } from './liquidityEngine.js';

const n = (v) => Number(v);
const r5 = (v) => Math.round(n(v) * 1e5) / 1e5;
const r2 = (v) => Math.round(n(v) * 100) / 100;

/**
 * Long wicks and rejections on the recent bars.
 *
 * The user asked for this specifically and no existing detector reports it standalone: the
 * pattern detector only fires on a textbook pinbar, while a 60%-of-range wick into a level is
 * meaningful long before it qualifies as one.
 */
export function detectLongWicks(candles, { lookback = 12, minWickRatio = 0.5 } = {}) {
  const cs = (candles || []).slice(-lookback);
  const out = [];
  cs.forEach((c, i) => {
    const o = n(c.open), h = n(c.high), l = n(c.low), cl = n(c.close);
    if (![o, h, l, cl].every(Number.isFinite)) return;
    const range = h - l;
    if (!(range > 0)) return;
    const upper = h - Math.max(o, cl);
    const lower = Math.min(o, cl) - l;
    const barsAgo = cs.length - 1 - i;
    if (lower / range >= minWickRatio) {
      out.push({ barsAgo, side: 'LOWER', wickPct: Math.round((lower / range) * 100), low: r5(l), close: r5(cl),
        note: 'long lower wick — buyers rejected lower prices' });
    }
    if (upper / range >= minWickRatio) {
      out.push({ barsAgo, side: 'UPPER', wickPct: Math.round((upper / range) * 100), high: r5(h), close: r5(cl),
        note: 'long upper wick — sellers rejected higher prices' });
    }
  });
  return out.sort((a, b) => a.barsAgo - b.barsAgo).slice(0, 6);
}

/**
 * Has price already come back to a level after leaving it?
 *
 * A level touched once is untested; a level touched, left, and revisited is a retest, and the
 * two mean different things for whether it will hold. Counted from closed bars only.
 */
export function detectRetests(candles, level, atr, { lookback = 60, tolAtr = 0.15 } = {}) {
  const L = n(level), a = n(atr);
  if (!Number.isFinite(L) || !(a > 0) || !Array.isArray(candles)) return null;
  const tol = a * tolAtr;
  const cs = candles.slice(-lookback);
  let touches = 0;
  let away = true;                 // must leave the band before another touch counts
  let lastTouchBarsAgo = null;
  // WHICH bars did the touching, offset back onto the caller's full series. The chart marks
  // these, so the image and the prompt text can never describe different candles.
  const offset = Math.max(0, candles.length - cs.length);
  const bars = [];
  cs.forEach((c, i) => {
    const h = n(c.high), l = n(c.low);
    if (!Number.isFinite(h) || !Number.isFinite(l)) return;
    const inBand = l <= L + tol && h >= L - tol;
    if (inBand && away) {
      touches += 1; away = false; lastTouchBarsAgo = cs.length - 1 - i;
      bars.push({ index: offset + i, price: L });
    } else if (!inBand) away = true;
  });
  return {
    touches,
    bars,
    lastTouchBarsAgo,
    retested: touches > 1,
    note: touches === 0 ? 'price has not reached this level in the lookback window'
      : touches === 1 ? 'touched once — untested since'
        : `retested ${touches} times — repeatedly defended or repeatedly attacked`,
  };
}

/** Compact OHLC for the prompt: arrays, not objects, so 40 bars stay affordable in tokens. */
export function compactBars(candles, count = 40) {
  return (candles || []).slice(-count).map((c) => [r5(c.open), r5(c.high), r5(c.low), r5(c.close)]);
}

/**
 * The full read. Every field is best-effort — a detector that throws or returns nothing leaves
 * its key empty rather than failing the whole review.
 */
export function buildMarketRead({ candles, symbol = '', level = null, atr = null, bars = 40 }) {
  const cs = Array.isArray(candles) ? candles : [];
  if (cs.length < 20) return { insufficient: true, barsAvailable: cs.length };
  const a = n(atr) || n(atr14(cs)) || null;
  const safe = (fn, fb) => { try { const v = fn(); return v ?? fb; } catch { return fb; } };
  // Guarding exceptions is not enough: a detector that returns an object where an array was
  // expected throws on the very next .slice(), which would sink the whole read.
  const arr = (fn) => { const v = safe(fn, []); return Array.isArray(v) ? v : []; };

  const sr = safe(() => detectSupportResistance(cs, a), { support: [], resistance: [] });
  const near = (list) => (Array.isArray(list) ? list : [])
    .map((x) => (typeof x === 'object' ? n(x.price ?? x.level ?? x.value) : n(x)))
    .filter((v) => Number.isFinite(v))
    .sort((x, y) => Math.abs(x - n(level)) - Math.abs(y - n(level)))
    .slice(0, 5)
    .map(r5);

  return {
    insufficient: false,
    atr: a === null ? null : r5(a),
    bars: compactBars(cs, bars),
    barCount: Math.min(cs.length, bars),
    patterns: arr(() => detectCandlestickPatterns(cs, a, []))
      .map((p) => ({ name: p.name, direction: p.direction, strength: p.strength, reason: p.reason })).slice(0, 6),
    longWicks: arr(() => detectLongWicks(cs)),
    structure: safe(() => detectMarketStructure(cs), null),
    orderBlocks: arr(() => detectOrderBlocks(cs))
      .slice(-6)
      .map((b) => ({ type: b.type || b.kind || null, top: r5(b.top ?? b.high), bottom: r5(b.bottom ?? b.low), index: b.index ?? null })),
    fvgs: arr(() => detectFVGs(cs))
      .slice(-5)
      .map((g) => ({ type: g.type || g.direction || null, top: r5(g.top ?? g.high), bottom: r5(g.bottom ?? g.low) })),
    sweeps: arr(() => detectLiquiditySweeps(cs)).slice(-4),
    support: near(sr.support),
    resistance: near(sr.resistance),
    breaker: safe(() => {
      const b = detectBreaker(cs);
      return b ? { type: b.type, zoneTop: r5(b.zoneTop), zoneBottom: r5(b.zoneBottom), ageBars: b.ageBars ?? null } : null;
    }, null),
    retests: level === null ? null : safe(() => detectRetests(cs, level, a), null),
  };
}

/** Render the read as prompt text. Sections with nothing in them say so, rather than vanishing. */
export function formatMarketRead(read, { symbol = '', timeframe = '' } = {}) {
  if (!read || read.insufficient) return `Insufficient candle history (${read?.barsAvailable ?? 0} bars) — no structural read available.`;
  const list = (arr, f, empty) => (arr && arr.length ? arr.map(f).join('; ') : empty);
  return [
    `LAST ${read.barCount} ${timeframe} CANDLES as [open, high, low, close], oldest first:`,
    JSON.stringify(read.bars),
    '',
    `Candlestick patterns detected: ${list(read.patterns, (p) => `${p.name} (${p.direction}, ${p.reason})`, 'none')}`,
    `Long wicks / rejections: ${list(read.longWicks, (w) => `${w.barsAgo} bars ago ${w.side} wick ${w.wickPct}% of range — ${w.note}`, 'none in the last 12 bars')}`,
    `Market structure: ${read.structure ? JSON.stringify(read.structure) : 'not determined'}`,
    `Order blocks (nearest recent): ${list(read.orderBlocks, (b) => `${b.type || 'OB'} ${b.bottom}-${b.top}`, 'none detected')}`,
    `Fair value gaps: ${list(read.fvgs, (g) => `${g.type || 'FVG'} ${g.bottom}-${g.top}`, 'none open')}`,
    `Liquidity sweeps: ${list(read.sweeps, (s) => JSON.stringify(s), 'none recent')}`,
    `Support near the level: ${read.support.length ? read.support.join(', ') : 'none'}`,
    `Resistance near the level: ${read.resistance.length ? read.resistance.join(', ') : 'none'}`,
    `Breaker block: ${read.breaker ? `${read.breaker.type} zone ${read.breaker.zoneBottom}-${read.breaker.zoneTop}` : 'none active'}`,
    `Retests of the forecast level: ${read.retests ? read.retests.note : 'not evaluated'}`,
  ].join('\n');
}
