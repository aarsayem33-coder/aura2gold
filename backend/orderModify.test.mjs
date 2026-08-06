import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeLeg, describeOrder, planModification, validateModification, MODIFIABLE_STATUSES,
} from './orderModify.js';

// EURUSD-like: $10 per pip per lot, 0.0001 pip, 5 digits.
const CTX = { pipSize: 0.0001, pipValuePerLot: 10, digits: 5, contractSize: 100000 };

const order = (o = {}) => ({
  id: 'ictorder:1', symbol: 'EURUSD', timeframe: 'M5', direction: 'BUY',
  order_type: 'BUY_LIMIT', status: 'PLACED', ticket: '123',
  entry_price: 1.1000, stop_loss: 1.0980, take_profit_1: 1.1020, take_profit_3: 1.1060,
  lots: 0.5, ...o,
});

// ── the four units ───────────────────────────────────────────────────────────

test('a leg is described in price, pips and dollars at once', () => {
  // Showing only prices makes a 2-pip stop look like a 40-pip one; showing only dollars hides
  // that $80 of risk became 3.2 lots. Both have already happened on this account.
  const leg = describeLeg({ entry: 1.1, price: 1.098, direction: 'BUY', lots: 0.5, ...CTX, side: 'stop' });
  assert.equal(leg.price, 1.098);
  assert.equal(leg.pips, 20);
  assert.equal(leg.usd, 100, '20 pips x 0.5 lots x $10');
});

test('dollar value scales with lot size', () => {
  const at = (lots) => describeLeg({ entry: 1.1, price: 1.098, direction: 'BUY', lots, ...CTX, side: 'stop' }).usd;
  assert.equal(at(0.5), 100);
  assert.equal(at(1), 200);
  assert.equal(at(0.1), 20);
});

test('a leg on the wrong side of entry is flagged, not silently plausible', () => {
  // This is the 10016 case — 29 of this account's rejections were a target behind the market.
  const good = describeLeg({ entry: 1.1, price: 1.098, direction: 'BUY', lots: 0.5, ...CTX, side: 'stop' });
  const bad = describeLeg({ entry: 1.1, price: 1.102, direction: 'BUY', lots: 0.5, ...CTX, side: 'stop' });
  assert.equal(good.correctSide, true);
  assert.equal(bad.correctSide, false, 'a buy stop above entry is wrong');
  const badTp = describeLeg({ entry: 1.1, price: 1.098, direction: 'BUY', lots: 0.5, ...CTX, side: 'target' });
  assert.equal(badTp.correctSide, false, 'a buy target below entry is wrong');
});

test('an absent leg is null, never a zero-dollar target', () => {
  // An order with no take profit is a deliberate choice on this desk (the SL-only profile).
  assert.equal(describeLeg({ entry: 1.1, price: null, direction: 'BUY', lots: 0.5, ...CTX, side: 'target' }), null);
  const d = describeOrder(order({ take_profit_1: null, take_profit_3: null }), CTX);
  assert.equal(d.tp1, null);
  assert.equal(d.tp3, null);
  assert.equal(d.stop.pips, 20, 'the stop is still described');
});

test('JPY and gold scale correctly', () => {
  const jpy = describeLeg({ entry: 150, price: 149.8, direction: 'BUY', lots: 1, pipSize: 0.01, pipValuePerLot: 6.5, side: 'stop' });
  assert.equal(jpy.pips, 20);
  assert.equal(jpy.usd, 130);
  const gold = describeLeg({ entry: 4000, price: 3998, direction: 'BUY', lots: 0.1, pipSize: 0.1, pipValuePerLot: 1, side: 'stop' });
  assert.equal(gold.pips, 20);
});

// ── the whole order ──────────────────────────────────────────────────────────

test('the order is summarised with risk, reward and R:R', () => {
  const d = describeOrder(order(), CTX);
  assert.equal(d.riskUsd, 100, '20 pips');
  assert.equal(d.rewardUsd, 300, '60 pips to TP3');
  assert.equal(d.rr, 3);
});

