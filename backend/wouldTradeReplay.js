/**
 * Counterfactual replay — what the never-traded decisions would actually have done.
 *
 * 404 of 592 MT5 decisions never reached the market. This replays each one against the candles
 * that followed, so "what would it have made" is MEASURED rather than assumed.
 *
 * THE ASSUMPTION THAT WOULD MAKE THIS A LIE, AND THE GUARD AGAINST IT
 * A pending order only produces a result if price actually reaches its entry. 137 of these
 * decisions are EXPIRED — pending orders that expired precisely BECAUSE price never came back.
 * Resolving those from their planned entry would credit trades that could never have opened,
 * and would flatter every one of them: a limit order that never fills is exactly the order
 * whose setup ran away, which is the same adverse selection that made the earlier limit-order
 * experiment look good at a 30% fill rate.
 *
 * So every pending order must first PROVE it would have filled, by price trading through its
 * entry inside the window. Orders that never fill are reported as NEVER_FILLED and carry no
 * result — not a win, not a loss, and never averaged into expectancy.
 *
 * Market orders are different: they fill at the next available price by definition, so they are
 * entered at the first bar of the window.
 *
 * Everything else inherits the resolution rules already proven in backtest.mjs: a bar that
 * straddles both levels is a LOSS (the order inside it is unknowable, and guessing "target"
 * turns losing systems into winning backtests), a target on the losing side is INVALID rather
 * than an instant win, and no bar beyond the current index is ever consulted.
 *
 * Pure: prices in, verdict out. No I/O, no clock, no database.
 */

import { resolveTrade } from './backtest.mjs';

const n = (v) => Number(v);
// Number(null) is 0 and 0 is finite — the coercion behind seven separate defects in this
// codebase. Every optional price goes through this rather than a bare isFinite.
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(n(v)) ? null : n(v));

export const REPLAY_OUTCOME = {
  WIN: 'WIN',
  LOSS: 'LOSS',
  NEVER_FILLED: 'NEVER_FILLED',
  OPEN: 'OPEN',
  INVALID: 'INVALID',
  NO_DATA: 'NO_DATA',
};

/** Order types that only exist once price comes to them. */
const PENDING = /LIMIT|STOP/i;

export function isPendingOrder(orderType) {
  return PENDING.test(String(orderType || ''));
}

/**
 * The bar at which this order would have become a position, or null if it never would.
 *
 * A market order is filled at `fromIdx` by definition. A pending order needs price to trade
 * through its entry: for a buy the bar must reach DOWN to the entry (low <= entry), for a sell
 * it must reach UP to it (high >= entry). Both are checked on the bar's range rather than its
 * close, because an intrabar touch fills a resting order.
 */
export function fillIndex(bars, { entry, direction, orderType }, fromIdx = 0, { maxBars = 2000 } = {}) {
  const e = num(entry);
  if (e === null || !Array.isArray(bars) || !bars.length) return null;
  if (!isPendingOrder(orderType)) return fromIdx < bars.length ? fromIdx : null;

  const buy = String(direction || '').toUpperCase() === 'BUY';
  const end = Math.min(bars.length, fromIdx + maxBars);
  for (let j = fromIdx; j < end; j++) {
    const hi = num(bars[j].high), lo = num(bars[j].low);
    if (hi === null || lo === null) continue;
    if (buy ? lo <= e : hi >= e) return j;
  }
  return null;
}

/**
 * Replay one never-traded decision.
 *
 * `target` defaults to TP1: the nearest rung of the ladder and the one most likely to be
 * reached, so it is the conservative read of what the decision was worth. Pass TP3 to ask the
 * more optimistic question separately rather than blending the two.
 */
