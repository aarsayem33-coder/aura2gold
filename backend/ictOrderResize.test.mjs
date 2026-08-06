import assert from 'node:assert/strict';
import test from 'node:test';
import {
  moneyToPips, pipsToMoney, lotsForMoney, priceAt, resizeOrder, validateResize,
  suggestSizing, RESIZE_LIMITS,
} from './ictOrderResize.js';

// EURUSD-like: $10 per pip per lot, 0.0001 pip, 5 digits.
const FX = { pipValuePerLot: 10, pipSize: 0.0001, digits: 5 };

// ── money <-> pips ───────────────────────────────────────────────────────────

test('dollars convert to pips at the given lot size', () => {
  assert.equal(moneyToPips({ usd: 100, lots: 1, pipValuePerLot: 10 }), 10);
  assert.equal(moneyToPips({ usd: 100, lots: 2, pipValuePerLot: 10 }), 5, 'twice the lots, half the stop');
  assert.equal(moneyToPips({ usd: 50, lots: 0.5, pipValuePerLot: 10 }), 10);
});

test('the money/stop trade-off is exactly the mechanism behind 5-lot 1.7-pip tickets', () => {
  // $85 of risk buys 1.7 pips at 5 lots and 85 pips at 0.1 — same money, wildly different trade.
  assert.equal(moneyToPips({ usd: 85, lots: 5, pipValuePerLot: 10 }), 1.7);
  assert.equal(moneyToPips({ usd: 85, lots: 0.1, pipValuePerLot: 10 }), 85);
});

test('pips convert back to dollars', () => {
  assert.equal(pipsToMoney({ pips: 10, lots: 1, pipValuePerLot: 10 }), 100);
  assert.equal(pipsToMoney({ pips: -10, lots: 1, pipValuePerLot: 10 }), -100);
});

test('nonsense inputs give null, never a zero that reads as free', () => {
  for (const bad of [null, undefined, '', 0, -5]) {
    assert.equal(moneyToPips({ usd: bad, lots: 1, pipValuePerLot: 10 }), null);
  }
  assert.equal(moneyToPips({ usd: 100, lots: 0, pipValuePerLot: 10 }), null);
  assert.equal(moneyToPips({ usd: 100, lots: 1, pipValuePerLot: null }), null);
});

// ── lot sizing ───────────────────────────────────────────────────────────────

test('lots are rounded DOWN so the typed budget is never exceeded', () => {
  // 85/(20*10) = 0.425 -> 0.42, not 0.43.
  assert.equal(lotsForMoney({ usd: 85, pips: 20, pipValuePerLot: 10, volStep: 0.01 }), 0.42);
});

test('broker minimum and maximum are respected', () => {
  assert.equal(lotsForMoney({ usd: 1, pips: 100, pipValuePerLot: 10, volMin: 0.01 }), 0.01);
  assert.equal(lotsForMoney({ usd: 10000, pips: 1, pipValuePerLot: 10, volMax: 5 }), 5);
});

// ── price placement ──────────────────────────────────────────────────────────

test('a buy stop sits below entry and its target above', () => {
  assert.equal(priceAt({ entry: 1.1, direction: 'BUY', pips: 20, pipSize: 0.0001, side: 'stop', digits: 5 }), 1.098);
  assert.equal(priceAt({ entry: 1.1, direction: 'BUY', pips: 20, pipSize: 0.0001, side: 'target', digits: 5 }), 1.102);
});

test('a sell stop sits above entry and its target below', () => {
  // Getting this backwards is the 10016 "invalid stops" case — 29 of this account's rejections.
  assert.equal(priceAt({ entry: 1.1, direction: 'SELL', pips: 20, pipSize: 0.0001, side: 'stop', digits: 5 }), 1.102);
  assert.equal(priceAt({ entry: 1.1, direction: 'SELL', pips: 20, pipSize: 0.0001, side: 'target', digits: 5 }), 1.098);
});

test('prices are rounded to the symbol digits', () => {
  const p = priceAt({ entry: 150, direction: 'BUY', pips: 13.37, pipSize: 0.01, side: 'target', digits: 3 });
  assert.equal(p, 150.134);
});

// ── building the ticket ──────────────────────────────────────────────────────

const buy = (o = {}) => resizeOrder({
  entry: 1.1, direction: 'BUY', lots: 0.5, slUsd: 50, tpUsd: 50, tp3Usd: 150, ...FX, ...o,
});

test('a full ticket is built from money alone', () => {
  const t = buy();
  assert.equal(t.ok, true);
  assert.equal(t.stopPips, 10, '$50 over 0.5 lots at $10/pip = 10 pips');
  assert.equal(t.stopLoss, 1.099);
  assert.equal(t.takeProfit1, 1.101);
  assert.equal(t.takeProfit3, 1.103);
  assert.equal(t.riskUsd, 50);
});

test('R:R is measured to the FINAL target, not TP1', () => {
  // TP1 is ~1R by construction on most ladders; computing from it stamps "1" on every ticket.
  assert.equal(buy().rr, 3, '$150 reward over $50 risk');
  assert.equal(buy({ tp3Usd: null }).rr, 1, 'falls back to TP1 only when TP3 is absent');
});

