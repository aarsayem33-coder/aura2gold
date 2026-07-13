import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateSignals, detectFVGs, detectOrderBlocks } from './signalEngine.js';

const baseTime = Date.UTC(2026, 0, 5, 0, 0, 0);
const step = 5 * 60 * 1000;

function candles(rows) {
  return rows.map(([open, high, low, close], index) => ({
    open,
    high,
    low,
    close,
    time: new Date(baseTime + index * step).toISOString(),
  }));
}

function duplicateBullishObRows() {
  return [
    [8, 9, 7.5, 8.5],
    [8.5, 10, 8, 9],
    [9, 11, 8.5, 10],
    [14, 15, 13, 14.5],       // first swing high
    [12, 12.5, 11, 11.5],
    [11.5, 13, 10.5, 12.5],
    [13, 14, 12, 13.5],       // second swing high
    [10, 10.5, 8, 9],         // shared bearish source candle
    [9, 11, 7, 10.5],         // touches through the future OB before confirmation
    [10.5, 16.5, 10, 16],     // confirms both swing breaks
    [16, 17, 15, 16.5],
    [16.5, 17, 15.5, 16],
  ];
}

function sharedBullishOb(input) {
  const sourceTime = input[7].time;
  return detectOrderBlocks(input).filter((ob) => ob.type === 'BULLISH' && ob.time === sourceTime);
}

test('duplicate OB candidates from the same source candle are suppressed exactly once', () => {
  const input = candles(duplicateBullishObRows());
  const matches = sharedBullishOb(input);

  assert.equal(matches.length, 1);
  assert.equal(matches[0].sourceIndex, 7);
  assert.equal(matches[0].confirmationIndex, 9);
  assert.equal(matches[0].confirmationTime, input[9].time);
});

test('OB candles before confirmation cannot mitigate or invalidate the zone', () => {
  const input = candles(duplicateBullishObRows());
  const [ob] = sharedBullishOb(input);

  assert.ok(ob, 'expected the shared bullish OB');
  assert.equal(input[8].low < ob.bottom, true, 'fixture must cross the far edge before confirmation');
  assert.equal(ob.state, 'ACTIVE');
  assert.equal(ob.mitigated, false);
  assert.equal(ob.invalidated, false);
  assert.equal(ob.mitigationIndex, null);
  assert.equal(ob.invalidationIndex, null);
});

test('OB lifecycle records post-confirmation mitigation and later invalidation', () => {
  const partialInput = candles([...duplicateBullishObRows(), [16, 16.2, 9, 9.5]]);
  const [mitigated] = sharedBullishOb(partialInput);

  assert.equal(mitigated.state, 'MITIGATED');
  assert.equal(mitigated.mitigated, true);
  assert.equal(mitigated.invalidated, false);
  assert.equal(mitigated.mitigationIndex, 12);
  assert.equal(mitigated.mitigationTime, partialInput[12].time);

  const invalidInput = candles([...duplicateBullishObRows(), [16, 16.2, 9, 9.5], [9.5, 10, 8, 8.5]]);
  const [invalidated] = sharedBullishOb(invalidInput);
  assert.equal(invalidated.state, 'INVALIDATED');
  assert.equal(invalidated.invalidationIndex, 13);
  assert.equal(invalidated.invalidationTime, invalidInput[13].time);
});

test('aggregateSignals allows the first OB mitigation candle, then retires the zone', () => {
  const input = candles([...duplicateBullishObRows(), [16, 16.2, 9, 9.5]]);
  const result = aggregateSignals({ candles: input, skipNews: true });
  const ob = result.systemDecision.orderBlocks.find((item) => item.time === input[7].time);

  assert.equal(ob?.state, 'MITIGATED');
  assert.equal(ob?.firstTouchNow, true);
  assert.equal(result.systemDecision.confluences.some((item) => item.name === 'Order Block'), true);

  const later = candles([...duplicateBullishObRows(), [16, 16.2, 9, 9.5], [12, 13, 11, 12]]);
  const laterResult = aggregateSignals({ candles: later, skipNews: true });
  assert.equal(laterResult.systemDecision.confluences.some((item) => item.name === 'Order Block'), false);
});

