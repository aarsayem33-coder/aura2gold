import assert from 'node:assert/strict';
import test from 'node:test';
import { slippageVerdict, resizeLotsToStop, SLIPPAGE_DEFAULTS } from './slippageGate.js';

const GOLD = { pip: 0.1, pipValuePerLot: 10 };
// Ticket 508997768 as it actually happened.
const REAL = { direction: 'BUY', plannedEntry: 4077.9, stopLoss: 4072.68, pip: 0.1 };

test('the four collapsed tickets are all refused at the 25% default', () => {
  // Every one of these reached MT5 and rewrote its own risk/reward. The gate exists for them.
  const cases = [
    { name: '508997768 XAUUSD', direction: 'BUY', plannedEntry: 4077.9, stopLoss: 4072.68, livePrice: 4081.55, pip: 0.1 },
    { name: '508993270 EURUSD', direction: 'BUY', plannedEntry: 1.1508, stopLoss: 1.15046, livePrice: 1.15101, pip: 0.0001 },
    { name: '508286732 USDJPY', direction: 'BUY', plannedEntry: 157.0, stopLoss: 156.9, livePrice: 157.079, pip: 0.01 },
    { name: '507898267 USDCHF', direction: 'SELL', plannedEntry: 0.8, stopLoss: 0.8004, livePrice: 0.79964, pip: 0.0001 },
  ];
  for (const c of cases) {
    const v = slippageVerdict(c);
    assert.equal(v.allowed, false, `${c.name} should be refused (moved ${v.pctOfStop}% of the stop)`);
    assert.match(v.reason, /setup has moved/);
    assert.ok(v.pctOfStop > 25, `${c.name} moved ${v.pctOfStop}%`);
  }
});

test('the real gold ticket is quantified exactly', () => {
  const v = slippageVerdict({ ...REAL, livePrice: 4081.55 });
  assert.equal(v.deviationPips, 36.5);
  assert.equal(v.pctOfStop, 69.9, '36.5 pips against a 52.2 pip stop');
  assert.equal(v.allowed, false);
});

test('a normal one-to-two pip fill passes untouched', () => {
  const v = slippageVerdict({ ...REAL, livePrice: 4078.0 });
  assert.equal(v.allowed, true);
  assert.equal(v.deviationPips, 1);
  assert.match(v.reason, /within tolerance/);
});

test('a better fill is never refused', () => {
  // Filling below a planned buy widens the reward and shrinks the risk. Refusing it would
  // throw away a better trade than the one planned.
  const v = slippageVerdict({ ...REAL, livePrice: 4070 });
  assert.equal(v.allowed, true);
  assert.match(v.reason, /at or better/);
  assert.ok(v.deviation < 0);
});

test('SELL slippage is measured in the opposite direction', () => {
  const sell = { direction: 'SELL', plannedEntry: 4077.9, stopLoss: 4083.12, pip: 0.1 };
  // Selling LOWER than planned is the adverse case.
  assert.equal(slippageVerdict({ ...sell, livePrice: 4074 }).allowed, false);
  // Selling higher is better.
  assert.equal(slippageVerdict({ ...sell, livePrice: 4080 }).allowed, true);
});

test('tolerance scales with the stop, which is the whole point of using a percentage', () => {
  // 3 pips is nothing on a 300-pip gold stop...
  const wide = slippageVerdict({ direction: 'BUY', plannedEntry: 4000, stopLoss: 3970, livePrice: 4000.3, pip: 0.1 });
  assert.equal(wide.allowed, true);
  // ...and fatal on a 4-pip EURUSD stop.
  const tight = slippageVerdict({ direction: 'BUY', plannedEntry: 1.1, stopLoss: 1.0996, livePrice: 1.1003, pip: 0.0001 });
  assert.equal(tight.allowed, false, 'the same 3 pips must be refused here');
});

test('the tolerance is configurable in both directions', () => {
  const at = (tolerancePct) => slippageVerdict({ ...REAL, livePrice: 4079.2, tolerancePct });
  assert.equal(at(25).allowed, true, '24.9% is inside 25');
  assert.equal(at(10).allowed, false, 'tightening must refuse it');
  assert.equal(at(80).allowed, true, 'loosening must permit it');
  assert.equal(at(0).allowed, false, 'zero tolerance permits only equal-or-better fills');
  assert.equal(SLIPPAGE_DEFAULTS.tolerancePct, 25);
});