test('targets are optional and absent ones stay null', () => {
  const t = buy({ tpUsd: null, tp2Usd: null, tp3Usd: null });
  assert.equal(t.ok, true);
  assert.equal(t.takeProfit1, null);
  assert.equal(t.takeProfit3, null);
  assert.equal(t.stopLoss, 1.099, 'the stop is still set');
});

test('a SELL ticket mirrors a BUY exactly', () => {
  const b = buy();
  const s = buy({ direction: 'SELL' });
  // Compared with a tolerance: these are binary floats, so equal distances differ in the last bits.
  assert.ok(Math.abs(Math.abs(s.stopLoss - 1.1) - Math.abs(b.stopLoss - 1.1)) < 1e-12);
  assert.ok(Math.abs(Math.abs(s.takeProfit3 - 1.1) - Math.abs(b.takeProfit3 - 1.1)) < 1e-12);
  assert.ok(s.stopLoss > 1.1 && s.takeProfit3 < 1.1, 'a sell stops above and targets below');
  assert.equal(s.stopPips, b.stopPips);
  assert.equal(s.rr, b.rr);
});

test('missing essentials are refused rather than guessed', () => {
  assert.equal(resizeOrder({ entry: null, direction: 'BUY', lots: 1, slUsd: 50, ...FX }).ok, false);
  assert.equal(resizeOrder({ entry: 1.1, direction: 'BUY', lots: 0, slUsd: 50, ...FX }).ok, false);
  assert.equal(resizeOrder({ entry: 1.1, direction: 'BUY', lots: 1, slUsd: null, ...FX }).ok, false);
  assert.equal(resizeOrder({ entry: 1.1, direction: 'BUY', lots: 1, slUsd: 50, pipValuePerLot: 0, pipSize: 0.0001 }).ok, false);
});

// ── the judgement ────────────────────────────────────────────────────────────

test('a sound ticket passes clean', () => {
  const v = validateResize({ ticket: buy({ lots: 0.1, slUsd: 50 }), symbol: 'EURUSD', riskBudget: 85, pipSize: 0.0001 });
  assert.equal(v.verdict, 'OK');
  assert.equal(v.errors.length, 0);
  assert.equal(v.warnings.length, 0);
});

test('a sub-5-pip stop is flagged with the measured number, not a rule of thumb', () => {
  const v = validateResize({ ticket: buy({ lots: 5, slUsd: 85 }), symbol: 'EURUSD', riskBudget: 85, pipSize: 0.0001 });
  assert.equal(v.verdict, 'RISKY');
  assert.ok(v.warnings.some((w) => /-0\.496R/.test(w)), 'must cite the measured expectancy');
});

test('exceeding the budget WARNS but never blocks a manual ticket', () => {
  // The user resizes from their own read of the market and asked for their numbers to reach MT5.
  // Only things the broker itself refuses are binding; a risk opinion is theirs to overrule.
  const v = validateResize({ ticket: buy({ slUsd: 500 }), symbol: 'EURUSD', riskBudget: 85, pipSize: 0.0001 });
  assert.notEqual(v.verdict, 'REJECT', 'a budget overage must stay placeable');
  assert.equal(v.overBudget, true);
  assert.ok(v.warnings.some((w) => /above your \$85 per-trade budget/.test(w)));
  assert.equal(v.errors.length, 0);
});

test('broker-fatal problems still REJECT even on a manual ticket', () => {
  // Passing these through would only produce a 10016 at the EA.
  const stop = validateResize({ ticket: buy({ lots: 5, slUsd: 85 }), minStopDistance: 0.0005, pipSize: 0.0001 });
  assert.equal(stop.verdict, 'REJECT');
  const lot = validateResize({ ticket: buy({ lots: 0.005 }), volMin: 0.01, pipSize: 0.0001 });
  assert.equal(lot.verdict, 'REJECT');
});

test('a stop inside the broker minimum is caught here, not as a 10016 at the EA', () => {
  const v = validateResize({
    ticket: buy({ lots: 5, slUsd: 85 }), symbol: 'EURUSD',
    minStopDistance: 0.0005, pipSize: 0.0001,
  });
  assert.equal(v.verdict, 'REJECT');
  assert.ok(v.errors.some((e) => /broker minimum/.test(e)));
});

test('broker lot rules are enforced', () => {
  const t = buy({ lots: 0.005 });
  assert.ok(validateResize({ ticket: t, volMin: 0.01 }).errors.some((e) => /below the broker minimum/.test(e)));
  assert.ok(validateResize({ ticket: buy({ lots: 50 }), volMax: 10 }).errors.some((e) => /above the broker maximum/.test(e)));
  assert.ok(validateResize({ ticket: buy({ lots: 0.015 }), volStep: 0.01 }).errors.some((e) => /multiple of the broker step/.test(e)));
});

