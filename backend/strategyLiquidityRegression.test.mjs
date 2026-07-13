// Strategy Lab liquidity regressions. Run: node backend/strategyLiquidityRegression.test.mjs
import assert from 'node:assert';
import { detectKeyLiquidityLevels } from './liquidityEngine.js';
import {
  STRATEGIES,
  booksLevels,
  dedupeStrategyVotes,
  evaluateStrategy,
  smcDealingRange,
  smcFreshFvg,
  smcRecentSweep,
  strategyTimeframes,
  tpLadder,
} from './strategyLab.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (error) { process.exitCode = 1; console.error(`FAIL  ${name}\n      ${error.message}`); }
}

const bar = (i, open = 10, high = 10.4, low = 9.6, close = 10) => ({
  time: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), open, high, low, close, volume: 100,
});

function lowSweepTape() {
  const candles = Array.from({ length: 30 }, (_, i) => bar(i));
  candles[5] = bar(5, 9, 9.5, 8, 9); // confirmed fractal low at 8
  return candles;
}

test('SMC sweep requires a strict, recent pierce and prompt reclaim', () => {
  const valid = lowSweepTape();
  valid[20] = bar(20, 8.2, 8.4, 7.8, 8.2);
  const sweep = smcRecentSweep(valid, { lookback: 12, maxReclaimBars: 2 });
  assert.equal(sweep?.sweepIdx, 20);
  assert.equal(sweep?.reclaimIdx, 20);
  assert.equal(smcRecentSweep(valid, { lookback: 5, maxReclaimBars: 2 }), null, 'old sweep must age out even if its level is old');

  const equalTouch = lowSweepTape();
  equalTouch[20] = bar(20, 8.2, 8.4, 8, 8.2);
  assert.equal(smcRecentSweep(equalTouch, { lookback: 12 }), null, 'touching the level is not a sweep');

  const lateReclaim = lowSweepTape();
  lateReclaim[20] = bar(20, 8.1, 8.3, 7.8, 7.9);
  for (let i = 21; i <= 23; i++) lateReclaim[i] = bar(i, 7.9, 8.1, 8.05, 7.9);
  lateReclaim[24] = bar(24, 7.9, 8.4, 8.05, 8.2);
  assert.equal(smcRecentSweep(lateReclaim, { lookback: 12, maxReclaimBars: 2 }), null, 'must not pair a stale pierce with a later close');
});

test('a later breach invalidates the prior sweep/reclaim episode', () => {
  const candles = lowSweepTape();
  candles[20] = bar(20, 8.2, 8.4, 7.8, 8.2); // valid reclaim
  for (let i = 21; i < candles.length; i++) candles[i] = bar(i, 7.4, 7.6, 7.2, 7.4);
  candles[23] = bar(23, 7.4, 7.6, 7.1, 7.4); // later breach, never reclaimed
  assert.equal(smcRecentSweep(candles, { lookback: 12, maxReclaimBars: 2 }), null);
});

test('FVG must complete after reclaim and remain not fully filled', () => {
  const candles = Array.from({ length: 7 }, (_, i) => bar(i));
  candles[3] = bar(3, 9.8, 10, 9.7, 9.9);
  candles[4] = bar(4, 9.9, 11.2, 9.8, 11.1);
  candles[5] = bar(5, 11.0, 11.4, 10.5, 11.2); // bullish FVG completes here
  candles[6] = bar(6, 11.2, 11.5, 10.3, 11.3); // partial fill only
  assert.equal(smcFreshFvg(candles, 'BULLISH', 1, { reclaimIdx: 5, minDispAtr: 0.6 }), null, 'same-bar completion is not post-reclaim');
  const fresh = smcFreshFvg(candles, 'BULLISH', 1, { reclaimIdx: 4, minDispAtr: 0.6 });
  assert.equal(fresh?.createIdx, 5);
  candles[6].low = 10; // reaches the far edge: full fill
  assert.equal(smcFreshFvg(candles, 'BULLISH', 1, { reclaimIdx: 4, minDispAtr: 0.6 }), null);
});

test('dealing range uses one coherent swing pair that predates the event', () => {
  const candles = Array.from({ length: 18 }, (_, i) => bar(i));
  candles[4] = bar(4, 12, 15, 11, 12);
  candles[8] = bar(8, 7, 8, 5, 7);
  candles[13] = bar(13, 16, 20, 15, 16); // pivot needs bar 15, so it did not exist before event 15
  const range = smcDealingRange(candles, 15);
  assert.deepEqual(range && { high: range.high, low: range.low, hiIdx: range.hiIdx, loIdx: range.loIdx }, { high: 15, low: 5, hiIdx: 4, loIdx: 8 });
});

