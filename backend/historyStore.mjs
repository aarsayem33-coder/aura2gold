/**
 * Local research history store — a SQLite file, not the hosted database.
 *
 * WHY SEPARATE
 * Ten years of gold candles is ~1.1M rows that NEVER change and are only ever read by
 * backtests. Putting them in the hosted MySQL costs quota that the live system needs for
 * signals, trades and forecasts, and every research query then pays a network round trip.
 * Keeping them in a local file makes backtests faster AND removes them from the quota
 * entirely. The live path is untouched — it keeps writing candles to MySQL as before.
 *
 * Lives in backend/.cache/ (already gitignored) so a decade of market data never lands in a
 * commit.
 *
 * CLI
 *   node historyStore.mjs import --file <csv> --symbol XAUUSD --tf M15
 *   node historyStore.mjs stats
 *
 * API
 *   import { readCandles, storeStats } from './historyStore.mjs';
 *   const bars = readCandles('XAUUSD', 'M15', { from: '2016-08-01', to: '2022-08-01' });
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const HISTORY_DB = path.join(__dirname, '.cache', 'history.db');

const TF_MS = { M1: 6e4, M5: 3e5, M15: 9e5, M30: 18e5, H1: 36e5, H4: 144e5, D1: 864e5, W1: 6048e5 };

function open() {
  fs.mkdirSync(path.dirname(HISTORY_DB), { recursive: true });
  const db = new DatabaseSync(HISTORY_DB);
  // WAL keeps a long import from blocking concurrent reads; the pragmas below trade a little
  // crash-durability for speed, which is the right trade for a file we can always rebuild
  // from the CSVs.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`CREATE TABLE IF NOT EXISTS candles (
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    ts INTEGER NOT NULL,          -- epoch ms, broker clock (same basis as the live feed)
    o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v REAL,
    PRIMARY KEY (symbol, timeframe, ts)
  ) WITHOUT ROWID`);
  return db;
}

/** Bars in ascending time order. `from`/`to` accept ISO dates or epoch ms. */
export function readCandles(symbol, timeframe, { from = null, to = null, limit = null } = {}) {
  const db = open();
  try {
    const ms = (v) => (v === null || v === undefined ? null : (typeof v === 'number' ? v : Date.parse(v)));
    const a = ms(from), b = ms(to);
    let sql = 'SELECT ts, o, h, l, c, v FROM candles WHERE symbol=? AND timeframe=?';
    const args = [String(symbol).toUpperCase(), String(timeframe).toUpperCase()];
    if (a !== null) { sql += ' AND ts >= ?'; args.push(a); }
    if (b !== null) { sql += ' AND ts < ?'; args.push(b); }
    sql += ' ORDER BY ts ASC';
    if (limit) { sql += ' LIMIT ?'; args.push(limit); }
    return db.prepare(sql).all(...args).map((r) => ({
      time: new Date(r.ts).toISOString(), ts: r.ts,
      open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v,
    }));
  } finally { db.close(); }
}

export function storeStats() {
  const db = open();
  try {
    return db.prepare(
      `SELECT symbol, timeframe, COUNT(*) bars, MIN(ts) first_ts, MAX(ts) last_ts
         FROM candles GROUP BY symbol, timeframe ORDER BY bars DESC`).all();
  } finally { db.close(); }
}

const splitCols = (line) => line.trim().split(/[\t;,]+/).map((s) => s.trim().replace(/^"|"$/g, ''));

/** Same parser contract as importMt5History.mjs — a bad row is dropped, never half-imported. */
function parseRow(cols) {
  if (cols.length < 5) return null;
  let dateStr = cols[0], rest = cols.slice(1);
  if (/^\d{2}:\d{2}/.test(cols[1] || '')) { dateStr = `${cols[0]} ${cols[1]}`; rest = cols.slice(2); }
  const norm = dateStr.replace(/\./g, '-').replace(' ', 'T');
  const ms = Date.parse(norm.length <= 10 ? `${norm}T00:00:00Z` : `${norm}Z`);
  if (!Number.isFinite(ms)) return null;
  const [o, h, l, c, v] = rest.map(Number);
  if (![o, h, l, c].every((x) => Number.isFinite(x) && x > 0)) return null;
  if (h < l || h < o || h < c || l > o || l > c) return null;
  return { ms, o, h, l, c, v: Number.isFinite(v) ? v : 0 };
}

export async function importCsv({ file, symbol, timeframe }) {
  const SYM = String(symbol).toUpperCase(), TF = String(timeframe).toUpperCase();
  if (!TF_MS[TF]) throw new Error(`unknown timeframe ${TF}`);
  const db = open();
  const ins = db.prepare('INSERT OR REPLACE INTO candles (symbol,timeframe,ts,o,h,l,c,v) VALUES (?,?,?,?,?,?,?,?)');
  let read = 0, ok = 0, bad = 0, first = null, last = null;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  db.exec('BEGIN');
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      read += 1;
      const cols = splitCols(line);
      if (read === 1 && (/date|open|<.*>/i.test(line) || !Number.isFinite(Number(cols[2])))) continue;
      const r = parseRow(cols);
      if (!r) { bad += 1; continue; }
      ok += 1;
      if (first === null || r.ms < first) first = r.ms;
      if (last === null || r.ms > last) last = r.ms;
      ins.run(SYM, TF, r.ms, r.o, r.h, r.l, r.c, r.v);
      // Commit periodically: one transaction over 700k rows holds a huge WAL and can exhaust
      // memory on a large file.
      if (ok % 50000 === 0) { db.exec('COMMIT'); db.exec('BEGIN'); process.stdout.write(`\r  ${ok.toLocaleString()}…`); }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; } finally { db.close(); }
  process.stdout.write('\r');
  return { read, ok, bad, first, last };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const cmd = process.argv[2];
  const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : null; };
  if (cmd === 'import') {
    const r = await importCsv({ file: arg('file'), symbol: arg('symbol'), timeframe: arg('tf') });
    console.log(`${arg('symbol')} ${arg('tf')}: ${r.ok.toLocaleString()} bars, ${r.bad} rejected, `
      + `${new Date(r.first).toISOString().slice(0, 10)} → ${new Date(r.last).toISOString().slice(0, 10)}`);
  } else if (cmd === 'stats') {
    const rows = storeStats();
    const mb = fs.existsSync(HISTORY_DB) ? (fs.statSync(HISTORY_DB).size / 1024 / 1024).toFixed(0) : 0;
    console.log(`local store: ${HISTORY_DB}  (${mb} MB)`);
    console.table(rows.map((r) => ({
      symbol: r.symbol, tf: r.timeframe, bars: r.bars.toLocaleString(),
      from: new Date(r.first_ts).toISOString().slice(0, 10),
      to: new Date(r.last_ts).toISOString().slice(0, 10),
    })));
  } else {
    console.log('usage: node historyStore.mjs import --file <csv> --symbol XAUUSD --tf M15');
    console.log('       node historyStore.mjs stats');
  }
}
