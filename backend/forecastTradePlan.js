// Trade plan for a forecast: the strategy's own entry/SL/TP, sized by the challenge rules.
//
// Division of authority, deliberately narrow:
//   * PRICES come from the strategy that fired in the what-if evaluation. Its evaluate()
//     returned entry, stop and target computed by its own rules against the scenario bars —
//     nothing here invents or adjusts a price.
//   * SIZE comes from the risk budget. Same formula as the live path in completeForexRiskPlan
//     (lots = risk / (stopPips x pipValue)), so a forecast ticket and a live ticket for the
//     same setup agree with each other.
//   * JUDGEMENT (is this safe for the challenge right now) mirrors challengeSignalGuard:
//     advisory warnings, never silent mutation of the plan.
//
// Everything is injected — challenge dashboard numbers, pip values, broker volume limits —
// because this module must be testable without a server and must never read live state that
// the caller didn't consciously choose.

const n = (v) => Number(v);
const r2 = (v) => Math.round(n(v) * 100) / 100;
const fin = (v) => (Number.isFinite(n(v)) ? n(v) : null);
const finPos = (v) => (Number.isFinite(n(v)) && n(v) > 0 ? n(v) : null);

/**
 * Which fire supplies the prices: the best-scored AGREEING strategy that actually returned an
 * entry and stop. A dissenting strategy's prices would describe the opposite trade, and a fire
 * without a stop cannot be sized at all.
 */
export function planSource(forecast) {
  const fires = Array.isArray(forecast?.fires) ? forecast.fires : [];
  return fires.find((f) => f.agrees && finPos(f.entry) && finPos(f.stopLoss)
    && f.entry !== f.stopLoss) || null;
}

/**
 * Size a stop-distance to a risk budget in account currency.
 *
 * Lots are FLOORED to the volume step, never rounded to nearest: rounding up overshoots the
 * budget, and on a challenge account "slightly more than the safe risk" is precisely the thing
 * the budget exists to prevent. The broker minimum is applied afterwards and is the one case
 * where the final risk may exceed the budget — reported, never hidden.
 */
export function sizeByRisk({ riskBudget, stopPips, pipValuePerLot, volMin = 0.01, volStep = 0.01, volMax = null }) {
  const budget = finPos(riskBudget);
  const pips = finPos(stopPips);
  const pv = finPos(pipValuePerLot);
  if (budget === null || pips === null || pv === null) return null;

  const raw = budget / (pips * pv);
  const step = finPos(volStep) ?? 0.01;
  let lots = Math.floor(raw / step) * step;
  lots = Math.round(lots * 1000) / 1000;

  const min = finPos(volMin) ?? 0.01;
  const max = finPos(volMax);
  let minForced = false;
  if (lots < min) { lots = min; minForced = raw < min; }
  if (max !== null && lots > max) lots = max;

  const lossAtStop = r2(lots * pips * pv);
  return {
    lots: Math.round(lots * 100) / 100,
    lossAtStop,
    riskBudget: r2(budget),
    // The one legitimate way risk exceeds budget: the broker's minimum lot is already bigger
    // than the budget allows. The caller must surface this, because the honest alternatives are
    // "trade above budget" or "skip the trade" — a decision for the user, not for rounding.
    overBudget: lossAtStop > budget + 0.005,
    minForced,
  };
}

/**
 * Challenge advisory for a sized plan. Mirrors challengeSignalGuard's semantics (annotate,
 * never block) against an injected dashboard snapshot.
 */
