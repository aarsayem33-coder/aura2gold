// liquidityEngine.js — pure, deterministic helpers for the Day Trading Desk.
//
// Encodes the two ideas BOTH podcast traders converge on:
//   1) Liquidity-pool targeting — resting liquidity sits at swing highs (buy-side,
//      BSL) and swing lows (sell-side, SSL); equal highs/lows stack it. The market
//      is "drawn" to unswept pools, so they make the highest-logic TARGETS. A pool
//      is "swept" once a later candle's wick trades through it.
//   2) Breaker detection — a failed order block that flips: price sweeps a swing
//      low (engineered liquidity), then RECLAIMS by closing back above the prior
//      swing high → bullish breaker (entry zone + stop below the sweep). Mirror for
//      bearish. This is Maine's favoured entry and Marco's "trade after the sweep".
//
// Pure: no I/O, no live signal-logic coupling. Safe to unit-test and reuse.

function n(v) { return Number(v); }
function r5(v) { return Math.round(v * 1e5) / 1e5; }

// Wilder ATR(14) — tolerance unit for clustering equal levels.
export function atr14(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = n(candles[i].high), l = n(candles[i].low), pc = n(candles[i - 1].close);
    if ([h, l, pc].some((x) => !Number.isFinite(x))) continue;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length < period) return null;
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

// Fractal swing points (2 bars each side) — the structure both traders read.
export function fractalSwings(candles) {
  const highs = [], lows = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const h = n(candles[i].high), l = n(candles[i].low);
    if (!Number.isFinite(h) || !Number.isFinite(l)) continue;
    if (h > n(candles[i - 1].high) && h > n(candles[i - 2].high) && h > n(candles[i + 1].high) && h > n(candles[i + 2].high)) {
      highs.push({ i, price: h, time: candles[i].time });
    }
    if (l < n(candles[i - 1].low) && l < n(candles[i - 2].low) && l < n(candles[i + 1].low) && l < n(candles[i + 2].low)) {
      lows.push({ i, price: l, time: candles[i].time });
    }
  }
  return { highs, lows };
}

// Resting liquidity pools, with equal-level clustering, swept flag, and the
// nearest unswept target each side (the "draw on liquidity").
export function detectLiquidityPools(candles, { equalTolAtr = 0.15, maxPerSide = 6 } = {}) {
  const empty = { buySide: [], sellSide: [], targetCandidatesAbove: [], targetCandidatesBelow: [], targetAbove: null, targetBelow: null, recentSweep: null };
  if (!Array.isArray(candles) || candles.length < 15) return empty;
  const atr = atr14(candles) || 0;
  const tol = atr * equalTolAtr;
  const { highs, lows } = fractalSwings(candles);
  const lastIdx = candles.length - 1;
  const price = n(candles[lastIdx].close);

  // Cluster nearby swing points into one pool (equal highs/lows = stacked liquidity).
  const cluster = (points, side) => {
    const pools = [];
    for (const p of points) {
      const hit = pools.find((q) => Math.abs(q.price - p.price) <= tol);
      if (hit) {
        hit.price = side === 'buy' ? Math.max(hit.price, p.price) : Math.min(hit.price, p.price);
        hit.touches += 1;
        if (p.i > hit.lastIdx) {
          hit.lastIdx = p.i;
          hit.timeIso = p.time;
        }
      } else {
        pools.push({ price: p.price, touches: 1, lastIdx: p.i, timeIso: p.time });
      }
    }
    return pools;
  };

  const markSwept = (pool, side) => {
    for (let j = pool.lastIdx + 1; j < candles.length; j++) {
      const through = side === 'buy' ? n(candles[j].high) > pool.price : n(candles[j].low) < pool.price;
      if (through) return { ...pool, swept: true, sweptAtMs: Date.parse(candles[j].time) };
    }
    return { ...pool, swept: false, sweptAtMs: null };
  };

  const shape = (p, type) => ({
    price: r5(p.price),
    type,                                   // 'BSL' (above) | 'SSL' (below)
    touches: p.touches,                     // equal-level stack strength
    equal: p.touches >= 2,
    swept: p.swept,
    sweptAtMs: p.sweptAtMs,
    timeIso: p.timeIso,
    distance: r5(p.price - price),
  });

  const allBuySide = cluster(highs, 'buy').map((p) => markSwept(p, 'buy')).map((p) => shape(p, 'BSL'))
    .sort((a, b) => a.distance - b.distance);
  const allSellSide = cluster(lows, 'sell').map((p) => markSwept(p, 'sell')).map((p) => shape(p, 'SSL'))
    .sort((a, b) => b.distance - a.distance);

  // Full actionable lists are uncapped so target selection cannot lose a farther
  // valid pool merely because the UI only needs a short display list.
  const targetCandidatesAbove = allBuySide.filter((p) => !p.swept && p.price > price).sort((a, b) => a.price - b.price);
  const targetCandidatesBelow = allSellSide.filter((p) => !p.swept && p.price < price).sort((a, b) => b.price - a.price);
  const targetAbove = targetCandidatesAbove[0] || null;
  const targetBelow = targetCandidatesBelow[0] || null;

  // Most recent sweep (either side) — the "liquidity has been taken" confirmation.
  let recentSweep = null;
  for (const p of [...allBuySide, ...allSellSide]) {
    if (p.swept && p.sweptAtMs && (!recentSweep || p.sweptAtMs > recentSweep.sweptAtMs)) recentSweep = p;
  }

  return {
    buySide: allBuySide.slice(0, maxPerSide),
    sellSide: allSellSide.slice(0, maxPerSide),
    targetCandidatesAbove,
    targetCandidatesBelow,
    targetAbove,
    targetBelow,
    recentSweep,
  };
}

