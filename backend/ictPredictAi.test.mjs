import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildIctAiPrompt, normaliseIctAi, reconcileIctAi, deterministicIctView,
} from './ictPredictAi.js';

const PRED = {
  symbol: 'XAUUSDM', timeframe: 'M15', setup: 'BULLISH_BREAKER', direction: 'BUY',
  level: 3990, structureLevel: 4010, atr: 10, bestScore: 88, grade: 'A+', proQualified: true,
  distance: { pips: 100, atr: 1 },
  eta: { minMinutes: 30, maxMinutes: 120 },
  projection: { bars: 3, walks: 0 },
  fires: [{ strategyId: 'ict-breaker', decision: 'BUY', score: 85, grade: 'A+', reason: 'BULLISH breaker' }],
  refused: [{ strategyId: 'ict-break-pro', reason: 'its own filters rejected the projected setup' }],
  measurements: { gates: [{ label: 'Stage', value: 'stage 2', pass: false, detail: 'worst context' }], bonuses: [] },
  scoreBasis: { assumed: ['displacement fixed at 1x ATR'], measured: ['higher-timeframe alignment'] },
  limitOrder: { type: 'BUY_LIMIT', entry: 3990, stopLoss: 3985, stopPips: 50, takeProfit1: 4000, rr: 2 },
  strategyPlan: { direction: 'BUY', entry: 3994, stopLoss: 3985, takeProfit1: 4003, rr: 1.9 },
};

const ok = (over = {}) => ({
  direction: 'BUY', agrees_with_system: true, score: 72, confidence: 'MEDIUM',
  reach_likelihood: 'HIGH', sweep_outcome: 'REJECT', order_type: 'LIMIT',
  entry: 3991, stop_loss: 3984, take_profit_1: 4005, take_profit_2: 4012,
  draw_on_liquidity: 'equal highs at 4012', invalidation: 'close below 3984',
  key_risks: ['NFP in the window'], rationale: 'because', verdict: 'TAKE', ...over,
});

// ── the prompt has to actually state the ICT question ────────────────────────

test('the prompt names the pool, the structure, and asks sweep-or-accept', () => {
  const s = buildIctAiPrompt({ prediction: PRED, market: { price: 4000, atr: 10 } });
  assert.match(s, /3990/);
  assert.match(s, /4010/);
  assert.match(s, /SWEEP OR ACCEPT/);
  assert.match(s, /bullish breaker/);
  assert.match(s, /"sweep_outcome"/);
});

test('the prompt discloses which score components were assumed', () => {
  // A reviewer not told the displacement was assumed treats a 95 as evidence and rubber-stamps
  // the prediction, which makes the panel worthless.
  const s = buildIctAiPrompt({ prediction: PRED });
  assert.match(s, /ASSUMED by the projection/);
  assert.match(s, /displacement fixed at 1x ATR/);
  assert.match(s, /conditional upper bound, not a probability/);
});

test('the prompt reports which strategies refused and why', () => {
  const s = buildIctAiPrompt({ prediction: PRED });
  assert.match(s, /ict-break-pro: did not fire/);
  assert.match(s, /Stage: stage 2 — FAIL/);
});

test('the image section only appears when an image is actually attached', () => {
  assert.doesNotMatch(buildIctAiPrompt({ prediction: PRED }), /CHART IMAGE IS ATTACHED/);
  assert.match(buildIctAiPrompt({ prediction: PRED, hasImage: true }), /CHART IMAGE IS ATTACHED/);
});

// ── normalisation ────────────────────────────────────────────────────────────

test('unknown enum values fall back rather than passing through', () => {
  const r = normaliseIctAi({ direction: 'LONG', confidence: 'VERY HIGH', sweep_outcome: 'maybe', verdict: 'BUY IT', order_type: 'STOP' });
  assert.equal(r.direction, 'NO_TRADE');
  assert.equal(r.confidence, 'LOW');
  assert.equal(r.sweepOutcome, 'UNCLEAR');
  assert.equal(r.verdict, 'WATCH');
  assert.equal(r.orderType, 'LIMIT');
});

test('an omitted agreement field is recorded as unstated, not as disagreement', () => {
  assert.equal(normaliseIctAi({}).agreementStated, false);
  assert.equal(normaliseIctAi({ agrees_with_system: false }).agreementStated, true);
});

