/**
 * Import MT5-exported history CSV into mt5_candles.
 *
 * WHY THIS EXISTS
 * The EA's own sync is capped at InpSyncCandlesLimit (4000) and, more importantly, syncing a
 * decade would monopolise the live feed for hours — the same EA is streaming candles, polling
 * trade commands and reporting fills. Exporting from the terminal and importing here is a
 * one-off bulk load that never touches the live path.
 *
 * HOW TO PRODUCE THE FILE (MetaTrader 5)
 *   1. Tools → Options → Charts → "Max bars in chart" = Unlimited, then restart MT5.
 *   2. View → Symbols → select XAUUSD → Bars tab → pick the timeframe → Request.
 *      (Or open the chart and press Home repeatedly until it stops loading further back.)
 *   3. File → Save As… on the chart, or View → Symbols → Bars → Export.
 *   4. Save as CSV. Repeat per timeframe.
 *
 * ACCEPTED FORMATS — MT5 has changed its export layout across builds, so both are handled:
 *   <DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>
 *   DATE,TIME,OPEN,HIGH,LOW,CLOSE,VOLUME
 * A header line is detected and skipped. Tab, comma and semicolon separators all work.
 *
 * USAGE
 *   node importMt5History.mjs --file "C:/path/XAUUSD_M15.csv" --symbol XAUUSD --tf M15 [--dry]
 *
 * SAFETY
 *   - Upserts on the same id the live feed uses (SYMBOL|TF|epochMs), so re-running is
 *     idempotent and a re-import can never duplicate a bar.
 *   - --dry parses and reports without writing a single row.
 *   - Rows that fail validation are counted and reported, never silently dropped.
 */
import fs from 'node:fs';
import readline from 'node:readline';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config({ path: './.env.local' });

const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};
const FILE = arg('file');
const SYMBOL = String(arg('symbol') || '').toUpperCase();
const TF = String(arg('tf') || '').toUpperCase();
const DRY = process.argv.includes('--dry');
const BATCH = 2000;

const TF_MS = { M1: 6e4, M5: 3e5, M15: 9e5, M30: 18e5, H1: 36e5, H4: 144e5, D1: 864e5, W1: 6048e5 };

if (!FILE || !SYMBOL || !TF) {
  console.error('usage: node importMt5History.mjs --file <csv> --symbol XAUUSD --tf M15 [--dry]');
  process.exit(1);
}
if (!TF_MS[TF]) { console.error(`unknown timeframe ${TF}. one of: ${Object.keys(TF_MS).join(', ')}`); process.exit(1); }
if (!fs.existsSync(FILE)) { console.error(`file not found: ${FILE}`); process.exit(1); }

/** Split on whatever MT5 used; its exports vary by build. */
const splitCols = (line) => line.trim().split(/[\t;,]+/).map((s) => s.trim().replace(/^"|"$/g, ''));

/**
 * Parse one row into a candle. Returns null on anything unusable rather than a partial bar —
 * a row with a bad price would otherwise poison every indicator computed from it.
 */
function parseRow(cols) {
  if (cols.length < 5) return null;
  // Either "YYYY.MM.DD HH:MM" as two columns, or a single ISO-ish stamp.
  let dateStr = cols[0];
  let rest = cols.slice(1);
  if (/^\d{2}:\d{2}/.test(cols[1] || '')) { dateStr = `${cols[0]} ${cols[1]}`; rest = cols.slice(2); }
  const norm = dateStr.replace(/\./g, '-').replace(' ', 'T');
  // MT5 stamps are broker-local wall clock with no zone. Treating them as UTC keeps them on the
  // SAME basis as the live feed, which stores the broker's clock too — mixing the two would
  // silently shift a decade of history against the bars already in the table.
  const ms = Date.parse(norm.length <= 10 ? `${norm}T00:00:00Z` : `${norm}Z`);
  if (!Number.isFinite(ms)) return null;
  const [o, h, l, cl, vol] = rest.map((v) => Number(v));
  if (![o, h, l, cl].every((v) => Number.isFinite(v) && v > 0)) return null;
  if (h < l || h < o || h < cl || l > o || l > cl) return null;   // impossible OHLC
  return { ms, o, h, l, c: cl, v: Number.isFinite(vol) ? vol : 0 };
}

const conn = DRY ? null : await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME, port: Number(process.env.DB_PORT) || 3306,
});

const SQL = `INSERT INTO mt5_candles
  (id, symbol, timeframe, candle_time, open_price, high, low, close_price, volume, spread, source_ip, raw_json, received_at)
  VALUES ? ON DUPLICATE KEY UPDATE
  open_price=VALUES(open_price), high=VALUES(high), low=VALUES(low),
  close_price=VALUES(close_price), volume=VALUES(volume)`;

let read = 0, ok = 0, bad = 0, written = 0, first = null, last = null;
let buf = [];
const flush = async () => {
  if (!buf.length) return;
  if (!DRY) await conn.query(SQL, [buf]);
  written += buf.length;
  buf = [];
  process.stdout.write(`\r  imported ${written.toLocaleString()} bars…`);
};

const rl = readline.createInterface({ input: fs.createReadStream(FILE), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  read += 1;
  const cols = splitCols(line);
  // Header detection: MT5 writes <DATE> style headers, and any row whose 3rd field is not a
  // number cannot be OHLC.
  if (read === 1 && (/date|open|<.*>/i.test(line) || !Number.isFinite(Number(cols[2])))) continue;
  const row = parseRow(cols);
  if (!row) { bad += 1; continue; }
  ok += 1;
  if (first === null || row.ms < first) first = row.ms;
  if (last === null || row.ms > last) last = row.ms;
  const dt = new Date(row.ms).toISOString().slice(0, 19).replace('T', ' ');
  buf.push([`${SYMBOL}|${TF}|${row.ms}`, SYMBOL, TF, dt, row.o, row.h, row.l, row.c, row.v, 0, 'csv-import', '{}', dt]);
  if (buf.length >= BATCH) await flush();
}
await flush();
process.stdout.write('\n');

const span = first && last ? (last - first) / 864e5 : 0;
console.log(`\n${SYMBOL} ${TF}  ${DRY ? '(DRY RUN — nothing written)' : ''}`);
console.log(`  lines read     : ${read.toLocaleString()}`);
console.log(`  valid bars     : ${ok.toLocaleString()}`);
console.log(`  rejected       : ${bad.toLocaleString()}${bad ? '  (bad OHLC or unparseable timestamp)' : ''}`);
console.log(`  written        : ${written.toLocaleString()}`);
if (first) {
  console.log(`  range          : ${new Date(first).toISOString().slice(0, 10)} → ${new Date(last).toISOString().slice(0, 10)}`);
  console.log(`  span           : ${(span / 365).toFixed(1)} years`);
  // Gap check: far fewer bars than the span implies means the export is incomplete, which is
  // worth knowing BEFORE a backtest quietly runs on swiss cheese.
  const expected = Math.round((last - first) / TF_MS[TF] * (TF === 'D1' || TF === 'W1' ? 1 : 5 / 7));
  const pct = expected ? Math.round((ok / expected) * 100) : 0;
  console.log(`  density        : ~${pct}% of the bars a continuous feed would have`);
  if (pct < 70) console.log('  ⚠ sparse — the terminal probably had not downloaded the full history.');
}
if (conn) await conn.end();
