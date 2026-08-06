/**
 * Local indicator store — a SQLite file, not the hosted database.
 *
 * WHY THIS EXISTS
 * `mt5_indicators` grew to 1,298.9 MB across 1,622,555 rows — 78% of the hosted database — and
 * tripped the account into a full privilege lockout: SELECT, INSERT and UPDATE denied on every
 * table, which took candles, signals, reports and the EA bridge down together.
 *
 * Two separate problems caused that size, and this store fixes both:
 *
 *  1. THE ROWS DO NOT BELONG IN A QUOTA'D DATABASE. They are append-only time series, read once
 *     at startup to warm an in-memory array and never joined against anything. Nothing remote
 *     reads them — the EA POSTs indicators to the server, it does not query them back. That is
 *     exactly the shape that belongs in a local file, like the candle history already does.
 *
 *  2. `raw_json LONGTEXT NOT NULL` WAS PURE DUPLICATION. Every row stored the full JSON payload
 *     alongside the five numeric values already parsed out of it — and `indicator.raw` is
 *     written but never read anywhere in the codebase. Every consumer reads value1..value5. It
 *     is deliberately NOT carried here: keeping a column nothing reads is what turned a ~100 MB
 *     table into a 1.3 GB one.
 *
 * Lives in backend/.cache/ (already gitignored) so indicator history never lands in a commit.
 *
 * CLI
 *   node indicatorStore.mjs stats
 *   node indicatorStore.mjs prune --days 30
 *
 * API
 *   import { writeIndicators, readIndicators, storeStats } from './indicatorStore.mjs';
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The override exists so tests get a scratch file. Without it a test run would prune and
// rewrite the real indicator history, which is the sort of thing you only discover afterwards.
export const INDICATOR_DB = process.env.INDICATOR_DB_OVERRIDE
  || path.join(__dirname, '.cache', 'indicators.db');

/** Rows kept per symbol+timeframe+indicator. Local disk is cheap, but not free. */
export const DEFAULT_RETENTION_DAYS = 45;

const n = (v) => Number(v);
// Number(null) is 0 and 0 is finite — the coercion behind seven separate defects in this
// codebase. An indicator value of 0 is legitimate (MACD histogram crossing), so a missing value
// must stay null rather than become one.
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(n(v)) ? null : n(v));

let cached = null;