// ─── Key institutional liquidity levels (the "obvious" pools traders watch) ───
// Beyond fractal equal-highs/lows, the strongest liquidity sits at NAMED levels: previous-day
// high/low, session highs/lows (Asian / London / NY), psychological round numbers, and major
// swings. The MORE OBVIOUS the level, the more stops rest there, so a sweep of it is higher
// probability. Returns one typed, scored list. Pure.
// strength scale (obviousness): 5 = big-figure round number · 4 = PDH/PDL or equal highs/lows
// · 3 = session high/low or minor round number · 2 = single major swing.

// Round-number step per instrument (psychological levels differ by market).
export function roundStepFor(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (/XAU|GOLD/.test(s)) return { step: 10, major: 50 };        // 2300, 2350
  if (/XAG|SILVER/.test(s)) return { step: 0.5, major: 1 };
  if (/BTC/.test(s)) return { step: 500, major: 1000 };
  if (/ETH/.test(s)) return { step: 50, major: 100 };
  if (/JPY/.test(s)) return { step: 0.5, major: 1 };             // 150.00, 150.50
  if (/US30|NAS|SPX|GER|UK100|JP225|DJI|NDX|USTEC|US100|US500/.test(s)) return { step: 50, major: 100 };
  return { step: 0.0050, major: 0.0100 };                        // 5-digit FX: 50-pip halves + big figures
}

// UTC session windows the tutorial names. Hours are [start, end). London/NY overlap on purpose.
const KEY_SESSIONS = [
  { key: 'ASIAN', label: 'Asian', startH: 0, endH: 8 },
  { key: 'LONDON', label: 'London', startH: 7, endH: 16 },
  { key: 'NY', label: 'New York', startH: 12, endH: 21 },
];

// Most recent COMPLETED session's high/low for each window (session end is in the past).
function sessionHighLows(candles, nowMs) {
  const out = [];
  for (const sess of KEY_SESSIONS) {
    const byDay = new Map();
    for (const c of candles) {
      const t = Date.parse(c.time); if (!Number.isFinite(t)) continue;
      const d = new Date(t); const h = d.getUTCHours();
      if (h < sess.startH || h >= sess.endH) continue;
      const dayKey = d.toISOString().slice(0, 10);
      const endMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), sess.endH);
      const rec = byDay.get(dayKey) || { hi: -Infinity, lo: Infinity, endMs };
      rec.hi = Math.max(rec.hi, n(c.high)); rec.lo = Math.min(rec.lo, n(c.low));
      byDay.set(dayKey, rec);
    }
    const completed = [...byDay.values()].filter((r) => r.endMs <= nowMs).sort((a, b) => b.endMs - a.endMs);
    if (completed.length && Number.isFinite(completed[0].hi)) out.push({ session: sess.key, label: sess.label, hi: completed[0].hi, lo: completed[0].lo, endMs: completed[0].endMs });
  }
  return out;
}