test('friction is reported as a share of risk, which is what makes tight stops fail', () => {
  const v = validateResize({ ticket: buy({ lots: 5, slUsd: 85 }), symbol: 'EURUSD', pipSize: 0.0001 });
  assert.ok(v.warnings.some((w) => /eat \d+% of this risk/.test(w)));
});

test('a stop inside the spread or a fraction of ATR is warned', () => {
  const spread = validateResize({ ticket: buy({ lots: 2, slUsd: 50 }), pipSize: 0.0001, spreadPips: 2 });
  assert.ok(spread.warnings.some((w) => /spread alone/.test(w)));
  const atr = validateResize({ ticket: buy({ lots: 2, slUsd: 50 }), pipSize: 0.0001, atrPips: 40 });
  assert.ok(atr.warnings.some((w) => /x ATR/.test(w)));
});

test('a poor reward-to-risk is warned', () => {
  const v = validateResize({ ticket: buy({ lots: 0.1, slUsd: 50, tpUsd: 50, tp3Usd: 50 }), pipSize: 0.0001 });
  assert.ok(v.warnings.some((w) => /reward-to-risk is 1:1/.test(w)));
});

test('notional exposure is judged separately from dollar risk', () => {
  // The exact case found live: risk correctly capped at $85 while the position is 65x the account.
  const v = validateResize({
    ticket: buy({ lots: 5, slUsd: 85 }), symbol: 'EURUSD',
    accountEquity: 10000, entryPrice: 1.1, contractSize: 100000, pipSize: 0.0001,
  });
  assert.ok(v.warnings.some((w) => /x your \$10,000 account/.test(w)));
  assert.ok(v.notes.some((nn) => /notional/.test(nn)));
});

test('a broker-fatal error outranks warnings in the verdict', () => {
  const v = validateResize({
    // 5 lots against $85 is a 1.7-pip stop = 0.00017, genuinely inside the broker minimum.
    ticket: buy({ lots: 5, slUsd: 85 }), symbol: 'EURUSD', riskBudget: 50,
    minStopDistance: 0.0005, pipSize: 0.0001,
  });
  assert.equal(v.verdict, 'REJECT', 'the broker minimum stop is binding');
  assert.ok(v.warnings.length > 0, 'warnings are still reported alongside');
  assert.equal(v.overBudget, true, 'and the budget overage is still surfaced');
});

// ── the suggestion ───────────────────────────────────────────────────────────

test('the suggestion answers "what lot size WOULD be right" with a number', () => {
  const s = suggestSizing({ riskUsd: 85, pipValuePerLot: 10, atrPips: 40 });
  assert.equal(s.suggestedStopPips, 20, 'half of a 40-pip ATR');
  assert.equal(s.suggestedLots, 0.42, '85/(20*10) rounded down to the step');
  assert.match(s.why, /ATR/);
});

test('the suggestion widens for spread when spread dominates', () => {
  const s = suggestSizing({ riskUsd: 85, pipValuePerLot: 10, atrPips: 4, spreadPips: 12 });
  assert.equal(s.suggestedStopPips, 36, 'three spreads beats both ATR/2 and the 5-pip floor');
});

test('the suggestion never falls below the measured floor', () => {
  const s = suggestSizing({ riskUsd: 85, pipValuePerLot: 10, atrPips: 2 });
  assert.equal(s.suggestedStopPips, RESIZE_LIMITS.minStopPips);
});

test('the suggestion NEVER advises tightening an already-healthy stop', () => {
  // Suggesting a 6-pip stop to someone running 60 would push them into the -0.496R band the
  // whole feature exists to keep them out of.
  assert.equal(suggestSizing({ riskUsd: 19, pipValuePerLot: 6.34, atrPips: 13.2, currentStopPips: 60 }), null);
  const s = suggestSizing({ riskUsd: 19, pipValuePerLot: 6.34, atrPips: 13.2, currentStopPips: 1 });
  assert.ok(s && s.suggestedStopPips > 1, 'a 1-pip stop still gets rescued');
});

test('the suggestion is null when it cannot be computed', () => {
  assert.equal(suggestSizing({ riskUsd: null, pipValuePerLot: 10 }), null);
  assert.equal(suggestSizing({ riskUsd: 85, pipValuePerLot: 0 }), null);
});

// ── the default path must stay untouched ─────────────────────────────────────

test('resizing is opt-in: with no override the module is never consulted', () => {
  // This file exports pure helpers only. The place-order endpoint calls them exclusively inside
  // `if (req.body?.override)`, so an ordinary "Place limit" click reaches none of this code and
  // writes exactly what it always wrote. The guard here is that resizeOrder REFUSES rather than
  // inventing a ticket when handed nothing — if it ever returned a usable default, a bug in the
  // caller could silently start resizing every order.
  assert.equal(resizeOrder({}).ok, false);
  assert.equal(resizeOrder({ entry: 1.1, direction: 'BUY' }).ok, false, 'no lots, no ticket');
  assert.equal(resizeOrder({ entry: 1.1, direction: 'BUY', lots: 0.1, ...FX }).ok, false, 'no risk, no ticket');
});
