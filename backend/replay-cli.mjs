#!/usr/bin/env node
/**
 * Phase 1 replay CLI — run the true signal-replay backtest against real DB
 * candles without booting the server.
 *
 * Usage (from backend/):
 *   node replay-cli.mjs XAUUSD M15
 *   node replay-cli.mjs EURUSD H1 --days 30 --cost 2
 *   node replay-cli.mjs XAUUSD M15 --json > replay.json
 *
 * Flags: --days N (default 14) --horizon H (hrs, default 72) --warmup N (default 80)
 *        --max N (default 1500) --cost pips (default per-symbol) --json (raw output)
 *
 * The signal logic (aggregateSignals + extractFeatures) is imported from
 * signalEngine.js — single-sourced with live + the /api/reports/replay/forex
 * endpoint. The forward-sim and stats below mirror server.js's evaluateForexReplay
 * / finalizeStats (conservative AMBIGUOUS rule, profit factor, 2R, byGate).
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { aggregateSignals } from './signalEngine.js';

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
const timeframe = (positional[1] || '').toUpperCase();
if (!symbol || !timeframe) {
  console.error('Usage: node replay-cli.mjs <SYMBOL> <TIMEFRAME> [--days N --horizon H --warmup N --max N --cost pips --json]');
  process.exit(1);
}

// ── pure helpers (mirror server.js) ──
function pipSizeForSymbol(s) {
  const u = String(s).toUpperCase();
  if (/XAU|GOLD/.test(u)) return 0.1;
  if (/XAG/.test(u)) return 0.01;
  if (/JPY/.test(u)) return 0.01;
  if (/BTC|ETH/.test(u)) return 1.0;
  return 0.0001;
}
function defaultCostPips(s) {
  const u = String(s).toUpperCase();
  if (/XAU|GOLD/.test(u)) return 6;
  if (/XAG/.test(u)) return 4;
  if (/BTC|ETH/.test(u)) return 30;
  if (/JPY/.test(u)) return 2;
  return 2;
}
function timeframeMinutes(tf) {
  const m = { M1: 1, M2: 2, M3: 3, M5: 5, M10: 10, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440 };
  return m[String(tf).toUpperCase()] || 15;
}
// Default email gate: grade >= A Setup AND quality >= A SIGNAL (matches live default).
function passesEmailGate(grade, quality) {
  const g = String(grade || '');
  const q = String(quality || '').toUpperCase();
  const isAGrade = g === 'A Setup' || g === 'A+ Setup';
  const isAQuality = q === 'A SIGNAL' || q === 'A+ SIGNAL';
  return isAGrade && isAQuality;
}

// Forward simulation — entry at signal-bar close, resolution begins next bar.
// Conservative: a bar that touches BOTH a TP and the SL is AMBIGUOUS, not a win.
function evaluateReplay({ symbol: sym, direction, entry, sl, tp1, tp2, tp3 }, forwardCandles, horizonHours) {
  if (![entry, sl, tp1].every(Number.isFinite)) return { valid: false };
  const isBuy = String(direction).toUpperCase().includes('BUY');
  const pip = pipSizeForSymbol(sym);
  const startMs = forwardCandles.length ? forwardCandles[0].ms : null;
  const horizonMs = Math.max(1, horizonHours) * 3600 * 1000;
  const later = forwardCandles.filter((c) => startMs !== null && c.ms <= startMs + horizonMs);
  if (!later.length) return { valid: true, outcome: 'EXPIRED', tpHitLevel: 0, profitLossPips: null, mfePips: 0, maePips: 0, barsToResolution: 0 };

  let bestRank = 0;
  let outcome = 'PENDING';
  let exitPrice = null;
  let bars = 0;
  let mfe = 0;
  let mae = 0;
  for (const c of later) {
    bars += 1;
    const lo = Number(c.low);
    const hi = Number(c.high);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    const favorable = isBuy ? (hi - entry) / pip : (entry - lo) / pip;
    const adverse = isBuy ? (lo - entry) / pip : (entry - hi) / pip;
    mfe = Math.max(mfe, Math.round(favorable * 10) / 10);
    mae = Math.min(mae, Math.round(adverse * 10) / 10);
    const hitTp1 = isBuy ? hi >= tp1 : lo <= tp1;
    const hitTp2 = Number.isFinite(tp2) ? (isBuy ? hi >= tp2 : lo <= tp2) : false;
    const hitTp3 = Number.isFinite(tp3) ? (isBuy ? hi >= tp3 : lo <= tp3) : false;
    const hitAny = hitTp3 || hitTp2 || hitTp1;
    const hitLevel = hitTp3 ? 3 : hitTp2 ? 2 : hitTp1 ? 1 : 0;
    const hitSl = isBuy ? lo <= sl : hi >= sl;
    if (hitSl && !hitAny) { if (bestRank === 0) { outcome = 'LOSS'; exitPrice = sl; } break; }
    if (hitAny && hitSl && hitLevel > bestRank) { outcome = 'AMBIGUOUS'; break; }
    if (hitAny && hitLevel > bestRank) {
      bestRank = hitLevel;
      outcome = hitLevel === 3 ? 'TP3_WIN' : hitLevel === 2 ? 'TP2_WIN' : 'TP1_WIN';
      exitPrice = hitLevel === 3 ? tp3 : hitLevel === 2 ? tp2 : tp1;
    }
  }
  if (outcome === 'PENDING') outcome = 'EXPIRED';
  const diff = isBuy ? (Number(exitPrice ?? entry) - entry) : (entry - Number(exitPrice ?? entry));
  const profitLossPips = outcome === 'LOSS'
    ? -Math.abs(Math.round((diff / pip) * 10) / 10)
    : outcome === 'AMBIGUOUS' ? null : Math.round((diff / pip) * 10) / 10;
  return { valid: true, outcome, tpHitLevel: bestRank, profitLossPips, mfePips: Math.round(mfe * 10) / 10, maePips: Math.round(mae * 10) / 10, barsToResolution: bars };
}

// Phase 4: path-aware management-model simulation. Returns the realized R-multiple
// (risk-multiple, net of cost) for each style, walking the SAME price path. This
// strips the optimistic "best TP ever reached" assumption of evaluateReplay by
// committing to a consistent rule. Conservative intrabar: if a bar touches both
// the stop and a target, the STOP is assumed hit first.
//   tp1/tp2/tp3      = all-or-nothing exit at that target (stop = initial SL)
//   halfBE_tp2/tp3   = 50% off at TP1, move stop to breakeven, runner to TP2/TP3
function simulateManagement(sig, candles, costPips, pip) {
  const { direction, entry, sl, tp1, tp2, tp3 } = sig;
  const risk = Math.abs(entry - sl);
  if (!(risk > 0) || !candles.length) return null;
  const dir = String(direction).toUpperCase().includes('BUY') ? 1 : -1;
  const costR = (costPips * pip) / risk;
  const rMult = (px) => (dir * (px - entry)) / risk;                 // R-multiple of exiting full size at px
  const hitTarget = (c, lvl) => Number.isFinite(lvl) && (dir === 1 ? c.high >= lvl : c.low <= lvl);
  const hitStop = (c, stop) => dir === 1 ? c.low <= stop : c.high >= stop;
  const lastClose = candles[candles.length - 1].close;

  // All-or-nothing to a single target; stop at initial SL.
  const aon = (target) => {
    for (const c of candles) {
      if (hitStop(c, sl)) return rMult(sl) - costR;                  // stop first (covers ambiguous)
      if (hitTarget(c, target)) return rMult(target) - costR;
    }
    return rMult(lastClose) - costR;                                 // horizon end: mark to last close
  };

  // 50% at TP1, move stop to breakeven, remaining 50% runs to runnerTarget.
  const halfBE = (runnerTarget) => {
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      if (hitStop(c, sl)) return rMult(sl) - costR;                  // full loss before TP1
      if (hitTarget(c, tp1)) {
        const lockedHalf = 0.5 * 1;                                  // +0.5R banked (TP1 = 1R)
        if (hitStop(c, entry)) return lockedHalf - costR;            // same bar pierced BE → runner flat
        for (let j = i + 1; j < candles.length; j++) {
          const d = candles[j];
          if (hitStop(d, entry)) return lockedHalf - costR;          // BE before target (conservative)
          if (hitTarget(d, runnerTarget)) return lockedHalf + 0.5 * rMult(runnerTarget) - costR;
        }
        return lockedHalf + 0.5 * rMult(lastClose) - costR;          // runner marked to last close
      }
    }
    return rMult(lastClose) - costR;
  };

  const r2 = (x) => Math.round(x * 100) / 100;
  return { tp1: r2(aon(tp1)), tp2: r2(aon(tp2)), tp3: r2(aon(tp3)), halfBE_tp2: r2(halfBE(tp2)), halfBE_tp3: r2(halfBE(tp3)) };
}

const MGMT_MODELS = [
  ['tp1', 'TP1 only (1R)'],
  ['tp2', 'TP2 only (2R)'],
  ['tp3', 'TP3 only (3R)'],
  ['halfBE_tp2', '50%@TP1 +BE, run TP2'],
  ['halfBE_tp3', '50%@TP1 +BE, run TP3'],
];
function aggregateMgmt(samples) {
  const out = {};
  for (const [key, label] of MGMT_MODELS) {
    const rs = samples.map((s) => s.mgmt && s.mgmt[key]).filter(Number.isFinite);
    const wins = rs.filter((r) => r > 0).length;
    const gw = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
    const gl = rs.filter((r) => r < 0).reduce((a, b) => a + Math.abs(b), 0);
    const sum = rs.reduce((a, b) => a + b, 0);
    out[key] = {
      label,
      n: rs.length,
      winRate: rs.length ? Math.round((wins / rs.length) * 100) : 0,
      expectancyR: rs.length ? Math.round((sum / rs.length) * 100) / 100 : 0,
      netR: Math.round(sum * 100) / 100,
      profitFactor: gl > 0 ? Math.round((gw / gl) * 100) / 100 : (gw > 0 ? null : 0),
    };
  }
  return out;
}

// ── stats (mirror server.js addToStats/finalizeStats) ──
function emptyStats() { return { total: 0, wins: 0, losses: 0, breakeven: 0, ambiguous: 0, expired: 0, tp1: 0, tp2: 0, tp3: 0, _gw: 0, _gl: 0, _pc: 0, netPips: 0 }; }
function addStat(s, outcome, pips) {
  s.total += 1;
  const o = String(outcome).toUpperCase();
  if (o.endsWith('_WIN') || o === 'WIN') { s.wins += 1; if (o === 'TP1_WIN') s.tp1 += 1; if (o === 'TP2_WIN') s.tp2 += 1; if (o === 'TP3_WIN') s.tp3 += 1; }
  else if (o === 'LOSS') s.losses += 1;
  else if (o === 'BREAKEVEN') s.breakeven += 1;
  else if (o === 'AMBIGUOUS') s.ambiguous += 1;
  else if (o === 'EXPIRED') s.expired += 1;
  if (Number.isFinite(pips)) { s.netPips += pips; s._pc += 1; if (pips >= 0) s._gw += pips; else s._gl += Math.abs(pips); }
}
function finalize(s) {
  const scored = s.wins + s.losses;
  return {
    total: s.total, settled: scored, wins: s.wins, losses: s.losses, ambiguous: s.ambiguous, expired: s.expired,
    winRate: scored ? Math.round((s.wins / scored) * 100) : 0,
    tp1HitRate: s.total ? Math.round((s.tp1 / s.total) * 100) : 0,
    tp2HitRate: s.total ? Math.round((s.tp2 / s.total) * 100) : 0,
    tp3HitRate: s.total ? Math.round((s.tp3 / s.total) * 100) : 0,
    profitFactor: s._gl > 0 ? Math.round((s._gw / s._gl) * 100) / 100 : (s._gw > 0 ? null : 0),
    netPips: Math.round(s.netPips * 10) / 10,
    avgPips: s._pc ? Math.round((s.netPips / s._pc) * 10) / 10 : 0,
  };
}
function groupBy(samples, keyFn) {
  const m = {};
  for (const s of samples) { const k = String(keyFn(s) ?? 'unknown'); (m[k] ||= emptyStats()); addStat(m[k], s.outcome, s.netPips); }
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, finalize(v)]));
}

const sampleConfidence = (n) => (n >= 300 ? 'strong' : n >= 100 ? 'usable' : n >= 30 ? 'early' : 'weak');

// Walk-forward / out-of-sample split: optimize on the chronological TRAIN portion,
// judge on the unseen TEST portion. If grade separation / edge only shows in TRAIN,
// it's curve-fitting. Samples are already in chronological order (bars ascending).
function oosReport(samples, split) {
  const n = samples.length;
  const cut = Math.floor(n * split);
  const train = samples.slice(0, cut);
  const test = samples.slice(cut);
  const fold = (arr) => finalize(arr.reduce((s, x) => (addStat(s, x.outcome, x.netPips), s), emptyStats()));
  const t = fold(train);
  const v = fold(test);
  // Verdict: does the edge survive out-of-sample? Needs enough test settled to mean anything.
  let verdict;
  if (v.settled < 10) verdict = `inconclusive (only ${v.settled} settled in test — need more history)`;
  else if (v.winRate >= t.winRate - 10 && v.netPips > 0) verdict = 'HOLDS out-of-sample';
  else verdict = 'DEGRADES out-of-sample (likely overfit)';
  return { split, trainN: train.length, testN: test.length, train: t, test: v, trainByGrade: groupBy(train, (s) => s.grade), testByGrade: groupBy(test, (s) => s.grade), verdict };
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
  // Keyset-paginate past the 5000-row wall (historical rows are ~5x polluted),
  // then collapse to real bars. Mirrors server getCandlesFromDbRange.
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
  // per real bar; raw series wrecks ATR/ADX/swings). Keep last snapshot, snap to boundary.
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
  const days = Math.max(1, Math.min(Number(flag('days', 14)), 120));
  const horizonHours = Math.max(1, Number(flag('horizon', 72)));
  const warmup = Math.max(40, Math.min(Number(flag('warmup', 80)), 400));
  const maxSignals = Math.max(1, Math.min(Number(flag('max', 1500)), 5000));
  const cost = flag('cost', null) !== null ? Number(flag('cost', null)) : defaultCostPips(symbol);
  const split = Math.min(0.9, Math.max(0.5, Number(flag('split', 0.7))));

  const endMs = Date.now();
  const startMs = endMs - days * 86400 * 1000;
  const bufferMs = Math.max(20 * 86400 * 1000, warmup * timeframeMinutes(timeframe) * 60 * 1000 * 1.4);
  const startIso = new Date(startMs - bufferMs).toISOString();
  const endIso = new Date(endMs).toISOString();

  const tag = (rows) => rows
    .filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite))
    .map((c) => ({ ...c, symbol, timeframe, ms: Date.parse(c.time) }))
    .filter((c) => Number.isFinite(c.ms));

  process.stderr.write(`Fetching ${symbol} ${timeframe} candles…\n`);
  const candles = tag(await fetchCandles(symbol, timeframe, startIso, endIso));
  if (candles.length < warmup + 5) {
    console.error(`Insufficient candle history: ${candles.length} bars (need > ${warmup + 5}). Try a higher timeframe or shorter --days.`);
    await pool.end();
    process.exit(2);
  }
  const h4 = tag(await fetchCandles(symbol, 'H4', startIso, endIso));
  const h1 = tag(await fetchCandles(symbol, 'H1', startIso, endIso));
  // Actual span of returned bars (vs requested --days), so the run reports up
  // front how much real history it found.
  const firstBarMs = candles[0].ms;
  const lastBarMs = candles[candles.length - 1].ms;
  const coverageDays = Math.round(((lastBarMs - firstBarMs) / 86400000) * 10) / 10;
  const truncated = firstBarMs > startMs;
  process.stderr.write(`Loaded ${candles.length} ${timeframe} bars (+${h4.length} H4, ${h1.length} H1), spanning ${coverageDays}d of ${days}d requested${truncated ? ' (TRUNCATED — DB does not reach requested start)' : ''}. Replaying…\n`);

  const samples = [];
  let holds = 0;
  let barsProcessed = 0;
  for (let i = warmup; i < candles.length - 1; i++) {
    const bar = candles[i];
    if (bar.ms < startMs) continue;
    barsProcessed += 1;
    let sd;
    try {
      sd = aggregateSignals({
        symbol, timeframe, candles: candles.slice(0, i + 1), indicators: [],
        marketLevels: [], accountSnapshot: null, adr: null, dailyHighLow: null,
        h4Candles: h4.filter((c) => c.ms <= bar.ms), h1Candles: h1.filter((c) => c.ms <= bar.ms),
        skipNews: true,
      }).systemDecision;
    } catch { continue; }
    if (!sd || sd.decision === 'HOLD') { holds += 1; continue; }
    const fwdAll = candles.slice(i + 1);
    const fwd = evaluateReplay({
      symbol, direction: sd.decision, entry: Number(sd.entryPrice), sl: Number(sd.stopLoss),
      tp1: Number(sd.takeProfit1), tp2: Number(sd.takeProfit2), tp3: Number(sd.takeProfit3),
    }, fwdAll, horizonHours);
    if (!fwd.valid) continue;
    const rawPips = Number.isFinite(fwd.profitLossPips) ? fwd.profitLossPips : null;
    const netPips = rawPips === null ? null : Math.round((rawPips - cost) * 10) / 10;
    // Derive the stop distance directly from entry/SL (riskPlan.stopPips is unreliable
    // in replay) so the 2R metric is trustworthy.
    const stopPips = (Number.isFinite(+sd.entryPrice) && Number.isFinite(+sd.stopLoss))
      ? Math.abs(+sd.entryPrice - +sd.stopLoss) / pipSizeForSymbol(symbol) : null;
    // Phase 4: management-model R-multiples over the horizon-limited path.
    const hStart = fwdAll.length ? fwdAll[0].ms : null;
    const fwdH = hStart === null ? [] : fwdAll.filter((c) => c.ms <= hStart + horizonHours * 3600 * 1000);
    const mgmt = simulateManagement({
      direction: sd.decision, entry: Number(sd.entryPrice), sl: Number(sd.stopLoss),
      tp1: Number(sd.takeProfit1), tp2: Number(sd.takeProfit2), tp3: Number(sd.takeProfit3),
    }, fwdH, cost, pipSizeForSymbol(symbol));
    samples.push({
      grade: sd.grade, signalQuality: sd.signalQuality, regime: sd.regime,
      session: sd.sessionContext?.reason || 'none', strategyType: sd.strategyType || 'SYSTEM_CONFLUENCE',
      pattern: sd.datFramework?.trigger?.pattern || (sd.candlePatterns || []).find((p) => p?.direction && p.direction !== 'neutral')?.name || 'none',
      outcome: fwd.outcome, netPips, mfePips: fwd.mfePips,
      hit2R: !!(stopPips && stopPips > 0 && Number(fwd.mfePips) >= 2 * stopPips),
      gate: passesEmailGate(sd.grade, sd.signalQuality) ? 'WOULD_EMAIL' : 'FILTERED_OUT',
      mgmt,
    });
    if (samples.length >= maxSignals) break;
  }

  const overall = finalize(samples.reduce((s, x) => (addStat(s, x.outcome, x.netPips), s), emptyStats()));
  const hit2RCount = samples.filter((s) => s.hit2R).length;
  const result = {
    symbol, timeframe, params: { days, horizonHours, warmup, maxSignals, costPips: cost },
    coverage: { requestedDays: days, coverageDays, truncated, firstBar: new Date(firstBarMs).toISOString(), lastBar: new Date(lastBarMs).toISOString() },
    barsProcessed, signalsGenerated: samples.length, holds,
    signalRate: barsProcessed ? Math.round((samples.length / barsProcessed) * 1000) / 10 : 0,
    twoR: { hit2RCount, twoRWinRate: samples.length ? Math.round((hit2RCount / samples.length) * 1000) / 10 : 0 },
    overall,
    management: aggregateMgmt(samples),
    oos: samples.length >= 10 ? oosReport(samples, split) : null,
    byGate: groupBy(samples, (s) => s.gate),
    byGrade: groupBy(samples, (s) => s.grade),
    byRegime: groupBy(samples, (s) => s.regime),
    bySession: groupBy(samples, (s) => s.session),
    byPattern: groupBy(samples, (s) => s.pattern),
  };

  await pool.end();

  if (hasFlag('json')) { console.log(JSON.stringify(result, null, 2)); return; }

  const line = (label, st) => `  ${label.padEnd(22)} n=${String(st.total).padStart(4)}  settled=${String(st.settled).padStart(4)}  win=${String(st.winRate + '%').padStart(4)}  PF=${String(st.profitFactor ?? '∞').padStart(5)}  net=${String(st.netPips).padStart(7)}p  avg=${String(st.avgPips).padStart(6)}p`;
  console.log(`\n═══ REPLAY: ${symbol} ${timeframe} | ${days}d | horizon ${horizonHours}h | cost ${cost}p ═══`);
  console.log(`Coverage: ${coverageDays}d of ${days}d requested${truncated ? ' ⚠ TRUNCATED' : ''}  (${new Date(firstBarMs).toISOString().slice(0, 10)} → ${new Date(lastBarMs).toISOString().slice(0, 10)})`);
  console.log(`Bars processed: ${barsProcessed} | Signals: ${samples.length} (${result.signalRate}%/bar) | Holds: ${holds}`);
  console.log(`2R hit rate: ${result.twoR.twoRWinRate}% (${hit2RCount}/${samples.length})`);
  console.log(`\nOVERALL`);
  console.log(line('all signals', overall));
  console.log(`  TP1/TP2/TP3 hit: ${overall.tp1HitRate}% / ${overall.tp2HitRate}% / ${overall.tp3HitRate}%  | ambiguous=${overall.ambiguous} expired=${overall.expired}`);
  console.log(`\nMANAGEMENT MODELS  (expectancy in R, after cost — strips best-TP inflation)`);
  Object.values(result.management).forEach((m) => {
    console.log(`  ${m.label.padEnd(22)} n=${String(m.n).padStart(4)}  win=${String(m.winRate + '%').padStart(4)}  expR=${String(m.expectancyR.toFixed(2)).padStart(6)}  netR=${String(m.netR.toFixed(1)).padStart(7)}  PF=${String(m.profitFactor ?? '∞').padStart(5)}`);
  });
  if (result.oos) {
    const o = result.oos;
    console.log(`\nWALK-FORWARD / OUT-OF-SAMPLE  (chronological ${Math.round(o.split * 100)}/${Math.round((1 - o.split) * 100)} split)`);
    console.log(`  TRAIN  n=${String(o.trainN).padStart(4)}  settled=${String(o.train.settled).padStart(4)}  win=${String(o.train.winRate + '%').padStart(4)}  net=${String(o.train.netPips).padStart(7)}p  PF=${o.train.profitFactor ?? '∞'}`);
    console.log(`  TEST   n=${String(o.testN).padStart(4)}  settled=${String(o.test.settled).padStart(4)}  win=${String(o.test.winRate + '%').padStart(4)}  net=${String(o.test.netPips).padStart(7)}p  PF=${o.test.profitFactor ?? '∞'}`);
    console.log(`  per-grade win% (train → test):`);
    const grades = [...new Set([...Object.keys(o.trainByGrade), ...Object.keys(o.testByGrade)])];
    grades.forEach((g) => {
      const tr = o.trainByGrade[g]; const te = o.testByGrade[g];
      console.log(`    ${g.padEnd(12)} ${tr ? tr.winRate + '%' : '—'} (n${tr ? tr.total : 0}) → ${te ? te.winRate + '%' : '—'} (n${te ? te.total : 0})`);
    });
    console.log(`  VERDICT: ${o.verdict}`);
  }
  const section = (title, obj) => { console.log(`\n${title}`); Object.entries(obj).sort((a, b) => b[1].total - a[1].total).forEach(([k, st]) => console.log(line(k, st))); };
  section('BY GATE  (← the "too strict?" answer)', result.byGate);
  section('BY GRADE', result.byGrade);
  section('BY REGIME', result.byRegime);
  section('BY SESSION', result.bySession);
  section('BY PATTERN', result.byPattern);
  console.log(`\nNote: point-in-time replay; entry=signal-bar close, resolve next bar; AMBIGUOUS≠win; ${cost}p cost deducted.`);
  console.log(`Limitations: news not point-in-time; ADR/DHL omitted; 5000-row DB cap (oldest-first) may truncate low TFs.\n`);
}

run().catch(async (err) => { console.error('Replay failed:', err.message); try { await pool.end(); } catch {} process.exit(1); });
