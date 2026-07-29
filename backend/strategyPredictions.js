// Ranking maths for /future-predictions/setups.
//
// A prediction is only useful if it resolves inside the window you are actually going to
// watch. The horizon is therefore a hard filter, not a preference: a beautiful setup whose
// entry is nine hours away is not a prediction for the next three hours, and ranking it
// alongside one that triggers in ten minutes would bury the tradable one.
//
// Kept pure so the ETA and the ordering can be tested without candles, a database or MT5.

/** Minutes per timeframe. 0 = unknown. */
export function tfMinutes(tf) {
  const m = /^([MH])(\d+)$/.exec(String(tf || '').toUpperCase());
  if (!m) return 0;
  return m[1] === 'H' ? Number(m[2]) * 60 : Number(m[2]);
}

/**
 * How long until this setup can actually be entered, in minutes.
 *
 * TRADABLE means now. Otherwise price has to travel from where it is to the entry, so the
 * estimate is that distance measured in bars of typical range (ATR), converted to minutes
 * by the timeframe. It is an order-of-magnitude estimate and is labelled as one — price
 * does not move at a constant rate, and nothing here pretends it does.
 */
export function estimateEtaMinutes({ status, price, entry, atr, timeframe }) {
  if (status === 'TRADABLE') return 0;
  if (status === 'EXPIRED') return null;
  const p = Number(price), e = Number(entry), a = Number(atr);
  const mins = tfMinutes(timeframe);
  if (!Number.isFinite(p) || !Number.isFinite(e) || !(a > 0) || !(mins > 0)) return null;
  const distance = Math.abs(e - p);
  if (distance <= 0) return 0;
  // Typical bar covers roughly one ATR of range; half of that is progress in one direction.
  const barsNeeded = distance / (a * 0.5);
  return Math.round(barsNeeded * mins);
}


/**
 * Expected time for the trade to RESOLVE — entry to TP1 — in minutes.
 *
 * "Expectation not more than 1-3 hours" is about how long the position is likely to be
 * open, which is a different question from when it can be entered. A market setup is
 * entrable now but its target may be a full session away, and that is the one that does not
 * belong on a three-hour page.
 *
 * Same crude travel model as the entry ETA: roughly half an ATR of directional progress per
 * bar. Deliberately the same assumption so the two numbers stay comparable.
 */
export function estimateResolveMinutes({ entry, target, atr, timeframe }) {
  const e = Number(entry), t = Number(target), a = Number(atr);
  const mins = tfMinutes(timeframe);
  if (!Number.isFinite(e) || !Number.isFinite(t) || !(a > 0) || !(mins > 0)) return null;
  const distance = Math.abs(t - e);
  if (distance <= 0) return 0;
  return Math.round((distance / (a * 0.5)) * mins);
}

/**
 * Combine setup quality with how soon it can be taken.
 *
 * Score alone would rank a 9-hour-away A+ above a tradable A. Time alone would rank every
 * marginal setup that happens to be at price. The weight decays linearly across the horizon
 * so a setup at the edge of the window keeps most of its quality but always loses to an
 * equal one that is closer.
 */
export function rankScore(score, etaMinutes, horizonMinutes) {
  const s = Number(score);
  if (!Number.isFinite(s)) return 0;
  if (etaMinutes === null || etaMinutes === undefined) return 0;
  if (!(horizonMinutes > 0)) return s;
  const frac = Math.max(0, Math.min(1, etaMinutes / horizonMinutes));
  const weight = 1 - 0.4 * frac;          // 1.0 now -> 0.6 at the horizon edge
  return Math.round(s * weight * 10) / 10;
}

/** Human ETA. */
export function etaLabel(etaMinutes) {
  if (etaMinutes === null || etaMinutes === undefined) return 'unknown';
  if (etaMinutes <= 0) return 'now';
  if (etaMinutes < 60) return `~${etaMinutes}m`;
  const h = Math.floor(etaMinutes / 60);
  const m = etaMinutes % 60;
  return m ? `~${h}h ${m}m` : `~${h}h`;
}

/**
 * Filter to the horizon and order best-first.
 *
 * Anything without a usable ETA is dropped rather than sorted to the bottom: an unknown ETA
 * cannot be claimed to fall inside a 3-hour window, and showing it would misrepresent the
 * whole point of the page.
 */
export function rankPredictions(rows, { horizonMinutes = 180 } = {}) {
  const scored = [];
  for (const r of rows || []) {
    const eta = r.etaMinutes;
    if (eta === null || eta === undefined) continue;
    if (eta > horizonMinutes) continue;
    // The whole trade has to fit the window: waiting for entry AND reaching the target.
    // Filtering on entry alone lets a market setup through whose target is a session away.
    const resolve = r.resolveMinutes;
    const total = resolve === null || resolve === undefined ? null : eta + resolve;
    if (total !== null && total > horizonMinutes) continue;
    scored.push({
      ...r,
      totalMinutes: total,
      rankScore: rankScore(r.score, total === null ? eta : total, horizonMinutes),
      etaLabel: etaLabel(eta),
      resolveLabel: etaLabel(resolve),
    });
  }
  // Best rank first; ties broken by the sooner setup, then the higher raw score.
  scored.sort((a, b) => (b.rankScore - a.rankScore)
    || (a.etaMinutes - b.etaMinutes)
    || ((b.score || 0) - (a.score || 0)));
  return scored;
}
