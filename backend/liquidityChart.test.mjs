import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLevel, analyseStructure, buildLiquidityChart } from './liquidityChart.js';

// Minimal candle builder — one bar per minute so indices are readable.
let t0 = Date.parse('2026-07-01T00:00:00Z');
const bar = (open, high, low, close, i) => ({
  time: new Date(t0 + i * 60000).toISOString(), open, high, low, close, volume: 100,
});
/** Flat filler bars around `mid` so ATR is a known, non-zero value. */
const filler = (count, mid, spread = 1, from = 0) =>
  Array.from({ length: count }, (_, k) => bar(mid, mid + spread, mid - spread, mid, from + k));

const LEVEL_ABOVE = { price: 110, side: 'above', formedIdx: 0, strength: 4 };
const LEVEL_BELOW = { price: 90, side: 'below', formedIdx: 0, strength: 4 };

test('FRESH: never revisited after it formed', () => {
  const candles = [bar(100, 111, 99, 100, 0), ...filler(20, 100, 1, 1)];
  const r = classifyLevel(candles, LEVEL_ABOVE, { atr: 2 });
  assert.equal(r.status, 'FRESH');
  assert.equal(r.touches, 0);
});

test('SWEPT: wick beyond the level, close back inside', () => {
  const candles = [
    ...filler(20, 100, 1, 0),
    bar(100, 114, 99, 101, 20),          // long wick through 110, closes back at 101
    ...filler(5, 101, 1, 21),
  ];
  const r = classifyLevel(candles, LEVEL_ABOVE, { atr: 2 });
  assert.equal(r.status, 'SWEPT');
  assert.equal(r.pierced, true);
  assert.equal(r.closesBeyond, 0, 'a sweep closes back inside, so nothing closed beyond');
});

test('SWEPT: a single close beyond that gets reclaimed is still a sweep, not a break', () => {
  const candles = [
    ...filler(20, 100, 1, 0),
    bar(108, 114, 107, 112, 20),         // one close beyond
    bar(112, 113, 100, 101, 21),         // reclaimed straight back
    ...filler(5, 101, 1, 22),
  ];
  const r = classifyLevel(candles, LEVEL_ABOVE, { atr: 2 });
  assert.equal(r.status, 'SWEPT');
});

test('BROKEN_ACCEPTED: closes beyond and price is still working around the level', () => {
  const candles = [
    ...filler(20, 100, 1, 0),
    bar(108, 113, 107, 112, 20),
    bar(112, 114, 111, 113, 21),
    ...filler(4, 113, 1, 22),            // holds just above 110 — a live retest zone
  ];
  const r = classifyLevel(candles, LEVEL_ABOVE, { atr: 2, deadAtr: 3 });
  assert.equal(r.status, 'BROKEN_ACCEPTED');
  assert.ok(r.closesBeyond >= 2);
});

test('INVALIDATED: broken, then left far behind — no longer active liquidity', () => {
  const candles = [
    ...filler(20, 100, 1, 0),
    bar(108, 116, 107, 115, 20),
    bar(115, 118, 114, 117, 21),
    ...filler(4, 124, 1, 22),            // 7 ATR beyond 110: the level is history
  ];
  const r = classifyLevel(candles, LEVEL_ABOVE, { atr: 2, deadAtr: 3 });
  assert.equal(r.status, 'INVALIDATED');
  assert.match(r.evidence, /no longer active/);
});

test('a break is never reported as a sweep', () => {
  const candles = [
    ...filler(20, 100, 1, 0),
    bar(108, 113, 107, 112, 20), bar(112, 114, 111, 113, 21), ...filler(4, 113, 1, 22),
  ];
  assert.notEqual(classifyLevel(candles, LEVEL_ABOVE, { atr: 2 }).status, 'SWEPT');
});

test('TESTED: reached with no decisive break and no strong reaction', () => {
  const candles = [
    ...filler(20, 100, 1, 0),
    bar(105, 109.9, 104, 105, 20),       // approaches 110 inside tolerance, no pierce
    ...filler(4, 105, 1, 21),            // drifts, no displacement
  ];
  const r = classifyLevel(candles, LEVEL_ABOVE, { atr: 20, rejectAtr: 1.0 });
  assert.equal(r.status, 'TESTED');
  assert.equal(r.pierced, false);
});

test('REJECTED: touched, not pierced, then pushed sharply away', () => {
  const candles = [
    ...filler(20, 100, 1, 0),
    bar(105, 110, 104, 108, 20),         // reaches the level exactly, no pierce
    bar(108, 108, 96, 97, 21),           // driven far away
    ...filler(3, 97, 1, 22),
  ];
  const r = classifyLevel(candles, LEVEL_ABOVE, { atr: 3, rejectAtr: 1.0 });
  assert.equal(r.status, 'REJECTED');
  assert.equal(r.pierced, false);
});

