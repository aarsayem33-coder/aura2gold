import assert from 'node:assert/strict';
import {
  STRATEGIES,
  detectLiquidityTrapProPivots,
  evaluateStrategy,
  strategyTimeframes,
} from './strategyLab.js';

const ID = 'liq-trap-pro';
const START = Date.UTC(2026, 0, 1, 12);

function waveTape({ drift = 0, bars = 96 } = {}) {
  const candles = [];
  for (let i = 0; i < bars; i++) {
    const mid = 100 + drift * i + 2 * Math.sin((2 * Math.PI * i) / 8);
    candles.push({
      time: new Date(START + i * 300000).toISOString(),
      open: mid - 0.1,
      high: mid + 0.4,
      low: mid - 0.4,
      close: mid + 0.1,
      volume: 100,
    });
  }
  return candles;
}

function equalLowSweep() {
  const candles = waveTape();
  candles.push({
    time: new Date(START + candles.length * 300000).toISOString(),
    open: 98.1,
    high: 99,
    low: 97.2,
    close: 98.6,
    volume: 150,
  });
  return candles;
}

function equalHighSweep() {
  const candles = waveTape();
  candles.push({
    time: new Date(START + candles.length * 300000).toISOString(),
    open: 101.9,
    high: 102.8,
    low: 101,
    close: 101.4,
    volume: 150,
  });
  return candles;
}

function ctx(candles, overrides = {}) {
  return {
    symbol: 'XAUUSDM', timeframe: 'M5', candles, pip: 0.1,
    h4Trend: 'BULLISH', h1Trend: 'BULLISH',
    ...overrides,
  };
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (error) { process.exitCode = 1; console.error(`FAIL  ${name}\n      ${error.stack || error.message}`); }
}

test('new registry entry is separate and keeps the original Liquidity Trap evaluator', () => {
  assert(STRATEGIES[ID]);
  assert(STRATEGIES['liquidity-trap']);
  assert.notEqual(STRATEGIES[ID].evaluate, STRATEGIES['liquidity-trap'].evaluate);
  assert.equal(STRATEGIES[ID].entryOrderType, 'MARKET');
  assert.notEqual(STRATEGIES[ID].forexOnly, true, 'Pro remains measured as both forex and fixed-time');
  assert.deepEqual(strategyTimeframes(ID), ['M5', 'M15', 'M30', 'H1']);
});

test('equal-low sweep and same-bar bullish reclaim emits a fresh BUY', () => {
  const candles = equalLowSweep();
  const signal = evaluateStrategy(ID, ctx(candles));
  assert(signal);
  assert.equal(signal.decision, 'BUY');
  assert.equal(signal.barIso, candles.at(-1).time);
  assert.equal(signal.meta.strategyVersion, 2);
  assert.equal(signal.meta.sourceType, 'EQUAL_LOW');
  assert.equal(signal.meta.setupMode, 'SWEEP_REJECT');
  assert.match(signal.meta.plan, /^SWEEP_EQUAL_/);
  assert(signal.stopLoss < candles.at(-1).low, 'stop is buffered beyond the sweep wick');
  assert(signal.stopLoss < signal.entry && signal.entry < signal.takeProfit1 && signal.takeProfit1 < signal.takeProfit2 && signal.takeProfit2 < signal.takeProfit3);
  assert(signal.riskRewardRatio >= 1.5);
});

test('equal-high sweep and same-bar bearish reclaim emits a mirrored SELL', () => {
  const candles = equalHighSweep();
  const signal = evaluateStrategy(ID, ctx(candles, { h4Trend: 'BEARISH', h1Trend: 'BEARISH' }));
  assert(signal);
  assert.equal(signal.decision, 'SELL');
  assert.equal(signal.meta.sourceType, 'EQUAL_HIGH');
  assert.equal(signal.meta.setupMode, 'SWEEP_REJECT');
  assert(signal.stopLoss > candles.at(-1).high, 'stop is buffered beyond the sweep wick');
  assert(signal.stopLoss > signal.entry && signal.entry > signal.takeProfit1 && signal.takeProfit1 > signal.takeProfit2 && signal.takeProfit2 > signal.takeProfit3);
});