export function detectKeyLiquidityLevels(candles, { symbol = '', dailyCandles = null, freshBars = 60 } = {}) {
  if (!Array.isArray(candles) || candles.length < 20) return { price: null, atr: null, levels: [], targetCandidatesAbove: [], targetCandidatesBelow: [], nearestAbove: null, nearestBelow: null };
  const atr = atr14(candles) || 0;
  const lastIdx = candles.length - 1;
  const price = n(candles[lastIdx].close);
  const nowMs = Date.parse(candles[lastIdx].time) || Date.now();
  const sym = String(symbol).toUpperCase();
  const pip = /JPY/.test(sym) ? 0.01 : /XAU|GOLD|XAG/.test(sym) ? 0.1 : 0.0001;
  const freshFromIdx = Math.max(0, candles.length - freshBars);
  const levels = [];

  // Has price traded THROUGH the level (a wick strictly beyond it) since `fromIdx`?
  // = swept/taken. PROVENANCE MATTERS: `fromIdx` must be the first candle that can
  // legitimately provide sweep evidence — strictly AFTER the level formed. Scanning
  // from the formation candle itself (with inclusive >=) made every swing/session
  // level mark ITSELF swept, and PDH/PDL scanned from index 0 were "swept" by
  // yesterday's own candles — 12–14 of 14 levels read SWEPT on live audits, starving
  // every fresh-level target picker into R-multiple fallbacks.
  const sweptSince = (lvl, semanticSide, formedIdx) => {
    for (let j = Math.max(0, formedIdx + 1); j < candles.length; j++) {
      if (semanticSide === 'above' ? n(candles[j].high) > lvl : n(candles[j].low) < lvl) return Date.parse(candles[j].time) || null;
    }
    return null;
  };
  // Last candle strictly before `ms`; the next bar is the first legal evidence.
  const idxBeforeMs = (ms) => {
    if (!Number.isFinite(ms)) return freshFromIdx - 1;
    let idx = -1;
    for (let j = 0; j < candles.length; j++) {
      if ((Date.parse(candles[j].time) || 0) >= ms) break;
      idx = j;
    }
    return idx;
  };
  const push = (type, label, lvl, strength, semanticSide, formedIdx = freshFromIdx - 1) => {
    if (!Number.isFinite(lvl) || lvl <= 0) return;
    const side = semanticSide || (lvl >= price ? 'above' : 'below');
    const sweptAt = sweptSince(lvl, side, formedIdx);
    levels.push({
      type, label, price: r5(lvl), side,
      distance: r5(Math.abs(lvl - price)),
      distancePips: Math.round((Math.abs(lvl - price) / pip) * 10) / 10,
      distanceAtr: atr ? Math.round((Math.abs(lvl - price) / atr) * 100) / 100 : null,
      swept: !!sweptAt, sweptAtMs: sweptAt, fresh: !sweptAt, strength, formedIdx,
    });
  };

  // 1) Previous-day high/low — the PREVIOUS COMPLETED day, not the forming D1. Top-tier obvious
  //    liquidity (every desk watches PDH/PDL) → strength 5 so it wins dedup ties over fractals.
  if (Array.isArray(dailyCandles) && dailyCandles.length >= 2) {
    const prev = dailyCandles[dailyCandles.length - 2];
    // Sweep evidence for PDH/PDL starts at TODAY's open (the forming D1's open time) —
    // yesterday's own candles touched yesterday's high by definition and prove nothing.
    const formedIdx = idxBeforeMs(Date.parse(dailyCandles[dailyCandles.length - 1].time));
    push('PDH', 'Prev day high', n(prev.high), 5, 'above', formedIdx);
    push('PDL', 'Prev day low', n(prev.low), 5, 'below', formedIdx);
  }
  // 2) Session highs/lows (Asian / London / NY) — most recent completed session. Named =
  //    watched → strength 4 (on par with equal highs/lows, above single swings).
  //    Sweep evidence starts after the session ENDED — in-session candles made the level.
  for (const s of sessionHighLows(candles, nowMs)) {
    const formedIdx = idxBeforeMs(s.endMs);
    push(`${s.session}_HIGH`, `${s.label} high`, s.hi, 4, 'above', formedIdx);
    push(`${s.session}_LOW`, `${s.label} low`, s.lo, 4, 'below', formedIdx);
  }
  // 3) Round numbers near price (per-instrument spacing). Big-figure = stronger.
  const { step, major } = roundStepFor(symbol);
  const range = Math.max(3 * (atr || step), 4 * step);
  if (step > 0) {
    for (let m = Math.floor((price - range) / step); m <= Math.ceil((price + range) / step); m++) {
      const lvl = r5(m * step);
      if (lvl <= 0 || Math.abs(lvl - price) > range) continue;
      const isMajor = Math.abs(lvl / major - Math.round(lvl / major)) < 1e-6;
      push('ROUND_NUMBER', `Round ${lvl}`, lvl, isMajor ? 5 : 3, lvl >= price ? 'above' : 'below');
    }
  }
  // 4) Equal highs/lows + major swings (equal = stacked = stronger).
  const { highs, lows } = fractalSwings(candles);
  const tol = (atr || 0) * 0.15;
  const clusterSwings = (pts, eqType, swingType, label, isHigh) => {
    const pools = [];
    for (const p of pts) {
      const hit = pools.find((q) => Math.abs(q.price - p.price) <= tol);
      // The pool's level is the EXTREME of its touches (stops rest beyond the highest
      // of the equal highs) — otherwise a later, slightly-higher touch would count as
      // trading "through" the first-touch price and self-sweep the cluster.
      if (hit) { hit.touches += 1; hit.lastIdx = Math.max(hit.lastIdx, p.i); hit.price = isHigh ? Math.max(hit.price, p.price) : Math.min(hit.price, p.price); }
      else pools.push({ price: p.price, touches: 1, lastIdx: p.i });
    }
    for (const q of pools) {
      const equal = q.touches >= 2;
      // Sweep evidence starts strictly AFTER the last touch that formed the level.
      push(equal ? eqType : swingType, equal ? `${label} (equal ×${q.touches})` : label, q.price, equal ? 4 : 2, isHigh ? 'above' : 'below', q.lastIdx);
    }
  };
  clusterSwings(highs, 'EQUAL_HIGH', 'MAJOR_SWING_HIGH', 'Swing high', true);
  clusterSwings(lows, 'EQUAL_LOW', 'MAJOR_SWING_LOW', 'Swing low', false);

  // De-dup near-identical levels on the same semantic side. Replace the whole
  // record when a better canonical source wins; mixing a PDH label into a swing's
  // stale formation/sweep metadata creates a level that never actually existed.
  levels.sort((a, b) => a.distance - b.distance);
  const dedup = [];
  const typePriority = (type) => /^(PDH|PDL)$/.test(type) ? 5 : /^(ASIAN|LONDON|NY)_/.test(type) ? 4 : /^EQUAL_/.test(type) ? 3 : type === 'ROUND_NUMBER' ? 2 : 1;
  const betterCanonical = (a, b) => a.strength !== b.strength
    ? a.strength > b.strength
    : typePriority(a.type) !== typePriority(b.type)
      ? typePriority(a.type) > typePriority(b.type)
      : a.formedIdx !== b.formedIdx
        ? a.formedIdx > b.formedIdx
        : a.type.localeCompare(b.type) < 0;
  for (const lv of levels) {
    const nearIdx = dedup.findIndex((d) => Math.abs(d.price - lv.price) <= tol && d.side === lv.side);
    if (nearIdx >= 0) {
      if (betterCanonical(lv, dedup[nearIdx])) dedup[nearIdx] = lv;
      continue;
    }
    dedup.push(lv);
  }
  const targetCandidatesAbove = dedup.filter((l) => l.side === 'above' && !l.swept && l.price > price).sort((a, b) => a.price - b.price);
  const targetCandidatesBelow = dedup.filter((l) => l.side === 'below' && !l.swept && l.price < price).sort((a, b) => b.price - a.price);
  const nearestAbove = targetCandidatesAbove[0] || null;
  const nearestBelow = targetCandidatesBelow[0] || null;
  return { price: r5(price), atr: r5(atr), levels: dedup, targetCandidatesAbove, targetCandidatesBelow, nearestAbove, nearestBelow };
}

