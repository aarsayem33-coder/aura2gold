/**
 * Modify a resting limit order — and show it in every unit at once.
 *
 * A pending order means four different things to four different questions, and a user editing
 * one of them needs to see all four move together:
 *   PRICE  — where the levels sit, which is what MT5 stores
 *   PIPS   — how far they are from entry, which is how a setup is judged
 *   USD    — what it costs and pays, which is how a decision is actually made
 *   LOTS   — the size that ties the other three together
 * Showing only prices makes a 2-pip stop look the same as a 40-pip one; showing only dollars
 * hides that $80 of risk became 3.2 lots. Both mistakes have already happened on this account.
 *
 * THE MT5 CONSTRAINT THAT SHAPES EVERYTHING HERE
 * `TRADE_ACTION_MODIFY` can change a pending order's price, stop, target and expiry. It CANNOT
 * change its volume. A lot-size change is therefore a cancel and a re-place, which is a
 * materially different act: the order loses its place in the queue, and between the two steps
 * price can move past the entry so the replacement is refused. That is not an implementation
 * detail to paper over — it changes the risk of the operation, so `planModification` reports it
 * as `requiresReplace` and the caller must surface it before anything is sent.
 *
 * Pure: numbers in, plan out. No I/O, no clock, no broker calls.
 */

import { moneyToPips, pipsToMoney, priceAt } from './ictOrderResize.js';

const n = (v) => Number(v);
// Number(null) is 0 and 0 is finite — the coercion behind seven separate defects in this
// codebase. Every optional number goes through this rather than a bare isFinite.
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(n(v)) ? null : n(v));
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

/** Statuses where an order is actually resting at the broker and can be modified. */
export const MODIFIABLE_STATUSES = new Set(['PLACED', 'SENT']);

/**
 * One leg of the ticket in all four units.
 *
 * Returns nulls rather than zeros when a leg is absent — an order with no take profit is a
 * deliberate choice on this desk (the ict-breaker SL-only profile), not a zero-dollar target.
 */
export function describeLeg({ entry, price, direction, lots, pipSize, pipValuePerLot, side }) {
  const e = num(entry), p = num(price), l = num(lots);
  const ps = num(pipSize), pv = num(pipValuePerLot);
  if (e === null || p === null || ps === null || ps <= 0) return null;
  const pips = Math.abs(p - e) / ps;
  const usd = (l !== null && pv !== null) ? pipsToMoney({ pips, lots: l, pipValuePerLot: pv }) : null;
  const buy = String(direction || '').toUpperCase() === 'BUY';
  // Which side of entry this leg actually sits on, so a mis-placed level is visible as such
  // rather than as a plausible-looking distance.
  const expected = side === 'stop' ? (buy ? p < e : p > e) : (buy ? p > e : p < e);
  return { price: p, pips: r1(pips), usd, side, correctSide: expected };
}

/**
 * The complete picture of an order as it stands right now.
 *
 * Built from what the broker holds, not from what was originally planned — an order that was
 * modified once already must describe its current state or the next edit is against a ghost.
 */
export function describeOrder(order, { pipSize, pipValuePerLot, contractSize = 100000, accountEquity = null } = {}) {
  const entry = num(order?.entry_price ?? order?.entry);
  const lots = num(order?.lots);
  const direction = order?.direction;
  const leg = (price, side) => describeLeg({ entry, price, direction, lots, pipSize, pipValuePerLot, side });

  const stop = leg(num(order?.stop_loss ?? order?.stopLoss), 'stop');
  const tp1 = leg(num(order?.take_profit_1 ?? order?.takeProfit1), 'target');
  const tp2 = leg(num(order?.take_profit_2 ?? order?.takeProfit2), 'target');
  const tp3 = leg(num(order?.take_profit_3 ?? order?.takeProfit3), 'target');

  const eq = num(accountEquity);
  const notional = (lots !== null && entry !== null)
    ? lots * (num(contractSize) ?? 100000) * (/JPY$/i.test(String(order?.symbol || '')) ? 1 : entry)
    : null;

  return {
    id: order?.id ?? null,
    symbol: order?.symbol ?? null,
    timeframe: order?.timeframe ?? null,
    direction: direction ?? null,
    orderType: order?.order_type ?? order?.orderType ?? null,
    status: order?.status ?? null,
    ticket: order?.ticket ?? null,
    entry, lots,
    stop, tp1, tp2, tp3,
    // R:R to the FINAL target. TP1 is roughly 1R by construction on most ladders, so computing
    // it from TP1 stamps "1" on every ticket regardless of the real draw.
    rr: (stop && (tp3 || tp1) && stop.pips > 0) ? r2(((tp3 || tp1).pips) / stop.pips) : null,
    riskUsd: stop?.usd ?? null,
    rewardUsd: (tp3 || tp1)?.usd ?? null,
    notional: notional === null ? null : Math.round(notional),
    notionalMultiple: (notional !== null && eq !== null && eq > 0) ? r1(notional / eq) : null,
    modifiable: MODIFIABLE_STATUSES.has(String(order?.status || '')),
  };
}

