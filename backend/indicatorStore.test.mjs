import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Point the store at a scratch file BEFORE importing it, so a test run never touches the real
// indicator history.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'indstore-'));
process.env.INDICATOR_DB_OVERRIDE = path.join(tmp, 'indicators.db');

const {
  writeIndicators, readIndicators, pruneOlderThan, storeStats, closeStore, toMs,
  DEFAULT_RETENTION_DAYS,
} = await import('./indicatorStore.mjs');

const reading = (o = {}) => ({
  symbol: 'XAUUSD', timeframe: 'M15', indicator: 'RSI',
  candleTime: '2026-08-04T12:00:00.000Z',
  value1: 62.5, value2: null, value3: null, value4: null, value5: null,
  createdAt: '2026-08-04T12:00:05.000Z', ...o,
});

test.after(() => { closeStore(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows lock */ } });

// ── time handling ────────────────────────────────────────────────────────────

test('candle time accepts ISO strings and epoch numbers alike', () => {
  // The live feed sends ISO; imports may send numbers.
  assert.equal(toMs('2026-08-04T12:00:00.000Z'), Date.parse('2026-08-04T12:00:00.000Z'));
  assert.equal(toMs(1785801600000), 1785801600000);
  assert.equal(toMs(null), null);
  assert.equal(toMs('not a date'), null);
});

// ── writes ───────────────────────────────────────────────────────────────────

test('a reading round-trips in the shape the server already consumes', () => {
  // Every consumer reads value1..value5 / candleTime / indicator. snake_case here would produce
  // undefined everywhere instead of an obvious failure.
  writeIndicators(reading());
  const [r] = readIndicators({ symbol: 'XAUUSD', timeframe: 'M15' });
  assert.equal(r.symbol, 'XAUUSD');
  assert.equal(r.indicator, 'RSI');
  assert.equal(r.value1, 62.5);
  assert.equal(r.candleTime, '2026-08-04T12:00:00.000Z');
  assert.ok(r.id.includes('XAUUSD'), 'a stable id, because upsertRecord de-dupes on it');
});

test('the raw payload is NOT stored — that column cost 1.2 GB', () => {
  writeIndicators(reading({ raw: { huge: 'x'.repeat(1000) } }));
  const [r] = readIndicators({ symbol: 'XAUUSD' });
  assert.equal(r.raw, undefined);
});

test('re-posting the same candle updates rather than duplicating', () => {
  const at = '2026-08-04T13:00:00.000Z';
  writeIndicators(reading({ candleTime: at, value1: 50 }));
  writeIndicators(reading({ candleTime: at, value1: 71 }));
  const rows = readIndicators({ symbol: 'XAUUSD' }).filter((x) => x.candleTime === at);
  assert.equal(rows.length, 1, 'one row per symbol+timeframe+indicator+candle');
  assert.equal(rows[0].value1, 71, 'the later value wins');
});

test('different indicators on the same candle are separate rows', () => {
  const at = '2026-08-04T14:00:00.000Z';
  writeIndicators([
    reading({ candleTime: at, indicator: 'RSI', value1: 55 }),
    reading({ candleTime: at, indicator: 'MACD', value1: 0.2, value2: 0.1 }),
  ]);
  const rows = readIndicators({ symbol: 'XAUUSD' }).filter((x) => x.candleTime === at);
  assert.equal(rows.length, 2);
});

test('a zero value is preserved, not turned into null', () => {
  // Number(null) is 0 and 0 is finite. A MACD histogram crossing zero is a real reading, and
  // conflating it with "missing" would silently change the signal.
  writeIndicators(reading({ candleTime: '2026-08-04T15:00:00.000Z', indicator: 'MACD', value1: 0 }));
  const [r] = readIndicators({ symbol: 'XAUUSD' }).filter((x) => x.indicator === 'MACD' && x.value1 === 0);
  assert.equal(r.value1, 0);
});

test('a missing value stays null rather than becoming zero', () => {
  writeIndicators(reading({ candleTime: '2026-08-04T16:00:00.000Z', indicator: 'ADX', value1: null }));
  const [r] = readIndicators({ symbol: 'XAUUSD' }).filter((x) => x.indicator === 'ADX');
  assert.equal(r.value1, null);
});

test('unkeyable rows are SKIPPED, never stored under a null key', () => {
  // A row with no symbol or candle time is invisible to every read but would still count
  // toward retention — worse than dropping it loudly.
  const before = storeStats().total;
  const res = writeIndicators([
    reading({ symbol: '' }),
    reading({ candleTime: null }),
    reading({ indicator: '' }),
    reading({ timeframe: null }),
  ]);
  assert.equal(res.written, 0);
  assert.equal(res.skipped, 4);
  assert.equal(storeStats().total, before, 'nothing was stored');
});