// ─── High-probability sweep grader (the 5-component model) ────────────────────
// A sweep is only worth trading when 5 things line up: (1) HTF context, (2) an OBVIOUS liquidity
// pool was the level swept (PDH/PDL/session/round/equal — not a random swing), (3) a rejection
// candle (long wick + close back inside), (4) displacement (strong move the other way), (5) a
// market-structure shift (close beyond a minor swing in the new direction). Grades the most
// recent qualifying sweep A+→F and returns an actionable signal, or null. Pure.
export function gradeSweep(candles, { symbol = '', dailyCandles = null, h4Trend = null, h1Trend = null, lookback = 12, minRR = 1.8, minGrade = 'B', maxConfirmationAgeBars = 0 } = {}) {
  if (!Array.isArray(candles) || candles.length < 40) return null;
  const atr = atr14(candles) || 0;
  if (!(atr > 0)) return null;
  const lastIdx = candles.length - 1;
  const { levels } = detectKeyLiquidityLevels(candles, { symbol, dailyCandles });
  const obvious = levels.filter((l) => l.strength >= 3); // named pools only (excludes plain swings)
  const fromIdx = Math.max(2, candles.length - lookback);

  const levelSideOk = (level, dir) => {
    const t = String(level.type || '').toUpperCase();
    if (t === 'ROUND_NUMBER') return true; // side-neutral; raid/target geometry supplies polarity
    const semanticSide = dir === 'SELL' ? 'above' : 'below';
    if (level.side !== semanticSide) return false;
    return dir === 'SELL' ? (t === 'PDH' || /HIGH$/.test(t)) : (t === 'PDL' || /LOW$/.test(t));
  };

  // Collect every chronological, semantically compatible raid. A level cannot be
  // swept before it exists, and equality is a touch, not a stop-taking pierce.
  const raids = [];
  for (let i = fromIdx; i <= lastIdx; i++) {
    const c = candles[i];
    const h = n(c.high), l = n(c.low), o = n(c.open), cl = n(c.close);
    const range = Math.max(h - l, 1e-9);
    for (const lv of obvious) {
      if (i <= lv.formedIdx) continue;
      // A liquidity pool is consumed by its first strict pierce. Do not reuse a
      // level that traded through earlier and happened to reject again later.
      let previouslyConsumed = false;
      for (let j = Math.max(0, lv.formedIdx + 1); j < i; j++) {
        if (lv.side === 'above' ? n(candles[j].high) > lv.price : n(candles[j].low) < lv.price) {
          previouslyConsumed = true;
          break;
        }
      }
      if (previouslyConsumed) continue;
      if (levelSideOk(lv, 'SELL') && h > lv.price && cl < lv.price && o < lv.price) {
        const wick = (h - Math.max(o, cl)) / range;
        if (wick >= 0.3) raids.push({ idx: i, dir: 'SELL', level: lv, wickRatio: wick });
      }
      if (levelSideOk(lv, 'BUY') && l < lv.price && cl > lv.price && o > lv.price) {
        const wick = (Math.min(o, cl) - l) / range;
        if (wick >= 0.3) raids.push({ idx: i, dir: 'BUY', level: lv, wickRatio: wick });
      }
    }
  }
  if (!raids.length) return null;

  const { highs, lows } = fractalSwings(candles);
  const gradeRank = { F: 0, C: 1, B: 2, A: 3, 'A+': 4 };
  const candidates = [];

  for (const raid of raids) {
    const { idx: sweepIdx, dir, level: swept, wickRatio } = raid;
    const structSwing = dir === 'BUY'
      ? [...highs].filter((s) => s.i + 2 <= sweepIdx).pop()
      : [...lows].filter((s) => s.i + 2 <= sweepIdx).pop();
    if (!structSwing) continue;
    let bosIdx = -1;
    for (let j = sweepIdx + 1; j <= lastIdx; j++) {
      if (dir === 'BUY' ? n(candles[j].close) > structSwing.price : n(candles[j].close) < structSwing.price) { bosIdx = j; break; }
    }
    if (bosIdx < 0) continue;

    const dirStruct = dir === 'BUY' ? 'BULLISH' : 'BEARISH';
    const disp = detectDisplacement(candles, sweepIdx, dirStruct, atr);
    if (!disp.present || !Number.isInteger(disp.index)) continue; // displacement is a hard gate

    // A clear H4 conflict always wins over H1 agreement.
    const htf = dir === 'BUY'
      ? (h4Trend === 'BEARISH' ? 'against' : (h4Trend === 'BULLISH' || h1Trend === 'BULLISH') ? 'aligned' : 'neutral')
      : (h4Trend === 'BULLISH' ? 'against' : (h4Trend === 'BEARISH' || h1Trend === 'BEARISH') ? 'aligned' : 'neutral');
    if (htf === 'against') continue;

    const confirmationIdx = Math.max(bosIdx, disp.index);
    if (lastIdx - confirmationIdx > Math.max(0, Number(maxConfirmationAgeBars) || 0)) continue;
    const entry = n(candles[confirmationIdx].close);
    const buffer = atr * 0.15;
    const stopLossRaw = dir === 'BUY' ? n(candles[sweepIdx].low) - buffer : n(candles[sweepIdx].high) + buffer;
    const risk = dir === 'BUY' ? entry - stopLossRaw : stopLossRaw - entry;
    if (!(risk > 0)) continue;

    // Pick a real opposing pool that was known and unswept at confirmation. This
    // preserves replay chronology and allows a farther valid pool when the nearest
    // one cannot meet the requested R:R floor.
    const targetLevels = levels
      .filter((l) => levelSideOk(l, dir === 'BUY' ? 'SELL' : 'BUY') && l.formedIdx < confirmationIdx && (dir === 'BUY' ? l.price > entry : l.price < entry))
      .filter((l) => {
        for (let j = Math.max(0, l.formedIdx + 1); j <= confirmationIdx; j++) {
          if (dir === 'BUY' ? n(candles[j].high) > l.price : n(candles[j].low) < l.price) return false;
        }
        return true;
      })
      .sort((a, b) => dir === 'BUY' ? a.price - b.price : b.price - a.price);
    const target = targetLevels.find((l) => {
      const reward = dir === 'BUY' ? l.price - entry : entry - l.price;
      return reward / risk >= minRR;
    });
    if (!target) continue;

    // Keep an already-confirmed setup visible only while its path remains open.
    // Notification/DB identities stay anchored to confirmationIdx, so repeated
    // evaluation does not create new alerts; completed or stopped setups disappear.
    let completed = false;
    for (let j = confirmationIdx + 1; j <= lastIdx; j++) {
      const hitStop = dir === 'BUY' ? n(candles[j].low) <= stopLossRaw : n(candles[j].high) >= stopLossRaw;
      const hitTarget = dir === 'BUY' ? n(candles[j].high) >= target.price : n(candles[j].low) <= target.price;
      if (hitStop || hitTarget) { completed = true; break; }
    }
    if (completed) continue;

    const rawRR = Math.abs(target.price - entry) / risk;
    if (!(rawRR >= minRR)) continue;
    const sObvious = Math.round((swept.strength / 5) * 30);
    const sDisp = disp.strong ? 20 : 12;
    const sRej = Math.round(Math.min(1, wickRatio / 0.6) * 15);
    const sHtf = htf === 'aligned' ? 10 : 5;
    const score = sObvious + 25 + sDisp + sRej + sHtf;
    const grade = score >= 85 ? 'A+' : score >= 72 ? 'A' : score >= 58 ? 'B' : score >= 42 ? 'C' : 'F';
    if (gradeRank[grade] < (gradeRank[minGrade] ?? 2)) continue;
    candidates.push({ ...raid, bosLevel: structSwing.price, bosIdx, disp, htf, confirmationIdx, entry, stopLossRaw, risk, target, rawRR, score, grade });
  }
  if (!candidates.length) return null;

  // Stable strongest-first ordering. Recency only breaks equal-quality candidates.
  candidates.sort((a, b) => b.score - a.score
    || b.level.strength - a.level.strength
    || b.wickRatio - a.wickRatio
    || b.idx - a.idx
    || a.level.type.localeCompare(b.level.type)
    || a.level.price - b.level.price);
  const best = candidates[0];
  const { idx: sweepIdx, dir, level: swept, wickRatio, bosLevel, disp, htf, confirmationIdx, entry, stopLossRaw, risk, target, rawRR, score, grade } = best;
  const sign = dir === 'BUY' ? 1 : -1;
  const finalReward = Math.abs(target.price - entry);
  const tp1 = r5(entry + sign * finalReward / 3);
  const tp2 = r5(entry + sign * finalReward * 2 / 3);
  const tp3 = r5(target.price);
  const stopLoss = r5(stopLossRaw);
  const rr = Math.round(rawRR * 100) / 100;
  if (dir === 'BUY' ? !(stopLoss < entry && entry < tp1 && tp1 < tp2 && tp2 < tp3) : !(stopLoss > entry && entry > tp1 && tp1 > tp2 && tp2 > tp3)) return null;

  return {
    decision: dir, score, grade,
    entry: r5(entry), stopLoss, takeProfit1: tp1, takeProfit2: tp2, takeProfit3: tp3, riskRewardRatio: rr,
    reason: `${dir} sweep of ${swept.label} → rejection + BOS + displacement (${htf} HTF); target ${target.label}`,
    barIso: candles[confirmationIdx].time,
    meta: {
      sweptLevel: { type: swept.type, price: swept.price, strength: swept.strength },
      sweepBarIso: candles[sweepIdx].time,
      confirmationIdx,
      targetLevel: { type: target.type, price: target.price, strength: target.strength },
      components: { htfContext: htf, obviousPool: swept.strength, rejectionPct: Math.round(wickRatio * 100), displacement: true, displacementStrong: !!disp.strong, structureShift: true },
      checklist: [
        `Swept OBVIOUS pool: ${swept.label} (str ${swept.strength}/5)`,
        `Rejection ${Math.round(wickRatio * 100)}% wick, closed back inside`,
        `Displacement ${disp.atrMultiple}×ATR${disp.strong ? ' strong' : ''}`,
        `BOS: close ${dir === 'BUY' ? 'above' : 'below'} ${r5(bosLevel)}`,
        `HTF: ${htf}`,
      ],
    },
  };
}

