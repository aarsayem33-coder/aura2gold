import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normaliseSymbols, buildBatchSql, buildBatchArgs, groupBatchRows, dedupeSeriesRequests, tailOf,
} from './candleBatch.js';

// The batched loader replaced one-query-per-symbol on the path that feeds ICT predictions and
// setup forecasts — both of which can place real orders. The hosted DB is privilege-revoked, so
// these tests are the only proof the batched path returns what the per-symbol path returned.

const row = (symbol, iso, over = {}) => ({
  symbol, candle_time: iso,
  open_price: 1, high: 2, low: 0.5, close_price: 1.5, volume: 100, ...over,
});

// ── SQL shape ────────────────────────────────────────────────────────────────

test('one subquery per symbol, so the LIMIT applies per symbol', () => {
  // The bug this prevents: `WHERE symbol IN (...) ORDER BY t DESC LIMIT 400` returns 400 rows
  // across ALL symbols, starving every symbol but the most recently active. It would read as
  // "some symbols stopped forecasting", not as a bug.
  const sql = buildBatchSql(3);
  assert.equal((sql.match(/SELECT/g) || []).length, 3);
  assert.equal((sql.match(/UNION ALL/g) || []).length, 2);
  assert.equal((sql.match(/LIMIT \?/g) || []).length, 3, 'each symbol needs its own LIMIT');
  assert.doesNotMatch(sql, /\bIN\s*\(/, 'must not collapse to an IN-list');
});

test('no window functions — avoids a server-version dependency', () => {
  assert.doesNotMatch(buildBatchSql(2), /ROW_NUMBER|OVER\s*\(|PARTITION BY/i);
});

test('the symbol column is compared bare, never wrapped in a function', () => {
  // UPPER(symbol) makes idx_mt5_candles_symbol_tf_time unusable: measured 1,056,249 rows
  // examined + filesort (689ms) versus 8,912 index-only (64ms). Ten of those per statement
  // held the whole connection pool and timed out the chart endpoint.
  assert.doesNotMatch(buildBatchSql(2), /UPPER\s*\(\s*symbol/i);
  assert.match(buildBatchSql(1), /WHERE symbol=\?/);
});

test('symbol is selected, or the rows cannot be grouped back', () => {
  assert.match(buildBatchSql(1), /SELECT symbol,/);
});

test('a zero or invalid symbol count yields no SQL rather than a broken statement', () => {
  for (const bad of [0, -1, null, undefined, 1.5, 'x']) assert.equal(buildBatchSql(bad), null, String(bad));
});

test('args line up with the placeholders, three per symbol in order', () => {
  const args = buildBatchArgs(['xauusd', 'EURUSD'], 'M15', 400);
  assert.deepEqual(args, ['XAUUSD', 'M15', 400, 'EURUSD', 'M15', 400]);
  assert.equal(args.length, (buildBatchSql(2).match(/\?/g) || []).length, 'arg count must equal placeholder count');
});

// ── symbol normalisation ─────────────────────────────────────────────────────

test('symbols are uppercased and de-duplicated', () => {
  // Trap #2: the broker uses XAUUSDm but storage uppercases. Querying both cases would issue two
  // subqueries whose rows then collide in one group.
  assert.deepEqual(normaliseSymbols(['xauusd', 'XAUUSD', 'XauUsd', 'eurusd']), ['XAUUSD', 'EURUSD']);
  assert.deepEqual(normaliseSymbols(['', null, undefined]), []);
  assert.deepEqual(normaliseSymbols(null), []);
});

// ── grouping and ordering ────────────────────────────────────────────────────

test('rows are grouped per symbol and sorted ASCENDING by time', () => {
  // The query returns DESC per branch; every engine downstream reads bars positionally
  // (candles[i-1], .at(-1)). A reversed array would not throw — it would produce confident
  // nonsense, which is far worse.
  const out = groupBatchRows([
    row('XAUUSD', '2026-01-01T03:00:00.000Z'),
    row('XAUUSD', '2026-01-01T01:00:00.000Z'),
    row('XAUUSD', '2026-01-01T02:00:00.000Z'),
    row('EURUSD', '2026-01-01T05:00:00.000Z'),
  ]);
  assert.deepEqual([...out.keys()], ['XAUUSD', 'EURUSD']);
  assert.deepEqual(out.get('XAUUSD').map((c) => c.time), [
    '2026-01-01T01:00:00.000Z', '2026-01-01T02:00:00.000Z', '2026-01-01T03:00:00.000Z',
  ]);
  assert.equal(out.get('EURUSD').length, 1);
});

test('interleaved branches still separate cleanly', () => {
  // UNION ALL branch order is a planner detail, not a guarantee.
  const out = groupBatchRows([
    row('A', '2026-01-01T02:00:00.000Z'), row('B', '2026-01-01T09:00:00.000Z'),
    row('A', '2026-01-01T01:00:00.000Z'), row('B', '2026-01-01T08:00:00.000Z'),
  ]);
  assert.deepEqual(out.get('A').map((c) => c.time), ['2026-01-01T01:00:00.000Z', '2026-01-01T02:00:00.000Z']);
  assert.deepEqual(out.get('B').map((c) => c.time), ['2026-01-01T08:00:00.000Z', '2026-01-01T09:00:00.000Z']);
});

test('the candle shape matches what the per-symbol loader produced', () => {
  const [c] = groupBatchRows([row('XAUUSD', '2026-01-01T00:00:00.000Z', {
    open_price: '4010.5', high: '4015.25', low: '4008', close_price: '4012.75', volume: '250',
  })]).get('XAUUSD');
  assert.deepEqual(c, {
    time: '2026-01-01T00:00:00.000Z',
    open: 4010.5, high: 4015.25, low: 4008, close: 4012.75, volume: 250,
  });
  for (const k of ['open', 'high', 'low', 'close', 'volume']) assert.equal(typeof c[k], 'number', `${k} must be numeric`);
});

test('a null volume becomes 0, matching the original mapping', () => {
  const [c] = groupBatchRows([row('X', '2026-01-01T00:00:00.000Z', { volume: null })]).get('X');
  assert.equal(c.volume, 0);
});

test('rows with no symbol are dropped rather than grouped under an empty key', () => {
  const out = groupBatchRows([row('', '2026-01-01T00:00:00.000Z'), row('A', '2026-01-01T00:00:00.000Z')]);
  assert.deepEqual([...out.keys()], ['A']);
});

test('empty input is an empty map, not a throw', () => {
  assert.equal(groupBatchRows([]).size, 0);
  assert.equal(groupBatchRows(null).size, 0);
});

// ── series dedupe and tail slicing ───────────────────────────────────────────

test('a series requested twice is fetched once, at the deeper depth', () => {
  // When the scan timeframe IS H4 it is also the trend source: 400 and 150 must collapse to one
  // fetch of 400, or the batch silently doubles its own round trips.
  const need = dedupeSeriesRequests([['H4', 400], ['H4', 150], ['H1', 150], ['D1', 8]]);
  assert.equal(need.get('H4'), 400);
  assert.equal(need.size, 3);
});

test('null series are skipped — a timeframe with no higher/lower neighbour', () => {
  const need = dedupeSeriesRequests([['M15', 400], [null, 200], [undefined, 200]]);
  assert.deepEqual([...need.keys()], ['M15']);
});

test('slicing the tail of a deeper fetch equals asking for the shallower window', () => {
  // This is what makes the dedupe safe: both mean "the most recent N".
  const rows = Array.from({ length: 400 }, (_, i) => ({ n: i }));
  assert.deepEqual(tailOf(rows, 150), rows.slice(-150));
  assert.equal(tailOf(rows, 150)[149].n, 399, 'the tail must end at the newest bar');
  assert.equal(tailOf(rows, 500).length, 400, 'asking for more than exists returns everything');
  assert.deepEqual(tailOf(null, 10), []);
});