/**
 * Work out what a requested change actually means.
 *
 * Changes may arrive in ANY unit — a new price, a pip distance, or a dollar amount — and are
 * resolved to prices, because prices are what MT5 stores. Whichever unit the user typed, the
 * other three are recomputed from the result rather than carried over, so the four views can
 * never drift apart.
 */
export function planModification(order, changes = {}, ctx = {}) {
  const { pipSize, pipValuePerLot, digits = null } = ctx;
  const ps = num(pipSize), pv = num(pipValuePerLot);
  const entry = num(changes.entry) ?? num(order?.entry_price ?? order?.entry);
  const direction = order?.direction;
  const currentLots = num(order?.lots);
  const lots = num(changes.lots) ?? currentLots;

  if (entry === null || ps === null || ps <= 0) {
    return { ok: false, error: 'this order has no usable entry price or pip size' };
  }
  if (lots === null || lots <= 0) return { ok: false, error: 'a positive lot size is required' };

  /** Resolve one leg from whichever unit was supplied. */
  const resolve = (key, side, currentPrice) => {
    const asPrice = num(changes[`${key}Price`]);
    if (asPrice !== null) return asPrice;
    const asPips = num(changes[`${key}Pips`]);
    if (asPips !== null) return priceAt({ entry, direction, pips: asPips, pipSize: ps, side, digits });
    const asUsd = num(changes[`${key}Usd`]);
    if (asUsd !== null) {
      if (pv === null || pv <= 0) return currentPrice;
      const pips = moneyToPips({ usd: asUsd, lots, pipValuePerLot: pv });
      return pips === null ? currentPrice : priceAt({ entry, direction, pips, pipSize: ps, side, digits });
    }
    return currentPrice;
  };

  const next = {
    entry,
    lots,
    stopLoss: resolve('sl', 'stop', num(order?.stop_loss ?? order?.stopLoss)),
    takeProfit1: resolve('tp1', 'target', num(order?.take_profit_1 ?? order?.takeProfit1)),
    takeProfit2: resolve('tp2', 'target', num(order?.take_profit_2 ?? order?.takeProfit2)),
    takeProfit3: resolve('tp3', 'target', num(order?.take_profit_3 ?? order?.takeProfit3)),
  };

  const before = describeOrder(order, ctx);
  const after = describeOrder({
    ...order,
    entry_price: next.entry, lots: next.lots,
    stop_loss: next.stopLoss,
    take_profit_1: next.takeProfit1, take_profit_2: next.takeProfit2, take_profit_3: next.takeProfit3,
  }, ctx);

  // MT5 cannot change a pending order's VOLUME in place. That makes a lot change a cancel and a
  // re-place: the order loses queue position, and price can run past the entry in between. The
  // caller must show this before sending, so it is reported rather than handled silently.
  const lotChanged = currentLots !== null && Math.abs(lots - currentLots) > 1e-9;

  const changed = [];
  if (lotChanged) changed.push('lots');
  if (num(changes.entry) !== null && Math.abs(next.entry - num(order?.entry_price ?? order?.entry)) > 1e-12) changed.push('entry');
  for (const [key, prev, nxt] of [
    ['stop', num(order?.stop_loss ?? order?.stopLoss), next.stopLoss],
    ['tp1', num(order?.take_profit_1 ?? order?.takeProfit1), next.takeProfit1],
    ['tp2', num(order?.take_profit_2 ?? order?.takeProfit2), next.takeProfit2],
    ['tp3', num(order?.take_profit_3 ?? order?.takeProfit3), next.takeProfit3],
  ]) {
    if (prev === null && nxt === null) continue;
    if (prev === null || nxt === null || Math.abs(prev - nxt) > 1e-12) changed.push(key);
  }

  return {
    ok: true,
    before, after, next,
    changed,
    requiresReplace: lotChanged,
    replaceWarning: lotChanged
      ? 'MT5 cannot change a resting order\'s lot size. This cancels the order and places a new one — it loses its place in the queue, and if price reaches the entry in between the replacement can be refused.'
      : null,
    unchanged: changed.length === 0,
  };
}