test('sell-side levels mirror the logic below price', () => {
  const swept = [
    ...filler(20, 100, 1, 0),
    bar(100, 101, 86, 99, 20),           // wick under 90, closes back above
    ...filler(4, 99, 1, 21),
  ];
  assert.equal(classifyLevel(swept, LEVEL_BELOW, { atr: 2 }).status, 'SWEPT');
  const broken = [
    ...filler(20, 100, 1, 0),
    bar(92, 93, 87, 88, 20), bar(88, 89, 86, 87, 21), ...filler(4, 87, 1, 22),
  ];
  assert.equal(classifyLevel(broken, LEVEL_BELOW, { atr: 2, deadAtr: 3 }).status, 'BROKEN_ACCEPTED');
});

test('evidence after the level formed only — earlier candles cannot classify it', () => {
  const candles = [
    bar(100, 120, 80, 100, 0),           // huge bar BEFORE the level formed
    ...filler(10, 100, 1, 1),
  ];
  const r = classifyLevel(candles, { price: 110, side: 'above', formedIdx: 5 }, { atr: 2 });
  assert.equal(r.status, 'FRESH', 'a bar predating the level must not mark it swept');
});

test('classifyLevel never throws on degenerate input', () => {
  for (const lv of [{ price: NaN, side: 'above', formedIdx: 0 }, { price: 100, side: 'above', formedIdx: 999 }]) {
    const r = classifyLevel(filler(5, 100), lv, { atr: 1 });
    assert.ok(LIQ_OK(r.status), `unexpected status ${r.status}`);
  }
});
const LIQ_OK = (s) => ['FRESH', 'TESTED', 'REJECTED', 'SWEPT', 'BROKEN_ACCEPTED', 'INVALIDATED'].includes(s);

// ── structure ──
test('analyseStructure labels swings and reads a bias', () => {
  const up = [];
  let p = 100;
  for (let i = 0; i < 12; i++) {            // stair-step higher highs / higher lows
    up.push(bar(p, p + 4, p - 1, p + 3, i * 2));
    up.push(bar(p + 3, p + 4, p + 1, p + 2, i * 2 + 1));
    p += 2;
  }
  const s = analyseStructure(up);
  assert.ok(['BULLISH', 'RANGING'].includes(s.bias));
  assert.ok(Array.isArray(s.swings));
  assert.ok(Array.isArray(s.events));
});

// ── end to end ──
test('buildLiquidityChart refuses to guess without enough candles', () => {
  const r = buildLiquidityChart(filler(10, 100), { symbol: 'XAUUSD' });
  assert.equal(r.ok, false);
  assert.match(r.error, /not enough candles/);
});

test('buildLiquidityChart returns classified levels and a stated draw', () => {
  const candles = [];
  let p = 100;
  for (let i = 0; i < 80; i++) {
    const hi = p + 2 + (i % 7), lo = p - 2 - (i % 5);
    candles.push(bar(p, hi, lo, p + ((i % 3) - 1), i));
    p += (i % 11 === 0) ? 3 : -0.4;
  }
  const r = buildLiquidityChart(candles, { symbol: 'EURUSD' });
  assert.equal(r.ok, true);
  assert.ok(r.levels.length > 0, 'should find some levels');
  for (const l of r.levels) {
    assert.ok(LIQ_OK(l.status), `bad status ${l.status}`);
    assert.ok(['BSL', 'SSL'].includes(l.pool));
    assert.ok(['EXTERNAL', 'INTERNAL'].includes(l.scope));
  }
  assert.ok(r.draw, 'a draw-on-liquidity read is always present');
  assert.ok(typeof r.draw.invalidation === 'string' && r.draw.invalidation.length > 0);
  assert.ok(Array.isArray(r.caveats));
});

test('missing daily/weekly candles are declared, not silently ignored', () => {
  const candles = filler(60, 100, 2);
  const r = buildLiquidityChart(candles, { symbol: 'EURUSD' });
  assert.ok(r.caveats.some((c) => /daily/i.test(c)), 'must say PDH/PDL are unavailable');
  assert.ok(r.caveats.some((c) => /weekly/i.test(c)), 'must say PWH/PWL are unavailable');
});

// ── setup scoring / ranking ──
import { scoreLiquiditySetup } from './liquidityChart.js';

const analysis = (over = {}) => ({
  ok: true, price: 100, atr: 2,
  structure: { bias: 'RANGING', swings: [], events: [] },
  levels: [],
  ...over,
});
const lvl = (o) => ({
  type: 'MAJOR_SWING_LOW', label: 'Swing low', price: 95, side: 'below', status: 'FRESH',
  strength: 2, scope: 'INTERNAL', pool: 'SSL', inducement: false, sweptAtMs: 1, distancePips: 10, ...o,
});

