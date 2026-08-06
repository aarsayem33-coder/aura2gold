import assert from 'node:assert/strict';
import test from 'node:test';
import { planSource, sizeByRisk, challengeAdvice, buildForecastPlan } from './forecastTradePlan.js';

// A gold sweep-reject forecast shaped like real runner output.
const fire = (over = {}) => ({
  strategyId: 'liq-trap-pro', decision: 'BUY', agrees: true, stage: 1,
  score: 85, grade: 'A', entry: 3999.2, stopLoss: 3992.7, takeProfit: 4018.7, rr: 3.0, ...over,
});
const forecast = (fires) => ({ fires, expectedDirection: 'BUY' });

const DASH = {
  status: 'OK',
  rules: { minRR: 2, onlyAPlus: false },
  safePerTradeRisk: 40, roomToDailyLoss: 120, roomToMaxDrawdown: 260,
};

const GOLD = { pipSize: 0.1, pipValuePerLot: 10 };

// ── choosing the price source ────────────────────────────────────────────────

test('the best agreeing strategy with prices supplies the plan', () => {
  const src = planSource(forecast([
    fire({ strategyId: 'best', score: 95, entry: null }),        // best score, but no entry
    fire({ strategyId: 'dissent', score: 90, agrees: false }),   // prices for the OPPOSITE trade
    fire({ strategyId: 'usable', score: 85 }),
  ]));
  assert.equal(src.strategyId, 'usable');
});

test('no usable source means no plan, with the reason stated', () => {
  assert.equal(planSource(forecast([fire({ entry: null })])), null);
  assert.equal(planSource(forecast([fire({ stopLoss: null })])), null);
  assert.equal(planSource(forecast([fire({ agrees: false })])), null);
  assert.equal(planSource(forecast([fire({ entry: 4000, stopLoss: 4000 })])), null);
  assert.equal(planSource({ fires: [] }), null);
  assert.equal(planSource(null), null);
  const { plan, reason } = buildForecastPlan({ forecast: forecast([fire({ agrees: false })]), ...GOLD, riskBudget: 40 });
  assert.equal(plan, null);
  assert.match(reason, /no agreeing strategy/);
});

// ── sizing ───────────────────────────────────────────────────────────────────

test('lots follow the live formula: risk / (stopPips x pipValue)', () => {
  // $40 budget, 65-pip gold stop, $10/pip/lot -> 0.0615 raw -> floored to 0.06.
  const s = sizeByRisk({ riskBudget: 40, stopPips: 65, pipValuePerLot: 10 });
  assert.equal(s.lots, 0.06);
  assert.equal(s.lossAtStop, 39);      // 0.06 * 65 * 10 — inside budget because of the floor
  assert.equal(s.overBudget, false);
  assert.equal(s.minForced, false);
});

test('lots floor to the step rather than rounding up past the budget', () => {
  // Raw 0.0699… must become 0.06, not 0.07: 0.07 would risk $45.5 against a $40 budget.
  const s = sizeByRisk({ riskBudget: 45.4, stopPips: 65, pipValuePerLot: 10 });
  assert.equal(s.lots, 0.06);
  assert.ok(s.lossAtStop <= 45.4);
});

test('the broker minimum can force risk over budget — reported, never hidden', () => {
  // Budget only supports 0.004 lots but volMin is 0.01: risk becomes $65 > $26.
  const s = sizeByRisk({ riskBudget: 26, stopPips: 650, pipValuePerLot: 10, volMin: 0.01 });
  assert.equal(s.lots, 0.01);
  assert.equal(s.lossAtStop, 65);
  assert.equal(s.overBudget, true);
  assert.equal(s.minForced, true);
});

test('volume max caps the size', () => {
  const s = sizeByRisk({ riskBudget: 100000, stopPips: 10, pipValuePerLot: 10, volMax: 5 });
  assert.equal(s.lots, 5);
});

test('a coarse volume step floors to that step', () => {
  // Step 0.1: raw 0.615 -> 0.6, not 0.62.
  const s = sizeByRisk({ riskBudget: 400, stopPips: 65, pipValuePerLot: 10, volStep: 0.1 });
  assert.equal(s.lots, 0.6);
});

test('sizing refuses to guess on missing inputs', () => {
  assert.equal(sizeByRisk({ riskBudget: 0, stopPips: 65, pipValuePerLot: 10 }), null);
  assert.equal(sizeByRisk({ riskBudget: 40, stopPips: 0, pipValuePerLot: 10 }), null);
  assert.equal(sizeByRisk({ riskBudget: 40, stopPips: 65, pipValuePerLot: NaN }), null);
});

// ── challenge advisory ───────────────────────────────────────────────────────

test('a safe plan on a healthy challenge passes clean', () => {
  const a = challengeAdvice({ lossAtStop: 39, rr: 3, grade: 'A', dashboard: DASH });
  assert.equal(a.eligible, true);
  assert.deepEqual(a.warnings, []);
});

