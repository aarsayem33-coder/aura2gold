// Tests for gradeSweep (the 5-component high-probability sweep model) in liquidityEngine.js.
// Run: node backend/gradeSweep.test.mjs
import assert from 'node:assert';
import { detectKeyLiquidityLevels, gradeSweep } from './liquidityEngine.js';

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

function mirrored(rows, pivot = 1.1) {
  return rows.map((c) => ({
    ...c,
    open: 2 * pivot - c.open,
    high: 2 * pivot - c.low,
    low: 2 * pivot - c.high,
    close: 2 * pivot - c.close,
  }));
}

test('null on insufficient data', () => {
  assert.strictEqual(gradeSweep([], { symbol: 'EURUSDM' }), null);
});

test('flat / no obvious sweep → null (does not fabricate a trade)', () => {
  assert.strictEqual(gradeSweep(flat(), { symbol: 'EURUSDM', h4Trend: 'NEUTRAL' }), null);
});

const openBearishSweep = () => bearishSweep().slice(0, 42); // stop at the confirmation bar
const sig = gradeSweep(openBearishSweep(), { symbol: 'EURUSDM', h4Trend: 'BEARISH', h1Trend: 'BEARISH' });

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
  assert.ok(sig.entry > sig.takeProfit1 && sig.takeProfit1 > sig.takeProfit2 && sig.takeProfit2 > sig.takeProfit3, 'SELL targets strictly ordered');
  assert.ok(sig.riskRewardRatio >= 1.8, `RR ${sig.riskRewardRatio}`);
  assert.ok(sig.barIso, 'barIso set (dedup anchor)');
});

test('entry and barIso are anchored where BOS + displacement are both knowable', () => {
  const idx = sig.meta.confirmationIdx;
  const rows = openBearishSweep();
  assert.ok(idx > 39, 'confirmation must occur after the sweep bar');
  assert.strictEqual(sig.barIso, rows[idx].time);
  assert.strictEqual(sig.entry, rows[idx].close, 'entry is confirmation close, not hindsight sweep close');
});

const buySig = gradeSweep(mirrored(openBearishSweep()), { symbol: 'EURUSDM', h4Trend: 'BULLISH', h1Trend: 'BULLISH' });

test('mirrored clean bullish sweep fires with a strictly ordered BUY ladder', () => {
  assert.ok(buySig, 'expected mirrored BUY signal');
  assert.strictEqual(buySig.decision, 'BUY');
  assert.ok(buySig.stopLoss < buySig.entry && buySig.entry < buySig.takeProfit1 && buySig.takeProfit1 < buySig.takeProfit2 && buySig.takeProfit2 < buySig.takeProfit3, 'BUY geometry strictly ordered');
  assert.ok(buySig.riskRewardRatio >= 1.8);
});

test('H4 opposition veto is non-vacuous and mirrored', () => {
  assert.ok(sig && buySig, 'both aligned controls must exist');
  assert.strictEqual(gradeSweep(openBearishSweep(), { symbol: 'EURUSDM', h4Trend: 'BULLISH', h1Trend: 'BEARISH' }), null);
  assert.strictEqual(gradeSweep(mirrored(openBearishSweep()), { symbol: 'EURUSDM', h4Trend: 'BEARISH', h1Trend: 'BULLISH' }), null);
});

test('strict pierce rejects equality in both directions', () => {
  const sellTouch = openBearishSweep();
  sellTouch[39] = { ...sellTouch[39], high: 1.1 };
  const buyTouch = mirrored(openBearishSweep());
  buyTouch[39] = { ...buyTouch[39], low: 1.1 };
  assert.strictEqual(gradeSweep(sellTouch, { symbol: 'EURUSDM', h4Trend: 'BEARISH' }), null);
  assert.strictEqual(gradeSweep(buyTouch, { symbol: 'EURUSDM', h4Trend: 'BULLISH' }), null);
});

test('displacement is a hard gate and exact completed fill rejects it, mirrored', () => {
  const sellFilled = bearishSweep();
  sellFilled[42] = { ...sellFilled[42], high: 1.099 };
  const buyFilled = mirrored(sellFilled);
  assert.strictEqual(gradeSweep(sellFilled, { symbol: 'EURUSDM', h4Trend: 'BEARISH' }), null);
  assert.strictEqual(gradeSweep(buyFilled, { symbol: 'EURUSDM', h4Trend: 'BULLISH' }), null);
});

