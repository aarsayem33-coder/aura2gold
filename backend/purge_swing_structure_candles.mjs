// Clean-cut purge for the swing-structure-candles strategy.
//
// WHY: the LTF (lower-timeframe) confirmation gate changes the entry rules of the
// existing `swing-structure-candles` strategy. Old rows in mt5_strategy_signals were
// produced by the PRE-LTF logic, so a blended win rate would be misleading. This wipes
// only that strategy's rows so the measured stats reflect ONLY the new logic going forward.
// (New signals are also stamped meta.v=2, so you can tell them apart if you keep history.)
//
// SAFETY (heeds AGENTS.md Trap #6 — Hostinger 120s statement timeout + read-only-on-quota):
//   • Default is DRY-RUN: prints the count, deletes nothing.
//   • Pass --yes to actually delete. Deletes are BATCHED (LIMIT) to stay under 120s.
//   • DELETE alone does NOT free InnoDB disk. Pass --reclaim to also run
//     `ALTER TABLE ... ENGINE=InnoDB` (allowed even under the read-only quota lock).
//
//   run (preview):  node purge_swing_structure_candles.mjs
//   run (delete) :  node purge_swing_structure_candles.mjs --yes
//   run (+reclaim): node purge_swing_structure_candles.mjs --yes --reclaim
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env.local'), override: true });
dotenv.config();

const STRATEGY = 'swing-structure-candles';
const TABLE = 'mt5_strategy_signals';
const BATCH = 2000;                 // rows per DELETE — comfortably under the 120s timeout
const args = new Set(process.argv.slice(2));
const DO_DELETE = args.has('--yes');
const DO_RECLAIM = args.has('--reclaim');

const pool = mysql.createPool({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  ssl: process.env.DB_SSL ? { rejectUnauthorized: false } : undefined,
  timezone: 'Z', connectionLimit: 3, waitForConnections: true,
});

async function count() {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) n,
            SUM(outcome <> 'PENDING') settledForex,
            SUM(ft_outcome <> 'PENDING') settledFt
       FROM ${TABLE} WHERE strategy = ?`, [STRATEGY]);
  return { n: Number(r.n || 0), settledForex: Number(r.settledForex || 0), settledFt: Number(r.settledFt || 0) };
}

try {
  const before = await count();
  console.log(`=== ${STRATEGY} in ${TABLE} ===`);
  console.log(`  rows=${before.n}  settled(forex)=${before.settledForex}  settled(ft)=${before.settledFt}`);

  if (!before.n) {
    console.log('  nothing to purge.');
  } else if (!DO_DELETE) {
    console.log('\n  DRY-RUN — no rows deleted. Re-run with --yes to purge (add --reclaim to free disk).');
  } else {
    let total = 0;
    for (;;) {
      const [res] = await pool.query(`DELETE FROM ${TABLE} WHERE strategy = ? LIMIT ${BATCH}`, [STRATEGY]);
      total += res.affectedRows;
      if (res.affectedRows) console.log(`  deleted ${total}/${before.n} ...`);
      if (res.affectedRows < BATCH) break;
    }
    console.log(`  done — deleted ${total} rows.`);

    if (DO_RECLAIM) {
      console.log('  reclaiming InnoDB space (ALTER TABLE ... ENGINE=InnoDB) ...');
      await pool.query(`ALTER TABLE ${TABLE} ENGINE=InnoDB`);
      console.log('  reclaim complete.');
    } else {
      console.log('  NOTE: DELETE does not free InnoDB disk. Re-run with --reclaim if you need the space back.');
    }
    const after = await count();
    console.log(`  remaining ${STRATEGY} rows: ${after.n}`);
  }
} catch (e) {
  console.error('purge failed:', e.code || e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
