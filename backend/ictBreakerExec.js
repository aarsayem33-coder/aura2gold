/**
 * ict-breaker execution profile — SL-only market orders.
 *
 * WHY THIS EXISTS
 * ict-breaker alerts arrive after the move has already run. Measured over 650 replayed
 * signals (21 days, M1-M30), the fill sits a median ~129% of the stop distance past the
 * planned entry on M5, and 29 of 29 MT5 "10016 Invalid stops" rejections were caused by
 * exactly one thing: TAKE PROFIT 1 WAS ALREADY BEHIND THE MARKET. Zero of those 29 had a
 * problem with the stop. The broker was refusing the target, never the risk.
 *
 * So this profile places the order with a stop and NO take profit. That removes the only
 * invalid leg, and the trade is managed manually from there.
 *
 * WHAT THE GATE IS, AND WHY IT IS NOT THE SLIPPAGE %
 * Bucketing the same 650 signals by lateness shows win rate CLIMBING to 97% while average R
 * goes NEGATIVE — because a fill past TP1 "wins" instantly for nothing while the stop sits far
 * away. Lateness alone is therefore a bad gate: it is high exactly where the win rate looks
 * best. What actually separates a live setup from a spent one is how much room remains to the
 * draw. Filtering on ">= 1R left to TP3" turned the 100-250% lateness buckets from -0.06R and
 * +0.05R into +0.25R and +0.21R. Small samples (n=17 each) — hence the hard cutoff too.
 *
 * SCOPE
 * Nothing here runs for any other strategy. The caller gates on the strategy id; every other
 * path keeps its existing plan, its take profits and the standard slippage gate.
 */

const n = (v) => Number(v);
const finite = (v) => Number.isFinite(n(v));

export const ICT_EXEC_DEFAULTS = {
  minRemainingR: 1.0,     // measured: below this the setup is spent (53.4% of alerts are)
  maxLatePct: 250,        // beyond this, expectancy went negative even WITH the >=1R filter
  minStopSpreadMult: 2.0, // a stop inside a couple of spreads is taken out by the spread itself
  noTakeProfit: true,
};

/** Signed distance in price terms, positive when `to` is in the trade's favour from `from`. */
function favourable(direction, from, to) {
  return String(direction).toUpperCase() === 'SELL' ? n(from) - n(to) : n(to) - n(from);
}

/**
 * How many R remain between the live price and the draw, measured from the price you would
 * ACTUALLY fill at — not from the planned entry, which you never get.
 *
 * Risk is live-price → stop and reward is live-price → target, so entering late correctly
 * shows as risk growing and reward shrinking at the same time. Returns null when the geometry
 * is unusable rather than a number that would read as "fine".
 */
export function remainingR({ direction, price, stopLoss, target }) {
  const p = n(price), s = n(stopLoss), t = n(target);
  if (!finite(p) || !finite(s) || !finite(t) || p <= 0) return null;
  // Distance from the stop UP to the price is the risk on a sell, and from the stop DOWN to
  // the price on a buy — which is exactly `favourable(dir, stop, price)`. No negation.
  const risk = favourable(direction, s, p);
  const reward = favourable(direction, p, t);
  // A stop already breached, or a target already passed, is not a tradeable setup.
  if (!(risk > 0) || !(reward > 0)) return null;
  return reward / risk;
}

/** How far past the planned entry the live price has travelled, as % of the planned stop. */
export function latenessPct({ direction, plannedEntry, plannedStop, price }) {
  const e = n(plannedEntry), s = n(plannedStop), p = n(price);
  if (!finite(e) || !finite(s) || !finite(p)) return null;
  const plannedRisk = Math.abs(e - s);
  if (!(plannedRisk > 0)) return null;
  return (favourable(direction, e, p) / plannedRisk) * 100;
}

/**
 * Lot size for a stop measured from the LIVE price, floored to the broker's volume step.
 *
 * Floored, never rounded: rounding up a 0.616 to 0.62 quietly exceeds the risk budget that
 * the challenge rules are built on. Returns null when even one step is too much risk, which
 * is the correct answer rather than "trade the minimum anyway".
 */
