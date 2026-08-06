// What-if runner: ask every strategy what it WOULD do if price arrived at a level and behaved
// a specific way.
//
// This is the part that makes the forecast honest. Nothing here reimplements a trading rule.
// For each candidate level it builds the canonical scenario bars (setupForecast.js), appends
// them to the REAL candle history, and calls the strategy's own evaluate() through an injected
// `evaluate` function. Whatever the strategy returns is what gets reported.
//
// Three properties the probe against live engines forced into the design:
//
//   1. Scenarios have STAGES. Detectors read the last candle, so a pin strategy fires with the
//      rejection bar last while a reclaim strategy needs the displacement bar last. Evaluating
//      only the full sequence hides every pin strategy. Each stage is evaluated in order and the
//      earliest fire is kept.
//   2. Only UNUSED levels are forecastable. The detectors deliberately refuse liquidity that has
//      already been swept, so a swept level is not a candidate — filtering it here avoids
//      generating forecasts that every strategy would correctly reject.
//   3. Some strategies CANNOT be forecast this way. ict-breaker, smc-fvg, three-candle-combo and
//      others need a longer specific bar sequence than "price arrives and rejects" specifies.
//      Deliberately NOT accommodated by inventing more bars: a synthetic sequence tuned until
//      ict-breaker fires is an authored signal, not a prediction. They are reported as
//      undeterminable, never as a rejection.

import {
  SCENARIOS, buildScenarioBars, scenarioContext, scenarioDirection,
  distanceTo, etaBand, horizonBucket,
} from './setupForecast.js';
import {
  emptyStats, recordScenario, partitionStrategies, placeboPrices, discriminationFor, VERDICT,
} from './forecastDiscrimination.js';
import { interleaveBySource } from './forecastLevels.js';

const n = (v) => Number(v);
// 5dp everywhere a price is carried: 2dp is lossy on forex, where it merges distinct levels.
const r5 = (v) => Math.round(n(v) * 1e5) / 1e5;

export const DEFAULTS = {
  minLevelStrength: 2,
  maxDistanceAtr: 8,        // beyond this the arrival is too speculative to be worth ranking
  minDistanceAtr: 0.05,     // already there: it is a live signal, not a forecast
  maxLevels: 18,            // evaluation cost is levels x scenarios x stages x strategies
  scenarios: SCENARIOS,
};

/**
 * Levels worth forecasting against, nearest first.
 *
 * `side` is relative to current price, so a level that no longer sits on its stated side is
 * stale and dropped rather than silently forecast in the wrong direction.
 */
export function forecastableLevels(levels, { price, atr, options = {} } = {}) {
  const o = { ...DEFAULTS, ...options };
  const p = n(price), a = n(atr);
  if (!Array.isArray(levels) || !Number.isFinite(p) || !(a > 0)) return [];
  const ranked = levels
    .filter((l) => {
      const lp = n(l.price);
      if (!Number.isFinite(lp) || lp <= 0) return false;
      if (l.swept) return false;                              // liquidity already taken
      if (n(l.strength) < o.minLevelStrength) return false;
      if (l.side !== 'below' && l.side !== 'above') return false;
      if (l.side === 'below' ? lp >= p : lp <= p) return false;   // stale side vs live price
      const d = Math.abs(lp - p) / a;
      return d >= o.minDistanceAtr && d <= o.maxDistanceAtr;
    })
    .sort((x, y) => Math.abs(n(x.price) - p) - Math.abs(n(y.price) - p))
    // Cap by round-robin across sources rather than by raw distance. Support/resistance zones are
    // far denser than daily liquidity, so a plain nearest-N cut here would refill the pool with
    // zones and quietly stop forecasting PDH/PDL — the same starvation the merge already guards
    // against upstream, reintroduced after filtering. With a single source this is exactly
    // `sort by distance, slice(maxLevels)`, so liquidity-only callers are unaffected.
    ;
  return interleaveBySource(ranked, { limit: o.maxLevels });
}

/**
 * Grade a forecast on the SAME scale the strategies use (strategyLab.js), so an A+ forecast
 * means the same score band as an A+ signal. Diverging here would make the two incomparable,
 * and the challenge rules read grades from both.
 */
