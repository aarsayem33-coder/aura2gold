// One-off repair: re-open Strategy Lab FIXED-TIME outcomes that were settled on a
// still-forming expiry candle (the old `expiryIdx >= candles.length` bug). Re-opening
// sets ft_outcome back to PENDING so the running server's resolver re-settles them
// correctly once the expiry candle has actually CLOSED (the fix in resolveStrategyFixedTime).
//
// SAFETY: only touches rows from the last 12h, where the in-memory candle store still
// holds the bars needed to re-resolve (avoids the 72h-EXPIRED wipe on older rows whose
// candles are gone). Correctly-settled rows re-resolve to the SAME value (idempotent);
// prematurely-settled rows get corrected; rows still inside their expiry window become
// live PENDING. Affects ONLY the fixed-time columns — forex outcome/score untouched.
//   run: node backfill_ft_premature.mjs
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env.local'), override: true });
dotenv.config();

const WINDOW_HOURS = Number(process.env.FT_BACKFILL_WINDOW_HOURS || 12);

const pool = mysql.createPool({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  ssl: process.env.DB_SSL ? { rejectUnauthorized: false } : undefined,
  timezone: 'Z', connectionLimit: 3, waitForConnections: true,
});

async function ftSnapshot(label) {
  const [[r]] = await pool.query(
    `SELECT
       SUM(ft_outcome='WIN') wins,
       SUM(ft_outcome='LOSS') losses,
       SUM(ft_outcome='DRAW') draws,
       SUM(ft_outcome='PENDING') pending,
       SUM(ft_outcome='EXPIRED') expired,
       COUNT(*) total
     FROM mt5_strategy_signals
     WHERE signal_time >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 90 DAY)`);
  const wins = Number(r.wins || 0), losses = Number(r.losses || 0);
  const winRate = (wins + losses) ? Math.round((wins / (wins + losses)) * 1000) / 10 : null;
  console.log(`  ${label.padEnd(16)} ftWins=${wins}  ftLosses=${losses}  ftDraws=${Number(r.draws || 0)}  ftWinRate=${winRate}%  pending=${Number(r.pending || 0)}  expired=${Number(r.expired || 0)}  total=${Number(r.total || 0)}`);
}

try {
  console.log(`=== Strategy Lab fixed-time repair (re-open last ${WINDOW_HOURS}h, 90d snapshot) ===`);
  console.log('BEFORE:');
  await ftSnapshot('fixed-time');

  // How many of the recent settled rows are still INSIDE their expiry window right now
  // (i.e. definitively settled on a forming candle = premature)?
  const [[pre]] = await pool.query(
    `SELECT COUNT(*) n FROM mt5_strategy_signals
      WHERE ft_outcome IN ('WIN','LOSS','DRAW')
        AND signal_time >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR)
        AND UTC_TIMESTAMP() < (bar_time + INTERVAL (
              (CASE timeframe
                 WHEN 'M1' THEN 1 WHEN 'M5' THEN 5 WHEN 'M15' THEN 15 WHEN 'M30' THEN 30
                 WHEN 'H1' THEN 60 WHEN 'H2' THEN 120 WHEN 'H4' THEN 240 WHEN 'H8' THEN 480
                 WHEN 'H12' THEN 720 WHEN 'D1' THEN 1440 ELSE 5 END) * 2) MINUTE)`,
    [WINDOW_HOURS]);
  console.log(`\n  Definitively-premature rows still inside their expiry window: ${Number(pre.n || 0)}`);

  console.log('\n=== RE-OPENING recent fixed-time outcomes for clean re-resolution ===');
  const [res] = await pool.execute(
    `UPDATE mt5_strategy_signals
        SET ft_outcome='PENDING', ft_exit_price=NULL, ft_pips=NULL
      WHERE ft_outcome IN ('WIN','LOSS','DRAW')
        AND signal_time >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR)`,
    [WINDOW_HOURS]);
  console.log(`  Re-opened ${res.affectedRows} fixed-time rows → PENDING (server will re-resolve at each expiry candle close).`);

  console.log('\nAFTER (immediately — pending will re-settle over the next candles):');
  await ftSnapshot('fixed-time');
  console.log('\nDone. Watch the Reports signal log: in-window calls now show LIVE green/red;');
  console.log('closed ones re-settle correctly within ~30-60s on the running server.');
} catch (e) {
  console.error('FT backfill failed:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
