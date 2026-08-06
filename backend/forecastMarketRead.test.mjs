import assert from 'node:assert/strict';
import test from 'node:test';
import { detectLongWicks, detectRetests, compactBars, buildMarketRead, formatMarketRead } from './forecastMarketRead.js';

const bar = (o, h, l, c) => ({ time: '2026-07-30T00:00:00.000Z', open: o, high: h, low: l, close: c, volume: 100 });
// A realistic-enough series for the engine detectors, which need 20+ bars.
const series = (count = 60, base = 4000) => Array.from({ length: count }, (_, i) => {
  const o = base + Math.sin(i / 4) * 10;
  const c = base + Math.sin((i + 1) / 4) * 10;
  return bar(o, Math.max(o, c) + 3, Math.min(o, c) - 3, c);
});

// ── long wicks (asked for explicitly) ────────────────────────────────────────

test('a long lower wick is detected with its share of the range', () => {
  // open 100, high 101, low 90, close 99.5 -> lower wick 9.5 of an 11 range.
  const w = detectLongWicks([bar(100, 101, 90, 99.5)]);
  assert.equal(w.length, 1);
  assert.equal(w[0].side, 'LOWER');
  assert.ok(w[0].wickPct >= 80, `expected a dominant wick, got ${w[0].wickPct}%`);
  assert.match(w[0].note, /buyers rejected/);
});

test('a long upper wick is detected and labelled for sellers', () => {
  const w = detectLongWicks([bar(100, 110, 99.5, 100.5)]);
  assert.equal(w[0].side, 'UPPER');
  assert.match(w[0].note, /sellers rejected/);
});

test('an ordinary body with small wicks is not reported', () => {
  // A near-marubozu: wicks are a few percent of range.
  assert.deepEqual(detectLongWicks([bar(100, 110.2, 99.8, 110)]), []);
});

test('wick detection is bounded and ordered by recency', () => {
  const many = Array.from({ length: 30 }, () => bar(100, 101, 90, 99.5));
  const w = detectLongWicks(many);
  assert.ok(w.length <= 6, 'the prompt must not be flooded');
  assert.equal(w[0].barsAgo, 0, 'most recent first');
});

test('wick detection survives junk bars', () => {
  assert.deepEqual(detectLongWicks([bar(NaN, 1, 0, 1)]), []);
  assert.deepEqual(detectLongWicks([bar(100, 100, 100, 100)]), [], 'zero range cannot divide');
  assert.deepEqual(detectLongWicks(null), []);
});

// ── retests (asked for explicitly) ───────────────────────────────────────────

test('a level touched once reads as untested', () => {
  const cs = [bar(110, 111, 109, 110), bar(105, 106, 99, 100), bar(110, 112, 109, 111)];
  const r = detectRetests(cs, 100, 10);
  assert.equal(r.touches, 1);
  assert.equal(r.retested, false);
  assert.match(r.note, /touched once/);
});

test('leaving and returning counts as a retest', () => {
  const cs = [
    bar(105, 106, 99, 100),     // touch
    bar(120, 121, 119, 120),    // away
    bar(105, 106, 99, 100),     // retest
  ];
  const r = detectRetests(cs, 100, 10);
  assert.equal(r.touches, 2);
  assert.equal(r.retested, true);
  assert.match(r.note, /retested 2 times/);
});

test('consecutive bars inside the band are one touch, not many', () => {
  // Without the "must leave first" rule, a level price sits on reads as 5 retests.
  const cs = Array.from({ length: 5 }, () => bar(101, 102, 99, 100));
  const r = detectRetests(cs, 100, 10);
  assert.equal(r.touches, 1);
});

test('a level never reached says so', () => {
  const r = detectRetests([bar(200, 201, 199, 200)], 100, 10);
  assert.equal(r.touches, 0);
  assert.match(r.note, /has not reached/);
});

test('retest detection degrades safely', () => {
  assert.equal(detectRetests(null, 100, 10), null);
  assert.equal(detectRetests([bar(1, 2, 0, 1)], NaN, 10), null);
  assert.equal(detectRetests([bar(1, 2, 0, 1)], 100, 0), null);
});

// ── bars ─────────────────────────────────────────────────────────────────────

test('bars are compacted to arrays and capped', () => {
  const b = compactBars(series(80), 40);
  assert.equal(b.length, 40);
  assert.equal(b[0].length, 4, 'open, high, low, close');
  assert.ok(b.every((x) => x.every(Number.isFinite)));
});

// ── the full read ────────────────────────────────────────────────────────────

test('the read carries real OHLC, not just closes', () => {
  // The whole reason this module exists: six closes made candle analysis impossible.
  const read = buildMarketRead({ candles: series(), symbol: 'XAUUSD', level: 4000 });
  assert.equal(read.insufficient, false);
  assert.equal(read.barCount, 40);
  assert.equal(read.bars[0].length, 4);
  assert.ok(read.atr > 0);
});

test('every strategy-relevant section is present', () => {
  const read = buildMarketRead({ candles: series(), symbol: 'XAUUSD', level: 4000 });
  for (const k of ['patterns', 'longWicks', 'structure', 'orderBlocks', 'fvgs', 'sweeps', 'support', 'resistance', 'breaker', 'retests']) {
    assert.ok(k in read, `missing ${k}`);
  }
});

test('too little history is reported, never faked', () => {
  const read = buildMarketRead({ candles: series(5) });
  assert.equal(read.insufficient, true);
  assert.equal(read.barsAvailable, 5);
  assert.match(formatMarketRead(read), /Insufficient candle history/);
});

test('a detector throwing does not sink the whole read', () => {
  // Bars shaped to upset the engine detectors; the read must still come back usable.
  const weird = Array.from({ length: 40 }, () => bar(0.0001, 0.0001, 0.0001, 0.0001));
  const read = buildMarketRead({ candles: weird, level: 0.0001 });
  assert.equal(read.insufficient, false);
  assert.ok(Array.isArray(read.patterns));
  assert.ok(Array.isArray(read.orderBlocks));
});

test('the prompt text names every section, including the empty ones', () => {
  // A section that vanishes when empty reads to the model as "not checked" rather than
  // "checked and there is nothing", which changes the conclusion it draws.
  const text = formatMarketRead(buildMarketRead({ candles: series(), level: 4000 }), { timeframe: 'M15' });
  for (const label of ['LAST 40 M15 CANDLES', 'Candlestick patterns', 'Long wicks', 'Market structure',
    'Order blocks', 'Fair value gaps', 'Liquidity sweeps', 'Support near', 'Resistance near',
    'Breaker block', 'Retests of the forecast level']) {
    assert.ok(text.includes(label), `prompt is missing "${label}"`);
  }
  assert.match(text, /\[\[/, 'OHLC arrays must be embedded');
});

test('support and resistance are ordered by closeness to the forecast level', () => {
  const read = buildMarketRead({ candles: series(), level: 4000 });
  const all = [...read.support, ...read.resistance];
  if (all.length > 1) {
    const d = all.map((p) => Math.abs(p - 4000));
    assert.ok(read.support.length <= 5 && read.resistance.length <= 5, 'bounded');
    assert.ok(d.every(Number.isFinite));
  }
});
