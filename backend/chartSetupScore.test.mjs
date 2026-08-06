import assert from 'node:assert/strict';
import test from 'node:test';
import { setupGrade, validateGeometry, measuredRr, scoreChartSetup, SETUP_GRADE_BANDS } from './chartSetupScore.js';

const BUY = { direction: 'BUY', entry: 4000, stopLoss: 3990, takeProfit1: 4010, takeProfit3: 4030 };
const SELL = { direction: 'SELL', entry: 4000, stopLoss: 4010, takeProfit1: 3990, takeProfit3: 3970 };

// ── grading ──────────────────────────────────────────────────────────────────

test('grades use the same bands as signals, plus D', () => {
  // An A here must mean the same band as an A on a signal, or the two are not comparable.
  assert.equal(setupGrade(90), 'A+');
  assert.equal(setupGrade(85), 'A+');
  assert.equal(setupGrade(80), 'A');
  assert.equal(setupGrade(75), 'A');
  assert.equal(setupGrade(70), 'B');
  assert.equal(setupGrade(65), 'B');
  assert.equal(setupGrade(55), 'C');
  assert.equal(setupGrade(50), 'C');
  assert.equal(setupGrade(40), 'D');
  assert.equal(setupGrade(0), 'D');
  assert.deepEqual(SETUP_GRADE_BANDS, { 'A+': 85, A: 75, B: 65, C: 50 });
});

test('a MISSING score grades null, never D', () => {
  // Number(null) is 0 and 0 is finite, so a bare isFinite check would grade "unknown" as the
  // worst possible setup — the exact conflation that blocked every forecast order once.
  assert.equal(setupGrade(null), null);
  assert.equal(setupGrade(undefined), null);
  assert.equal(setupGrade(''), null);
  assert.equal(setupGrade('abc'), null);
  assert.equal(setupGrade(0), 'D', 'an actual zero IS a D');
});

// ── geometry ─────────────────────────────────────────────────────────────────

test('a sound ticket validates both ways round', () => {
  assert.equal(validateGeometry(BUY).valid, true);
  assert.equal(validateGeometry(SELL).valid, true);
});

test('a target behind the entry is rejected, not scored low', () => {
  // This is the 10016 case: TP already behind the market. Scoring it at all would surface a
  // trade that cannot exist as an opportunity.
  const bad = validateGeometry({ ...BUY, takeProfit1: 3995, takeProfit3: 3980 });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((e) => /behind the entry/.test(e)));
  const out = scoreChartSetup({ ...BUY, takeProfit1: 3995, takeProfit3: 3980 });
  assert.equal(out.score, null, 'an unusable ticket must not receive a score');
  assert.equal(out.grade, null);
  assert.match(out.note, /Unusable ticket/);
});

test('a stop on the winning side is rejected', () => {
  const g = validateGeometry({ ...BUY, stopLoss: 4010 });
  assert.equal(g.valid, false);
  assert.ok(g.errors.some((e) => /winning side/.test(e)));
});

test('missing prices are named individually', () => {
  const g = validateGeometry({ direction: 'BUY', entry: null, stopLoss: null, takeProfit1: null, takeProfit3: null });
  assert.equal(g.valid, false);
  assert.ok(g.errors.some((e) => /entry/.test(e)));
  assert.ok(g.errors.some((e) => /stop loss/.test(e)));
  assert.ok(g.errors.some((e) => /take profit/.test(e)));
});

test('zero risk is rejected rather than dividing by zero', () => {
  const g = validateGeometry({ ...BUY, stopLoss: 4000 });
  assert.equal(g.valid, false);
  assert.equal(measuredRr({ ...BUY, stopLoss: 4000 }), null);
});

test('no direction is not a tradeable ticket', () => {
  assert.equal(validateGeometry({ ...BUY, direction: 'HOLD' }).valid, false);
  assert.equal(validateGeometry({ ...BUY, direction: null }).valid, false);
});

// ── R:R is recomputed, never taken on trust ──────────────────────────────────

test('R:R is measured to the FINAL target, not TP1', () => {
  // TP1 is ~1R by construction on most ladders, so computing from it stamps "RR 1" on every
  // ticket regardless of the real draw — a defect that once tripped the challenge minRR gate.
  assert.equal(measuredRr(BUY), 3, 'reward 30, risk 10');
  assert.equal(measuredRr(SELL), 3);
  const tp1Only = measuredRr({ ...BUY, takeProfit3: null });
  assert.equal(tp1Only, 1, 'falls back to TP1 only when TP3 is absent');
});

test('a model-supplied riskReward is ignored entirely', () => {
  // The model does its own arithmetic on prices it also chose; if it mis-places a target it
  // reports a great R:R for a trade that cannot happen.
  const out = scoreChartSetup({ ...BUY, riskReward: 99 });
  assert.equal(out.rr, 3, 'recomputed from the actual prices');
});

// ── scoring ──────────────────────────────────────────────────────────────────

