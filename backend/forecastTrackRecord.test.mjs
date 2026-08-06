import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTrackRecord, trackRecordFor, GROUPINGS, TRACK_DEFAULTS,
} from './forecastTrackRecord.js';

/** A resolved forecast row. */
const row = (o = {}) => ({
  strategy: 'liquidity-trap', symbol: 'EURUSD', timeframe: 'M15', levelType: 'PDH',
  matched: true, hitR: 1.5, ...o,
});
const many = (count, o = {}) => Array.from({ length: count }, () => row(o));
const forecast = (o = {}) => ({
  bestStrategy: 'liquidity-trap', symbol: 'EURUSD', timeframe: 'M15', levelType: 'PDH', ...o,
});

// ── rates ────────────────────────────────────────────────────────────────────

test('match rate is over ALL forecasts, win rate only over settled ones', () => {
  // Dividing wins by all forecasts would understate every strategy that waits for its setup.
  const rec = buildTrackRecord([
    ...many(10, { matched: true, hitR: 2 }),
    ...many(10, { matched: false, hitR: null }),
  ], { minSample: 5 });
  const t = rec.tables.get('strategy').get('liquidity-trap');
  assert.equal(t.n, 20);
  assert.equal(t.matchRate, 0.5, '10 of 20 matched');
  assert.equal(t.winRate, 1, '10 of 10 SETTLED won');
  assert.equal(t.settled, 10);
});

test('a strategy with nothing settled has a null win rate, not zero', () => {
  // A zero would rank it below a genuine loser.
  const rec = buildTrackRecord(many(25, { hitR: null }), { minSample: 5 });
  assert.equal(rec.tables.get('strategy').get('liquidity-trap').winRate, null);
});

test('losses count as settled and drag the rate down', () => {
  const rec = buildTrackRecord([...many(6, { hitR: 2 }), ...many(4, { hitR: -1 })], { minSample: 5 });
  assert.equal(rec.tables.get('strategy').get('liquidity-trap').winRate, 0.6);
});

test('rows missing a grouping field are skipped, not bucketed under empty', () => {
  const rec = buildTrackRecord([...many(5), ...many(5, { levelType: null })], { minSample: 1 });
  assert.equal(rec.tables.get('strategy|levelType').get('liquidity-trap|PDH').n, 5);
  assert.equal(rec.tables.get('strategy').get('liquidity-trap').n, 10, 'coarser grouping keeps them');
});

// ── the sample floor, which is the whole point ───────────────────────────────

test('a perfect record on a tiny sample earns NO badge', () => {
  // The measured reality: strategy x symbol x tf x level has a median sample of 1 and a max of
  // 13 across 781 resolved forecasts. 100% of 4 is not evidence.
  const rec = buildTrackRecord(many(4, { matched: true, hitR: 3 }), { minSample: 20 });
  const t = trackRecordFor(forecast(), rec);
  assert.equal(t.qualifies, false);
  assert.match(t.reason, /not enough history/);
});

test('the badge uses the FINEST grouping that clears the floor', () => {
  // 25 rows on the exact combo — the most specific evidence available, so it should be used.
  const rec = buildTrackRecord(many(25, { matched: true, hitR: 2 }), { minSample: 20 });
  const t = trackRecordFor(forecast(), rec);
  assert.equal(t.qualifies, true);
  assert.equal(t.groupingKey, GROUPINGS[0].key, 'the finest grouping');
  assert.equal(t.n, 25);
});

test('when the fine combo is thin it falls back to a coarser one', () => {
  const rec = buildTrackRecord([
    ...many(5, { symbol: 'EURUSD', hitR: 2 }),        // thin on the exact combo
    ...many(30, { symbol: 'GBPUSD', hitR: 2 }),       // but the strategy has history
  ], { minSample: 20 });
  const t = trackRecordFor(forecast(), rec);
  assert.equal(t.qualifies, true);
  assert.notEqual(t.groupingKey, GROUPINGS[0].key);
  assert.ok(t.n >= 20);
});

test('the grouping actually used is always reported', () => {
  // A badge that will not say what it measured is worse than no badge.
  const rec = buildTrackRecord(many(25, { hitR: 2 }), { minSample: 20 });
  const t = trackRecordFor(forecast(), rec);
  assert.ok(t.grouping && t.grouping.length > 3);
  assert.match(t.reason, /over 25/);
});

// ── thresholds ───────────────────────────────────────────────────────────────

test('either a 70% win rate OR an 80% match rate earns the tick', () => {
  const winOnly = buildTrackRecord([...many(18, { hitR: 2, matched: false }), ...many(7, { hitR: -1, matched: false })], { minSample: 20 });
  const w = trackRecordFor(forecast(), winOnly);
  assert.equal(w.qualifies, true);
  assert.equal(w.basis, 'win rate');

  const matchOnly = buildTrackRecord([...many(21, { matched: true, hitR: -1 }), ...many(4, { matched: false, hitR: -1 })], { minSample: 20 });
  const m = trackRecordFor(forecast(), matchOnly);
  assert.equal(m.qualifies, true);
  assert.equal(m.basis, 'match rate');
});

test('clearing both is reported as both', () => {
  const rec = buildTrackRecord(many(25, { matched: true, hitR: 2 }), { minSample: 20 });
  assert.equal(trackRecordFor(forecast(), rec).basis, 'both');
});

test('a big sample that misses both bars gets no tick, and says why', () => {
  const rec = buildTrackRecord([...many(10, { matched: true, hitR: 2 }), ...many(30, { matched: false, hitR: -1 })], { minSample: 20 });
  const t = trackRecordFor(forecast(), rec);
  assert.equal(t.qualifies, false);
  assert.match(t.reason, /below the bar/);
  assert.ok(t.n >= 20, 'the evidence is still reported');
});

test('the thresholds are the documented ones', () => {
  assert.equal(TRACK_DEFAULTS.minWinRate, 0.70);
  assert.equal(TRACK_DEFAULTS.minMatchRate, 0.80);
  assert.equal(TRACK_DEFAULTS.minSample, 20);
});

test('custom thresholds are honoured', () => {
  const rec = buildTrackRecord(many(25, { matched: false, hitR: 2 }), { minSample: 20 });
  assert.equal(trackRecordFor(forecast(), rec, { minWinRate: 0.99 }).qualifies, true, '100% clears 99%');
  const half = buildTrackRecord([...many(13, { hitR: 2, matched: false }), ...many(12, { hitR: -1, matched: false })], { minSample: 20 });
  assert.equal(trackRecordFor(forecast(), half, { minWinRate: 0.7 }).qualifies, false);
});

// ── missing inputs ───────────────────────────────────────────────────────────

test('no history at all is stated plainly, not shown as a failure', () => {
  // "Not enough history" and "performed badly" are different claims.
  const t = trackRecordFor(forecast(), buildTrackRecord([]));
  assert.equal(t.qualifies, false);
  assert.match(t.reason, /not enough history/);
});

test('a forecast with no strategy cannot be judged', () => {
  const rec = buildTrackRecord(many(25), { minSample: 20 });
  const t = trackRecordFor(forecast({ bestStrategy: null }), rec);
  assert.equal(t.qualifies, false);
});

test('a missing record object never throws', () => {
  assert.equal(trackRecordFor(forecast(), null).qualifies, false);
  assert.equal(trackRecordFor(forecast(), {}).qualifies, false);
});
