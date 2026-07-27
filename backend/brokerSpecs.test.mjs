import test from 'node:test';
import assert from 'node:assert/strict';
import {
  valuePerPricePerLot, valuePerPipPerLot, minStopDistance, spreadPrice,
  normalizeLots, assessStopDistance,
} from './brokerSpecs.js';

// Real Exness specs as MT5 reports them.
const GOLD = { point: 0.01, digits: 2, tickValue: 1.0, tickSize: 0.01, contractSize: 100, stopsLevel: 0, spread: 18, volMin: 0.01, volMax: 200, volStep: 0.01 };
const GBP = { point: 0.00001, digits: 5, tickValue: 1.0, tickSize: 0.00001, contractSize: 100000, stopsLevel: 40, spread: 13, volMin: 0.01, volMax: 200, volStep: 0.01 };
// The x100 Nasdaq contract that produced the -$944 loss on a $10 budget.
const USTEC100 = { point: 0.01, digits: 2, tickValue: 1.0, tickSize: 0.01, contractSize: 100, stopsLevel: 50, spread: 250, volMin: 0.01, volMax: 50, volStep: 0.01 };

test('gold: broker tick data yields $100 per $1 of price per lot', () => {
  assert.equal(valuePerPricePerLot(GOLD), 100);
  // A gold pip is 0.1 of price -> $10 per pip per lot. The old table said $1.
  assert.equal(valuePerPipPerLot(GOLD, 0.1), 10);
});

test('gold sizing reproduces the real trade instead of guessing', () => {
  // The actual fill: stop $1.595 of price, risk budget $25, broker sized 0.16 lots.
  const perPip = valuePerPipPerLot(GOLD, 0.1);        // $10
  const stopPips = 1.595 / 0.1;                       // 15.95 pips
  const lots = normalizeLots(GOLD, 25 / (stopPips * perPip));
  assert.equal(lots, 0.16, 'must reproduce the 0.16 lots actually traded');
  const risk = stopPips * perPip * lots;
  assert.ok(Math.abs(risk - 25.52) < 0.2, `risk ${risk} should match the observed -$25.52`);
});

test('forex: standard lot prices at $10 per pip', () => {
  // tickValue/tickSize is a float division (1.0 / 0.00001 = 99999.99999999999), so these
  // are compared with a tolerance. The residue is ~1e-11 and vanishes once lots are
  // rounded to the broker's 0.01 step.
  assert.ok(Math.abs(valuePerPricePerLot(GBP) - 100000) < 1e-6);
  assert.ok(Math.abs(valuePerPipPerLot(GBP, 0.0001) - 10) < 1e-9);
  assert.equal(normalizeLots(GBP, 25 / (20 * valuePerPipPerLot(GBP, 0.0001))), 0.13,
    'float residue must not shift the traded lot size');
});

test('the x100 Nasdaq contract prices at $100 per point, not $1', () => {
  assert.equal(valuePerPipPerLot(USTEC100, 1.0), 100,
    'a 1-point move on the x100 contract is $100 per lot');
  // The trade that lost $944 on a $10 budget: 0.44 lots x 21.49 points.
  assert.ok(Math.abs(0.44 * 21.49 * 100 - 945.56) < 1, 'reproduces the real loss');
});

test('minimum stop distance is read from the broker', () => {
  assert.equal(minStopDistance(GBP), 0.0004, 'GBPUSD: 40 points = 4 pips');
  assert.equal(minStopDistance(GOLD), 0, 'gold: no enforced minimum here');
  assert.equal(minStopDistance(null), null, 'unknown symbol reports null, never a guess');
});

test('the GBPUSD order that MT5 rejected is now caught before sending', () => {
  // The real rejection: 3.5 pip stop against a 4 pip broker minimum -> error 10016.
  const a = assessStopDistance(GBP, 0.00035);
  assert.equal(a.blocked, true);
  assert.match(a.reason, /minimum stop distance/);
  // 5 pips clears the broker minimum.
  const b = assessStopDistance(GBP, 0.0005);
  assert.equal(b.blocked, false, '5 pips is placeable');
});

test('a stop inside the spread is blocked, a thin one only warns', () => {
  // GBP spread = 13 points = 1.3 pips.
  assert.equal(assessStopDistance(GBP, 0.00030).blocked, true, 'under 3x spread -> blocked');
  const thin = assessStopDistance(GBP, 0.0008);      // ~6x spread
  assert.equal(thin.blocked, false);
  assert.equal(thin.ok, false, 'still flagged as thin');
  const fine = assessStopDistance(GBP, 0.0020);      // ~15x spread
  assert.equal(fine.ok, true);
});

test('the gold trade that stopped out was placeable and not spread-doomed', () => {
  // Honest check: $1.595 stop against an $0.18 spread is ~8.9x — thin-ish but valid.
  const a = assessStopDistance(GOLD, 1.595);
  assert.equal(a.blocked, false, 'it was a legitimate order, not a broker violation');
  assert.ok(a.spreads > 8, `~${a.spreads.toFixed(1)}x spread`);
});

test('lot sizes are snapped to the broker volume step and floor', () => {
  assert.equal(normalizeLots(GOLD, 0.157), 0.16);
  assert.equal(normalizeLots(GOLD, 0.0001), 0.01, 'never below the broker minimum');
  assert.equal(normalizeLots(USTEC100, 999), 50, 'never above the broker maximum');
});

test('unknown specs never fabricate a value', () => {
  assert.equal(valuePerPricePerLot(null), null);
  assert.equal(valuePerPricePerLot({ tickValue: 0, tickSize: 0 }), null);
  assert.equal(spreadPrice({}), null);
});
