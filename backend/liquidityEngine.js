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
  const empty = { buySide: [], sellSide: [], targetAbove: null, targetBelow: null, recentSweep: null };
  if (!Array.isArray(candles) || candles.length < 15) return empty;
  const atr = atr14(candles) || 0;
  const tol = atr * equalTolAtr;
  const { highs, lows } = fractalSwings(candles);
  const lastIdx = candles.length - 1;
  const price = n(candles[lastIdx].close);

  // Cluster nearby swing points into one pool (equal highs/lows = stacked liquidity).
  const cluster = (points) => {
    const pools = [];
    for (const p of points) {
      const hit = pools.find((q) => Math.abs(q.price - p.price) <= tol);
      if (hit) {
        hit.price = (hit.price * hit.touches + p.price) / (hit.touches + 1);
        hit.touches += 1;
        hit.lastIdx = Math.max(hit.lastIdx, p.i);
        hit.timeIso = candles[Math.max(hit.lastIdx, p.i)].time;
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

  const buySide = cluster(highs).map((p) => markSwept(p, 'buy')).map((p) => shape(p, 'BSL'))
    .sort((a, b) => a.distance - b.distance);
  const sellSide = cluster(lows).map((p) => markSwept(p, 'sell')).map((p) => shape(p, 'SSL'))
    .sort((a, b) => b.distance - a.distance);

  // Draw on liquidity: nearest UNSWEPT pool above (long target) / below (short target).
  const targetAbove = buySide.filter((p) => !p.swept && p.price > price).sort((a, b) => a.price - b.price)[0] || null;
  const targetBelow = sellSide.filter((p) => !p.swept && p.price < price).sort((a, b) => b.price - a.price)[0] || null;

  // Most recent sweep (either side) — the "liquidity has been taken" confirmation.
  let recentSweep = null;
  for (const p of [...buySide, ...sellSide]) {
    if (p.swept && p.sweptAtMs && (!recentSweep || p.sweptAtMs > recentSweep.sweptAtMs)) recentSweep = p;
  }

  return {
    buySide: buySide.slice(0, maxPerSide),
    sellSide: sellSide.slice(0, maxPerSide),
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
    if (completed.length && Number.isFinite(completed[0].hi)) out.push({ session: sess.key, label: sess.label, hi: completed[0].hi, lo: completed[0].lo });
  }
  return out;
}

export function detectKeyLiquidityLevels(candles, { symbol = '', dailyCandles = null, freshBars = 60 } = {}) {
  if (!Array.isArray(candles) || candles.length < 20) return { price: null, atr: null, levels: [], nearestAbove: null, nearestBelow: null };
  const atr = atr14(candles) || 0;
  const lastIdx = candles.length - 1;
  const price = n(candles[lastIdx].close);
  const nowMs = Date.parse(candles[lastIdx].time) || Date.now();
  const sym = String(symbol).toUpperCase();
  const pip = /JPY/.test(sym) ? 0.01 : /XAU|GOLD|XAG/.test(sym) ? 0.1 : 0.0001;
  const freshFromIdx = Math.max(0, candles.length - freshBars);
  const levels = [];

  // Has price traded THROUGH the level (a wick beyond it) since `fromIdx`? = swept/taken.
  const sweptSince = (lvl, side, fromIdx) => {
    for (let j = Math.max(0, fromIdx); j < candles.length; j++) {
      if (side === 'above' ? n(candles[j].high) >= lvl : n(candles[j].low) <= lvl) return Date.parse(candles[j].time) || null;
    }
    return null;
  };
  const push = (type, label, lvl, strength, formedIdx = freshFromIdx) => {
    if (!Number.isFinite(lvl) || lvl <= 0) return;
    const side = lvl >= price ? 'above' : 'below';
    const sweptAt = sweptSince(lvl, side, formedIdx);
    levels.push({
      type, label, price: r5(lvl), side,
      distance: r5(Math.abs(lvl - price)),
      distancePips: Math.round((Math.abs(lvl - price) / pip) * 10) / 10,
      distanceAtr: atr ? Math.round((Math.abs(lvl - price) / atr) * 100) / 100 : null,
      swept: !!sweptAt, sweptAtMs: sweptAt, fresh: !sweptAt, strength,
    });
  };

  // 1) Previous-day high/low — the PREVIOUS COMPLETED day, not the forming D1. Top-tier obvious
  //    liquidity (every desk watches PDH/PDL) → strength 5 so it wins dedup ties over fractals.
  if (Array.isArray(dailyCandles) && dailyCandles.length >= 2) {
    const prev = dailyCandles[dailyCandles.length - 2];
    push('PDH', 'Prev day high', n(prev.high), 5, 0);
    push('PDL', 'Prev day low', n(prev.low), 5, 0);
  }
  // 2) Session highs/lows (Asian / London / NY) — most recent completed session. Named =
  //    watched → strength 4 (on par with equal highs/lows, above single swings).
  for (const s of sessionHighLows(candles, nowMs)) {
    push(`${s.session}_HIGH`, `${s.label} high`, s.hi, 4);
    push(`${s.session}_LOW`, `${s.label} low`, s.lo, 4);
  }
  // 3) Round numbers near price (per-instrument spacing). Big-figure = stronger.
  const { step, major } = roundStepFor(symbol);
  const range = Math.max(3 * (atr || step), 4 * step);
  if (step > 0) {
    for (let m = Math.floor((price - range) / step); m <= Math.ceil((price + range) / step); m++) {
      const lvl = r5(m * step);
      if (lvl <= 0 || Math.abs(lvl - price) > range) continue;
      const isMajor = Math.abs(lvl / major - Math.round(lvl / major)) < 1e-6;
      push('ROUND_NUMBER', `Round ${lvl}`, lvl, isMajor ? 5 : 3);
    }
  }
  // 4) Equal highs/lows + major swings (equal = stacked = stronger).
  const { highs, lows } = fractalSwings(candles);
  const tol = (atr || 0) * 0.15;
  const clusterSwings = (pts, eqType, swingType, label) => {
    const pools = [];
    for (const p of pts) {
      const hit = pools.find((q) => Math.abs(q.price - p.price) <= tol);
      if (hit) { hit.touches += 1; hit.lastIdx = Math.max(hit.lastIdx, p.i); }
      else pools.push({ price: p.price, touches: 1, lastIdx: p.i });
    }
    for (const q of pools) {
      const equal = q.touches >= 2;
      push(equal ? eqType : swingType, equal ? `${label} (equal ×${q.touches})` : label, q.price, equal ? 4 : 2, q.lastIdx);
    }
  };
  clusterSwings(highs, 'EQUAL_HIGH', 'MAJOR_SWING_HIGH', 'Swing high');
  clusterSwings(lows, 'EQUAL_LOW', 'MAJOR_SWING_LOW', 'Swing low');

  // De-dup near-identical levels on the same side (keep the strongest / most-named), nearest-first.
  levels.sort((a, b) => a.distance - b.distance);
  const dedup = [];
  for (const lv of levels) {
    const near = dedup.find((d) => Math.abs(d.price - lv.price) <= tol && d.side === lv.side);
    if (near) { if (lv.strength > near.strength) { near.type = lv.type; near.label = lv.label; near.strength = lv.strength; } continue; }
    dedup.push(lv);
  }
  const nearestAbove = dedup.filter((l) => l.side === 'above' && !l.swept).sort((a, b) => a.distance - b.distance)[0] || null;
  const nearestBelow = dedup.filter((l) => l.side === 'below' && !l.swept).sort((a, b) => a.distance - b.distance)[0] || null;
  return { price: r5(price), atr: r5(atr), levels: dedup, nearestAbove, nearestBelow };
}

// ─── High-probability sweep grader (the 5-component model) ────────────────────
// A sweep is only worth trading when 5 things line up: (1) HTF context, (2) an OBVIOUS liquidity
// pool was the level swept (PDH/PDL/session/round/equal — not a random swing), (3) a rejection
// candle (long wick + close back inside), (4) displacement (strong move the other way), (5) a
// market-structure shift (close beyond a minor swing in the new direction). Grades the most
// recent qualifying sweep A+→F and returns an actionable signal, or null. Pure.
export function gradeSweep(candles, { symbol = '', dailyCandles = null, h4Trend = null, h1Trend = null, lookback = 12, minRR = 1.8, minGrade = 'B' } = {}) {
  if (!Array.isArray(candles) || candles.length < 40) return null;
  const atr = atr14(candles) || 0;
  if (!(atr > 0)) return null;
  const lastIdx = candles.length - 1;
  const { levels, nearestAbove, nearestBelow } = detectKeyLiquidityLevels(candles, { symbol, dailyCandles });
  const obvious = levels.filter((l) => l.strength >= 3); // named pools only (excludes plain swings)
  const fromIdx = Math.max(2, candles.length - lookback);

  // Most recent sweep: pierced an obvious level's wick but CLOSED back inside.
  let best = null;
  for (let i = fromIdx; i <= lastIdx; i++) {
    const c = candles[i];
    const h = n(c.high), l = n(c.low), o = n(c.open), cl = n(c.close);
    const range = Math.max(h - l, 1e-9);
    for (const lv of obvious) {
      if (h >= lv.price && cl < lv.price && o < lv.price) { // bearish: swept buy-side, closed below → SELL
        const wick = (h - Math.max(o, cl)) / range;
        if (wick >= 0.3 && (!best || i >= best.idx)) best = { idx: i, dir: 'SELL', level: lv, wickRatio: wick };
      }
      if (l <= lv.price && cl > lv.price && o > lv.price) { // bullish: swept sell-side, closed above → BUY
        const wick = (Math.min(o, cl) - l) / range;
        if (wick >= 0.3 && (!best || i >= best.idx)) best = { idx: i, dir: 'BUY', level: lv, wickRatio: wick };
      }
    }
  }
  if (!best) return null;
  const { idx: sweepIdx, dir, level: swept, wickRatio } = best;
  const dirStruct = dir === 'BUY' ? 'BULLISH' : 'BEARISH';

  // (5) Market-structure shift (BOS): close beyond the most recent minor swing in the trade dir.
  const { highs, lows } = fractalSwings(candles);
  let bos = false, bosLevel = null;
  if (dir === 'BUY') {
    const mh = [...highs].filter((s) => s.i <= sweepIdx).pop();
    if (mh) { bosLevel = mh.price; for (let j = sweepIdx + 1; j <= lastIdx; j++) if (n(candles[j].close) > mh.price) { bos = true; break; } }
  } else {
    const ml = [...lows].filter((s) => s.i <= sweepIdx).pop();
    if (ml) { bosLevel = ml.price; for (let j = sweepIdx + 1; j <= lastIdx; j++) if (n(candles[j].close) < ml.price) { bos = true; break; } }
  }
  // (4) Displacement, (1) HTF context.
  const disp = detectDisplacement(candles, sweepIdx, dirStruct, atr);
  const htf = dir === 'BUY'
    ? (h4Trend === 'BULLISH' || h1Trend === 'BULLISH' ? 'aligned' : h4Trend === 'BEARISH' ? 'against' : 'neutral')
    : (h4Trend === 'BEARISH' || h1Trend === 'BEARISH' ? 'aligned' : h4Trend === 'BULLISH' ? 'against' : 'neutral');

  // Score 0-100: obvious pool 30 · structure shift 25 · displacement 20 · rejection 15 · HTF 10.
  const sObvious = Math.round((swept.strength / 5) * 30);
  const sStruct = bos ? 25 : 0;
  const sDisp = disp.present ? (disp.strong ? 20 : 12) : 0;
  const sRej = Math.round(Math.min(1, wickRatio / 0.6) * 15);
  const sHtf = htf === 'aligned' ? 10 : htf === 'neutral' ? 5 : 0;
  const score = sObvious + sStruct + sDisp + sRej + sHtf;
  const grade = score >= 85 ? 'A+' : score >= 72 ? 'A' : score >= 58 ? 'B' : score >= 42 ? 'C' : 'F';
  const gradeRank = { F: 0, C: 1, B: 2, A: 3, 'A+': 4 };

  // Hard discipline: must have swept an obvious pool, rejected, and shifted structure — never
  // enter on the sweep alone; never fight a clear HTF trend.
  if (!bos || sRej === 0 || htf === 'against' || gradeRank[grade] < (gradeRank[minGrade] ?? 2)) return null;

  const sweepC = candles[sweepIdx];
  // Enter at the rejection candle's close (a limit on the retrace), NOT the run-away current
  // price — keeps the stop tight (just beyond the sweep wick) and the RR honest.
  const entry = n(sweepC.close);
  const buffer = atr * 0.15;
  const stopLoss = dir === 'BUY' ? r5(n(sweepC.low) - buffer) : r5(n(sweepC.high) + buffer);
  const risk = Math.abs(entry - stopLoss);
  if (!(risk > 0)) return null;
  const opp = dir === 'BUY' ? (nearestAbove && nearestAbove.fresh ? nearestAbove.price : null) : (nearestBelow && nearestBelow.fresh ? nearestBelow.price : null);
  const tp1 = r5(dir === 'BUY' ? entry + risk : entry - risk);
  const tp2 = r5(dir === 'BUY' ? entry + 2 * risk : entry - 2 * risk);
  const tp3 = opp && (dir === 'BUY' ? opp > entry : opp < entry) ? r5(opp) : r5(dir === 'BUY' ? entry + 3 * risk : entry - 3 * risk);
  const rr = Math.round((Math.abs(tp3 - entry) / risk) * 100) / 100;
  if (rr < minRR) return null;

  return {
    decision: dir, score, grade,
    entry: r5(entry), stopLoss, takeProfit1: tp1, takeProfit2: tp2, takeProfit3: tp3, riskRewardRatio: rr,
    reason: `${dir} sweep of ${swept.label} → rejection + BOS${disp.present ? ' + displacement' : ''} (${htf} HTF); target ${opp ? 'opposing liquidity' : `${Math.round(rr)}R`}`,
    barIso: sweepC.time,
    meta: {
      sweptLevel: { type: swept.type, price: swept.price, strength: swept.strength },
      components: { htfContext: htf, obviousPool: swept.strength, rejectionPct: Math.round(wickRatio * 100), displacement: disp.present, displacementStrong: disp.strong, structureShift: bos },
      checklist: [
        `Swept OBVIOUS pool: ${swept.label} (str ${swept.strength}/5)`,
        `Rejection ${Math.round(wickRatio * 100)}% wick, closed back inside`,
        disp.present ? `Displacement ${disp.atrMultiple}×ATR${disp.strong ? ' strong' : ''}` : 'No displacement',
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
  if (!atr || atr <= 0 || !Number.isFinite(reclaimIdx)) return { present: false, atrMultiple: 0 };
  const lo = Math.max(2, reclaimIdx - 1);
  const hi = Math.min(candles.length - 1, reclaimIdx + 2);
  let best = null;
  for (let i = lo; i <= hi; i++) {
    const c = candles[i], c2 = candles[i - 1], c3 = candles[i - 2];
    const bullFvg = n(c.low) > n(c3.high) && n(c2.close) > n(c2.open);
    const bearFvg = n(c.high) < n(c3.low) && n(c2.close) < n(c2.open);
    if (dir === 'BULLISH' ? !bullFvg : !bearFvg) continue;
    const mult = Math.abs(n(c2.close) - n(c2.open)) / atr;
    const gapLow = dir === 'BULLISH' ? n(c3.high) : n(c.high);
    const gapHigh = dir === 'BULLISH' ? n(c.low) : n(c3.low);
    if (!best || mult > best.mult) best = { mult, gapLow, gapHigh };
  }
  if (!best) return { present: false, atrMultiple: 0 };
  return {
    present: best.mult >= minAtr,
    strong: best.mult >= strongAtr,
    atrMultiple: Math.round(best.mult * 100) / 100,
    gapLow: r5(Math.min(best.gapLow, best.gapHigh)),
    gapHigh: r5(Math.max(best.gapLow, best.gapHigh)),
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

  // BULLISH: swing low → swept (lower low) → close back above the prior swing high.
  let bull = null;
  for (let k = lows.length - 1; k >= 0; k--) {
    const low = lows[k];
    if (lastIdx - low.i > maxAgeBars) break;
    const priorHigh = [...highs].reverse().find((h) => h.i < low.i);
    if (!priorHigh) continue;
    let sweepIdx = -1, sweepLow = low.price;
    for (let j = low.i + 1; j < candles.length; j++) {
      if (n(candles[j].low) < sweepLow) { sweepIdx = j; sweepLow = n(candles[j].low); }
    }
    if (sweepIdx === -1) continue;
    let reclaimIdx = -1;
    for (let j = sweepIdx + 1; j < candles.length; j++) {
      if (n(candles[j].close) > priorHigh.price) { reclaimIdx = j; break; }
    }
    if (reclaimIdx === -1) continue;
    let obIdx = -1;
    for (let j = reclaimIdx - 1; j >= sweepIdx; j--) {
      if (n(candles[j].close) < n(candles[j].open)) { obIdx = j; break; }
    }
    if (obIdx === -1) obIdx = sweepIdx;
    const z = zoneOf(obIdx);
    bull = {
      type: 'BULLISH', ...z,
      entry: z.zoneTop, stop: r5(sweepLow), sweepLevel: r5(sweepLow), structureLevel: r5(priorHigh.price),
      confirmedIso: candles[reclaimIdx].time, ageBars: lastIdx - reclaimIdx, reclaimIdx,
      displacement: detectDisplacement(candles, reclaimIdx, 'BULLISH', atr),
    };
    break;
  }

  // BEARISH: swing high → swept (higher high) → close back below the prior swing low.
  let bear = null;
  for (let k = highs.length - 1; k >= 0; k--) {
    const high = highs[k];
    if (lastIdx - high.i > maxAgeBars) break;
    const priorLow = [...lows].reverse().find((l) => l.i < high.i);
    if (!priorLow) continue;
    let sweepIdx = -1, sweepHigh = high.price;
    for (let j = high.i + 1; j < candles.length; j++) {
      if (n(candles[j].high) > sweepHigh) { sweepIdx = j; sweepHigh = n(candles[j].high); }
    }
    if (sweepIdx === -1) continue;
    let reclaimIdx = -1;
    for (let j = sweepIdx + 1; j < candles.length; j++) {
      if (n(candles[j].close) < priorLow.price) { reclaimIdx = j; break; }
    }
    if (reclaimIdx === -1) continue;
    let obIdx = -1;
    for (let j = reclaimIdx - 1; j >= sweepIdx; j--) {
      if (n(candles[j].close) > n(candles[j].open)) { obIdx = j; break; }
    }
    if (obIdx === -1) obIdx = sweepIdx;
    const z = zoneOf(obIdx);
    bear = {
      type: 'BEARISH', ...z,
      entry: z.zoneBottom, stop: r5(sweepHigh), sweepLevel: r5(sweepHigh), structureLevel: r5(priorLow.price),
      confirmedIso: candles[reclaimIdx].time, ageBars: lastIdx - reclaimIdx, reclaimIdx,
      displacement: detectDisplacement(candles, reclaimIdx, 'BEARISH', atr),
    };
    break;
  }

  if (bull && bear) return bull.reclaimIdx >= bear.reclaimIdx ? bull : bear;
  return bull || bear || null;
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
  let inside = true;
  for (let k = 0; k < probe.length; k++) {
    const c = probe[k];
    const wickBeyond = dir === 'BULLISH' ? n(c.high) > edge : n(c.low) < edge;
    const closeBeyond = dir === 'BULLISH' ? n(c.close) > edge : n(c.close) < edge;
    if (inside && wickBeyond) {
      drives.push({ kind: closeBeyond ? 'CLOSED' : 'FAILED', iso: c.time, idx: absBase + k });
      inside = !closeBeyond; // closed beyond → now outside; failed wick → still inside
    } else if (!inside && !wickBeyond) {
      inside = true; // pulled fully back inside → a new drive can be counted
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
export function buildLiquidityPlan(breaker, pools) {
  if (!breaker || !pools) return null;
  const targetPool = breaker.type === 'BULLISH' ? pools.targetAbove : pools.targetBelow;
  if (!targetPool) return null;
  const entry = breaker.entry, stop = breaker.stop, target = targetPool.price;
  const risk = Math.abs(entry - stop);
  const reward = breaker.type === 'BULLISH' ? target - entry : entry - target;
  if (!(risk > 0) || !(reward > 0)) return null;
  return {
    direction: breaker.type === 'BULLISH' ? 'BUY' : 'SELL',
    entry: r5(entry), stop: r5(stop), target: r5(target),
    targetType: targetPool.type, targetEqual: targetPool.equal,
    rr: Math.round((reward / risk) * 100) / 100,
    displacement: breaker.displacement || { present: false, atrMultiple: 0 },
  };
}
