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

// Synthetic Plan A: a bearish cloud stays below an untouched 5-dot round number,
// then a completed sweep candle wicks through it and closes back below. The next
// CLOSED candle follows through; the final row is the current forming candle.
function sweepRejectCandles() {
  const rows = [];
  let p = 1.09750;
  for (let i = 0; i < 100; i++) {
    const o = p;
    p -= 0.000035;
    rows.push([o, Math.max(o, p) + 0.00012, Math.min(o, p) - 0.00012, p]);
  }
  rows.push([p, 1.10030, p - 0.00020, p + 0.00005]); // completed sweep; body remains below 1.10000
  rows.push([p + 0.00005, p + 0.00010, p - 0.00065, p - 0.00055]); // completed bearish follow-through
  rows.push([p - 0.00055, p - 0.00025, p - 0.00060, p - 0.00058]); // forming bar has not touched confirmation trigger
  return mkCandles(rows);
}

const ctxFor = (candles, extra = {}) => ({ symbol: 'EURUSDM', timeframe: 'M15', candles, candlesIncludeFormingBar: true, pip: 0.0001, h4Trend: null, h1Trend: null, config: { maxTargetAtr: 30 }, ...extra });

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
  assert(sig !== null, 'expected a signal (round-number sweep, closed confirmation, H1 aligned)');
  assert(sig.decision === 'SELL', `direction should be SELL, got ${sig.decision}`);
  assert(sig.meta?.plan === 'SWEEP-REJECT', 'plan A');
  assert(sig.meta?.requiresFill === true, 'fill-gated honest measurement');
  assert(sig.meta?.entryOrderType === 'STOP', 'Plan A must be a stop entry');
  assert(sig.meta?.strategyVersion === 2, 'new signal must be version 2');
  assert(sig.meta?.measureFixedTime === false, 'forex-only strategy must not be scored as fixed-time');
  assert(sig.meta?.forexOnly === true, 'forex framing only');
  assert(Number.isFinite(sig.entry) && Number.isFinite(sig.stopLoss) && Number.isFinite(sig.takeProfit3), 'prices');
  assert(sig.stopLoss > sig.entry && sig.takeProfit3 < sig.entry, 'SELL geometry');
  assert(sig.riskRewardRatio >= 1.8, 'RR floor respected');
  assert(sig.score >= 72 && sig.score <= 97, 'score in band');
});

test('forming follow-through candle cannot create a signal', () => {
  const withoutTrailingFormingBar = sweepRejectCandles().slice(0, -1);
  assert(evaluateStrategy(ID, ctxFor(withoutTrailingFormingBar, { h1Trend: 'BEARISH' })) === null, 'confirmation must be closed');
});

test('closed-bar scanner context keeps the latest confirmation bar', () => {
  const closedBars = sweepRejectCandles().slice(0, -1);
  const sig = evaluateStrategy(ID, ctxFor(closedBars, { candlesIncludeFormingBar: false, h1Trend: 'BEARISH' }));
  assert(sig?.meta?.plan === 'SWEEP-REJECT', 'must not drop the second valid closed bar');
  assert(sig.barIso === closedBars[closedBars.length - 1].time, 'alert is anchored to the closed confirmation');
});

test('pre-alert touch of the confirmation trigger is rejected as late', () => {
  const candles = sweepRejectCandles();
  candles[candles.length - 1].low = candles[candles.length - 2].low - 0.00001;
  assert(evaluateStrategy(ID, ctxFor(candles, { h1Trend: 'BEARISH' })) === null, 'late trigger must not alert');
});

test('an older closed confirmation cannot alert after a later candle', () => {
  const candles = sweepRejectCandles();
  const forming = candles.pop();
  const confirmation = candles[candles.length - 1];
  const tfMs = 15 * 60 * 1000;
  candles.push({
    ...forming,
    time: new Date(Date.parse(confirmation.time) + tfMs).toISOString(),
    high: confirmation.high - 0.00005,
    low: confirmation.low + 0.00005,
    close: confirmation.close,
  });
  candles.push({
    ...forming,
    time: new Date(Date.parse(confirmation.time) + 2 * tfMs).toISOString(),
    high: confirmation.high - 0.00005,
    low: confirmation.low + 0.00006,
    close: confirmation.close,
  });
  assert(evaluateStrategy(ID, ctxFor(candles, { h1Trend: 'BEARISH' })) === null, 'stale confirmation must not alert');
});

test('strategy hard-rejects every timeframe except M15/M30', () => {
  const candles = sweepRejectCandles();
  for (const timeframe of ['M1', 'M5', 'H1', 'H4', 'D1']) {
    assert(evaluateStrategy(ID, ctxFor(candles, { timeframe, h1Trend: 'BEARISH' })) === null, `${timeframe} must be rejected`);
  }
});

test('never fights a clear H4: bullish H4 kills the synthetic SELL', () => {
  const sig = evaluateStrategy(ID, ctxFor(sweepRejectCandles(), { h4Trend: 'BULLISH' }));
  assert(sig === null || sig.decision !== 'SELL', 'SELL must be vetoed under bullish H4');
});

console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