export function forecastGrade(score) {
  // Explicit null guard, not a bare Number.isFinite: Number(null) is 0 and 0 is finite, so a
  // MISSING score would be graded C — a failing grade — rather than reported as unknown. That
  // exact conflation is what made the challenge guard refuse every forecast order.
  if (score === null || score === undefined || score === '') return null;
  const v = n(score);
  if (!Number.isFinite(v)) return null;
  return v >= 85 ? 'A+' : v >= 75 ? 'A' : v >= 65 ? 'B' : 'C';
}

/**
 * Stable identity for a forecast, so re-scoring the same idea updates rather than duplicates.
 *
 * Five decimals, not two: a 2dp key reads fine on gold (4060.62) but collides on forex, where
 * GBPUSD 1.33124 and 1.33501 are distinct levels an ATR apart. The live probe hit exactly that —
 * two different EQUAL_LOW forecasts sharing one key — which would have silently overwritten one
 * with the other and made the tracked score drift meaningless.
 */
export function forecastKey({ symbol, timeframe, level, scenario }) {
  return `${symbol}|${timeframe}|${(Math.round(n(level) * 1e5) / 1e5).toFixed(5)}|${scenario}`;
}

/**
 * Run one level x scenario across every strategy.
 *
 * `baseline` maps strategyId -> decision already firing on the real bars. A strategy already
 * calling BUY right now tells us nothing about the hypothetical, so those are excluded — without
 * this the forecast would take credit for live signals.
 */
export function runScenario({
  base, level, side, scenario, atr, timeframe, symbol, price, pip,
  strategyIds, evaluate, baseline = new Map(), allowed = null,
}) {
  const bars = buildScenarioBars({ level, side, scenario, atr, lastCandle: base?.candles?.at?.(-1), timeframe });
  if (!bars) return { firedIds: [], forecast: null, unbuildable: true };
  const expected = scenarioDirection(scenario, side);

  const fires = new Map();
  const threw = [];
  for (let stage = 1; stage <= bars.length; stage++) {
    const ctx = scenarioContext(base, bars.slice(0, stage));
    if (!ctx) continue;
    for (const id of strategyIds) {
      if (fires.has(id)) continue;                       // earliest stage wins
      let res = null;
      try {
        res = evaluate(id, ctx);
      } catch (error) {
        if (!threw.includes(id)) threw.push(id);
        continue;
      }
      if (!res?.decision) continue;
      const decision = String(res.decision).toUpperCase();
      if (baseline.get(id) === decision) continue;       // already firing this way for real
      fires.set(id, {
        strategyId: id,
        decision,
        agrees: decision === expected,
        stage,
        score: Number.isFinite(n(res.score)) ? n(res.score) : null,
        grade: res.grade || null,
        entry: Number.isFinite(n(res.entry)) ? n(res.entry) : null,
        stopLoss: Number.isFinite(n(res.stopLoss)) ? n(res.stopLoss) : null,
        // The lab contract names targets takeProfit1/2/3 — reading `takeProfit` here silently
        // returned null for every strategy and stripped the target off every ticket. The whole
        // ladder is kept: TP1 is ~1R while the strategy's advertised RR is measured to its
        // final target, so a ticket showing only TP1 would misstate the trade.
        takeProfit: Number.isFinite(n(res.takeProfit1)) ? n(res.takeProfit1)
          : Number.isFinite(n(res.takeProfit)) ? n(res.takeProfit) : null,
        takeProfit2: Number.isFinite(n(res.takeProfit2)) ? n(res.takeProfit2) : null,
        takeProfit3: Number.isFinite(n(res.takeProfit3)) ? n(res.takeProfit3) : null,
        rr: Number.isFinite(n(res.riskRewardRatio)) ? n(res.riskRewardRatio) : null,
      });
    }
  }
  // Every strategy that fired, including ones excluded from forecasts. The discrimination
  // measurement needs all of them: a dropped strategy that is never evaluated again can never
  // earn its way back, so the verdict would be permanent on the strength of one measurement.
  const firedIds = [...fires.keys()];
  const shown = allowed ? firedIds.filter((id) => allowed.has(id)) : firedIds;
  if (!shown.length) return { firedIds, forecast: null };   // nothing showable backs it

  const list = shown.map((id) => fires.get(id)).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  // A scenario only DISSENTERS fire on is not a forecast of that scenario. Without this the
  // page rendered rows reading "Touch & reject -> BUY · 88 · 0 strats · 1 against": a headline
  // direction and score taken from a strategy arguing the opposite. Dissent is worth showing
  // beside agreement, never as the entire basis for a claim.
  const backing = list.filter((f) => f.agrees);
  if (!backing.length) return { firedIds, forecast: null };
  const dist = distanceTo({ price, level, atr, pip });
  const eta = etaBand({ distanceAtr: dist?.atr, timeframe });
  const bucket = eta ? horizonBucket(eta.midMinutes) : null;
  const agreeing = list.filter((f) => f.agrees);
  const dissenting = list.filter((f) => !f.agrees);
  // Consensus direction is decided by the strategies, not by the scenario premise — if they
  // disagree with the premise that is a finding, not an error to be smoothed over.
  const buys = list.filter((f) => f.decision === 'BUY').length;
  const sells = list.filter((f) => f.decision === 'SELL').length;

  return {
    firedIds,
    forecast: {
      key: forecastKey({ symbol, timeframe, level, scenario }),
      symbol, timeframe, scenario,
      level: r5(level), side,
      expectedDirection: expected,
      consensusDirection: buys === sells ? 'SPLIT' : buys > sells ? 'BUY' : 'SELL',
      distance: dist,
      eta,
      horizon: bucket ? { key: bucket.key, label: bucket.label } : null,
      fires: list,
      agreeCount: agreeing.length,
      dissentCount: dissenting.length,
      // From the AGREEING fires only: the headline score must measure support for the
      // forecast's own direction, not the loudest voice regardless of which way it points.
      bestScore: backing[0]?.score ?? null,
      bestStrategy: backing[0]?.strategyId || null,
      // The firing strategy's own grade when it reported one, else derived from the score on
      // the shared scale — a forecast without a grade reads to the challenge guard as a
      // FAILING grade, which is what blocked place-order.
      grade: backing[0]?.grade || forecastGrade(backing[0]?.score),
      scenarioBars: bars,        // disclosed: the reader must be able to see what was assumed
      threw,
    },
  };
}

