import test from 'node:test';
import assert from 'node:assert/strict';
import { tfMinutes, estimateEtaMinutes, rankScore, etaLabel, rankPredictions } from './strategyPredictions.js';

test('tfMinutes covers the intraday ladder and rejects the rest', () => {
  assert.equal(tfMinutes('M5'), 5);
  assert.equal(tfMinutes('M15'), 15);
  assert.equal(tfMinutes('M30'), 30);
  assert.equal(tfMinutes('H1'), 60);
  assert.equal(tfMinutes('H4'), 240);
  for (const bad of ['D1', 'W1', '', null, 'nonsense']) assert.equal(tfMinutes(bad), 0);
});

test('a tradable setup has no wait', () => {
  assert.equal(estimateEtaMinutes({ status: 'TRADABLE', price: 100, entry: 101, atr: 1, timeframe: 'M15' }), 0);
});

test('an expired setup has no ETA at all', () => {
  assert.equal(estimateEtaMinutes({ status: 'EXPIRED', price: 100, entry: 101, atr: 1, timeframe: 'M15' }), null);
});

test('waiting setups scale with distance and timeframe', () => {
  // 1 ATR away, half an ATR of progress per bar -> 2 bars.
  const m15 = estimateEtaMinutes({ status: 'WAIT', price: 100, entry: 102, atr: 2, timeframe: 'M15' });
  assert.equal(m15, 30, '2 bars of M15');
  const m5 = estimateEtaMinutes({ status: 'WAIT', price: 100, entry: 102, atr: 2, timeframe: 'M5' });
  assert.equal(m5, 10, 'same distance is sooner on a faster timeframe');
  const far = estimateEtaMinutes({ status: 'WAIT', price: 100, entry: 110, atr: 2, timeframe: 'M15' });
  assert.ok(far > m15, 'further away takes longer');
});

test('no ETA is invented when an input is missing', () => {
  for (const bad of [
    { status: 'WAIT', price: NaN, entry: 102, atr: 2, timeframe: 'M15' },
    { status: 'WAIT', price: 100, entry: 102, atr: 0, timeframe: 'M15' },
    { status: 'WAIT', price: 100, entry: 102, atr: 2, timeframe: 'D1' },
  ]) assert.equal(estimateEtaMinutes(bad), null);
});

test('rank weights quality by how soon it can be taken', () => {
  const now = rankScore(80, 0, 180);
  const edge = rankScore(80, 180, 180);
  assert.ok(now > edge, 'the same score is worth more when it is tradable now');
  assert.equal(now, 80);
  assert.equal(edge, 48, '0.6x weight at the horizon edge');
});

test('a tradable good setup outranks a distant excellent one', () => {
  const tradableA = rankScore(78, 0, 180);
  const distantAplus = rankScore(92, 175, 180);
  assert.ok(tradableA > distantAplus, `${tradableA} should beat ${distantAplus}`);
});

test('etaLabel reads naturally', () => {
  assert.equal(etaLabel(0), 'now');
  assert.equal(etaLabel(25), '~25m');
  assert.equal(etaLabel(60), '~1h');
  assert.equal(etaLabel(95), '~1h 35m');
  assert.equal(etaLabel(null), 'unknown');
});

test('the horizon is a hard filter, not a preference', () => {
  const rows = [
    { symbol: 'A', score: 95, etaMinutes: 600 },   // 10h away
    { symbol: 'B', score: 70, etaMinutes: 30 },
  ];
  const out = rankPredictions(rows, { horizonMinutes: 180 });
  assert.equal(out.length, 1);
  assert.equal(out[0].symbol, 'B', 'the 10h setup is not a 3h prediction');
});

test('rows without a usable ETA are dropped, not floated to the bottom', () => {
  const out = rankPredictions([
    { symbol: 'A', score: 99, etaMinutes: null },
    { symbol: 'B', score: 60, etaMinutes: 10 },
  ], { horizonMinutes: 180 });
  assert.equal(out.length, 1);
  assert.equal(out[0].symbol, 'B');
});

test('ordering puts the best combination first and ties break on time', () => {
  const out = rankPredictions([
    { symbol: 'FAR', score: 90, etaMinutes: 170 },
    { symbol: 'NOW', score: 82, etaMinutes: 0 },
    { symbol: 'SOON', score: 82, etaMinutes: 20 },
  ], { horizonMinutes: 180 });
  assert.equal(out[0].symbol, 'NOW');
  assert.equal(out[1].symbol, 'SOON', 'equal score, sooner wins');
  assert.ok(out.every((r) => typeof r.etaLabel === 'string'));
});

test('an empty or missing list is handled', () => {
  assert.deepEqual(rankPredictions([], {}), []);
  assert.deepEqual(rankPredictions(null, {}), []);
});

import { estimateResolveMinutes } from './strategyPredictions.js';

test('resolve time scales with the distance to target', () => {
  // 1 ATR to target, half an ATR per bar -> 2 bars of M15 = 30 min.
  assert.equal(estimateResolveMinutes({ entry: 100, target: 102, atr: 2, timeframe: 'M15' }), 30);
  assert.ok(estimateResolveMinutes({ entry: 100, target: 110, atr: 2, timeframe: 'M15' }) > 30);
  assert.equal(estimateResolveMinutes({ entry: 100, target: 100, atr: 2, timeframe: 'M15' }), 0);
});

test('resolve time is null rather than guessed when inputs are missing', () => {
  assert.equal(estimateResolveMinutes({ entry: 100, target: 102, atr: 0, timeframe: 'M15' }), null);
  assert.equal(estimateResolveMinutes({ entry: 100, target: 102, atr: 2, timeframe: 'D1' }), null);
});

test('a market setup whose target is a session away is outside a 3h window', () => {
  const out = rankPredictions([
    { symbol: 'SLOW', score: 95, etaMinutes: 0, resolveMinutes: 600 },   // entrable now, resolves in 10h
    { symbol: 'FITS', score: 70, etaMinutes: 0, resolveMinutes: 45 },
  ], { horizonMinutes: 180 });
  assert.equal(out.length, 1, 'the 10h-to-target setup does not belong on a 3h page');
  assert.equal(out[0].symbol, 'FITS');
});

test('entry wait and target travel are both counted against the horizon', () => {
  const out = rankPredictions([
    { symbol: 'TIGHT', score: 80, etaMinutes: 100, resolveMinutes: 100 },  // 200 total
    { symbol: 'OK', score: 80, etaMinutes: 100, resolveMinutes: 60 },      // 160 total
  ], { horizonMinutes: 180 });
  assert.deepEqual(out.map((r) => r.symbol), ['OK']);
  assert.equal(out[0].totalMinutes, 160);
});