export function sizeForStop({ riskAmount, stopDistance, pipSize, pipValuePerLot, volumeStep = 0.01, volumeMin = 0.01, volumeMax = 100 }) {
  const risk = n(riskAmount), dist = n(stopDistance), ps = n(pipSize), pv = n(pipValuePerLot);
  if (!(risk > 0) || !(dist > 0) || !(ps > 0) || !(pv > 0)) return null;
  const stopPips = dist / ps;
  if (!(stopPips > 0)) return null;
  const raw = risk / (stopPips * pv);
  const step = n(volumeStep) > 0 ? n(volumeStep) : 0.01;
  const floored = Math.floor(raw / step) * step;
  // Guard the float dust that Math.floor on non-decimal steps leaves behind.
  const lots = Math.round(floored * 1e8) / 1e8;
  if (lots < n(volumeMin)) return null;                     // one step already over budget
  return Math.min(lots, n(volumeMax) > 0 ? n(volumeMax) : lots);
}

/**
 * The full decision for one ict-breaker candidate.
 *
 * Returns `{ allow, reason, ... }`. `allow:false` always carries a reason that names the
 * measurement that refused it, so a skipped setup is explainable after the fact rather than
 * silently missing.
 */
export function ictBreakerExecPlan({
  direction, plannedEntry, plannedStop, target, price,
  riskAmount, pipSize, pipValuePerLot,
  spread = 0, volumeStep = 0.01, volumeMin = 0.01, volumeMax = 100,
  options = {},
}) {
  const o = { ...ICT_EXEC_DEFAULTS, ...options };
  const deny = (reason, extra = {}) => ({ allow: false, reason, ...extra });

  const dir = String(direction || '').toUpperCase();
  if (dir !== 'BUY' && dir !== 'SELL') return deny('unusable direction');
  const p = n(price), stop = n(plannedStop);
  if (!finite(p) || p <= 0 || !finite(stop) || stop <= 0) return deny('unusable price or stop');

  // The stop stays the STRUCTURAL level the strategy chose — it is the invalidation point, and
  // moving it to flatter risk would be inventing a different trade. Distance is absorbed by lot
  // size instead.
  const stopDistance = dir === 'SELL' ? stop - p : p - stop;
  if (!(stopDistance > 0)) return deny('market already through the stop');

  // A stop only a spread or two away is taken out by the spread itself, not by the market.
  const sp = n(spread);
  if (sp > 0 && stopDistance < sp * o.minStopSpreadMult) {
    return deny(`stop is only ${(stopDistance / sp).toFixed(1)}x the spread`, { stopDistance });
  }

  const late = latenessPct({ direction: dir, plannedEntry, plannedStop, price: p });
  if (late !== null && late > o.maxLatePct) {
    return deny(`${late.toFixed(0)}% past the entry — beyond the ${o.maxLatePct}% cutoff where expectancy went negative`, { latePct: late });
  }

  const rLeft = remainingR({ direction: dir, price: p, stopLoss: stop, target });
  if (rLeft === null) return deny('no room left to the draw (target already passed)', { latePct: late });
  if (rLeft < o.minRemainingR) {
    return deny(`only ${rLeft.toFixed(2)}R left to the draw (need ${o.minRemainingR}R) — setup is spent`, { remainingR: rLeft, latePct: late });
  }

  const lots = sizeForStop({ riskAmount, stopDistance, pipSize, pipValuePerLot, volumeStep, volumeMin, volumeMax });
  if (lots === null) {
    return deny('stop too wide to size within the risk budget', { stopDistance, remainingR: rLeft, latePct: late });
  }

  const stopPips = stopDistance / n(pipSize);
  return {
    allow: true,
    reason: `SL-only: ${rLeft.toFixed(2)}R to the draw, ${late === null ? '?' : late.toFixed(0)}% past entry`,
    lots,
    stopLoss: stop,
    // Deliberately null. MT5 reads 0/absent as "no take profit", which is the whole point:
    // the TP was the only leg the broker was rejecting.
    takeProfit: o.noTakeProfit ? null : n(target),
    stopDistance,
    stopPips: Math.round(stopPips * 10) / 10,
    lossAtStop: Math.round(stopPips * n(pipValuePerLot) * lots * 100) / 100,
    remainingR: Math.round(rLeft * 100) / 100,
    latePct: late === null ? null : Math.round(late),
  };
}