test('FVG lifecycle starts after completion and records partial mitigation', () => {
  const input = candles([
    [9, 10, 8.5, 9.5],
    [9.5, 11.5, 9.4, 11],
    [11, 12, 11, 11.5],
    [11.5, 12, 10.5, 11],
  ]);
  const bullish = detectFVGs(input).find((fvg) => fvg.type === 'BULLISH');

  assert.ok(bullish, 'expected bullish FVG');
  assert.equal(bullish.completionIndex, 2);
  assert.equal(bullish.completionTime, input[2].time);
  assert.equal(bullish.state, 'MITIGATED');
  assert.equal(bullish.mitigationIndex, 3);
  assert.equal(bullish.filled, false);
  assert.equal(bullish.firstTouchNow, true);
});

test('aggregateSignals allows the first FVG retest candle, then retires the gap', () => {
  const flat = Array.from({ length: 20 }, () => [9.2, 9.5, 9, 9.2]);
  const firstTouch = candles([
    ...flat,
    [9, 10, 8.5, 9.5],
    [9.5, 11.5, 9.4, 11],
    [11, 12, 11, 11.5],
    [11.5, 12, 10.5, 10.8],
  ]);
  const firstResult = aggregateSignals({ candles: firstTouch, skipNews: true });
  assert.equal(firstResult.systemDecision.confluences.some((item) => item.name === 'FVG Retest'), true);

  const later = candles([
    ...flat,
    [9, 10, 8.5, 9.5],
    [9.5, 11.5, 9.4, 11],
    [11, 12, 11, 11.5],
    [11.5, 12, 10.5, 10.8],
    [11, 12, 11, 11.5],
  ]);
  const laterResult = aggregateSignals({ candles: later, skipNews: true });
  assert.equal(laterResult.systemDecision.confluences.some((item) => item.name === 'FVG Retest'), false);
});

test('an exact FVG far-edge touch counts as filled', () => {
  const bullishInput = candles([
    [9, 10, 8.5, 9.5],
    [9.5, 11.5, 9.4, 11],
    [11, 12, 11, 11.5],
    [11.5, 12, 10, 10.5],
  ]);
  const bullish = detectFVGs(bullishInput).find((fvg) => fvg.type === 'BULLISH');

  assert.equal(bullish.state, 'FILLED');
  assert.equal(bullish.filled, true);
  assert.equal(bullish.fillIndex, 3);
  assert.equal(bullish.fillTime, bullishInput[3].time);

  const bearishInput = candles([
    [11, 11.5, 10, 10.5],
    [10.5, 10.6, 8.5, 9],
    [9, 9.5, 8, 8.5],
    [8.5, 10, 8.2, 9.5],
  ]);
  const bearish = detectFVGs(bearishInput).find((fvg) => fvg.type === 'BEARISH');
  assert.equal(bearish.state, 'FILLED');
  assert.equal(bearish.filled, true);
  assert.equal(bearish.fillIndex, 3);
});

test('aggregateSignals excludes a filled FVG from scoring and SMC/DAT use', () => {
  const flat = Array.from({ length: 20 }, () => [9.2, 9.5, 9, 9.2]);
  const input = candles([
    ...flat,
    [9, 10, 8.5, 9.5],
    [9.5, 11.5, 9.4, 11],
    [11, 12, 11, 11.5],
    [11.5, 12, 10, 10.5],
  ]);
  const result = aggregateSignals({ candles: input, skipNews: true });
  const filled = result.systemDecision.fvgs.find((fvg) => fvg.type === 'BULLISH' && fvg.bottom === 10);

  assert.equal(filled?.filled, true);
  assert.equal(result.systemDecision.confluences.some((item) => item.name === 'FVG Retest'), false);
  assert.equal(result.systemDecision.bpr.active, false);
  assert.equal(result.systemDecision.strategyTags.includes('SMC'), false);
});