test('warnings mirror the live guard: safe-risk, daily room, drawdown', () => {
  // Above safe per-trade but inside daily room.
  const a = challengeAdvice({ lossAtStop: 71.32, rr: 3, grade: 'A', dashboard: DASH });
  assert.equal(a.eligible, true, 'risk warnings annotate, they do not block');
  assert.match(a.warnings[0], /above the safe per-trade risk \(40\)/);
  // Past the daily room — the safe-risk warning is superseded, matching challengeSignalGuard.
  const b = challengeAdvice({ lossAtStop: 150, rr: 3, grade: 'A', dashboard: DASH });
  assert.match(b.warnings[0], /exceeds today's remaining loss room/);
  assert.equal(b.warnings.length, 1);
  // Past everything.
  const c = challengeAdvice({ lossAtStop: 300, rr: 3, grade: 'A', dashboard: DASH });
  assert.ok(c.warnings.some((w) => /breach max drawdown/.test(w)));
});

test('a breached challenge is ineligible regardless of the plan', () => {
  const a = challengeAdvice({ lossAtStop: 5, rr: 9, grade: 'A+', dashboard: { ...DASH, status: 'BREACH_DAILY' } });
  assert.equal(a.eligible, false);
  assert.match(a.warnings[0], /past today's loss limit/);
  const b = challengeAdvice({ lossAtStop: 5, rr: 9, grade: 'A+', dashboard: { ...DASH, status: 'BREACH_MAX_DD' } });
  assert.match(b.warnings[0], /past max drawdown/);
});

test('quality gates: grade and minimum RR', () => {
  const a = challengeAdvice({ lossAtStop: 10, rr: 3, grade: 'B', dashboard: { ...DASH, rules: { minRR: 2, onlyAPlus: true } } });
  assert.equal(a.eligible, false);
  assert.match(a.warnings[0], /below A grade/);
  const b = challengeAdvice({ lossAtStop: 10, rr: 1.4, grade: 'A', dashboard: DASH });
  assert.equal(b.eligible, false);
  assert.match(b.warnings[0], /RR below challenge min 2/);
});

test('no dashboard yields an honest unknown, not a fake pass', () => {
  const a = challengeAdvice({ lossAtStop: 10, rr: 3, grade: 'A', dashboard: null });
  assert.equal(a.eligible, null);
  assert.match(a.warnings[0], /unavailable/);
});

// ── the full ticket ──────────────────────────────────────────────────────────

test('a full plan carries the strategy prices, sized lots and challenge verdict', () => {
  const { plan, reason } = buildForecastPlan({
    forecast: forecast([fire()]), ...GOLD, riskBudget: 40, dashboard: DASH,
  });
  assert.equal(reason, null);
  assert.equal(plan.strategyId, 'liq-trap-pro');
  assert.equal(plan.direction, 'BUY');
  assert.equal(plan.entry, 3999.2);
  assert.equal(plan.stopLoss, 3992.7);
  assert.equal(plan.takeProfit, 4018.7);
  assert.equal(plan.stopPips, 65);
  assert.equal(plan.rr, 3);
  assert.equal(plan.lots, 0.06);
  assert.equal(plan.lossAtStop, 39);
  assert.equal(plan.profitAtTp, 117);      // 0.06 x 195 pips x $10
  assert.equal(plan.challenge.eligible, true);
  assert.equal(plan.conditional, true, 'the ticket must say it is conditional on the scenario');
});

test('RR is the strategy figure the live guard uses; the ladder cross-check rides along', () => {
  // The lab measures RR to the FINAL target while TP1 is ~1R. Recomputing the headline RR from
  // TP1 stamped every ticket "RR 1" and falsely tripped the challenge minRR warning.
  const { plan } = buildForecastPlan({
    forecast: forecast([fire({ rr: 3, takeProfit: 4005.7, takeProfit2: 4012.2, takeProfit3: 4018.7 })]),
    ...GOLD, riskBudget: 40, dashboard: DASH,
  });
  assert.equal(plan.rr, 3, 'headline RR must match what challengeSignalGuard receives live');
  assert.equal(plan.rrToFinal, 3, 'cross-check computed to TP3');
  assert.equal(plan.takeProfit, 4005.7);
  assert.equal(plan.takeProfit3, 4018.7);
  assert.equal(plan.challenge.eligible, true, 'a 3R ladder must not warn about minRR 2');
  // Without a stated rr, the final-target recomputation stands in.
  const { plan: p2 } = buildForecastPlan({
    forecast: forecast([fire({ rr: null, takeProfit: 4005.7, takeProfit3: 4018.7 })]),
    ...GOLD, riskBudget: 40, dashboard: DASH,
  });
  assert.equal(p2.rr, 3);
});

test('profit at TP1 and at the final target are both priced', () => {
  const { plan } = buildForecastPlan({
    forecast: forecast([fire({ takeProfit: 4005.7, takeProfit3: 4018.7 })]),
    ...GOLD, riskBudget: 40, dashboard: DASH,
  });
  assert.equal(plan.lots, 0.06);
  assert.equal(plan.profitAtTp, 39);          // TP1: 65 pips x 0.06 x $10
  assert.equal(plan.profitAtFinalTp, 117);    // TP3: 195 pips
});

test('a plan without a target still sizes, with RR from the fire if stated', () => {
  const { plan } = buildForecastPlan({
    forecast: forecast([fire({ takeProfit: null, rr: 2.4 })]), ...GOLD, riskBudget: 40, dashboard: DASH,
  });
  assert.equal(plan.takeProfit, null);
  assert.equal(plan.profitAtTp, null);
  assert.equal(plan.rr, 2.4);
  assert.equal(plan.lots, 0.06);
});

test('unknown pip value refuses to size rather than guessing', () => {
  const { plan, reason } = buildForecastPlan({
    forecast: forecast([fire()]), pipSize: 0.1, pipValuePerLot: null, riskBudget: 40,
  });
  assert.equal(plan, null);
  assert.match(reason, /pip value unknown/);
});

test('no risk budget refuses to size rather than defaulting silently', () => {
  const { plan, reason } = buildForecastPlan({
    forecast: forecast([fire()]), ...GOLD, riskBudget: null,
  });
  assert.equal(plan, null);
  assert.match(reason, /no risk budget/);
});

test('forex prices size correctly at forex scale', () => {
  // EURUSD: entry 1.1440, stop 1.1420 -> 20 pips at $10/pip/lot, $40 budget -> 0.2 lots.
  const { plan } = buildForecastPlan({
    forecast: forecast([fire({ entry: 1.144, stopLoss: 1.142, takeProfit: 1.15 })]),
    pipSize: 0.0001, pipValuePerLot: 10, riskBudget: 40, dashboard: DASH,
  });
  assert.equal(plan.stopPips, 20);
  assert.equal(plan.lots, 0.2);
  assert.equal(plan.lossAtStop, 40);
  assert.equal(plan.rr, 3);
});

test('a tight budget sizes down inside it rather than forcing the minimum', () => {
  // $26 over a 65-pip gold stop is exactly 0.04 lots — small, but affordable as-is.
  const { plan } = buildForecastPlan({
    forecast: forecast([fire()]), ...GOLD, riskBudget: 26,
    dashboard: { ...DASH, safePerTradeRisk: 40 },
  });
  assert.equal(plan.lots, 0.04);
  assert.equal(plan.lossAtStop, 26);
  assert.equal(plan.overBudget, false);
  assert.equal(plan.minForced, false);
  assert.deepEqual(plan.challenge.warnings, []);
});

test('genuinely unaffordable minimum is flagged and warned on', () => {
  // 650-pip stop: min lot risks $65 > $26 budget, and > $40 safe risk -> warning present.
  const wide = fire({ entry: 4064.2, stopLoss: 3999.2, takeProfit: 4259.2 });
  const { plan } = buildForecastPlan({
    forecast: forecast([wide]), ...GOLD, riskBudget: 26, dashboard: DASH,
  });
  assert.equal(plan.lots, 0.01);
  assert.equal(plan.lossAtStop, 65);
  assert.equal(plan.overBudget, true);
  assert.equal(plan.minForced, true);
  assert.ok(plan.challenge.warnings.some((w) => /above the safe per-trade risk/.test(w)));
});

test('the plan carries the firing strategy grade', () => {
  // Without it, a challenge set to A/A+ only reads a missing grade as a failing grade and
  // refuses every forecast order — observed live as a 409 on place-order.
  const { plan } = buildForecastPlan({
    forecast: forecast([fire({ grade: 'A+' })]), ...GOLD, riskBudget: 40, dashboard: DASH,
  });
  assert.equal(plan.grade, 'A+');
  // A strategy that genuinely reports no grade stays null rather than inventing one.
  const { plan: p2 } = buildForecastPlan({
    forecast: forecast([fire({ grade: null })]), ...GOLD, riskBudget: 40, dashboard: DASH,
  });
  assert.equal(p2.grade, null);
});

test('an A-grade ticket passes an A-plus-only challenge', () => {
  const strict = { ...DASH, rules: { minRR: 2, onlyAPlus: true } };
  assert.equal(buildForecastPlan({ forecast: forecast([fire({ grade: 'A' })]), ...GOLD, riskBudget: 40, dashboard: strict }).plan.challenge.eligible, true);
  assert.equal(buildForecastPlan({ forecast: forecast([fire({ grade: 'B' })]), ...GOLD, riskBudget: 40, dashboard: strict }).plan.challenge.eligible, false);
});
