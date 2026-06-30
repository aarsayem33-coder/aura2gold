// Tests for gradeSweep (the 5-component high-probability sweep model) in liquidityEngine.js.
// Run: node backend/gradeSweep.test.mjs
import assert from 'node:assert';
import { gradeSweep } from './liquidityEngine.js';

let passed = 0;
function test(name, fn) { try { fn(); console.log(`  ok  ${name}`); passed++; } catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; } }

// A clean BEARISH sweep of the 1.10000 big-figure: rally up, wick above 1.1000 + close back below
// (rejection), then strong displacement down that breaks a prior minor swing low (BOS).
function bearishSweep() {
  const out = [];
  const t0 = Date.UTC(2026, 5, 25, 8, 0, 0);
  const bar = (i, o, h, l, c) => out.push({ time: new Date(t0 + i * 15 * 60000).toISOString(), open: o, high: h, low: l, close: c, volume: 100 });
  for (let i = 0; i < 26; i++) {                       // base with a minor swing low at bar 12 = 1.0950
    const base = 1.0965 + Math.sin(i / 3) * 0.0008;
    const lo = i === 12 ? 1.0950 : base - 0.0004;
    bar(i, base, base + 0.0004, Math.min(base - 0.0004, lo), base + (i % 2 ? 0.0002 : -0.0002));
  }
  for (let i = 26; i < 39; i++) {                      // rally toward 1.1000
    const cc = Math.min(1.0992, 1.0965 + (i - 25) * 0.00022);
    bar(i, cc - 0.0002, cc + 0.0003, cc - 0.0003, cc);
  }
  bar(39, 1.0992, 1.1010, 1.0990, 1.0992);             // SWEEP: wick above 1.1000, close back below
  bar(40, 1.0991, 1.0992, 1.0965, 1.0968);             // displacement down (FVG)
  bar(41, 1.0966, 1.0967, 1.0940, 1.0944);             // close 1.0944 < 1.0950 swing low → BOS
  bar(42, 1.0944, 1.0946, 1.0930, 1.0934);
  bar(43, 1.0934, 1.0938, 1.0925, 1.0930);
  bar(44, 1.0930, 1.0934, 1.0922, 1.0928);
  return out;
}
// Flat noise — no obvious sweep.
function flat() {
  const out = []; const t0 = Date.UTC(2026, 5, 25, 8, 0, 0);
  for (let i = 0; i < 60; i++) { const b = 1.1000 + Math.sin(i / 4) * 0.0003; out.push({ time: new Date(t0 + i * 15 * 60000).toISOString(), open: b, high: b + 0.0002, low: b - 0.0002, close: b + (i % 2 ? 0.0001 : -0.0001), volume: 100 }); }
  return out;
}

test('null on insufficient data', () => {
  assert.strictEqual(gradeSweep([], { symbol: 'EURUSDM' }), null);
});

test('flat / no obvious sweep → null (does not fabricate a trade)', () => {
  assert.strictEqual(gradeSweep(flat(), { symbol: 'EURUSDM', h4Trend: 'NEUTRAL' }), null);
});

const sig = gradeSweep(bearishSweep(), { symbol: 'EURUSDM', h4Trend: 'BEARISH', h1Trend: 'BEARISH' });

test('clean bearish sweep of 1.10000 fires a graded SELL', () => {
  assert.ok(sig, 'expected a signal');
  assert.strictEqual(sig.decision, 'SELL');
  assert.ok(['A+', 'A', 'B'].includes(sig.grade), `grade should be >=B, got ${sig.grade}`);
});

test('all 5 components present + sweptLevel is an obvious pool', () => {
  const c = sig.meta.components;
  assert.strictEqual(c.structureShift, true, 'BOS required');
  assert.ok(c.rejectionPct >= 30, `rejection wick ${c.rejectionPct}%`);
  assert.strictEqual(c.htfContext, 'aligned', 'HTF aligned');
  assert.ok(sig.meta.sweptLevel.strength >= 3, 'swept an obvious pool');
});

test('valid SELL plan geometry + RR >= 1.8', () => {
  assert.ok(sig.stopLoss > sig.entry, 'SELL stop must be above entry (beyond the sweep wick)');
  assert.ok(sig.takeProfit1 < sig.entry && sig.takeProfit3 < sig.entry, 'targets below entry');
  assert.ok(sig.riskRewardRatio >= 1.8, `RR ${sig.riskRewardRatio}`);
  assert.ok(sig.barIso, 'barIso set (dedup anchor)');
});

test('deterministic', () => {
  const a = JSON.stringify(gradeSweep(bearishSweep(), { symbol: 'EURUSDM', h4Trend: 'BEARISH' }));
  const b = JSON.stringify(gradeSweep(bearishSweep(), { symbol: 'EURUSDM', h4Trend: 'BEARISH' }));
  assert.strictEqual(a, b);
});

console.log(`\n${passed} passed`);