test('semantic high/low polarity produces mirrored PDH SELL and PDL BUY controls', () => {
  const sellDaily = [
    { time: '2026-06-23T00:00:00Z', high: 1.11, low: 1.07 },
    { time: '2026-06-24T00:00:00Z', high: 1.1, low: 1.08 },
    { time: '2026-06-25T00:00:00Z', high: 1.1, low: 1.08 },
  ];
  const buyDaily = sellDaily.map((d) => ({ ...d, high: 2.2 - d.low, low: 2.2 - d.high }));
  const sell = gradeSweep(openBearishSweep(), { symbol: 'XAUUSDM', dailyCandles: sellDaily, h4Trend: 'BEARISH' });
  const buy = gradeSweep(mirrored(openBearishSweep()), { symbol: 'XAUUSDM', dailyCandles: buyDaily, h4Trend: 'BULLISH' });
  assert.ok(sell && sell.decision === 'SELL' && sell.meta.sweptLevel.type === 'PDH', 'PDH is valid only as buy-side liquidity for SELL');
  assert.ok(buy && buy.decision === 'BUY' && buy.meta.sweptLevel.type === 'PDL', 'PDL is valid only as sell-side liquidity for BUY');
});

test('an already-consumed stronger level is skipped for the fresh same-bar level, mirrored', () => {
  const sellRows = openBearishSweep();
  sellRows[30] = { ...sellRows[30], high: 1.1005 }; // completed London high (strength 4), also pierced at bar 39
  const levels = detectKeyLiquidityLevels(sellRows, { symbol: 'EURUSDM' }).levels;
  assert.ok(levels.some((l) => l.type === 'LONDON_HIGH' && l.strength === 4), 'weaker eligible control level must exist');
  const sell = gradeSweep(sellRows, { symbol: 'EURUSDM', h4Trend: 'BEARISH' });
  const buy = gradeSweep(mirrored(sellRows), { symbol: 'EURUSDM', h4Trend: 'BULLISH' });
  assert.ok(sell && sell.meta.sweptLevel.type === 'LONDON_HIGH', 'SELL must skip the already-consumed round number');
  assert.ok(buy && buy.meta.sweptLevel.type === 'LONDON_LOW', 'BUY must skip the mirrored consumed round number');
});

test('deterministic', () => {
  const a = JSON.stringify(gradeSweep(openBearishSweep(), { symbol: 'EURUSDM', h4Trend: 'BEARISH' }));
  const b = JSON.stringify(gradeSweep(openBearishSweep(), { symbol: 'EURUSDM', h4Trend: 'BEARISH' }));
  assert.strictEqual(a, b);
});

test('an already-consumed level cannot sponsor a later sweep signal', () => {
  const rows = openBearishSweep();
  rows[20] = { ...rows[20], high: 1.1004, close: 1.0990, open: 1.0990 };
  const result = gradeSweep(rows, { symbol: 'EURUSDM', h4Trend: 'BEARISH' });
  assert.ok(result, 'a newly formed session level may still qualify');
  assert.notStrictEqual(result.meta.sweptLevel.type, 'ROUND_NUMBER', 'consumed round number must not be reused');
});

test('a completed structural target is not resurrected as an active setup', () => {
  const rows = bearishSweep();
  rows[42] = { ...rows[42], low: 1.079 };
  assert.strictEqual(gradeSweep(rows, { symbol: 'EURUSDM', h4Trend: 'BEARISH' }), null);
});

test('an uncompleted market-at-close setup is not emitted one bar late', () => {
  const rows = openBearishSweep();
  const last = rows[rows.length - 1];
  rows.push({ ...last, time: new Date(Date.parse(last.time) + 15 * 60000).toISOString(), open: 1.0943, high: 1.0948, low: 1.0938, close: 1.0942 });
  assert.strictEqual(gradeSweep(rows, { symbol: 'EURUSDM', h4Trend: 'BEARISH' }), null);
});

console.log(`\n${passed} passed`);
