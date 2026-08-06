import assert from 'node:assert/strict';
import test from 'node:test';
import { remainingR, latenessPct, sizeForStop, ictBreakerExecPlan, ICT_EXEC_DEFAULTS } from './ictBreakerExec.js';

// A real rejected ticket: GBPJPY SELL, planned 213.86, stop 213.962, draw 213.554.
const SELL = { direction: 'SELL', plannedEntry: 213.86, plannedStop: 213.962, target: 213.554 };
const FX = { pipSize: 0.01, pipValuePerLot: 6.21, riskAmount: 40 };

// ── remainingR ───────────────────────────────────────────────────────────────

test('remaining R is measured from the LIVE price, so lateness shrinks it', () => {
  // At the planned entry the trade is worth ~3R; 5 pips late it is worth materially less,
  // because risk grows and reward shrinks on the same move.
  const atEntry = remainingR({ direction: 'SELL', price: 213.86, stopLoss: 213.962, target: 213.554 });
  const late = remainingR({ direction: 'SELL', price: 213.80, stopLoss: 213.962, target: 213.554 });
  assert.ok(atEntry > late, `${atEntry} should exceed ${late}`);
  assert.ok(Math.abs(atEntry - 3.0) < 0.05, `~3R at entry, got ${atEntry}`);
});

test('a target already passed is not a tradeable setup', () => {
  // Past the draw there is nothing left to win — must be null, never a small positive.
  assert.equal(remainingR({ direction: 'SELL', price: 213.50, stopLoss: 213.962, target: 213.554 }), null);
  assert.equal(remainingR({ direction: 'BUY', price: 214.00, stopLoss: 213.5, target: 213.9 }), null);
});

test('a stop already breached is not a tradeable setup', () => {
  assert.equal(remainingR({ direction: 'SELL', price: 214.00, stopLoss: 213.962, target: 213.554 }), null);
  assert.equal(remainingR({ direction: 'BUY', price: 213.40, stopLoss: 213.5, target: 214.0 }), null);
});

test('remaining R refuses unusable input rather than returning a number', () => {
  for (const bad of [{ price: null }, { price: 0 }, { stopLoss: NaN }, { target: undefined }]) {
    assert.equal(remainingR({ direction: 'SELL', price: 213.8, stopLoss: 213.96, target: 213.55, ...bad }), null, JSON.stringify(bad));
  }
});

test('BUY and SELL are symmetric', () => {
  const s = remainingR({ direction: 'SELL', price: 100, stopLoss: 101, target: 97 });
  const b = remainingR({ direction: 'BUY', price: 100, stopLoss: 99, target: 103 });
  assert.equal(s, b);
  assert.equal(s, 3);
});

// ── lateness ─────────────────────────────────────────────────────────────────

test('lateness is a share of the PLANNED stop, matching the slippage gate metric', () => {
  // Planned risk 10.2 pips; 10.2 pips past the entry = 100%.
  const late = latenessPct({ direction: 'SELL', plannedEntry: 213.86, plannedStop: 213.962, price: 213.758 });
  assert.ok(Math.abs(late - 100) < 0.5, `expected ~100%, got ${late}`);
});

test('a fill BETTER than planned reads as negative lateness, not as late', () => {
  const early = latenessPct({ direction: 'SELL', plannedEntry: 213.86, plannedStop: 213.962, price: 213.90 });
  assert.ok(early < 0, `${early} should be negative`);
});

// ── sizing ───────────────────────────────────────────────────────────────────

test('lots are FLOORED to the volume step, never rounded up', () => {
  // Rounding up silently exceeds the budget the challenge rules are built on.
  const lots = sizeForStop({ riskAmount: 40, stopDistance: 0.102, pipSize: 0.01, pipValuePerLot: 6.21, volumeStep: 0.01 });
  assert.equal(lots, 0.63);
  const exact = 40 / (10.2 * 6.21);
  assert.ok(lots <= exact, `${lots} must not exceed the un-floored ${exact}`);
});

test('a stop too wide to size within budget returns null, not the minimum lot', () => {
  // Trading the minimum anyway would break the risk budget rather than skip the trade.
  assert.equal(sizeForStop({ riskAmount: 40, stopDistance: 100, pipSize: 0.01, pipValuePerLot: 6.21, volumeMin: 0.01 }), null);
});

test('a wider stop always produces fewer lots', () => {
  const tight = sizeForStop({ riskAmount: 40, stopDistance: 0.102, pipSize: 0.01, pipValuePerLot: 6.21 });
  const wide = sizeForStop({ riskAmount: 40, stopDistance: 0.300, pipSize: 0.01, pipValuePerLot: 6.21 });
  assert.ok(wide < tight, `${wide} should be under ${tight}`);
});

test('sizing respects a non-decimal volume step and the broker max', () => {
  const lots = sizeForStop({ riskAmount: 1000, stopDistance: 0.102, pipSize: 0.01, pipValuePerLot: 6.21, volumeStep: 0.05 });
  assert.equal(Math.round((lots / 0.05) % 1 * 1e6) / 1e6, 0, `${lots} must be a multiple of 0.05`);
  const capped = sizeForStop({ riskAmount: 100000, stopDistance: 0.102, pipSize: 0.01, pipValuePerLot: 6.21, volumeMax: 5 });
  assert.equal(capped, 5);
});