// Displacement = the "institutionally sponsored" confirmation both traders want:
// a strong-bodied candle that opens a fair-value gap in the breaker's direction
// around the reclaim. Returns { present, strong, atrMultiple, gapLow, gapHigh }.
// Without displacement, a reclaim is a weak/limp break (don't trust it).
export function detectDisplacement(candles, reclaimIdx, dir, atr, { minAtr = 0.8, strongAtr = 1.3 } = {}) {
  if (!Array.isArray(candles) || !atr || atr <= 0 || !Number.isInteger(reclaimIdx) || (dir !== 'BULLISH' && dir !== 'BEARISH')) return { present: false, atrMultiple: 0 };
  // CHRONOLOGY: displacement must confirm the event, so the FVG may complete at the
  // reclaim bar or after — never before it (the old `reclaimIdx - 1` start let a gap
  // fully formed BEFORE the reclaim count as its confirmation).
  const lo = Math.max(2, reclaimIdx);
  const hi = Math.min(candles.length - 1, reclaimIdx + 2);
  let best = null;
  for (let i = lo; i <= hi; i++) {
    const c = candles[i], c2 = candles[i - 1], c3 = candles[i - 2];
    const bullFvg = n(c.low) > n(c3.high) && n(c2.close) > n(c2.open);
    const bearFvg = n(c.high) < n(c3.low) && n(c2.close) < n(c2.open);
    if (dir === 'BULLISH' ? !bullFvg : !bearFvg) continue;
    // Still-open check: a gap later traded fully through (price beyond its far edge)
    // is spent — it no longer evidences unfilled institutional interest.
    const edgeLow = dir === 'BULLISH' ? n(c3.high) : n(c.high);
    const edgeHigh = dir === 'BULLISH' ? n(c.low) : n(c3.low);
    const farEdge = dir === 'BULLISH' ? Math.min(edgeLow, edgeHigh) : Math.max(edgeLow, edgeHigh);
    let filled = false;
    for (let j = i + 1; j <= candles.length - 1; j++) {
      if (dir === 'BULLISH' ? n(candles[j].low) <= farEdge : n(candles[j].high) >= farEdge) { filled = true; break; }
    }
    if (filled) continue;
    const mult = Math.abs(n(c2.close) - n(c2.open)) / atr;
    if (!best || mult > best.mult) best = { mult, gapLow: edgeLow, gapHigh: edgeHigh, index: i };
  }
  if (!best) return { present: false, atrMultiple: 0 };
  return {
    present: best.mult >= minAtr,
    strong: best.mult >= strongAtr,
    atrMultiple: Math.round(best.mult * 100) / 100,
    gapLow: r5(Math.min(best.gapLow, best.gapHigh)),
    gapHigh: r5(Math.max(best.gapLow, best.gapHigh)),
    index: best.index,
    barIso: candles[best.index].time,
  };
}

