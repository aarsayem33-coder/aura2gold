/**
 * Where do the minutes go? — the four segments between a candle closing and an order filling.
 *
 * Run:  node latencyReport.mjs [days]
 *
 * Reads the instrumentation added for the ict-breaker family. Reports MEDIANS, not means: one
 * stalled row would drag a mean anywhere, and the question is what happens on a typical trade.
 *
 * The measurement that matters: the 10-year test showed the strategy's entire edge is destroyed
 * within the first 5 MINUTES of delay (avg win 4.08R -> 1.08R). So the bar is not "fast enough
 * on average" — it is whether the typical trade clears the candle close by seconds or minutes.
 */
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config({ path: './.env.local' });

const DAYS = Math.max(1, Number(process.argv[2]) || 14);

const c = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME, port: Number(process.env.DB_PORT) || 3306,
});

const [rows] = await c.query(
  `SELECT id, strategy, symbol, timeframe, status,
          bar_close_at, detected_at, created_at, sent_at, filled_at
     FROM mt5_auto_trades
    WHERE detected_at IS NOT NULL
      AND created_at > DATE_SUB(NOW(), INTERVAL ? DAY)
    ORDER BY created_at DESC`, [DAYS]);

if (!rows.length) {
  console.log(`No instrumented rows in the last ${DAYS} days.`);
  console.log('This is expected until the ict-breaker family next auto-trades — the columns are');
  console.log('only populated on rows that actually reach the EA.');
  await c.end();
  process.exit(0);
}

const ms = (a, b) => {
  if (!a || !b) return null;
  const d = new Date(b).getTime() - new Date(a).getTime();
  return Number.isFinite(d) ? d : null;
};
const q = (arr, p) => {
  const v = arr.filter((x) => x !== null).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length * p)] : null;
};
const fmt = (v) => (v === null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`);

const SEGMENTS = [
  ['① candle close → detected', 'bar_close_at', 'detected_at', 'scanner on a timer vs on bar close'],
  ['② detected → row written', 'detected_at', 'created_at', 'should be milliseconds'],
  ['③ row → EA picked up', 'created_at', 'sent_at', 'InpTradePollSec = 3s'],
  ['④ EA sent → filled', 'sent_at', 'filled_at', "the broker's, not ours"],
];

console.log(`=== auto-trade latency · ict-breaker family · last ${DAYS} days · ${rows.length} rows ===\n`);
console.log('segment'.padEnd(28) + 'n'.padStart(5) + 'p50'.padStart(9) + 'p75'.padStart(9) + 'p90'.padStart(9) + '   what it means');
for (const [label, from, to, note] of SEGMENTS) {
  const vals = rows.map((r) => ms(r[from], r[to])).filter((v) => v !== null && v >= 0);
  console.log(label.padEnd(28) + String(vals.length).padStart(5)
    + fmt(q(vals, 0.5)).padStart(9) + fmt(q(vals, 0.75)).padStart(9) + fmt(q(vals, 0.9)).padStart(9)
    + '   ' + note);
}

// End to end, against the threshold that actually matters.
const total = rows.map((r) => ms(r.bar_close_at, r.filled_at)).filter((v) => v !== null && v >= 0);
if (total.length) {
  const p50 = q(total, 0.5), p90 = q(total, 0.9);
  console.log(`\nEND TO END (candle close → filled): p50 ${fmt(p50)} · p90 ${fmt(p90)} · n=${total.length}`);
  const under5m = total.filter((v) => v < 5 * 60000).length;
  console.log(`fills inside the 5-minute window where the edge survives: ${under5m}/${total.length}`
    + ` (${((under5m / total.length) * 100).toFixed(0)}%)`);
} else {
  console.log('\nEND TO END: no filled rows yet — segments ① to ③ are still measurable above.');
}

// Per timeframe: a 60s scan timer hurts M5 far more than H1, so the split matters.
console.log('\nby timeframe (segment ① — candle close → detected):');
const byTf = {};
for (const r of rows) {
  const v = ms(r.bar_close_at, r.detected_at);
  if (v === null || v < 0) continue;
  (byTf[r.timeframe] ||= []).push(v);
}
for (const [tf, vals] of Object.entries(byTf).sort()) {
  console.log(`  ${tf.padEnd(5)} n=${String(vals.length).padStart(4)}  p50 ${fmt(q(vals, 0.5)).padStart(8)}  p90 ${fmt(q(vals, 0.9)).padStart(8)}`);
}
await c.end();