/**
 * Full sweep for one symbol/timeframe.
 *
 * `strategyIds` should already be filtered to strategies that run on this timeframe — the
 * registry owns that decision, not this module.
 */
export function runForecasts({
  base, levels, atr, price, pip, symbol, timeframe,
  strategyIds, evaluate, discrimination = null, options = {},
}) {
  const o = { ...DEFAULTS, ...options };
  const empty = {
    forecasts: [], candidates: 0, silent: [], evaluations: 0,
    stats: emptyStats(), dropped: [], unmeasured: [], placeboCount: 0,
  };
  if (!base || !Array.isArray(strategyIds) || typeof evaluate !== 'function') return empty;

  // Shape-driven strategies are excluded from what gets SHOWN, but stay in the evaluation set so
  // the measurement continues and a verdict can change. Excluding them from evaluation entirely
  // would freeze the verdict permanently on whatever the first measurement happened to say.
  const { allowed, dropped, unmeasured } = partitionStrategies(strategyIds, discrimination, o);
  const allowedSet = new Set(allowed);

  const candidates = forecastableLevels(levels, { price, atr, options: o });

  // What is already firing for real? Established once, not per scenario.
  const baseline = new Map();
  for (const id of strategyIds) {
    try {
      const r = evaluate(id, base);
      if (r?.decision) baseline.set(id, String(r.decision).toUpperCase());
    } catch { /* a live-path failure is not this feature's problem to report */ }
  }

  const stats = emptyStats();
  const forecasts = [];
  const everFired = new Set();
  let evaluations = 0;

  const sweep = (targets, arm) => {
    for (const lv of targets) {
      for (const scenario of o.scenarios) {
        const res = runScenario({
          base, level: n(lv.price), side: lv.side, scenario, atr, timeframe, symbol, price, pip,
          strategyIds, evaluate, baseline, allowed: allowedSet,
        });
        if (res.unbuildable) continue;
        evaluations += strategyIds.length * 2;
        recordScenario(stats, { arm, fired: res.firedIds });
        if (arm !== 'real' || !res.forecast) continue;
        const f = res.forecast;
        f.levelType = lv.type || null;
        f.levelLabel = lv.label || null;
        f.levelStrength = n(lv.strength) || null;
        // A level can be several things at once — a PDH that is also an order block edge. `type`
        // names only the strongest, so the full list is carried separately: without it, merging
        // would quietly reassign a hit away from the source that actually earned it, and the
        // per-source track record would be measuring the wrong thing.
        f.levelSources = Array.isArray(lv.sources) && lv.sources.length ? [...lv.sources] : (lv.type ? [lv.type] : []);
        f.levelConfluence = n(lv.confluence) > 0 ? n(lv.confluence) : 1;
        f.fires.forEach((x) => everFired.add(x.strategyId));
        forecasts.push(f);
      }
    }
  };

  sweep(candidates, 'real');
  // The control arm. It produces no forecasts — its only job is to keep the level-driven vs
  // shape-driven measurement current as market conditions change.
  const placebo = placeboPrices(levels, { price, atr, realLevels: candidates, options: o });
  sweep(placebo, 'placebo');

  // Strategies absent from the output, and honestly why. A strategy that cannot be forecast this
  // way (needs a longer bar sequence than a level-arrival scenario specifies) is a different
  // thing from one excluded for firing on shape alone, and they must not be conflated.
  const droppedIds = new Set(dropped.map((d) => d.strategyId));
  const silent = strategyIds.filter((id) => !everFired.has(id) && !baseline.has(id) && !droppedIds.has(id));

  return {
    forecasts: rankForecasts(forecasts, discrimination, o),
    candidates: candidates.length,
    placeboCount: placebo.length,
    silent, dropped, unmeasured, stats, evaluations,
  };
}

