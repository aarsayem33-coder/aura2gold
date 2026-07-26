// H4 Liquidity Pin Entry tests. Run: node backend/h4LiquidityPinEntry.test.mjs
import assert from 'node:assert';
import { detectLiquidityPinRejection } from './liquidityEngine.js';
import { STRATEGIES, evaluateStrategy, strategyTimeframes } from './strategyLab.js';

const ID = 'h4-liquidity-pin-entry';
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (error) { process.exitCode = 1; console.error(`FAIL  ${name}\n      ${error.message}`); }
}

function buyTape({ timeframeMinutes = 15, endHour = 14, startPrice = 4012 } = {}) {
  const count = 90;
  const endMs = Date.UTC(2026, 6, 14, endHour, 0, 0);
  const startMs = endMs - (count - 1) * timeframeMinutes * 60000;
  const candles = [];
  for (let i = 0; i < count - 1; i++) {
    const close = startPrice - i * ((startPrice - 4002.2) / (count - 2));
    const open = close + 0.04;
    candles.push({
      time: new Date(startMs + i * timeframeMinutes * 60000).toISOString(),
      open,
      high: open + 0.24,
      low: close - 0.24,
      close,
      tick_volume: 100,
    });
  }
  candles.push({
    time: new Date(endMs).toISOString(),
    open: 4001.7,
    high: 4002.25,
    low: 3998.7,
    close: 4002.05,
    tick_volume: 180,
  });
  return candles;
}

function mirror(rows, pivot = 4000) {
  return rows.map((candle) => ({
    ...candle,
    open: 2 * pivot - candle.open,
    high: 2 * pivot - candle.low,
    low: 2 * pivot - candle.high,
    close: 2 * pivot - candle.close,
  }));
}

const context = (candles, overrides = {}) => ({
  symbol: 'XAUUSDM',
  timeframe: 'M15',
  candles,
  candlesIncludeFormingBar: false,
  pip: 0.01,
  h4Trend: 'BULLISH',
  h1Trend: 'NEUTRAL',
  ...overrides,
});

test('registry is gold forex-only, M15/M30, STOP-entry, and default-muted', () => {
  const strategy = STRATEGIES[ID];
  assert.ok(strategy);
  assert.equal(strategy.forexOnly, true);
  assert.equal(strategy.measureFixedTime, false);
  assert.equal(strategy.entryOrderType, 'STOP');
  assert.equal(strategy.defaultEnabled, false);
  assert.deepEqual(strategyTimeframes(ID), ['M15', 'M30']);
});

test('latest closed bullish liquidity pin is detected at the swept round number', () => {
  const event = detectLiquidityPinRejection(buyTape(), { symbol: 'XAUUSDM', pip: 0.01 });
  assert.ok(event, 'expected pin event');
  assert.equal(event.decision, 'BUY');
  assert.equal(event.level.type, 'ROUND_NUMBER');
  assert.equal(event.level.price, 4000);
  assert.ok(event.wickRatio >= 0.45);
  assert.ok(event.sweepDepth > 0);
});

test('mirrored pin is detected as SELL with mirrored liquidity semantics', () => {
  const event = detectLiquidityPinRejection(mirror(buyTape()), { symbol: 'XAUUSDM', pip: 0.01 });
  assert.ok(event, 'expected mirrored pin event');
  assert.equal(event.decision, 'SELL');
  assert.equal(event.level.price, 4000);
  assert.ok(event.extreme > event.level.price);
});

test('aligned BUY produces an honest pending STOP plan with 1R TP1', () => {
  const signal = evaluateStrategy(ID, context(buyTape()));
  assert.ok(signal, 'expected aligned signal');
  assert.equal(signal.decision, 'BUY');
  assert.equal(signal.meta.entryOrderType, 'STOP');
  assert.equal(signal.meta.requiresFill, true);
  assert.equal(signal.meta.entryState, 'WAIT');
  assert.equal(signal.meta.validBars, 2);
  assert.equal(signal.meta.forexOnly, true);
  assert.equal(signal.meta.measureFixedTime, false);
  assert.equal(signal.meta.tp1ClosePercent, 70);
  assert.equal(signal.meta.moveRunnerToBreakEven, true);
  assert.ok(signal.stopLoss < signal.entry && signal.entry < signal.takeProfit1);
  const risk = signal.entry - signal.stopLoss;
  assert.ok(Math.abs(signal.takeProfit1 - (signal.entry + risk)) < 1e-4, 'TP1 must be exactly 1R');
  assert.ok(signal.riskRewardRatio >= STRATEGIES[ID].config.minRR);
});

