/**
 * Gold Scalping — Brad Gold's 5-step framework, mechanised.
 *
 * Source: "BEST Gold Scalping Strategy (Beginner to PRO)" (Brad Gold / 1% Club).
 *
 *   1. BIAS      H1 and M15 must agree. Misalignment is explicitly called a low-probability
 *                setup in the source, so it is a hard reject here rather than a score penalty.
 *   2. MAP       Demand zones for longs / supply zones for shorts, worked from the extreme
 *                inward, plus the untouched swing liquidity beyond them.
 *   3. WAIT      Do nothing until price actually MITIGATES a point of interest. The source is
 *                emphatic that entries "in the middle of nowhere" are what kills beginners.
 *   4. TRIGGER   Two models, registered as two strategies so the lab can rank them:
 *                  SWEEP — POI mitigation + liquidity sweep (+ optional confirming candle)
 *                  MSS   — the above, plus a market shift, then a pullback into the zone
 *                          that CAUSED the shift
 *   5. EXIT      The NEAREST opposing swing/POI. The source is explicit that this is a scalp:
 *                "get in fast, get out faster", not a 1:10 runner.
 *
 * DESIGN NOTES THAT ARE NOT OBVIOUS FROM THE TRANSCRIPT
 *
 * - Both variants are MARKET orders. The MSS variant only fires once price has ALREADY
 *   returned into the shift zone, so the alert IS the entry moment. Framing it as a resting
 *   limit would be truer to the video but measurably worse here: the 2026-07-13 experiment
 *   expired 76% of limit entries unfilled, and a replay of 355 signals filled only 30% within
 *   four bars — and those fills were adversely selected (they are the ones that came back to
 *   stop you). Alerting at the moment of return keeps the same entry price without the
 *   fill risk.
 *
 * - There is deliberately NO minimum R:R gate. The source targets the nearest liquidity, so
 *   R:R is often 1-2 by design; a 2R floor would reject the strategy's own logic. R:R is
 *   recorded so expectancy can be measured instead — win rate alone is misleading at low R,
 *   which is exactly how ict-breaker looked healthy at 97% and measured negative.
 *
 * Pure: candles in, decision out. No I/O, no server state, no other strategy touched.
 */

import { fractalSwings, atr14 } from './liquidityEngine.js';

const n = (v) => Number(v);
const r5 = (v) => Math.round(n(v) * 1e5) / 1e5;
const arr = (v) => (Array.isArray(v) ? v : []);

export const GOLD_SCALP_DEFAULTS = {
  swingLookback: 60,        // bars scanned for structure and liquidity
  maxZoneAgeBars: 60,       // a zone older than this is stale structure, not a live POI
  maxZoneAtr: 1.5,          // wider than this is a region, not a level worth pricing an entry at
  sweepLookback: 40,        // how far back a swept swing may have formed
  maxSweepAgeBars: 4,       // the sweep must be RECENT or it is not this setup any more
  requireConfirmCandle: true, // the middle model the source actually used in his live trade
  minConfirmBody: 0.45,     // confirming candle body as a share of its range
  minStopAtr: 0.35,         // reuse of the lab-wide sub-spread stop floor (the RR-106 fix)
  minStopPips: 3,
  minTargetAtr: 0.5,        // below this the target is inside the noise
  requireMss: false,        // the conservative variant sets this
  maxMssPullbackBars: 12,   // how long after the shift a pullback still counts
};

/** Trend from swing structure: HH/HL = BULLISH, LH/LL = BEARISH, otherwise RANGE. */
export function structureTrend(candles, { lookback = 60 } = {}) {
  const cs = arr(candles);
  if (cs.length < 20) return 'RANGE';
  const window = cs.slice(-Math.max(20, lookback));
  const { highs, lows } = fractalSwings(window);
  if (highs.length < 2 || lows.length < 2) return 'RANGE';
  const h1 = highs[highs.length - 1].price, h0 = highs[highs.length - 2].price;
  const l1 = lows[lows.length - 1].price, l0 = lows[lows.length - 2].price;
  if (h1 > h0 && l1 > l0) return 'BULLISH';
  if (h1 < h0 && l1 < l0) return 'BEARISH';
  return 'RANGE';
}

/**
 * Step 1 — do the timeframes agree?
 *
 * `h1Trend` comes from the lab context (a real H1 series). The signal timeframe's own trend is
 * read from its candles. Anything other than a clean match is refused, including RANGE: the
 * source treats "not aligned" and "unclear" the same way, as a reason not to trade.
 */