export function replayDecision(decision, bars, { target = 'tp1', maxBars = 2000 } = {}) {
  const entry = num(decision?.entry_price ?? decision?.entry);
  const stop = num(decision?.stop_loss ?? decision?.stopLoss);
  const tp = target === 'tp3'
    ? num(decision?.take_profit_3 ?? decision?.takeProfit3) ?? num(decision?.take_profit_1 ?? decision?.takeProfit1)
    : num(decision?.take_profit_1 ?? decision?.takeProfit1);

  if (!Array.isArray(bars) || bars.length === 0) {
    return { outcome: REPLAY_OUTCOME.NO_DATA, r: null, bars: 0, filledAtIdx: null };
  }
  if (entry === null || stop === null || tp === null) {
    return { outcome: REPLAY_OUTCOME.INVALID, r: null, bars: 0, filledAtIdx: null };
  }

  const idx = fillIndex(bars, {
    entry, direction: decision?.direction, orderType: decision?.order_type ?? decision?.orderType,
  }, 0, { maxBars });

  // The guard that keeps this honest: no fill, no result.
  if (idx === null) {
    return { outcome: REPLAY_OUTCOME.NEVER_FILLED, r: null, bars: bars.length, filledAtIdx: null };
  }

  const res = resolveTrade(
    { decision: decision?.direction, entry, stopLoss: stop, takeProfit: tp },
    bars, idx, { maxBars },
  );
  // resolveTrade reports OPEN with r=0; a zero here would be counted as a scratch trade and
  // drag every expectancy toward the middle, so unsettled outcomes carry a null instead.
  const settled = res.outcome === 'WIN' || res.outcome === 'LOSS';
  return {
    outcome: res.outcome === 'WIN' ? REPLAY_OUTCOME.WIN
      : res.outcome === 'LOSS' ? REPLAY_OUTCOME.LOSS
        : res.outcome === 'INVALID' ? REPLAY_OUTCOME.INVALID : REPLAY_OUTCOME.OPEN,
    r: settled ? Math.round(res.r * 1000) / 1000 : null,
    bars: res.bars,
    filledAtIdx: idx,
  };
}

/**
 * Aggregate a set of replayed decisions.
 *
 * Expectancy is over SETTLED replays only. Never-filled and still-open decisions are counted
 * and reported, because the fill rate is itself a finding: a strategy whose orders mostly never
 * fill has no edge to measure, however good the ones that did fill look.
 */
export function summariseReplay(replays, { riskPerTrade = 80 } = {}) {
  const list = Array.isArray(replays) ? replays : [];
  const settled = list.filter((x) => x.outcome === REPLAY_OUTCOME.WIN || x.outcome === REPLAY_OUTCOME.LOSS);
  const wins = settled.filter((x) => x.outcome === REPLAY_OUTCOME.WIN);
  const neverFilled = list.filter((x) => x.outcome === REPLAY_OUTCOME.NEVER_FILLED);
  const netR = settled.reduce((a, x) => a + (x.r ?? 0), 0);
  const round = (v, p = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** p) / 10 ** p : v);

  return {
    replayed: list.length,
    settled: settled.length,
    wins: wins.length,
    losses: settled.length - wins.length,
    neverFilled: neverFilled.length,
    stillOpen: list.filter((x) => x.outcome === REPLAY_OUTCOME.OPEN).length,
    invalid: list.filter((x) => x.outcome === REPLAY_OUTCOME.INVALID).length,
    noData: list.filter((x) => x.outcome === REPLAY_OUTCOME.NO_DATA).length,
    winRate: settled.length ? round(wins.length / settled.length, 4) : null,
    // NaN, not 0: nothing settled means no expectancy, and a zero would rank it above losers.
    expectancyR: settled.length ? round(netR / settled.length, 3) : NaN,
    netR: round(netR, 2),
    // Counterfactual money, at one constant risk. Labelled everywhere it surfaces: these trades
    // never existed, so this is what the decisions were WORTH, not money that was missed.
    estimatedProfit: round(netR * riskPerTrade),
    riskPerTrade,
    // The share of pending orders that price never came back for — the adverse-selection check.
    fillRate: list.length ? round((list.length - neverFilled.length) / list.length, 4) : null,
  };
}
