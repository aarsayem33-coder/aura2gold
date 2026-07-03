// Tests for special-forex-sniper (strategyLab.js).
// Run: node backend/specialForexSniper.test.mjs
import assert from 'node:assert';
import { STRATEGIES, evaluateStrategy, strategyTimeframes } from './strategyLab.js';

let passed = 0;
function test(name, fn) { try { fn(); console.log(`  ok  ${name}`); passed++; } catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; } }

const MIN = 60000;
// London-session flat noise — no sweep, no displacement: must never fabricate a signal.
function flat(count = 220, base = 1.1000) {
  const out = []; const t0 = Date.UTC(2026, 6, 2, 9, 0, 0); // 09:00 UTC = London
  for (let i = 0; i < count; i++) { const b = base + Math.sin(i / 5) * 0.0004; out.push({ time: new Date(t0 + i * 5 * MIN).toISOString(), open: b, high: b + 0.0002, low: b - 0.0002, close: b + (i % 2 ? 0.0001 : -0.0001), volume: 100 }); }
  return out;
}
const ctx = (candles, tf = 'M5', extra = {}) => ({ symbol: 'EURUSDM', timeframe: tf, candles, pip: 0.0001, h4Trend: null, h1Trend: null, ...extra });

test('registered with forex-sniper contract', () => {
  const s = STRATEGIES['special-forex-sniper'];
  assert.ok(s, 'missing from registry');
  assert.equal(s.name, 'Special Forex Sniper');
  assert.ok(s.config.minRR >= 2, 'RR floor must be >= 2');
  assert.ok(s.config.idealPreEntryPips >= 10 && s.config.idealPreEntryPips <= 12, 'ideal pre-entry band 10-12');
  assert.ok(s.config.m1ExceptionalScore >= 90, 'M1 gate must demand >= 90');
  assert.deepEqual(strategyTimeframes('special-forex-sniper'), ['M1', 'M5', 'M15', 'M30', 'H1']);
});

test('flat data -> null (no fabricated signal)', () => {
  assert.equal(evaluateStrategy('special-forex-sniper', ctx(flat())), null);
});

test('deterministic (same input, same output)', () => {
  const c = flat();
  const a = JSON.stringify(evaluateStrategy('special-forex-sniper', ctx(c)));
  const b = JSON.stringify(evaluateStrategy('special-forex-sniper', ctx(c)));
  assert.equal(a, b);
});

test('insufficient data -> null', () => {
  assert.equal(evaluateStrategy('special-forex-sniper', ctx(flat(40))), null);
});

test('M1 flat/weak -> null (M1 hard gate)', () => {
  const c = flat().map((k, i) => ({ ...k, time: new Date(Date.UTC(2026, 6, 2, 13, 0, 0) + i * MIN).toISOString() }));
  assert.equal(evaluateStrategy('special-forex-sniper', ctx(c, 'M1')), null);
});

test('no throw across every timeframe on noise', () => {
  const c = flat();
  for (const tf of ['M1', 'M5', 'M15', 'M30', 'H1']) {
    const r = evaluateStrategy('special-forex-sniper', ctx(c, tf));
    assert.ok(r === null || (r.decision && r.entry && r.stopLoss && r.riskRewardRatio >= 2 && r.meta?.requiresFill === true), `bad shape on ${tf}`);
  }
});

console.log(`\n${passed} passed`);
