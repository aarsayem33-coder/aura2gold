// One-off: re-open fixed-time rows that were marked SKIPPED (the earlier "stale = no
// result" approach). They go back to PENDING so the running resolver re-settles each to a
// real WIN/LOSS/DRAW against its closed expiry candle. "Tradable vs late" is now a derived
// flag (ftActionable) computed from timestamps — late calls still show their result but are
// excluded from the tradable win-rate. Touches ONLY ft_outcome.
//   run: node backfill_ft_unskip.mjs
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env.local'), override: true });
dotenv.config();
const pool = mysql.createPool({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  ssl: process.env.DB_SSL ? { rejectUnauthorized: false } : undefined,
  timezone: 'Z', connectionLimit: 2,
});
try {
  const [[before]] = await pool.query("SELECT SUM(ft_outcome='SKIPPED') skipped, SUM(ft_outcome='PENDING') pending FROM mt5_strategy_signals");
  console.log(`BEFORE: skipped=${Number(before.skipped||0)} pending=${Number(before.pending||0)}`);
  const [res] = await pool.execute("UPDATE mt5_strategy_signals SET ft_outcome='PENDING', ft_exit_price=NULL, ft_pips=NULL WHERE ft_outcome='SKIPPED'");
  console.log(`Re-opened ${res.affectedRows} SKIPPED rows → PENDING (resolver will settle each to a real outcome within ~30-60s).`);
} catch (e) { console.error('Backfill failed:', e.message); process.exitCode = 1; } finally { await pool.end(); }