// Most recent breaker (failed OB that flipped). Returns the freshest of the
// bullish/bearish candidates, or null. Pure price action — close-confirmed.
// Each breaker carries a `displacement` confirmation (see detectDisplacement).
export function detectBreaker(candles, { maxAgeBars = 40 } = {}) {
  if (!Array.isArray(candles) || candles.length < 20) return null;
  const { highs, lows } = fractalSwings(candles);
  const lastIdx = candles.length - 1;
  const atr = atr14(candles);

  const zoneOf = (idx) => ({
    zoneTop: r5(Math.max(n(candles[idx].open), n(candles[idx].close))),
    zoneBottom: r5(Math.min(n(candles[idx].open), n(candles[idx].close))),
  });

  const lifecycleOpen = ({ type, reclaimIdx, stop, zoneTop, zoneBottom, target }) => {
    for (let j = reclaimIdx + 1; j <= lastIdx; j++) {
      if (type === 'BULLISH' ? n(candles[j].low) <= stop : n(candles[j].high) >= stop) return false;
      const overlapsZone = n(candles[j].low) <= zoneTop && n(candles[j].high) >= zoneBottom;
      if (overlapsZone) return false;
      if (Number.isFinite(target) && (type === 'BULLISH' ? n(candles[j].high) >= target : n(candles[j].low) <= target)) return false;
    }

    // Only confirmed fractals can establish an opposite structure level. The pure
    // helper treats every supplied bar as data; it never guesses that the last bar
    // is forming or silently drops it.
    const oppositeSwings = type === 'BULLISH' ? lows : highs;
    for (const swing of oppositeSwings.filter((s) => s.i > reclaimIdx)) {
      for (let j = swing.i + 1; j <= lastIdx; j++) {
        if (type === 'BULLISH' ? n(candles[j].close) < swing.price : n(candles[j].close) > swing.price) return false;
      }
    }
    return true;
  };

  const candidates = [];
  // Source swings may be old; breaker age starts when the reclaim confirms.
  for (const low of lows) {
    const priorHigh = [...highs].reverse().find((h) => h.i < low.i);
    if (!priorHigh) continue;
    let sweepIdx = -1, sweepLow = low.price;
    for (let j = low.i + 1; j <= lastIdx; j++) {
      if (n(candles[j].low) < low.price && sweepIdx < 0) sweepIdx = j;
      if (sweepIdx >= 0) sweepLow = Math.min(sweepLow, n(candles[j].low));
      if (sweepIdx >= 0 && n(candles[j].close) > priorHigh.price) {
        const reclaimIdx = j;
        if (lastIdx - reclaimIdx > maxAgeBars) break;
        let obIdx = -1;
        for (let q = reclaimIdx - 1; q >= sweepIdx; q--) {
          if (n(candles[q].close) < n(candles[q].open)) { obIdx = q; break; }
        }
        if (obIdx < 0) obIdx = sweepIdx;
        const zone = zoneOf(obIdx);
        const targetSwing = highs.filter((h) => h.i + 2 <= reclaimIdx && h.price > n(candles[reclaimIdx].close)).sort((a, b) => a.price - b.price)[0];
        const target = targetSwing?.price ?? null;
        if (lifecycleOpen({ type: 'BULLISH', reclaimIdx, stop: sweepLow, ...zone, target })) {
          candidates.push({
            type: 'BULLISH', ...zone,
            entry: zone.zoneTop, stop: r5(sweepLow), sweepLevel: r5(sweepLow), structureLevel: r5(priorHigh.price),
            target: Number.isFinite(target) ? r5(target) : null,
            confirmedIso: candles[reclaimIdx].time, ageBars: lastIdx - reclaimIdx, reclaimIdx,
            displacement: detectDisplacement(candles, reclaimIdx, 'BULLISH', atr),
          });
        }
        break;
      }
    }
  }

  for (const high of highs) {
    const priorLow = [...lows].reverse().find((l) => l.i < high.i);
    if (!priorLow) continue;
    let sweepIdx = -1, sweepHigh = high.price;
    for (let j = high.i + 1; j <= lastIdx; j++) {
      if (n(candles[j].high) > high.price && sweepIdx < 0) sweepIdx = j;
      if (sweepIdx >= 0) sweepHigh = Math.max(sweepHigh, n(candles[j].high));
      if (sweepIdx >= 0 && n(candles[j].close) < priorLow.price) {
        const reclaimIdx = j;
        if (lastIdx - reclaimIdx > maxAgeBars) break;
        let obIdx = -1;
        for (let q = reclaimIdx - 1; q >= sweepIdx; q--) {
          if (n(candles[q].close) > n(candles[q].open)) { obIdx = q; break; }
        }
        if (obIdx < 0) obIdx = sweepIdx;
        const zone = zoneOf(obIdx);
        const targetSwing = lows.filter((l) => l.i + 2 <= reclaimIdx && l.price < n(candles[reclaimIdx].close)).sort((a, b) => b.price - a.price)[0];
        const target = targetSwing?.price ?? null;
        if (lifecycleOpen({ type: 'BEARISH', reclaimIdx, stop: sweepHigh, ...zone, target })) {
          candidates.push({
            type: 'BEARISH', ...zone,
            entry: zone.zoneBottom, stop: r5(sweepHigh), sweepLevel: r5(sweepHigh), structureLevel: r5(priorLow.price),
            target: Number.isFinite(target) ? r5(target) : null,
            confirmedIso: candles[reclaimIdx].time, ageBars: lastIdx - reclaimIdx, reclaimIdx,
            displacement: detectDisplacement(candles, reclaimIdx, 'BEARISH', atr),
          });
        }
        break;
      }
    }
  }

  candidates.sort((a, b) => b.reclaimIdx - a.reclaimIdx || a.type.localeCompare(b.type));
  return candidates[0] || null;
}