export function trendsAligned(h1Trend, ltfTrend) {
  const a = String(h1Trend || '').toUpperCase();
  const b = String(ltfTrend || '').toUpperCase();
  if (a !== 'BULLISH' && a !== 'BEARISH') return null;
  if (a !== b) return null;
  return a === 'BULLISH' ? 'BUY' : 'SELL';
}

/**
 * Step 2/3 — the point of interest price is sitting in RIGHT NOW.
 *
 * A demand zone is the last down-candle before an up-displacement (and vice versa) — the
 * "pivot candle" the source draws his zones from. Only zones price is currently INSIDE
 * qualify, which is the mechanical form of "wait for mitigation, never enter mid-range".
 *
 * Zones are returned nearest-first from the extreme, matching "always start from the extreme".
 */
export function findMitigatedZone(candles, direction, atr, { options = {} } = {}) {
  const o = { ...GOLD_SCALP_DEFAULTS, ...options };
  const cs = arr(candles);
  if (cs.length < 20 || !(n(atr) > 0)) return null;
  const buy = direction === 'BUY';
  const last = cs.length - 1;
  const price = n(cs[last].close);
  const lo = n(cs[last].low), hi = n(cs[last].high);

  const zones = [];
  // Scan back for a pivot candle followed by displacement away from it.
  for (let i = last - 2; i >= Math.max(1, last - o.maxZoneAgeBars); i--) {
    const c = cs[i];
    const o_ = n(c.open), cl = n(c.close), h = n(c.high), l = n(c.low);
    if (!Number.isFinite(o_) || !Number.isFinite(cl)) continue;
    // Demand = a DOWN candle that price then left upward; supply = an UP candle left downward.
    const isPivot = buy ? cl < o_ : cl > o_;
    if (!isPivot) continue;
    // Displacement out of the zone: the next two bars must travel at least 1 ATR the right way.
    const nxt = cs[i + 1], nxt2 = cs[i + 2];
    if (!nxt || !nxt2) continue;
    const moved = buy ? Math.max(n(nxt.high), n(nxt2.high)) - h : l - Math.min(n(nxt.low), n(nxt2.low));
    if (!(moved >= n(atr))) continue;
    const top = h, bottom = l;
    const height = top - bottom;
    if (!(height > 0) || height > o.maxZoneAtr * n(atr)) continue;
    // Still unmitigated up to the CURRENT bar: price must not have traded through it since.
    let breached = false;
    for (let j = i + 3; j < last; j++) {
      if (buy ? n(cs[j].low) <= bottom : n(cs[j].high) >= top) { breached = true; break; }
    }
    if (breached) continue;
    // Mitigated NOW: the live bar is inside the zone.
    const inside = buy ? (lo <= top && hi >= bottom) : (hi >= bottom && lo <= top);
    if (!inside) continue;
    zones.push({ top: r5(top), bottom: r5(bottom), index: i, ageBars: last - i, heightAtr: height / n(atr) });
  }
  if (!zones.length) return null;
  // Nearest to price first — the first zone price reaches is the one it reacts from.
  zones.sort((a, b) => Math.abs((buy ? a.top : a.bottom) - price) - Math.abs((buy ? b.top : b.bottom) - price));
  return zones[0];
}

/**
 * Step 4a — the liquidity sweep.
 *
 * A sweep is a swing level pierced and then RECLAIMED: price traded through, failed, and
 * closed back. A pierce that stays through is a breakout, not a sweep, and trading it as one
 * is the "false breakout" the source warns about.
 *
 * Returns the protected extreme, which becomes the stop.
 */
export function findSweep(candles, direction, { options = {} } = {}) {
  const o = { ...GOLD_SCALP_DEFAULTS, ...options };
  const cs = arr(candles);
  if (cs.length < 15) return null;
  const buy = direction === 'BUY';
  const last = cs.length - 1;
  const window = cs.slice(-Math.max(20, o.sweepLookback + 5));
  const offset = cs.length - window.length;
  const { highs, lows } = fractalSwings(window);
  const points = (buy ? lows : highs).map((p) => ({ ...p, i: p.i + offset }));
  let best = null;
  for (const p of points) {
    for (let j = p.i + 1; j <= last; j++) {
      if (last - j > o.maxSweepAgeBars) continue;         // must be a RECENT sweep
      const pierced = buy ? n(cs[j].low) < p.price : n(cs[j].high) > p.price;
      if (!pierced) continue;
      // Reclaimed: this bar closed back on the correct side of the swept level.
      const reclaimed = buy ? n(cs[j].close) > p.price : n(cs[j].close) < p.price;
      if (!reclaimed) continue;
      const extreme = buy ? n(cs[j].low) : n(cs[j].high);
      const cand = { sweptLevel: r5(p.price), sweepIdx: j, ageBars: last - j, protectedExtreme: r5(extreme) };
      if (!best || cand.sweepIdx > best.sweepIdx) best = cand;
    }
  }
  return best;
}

