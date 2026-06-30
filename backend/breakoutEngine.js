// breakoutEngine.js — PURE, additive, ISOLATED graded-breakout detection.
//
// Detects two phases of a breakout on WELL-FORMED ("strongest") charts only:
//   • PRE       — price is compressing into / approaching a strong level in the
//                 trend direction but has NOT yet broken (a "possible breakout").
//   • CONFIRMED — a candle has CLOSED decisively beyond the level (immediate
//                 confirmation), ideally with displacement (institutional body).
//
// "Well-formed chart" = clean directional structure (HH+HL or LH+LL), orderly
// zigzag (alternating swings with real amplitude vs ATR), and a defined,
// multi-touch support/resistance level being tested. Choppy / rangebound charts
// are graded low and never alert.
//
// Every candidate is graded A+ / A / B / C from a deterministic 0-100 score so
// the notification controller can gate email strictly (A+/A/B) while letting
// browser desktop notifications fire generously. C-grade = not worth alerting.
//
// This module is PURE (no I/O, no DB, no email). It reuses the SAME live
// detectors the rest of the system uses — it never touches or blends with
// aggregateSignals / live signal logic.

import { atr14, fractalSwings, detectDisplacement } from './liquidityEngine.js';
import { detectMarketStructure, detectSupportResistance } from './signalEngine.js';

const n = (v) => Number(v);
const r5 = (v) => Math.round(v * 1e5) / 1e5;
const lastN = (arr, k) => arr.slice(Math.max(0, arr.length - k));

// ── Grade mapping (single source of truth, shared shape with STRATEGY_GRADE_RANK) ──
export const BREAKOUT_GRADE_RANK = { C: 0, B: 1, A: 2, 'A+': 3 };

export function gradeFromScore(score) {
  const s = Number(score) || 0;
  if (s >= 85) return 'A+';
  if (s >= 75) return 'A';
  if (s >= 65) return 'B';
  return 'C';
}

// ── Swing helpers ────────────────────────────────────────────────────────────
function mergedSwings(highs, lows) {
  return [
    ...highs.map((s) => ({ ...s, kind: 'H' })),
    ...lows.map((s) => ({ ...s, kind: 'L' })),
  ].sort((a, b) => a.i - b.i);
}

// Average absolute price move between consecutive swing points (leg amplitude).
function avgLegAmplitude(highs, lows) {
  const m = mergedSwings(highs, lows);
  if (m.length < 2) return null;
  let sum = 0;
  let cnt = 0;
  for (let i = 1; i < m.length; i++) {
    sum += Math.abs(m[i].price - m[i - 1].price);
    cnt++;
  }
  return cnt ? sum / cnt : null;
}

// Do swings interleave high/low/high/low (orderly zigzag) rather than stacking?
function swingsAlternate(highs, lows) {
  const m = mergedSwings(highs, lows);
  if (m.length < 3) return false;
  let alt = 0;
  for (let i = 1; i < m.length; i++) if (m[i].kind !== m[i - 1].kind) alt++;
  return alt >= (m.length - 1) * 0.6;
}

// How many consecutive swings keep the trend ordering (HH/HL for UP, LH/LL DOWN).
function countConsecutive(highs, lows, trend) {
  if (trend !== 'UP' && trend !== 'DOWN') return 0;
  const cmp = trend === 'UP' ? (a, b) => a > b : (a, b) => a < b;
  let cH = 0;
  for (let i = highs.length - 1; i > 0; i--) {
    if (cmp(highs[i].price, highs[i - 1].price)) cH++; else break;
  }
  let cL = 0;
  for (let i = lows.length - 1; i > 0; i--) {
    if (cmp(lows[i].price, lows[i - 1].price)) cL++; else break;
  }
  return Math.min(cH, cL) + 1;
}