/**
 * Check a planned modification before it is sent.
 *
 * Errors are what the broker will refuse. Warnings are judgement, and on a manual edit the user
 * overrules them — they resize from their own read of the market and asked for their numbers to
 * be passed through.
 */
export function validateModification(plan, {
  minStopDistance = null, pipSize = null, volMin = 0.01, volMax = null, volStep = 0.01,
  marketPrice = null, riskBudget = null,
} = {}) {
  const errors = [];
  const warnings = [];
  if (!plan?.ok) return { verdict: 'INVALID', errors: ['the modification could not be planned'], warnings };
  const a = plan.after;

  if (!plan.before.modifiable) {
    errors.push(`this order is ${String(plan.before.status || 'unknown').toLowerCase()} — only a resting order can be modified`);
  }

  // Legs on the wrong side of entry are the 10016 case: 29 of this account's rejections were a
  // target already behind the market.
  for (const [name, leg] of [['stop', a.stop], ['TP1', a.tp1], ['TP2', a.tp2], ['TP3', a.tp3]]) {
    if (leg && !leg.correctSide) errors.push(`${name} is on the wrong side of entry — MT5 would reject this`);
  }

  const ps = num(pipSize), msd = num(minStopDistance);
  if (msd !== null && a.stop && ps !== null && a.stop.pips * ps < msd) {
    errors.push(`the stop is ${(a.stop.pips * ps).toFixed(5)} from entry, inside the broker minimum of ${msd}`);
  }

  const min = num(volMin) ?? 0.01, max = num(volMax), step = num(volStep) ?? 0.01;
  if (a.lots !== null) {
    if (a.lots < min) errors.push(`lot size ${a.lots} is below the broker minimum of ${min}`);
    if (max !== null && a.lots > max) errors.push(`lot size ${a.lots} is above the broker maximum of ${max}`);
    if (Math.abs(a.lots / step - Math.round(a.lots / step)) > 1e-6) {
      errors.push(`lot size ${a.lots} is not a multiple of the broker step ${step}`);
    }
  }

  // A limit must still rest on the correct side of the CURRENT market, or it is no longer the
  // setup that was planned — it would fill instantly as a market order.
  const mkt = num(marketPrice);
  if (mkt !== null && a.entry !== null) {
    const buy = String(a.direction || '').toUpperCase() === 'BUY';
    if (buy && a.entry >= mkt) errors.push(`price ${mkt} is already at or below the buy-limit entry ${a.entry}`);
    if (!buy && a.entry <= mkt) errors.push(`price ${mkt} is already at or above the sell-limit entry ${a.entry}`);
  }

  // Judgement, not refusal.
  const budget = num(riskBudget);
  if (budget !== null && a.riskUsd !== null && a.riskUsd > budget + 0.005) {
    warnings.push(`risking $${a.riskUsd} is above your $${budget} per-trade budget (${(a.riskUsd / budget).toFixed(1)}x)`);
  }
  if (a.stop && a.stop.pips < 5) {
    warnings.push(`a ${a.stop.pips}-pip stop is inside market noise — stops under 5 pips returned -0.496R over 38 trades on this account`);
  }
  if (a.rr !== null && a.rr < 1.5) {
    warnings.push(`reward-to-risk is ${a.rr}:1 after this change`);
  }
  if (a.notionalMultiple !== null && a.notionalMultiple > 20) {
    warnings.push(`this is ${a.notionalMultiple}x your account in notional — your risk is capped, the margin required is not`);
  }
  if (plan.requiresReplace) warnings.push(plan.replaceWarning);

  return { verdict: errors.length ? 'REJECT' : warnings.length ? 'RISKY' : 'OK', errors, warnings };
}