test('liquidity-family votes are deduped before direction counting', () => {
  const raw = [
    { src: 'ICT', dir: 'BUY', score: 90, family: 'liquidity-event' },
    { src: 'Trap', dir: 'BUY', score: 80, family: 'liquidity-event' },
    { src: 'FVG', dir: 'BUY', score: 70, family: 'liquidity-event' },
    { src: 'Trend', dir: 'SELL', score: 75 },
    { src: 'Location', dir: 'SELL', score: 72 },
  ];
  const independent = dedupeStrategyVotes(raw);
  assert.equal(independent.filter((v) => v.dir === 'BUY').length, 1);
  assert.equal(independent.filter((v) => v.dir === 'SELL').length, 2);
  assert.equal(independent.find((v) => v.family === 'liquidity-event').src, 'ICT');
});

test('books key-level candidates contain no stale liquidity levels', () => {
  const candles = Array.from({ length: 90 }, (_, i) => bar(i, 1.1, 1.101, 1.099, 1.1));
  candles[70] = bar(70, 1.1, 1.106, 1.099, 1.101); // sweeps nearby round levels
  const detected = detectKeyLiquidityLevels(candles, { symbol: 'EURUSDM' }).levels;
  assert(detected.some((l) => l.strength >= 3 && !l.fresh), 'fixture must include a stale key level');
  const levels = booksLevels({ candles, symbol: 'EURUSDM' }, { kijun: 1.09, cloudTop: 1.11, cloudBot: 1.08 }, { ok: false });
  const bookKeys = levels.filter((l) => l.kind === 'KEY_LEVEL');
  for (const level of bookKeys) {
    const source = detected.find((l) => l.price === level.price && (l.label || l.type) === level.label);
    assert(source?.fresh === true && !source.swept, `stale obstacle leaked: ${level.label}`);
  }
});

test('TP ladder stays strictly ordered and keeps the supplied structural target', () => {
  const buy = tpLadder('BUY', 100, 10, 108);
  assert(buy.takeProfit1 < buy.takeProfit2 && buy.takeProfit2 < buy.takeProfit3);
  assert.equal(buy.takeProfit3, 108);
  const sell = tpLadder('SELL', 100, 10, 92);
  assert(sell.takeProfit1 > sell.takeProfit2 && sell.takeProfit2 > sell.takeProfit3);
  assert.equal(sell.takeProfit3, 92);
  assert.equal(tpLadder('BUY', 100, 10, 99), null, 'wrong-side structural target must be rejected');
});

test('forex-only registry contract and ICT timeframe expansion are preserved', () => {
  for (const id of ['xau-session-raid', 'special-forex-sniper']) {
    assert.equal(STRATEGIES[id].forexOnly, true, id);
    assert.equal(STRATEGIES[id].measureFixedTime, false, id);
  }
  assert.deepEqual(strategyTimeframes('ict-breaker'), ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1']);
  assert.equal(STRATEGIES['ict-breaker'].entryOrderType, 'LIMIT');
});

test('evaluateStrategy logs useful context and contains strategy exceptions', () => {
  const id = '__throwing-regression__';
  STRATEGIES[id] = { id, forexOnly: true, config: {}, evaluate: () => { throw new Error('synthetic failure'); } };
  const calls = [];
  const original = console.error;
  console.error = (...args) => calls.push(args);
  try {
    const result = evaluateStrategy(id, { symbol: 'EURUSDM', timeframe: 'M15', candles: [bar(1)] });
    assert.equal(result, null);
  } finally {
    console.error = original;
    delete STRATEGIES[id];
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].strategy, id);
  assert.equal(calls[0][1].symbol, 'EURUSDM');
  assert.match(calls[0][1].error, /synthetic failure/);
});

test('evaluateStrategy stamps emitted forex-only signals', () => {
  const id = '__forex-only-regression__';
  STRATEGIES[id] = { id, forexOnly: true, measureFixedTime: false, evaluate: () => ({ decision: 'BUY', meta: { source: 'fixture' } }) };
  try {
    const signal = evaluateStrategy(id, { candles: [] });
    assert.equal(signal.meta.forexOnly, true);
    assert.equal(signal.meta.measureFixedTime, false);
    assert.equal(signal.meta.source, 'fixture');
    assert.equal(signal.meta.entryOrderType, 'MARKET');
  } finally { delete STRATEGIES[id]; }
});

test('evaluateStrategy distinguishes market-at-close and resting limit entries', () => {
  const marketId = '__market-entry-regression__';
  const limitId = '__limit-entry-regression__';
  STRATEGIES[marketId] = { id: marketId, evaluate: () => ({ decision: 'BUY' }) };
  STRATEGIES[limitId] = { id: limitId, entryOrderType: 'LIMIT', evaluate: () => ({ decision: 'BUY' }) };
  try {
    const market = evaluateStrategy(marketId, { candles: [] });
    const limit = evaluateStrategy(limitId, { candles: [] });
    assert.equal(market.meta.entryOrderType, 'MARKET');
    assert.equal(market.meta.requiresFill, false);
    assert.equal(limit.meta.entryOrderType, 'LIMIT');
    assert.equal(limit.meta.requiresFill, true);
  } finally {
    delete STRATEGIES[marketId];
    delete STRATEGIES[limitId];
  }
});

console.log(`\n${passed} passed`);