test('mirrored aligned SELL has correct entry, stop, and target geometry', () => {
  const signal = evaluateStrategy(ID, context(mirror(buyTape()), { h4Trend: 'BEARISH' }));
  assert.ok(signal, 'expected aligned mirrored signal');
  assert.equal(signal.decision, 'SELL');
  assert.ok(signal.stopLoss > signal.entry && signal.entry > signal.takeProfit1);
  assert.ok(signal.takeProfit1 > signal.takeProfit2 && signal.takeProfit2 > signal.takeProfit3);
});

test('strict H4 gate rejects opposition and neutral bias', () => {
  assert.equal(evaluateStrategy(ID, context(buyTape(), { h4Trend: 'BEARISH' })), null);
  assert.equal(evaluateStrategy(ID, context(buyTape(), { h4Trend: 'NEUTRAL' })), null);
  assert.equal(evaluateStrategy(ID, context(buyTape(), { h4Trend: null })), null);
});

test('strategy rejects non-gold symbols and unsupported timeframes', () => {
  assert.equal(evaluateStrategy(ID, context(buyTape(), { symbol: 'EURUSDM' })), null);
  for (const timeframe of ['M1', 'M5', 'H1', 'H4']) {
    assert.equal(evaluateStrategy(ID, context(buyTape(), { timeframe })), null, timeframe);
  }
});

test('M30 uses the same closed-pin rules', () => {
  const candles = buyTape({ timeframeMinutes: 30, startPrice: 4022 });
  const signal = evaluateStrategy(ID, context(candles, { timeframe: 'M30' }));
  assert.ok(signal);
  assert.equal(signal.decision, 'BUY');
});

test('all sessions remain measurable rather than acting as a hard gate', () => {
  const asian = evaluateStrategy(ID, context(buyTape({ endHour: 5 })));
  const overlap = evaluateStrategy(ID, context(buyTape({ endHour: 14 })));
  assert.ok(asian && overlap, 'both sessions should qualify');
  assert.equal(asian.meta.session, 'ASIAN');
  assert.equal(overlap.meta.session, 'OVERLAP');
});

test('touch, weak pin, and previously consumed liquidity are rejected', () => {
  const touch = buyTape();
  touch[touch.length - 1] = { ...touch[touch.length - 1], low: 4000 };
  assert.equal(detectLiquidityPinRejection(touch, { symbol: 'XAUUSDM', pip: 0.01 }), null, 'touch is not a sweep');

  const weak = buyTape();
  weak[weak.length - 1] = { ...weak[weak.length - 1], high: 4006.7 };
  assert.equal(detectLiquidityPinRejection(weak, { symbol: 'XAUUSDM', pip: 0.01 }), null, 'weak rejection shape must fail');

  const consumed = buyTape();
  for (let i = 78; i <= 82; i++) consumed[i] = { ...consumed[i], low: 3999.5 };
  assert.equal(detectLiquidityPinRejection(consumed, { symbol: 'XAUUSDM', pip: 0.01 }), null, 'previously raided level must fail');
});

test('forming or stale pins cannot create a signal', () => {
  const forming = buyTape();
  assert.equal(evaluateStrategy(ID, context(forming, { candlesIncludeFormingBar: true })), null, 'forming last pin must be ignored');

  const stale = buyTape();
  const pin = stale[stale.length - 1];
  stale.push({ ...pin, time: new Date(Date.parse(pin.time) + 15 * 60000).toISOString(), open: 4002.05, high: 4002.2, low: 4001.7, close: 4001.9 });
  assert.equal(evaluateStrategy(ID, context(stale)), null, 'only the latest closed bar may qualify');
});

test('detector and strategy are deterministic', () => {
  const candles = buyTape();
  assert.equal(
    JSON.stringify(detectLiquidityPinRejection(candles, { symbol: 'XAUUSDM', pip: 0.01 })),
    JSON.stringify(detectLiquidityPinRejection(candles, { symbol: 'XAUUSDM', pip: 0.01 })),
  );
  assert.equal(JSON.stringify(evaluateStrategy(ID, context(candles))), JSON.stringify(evaluateStrategy(ID, context(candles))));
});

console.log(`\n${passed} passed`);