test('better reward-to-risk scores higher', () => {
  const poor = scoreChartSetup({ ...BUY, takeProfit3: 4005 });      // 0.5R
  const good = scoreChartSetup({ ...BUY, takeProfit3: 4030 });      // 3R
  assert.ok(good.score > poor.score, `${good.score} should beat ${poor.score}`);
});

test('engine agreement lifts the score and disagreement cuts it', () => {
  const base = { ...BUY };
  const aligned = scoreChartSetup({ ...base, strategyMatch: { verdict: 'ALIGNED', agreeing: [1, 2], opposing: [] } });
  const contrary = scoreChartSetup({ ...base, strategyMatch: { verdict: 'CONTRARY', agreeing: [], opposing: [1, 2] } });
  const none = scoreChartSetup(base);
  assert.ok(aligned.score > none.score);
  assert.ok(contrary.score < none.score);
});

test('trading against a clear higher timeframe is penalised', () => {
  const with_ = scoreChartSetup({ ...BUY, htfBias: 'BULLISH' });
  const against = scoreChartSetup({ ...BUY, htfBias: 'BEARISH' });
  assert.ok(with_.score > against.score);
  assert.ok(against.breakdown.some((b) => /AGAINST/.test(b.why)));
});

test('a stop inside the noise is punished', () => {
  // Sub-ATR stops are what forced 1-3 lot sizes on the live account and got taken out by
  // spread rather than by the market being wrong.
  const tight = scoreChartSetup({ ...BUY, stopLoss: 3999, takeProfit3: 4003, atr: 10 });
  const sane = scoreChartSetup({ ...BUY, atr: 10 });
  assert.ok(tight.score < sane.score);
  assert.ok(tight.breakdown.some((b) => /inside the noise/.test(b.why)));
});

test('a stop barely above the spread is punished', () => {
  const out = scoreChartSetup({ ...BUY, stopLoss: 3999.5, takeProfit3: 4002, spread: 0.4 });
  assert.ok(out.breakdown.some((b) => b.factor === 'spread' && b.points < 0));
});

test('the model confidence can nudge a grade but never carry one', () => {
  // Self-assessment is the last thing that should lead: this project measured a 97% "win rate"
  // that was really -0.74R.
  const low = scoreChartSetup({ ...BUY, aiConfidence: 10 });
  const high = scoreChartSetup({ ...BUY, aiConfidence: 95 });
  assert.ok(high.score > low.score);
  assert.ok(high.score - low.score <= 13, `confidence swing ${high.score - low.score} is too large to be a nudge`);
});

test('stale data costs the setup', () => {
  const fresh = scoreChartSetup({ ...BUY, dataFresh: true });
  const stale = scoreChartSetup({ ...BUY, dataFresh: false });
  assert.equal(fresh.score - stale.score, 10);
  assert.ok(stale.breakdown.some((b) => /not live/.test(b.why)));
});

test('every score comes with a breakdown that explains it', () => {
  // An unexplained score is indistinguishable from a guess.
  const out = scoreChartSetup({ ...BUY, aiConfidence: 70, htfBias: 'BULLISH', atr: 10, strategyMatch: { verdict: 'ALIGNED', agreeing: [1], opposing: [] } });
  assert.ok(out.breakdown.length >= 5);
  for (const b of out.breakdown) {
    assert.ok(typeof b.factor === 'string' && b.factor.length > 2);
    assert.ok(Number.isFinite(b.points));
    assert.ok(typeof b.why === 'string' && b.why.length > 2);
  }
  const sum = 45 + out.breakdown.filter((b) => b.factor !== 'valid ticket').reduce((a, b) => a + b.points, 0);
  assert.ok(Math.abs(sum - out.score) <= 1, `breakdown ${sum} should reconstruct the score ${out.score}`);
});

test('scores stay inside 0-100 however extreme the inputs', () => {
  const worst = scoreChartSetup({
    ...BUY, takeProfit3: 4001, aiConfidence: 0, dataFresh: false, atr: 100, spread: 5,
    htfBias: 'BEARISH', strategyMatch: { verdict: 'CONTRARY', agreeing: [], opposing: [1, 2, 3] },
  });
  const best = scoreChartSetup({
    ...BUY, takeProfit3: 4100, aiConfidence: 95, dataFresh: true, atr: 10,
    htfBias: 'BULLISH', strategyMatch: { verdict: 'ALIGNED', agreeing: [1, 2, 3], opposing: [] },
  });
  assert.ok(worst.score >= 0 && worst.score <= 100);
  assert.ok(best.score >= 0 && best.score <= 100);
  assert.ok(best.score > worst.score);
  assert.equal(worst.grade, 'D');
});

test('SELL is scored identically to a mirrored BUY', () => {
  const b = scoreChartSetup({ ...BUY, atr: 10, htfBias: 'BULLISH' });
  const s = scoreChartSetup({ ...SELL, atr: 10, htfBias: 'BEARISH' });
  assert.equal(b.score, s.score);
  assert.equal(b.rr, s.rr);
});

test('scoring is deterministic', () => {
  const args = { ...BUY, aiConfidence: 70, atr: 10, htfBias: 'BULLISH' };
  assert.deepEqual(scoreChartSetup(args), scoreChartSetup(args));
});