test('an exact equal-low touch with a closed rejection emits ZONE_REJECT', () => {
  const candles = equalLowSweep();
  candles.at(-1).low = 97.6;
  const signal = evaluateStrategy(ID, ctx(candles));
  assert(signal);
  assert.equal(signal.decision, 'BUY');
  assert.equal(signal.meta.setupMode, 'ZONE_REJECT');
  assert.match(signal.meta.plan, /^ZONE_EQUAL_/);
});

test('price outside the swing zone does not fabricate a rejection signal', () => {
  const candles = equalLowSweep();
  candles.at(-1).open = 98.3;
  candles.at(-1).close = 98.7;
  candles.at(-1).low = 97.75;
  assert.equal(evaluateStrategy(ID, ctx(candles)), null);
});

test('a historical reclaim is never re-emitted as a stale market entry', () => {
  const candles = equalLowSweep();
  candles.push({
    time: new Date(START + candles.length * 300000).toISOString(),
    open: 98.6, high: 99.1, low: 98.3, close: 98.8, volume: 100,
  });
  assert.equal(evaluateStrategy(ID, ctx(candles)), null);
});

test('H4 opposition penalizes but does not veto an otherwise exceptional reversal', () => {
  const aligned = evaluateStrategy(ID, ctx(equalLowSweep()));
  const opposed = evaluateStrategy(ID, ctx(equalLowSweep(), { h4Trend: 'BEARISH' }));
  assert(aligned && opposed);
  assert.equal(opposed.decision, 'BUY');
  assert.equal(opposed.meta.h4Against, true);
  assert(opposed.score < aligned.score);
});

test('a forming sweep candle is not used as confirmation', () => {
  assert.equal(evaluateStrategy(ID, ctx(equalLowSweep(), { candlesIncludeFormingBar: true })), null);
});

test('a prominent non-equal locked swing can sponsor a signal when its quality clears the configured floor', () => {
  const candles = waveTape({ drift: 0.04 });
  const pivots = detectLiquidityTrapProPivots(candles);
  const source = [...pivots].reverse().find((pivot) => pivot.kind === 'L');
  assert(source && source.prominenceAtr >= 1.2);
  candles.push({
    time: new Date(START + candles.length * 300000).toISOString(),
    open: source.price + 0.5,
    high: source.price + 1.4,
    low: source.price - 0.4,
    close: source.price + 1,
    volume: 150,
  });
  const signal = evaluateStrategy(ID, ctx(candles, { config: { minScore: 65 } }));
  assert(signal);
  assert.equal(signal.decision, 'BUY');
  assert.equal(signal.meta.sourceType, 'MAJOR_SWING');
  assert.match(signal.meta.plan, /^SWEEP_SWING_/);
});

test('swing-prominence thresholds reject minor source pivots', () => {
  const candles = waveTape({ drift: 0.04 });
  const source = [...detectLiquidityTrapProPivots(candles)].reverse().find((pivot) => pivot.kind === 'L');
  candles.push({
    time: new Date(START + candles.length * 300000).toISOString(),
    open: source.price + 0.5, high: source.price + 1.4,
    low: source.price - 0.4, close: source.price + 1, volume: 150,
  });
  const signal = evaluateStrategy(ID, ctx(candles, {
    config: { minScore: 0, minSwingProminenceAtr: 10, minKeySwingProminenceAtr: 10 },
  }));
  assert.equal(signal, null);
});

test('locked ZigZag pivots do not move when future volatility is appended', () => {
  const original = waveTape();
  const before = detectLiquidityTrapProPivots(original);
  const extended = [...original];
  for (let i = original.length; i < original.length + 16; i++) {
    const mid = 100 + 3 * Math.sin((2 * Math.PI * i) / 8);
    extended.push({
      time: new Date(START + i * 300000).toISOString(),
      open: mid, high: mid + 0.4, low: mid - 0.4, close: mid, volume: 100,
    });
  }
  const after = detectLiquidityTrapProPivots(extended);
  const shape = (pivots) => pivots.map(({ idx, confirmedAtIdx, kind, price, prominenceAtr }) => ({ idx, confirmedAtIdx, kind, price, prominenceAtr }));
  assert.deepEqual(shape(after).slice(0, before.length), shape(before));
});

test('evaluation is deterministic and PSAR remains measurement, not a hard gate', () => {
  const candles = equalLowSweep();
  const first = evaluateStrategy(ID, ctx(candles));
  const second = evaluateStrategy(ID, ctx(candles));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert(first?.meta?.psar);
  assert.match(first.meta.plan, /PSAR/);
});

console.log(`\n${passed} passed`);
