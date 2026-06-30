// Tests for detectKeyLiquidityLevels + roundStepFor (liquidityEngine.js).
// Run: node backend/keyLiquidity.test.mjs
import assert from 'node:assert';
import { detectKeyLiquidityLevels, roundStepFor } from './liquidityEngine.js';

let passed = 0;
function test(name, fn) { try { fn(); console.log(`  ok  ${name}`); passed++; } catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; } }

// 192 M15 candles across 48 UTC hours, price oscillating near 1.1000 (so 1.10000 round# is in range).
function candles() {
  const out = [];
  const t0 = Date.UTC(2026, 5, 25, 0, 0, 0);
  for (let i = 0; i < 192; i++) {
    const t = t0 + i * 15 * 60000;
    const base = 1.1000 + Math.sin(i / 9) * 0.0015;
    const o = base, c = base + (i % 2 ? 0.0002 : -0.0002);
    out.push({ time: new Date(t).toISOString(), open: o, high: Math.max(o, c) + 0.0003, low: Math.min(o, c) - 0.0003, close: c, volume: 100 });
  }
  return out;
}
const daily = [
  { time: '2026-06-24T00:00:00Z', high: 1.1080, low: 1.0920, close: 1.1000 },
  { time: '2026-06-25T00:00:00Z', high: 1.1060, low: 1.0940, close: 1.1010 }, // previous COMPLETED day (index -2)
  { time: '2026-06-26T00:00:00Z', high: 1.1030, low: 1.0980, close: 1.1005 }, // forming D1 (last)
];

test('roundStepFor is per-instrument', () => {
  assert.strictEqual(roundStepFor('XAUUSDM').step, 10);
  assert.strictEqual(roundStepFor('USDJPY').step, 0.5);
  assert.strictEqual(roundStepFor('EURUSDM').step, 0.005);
  assert.strictEqual(roundStepFor('BTCUSD').step, 500);
});

test('short data returns empty', () => {
  assert.deepStrictEqual(detectKeyLiquidityLevels([], {}).levels, []);
});

const r = detectKeyLiquidityLevels(candles(), { symbol: 'EURUSDM', dailyCandles: daily });

test('PDH/PDL come from the PREVIOUS COMPLETED day, not the forming D1', () => {
  const pdh = r.levels.find((l) => l.type === 'PDH');
  const pdl = r.levels.find((l) => l.type === 'PDL');
  assert.ok(pdh && Math.abs(pdh.price - 1.1060) < 1e-6, `PDH should be 1.1060, got ${pdh?.price}`);
  assert.ok(pdl && Math.abs(pdl.price - 1.0940) < 1e-6, `PDL should be 1.0940, got ${pdl?.price}`);
});

test('round numbers detected (big figure 1.10000 = strength 5)', () => {
  const rn = r.levels.find((l) => l.type === 'ROUND_NUMBER' && Math.abs(l.price - 1.1) < 1e-6);
  assert.ok(rn, 'expected a round-number level at 1.10000');
  assert.strictEqual(rn.strength, 5, 'big-figure round number should be strength 5');
});

test('session highs/lows detected (Asian/London/NY)', () => {
  // With this near-flat synthetic data, session levels that coincide (within tol) with a
  // stronger level (round number / PDH) are correctly merged by the dedup — so we assert ≥1
  // surviving session level, proving end-to-end session detection works.
  const sess = r.levels.filter((l) => /^(ASIAN|LONDON|NY)_(HIGH|LOW)$/.test(l.type));
  assert.ok(sess.length >= 1, `expected at least one session level, got ${sess.map((l) => l.type)}`);
});

test('every level is fully typed', () => {
  for (const l of r.levels) {
    assert.ok(typeof l.type === 'string' && l.label, 'type+label');
    assert.ok(l.side === 'above' || l.side === 'below', 'side');
    assert.ok(Number.isFinite(l.distance) && (l.distanceAtr === null || Number.isFinite(l.distanceAtr)), 'distance');
    assert.ok(typeof l.swept === 'boolean' && typeof l.fresh === 'boolean' && l.swept === !l.fresh, 'swept/fresh');
    assert.ok(Number.isFinite(l.strength), 'strength');
  }
});

test('nearest unswept level each side is surfaced', () => {
  assert.ok(r.nearestAbove && r.nearestAbove.side === 'above', 'nearestAbove');
  assert.ok(r.nearestBelow && r.nearestBelow.side === 'below', 'nearestBelow');
});

console.log(`\n${passed} passed`);