test('R:R is measured to the FINAL target, not TP1', () => {
  // TP1 is ~1R by construction on most ladders; computing from it stamps "1" on every ticket.
  assert.equal(describeOrder(order(), CTX).rr, 3);
  assert.equal(describeOrder(order({ take_profit_3: null }), CTX).rr, 1, 'falls back to TP1 only when TP3 is absent');
});

test('notional exposure is reported next to the dollar risk', () => {
  // The dollar risk can be inside budget while the POSITION is many multiples of the account —
  // which is what margin, not risk, is measured against.
  const d = describeOrder(order({ lots: 5 }), { ...CTX, accountEquity: 10000 });
  assert.equal(d.notional, 550000);
  assert.equal(d.notionalMultiple, 55);
});

test('only a resting order is modifiable', () => {
  for (const s of ['PLACED', 'SENT']) assert.equal(describeOrder(order({ status: s }), CTX).modifiable, true);
  for (const s of ['QUEUED', 'CLOSED', 'EXPIRED', 'CANCELLING']) {
    assert.equal(describeOrder(order({ status: s }), CTX).modifiable, false, `${s} is not modifiable`);
  }
  assert.deepEqual([...MODIFIABLE_STATUSES].sort(), ['PLACED', 'SENT']);
});

// ── editing in any unit ──────────────────────────────────────────────────────

test('a stop can be moved by price, by pips, or by dollars — same result', () => {
  // Whichever unit is typed, the other three are recomputed from the result, so the four views
  // can never drift apart.
  const byPrice = planModification(order(), { slPrice: 1.0960 }, CTX);
  const byPips = planModification(order(), { slPips: 40 }, CTX);
  const byUsd = planModification(order(), { slUsd: 200 }, CTX);
  for (const p of [byPrice, byPips, byUsd]) {
    assert.equal(p.ok, true);
    assert.equal(p.after.stop.price, 1.096);
    assert.equal(p.after.stop.pips, 40);
    assert.equal(p.after.stop.usd, 200);
  }
});

test('an unedited leg keeps its current price', () => {
  const p = planModification(order(), { slPips: 40 }, CTX);
  assert.equal(p.after.tp1.price, 1.102, 'TP1 untouched');
  assert.equal(p.after.tp3.price, 1.106);
  assert.deepEqual(p.changed, ['stop']);
});

test('changing lots rescales every dollar figure without moving a price', () => {
  const p = planModification(order(), { lots: 1 }, CTX);
  assert.equal(p.after.stop.price, 1.098, 'prices are unchanged');
  assert.equal(p.after.stop.pips, 20);
  assert.equal(p.after.stop.usd, 200, 'but the dollar risk doubles');
  assert.equal(p.before.stop.usd, 100);
});