/** The confirming candle the source used live: a real body closing in the trade direction. */
export function confirmCandle(candle, direction, { minBody = 0.45 } = {}) {
  if (!candle) return false;
  const o = n(candle.open), c = n(candle.close), h = n(candle.high), l = n(candle.low);
  const range = h - l;
  if (!(range > 0)) return false;
  const body = Math.abs(c - o) / range;
  if (body < minBody) return false;
  return direction === 'BUY' ? c > o : c < o;
}

/**
 * Step 4b — the market shift, and the pullback into the zone that produced it.
 *
 * The shift is price closing through the last opposing internal swing. The source then waits
 * for price to return to the origin of that move; this reports both so the caller can require
 * the return rather than entering on the break itself.
 */
export function findMarketShift(candles, direction, { options = {} } = {}) {
  const o = { ...GOLD_SCALP_DEFAULTS, ...options };
  const cs = arr(candles);
  if (cs.length < 20) return null;
  const buy = direction === 'BUY';
  const last = cs.length - 1;
  const window = cs.slice(-Math.max(20, o.swingLookback));
  const offset = cs.length - window.length;
  const { highs, lows } = fractalSwings(window);
  const points = (buy ? highs : lows).map((p) => ({ ...p, i: p.i + offset }));
  if (!points.length) return null;
  // The most recent opposing swing that price has closed through.
  for (let k = points.length - 1; k >= 0; k--) {
    const p = points[k];
    for (let j = p.i + 1; j <= last; j++) {
      const broke = buy ? n(cs[j].close) > p.price : n(cs[j].close) < p.price;
      if (!broke) continue;
      if (last - j > o.maxMssPullbackBars) return null;   // the shift is stale
      // Origin of the shift leg: the extreme bar between the swing and the break.
      let originIdx = p.i;
      for (let m = p.i; m <= j; m++) {
        const better = buy ? n(cs[m].low) < n(cs[originIdx].low) : n(cs[m].high) > n(cs[originIdx].high);
        if (better) originIdx = m;
      }
      const zTop = n(cs[originIdx].high), zBot = n(cs[originIdx].low);
      const lo = n(cs[last].low), hi = n(cs[last].high);
      const returned = buy ? lo <= zTop : hi >= zBot;
      return {
        brokeLevel: r5(p.price), breakIdx: j, ageBars: last - j,
        zoneTop: r5(zTop), zoneBottom: r5(zBot), returned,
      };
    }
  }
  return null;
}

/**
 * Step 5 — the NEAREST opposing swing or level, never the furthest.
 *
 * Deliberately conservative, per "target the nearest logical liquidity". A target closer than
 * `minTargetAtr` is inside the noise and returns null rather than a trade that cannot clear
 * its own spread.
 */
export function nearestTarget(candles, direction, entry, atr, { options = {} } = {}) {
  const o = { ...GOLD_SCALP_DEFAULTS, ...options };
  const cs = arr(candles);
  const a = n(atr), e = n(entry);
  if (cs.length < 20 || !(a > 0) || !Number.isFinite(e)) return null;
  const buy = direction === 'BUY';
  const window = cs.slice(-Math.max(20, o.swingLookback));
  const { highs, lows } = fractalSwings(window);
  const points = (buy ? highs : lows).map((p) => n(p.price))
    .filter((p) => (buy ? p > e : p < e))
    .filter((p) => Math.abs(p - e) >= o.minTargetAtr * a);
  if (!points.length) return null;
  // Nearest ahead of price — the cleanest part of the move, not the whole move.
  return r5(buy ? Math.min(...points) : Math.max(...points));
}

/**
 * The full decision. `variant` selects the entry model: 'SWEEP' or 'MSS'.
 * Returns null when any step fails — the caller treats null as "no setup".
 */
