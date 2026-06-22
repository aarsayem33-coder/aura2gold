// One-off repair: relabel rows that were real TP wins but got overwritten to
// EXPIRED by the old 72h gate. Identifies them by the win evidence the bug left
// behind (profit_loss_pips > 0). Prints 90-day win-rate before & after.
//   run: node backfill_expired_wins.mjs
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
  timezone: 'Z', connectionLimit: 3, waitForConnections: true,
});

const WIN = "outcome IN ('WIN','TP1_WIN','TP2_WIN','TP3_WIN')";

async function snapshot(table, extra = '') {
  const where = `WHERE signal_time >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 90 DAY) ${extra}`;
  const [[r]] = await pool.query(
    `SELECT
       SUM(${WIN}) wins,
       SUM(outcome='LOSS') losses,
       SUM(outcome='EXPIRED') expired,
       SUM(outcome='PENDING') pending,
       SUM(outcome='EXPIRED' AND profit_loss_pips IS NOT NULL AND profit_loss_pips > 0) corruptedWins,
       COUNT(*) total
     FROM ${table} ${where}`);
  const wins = Number(r.wins || 0), losses = Number(r.losses || 0);
  const winRate = (wins + losses) ? Math.round((wins / (wins + losses)) * 1000) / 10 : null;
  return { wins, losses, expired: Number(r.expired || 0), pending: Number(r.pending || 0), corruptedWins: Number(r.corruptedWins || 0), total: Number(r.total || 0), winRate };
}

function show(label, s) {
  console.log(`  ${label.padEnd(22)} wins=${s.wins}  losses=${s.losses}  winRate=${s.winRate}%  expired=${s.expired}  pending=${s.pending}  (corruptedWins=${s.corruptedWins})`);
}

try {
  console.log('=== BEFORE (last 90 days) ===');
  const sysBefore = await snapshot('mt5_system_signal_log');
  const emBefore = await snapshot('mt5_signal_email_reports', "AND signal_type='forex'");
  show('system signal log', sysBefore);
  show('emailed forex', emBefore);

  console.log('\n=== RUNNING BACKFILL ===');
  const [sysRes] = await pool.execute(
    `UPDATE mt5_system_signal_log
        SET outcome = CASE WHEN tp_hit_level >= 3 THEN 'TP3_WIN' WHEN tp_hit_level = 2 THEN 'TP2_WIN' ELSE 'TP1_WIN' END
      WHERE outcome='EXPIRED' AND profit_loss_pips IS NOT NULL AND profit_loss_pips > 0`);
  console.log(`  system signal log: relabeled ${sysRes.affectedRows} EXPIRED→win`);
  const [emRes] = await pool.execute(
    `UPDATE mt5_signal_email_reports
        SET outcome = 'WIN'
      WHERE signal_type='forex' AND outcome='EXPIRED' AND profit_loss_pips IS NOT NULL AND profit_loss_pips > 0`);
  console.log(`  emailed forex:     relabeled ${emRes.affectedRows} EXPIRED→WIN`);

  console.log('\n=== AFTER (last 90 days) ===');
  show('system signal log', await snapshot('mt5_system_signal_log'));
  show('emailed forex', await snapshot('mt5_signal_email_reports', "AND signal_type='forex'"));
  console.log('\nDone.');
} catch (e) {
  console.error('Backfill failed:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