test('sizing refuses unusable input', () => {
  assert.equal(sizeForStop({ riskAmount: 0, stopDistance: 0.1, pipSize: 0.01, pipValuePerLot: 6 }), null);
  assert.equal(sizeForStop({ riskAmount: 40, stopDistance: 0, pipSize: 0.01, pipValuePerLot: 6 }), null);
  assert.equal(sizeForStop({ riskAmount: 40, stopDistance: 0.1, pipSize: 0, pipValuePerLot: 6 }), null);
  assert.equal(sizeForStop({ riskAmount: 40, stopDistance: 0.1, pipSize: 0.01, pipValuePerLot: null }), null);
});

// ── the plan ─────────────────────────────────────────────────────────────────

test('a live setup is allowed, with NO take profit', () => {
  // The whole point: TP was the only leg MT5 rejected (29/29), so it is not sent.
  const p = ictBreakerExecPlan({ ...SELL, price: 213.83, ...FX });
  assert.equal(p.allow, true, p.reason);
  assert.equal(p.takeProfit, null, 'no take profit is sent');
  assert.equal(p.stopLoss, 213.962, 'the structural stop is kept as-is');
  assert.ok(p.lots > 0);
  assert.ok(p.remainingR >= 1);
});

test('the stop is never moved to flatter the risk — lots absorb the distance', () => {
  const near = ictBreakerExecPlan({ ...SELL, price: 213.85, ...FX });
  const far = ictBreakerExecPlan({ ...SELL, price: 213.80, ...FX });
  assert.equal(near.stopLoss, far.stopLoss, 'same structural stop either way');
  assert.ok(far.lots < near.lots, 'the later fill sizes smaller, it does not move the stop');
  assert.ok(far.lossAtStop <= FX.riskAmount + 0.01, 'risk stays inside the budget');
});

test('a spent setup is refused by the >=1R rule, before the lateness cutoff applies', () => {
  // 213.70 is chosen to isolate this rule: 157% late (inside the 250% cutoff) but only 0.56R
  // left to the 213.554 draw. The setup still "looks" fine on lateness alone — which is the
  // whole reason the gate is remaining-R and not slippage %.
  const p = ictBreakerExecPlan({ ...SELL, price: 213.70, ...FX });
  assert.equal(p.allow, false);
  assert.match(p.reason, /spent|left to the draw/i);
  assert.ok(p.latePct < 250, `should be inside the cutoff, was ${p.latePct}%`);
});

test('past the lateness cutoff it is refused even with room to the draw', () => {
  // Wide draw so >=1R still passes; only the cutoff should stop it.
  const p = ictBreakerExecPlan({
    direction: 'SELL', plannedEntry: 213.86, plannedStop: 213.962, target: 210.0,
    price: 213.50, ...FX, options: { maxLatePct: 250 },
  });
  assert.equal(p.allow, false);
  assert.match(p.reason, /cutoff/i);
  assert.ok(p.latePct > 250);
});

test('a stop inside a couple of spreads is refused', () => {
  // The spread would take it out, not the market.
  const p = ictBreakerExecPlan({ ...SELL, price: 213.95, ...FX, spread: 0.02 });
  assert.equal(p.allow, false);
  assert.match(p.reason, /spread/i);
});

test('a market already through the stop is refused', () => {
  const p = ictBreakerExecPlan({ ...SELL, price: 214.10, ...FX });
  assert.equal(p.allow, false);
  assert.match(p.reason, /through the stop/i);
});

test('every refusal names the measurement that caused it', () => {
  const cases = [
    { price: 214.10 }, { price: 213.60 }, { price: 213.95, spread: 0.02 },
    { price: 0 }, { direction: 'HOLD', price: 213.83 },
  ];
  for (const c of cases) {
    const p = ictBreakerExecPlan({ ...SELL, ...FX, ...c });
    assert.equal(p.allow, false, JSON.stringify(c));
    assert.ok(typeof p.reason === 'string' && p.reason.length > 8, `weak reason: ${p.reason}`);
  }
});

test('BUY side works the same way', () => {
  const p = ictBreakerExecPlan({
    direction: 'BUY', plannedEntry: 1.1000, plannedStop: 1.0980, target: 1.1060,
    price: 1.1005, pipSize: 0.0001, pipValuePerLot: 10, riskAmount: 40,
  });
  assert.equal(p.allow, true, p.reason);
  assert.equal(p.takeProfit, null);
  assert.equal(p.stopLoss, 1.0980);
});

test('the defaults are the measured ones', () => {
  // These came from the 650-signal replay; changing them silently would change which trades
  // reach a live account.
  assert.equal(ICT_EXEC_DEFAULTS.minRemainingR, 1.0);
  assert.equal(ICT_EXEC_DEFAULTS.maxLatePct, 250);
  assert.equal(ICT_EXEC_DEFAULTS.noTakeProfit, true);
});

test('noTakeProfit:false restores the target, for a shadow comparison', () => {
  const p = ictBreakerExecPlan({ ...SELL, price: 213.83, ...FX, options: { noTakeProfit: false } });
  assert.equal(p.allow, true);
  assert.equal(p.takeProfit, 213.554);
});