// ── 1) Chart-quality / structure assessment (the "strongest chart" gate) ──────
// Returns a 0-100 structural score + the detected trend. Pure structure only;
// level strength + displacement are folded in later by buildBreakoutCandidate.
export function assessChartQuality(candles) {
  const empty = { score: 0, trend: 'NONE', reasons: ['insufficient data'], atr: null, swings: { highs: [], lows: [] } };
  if (!Array.isArray(candles) || candles.length < 30) return empty;

  const atr = atr14(candles);
  const { highs, lows } = fractalSwings(candles);
  if (highs.length < 2 || lows.length < 2) return { ...empty, atr, reasons: ['not enough swings'] };

  const rHighs = lastN(highs, 3);
  const rLows = lastN(lows, 3);
  const hh = rHighs[rHighs.length - 1].price > rHighs[rHighs.length - 2].price;
  const lh = rHighs[rHighs.length - 1].price < rHighs[rHighs.length - 2].price;
  const hl = rLows[rLows.length - 1].price > rLows[rLows.length - 2].price;
  const ll = rLows[rLows.length - 1].price < rLows[rLows.length - 2].price;

  let trend = 'NONE';
  if (hh && hl) trend = 'UP';
  else if (lh && ll) trend = 'DOWN';

  const reasons = [];
  let score = 45;

  if (trend === 'UP') { score += 18; reasons.push('higher highs + higher lows'); }
  else if (trend === 'DOWN') { score += 18; reasons.push('lower highs + lower lows'); }
  else { reasons.push('no clean HH/HL or LH/LL structure'); }

  const consec = countConsecutive(highs, lows, trend);
  if (consec >= 3) { score += Math.min(12, (consec - 2) * 4); reasons.push(`${consec} consecutive trend swings`); }

  const amp = avgLegAmplitude(highs, lows);
  if (atr && amp) {
    const ratio = amp / atr;
    if (ratio >= 1.0) { score += 12; reasons.push('clean wide swings'); }
    else if (ratio >= 0.6) { score += 6; reasons.push('moderate swing amplitude'); }
    else { score -= 10; reasons.push('choppy / narrow swings'); }
  }

  if (swingsAlternate(highs, lows)) { score += 6; reasons.push('orderly zigzag'); }
  else { score -= 6; reasons.push('disorderly / overlapping swings'); }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, trend, hh, hl, lh, ll, reasons, atr, swings: { highs, lows } };
}

// Pick the level being tested in the trend direction: nearest strong S/R, else
// the structural swing high/low. Returns { level, strength } or null.
function trendLevel(candles, atr, trend, structure) {
  const sr = detectSupportResistance(candles, atr || 1);
  const close = n(candles[candles.length - 1].close);
  if (trend === 'UP') {
    const res = (sr.resistance || []).filter((z) => z.level > close).sort((a, b) => a.level - b.level)[0];
    if (res) return { level: res.level, strength: res.strength || 1 };
    if (structure.lastSwingHigh) return { level: structure.lastSwingHigh, strength: 1 };
  } else if (trend === 'DOWN') {
    const sup = (sr.support || []).filter((z) => z.level < close).sort((a, b) => b.level - a.level)[0];
    if (sup) return { level: sup.level, strength: sup.strength || 1 };
    if (structure.lastSwingLow) return { level: structure.lastSwingLow, strength: 1 };
  }
  return null;
}

// ── 2) PRE — approaching a level but not yet broken ───────────────────────────
// Price within `approachAtr` * ATR of the trend-direction level, on the correct
// side (not yet closed beyond it).
export function detectApproach(candles, quality, { approachAtr = 0.3 } = {}) {
  if (!quality || quality.trend === 'NONE' || !quality.atr) return null;
  const atr = quality.atr;
  const structure = detectMarketStructure(candles);
  const lvl = trendLevel(candles, atr, quality.trend, structure);
  if (!lvl) return null;

  const close = n(candles[candles.length - 1].close);
  const dir = quality.trend === 'UP' ? 'BUY' : 'SELL';
  const distance = quality.trend === 'UP' ? lvl.level - close : close - lvl.level;
  if (!(distance > 0)) return null;                 // already at/through the level → not a PRE
  const distanceAtr = distance / atr;
  if (distanceAtr > approachAtr) return null;        // too far away yet

  return {
    phase: 'PRE',
    direction: dir,
    level: r5(lvl.level),
    levelStrength: lvl.strength,
    distanceAtr: Math.round(distanceAtr * 100) / 100,
  };
}

