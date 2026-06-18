#!/usr/bin/env node
/**
 * FTT (Fixed-Time Trade) replay CLI — true point-in-time backtest for the
 * fixed-time/binary engine, the counterpart to replay-cli.mjs (forex).
 *
 * Usage (from backend/):
 *   node ftt-replay-cli.mjs XAUUSDM 5m
 *   node ftt-replay-cli.mjs EURUSDM 15m --tf M5 --days 30 --payout 0.85
 *   node ftt-replay-cli.mjs XAUUSDM 5m --json > ftt-replay.json
 *
 * Flags: --tf BASE_TF (default M1) --days N (default 14) --warmup N (default 80)
 *        --max N (default 3000) --payout P (broker win payout, default 0.85)
 *        --split S (OOS train fraction, default 0.7) --json (raw output)
 *
 * Resolution mirrors the LIVE FTT resolver (server.js setInterval): entry at the
 * signal-bar close; expiry = entryTime + expiry duration; exit = close of the
 * candle nearest the expiry within a tolerance window; WIN if price moved the
 * predicted way (UP→exit>entry, DOWN→exit<entry), LOSS if opposite, DRAW if
 * equal, NO_TRADE for HOLD (not scored). FTT is binary, so "expectancy" is
 * payout-weighted units per scored trade (stake=1), not pips.
 *
 * The prediction logic (generateFttPrediction) is imported from fttEngine.js —
 * single-sourced with live. skipNews:true avoids applying the CURRENT news
 * calendar to historical bars (same point-in-time fix used in the forex replay).
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { generateFttPrediction } from './fttEngine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env.local'), override: true });
dotenv.config({ path: path.join(__dirname, '.env') });

// ── arg parsing ──
const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const hasFlag = (name) => argv.includes(`--${name}`);
const symbol = (positional[0] || '').toUpperCase();
const expiry = (positional[1] || '').toLowerCase();
if (!symbol || !expiry) {
  console.error('Usage: node ftt-replay-cli.mjs <SYMBOL> <EXPIRY e.g. 5m> [--tf M1 --days N --warmup N --max N --payout P --split S --json]');
  process.exit(1);
}

// ── pure helpers ──
// Mirror of fttEngine.parseExpiryMs (not exported there).
function parseExpiryMs(exp) {
  const str = String(exp || '5m').trim().toLowerCase();
  const match = str.match(/^(\d+)\s*(m|min|h|hr|s|sec)$/);
  if (!match) return 5 * 60 * 1000;
  const value = Number(match[1]);
  switch (match[2]) {
    case 's': case 'sec': return value * 1000;
    case 'h': case 'hr': return value * 60 * 60 * 1000;
    default: return value * 60 * 1000; // m / min
  }
}
function timeframeMinutes(tf) {
  const m = { M1: 1, M2: 2, M3: 3, M5: 5, M10: 10, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440 };
  return m[String(tf).toUpperCase()] || 1;
}
// FTT tier gate: live default min tier = QUALITY_SIGNAL.
const FTT_TIER_RANK = { NO_TRADE: 0, WATCH_ONLY: 0, TRADE_SIGNAL: 1, QUALITY_SIGNAL: 2 };
function passesFttGate(tier) {
  return (FTT_TIER_RANK[String(tier || '').toUpperCase()] || 0) >= FTT_TIER_RANK.QUALITY_SIGNAL;
}

// Resolve a fixed-time prediction against the forward candle series, mirroring the
// live resolver's nearest-candle-within-tolerance rule.
function resolveFtt(direction, entryPrice, entryMs, expiryMs, forwardCandles) {
  if (String(direction).toUpperCase() === 'HOLD') return { outcome: 'NO_TRADE', exitPrice: null };
  const expiryTime = entryMs + expiryMs;
  const toleranceMs = expiryMs <= 5 * 60 * 1000
    ? Math.max(15 * 1000, Math.min(60 * 1000, expiryMs * 0.25))
    : Math.min(3 * 60 * 1000, expiryMs * 0.2);
  const candidates = forwardCandles
    .filter((c) => Number.isFinite(c.ms) && Math.abs(c.ms - expiryTime) <= toleranceMs)
    .sort((a, b) => {
      const ad = Math.abs(a.ms - expiryTime);
      const bd = Math.abs(b.ms - expiryTime);
      return ad !== bd ? ad - bd : a.ms - b.ms;
    });
  const hit = candidates[0];
  if (!hit || hit.close === null || hit.close === undefined) return { outcome: 'EXPIRED', exitPrice: null };
  const exit = Number(hit.close);
  if (exit > entryPrice) return { outcome: direction === 'UP' ? 'WIN' : 'LOSS', exitPrice: exit };
  if (exit < entryPrice) return { outcome: direction === 'DOWN' ? 'WIN' : 'LOSS', exitPrice: exit };
  return { outcome: 'DRAW', exitPrice: exit };
}

// ── stats (binary, payout-weighted) ──
function emptyStats() { return { total: 0, wins: 0, losses: 0, draws: 0, noTrade: 0, expired: 0 }; }
function addStat(s, outcome) {
  s.total += 1;
  const o = String(outcome).toUpperCase();
  if (o === 'WIN') s.wins += 1;
  else if (o === 'LOSS') s.losses += 1;
  else if (o === 'DRAW') s.draws += 1;
  else if (o === 'NO_TRADE') s.noTrade += 1;
  else if (o === 'EXPIRED') s.expired += 1;
}
function finalize(s, payout) {
  const scored = s.wins + s.losses;
  const breakevenWinRate = Math.round((1 / (1 + payout)) * 1000) / 10; // % needed to break even
  return {
    total: s.total, scored, wins: s.wins, losses: s.losses, draws: s.draws, noTrade: s.noTrade, expired: s.expired,
    winRate: scored ? Math.round((s.wins / scored) * 1000) / 10 : 0,
    // expectancy in stake-units per scored trade: win pays +payout, loss pays -1.
    expectancyUnits: scored ? Math.round(((s.wins * payout - s.losses) / scored) * 1000) / 1000 : 0,
    netUnits: Math.round((s.wins * payout - s.losses) * 100) / 100,
    breakevenWinRate,
  };
}
function groupBy(samples, keyFn, payout) {
  const m = {};
  for (const s of samples) { const k = String(keyFn(s) ?? 'unknown'); (m[k] ||= emptyStats()); addStat(m[k], s.outcome); }
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, finalize(v, payout)]));
}
const sampleConfidence = (n) => (n >= 300 ? 'strong' : n >= 100 ? 'usable' : n >= 30 ? 'early' : 'weak');

// Walk-forward / OOS — does the FTT edge survive out-of-sample? Verdict needs the
// test fold to clear breakeven (positive payout-weighted expectancy), not just >50%.
function oosReport(samples, split, payout) {
  const n = samples.length;
  const cut = Math.floor(n * split);
  const train = samples.slice(0, cut);
  const test = samples.slice(cut);
  const fold = (arr) => finalize(arr.reduce((s, x) => (addStat(s, x.outcome), s), emptyStats()), payout);
  const t = fold(train);
  const v = fold(test);
  let verdict;
  if (v.scored < 10) verdict = `inconclusive (only ${v.scored} scored in test — need more history)`;
  else if (v.winRate >= t.winRate - 10 && v.expectancyUnits > 0) verdict = 'HOLDS out-of-sample';
  else verdict = 'DEGRADES out-of-sample (likely overfit or below payout breakeven)';
  return { split, trainN: train.length, testN: test.length, train: t, test: v, trainByTier: groupBy(train, (s) => s.qualityTier, payout), testByTier: groupBy(test, (s) => s.qualityTier, payout), verdict };
}

// ── DB ──
const DB_SSL = process.env.DB_SSL === 'true';
if (!process.env.DB_HOST || !process.env.DB_USER || !process.env.DB_NAME) {
  console.error('Missing DB config (DB_HOST/DB_USER/DB_PASSWORD/DB_NAME). Run from backend/ with .env present.');
  process.exit(1);
}
const pool = mysql.createPool({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  waitForConnections: true, connectionLimit: 3, ssl: DB_SSL ? { rejectUnauthorized: false } : undefined, timezone: 'Z',
});
async function fetchCandles(sym, tf, startIso, endIso, maxRows = 200000) {
  const all = [];
  let lastSeen = null;
  while (all.length < maxRows) {
    const lowClause = lastSeen === null ? 'candle_time >= ?' : 'candle_time > ?';
    const lowParam = lastSeen === null ? startIso : lastSeen;
    const take = Math.min(5000, maxRows - all.length);
    const [rows] = await pool.query(
      `SELECT candle_time, open_price, high, low, close_price, volume, spread
       FROM mt5_candles WHERE symbol = ? AND timeframe = ? AND ${lowClause} AND candle_time <= ?
       ORDER BY candle_time ASC LIMIT ?`,
      [sym, tf, lowParam, endIso, take],
    );
    if (!rows.length) break;
    all.push(...rows);
    lastSeen = rows[rows.length - 1].candle_time;
    if (rows.length < take) break;
  }
  const mapped = all.map((r) => ({
    time: r.candle_time ? new Date(r.candle_time).toISOString() : null,
    open: r.open_price == null ? null : Number(r.open_price),
    high: r.high == null ? null : Number(r.high),
    low: r.low == null ? null : Number(r.low),
    close: r.close_price == null ? null : Number(r.close_price),
    volume: r.volume == null ? null : Number(r.volume),
    spread: r.spread == null ? null : Number(r.spread),
  })).filter((c) => c.time);
  // Collapse intra-bar snapshots → one bar per interval (the DB stores ~5x rows
  // per real bar; raw series wrecks indicators).
  const intervalMs = timeframeMinutes(tf) * 60 * 1000;
  const byBar = new Map();
  for (const c of mapped) {
    const ms = Date.parse(c.time);
    if (!Number.isFinite(ms)) continue;
    byBar.set(Math.floor(ms / intervalMs) * intervalMs, { ...c, time: new Date(Math.floor(ms / intervalMs) * intervalMs).toISOString() });
  }
  return [...byBar.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
}

// ── replay ──
async function run() {
  const baseTf = String(flag('tf', 'M1')).toUpperCase();
  const days = Math.max(1, Math.min(Number(flag('days', 14)), 120));
  const warmup = Math.max(40, Math.min(Number(flag('warmup', 80)), 400));
  const maxSignals = Math.max(1, Math.min(Number(flag('max', 3000)), 10000));
  const payout = Math.max(0.1, Math.min(Number(flag('payout', 0.85)), 5));
  const split = Math.min(0.9, Math.max(0.5, Number(flag('split', 0.7))));
  const expiryMs = parseExpiryMs(expiry);

  const endMs = Date.now();
  const startMs = endMs - days * 86400 * 1000;
  const bufferMs = Math.max(20 * 86400 * 1000, warmup * timeframeMinutes(baseTf) * 60 * 1000 * 1.4);
  const startIso = new Date(startMs - bufferMs).toISOString();
  const endIso = new Date(endMs).toISOString();

  const tag = (rows) => rows
    .filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite))
    .map((c) => ({ ...c, symbol, ms: Date.parse(c.time) }))
    .filter((c) => Number.isFinite(c.ms));

  process.stderr.write(`Fetching ${symbol} ${baseTf} candles…\n`);
  const candles = tag(await fetchCandles(symbol, baseTf, startIso, endIso));
  if (candles.length < warmup + 5) {
    console.error(`Insufficient candle history: ${candles.length} bars (need > ${warmup + 5}). Try a higher --tf or shorter --days.`);
    await pool.end();
    process.exit(2);
  }
  const h4 = tag(await fetchCandles(symbol, 'H4', startIso, endIso));
  const h1 = tag(await fetchCandles(symbol, 'H1', startIso, endIso));
  const firstBarMs = candles[0].ms;
  const lastBarMs = candles[candles.length - 1].ms;
  const coverageDays = Math.round(((lastBarMs - firstBarMs) / 86400000) * 10) / 10;
  const truncated = firstBarMs > startMs;
  process.stderr.write(`Loaded ${candles.length} ${baseTf} bars (+${h4.length} H4, ${h1.length} H1), spanning ${coverageDays}d of ${days}d requested${truncated ? ' (TRUNCATED)' : ''}. Replaying ${expiry} expiry…\n`);

  const samples = [];
  let holds = 0;
  let barsProcessed = 0;
  for (let i = warmup; i < candles.length - 1; i++) {
    const bar = candles[i];
    if (bar.ms < startMs) continue;
    barsProcessed += 1;
    let pred;
    try {
      pred = generateFttPrediction({
        symbol, expiry, candles: candles.slice(0, i + 1), indicators: [],
        marketLevels: [], accountSnapshot: null, adr: null, dailyHighLow: null,
        h4Candles: h4.filter((c) => c.ms <= bar.ms), h1Candles: h1.filter((c) => c.ms <= bar.ms),
        skipNews: true,
      });
    } catch { continue; }
    if (!pred || pred.direction === 'HOLD') { holds += 1; continue; }
    const entry = Number(pred.entryPrice);
    if (!Number.isFinite(entry)) continue;
    const res = resolveFtt(pred.direction, entry, bar.ms, expiryMs, candles.slice(i + 1));
    const ind = pred.indicators || {};
    samples.push({
      signalTime: bar.time,
      direction: pred.direction,
      confidence: pred.confidence,
      grade: ind.grade || 'No Trade',
      qualityTier: ind.qualityTier || 'WATCH_ONLY',
      qualityScore: ind.qualityScore,
      session: ind.systemDecision?.sessionContext?.reason || 'none',
      pattern: (ind.detectedPatterns || []).find((p) => p?.direction && p.direction !== 'neutral')?.name
        || (Array.isArray(ind.detectedPatterns) && ind.detectedPatterns[0]?.name) || 'none',
      outcome: res.outcome,
      exitPrice: res.exitPrice,
      gate: passesFttGate(ind.qualityTier) ? 'WOULD_EMAIL' : 'FILTERED_OUT',
    });
    if (samples.length >= maxSignals) break;
  }

  const overall = finalize(samples.reduce((s, x) => (addStat(s, x.outcome), s), emptyStats()), payout);
  const result = {
    symbol, expiry, baseTf, payout,
    params: { days, warmup, maxSignals, split },
    coverage: { requestedDays: days, coverageDays, truncated, firstBar: new Date(firstBarMs).toISOString(), lastBar: new Date(lastBarMs).toISOString() },
    barsProcessed, signalsGenerated: samples.length, holds,
    signalRate: barsProcessed ? Math.round((samples.length / barsProcessed) * 1000) / 10 : 0,
    overall,
    oos: samples.length >= 10 ? oosReport(samples, split, payout) : null,
    byGate: groupBy(samples, (s) => s.gate, payout),
    byTier: groupBy(samples, (s) => s.qualityTier, payout),
    byGrade: groupBy(samples, (s) => s.grade, payout),
    bySession: groupBy(samples, (s) => s.session, payout),
    byPattern: groupBy(samples, (s) => s.pattern, payout),
    methodology: [
      'Point-in-time replay: each bar sees only candles up to its close (skipNews so the current calendar is not applied to history).',
      'Entry at signal-bar close; resolve at expiry via nearest candle within live tolerance.',
      `Binary outcome; expectancy in stake-units at payout ${payout} (win +${payout}, loss -1). Breakeven win rate ${overall.breakevenWinRate}%.`,
      'Limitation: resolves on the base-TF series (use --tf M1 for the most precise expiry match); news not point-in-time; ADR/DHL omitted.',
    ],
  };

  await pool.end();

  if (hasFlag('json')) { console.log(JSON.stringify(result, null, 2)); return; }

  const line = (label, st) => `  ${label.padEnd(22)} n=${String(st.total).padStart(4)}  scored=${String(st.scored).padStart(4)}  win=${String(st.winRate + '%').padStart(6)}  expU=${String(st.expectancyUnits.toFixed(3)).padStart(7)}  net=${String(st.netUnits).padStart(7)}u`;
  console.log(`\n═══ FTT REPLAY: ${symbol} ${expiry} | base ${baseTf} | ${days}d | payout ${payout} ═══`);
  console.log(`Coverage: ${coverageDays}d of ${days}d requested${truncated ? ' ⚠ TRUNCATED' : ''}  (${new Date(firstBarMs).toISOString().slice(0, 10)} → ${new Date(lastBarMs).toISOString().slice(0, 10)})`);
  console.log(`Bars processed: ${barsProcessed} | Signals: ${samples.length} (${result.signalRate}%/bar) | Holds: ${holds}`);
  console.log(`Breakeven win rate at payout ${payout}: ${overall.breakevenWinRate}%  ← must clear this to be profitable`);
  console.log(`\nOVERALL`);
  console.log(line('all signals', overall));
  console.log(`  draws=${overall.draws} no-trade=${overall.noTrade} expired=${overall.expired}`);
  if (result.oos) {
    const o = result.oos;
    console.log(`\nWALK-FORWARD / OUT-OF-SAMPLE  (chronological ${Math.round(o.split * 100)}/${Math.round((1 - o.split) * 100)} split)`);
    console.log(`  TRAIN  n=${String(o.trainN).padStart(4)}  scored=${String(o.train.scored).padStart(4)}  win=${String(o.train.winRate + '%').padStart(6)}  expU=${o.train.expectancyUnits.toFixed(3)}`);
    console.log(`  TEST   n=${String(o.testN).padStart(4)}  scored=${String(o.test.scored).padStart(4)}  win=${String(o.test.winRate + '%').padStart(6)}  expU=${o.test.expectancyUnits.toFixed(3)}`);
    console.log(`  per-tier win% (train → test):`);
    const tiers = [...new Set([...Object.keys(o.trainByTier), ...Object.keys(o.testByTier)])];
    tiers.forEach((t) => {
      const tr = o.trainByTier[t]; const te = o.testByTier[t];
      console.log(`    ${t.padEnd(16)} ${tr ? tr.winRate + '%' : '—'} (n${tr ? tr.total : 0}) → ${te ? te.winRate + '%' : '—'} (n${te ? te.total : 0})`);
    });
    console.log(`  VERDICT: ${o.verdict}`);
  }
  const section = (title, obj) => { console.log(`\n${title}`); Object.entries(obj).sort((a, b) => b[1].total - a[1].total).forEach(([k, st]) => console.log(line(k, st))); };
  section('BY GATE  (← the "too strict?" answer for FTT)', result.byGate);
  section('BY TIER', result.byTier);
  section('BY GRADE', result.byGrade);
  section('BY SESSION', result.bySession);
  section('BY PATTERN', result.byPattern);
  console.log(`\nNote: point-in-time; entry=signal-bar close; resolve at expiry nearest candle; HOLD=NO_TRADE (unscored).`);
  console.log(`Payout-weighted: win +${payout}u, loss -1u. Clear ${overall.breakevenWinRate}% win rate to profit.\n`);
}

run().catch(async (err) => { console.error('FTT replay failed:', err.message); try { await pool.end(); } catch {} process.exit(1); });