/**
 * Rank by score AND time-to-arrival, which is what makes the list actionable rather than just
 * sorted by conviction. A 95 twelve hours out should not outrank an 80 arriving within the hour.
 *
 * Proximity decays smoothly with the central ETA (half weight at ~3h) instead of using the
 * horizon buckets, so ordering does not jump at a bucket boundary. Buckets are for grouping in
 * the UI; this is for ordering inside and across them.
 */
export function rankForecasts(forecasts, discrimination = null, options = {}) {
  const scored = (Array.isArray(forecasts) ? forecasts : []).map((f) => {
    const score = n(f.bestScore) || 0;
    const mid = n(f.eta?.midMinutes);
    const proximity = Number.isFinite(mid) ? 180 / (180 + Math.max(0, mid)) : 0.5;
    const consensus = Math.min(1, f.agreeCount / 3);           // 3+ agreeing strategies saturates
    const dissentPenalty = f.dissentCount > 0 && f.agreeCount === 0 ? 0.5 : 1;
    const strength = Math.min(1, (n(f.levelStrength) || 2) / 5);
    // Shape-driven strategies are already excluded, so this only distinguishes a PROVEN
    // level-driven leader from one whose discrimination is not yet established.
    const lead = f.bestStrategy && discrimination
      ? discriminationFor(discrimination, f.bestStrategy, options)
      : null;
    const proven = !lead || lead.verdict === VERDICT.LEVEL_DRIVEN ? 1 : 0.9;
    const rank = (score * 0.55 + score * 0.20 * consensus) * (0.45 + 0.55 * proximity)
      * (0.85 + 0.15 * strength) * dissentPenalty * proven;
    return {
      ...f,
      rankScore: Math.round(rank * 100) / 100,
      proximity: Math.round(proximity * 100) / 100,
      ...(lead ? { leadDiscrimination: lead } : {}),
    };
  });
  return scored.sort((a, b) => b.rankScore - a.rankScore
    || (n(a.eta?.midMinutes) || 0) - (n(b.eta?.midMinutes) || 0));
}

/** Group ranked forecasts into the horizon buckets, preserving rank order inside each. */
export function groupByHorizon(forecasts, buckets) {
  const out = buckets.map((b) => ({ ...b, forecasts: [] }));
  for (const f of forecasts || []) {
    const slot = out.find((b) => b.key === f.horizon?.key) || out[out.length - 1];
    slot.forecasts.push(f);
  }
  return out;
}
