// LIL SWEEP-PRO+ tests — registry contract, null discipline, determinism, and a
// synthetic Plan A sweep-rejection that must produce a well-formed trigger signal.
// Run: node backend/lilSweepProPlus.test.mjs
import { STRATEGIES, evaluateStrategy, strategyTimeframes } from './strategyLab.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.error(`FAIL  ${name}: ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const ID = 'lil-sweep-pro-plus';

// Candle factory: ISO times spaced by tfSec, London hours so the session gate is warm.
function mkCandles(rows, { tfSec = 900 } = {}) {
  const t0 = Date.UTC(2026, 5, 9, 9, 0, 0); // Tuesday 09:00 UTC (London)
  return rows.map((r, i) => ({
    time: new Date(t0 + i * tfSec * 1000).toISOString(),
    open: r[0], high: r[1], low: r[2], close: r[3], tick_volume: r[4] ?? 100,
  }));
}

// Flat, dead market — no levels worth trading, no signal.
function flatCandles(nBars = 120, base = 1.1) {
  const rows = [];
  for (let i = 0; i < nBars; i++) {
    const w = 0.0004 * Math.sin(i / 3);
    rows.push([base + w, base + w + 0.0003, base + w - 0.0003, base + w + 0.0001]);
  }
  return mkCandles(rows);
}

// Synthetic Plan A: a rising market prints a clean PDH-style high zone with EQUAL
// highs at `lvl`, then a sweep candle wicks through it, closes back below, the next
// candle drives down, and price holds below into the last bar.
function sweepRejectCandles() {
  const rows = [];
  const lvl = 1.10500;
  let p = 1.09600;
  for (let i = 0; i < 70; i++) { const o = p; p += 0.00012; rows.push([o, Math.max(o, p) + 0.0002, Math.min(o, p) - 0.0002, p]); }
  // Two equal highs AT the level (visible stop cluster), pull back between them.
  rows.push([p, lvl, p - 0.0004, lvl - 0.0012]);
  for (let i = 0; i < 6; i++) rows.push([lvl - 0.0012, lvl - 0.0008, lvl - 0.0022, lvl - 0.0015]);
  rows.push([lvl - 0.0015, lvl, lvl - 0.0018, lvl - 0.0010]);
  for (let i = 0; i < 4; i++) rows.push([lvl - 0.0010, lvl - 0.0006, lvl - 0.0020, lvl - 0.0012]);
  // THE SWEEP: wick 8 pips through the equal highs, close back 6 pips below.
  rows.push([lvl - 0.0012, lvl + 0.0008, lvl - 0.0014, lvl - 0.0006]);
  // Follow-through down, then holding below the level (never re-closing above).
  rows.push([lvl - 0.0006, lvl - 0.0004, lvl - 0.0016, lvl - 0.0014]);
  rows.push([lvl - 0.0014, lvl - 0.0010, lvl - 0.0020, lvl - 0.0016]);
  return mkCandles(rows);
}

const ctxFor = (candles, extra = {}) => ({ symbol: 'EURUSDM', timeframe: 'M15', candles, pip: 0.0001, h4Trend: null, h1Trend: null, ...extra });

test('registry contract: id, name, forex TFs, evaluate function', () => {
  const s = STRATEGIES[ID];
  assert(s, 'registered');
  assert(s.name === 'LIL SWEEP-PRO+', 'name');
  assert(typeof s.evaluate === 'function', 'evaluate');
  assert(strategyTimeframes(ID).includes('M15'), 'timeframes');
  assert(s.config.minLevelStrength >= 4, 'watches only the strongest levels');
  assert(s.config.minRR >= 1.8, 'RR floor');
});

test('flat market → null (no strong levels, no trade)', () => {
  assert(evaluateStrategy(ID, ctxFor(flatCandles())) === null, 'expected null');
});

test('insufficient data → null, never throws', () => {
  assert(evaluateStrategy(ID, ctxFor(mkCandles([[1.1, 1.101, 1.099, 1.1005]]))) === null, 'expected null');
  assert(evaluateStrategy(ID, ctxFor([])) === null, 'expected null');
});

test('deterministic: same candles → identical result', () => {
  const c = sweepRejectCandles();
  const a = evaluateStrategy(ID, ctxFor(c));
  const b = evaluateStrategy(ID, ctxFor(c));
  assert(JSON.stringify(a) === JSON.stringify(b), 'must be deterministic');
});

test('synthetic sweep-rejection + H1 alignment → well-formed SELL trigger', () => {
  const sig = evaluateStrategy(ID, ctxFor(sweepRejectCandles(), { h1Trend: 'BEARISH' }));
  assert(sig !== null, 'expected a signal (equal-highs sweep, all 4 conditions, H1 aligned)');
  assert(sig.decision === 'SELL', `direction should be SELL, got ${sig.decision}`);
  assert(sig.meta?.plan === 'SWEEP-REJECT', 'plan A');
  assert(sig.meta?.requiresFill === true, 'fill-gated honest measurement');
  assert(sig.meta?.forexOnly === true, 'forex framing only');
  assert(Number.isFinite(sig.entry) && Number.isFinite(sig.stopLoss) && Number.isFinite(sig.takeProfit3), 'prices');
  assert(sig.stopLoss > sig.entry && sig.takeProfit3 < sig.entry, 'SELL geometry');
  assert(sig.riskRewardRatio >= 1.8, 'RR floor respected');
  assert(sig.score >= 72 && sig.score <= 97, 'score in band');
});

test('never fights a clear H4: bullish H4 kills the synthetic SELL', () => {
  const sig = evaluateStrategy(ID, ctxFor(sweepRejectCandles(), { h4Trend: 'BULLISH' }));
  assert(sig === null || sig.decision !== 'SELL', 'SELL must be vetoed under bullish H4');
});

console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
