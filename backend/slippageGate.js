// Slippage gate — the rule that stops a ticket's risk/reward being rewritten by the fill.
//
// The problem it solves, measured on live tickets: the ticket is built at signal time with
// absolute SL/TP prices, but a MARKET order fills at whatever the market is when the EA gets
// it. Any gap comes entirely OUT of the reward and goes entirely INTO the risk, because the
// stop and target never move:
//
//   508993270  stated RR 5.44 -> real 0.24 at TP1, risk 1.62x budget
//   508997768  stated RR 2.46 -> real 0.18 at TP1, risk 1.70x budget ($40 -> $71)
//   507898267  stated RR 2.19 -> real 0.60,  reward 0.00, risk 2.00x ($50 -> $114 loss)
//
// Two rules, in this order:
//
//   1. REFUSE the trade when the fill price has moved too far, as a fraction of the planned
//      stop distance. A percentage of the stop — not a flat pip count — because 3 pips is
//      nothing on a 300-pip gold stop and fatal on a 4-pip EURUSD stop.
//   2. Otherwise RESIZE the lots against the real distance to the (unchanged) stop, so the
//      money risked stays at budget even though the stop is now further away.
//
// The stop itself is never moved. It sits at the structural level that justifies the trade;
// sliding it to protect the R-multiple would put it inside the noise it was placed to avoid.
//
// This module is the SPEC. The gate has to run where the live tick is — inside the EA at the
// moment of execution — so AuraGoldSignals.mq5 implements the same arithmetic. These tests are
// what make that implementation checkable.

const n = (v) => Number(v);
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(n(v)) ? null : n(v));

export const SLIPPAGE_DEFAULTS = {
  tolerancePct: 25,     // max adverse move, as a % of the planned stop distance
};

/**
 * May this order still be sent at the current price?
 *
 * Only ADVERSE movement counts. A fill that improves the entry widens the reward and shrinks
 * the risk — refusing it would be throwing away a better trade than the one planned.
 */
export function slippageVerdict({ direction, plannedEntry, livePrice, stopLoss, tolerancePct = SLIPPAGE_DEFAULTS.tolerancePct, pip = null }) {
  const entry = num(plannedEntry);
  const live = num(livePrice);
  const sl = num(stopLoss);
  const tol = num(tolerancePct);
  if (entry === null || live === null || sl === null) {
    return { allowed: true, reason: 'insufficient data to judge slippage', deviation: null, pctOfStop: null };
  }
  const buy = String(direction).toUpperCase().includes('BUY');
  const plannedStop = Math.abs(entry - sl);
  if (!(plannedStop > 0)) {
    return { allowed: false, reason: 'planned stop distance is zero', deviation: null, pctOfStop: null };
  }
  // Positive = worse than planned (paying up on a buy, selling lower on a sell).
  const deviation = buy ? live - entry : entry - live;
  const pctOfStop = Math.round((deviation / plannedStop) * 1000) / 10;
  const toPips = (v) => (pip && pip > 0 ? Math.round((v / pip) * 10) / 10 : null);

  // A tolerance that cannot be read blocks rather than waving everything through: this gate
  // exists because unchecked fills cost real money.
  if (tol === null || tol < 0) {
    return { allowed: false, reason: 'slippage tolerance is not configured', deviation, pctOfStop, deviationPips: toPips(deviation) };
  }
  if (deviation <= 0) {
    return { allowed: true, reason: 'filled at or better than the planned entry', deviation, pctOfStop, deviationPips: toPips(deviation) };
  }
  if (pctOfStop > tol) {
    return {
      allowed: false,
      reason: `price moved ${pctOfStop}% of the stop distance since the signal (limit ${tol}%) — the setup has moved`,
      deviation, pctOfStop, deviationPips: toPips(deviation),
    };
  }
  return { allowed: true, reason: `within tolerance (${pctOfStop}% of ${tol}%)`, deviation, pctOfStop, deviationPips: toPips(deviation) };
}

/**
 * Lots that risk `riskAmount` over the REAL distance from the live price to the unchanged stop.
 *
 * Floored to the volume step, never rounded up — rounding up overshoots the budget, which is
 * the exact failure this whole gate exists to prevent. The broker minimum is applied last and
 * is the one case where risk may still exceed budget; it is reported, not hidden.
 */
export function resizeLotsToStop({ riskAmount, livePrice, stopLoss, pip, pipValuePerLot, volMin = 0.01, volStep = 0.01, volMax = null }) {
  const budget = num(riskAmount);
  const live = num(livePrice);
  const sl = num(stopLoss);
  const p = num(pip);
  const pv = num(pipValuePerLot);
  if (budget === null || budget <= 0 || live === null || sl === null || !p || p <= 0 || !pv || pv <= 0) return null;

  const stopPips = Math.abs(live - sl) / p;
  if (!(stopPips > 0)) return null;

  const raw = budget / (stopPips * pv);
  const step = num(volStep) && num(volStep) > 0 ? num(volStep) : 0.01;
  let lots = Math.floor(raw / step) * step;
  lots = Math.round(lots * 1000) / 1000;

  const min = num(volMin) && num(volMin) > 0 ? num(volMin) : 0.01;
  const max = num(volMax);
  let minForced = false;
  if (lots < min) { lots = min; minForced = raw < min; }
  if (max !== null && lots > max) lots = max;

  const riskAtStop = Math.round(lots * stopPips * pv * 100) / 100;
  return {
    lots: Math.round(lots * 100) / 100,
    stopPips: Math.round(stopPips * 10) / 10,
    riskAtStop,
    overBudget: riskAtStop > budget + 0.005,
    minForced,
  };
}