test('a lot change requires a cancel-and-replace and says so', () => {
  // MT5 cannot change a resting order's volume in place. That is a materially different act —
  // it loses queue position and can be refused if price moved — so it must be surfaced.
  const p = planModification(order(), { lots: 1 }, CTX);
  assert.equal(p.requiresReplace, true);
  assert.match(p.replaceWarning, /cannot change a resting order's lot size/);
  assert.ok(p.changed.includes('lots'));
});

test('a price-only change does NOT require a replace', () => {
  const p = planModification(order(), { slPips: 40, tp1Pips: 50 }, CTX);
  assert.equal(p.requiresReplace, false);
  assert.equal(p.replaceWarning, null);
});

test('changing the entry re-bases every distance', () => {
  const p = planModification(order(), { entry: 1.0990 }, CTX);
  assert.equal(p.after.entry, 1.099);
  assert.equal(p.after.stop.pips, 10, 'the stop is now 10 pips away, not 20');
  assert.ok(p.changed.includes('entry'));
});

test('a no-op edit reports nothing changed', () => {
  const p = planModification(order(), {}, CTX);
  assert.equal(p.unchanged, true);
  assert.deepEqual(p.changed, []);
});

test('a target can be removed by setting it null', () => {
  const p = planModification(order(), { tp3Price: null }, CTX);
  assert.equal(p.after.tp3.price, 1.106, 'null means "leave it", not "clear it"');
});

test('SELL mirrors BUY when editing in pips', () => {
  const sell = order({ direction: 'SELL', stop_loss: 1.1020, take_profit_1: 1.098, take_profit_3: 1.094 });
  const p = planModification(sell, { slPips: 40 }, CTX);
  assert.equal(p.after.stop.price, 1.104, 'a sell stop moves UP');
  assert.equal(p.after.stop.correctSide, true);
});

test('a broken order is refused rather than planned', () => {
  assert.equal(planModification(order({ entry_price: null }), { slPips: 20 }, CTX).ok, false);
  assert.equal(planModification(order(), { lots: 0 }, CTX).ok, false);
});

// ── validation ───────────────────────────────────────────────────────────────

test('a sound modification passes clean', () => {
  const p = planModification(order(), { slPips: 25 }, CTX);
  const v = validateModification(p, { pipSize: 0.0001, riskBudget: 200 });
  assert.equal(v.verdict, 'OK');
  assert.equal(v.errors.length, 0);
});

test('a leg on the wrong side is an ERROR', () => {
  const p = planModification(order(), { slPrice: 1.1020 }, CTX);
  const v = validateModification(p, { pipSize: 0.0001 });
  assert.equal(v.verdict, 'REJECT');
  assert.ok(v.errors.some((e) => /wrong side of entry/.test(e)));
});

test('a stop inside the broker minimum is an ERROR', () => {
  const p = planModification(order(), { slPips: 1 }, CTX);
  const v = validateModification(p, { pipSize: 0.0001, minStopDistance: 0.0005 });
  assert.equal(v.verdict, 'REJECT');
  assert.ok(v.errors.some((e) => /broker minimum/.test(e)));
});

test('a non-resting order cannot be modified', () => {
  const p = planModification(order({ status: 'CLOSED' }), { slPips: 30 }, CTX);
  const v = validateModification(p, { pipSize: 0.0001 });
  assert.equal(v.verdict, 'REJECT');
  assert.ok(v.errors.some((e) => /only a resting order/.test(e)));
});

test('a limit that would fill instantly against the market is refused', () => {
  // Otherwise it stops being the setup that was planned and becomes a market order.
  const p = planModification(order(), { entry: 1.1050 }, CTX);
  const v = validateModification(p, { pipSize: 0.0001, marketPrice: 1.1000 });
  assert.equal(v.verdict, 'REJECT');
  assert.ok(v.errors.some((e) => /already at or below the buy-limit/.test(e)));
});

test('broker lot rules are enforced', () => {
  const step = validateModification(planModification(order(), { lots: 0.015 }, CTX), { volStep: 0.01, pipSize: 0.0001 });
  assert.ok(step.errors.some((e) => /multiple of the broker step/.test(e)));
  const small = validateModification(planModification(order(), { lots: 0.005 }, CTX), { volMin: 0.01, pipSize: 0.0001 });
  assert.ok(small.errors.some((e) => /below the broker minimum/.test(e)));
});

test('budget, tight stops and notional are WARNINGS, never refusals', () => {
  // The user edits from their own read of the market and asked for their numbers to be passed
  // through; only what the broker refuses is binding.
  const p = planModification(order({ lots: 5 }), { slPips: 2 }, { ...CTX, accountEquity: 10000 });
  const v = validateModification(p, { pipSize: 0.0001, riskBudget: 80 });
  assert.notEqual(v.verdict, 'REJECT');
  assert.ok(v.warnings.some((w) => /above your \$80 per-trade budget/.test(w)));
  assert.ok(v.warnings.some((w) => /-0\.496R/.test(w)));
  assert.ok(v.warnings.some((w) => /notional/.test(w)));
});

test('the cancel-and-replace caveat rides along as a warning', () => {
  const v = validateModification(planModification(order(), { lots: 1 }, CTX), { pipSize: 0.0001 });
  assert.ok(v.warnings.some((w) => /cannot change a resting order's lot size/.test(w)));
});
