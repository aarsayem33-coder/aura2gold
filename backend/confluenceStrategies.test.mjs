// Tests for forex-confluence + fixed-time-confluence (strategyLab.js).
// Run: node backend/confluenceStrategies.test.mjs
import assert from 'node:assert';
import { STRATEGIES, evaluateStrategy, strategyTimeframes } from './strategyLab.js';

let passed = 0;
function test(name, fn) { try { fn(); console.log(`  ok  ${name}`); passed++; } catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; } }

const PIP = 0.0001, MIN = 60000;
// Flat noise — no single strategy fires, so confluence can't fire either.
function flat() {
  const out = []; const t0 = Date.UTC(2026, 5, 25, 13, 0, 0);
  for (let i = 0; i < 220; i++) { const b = 1.1000 + Math.sin(i / 5) * 0.0004; out.push({ time: new Date(t0 + i * MIN).toISOString(), open: b, high: b + 0.0002, low: b - 0.0002, close: b + (i % 2 ? 0.0001 : -0.0001), volume: 100 }); }
  return out;
}
const ctx = (candles, over = {}) => ({ symbol: 'XAUUSDM', timeframe: 'M5', candles, pip: PIP, h4Trend: 'NEUTRAL', h1Trend: 'NEUTRAL', ...over });

test('both confluence strategies are registered', () => {
  assert.ok(STRATEGIES['forex-confluence'], 'forex-confluence registered');
  assert.ok(STRATEGIES['fixed-time-confluence'], 'fixed-time-confluence registered');
  assert.ok(strategyTimeframes('fixed-time-confluence').includes('M1'), 'ft-confluence has M1');
});

test('return null (no throw) on flat data — no agreement, no fabricated signal', () => {
  assert.strictEqual(evaluateStrategy('forex-confluence', ctx(flat())), null);
  assert.strictEqual(evaluateStrategy('fixed-time-confluence', ctx(flat())), null);
});

test('null on insufficient data', () => {
  assert.strictEqual(evaluateStrategy('forex-confluence', ctx(flat().slice(0, 20))), null);
});

test('deterministic', () => {
  const c = flat();
  assert.strictEqual(
    JSON.stringify(evaluateStrategy('forex-confluence', ctx(c))),
    JSON.stringify(evaluateStrategy('forex-confluence', ctx(c))),
  );
});

console.log(`\n${passed} passed`);