test('direction comes from the side whose liquidity was taken', () => {
  const buy = scoreLiquiditySetup(analysis({ levels: [
    lvl({ price: 96, side: 'below', pool: 'SSL', status: 'SWEPT', sweptAtMs: 200 }),
    lvl({ price: 112, side: 'above', pool: 'BSL', status: 'FRESH', scope: 'EXTERNAL' }),
  ] }));
  assert.equal(buy.direction, 'BUY', 'sell-side taken -> look up');

  const sell = scoreLiquiditySetup(analysis({ levels: [
    lvl({ price: 104, side: 'above', pool: 'BSL', status: 'SWEPT', sweptAtMs: 200 }),
    lvl({ price: 88, side: 'below', pool: 'SSL', status: 'FRESH', scope: 'EXTERNAL' }),
  ] }));
  assert.equal(sell.direction, 'SELL', 'buy-side taken -> look down');
});

test('no suggestion without a fresh pool to target', () => {
  const r = scoreLiquiditySetup(analysis({ levels: [
    lvl({ price: 96, side: 'below', status: 'SWEPT', sweptAtMs: 200 }),
  ] }));
  assert.equal(r.target, null);
  assert.ok(r.blockers.some((b) => /no fresh pool/.test(b)));
});

test('no suggestion when nothing has been swept', () => {
  const r = scoreLiquiditySetup(analysis({ levels: [lvl({ status: 'FRESH' })] }));
  assert.equal(r.direction, null);
  assert.ok(r.blockers.some((b) => /no liquidity has been taken/.test(b)));
});

test('structure agreement raises the score, disagreement lowers it', () => {
  const base = { levels: [
    lvl({ price: 96, side: 'below', pool: 'SSL', status: 'SWEPT', sweptAtMs: 200, strength: 5 }),
    lvl({ price: 112, side: 'above', pool: 'BSL', status: 'FRESH', scope: 'EXTERNAL' }),
  ] };
  const withTrend = scoreLiquiditySetup(analysis({ ...base, structure: { bias: 'BULLISH', events: [] } }));
  const against = scoreLiquiditySetup(analysis({ ...base, structure: { bias: 'BEARISH', events: [] } }));
  assert.ok(withTrend.score > against.score, `${withTrend.score} should beat ${against.score}`);
  assert.ok(against.blockers.some((b) => /against the direction/.test(b)));
});

test('a target too close to be worth it is called out, not hidden', () => {
  const r = scoreLiquiditySetup(analysis({ levels: [
    lvl({ price: 96, side: 'below', pool: 'SSL', status: 'SWEPT', sweptAtMs: 200 }),
    lvl({ price: 101, side: 'above', pool: 'BSL', status: 'FRESH' }),   // 1R vs 4 risk
  ] }), { minRR: 1.5 });
  assert.ok(r.rr !== null && r.rr < 1.5);
  assert.ok(r.blockers.some((b) => /below the .*R floor/.test(b)));
});

test('score stays inside 0-100 and always carries a grade', () => {
  const r = scoreLiquiditySetup(analysis({ levels: [
    lvl({ price: 99, side: 'below', pool: 'SSL', status: 'SWEPT', sweptAtMs: 200, strength: 5 }),
    lvl({ price: 140, side: 'above', pool: 'BSL', status: 'FRESH', scope: 'EXTERNAL' }),
  ], structure: { bias: 'BULLISH', events: [{ type: 'CHoCH', direction: 'UP' }] } }));
  assert.ok(r.score >= 0 && r.score <= 100);
  assert.ok(['A+', 'A', 'B', 'C'].includes(r.grade));
});

test('invalidation is the level that was swept', () => {
  const r = scoreLiquiditySetup(analysis({ levels: [
    lvl({ price: 96, side: 'below', pool: 'SSL', status: 'SWEPT', sweptAtMs: 200 }),
    lvl({ price: 112, side: 'above', pool: 'BSL', status: 'FRESH', scope: 'EXTERNAL' }),
  ] }));
  assert.equal(r.invalidation, 96, 'back through the swept level kills the read');
});

test('an invalidation a few ticks from price is refused, not quoted as a huge R', () => {
  const r = scoreLiquiditySetup(analysis({ price: 100, atr: 2, levels: [
    lvl({ price: 99.9, side: 'below', pool: 'SSL', status: 'SWEPT', sweptAtMs: 200 }),  // 0.05x ATR away
    lvl({ price: 130, side: 'above', pool: 'BSL', status: 'FRESH', scope: 'EXTERNAL' }),
  ] }));
  assert.equal(r.rr, null, 'must not quote an R off a non-existent stop');
  assert.ok(r.blockers.some((b) => /too close to be a usable stop/.test(b)));
});