// ── 3) CONFIRMED — decisive close beyond the level (immediate) ────────────────
// Confirmation = the latest candle CLOSED beyond the trend-direction level while
// the prior close was on the other side, with a decisive body (>= minBreakBodyAtr
// * ATR). Displacement (FVG) is a quality bonus, not a hard gate.
export function detectConfirmedBreakout(candles, quality, { minBreakBodyAtr = 0.5 } = {}) {
  if (!quality || quality.trend === 'NONE' || !quality.atr) return null;
  const atr = quality.atr;
  const structure = detectMarketStructure(candles);
  const lvl = trendLevel(candles, atr, quality.trend, structure);

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  if (!last || !prev) return null;
  const close = n(last.close);
  const prevClose = n(prev.close);
  const body = Math.abs(close - n(last.open));
  const bodyAtr = body / atr;

  // Level that was just crossed. If trendLevel returned a not-yet-broken level
  // (close still on the near side), fall back to the structural swing the close
  // has just cleared (BOS), so a fresh break is caught the moment it prints.
  let level = lvl ? lvl.level : null;
  let strength = lvl ? lvl.strength : 1;

  let broke = false;
  if (quality.trend === 'UP') {
    const ref = (level !== null && close > level) ? level : structure.lastSwingHigh;
    broke = ref && prevClose <= ref && close > ref;
    if (broke) { level = ref; strength = lvl && lvl.level === ref ? lvl.strength : 1; }
  } else {
    const ref = (level !== null && close < level) ? level : structure.lastSwingLow;
    broke = ref && prevClose >= ref && close < ref;
    if (broke) { level = ref; strength = lvl && lvl.level === ref ? lvl.strength : 1; }
  }
  if (!broke) return null;
  if (!(bodyAtr >= minBreakBodyAtr)) return null;    // reject limp / doji pokes

  const dir = quality.trend === 'UP' ? 'BUY' : 'SELL';
  const displacement = detectDisplacement(
    candles,
    candles.length - 1,
    quality.trend === 'UP' ? 'BULLISH' : 'BEARISH',
    atr,
  );

  return {
    phase: 'CONFIRMED',
    direction: dir,
    level: r5(level),
    levelStrength: strength,
    bodyAtr: Math.round(bodyAtr * 100) / 100,
    displacement,
  };
}