function open() {
  if (cached) return cached;
  fs.mkdirSync(path.dirname(INDICATOR_DB), { recursive: true });
  const db = new DatabaseSync(INDICATOR_DB);
  // WAL so the EA's continuous writes never block the startup read; NORMAL sync because this
  // file is rebuildable — the EA reposts everything within a poll cycle or two.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`CREATE TABLE IF NOT EXISTS indicators (
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    indicator TEXT NOT NULL,
    ts INTEGER NOT NULL,            -- candle time as epoch ms
    v1 REAL, v2 REAL, v3 REAL, v4 REAL, v5 REAL,
    created_at INTEGER NOT NULL,    -- epoch ms, for retention
    PRIMARY KEY (symbol, timeframe, indicator, ts)
  ) WITHOUT ROWID`);
  // The read path is always "newest N for this symbol+timeframe", so that is what is indexed.
  db.exec('CREATE INDEX IF NOT EXISTS idx_ind_recent ON indicators (symbol, timeframe, ts DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_ind_created ON indicators (created_at)');
  cached = db;
  return db;
}

/** Close the handle. Tests need this to release the file between cases. */
export function closeStore() {
  if (cached) { try { cached.close(); } catch { /* already closed */ } cached = null; }
}

/** Candle time to epoch ms. The live feed sends ISO strings; imports may send numbers. */
export function toMs(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Upsert a batch of indicator readings.
 *
 * Batched in a single transaction: the EA posts several indicators per candle per symbol, and
 * committing each one separately is what makes a local write feel like a network one. Rows
 * that cannot be keyed are skipped rather than stored under a null key, where they would be
 * invisible to every read and still count toward retention.
 */
export function writeIndicators(rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  if (!list.length) return { written: 0, skipped: 0 };
  const db = open();
  const stmt = db.prepare(`INSERT INTO indicators
      (symbol, timeframe, indicator, ts, v1, v2, v3, v4, v5, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(symbol, timeframe, indicator, ts) DO UPDATE SET
      v1=excluded.v1, v2=excluded.v2, v3=excluded.v3, v4=excluded.v4, v5=excluded.v5,
      created_at=excluded.created_at`);

  let written = 0, skipped = 0;
  db.exec('BEGIN');
  try {
    for (const r of list) {
      const symbol = String(r?.symbol || '').toUpperCase();
      const timeframe = String(r?.timeframe || '').toUpperCase();
      const indicator = String(r?.indicator ?? r?.indicator_name ?? '').toUpperCase();
      const ts = toMs(r?.candleTime ?? r?.candle_time ?? r?.ts);
      if (!symbol || !timeframe || !indicator || ts === null) { skipped += 1; continue; }
      stmt.run(symbol, timeframe, indicator, ts,
        num(r?.value1 ?? r?.value_1), num(r?.value2 ?? r?.value_2), num(r?.value3 ?? r?.value_3),
        num(r?.value4 ?? r?.value_4), num(r?.value5 ?? r?.value_5),
        toMs(r?.createdAt ?? r?.created_at) ?? Date.now());
      written += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { written, skipped };
}

/**
 * Newest-first readings, shaped exactly like the in-memory `indicators` array the server keeps.
 *
 * The shape matters: this replaces a MySQL row mapping, and every consumer reads `value1`..
 * `value5` / `candleTime` / `indicator`. Returning snake_case here would silently produce
 * undefined everywhere instead of an obvious failure.
 */
export function readIndicators({ symbol = null, timeframe = null, limit = 100000 } = {}) {
  const db = open();
  let sql = 'SELECT symbol, timeframe, indicator, ts, v1, v2, v3, v4, v5, created_at FROM indicators';
  const where = [], args = [];
  if (symbol) { where.push('symbol=?'); args.push(String(symbol).toUpperCase()); }
  if (timeframe) { where.push('timeframe=?'); args.push(String(timeframe).toUpperCase()); }
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ' ORDER BY ts DESC LIMIT ?';
  args.push(Math.max(1, Number(limit) || 100000));

  return db.prepare(sql).all(...args).map((r) => ({
    // Stable synthetic id — the hosted table had one and upsertRecord() de-dupes on it.
    id: `${r.symbol}:${r.timeframe}:${r.indicator}:${r.ts}`,
    symbol: r.symbol,
    timeframe: r.timeframe,
    indicator: r.indicator,
    candleTime: new Date(r.ts).toISOString(),
    value1: r.v1, value2: r.v2, value3: r.v3, value4: r.v4, value5: r.v5,
    createdAt: new Date(r.created_at).toISOString(),
    // `raw` is deliberately absent: nothing reads it, and storing it is what cost 1.2 GB.
  }));
}

/** Delete readings older than `days`. Returns how many went. */
export function pruneOlderThan(days = DEFAULT_RETENTION_DAYS) {
  const db = open();
  const cutoff = Date.now() - Math.max(1, Number(days) || DEFAULT_RETENTION_DAYS) * 86400000;
  const before = db.prepare('SELECT COUNT(*) c FROM indicators').get().c;
  db.prepare('DELETE FROM indicators WHERE created_at < ?').run(cutoff);
  const after = db.prepare('SELECT COUNT(*) c FROM indicators').get().c;
  return { deleted: before - after, remaining: after, cutoff: new Date(cutoff).toISOString() };
}

/** What is in the file, and how big it is. */
export function storeStats() {
  const db = open();
  const rows = db.prepare(
    `SELECT symbol, timeframe, indicator, COUNT(*) rows, MIN(ts) first_ts, MAX(ts) last_ts
       FROM indicators GROUP BY symbol, timeframe, indicator ORDER BY rows DESC`).all();
  const total = db.prepare('SELECT COUNT(*) c FROM indicators').get().c;
  let bytes = 0;
  try { bytes = fs.statSync(INDICATOR_DB).size; } catch { /* not created yet */ }
  return { file: INDICATOR_DB, bytes, mb: Math.round((bytes / 1048576) * 10) / 10, total, series: rows };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('indicatorStore.mjs')) {
  const cmd = process.argv[2];
  const arg = (name, dflt = null) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : dflt;
  };
  if (cmd === 'stats') {
    const s = storeStats();
    console.log(`${s.file}\n${s.total.toLocaleString()} readings · ${s.mb} MB`);
    for (const r of s.series.slice(0, 20)) {
      console.log(`  ${r.symbol} ${r.timeframe} ${r.indicator}: ${r.rows.toLocaleString()} rows`
        + ` (${new Date(r.first_ts).toISOString().slice(0, 10)} → ${new Date(r.last_ts).toISOString().slice(0, 10)})`);
    }
  } else if (cmd === 'prune') {
    console.log(JSON.stringify(pruneOlderThan(Number(arg('days', DEFAULT_RETENTION_DAYS))), null, 2));
  } else {
    console.log('usage: node indicatorStore.mjs stats | prune --days 30');
  }
  closeStore();
}