test('an unreadable tolerance blocks rather than waving everything through', () => {
  // `undefined` is excluded on purpose: a JS default parameter fires only on undefined, so
  // omitting the field means "use the 25% default", not "the setting is broken".
  for (const bad of [null, '', 'abc', -5]) {
    const v = slippageVerdict({ ...REAL, livePrice: 4079, tolerancePct: bad });
    assert.equal(v.allowed, false, `tolerance ${String(bad)} must not permit the trade`);
  }
  assert.equal(slippageVerdict({ ...REAL, livePrice: 4079 }).allowed, true, 'omitted tolerance falls back to the default');
});

test('missing prices do not silently block every trade', () => {
  // Failing open here is deliberate: the gate is an improvement, not a new single point of
  // failure that halts trading when one field is absent.
  const v = slippageVerdict({ direction: 'BUY', plannedEntry: null, livePrice: 4080, stopLoss: 4070 });
  assert.equal(v.allowed, true);
  assert.match(v.reason, /insufficient data/);
});

test('a zero stop distance is refused, not divided by', () => {
  const v = slippageVerdict({ direction: 'BUY', plannedEntry: 4000, stopLoss: 4000, livePrice: 4001 });
  assert.equal(v.allowed, false);
  assert.match(v.reason, /zero/);
});

// ── lot resize ───────────────────────────────────────────────────────────────

test('lots are resized so the budget survives a wider real stop', () => {
  // Gold: $40 budget, stop now 88.7 pips away from the live price instead of 52.2.
  const r = resizeLotsToStop({ riskAmount: 40, livePrice: 4081.55, stopLoss: 4072.68, ...GOLD });
  assert.equal(r.stopPips, 88.7);
  assert.equal(r.lots, 0.04, '0.08 lots would have risked $71');
  assert.ok(r.riskAtStop <= 40, `risk ${r.riskAtStop} must stay inside budget`);
  assert.equal(r.overBudget, false);
});

test('lots floor to the step rather than rounding up past budget', () => {
  // 65 pips x $10/pip = $650 per lot; $45.4 buys 0.0698 lots, which must floor to 0.06.
  const r = resizeLotsToStop({ riskAmount: 45.4, livePrice: 4006.5, stopLoss: 4000, ...GOLD });
  assert.equal(r.lots, 0.06);
  assert.ok(r.riskAtStop <= 45.4);
});

test('an unaffordable broker minimum is reported, never hidden', () => {
  const r = resizeLotsToStop({ riskAmount: 26, livePrice: 4065, stopLoss: 4000, ...GOLD });
  assert.equal(r.lots, 0.01);
  assert.equal(r.riskAtStop, 65);
  assert.equal(r.overBudget, true);
  assert.equal(r.minForced, true);
});

test('volume max caps the size', () => {
  const r = resizeLotsToStop({ riskAmount: 100000, livePrice: 4001, stopLoss: 4000, ...GOLD, volMax: 5 });
  assert.equal(r.lots, 5);
});

test('resize refuses to guess on missing inputs', () => {
  assert.equal(resizeLotsToStop({ riskAmount: 0, livePrice: 4081, stopLoss: 4072, ...GOLD }), null);
  assert.equal(resizeLotsToStop({ riskAmount: 40, livePrice: 4072, stopLoss: 4072, ...GOLD }), null);
  assert.equal(resizeLotsToStop({ riskAmount: 40, livePrice: 4081, stopLoss: 4072, pip: 0, pipValuePerLot: 10 }), null);
  assert.equal(resizeLotsToStop({ riskAmount: 40, livePrice: 4081, stopLoss: 4072, pip: 0.1, pipValuePerLot: null }), null);
});

test('together: a tolerable slip keeps the budget instead of blowing it', () => {
  // 20% of the stop — allowed — but the stop is now 20% further away, so the size must drop.
  const live = 4077.9 + 0.1 * 10.4;      // 10.4 pips adverse on a 52.2 pip stop
  const v = slippageVerdict({ ...REAL, livePrice: live });
  assert.equal(v.allowed, true);
  const r = resizeLotsToStop({ riskAmount: 40, livePrice: live, stopLoss: 4072.68, ...GOLD });
  assert.ok(r.stopPips > 52.2, 'the real stop is wider than planned');
  assert.ok(r.riskAtStop <= 40, 'yet the money at risk is unchanged');
});