// Drive label — advisory ONLY (does not gate any signal). Tells you whether the
// current push beyond the recent range edge is the FIRST drive (fakeout risk —
// Fabio's "never take the first drive") or a SECOND drive (higher quality:
// either after a FAILED first drive = shakeout, or after a RETEST of the edge).
//
//   FIRST_DRIVE  — first close/wick beyond the edge; wait for confirmation.
//   SECOND_DRIVE — price already drove out once (failed or pulled back) and is
//                  driving again → the move you actually want to trade.
//   NONE         — price is inside the range / no active drive in `dir`.
//
// Edge = extreme of the BASE (older portion of the window) so drives are measured
// against a level that formed BEFORE them. Pure price action, close-confirmed.
export function classifyDrive(candles, dir, { lookback = 40, baseBars = 20 } = {}) {
  const none = { label: 'NONE', basis: null, edge: null, drives: 0, firstDriveIdx: null, firstDriveIso: null, note: 'No active drive vs recent range' };
  if (!Array.isArray(candles) || candles.length < lookback) return none;
  if (dir !== 'BULLISH' && dir !== 'BEARISH') return none;

  const recent = candles.slice(-lookback);
  const base = recent.slice(0, baseBars);
  const probe = recent.slice(baseBars);
  if (probe.length < 3) return none;

  const edge = dir === 'BULLISH'
    ? Math.max(...base.map((c) => n(c.high)).filter(Number.isFinite))
    : Math.min(...base.map((c) => n(c.low)).filter(Number.isFinite));
  if (!Number.isFinite(edge)) return none;

  // Walk the probe window. A drive starts when price (inside) wicks beyond the edge.
  // CLOSED beyond = a real drive out; wick-only then back = a FAILED drive (sweep).
  // Price must fully pull back inside before another drive can be counted.
  // `absBase` lets us record each drive's absolute index into `candles`.
  const absBase = candles.length - lookback + baseBars;
  const drives = [];
  let ready = true;
  for (let k = 0; k < probe.length; k++) {
    const c = probe[k];
    const wickBeyond = dir === 'BULLISH' ? n(c.high) > edge : n(c.low) < edge;
    const closeBeyond = dir === 'BULLISH' ? n(c.close) > edge : n(c.close) < edge;
    if (ready && wickBeyond) {
      drives.push({ kind: closeBeyond ? 'CLOSED' : 'FAILED', iso: c.time, idx: absBase + k });
      ready = false;
    } else if (!wickBeyond) {
      // A distinct drive needs a reset bar wholly back inside. Adjacent failed
      // wicks are one continuing probe, not multiple independent attempts.
      ready = true;
    }
  }
  if (drives.length === 0) return { ...none, edge: r5(edge) };

  const last = candles[candles.length - 1];
  const nowBeyond = dir === 'BULLISH' ? n(last.high) > edge : n(last.low) < edge;
  if (!nowBeyond) {
    return { ...none, edge: r5(edge), drives: drives.length, firstDriveIdx: drives[0].idx, firstDriveIso: drives[0].iso, note: 'Price back inside range — no active drive' };
  }

  const count = drives.length;
  const label = count >= 2 ? 'SECOND_DRIVE' : 'FIRST_DRIVE';
  const basis = label === 'SECOND_DRIVE'
    ? (drives[count - 2].kind === 'FAILED' ? 'FAILED_FIRST' : 'RETEST')
    : null;
  return {
    label,
    basis,
    edge: r5(edge),
    drives: count,
    firstDriveIdx: drives[0].idx,
    firstDriveIso: drives[0].iso,
    note: label === 'SECOND_DRIVE'
      ? (basis === 'FAILED_FIRST'
          ? 'Second drive after a failed first (shakeout) — higher quality'
          : 'Second drive after retest of the edge — higher quality')
      : 'First drive out of range — fakeout risk, wait for the second',
  };
}