// ── 4) Compose the graded candidate the notification controller consumes ──────
// Prefers CONFIRMED over PRE (a break in progress is more actionable than an
// approach). Returns a fully-graded candidate or null when the chart isn't
// well-formed or nothing is happening at the level.
export function buildBreakoutCandidate({ symbol, timeframe, candles }, opts = {}) {
  const { approachAtr = 0.3, minBreakBodyAtr = 0.5 } = opts;
  if (!Array.isArray(candles) || candles.length < 30) return null;

  const quality = assessChartQuality(candles);
  if (quality.trend === 'NONE') return null;          // not a well-formed directional chart

  const last = candles[candles.length - 1];
  const price = n(last.close);
  const atr = quality.atr;

  const confirmed = detectConfirmedBreakout(candles, quality, { minBreakBodyAtr });
  const approach = confirmed ? null : detectApproach(candles, quality, { approachAtr });
  const ev = confirmed || approach;
  if (!ev) return null;

  // Composite score: structure (60%) + level strength + (confirm: body + displacement / pre: proximity).
  const reasons = [...quality.reasons];
  let score = quality.score * 0.6;

  const levelBonus = Math.min(18, (ev.levelStrength || 1) * 7);
  score += levelBonus;
  if ((ev.levelStrength || 1) >= 2) reasons.push(`multi-touch level (${ev.levelStrength}x)`);

  if (ev.phase === 'CONFIRMED') {
    score += Math.min(12, ev.bodyAtr * 8);
    reasons.push(`decisive break body ${ev.bodyAtr}x ATR`);
    if (ev.displacement && ev.displacement.present) {
      score += ev.displacement.strong ? 12 : 7;
      reasons.push(ev.displacement.strong ? 'strong displacement (institutional)' : 'displacement present');
    }
  } else {
    // PRE: closer to the level = higher readiness.
    const prox = Math.max(0, approachAtr - ev.distanceAtr) / approachAtr; // 0..1
    score += Math.round(prox * 12);
    reasons.push(`approaching level (${ev.distanceAtr}x ATR away)`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade = gradeFromScore(score);

  return {
    symbol,
    timeframe,
    phase: ev.phase,                 // 'PRE' | 'CONFIRMED'
    direction: ev.direction,         // 'BUY' | 'SELL'
    grade,                           // 'A+' | 'A' | 'B' | 'C'
    score,
    trend: quality.trend,            // 'UP' | 'DOWN'
    level: ev.level,
    levelStrength: ev.levelStrength || 1,
    price: r5(price),
    atr: atr ? r5(atr) : null,
    distanceAtr: ev.distanceAtr ?? null,
    bodyAtr: ev.bodyAtr ?? null,
    displacement: ev.displacement || null,
    reasons,
    bar: last.time,                  // dedup key per bar
  };
}

// ── 5) Follow-through tracker ────────────────────────────────────────────────
// Given a CONFIRMED breakout (level, direction, confirm price/time, ATR-at-confirm)
// and the candles since it confirmed, report whether the break EXTENDED or FAILED.
// Pure; no I/O. States (priority order):
//   TARGET_HIT       — extended ≥ targetAtr × ATR beyond the level (measured move)
//   FAILED           — a candle CLOSED back through the level (the break reclaimed)
//   STALLING         — still beyond the level but gave back most of its best extension
//   FOLLOWING_THROUGH— beyond the level and progressing
// Excursions are measured FROM THE LEVEL in the break direction.
export function breakoutFollowThrough(bk, candles, { targetAtr = 2, failBufferAtr = 0.1, stallGiveback = 0.6 } = {}) {
  if (!bk || !Array.isArray(candles) || candles.length < 2) return null;
  const dir = bk.direction === 'SELL' ? 'SELL' : 'BUY';
  const sign = dir === 'BUY' ? 1 : -1;
  const level = n(bk.level);
  const atr = n(bk.atr) > 0 ? n(bk.atr) : (atr14(candles) || 0);
  if (!Number.isFinite(level) || !(atr > 0)) return null;
  const confirmMs = Date.parse(bk.barTime || '') || null;

  // Bars strictly AFTER the confirm candle = the follow-through; fall back to the last bar.
  const follow = confirmMs ? candles.filter((c) => (Date.parse(c.time) || 0) > confirmMs) : [];
  const bars = follow.length ? follow : candles.slice(-1);
  const current = n(candles[candles.length - 1].close);

  let mfe = 0, mae = 0, failed = false;
  for (const c of bars) {
    const fav = sign === 1 ? n(c.high) : n(c.low);   // favorable extreme (extension)
    const adv = sign === 1 ? n(c.low) : n(c.high);    // adverse extreme (pullback)
    mfe = Math.max(mfe, sign * (fav - level));
    mae = Math.min(mae, sign * (adv - level));
    if (sign === 1 ? n(c.close) < level - failBufferAtr * atr : n(c.close) > level + failBufferAtr * atr) failed = true;
  }
  const beyond = sign * (current - level);
  const mfeAtr = mfe / atr, beyondAtr = beyond / atr, maeAtr = mae / atr;
  const reachedTarget = mfeAtr >= targetAtr;

  let state;
  if (reachedTarget) state = 'TARGET_HIT';
  else if (failed) state = 'FAILED';
  else if (beyondAtr <= 0 || beyondAtr < stallGiveback * mfeAtr) state = 'STALLING';
  else state = 'FOLLOWING_THROUGH';

  // Live movement score (0-100) — how healthy the follow-through is RIGHT NOW:
  // reach toward the measured move (40) + how much of the peak it's holding (35) +
  // current standing (15) − a penalty for pulling back below the level (20).
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const retention = mfeAtr > 0 ? clamp01(beyondAtr / mfeAtr) : 0;
  const adverse = Math.max(0, -maeAtr);
  // Pure live-movement health (no outcome override): a break still extending and
  // holding its gain grades high; one that reversed back below the level grades low —
  // even if it had briefly tagged target. Reflects how the move looks RIGHT NOW.
  let liveScore = 40 * clamp01(mfeAtr / targetAtr) + 35 * retention + 15 * clamp01(beyondAtr / targetAtr) - 20 * clamp01(adverse / targetAtr);
  liveScore = Math.round(Math.max(0, Math.min(100, liveScore)));
  const liveGrade = gradeFromScore(liveScore);

  return {
    direction: dir, level: r5(level), confirmPrice: r5(n(bk.price)), currentPrice: r5(current),
    liveScore, liveGrade, retentionPct: Math.round(retention * 100),
    beyond: r5(beyond), beyondAtr: Math.round(beyondAtr * 100) / 100,
    sinceConfirm: r5(sign * (current - n(bk.price))),
    mfe: r5(mfe), mfeAtr: Math.round(mfeAtr * 100) / 100,
    mae: r5(mae), maeAtr: Math.round(maeAtr * 100) / 100,
    targetPrice: r5(level + sign * targetAtr * atr),
    progressPct: Math.max(0, Math.min(100, Math.round((mfeAtr / targetAtr) * 100))),
    state, failed, reachedTarget, barsSince: follow.length, atr: r5(atr),
  };
}
