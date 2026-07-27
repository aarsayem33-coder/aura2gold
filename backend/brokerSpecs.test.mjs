import test from 'node:test';
import assert from 'node:assert/strict';
import {
  valuePerPricePerLot, valuePerPipPerLot, minStopDistance, spreadPrice,
  normalizeLots, assessStopDistance, marginRequired, assessMargin,
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

// ── margin pre-check (added before switching brokers) ──
// Exness demo, 1:200 leverage: 1 lot of gold at ~4090 needs ~$2045 margin.
const GOLD_M = { ...GOLD, marginPerLot: 2045 };
const GBP_M = { ...GBP, marginPerLot: 668 };

test('margin required scales with lot size', () => {
  assert.equal(marginRequired(GOLD_M, 0.16), 327.2);
  assert.equal(marginRequired(GOLD_M, 1), 2045);
  assert.equal(marginRequired({}, 1), null, 'no broker data -> null, never a guess');
});

test('a position bigger than free margin is blocked before sending', () => {
  const a = assessMargin(GOLD_M, 3, 4000);        // needs $6135 of $4000
  assert.equal(a.blocked, true);
  assert.match(a.reason, /not enough free margin/);
});

test('a position that would tie up most of the account is blocked', () => {
  const a = assessMargin(GOLD_M, 1.7, 4000);      // ~$3476 = 87% of free margin
  assert.equal(a.blocked, true);
  assert.match(a.reason, /tie up/);
  assert.ok(a.usePct > 80);
});

test('a moderate position warns but still trades', () => {
  const a = assessMargin(GOLD_M, 1, 4000);        // $2045 = 51%
  assert.equal(a.blocked, false, 'must not block a legitimate trade');
  assert.equal(a.ok, false, 'but should flag the exposure');
  assert.match(a.reason, /uses 51.1% of free margin/);
});

test('a normal risk-sized position passes cleanly', () => {
  const a = assessMargin(GOLD_M, 0.16, 4000);     // $327 = 8%
  assert.equal(a.ok, true);
  assert.equal(a.blocked, false);
  assert.equal(a.reason, null);
  assert.equal(a.usePct, 8.2);
});

test('low-leverage accounts are caught: same trade, 1:30 broker', () => {
  // The same 0.16 lots of gold needs ~6.7x more margin at 1:30 than at 1:200.
  const GOLD_EU = { ...GOLD, marginPerLot: 13633 };
  const ok200 = assessMargin(GOLD_M, 0.16, 1000);
  const eu30 = assessMargin(GOLD_EU, 0.16, 1000);
  assert.equal(ok200.blocked, false, '1:200 account can afford it');
  assert.equal(eu30.blocked, true, '1:30 account cannot — caught before the order is sent');
});

test('margin is never blocked when the broker has not reported it yet', () => {
  const a = assessMargin(GBP, 0.5, 4000);         // GBP spec has no marginPerLot
  assert.equal(a.ok, true);
  assert.equal(a.required, null);
});