// Second-drive GATE shape (Spec 1). Thin wrapper over classifyDrive that answers the
// one question the trigger gate needs: is the current push a SECOND drive (tradable)
// rather than the raw first break (fakeout risk)? Reuses the same close-confirmed walk.
//   isSecondDrive — true only when label === 'SECOND_DRIVE'
//   firstDriveIdx — absolute index of the first drive (for reference/replay)
//   basis         — 'FAILED_FIRST' | 'RETEST' | null
// Carries label/note/edge/drives through so the SAME object feeds the advisory badge.
export function detectSecondDrive(candles, dir, opts = {}) {
  const d = classifyDrive(candles, dir, opts);
  return {
    isSecondDrive: d.label === 'SECOND_DRIVE',
    firstDriveIdx: d.firstDriveIdx ?? null,
    basis: d.basis,
    label: d.label,
    note: d.note,
    edge: d.edge,
    drives: d.drives,
  };
}

// Combine a breaker with the opposing liquidity pool to produce a liquidity-targeted
// plan (entry + stop from the breaker, target = the draw on liquidity). RR honest-null
// when geometry is invalid (e.g. target on the wrong side of entry).
export function buildLiquidityPlan(breaker, pools, { minRR = 1.5 } = {}) {
  if (!breaker || !pools) return null;
  if (breaker.type !== 'BULLISH' && breaker.type !== 'BEARISH') return null;
  const bull = breaker.type === 'BULLISH';
  const entry = n(breaker.entry), stop = n(breaker.stop);
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(minRR) || minRR < 0) return null;
  // The stop must sit on the protective side of the ENTRY — Math.abs alone accepted
  // directionally-invalid geometry.
  if (!(bull ? stop < entry : stop > entry)) return null;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  // Candidate targets relative to the breaker ENTRY (not just current price): the
  // nearest unswept pool beyond the entry; when the nearest pool sits inside the
  // entry↔stop geometry or behind the entry, try the next unswept pool out.
  const fullCandidates = bull
    ? (Array.isArray(pools.targetCandidatesAbove) ? pools.targetCandidatesAbove : pools.buySide)
    : (Array.isArray(pools.targetCandidatesBelow) ? pools.targetCandidatesBelow : pools.sellSide);
  if (!Array.isArray(fullCandidates)) return null;
  const candidates = fullCandidates
    .filter((p) => p && p.type === (bull ? 'BSL' : 'SSL') && !p.swept && Number.isFinite(n(p.price)) && (bull ? n(p.price) > entry : n(p.price) < entry))
    .sort((a, b) => (bull ? a.price - b.price : b.price - a.price));
  for (const targetPool of candidates) {
    const target = n(targetPool.price);
    const reward = bull ? target - entry : entry - target;
    if (!(reward > 0)) continue;
    const rawRR = reward / risk;
    if (!(rawRR >= minRR)) continue;               // gate the truth, not a rounded-up display value
    const rr = Math.round(rawRR * 100) / 100;
    return {
      direction: bull ? 'BUY' : 'SELL',
      entry: r5(entry), stop: r5(stop), target: r5(target),
      targetType: targetPool.type, targetEqual: targetPool.equal,
      rr,
      displacement: breaker.displacement || { present: false, atrMultiple: 0 },
    };
  }
  return null;
}