test('prices that are not numbers become null instead of zero', () => {
  const r = normaliseIctAi({ entry: 'about 3990', stop_loss: null, take_profit_1: '' });
  assert.equal(r.entry, null);
  assert.equal(r.stopLoss, null);
  assert.equal(r.takeProfit1, null);
});

// ── reconciliation ───────────────────────────────────────────────────────────

test('a sound ticket survives and gets its RR computed from its own prices', () => {
  const r = reconcileIctAi(normaliseIctAi(ok()), { prediction: PRED, pip: 0.1 });
  assert.deepEqual(r.issues, []);
  assert.equal(r.ticketUsable, true);
  assert.equal(r.stopPips, 70);
  assert.equal(r.rr, Math.round(((4012 - 3991) / 7) * 100) / 100);
  assert.equal(r.agreesWithSystem, true);
});

test('a stop on the wrong side of entry is refused outright', () => {
  const r = reconcileIctAi(normaliseIctAi(ok({ stop_loss: 3995 })), { prediction: PRED, pip: 0.1 });
  assert.equal(r.ticketUsable, false);
  assert.match(r.issues.join(' '), /wrong side of entry/);
});

test('a stop inside the pool is flagged — the sweep itself would take it', () => {
  // The ICT-specific check. A stop above the swing low being swept looks perfectly valid against
  // the entry and is still guaranteed to be hit by the setup working as predicted.
  const r = reconcileIctAi(normaliseIctAi(ok({ entry: 3995, stop_loss: 3992 })), { prediction: PRED, pip: 0.1 });
  assert.match(r.issues.join(' '), /sits inside the pool/);
  assert.equal(r.ticketUsable, false);
});

test('an entry nowhere near the pool is a different setup, not this one', () => {
  const r = reconcileIctAi(normaliseIctAi(ok({ entry: 4030, stop_loss: 4020, take_profit_1: 4060, take_profit_2: 4070 })), { prediction: PRED, pip: 0.1 });
  assert.match(r.issues.join(' '), /more than 2 ATR from the pool/);
});

test('predicting the sweep is ACCEPTED contradicts the breaker premise and is called out', () => {
  const r = reconcileIctAi(normaliseIctAi(ok({ sweep_outcome: 'ACCEPT' })), { prediction: PRED, pip: 0.1 });
  assert.match(r.issues.join(' '), /expects the sweep to be ACCEPTED/);
});

test('a target on the wrong side is dropped and RR falls back to the remaining one', () => {
  const r = reconcileIctAi(normaliseIctAi(ok({ take_profit_1: 3980, take_profit_2: 4012 })), { prediction: PRED, pip: 0.1 });
  assert.equal(r.takeProfit1, null);
  assert.equal(r.rr, Math.round(((4012 - 3991) / 7) * 100) / 100);
  assert.equal(r.ticketUsable, false, 'no TP1 means the ticket is not usable as returned');
});

test('a claimed agreement that its own direction contradicts is reported', () => {
  const r = reconcileIctAi(normaliseIctAi(ok({ direction: 'SELL', agrees_with_system: true, stop_loss: 3999, take_profit_1: 3970, take_profit_2: 3960 })), { prediction: PRED, pip: 0.1 });
  assert.match(r.issues.join(' '), /said it agrees/);
  assert.equal(r.agreesWithSystem, false);
});

test('NO_TRADE short-circuits without inventing a ticket', () => {
  const r = reconcileIctAi(normaliseIctAi(ok({ direction: 'NO_TRADE' })), { prediction: PRED, pip: 0.1 });
  assert.equal(r.ticketUsable, false);
  assert.equal(r.agreesWithSystem, false);
});

test('a stop inside the broker minimum is flagged rather than silently widened', () => {
  const r = reconcileIctAi(normaliseIctAi(ok({ stop_loss: 3990.9 })), { prediction: PRED, pip: 0.1, minStopDistance: 2 });
  assert.match(r.issues.join(' '), /minimum distance/);
});

// ── the unavailable path ─────────────────────────────────────────────────────

test('with no AI available the panel reports the deterministic evidence, never an opinion', () => {
  const v = deterministicIctView(PRED, 'no credentials');
  assert.equal(v.available, false);
  assert.equal(v.reason, 'no credentials');
  assert.match(v.summary, /1 ICT strategy backing BUY at 3990/);
  assert.match(v.summary, /clears the PRO overlay/);
});

test('a failing gate is named when the setup does not clear the overlay', () => {
  const v = deterministicIctView({ ...PRED, proQualified: false }, 'quota');
  assert.match(v.summary, /Stage fails the PRO overlay/);
});