test('an empty batch is a no-op, not an error', () => {
  assert.deepEqual(writeIndicators([]), { written: 0, skipped: 0 });
});

test('symbol, timeframe and indicator are normalised to upper case', () => {
  writeIndicators(reading({ symbol: 'eurusd', timeframe: 'm5', indicator: 'rsi', candleTime: '2026-08-04T17:00:00.000Z' }));
  const [r] = readIndicators({ symbol: 'EURUSD', timeframe: 'M5' });
  assert.equal(r.symbol, 'EURUSD');
  assert.equal(r.timeframe, 'M5');
  assert.equal(r.indicator, 'RSI');
});

test('snake_case input from the old MySQL rows is accepted', () => {
  // The migration reads rows shaped the way the hosted table returned them.
  writeIndicators({
    symbol: 'GBPUSD', timeframe: 'H1', indicator_name: 'ADX',
    candle_time: '2026-08-04T18:00:00.000Z', value_1: 27.4, created_at: '2026-08-04T18:00:01.000Z',
  });
  const [r] = readIndicators({ symbol: 'GBPUSD' });
  assert.equal(r.indicator, 'ADX');
  assert.equal(r.value1, 27.4);
});

// ── reads ────────────────────────────────────────────────────────────────────

test('readings come back newest first', () => {
  writeIndicators([
    reading({ symbol: 'USDJPY', candleTime: '2026-08-04T10:00:00.000Z', value1: 1 }),
    reading({ symbol: 'USDJPY', candleTime: '2026-08-04T11:00:00.000Z', value1: 2 }),
    reading({ symbol: 'USDJPY', candleTime: '2026-08-04T12:00:00.000Z', value1: 3 }),
  ]);
  const rows = readIndicators({ symbol: 'USDJPY' });
  assert.equal(rows[0].value1, 3, 'newest first, matching the MySQL ORDER BY it replaces');
});

test('filters narrow to one series', () => {
  writeIndicators([
    reading({ symbol: 'AUDUSD', timeframe: 'M5', candleTime: '2026-08-04T09:00:00.000Z' }),
    reading({ symbol: 'AUDUSD', timeframe: 'H4', candleTime: '2026-08-04T09:00:00.000Z' }),
  ]);
  assert.equal(readIndicators({ symbol: 'AUDUSD', timeframe: 'M5' }).length, 1);
  assert.equal(readIndicators({ symbol: 'AUDUSD' }).length, 2);
});

test('the limit is honoured', () => {
  assert.ok(readIndicators({ limit: 2 }).length <= 2);
});

// ── retention ────────────────────────────────────────────────────────────────

test('pruning removes old readings and keeps recent ones', () => {
  const old = Date.now() - 90 * 86400000;
  const fresh = Date.now();
  writeIndicators([
    reading({ symbol: 'NZDUSD', candleTime: old, createdAt: old }),
    reading({ symbol: 'NZDUSD', candleTime: fresh, createdAt: fresh }),
  ]);
  const before = readIndicators({ symbol: 'NZDUSD' }).length;
  assert.equal(before, 2);
  const res = pruneOlderThan(30);
  assert.ok(res.deleted >= 1, `expected the 90-day-old row to go, deleted ${res.deleted}`);
  assert.equal(readIndicators({ symbol: 'NZDUSD' }).length, 1, 'the fresh one survives');
});

test('retention is keyed on when it was RECORDED, not the candle time', () => {
  // A backfill of old candles recorded today must not be pruned as if it were old.
  const oldCandle = Date.now() - 200 * 86400000;
  writeIndicators(reading({ symbol: 'USDCHF', candleTime: oldCandle, createdAt: Date.now() }));
  pruneOlderThan(30);
  assert.equal(readIndicators({ symbol: 'USDCHF' }).length, 1);
});

test('the default retention is stated, not hidden', () => {
  assert.equal(DEFAULT_RETENTION_DAYS, 45);
});

// ── stats ────────────────────────────────────────────────────────────────────

test('stats report size and per-series counts', () => {
  const s = storeStats();
  assert.ok(s.total > 0);
  assert.ok(s.bytes > 0, 'the file exists on disk');
  assert.ok(Array.isArray(s.series) && s.series.length > 0);
  assert.ok(s.series[0].rows >= 1);
});