export function goldScalpPlan({ candles, h1Trend, pip = 0.0001, variant = 'SWEEP', options = {} }) {
  const o = { ...GOLD_SCALP_DEFAULTS, ...options };
  const cs = arr(candles);
  if (cs.length < 60) return null;
  const atr = n(atr14(cs));
  if (!(atr > 0)) return null;

  // Step 1 — bias.
  const ltfTrend = structureTrend(cs, { lookback: o.swingLookback });
  const dir = trendsAligned(h1Trend, ltfTrend);
  if (!dir) return null;
  const buy = dir === 'BUY';

  // Steps 2/3 — a point of interest price is mitigating right now.
  const zone = findMitigatedZone(cs, dir, atr, { options: o });
  if (!zone) return null;

  // Step 4a — the sweep, which also supplies the protected extreme used as the stop.
  const sweep = findSweep(cs, dir, { options: o });
  if (!sweep) return null;

  const last = cs[cs.length - 1];
  if (o.requireConfirmCandle && !confirmCandle(last, dir, { minBody: o.minConfirmBody })) return null;

  // Step 4b — the conservative variant additionally needs a shift AND the return to its zone.
  let mss = null;
  if (variant === 'MSS') {
    mss = findMarketShift(cs, dir, { options: o });
    if (!mss || !mss.returned) return null;
  }

  const entry = n(last.close);
  // Stop below/above the PROTECTED extreme — the low that swept liquidity. For the MSS
  // variant the shift zone is the structure being defended, so the stop respects whichever
  // is further, rather than sitting inside the level it is meant to survive.
  let stop = sweep.protectedExtreme;
  if (mss) stop = buy ? Math.min(stop, mss.zoneBottom) : Math.max(stop, mss.zoneTop);
  const risk = Math.abs(entry - stop);
  const floor = Math.max(o.minStopAtr * atr, o.minStopPips * (pip || 0.0001));
  if (!(risk > 0) || risk < floor) return null;             // sub-spread stops (the RR-106 fix)
  if (buy ? stop >= entry : stop <= entry) return null;     // stop must be on the losing side

  const target = nearestTarget(cs, dir, entry, atr, { options: o });
  if (target === null) return null;
  const reward = Math.abs(target - entry);
  const rr = reward / risk;

  // Score from the components the source treats as quality: a tight zone, a fresh sweep,
  // trend agreement (already required, so it is a floor not a bonus), and room to target.
  let score = 55;
  score += Math.min(12, Math.round((1.5 - zone.heightAtr) * 10));   // tighter zone = better
  score += sweep.ageBars === 0 ? 8 : sweep.ageBars <= 1 ? 5 : 2;    // freshness
  score += Math.min(12, Math.round(rr * 4));                        // room to the target
  if (mss) score += 8;                                              // extra structural proof
  score = Math.max(40, Math.min(95, score));

  const sign = buy ? 1 : -1;
  return {
    decision: dir,
    score,
    grade: score >= 85 ? 'A+' : score >= 75 ? 'A' : score >= 65 ? 'B' : 'C',
    entry: r5(entry),
    stopLoss: r5(stop),
    takeProfit1: r5(entry + sign * risk),                  // 1R rung
    takeProfit2: r5(entry + sign * Math.min(risk * 2, reward)),
    takeProfit3: r5(target),                               // the nearest opposing liquidity
    riskRewardRatio: Math.round(rr * 100) / 100,
    reason: `${variant === 'MSS' ? 'MSS' : 'Sweep'} @ ${buy ? 'demand' : 'supply'} ${zone.bottom}-${zone.top}`
      + ` · swept ${sweep.sweptLevel} (${sweep.ageBars} bars ago) · H1+${'LTF'} ${dir === 'BUY' ? 'bullish' : 'bearish'}`
      + ` → nearest ${buy ? 'high' : 'low'} ${target}`,
    // Anchored to the SWEEP bar, not the current bar. The setup stays true for as long as
    // price sits in the zone, so anchoring to `last` would re-emit the same trade every bar
    // and multiply one setup into a dozen. Same reason ict-breaker anchors to its breaker.
    barIso: cs[sweep.sweepIdx]?.time || last.time,
    meta: {
      variant,
      zoneTop: zone.top, zoneBottom: zone.bottom, zoneAgeBars: zone.ageBars,
      zoneHeightAtr: Math.round(zone.heightAtr * 100) / 100,
      sweptLevel: sweep.sweptLevel, sweepAgeBars: sweep.ageBars,
      protectedExtreme: sweep.protectedExtreme,
      mssLevel: mss?.brokeLevel ?? null,
      target,
      atr: Math.round(atr * 1e5) / 1e5,
    },
  };
}