export function challengeAdvice({ lossAtStop, rr, grade, dashboard }) {
  if (!dashboard) return { eligible: null, warnings: ['challenge state unavailable'] };
  const warnings = [];
  let eligible = true;
  const loss = finPos(lossAtStop);
  const status = String(dashboard.status || '');
  if (status === 'BREACH_MAX_DD' || status === 'BREACH_DAILY') {
    warnings.push(status === 'BREACH_MAX_DD'
      ? 'challenge already past max drawdown — do not trade'
      : "challenge already past today's loss limit — do not trade");
    eligible = false;
  }
  const rules = dashboard.rules || {};
  if (rules.onlyAPlus && !['A', 'A+'].includes(String(grade || '').toUpperCase())) {
    warnings.push('below A grade — skip for the challenge');
    eligible = false;
  }
  const minRR = finPos(rules.minRR);
  if (minRR !== null && fin(rr) !== null && n(rr) < minRR) {
    warnings.push(`RR below challenge min ${minRR}`);
    eligible = false;
  }
  if (loss !== null) {
    const daily = fin(dashboard.roomToDailyLoss);
    const dd = fin(dashboard.roomToMaxDrawdown);
    const safe = fin(dashboard.safePerTradeRisk);
    if (daily !== null && loss > daily) warnings.push(`a full stop (${r2(loss)}) exceeds today's remaining loss room (${r2(daily)})`);
    else if (safe !== null && loss > safe) warnings.push(`a full stop (${r2(loss)}) is above the safe per-trade risk (${r2(safe)})`);
    if (dd !== null && loss > dd) warnings.push(`a full stop would breach max drawdown (room ${r2(dd)})`);
  }
  return { eligible, warnings };
}

/**
 * The full ticket for one forecast.
 *
 * Returns { plan: null, reason } when no agreeing strategy produced usable prices — the
 * forecast is still worth showing (strategies DO back the idea), it just cannot carry a sized
 * ticket, and the page must say why instead of showing an empty box.
 */
export function buildForecastPlan({
  forecast,
  pipSize,
  pipValuePerLot,
  riskBudget,
  dashboard = null,
  volMin = 0.01, volStep = 0.01, volMax = null,
}) {
  if (!forecast) return { plan: null, reason: 'no forecast' };
  const src = planSource(forecast);
  if (!src) return { plan: null, reason: 'no agreeing strategy returned entry and stop prices' };

  const ps = finPos(pipSize);
  const pv = finPos(pipValuePerLot);
  if (ps === null || pv === null) return { plan: null, reason: 'pip value unknown for this symbol' };

  const entry = n(src.entry);
  const stop = n(src.stopLoss);
  const target = finPos(src.takeProfit);          // TP1: the first rung, ~1R by lab convention
  const target2 = finPos(src.takeProfit2);
  const target3 = finPos(src.takeProfit3);
  const finalTarget = target3 ?? target2 ?? target;
  const stopDistance = Math.abs(entry - stop);
  if (!(stopDistance > 0)) return { plan: null, reason: 'zero stop distance' };
  const stopPips = Math.round((stopDistance / ps) * 10) / 10;

  // RR is the strategy's own figure, exactly as the live challenge guard receives it — the lab
  // measures it to the FINAL target. Recomputing from TP1 (~1R by convention) stamped every
  // ticket RR 1 and falsely tripped the minRR warning on setups the live path accepts. The
  // recomputation survives as a cross-check against the final target, not as the headline.
  const rrToFinal = finalTarget !== null
    ? Math.round((Math.abs(finalTarget - entry) / stopDistance) * 100) / 100
    : null;
  // finPos, not fin: Number(null) is 0 and 0 is finite, so a strategy that omitted its RR
  // would otherwise get rr 0 stamped on the ticket instead of the recomputed figure.
  const rr = finPos(src.rr) ?? rrToFinal;

  const sized = sizeByRisk({ riskBudget, stopPips, pipValuePerLot: pv, volMin, volStep, volMax });
  if (!sized) return { plan: null, reason: 'no risk budget available to size against' };

  const profitAt = (t) => (t !== null ? r2(sized.lots * (Math.abs(t - entry) / ps) * pv) : null);
  const profitAtTp = profitAt(target);
  const advice = challengeAdvice({ lossAtStop: sized.lossAtStop, rr, grade: src.grade, dashboard });

  return {
    plan: {
      strategyId: src.strategyId,
      direction: src.decision,
      entry, stopLoss: stop,
      takeProfit: target, takeProfit2: target2, takeProfit3: target3,
      profitAtFinalTp: profitAt(finalTarget),
      rrToFinal,
      stopPips, rr,
      lots: sized.lots,
      lossAtStop: sized.lossAtStop,
      profitAtTp,
      riskBudget: sized.riskBudget,
      overBudget: sized.overBudget,
      minForced: sized.minForced,
      challenge: advice,
      // Sized against a hypothetical arrival: prices are conditional on the scenario happening.
      conditional: true,
    },
    reason: null,
  };
}
