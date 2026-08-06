import assert from 'node:assert/strict';
import test from 'node:test';
import {
  forecastableLevels, forecastKey, runScenario, runForecasts, rankForecasts, groupByHorizon, DEFAULTS,
  forecastGrade,
} from './setupForecastRunner.js';
import { HORIZON_BUCKETS } from './setupForecast.js';
import { emptyStats } from './forecastDiscrimination.js';

const PRICE = 4038.58;
const ATR = 8.98;
// A real-shaped context: 400 bars is what buildStrategyContext supplies, and detectors need depth.
const CANDLES = Array.from({ length: 400 }, (_, i) => ({
  time: new Date(Date.parse('2026-07-25T00:00:00.000Z') + i * 15 * 60000).toISOString(),
  open: 4030 + (i % 7), high: 4034 + (i % 7), low: 4026 + (i % 7), close: 4031 + (i % 7), volume: 500,
}));
const BASE = { symbol: 'XAUUSD', timeframe: 'M15', candles: CANDLES, pip: 0.1, h1Trend: 'BULLISH', h4Trend: 'BEARISH' };

const lvl = (over = {}) => ({ price: 4020, side: 'below', strength: 4, type: 'PDL', swept: false, ...over });
// runScenario returns { firedIds, forecast }: firedIds feeds the discrimination measurement and
// includes strategies excluded from the output, forecast is what gets shown.
const runRaw = (over = {}) => runScenario({
  base: BASE, level: 4020, side: 'below', scenario: 'SWEEP_REJECT', atr: ATR,
  timeframe: 'M15', symbol: 'XAUUSD', price: PRICE, pip: 0.1,
  strategyIds: ['a'], evaluate: () => ({ decision: 'BUY', score: 80 }), ...over,
});
const run = (over = {}) => runRaw(over).forecast;

// ── level selection ──────────────────────────────────────────────────────────

test('only unswept, strong-enough, correctly-sided levels are forecastable', () => {
  const levels = [
    lvl({ price: 4020 }),                                  // keep
    lvl({ price: 4010, swept: true }),                     // liquidity already taken
    lvl({ price: 4015, strength: 1 }),                      // too weak
    lvl({ price: 4060, side: 'below' }),                    // stale: "below" but above price
    lvl({ price: 4050, side: 'above' }),                    // keep
    lvl({ price: 4038.60, side: 'above' }),                 // already there — a live signal
    lvl({ price: 3900 }),                                   // 15 ATR away, too speculative
    lvl({ price: NaN }),
    lvl({ price: 4030, side: 'sideways' }),
  ];
  const out = forecastableLevels(levels, { price: PRICE, atr: ATR });
  // Nearest first: 4050 is 11.42 away, 4020 is 18.58.
  assert.deepEqual(out.map((l) => l.price), [4050, 4020]);
});

test('forecastable levels come back nearest-first and capped', () => {
  const many = Array.from({ length: 30 }, (_, i) => lvl({ price: 4035 - i }));
  const out = forecastableLevels(many, { price: PRICE, atr: ATR });
  assert.equal(out.length, DEFAULTS.maxLevels);
  assert.equal(out[0].price, 4035, 'nearest level must come first');
  for (let i = 1; i < out.length; i++) {
    assert.ok(Math.abs(out[i].price - PRICE) >= Math.abs(out[i - 1].price - PRICE));
  }
});

test('level selection degrades safely on bad input', () => {
  assert.deepEqual(forecastableLevels(null, { price: PRICE, atr: ATR }), []);
  assert.deepEqual(forecastableLevels([lvl()], { price: NaN, atr: ATR }), []);
  assert.deepEqual(forecastableLevels([lvl()], { price: PRICE, atr: 0 }), []);
});

test('forecastKey is stable across re-scoring so drift updates one row', () => {
  const a = forecastKey({ symbol: 'XAUUSD', timeframe: 'M15', level: 4020.0000004, scenario: 'SWEEP_REJECT' });
  const b = forecastKey({ symbol: 'XAUUSD', timeframe: 'M15', level: 4020.0000001, scenario: 'SWEEP_REJECT' });
  assert.equal(a, b, 'float noise must not mint a new forecast');
  assert.notEqual(a, forecastKey({ symbol: 'XAUUSD', timeframe: 'M15', level: 4020, scenario: 'BREAK_HOLD' }));
  assert.notEqual(a, forecastKey({ symbol: 'EURUSD', timeframe: 'M15', level: 4020, scenario: 'SWEEP_REJECT' }));
});

test('forecastKey separates distinct forex levels that share 2 decimal places', () => {
  // Regression from the live probe: GBPUSD EQUAL_LOW 1.33124 and 1.33501 are an ATR apart but
  // both render as "1.33". A 2dp key merged them, so one forecast silently overwrote the other
  // and the tracked score drift became meaningless.
  const near = forecastKey({ symbol: 'GBPUSD', timeframe: 'M15', level: 1.33124, scenario: 'BREAK_HOLD' });
  const far = forecastKey({ symbol: 'GBPUSD', timeframe: 'M15', level: 1.33501, scenario: 'BREAK_HOLD' });
  assert.notEqual(near, far);
  // And a pip apart on a JPY pair, which has its own scale.
  assert.notEqual(
    forecastKey({ symbol: 'USDJPY', timeframe: 'H1', level: 148.552, scenario: 'SWEEP_REJECT' }),
    forecastKey({ symbol: 'USDJPY', timeframe: 'H1', level: 148.562, scenario: 'SWEEP_REJECT' }),
  );
});

test('forecasts keep full price precision on forex, not rounded to cents', () => {
  const { forecast } = runScenario({
    base: { ...BASE, symbol: 'GBPUSD', pip: 0.0001 }, level: 1.33124, side: 'below',
    scenario: 'SWEEP_REJECT', atr: 0.0035, timeframe: 'M15', symbol: 'GBPUSD', price: 1.34,
    pip: 0.0001, strategyIds: ['a'], evaluate: () => ({ decision: 'BUY', score: 80 }),
  });
  assert.equal(forecast.level, 1.33124, 'a 2dp level would be indistinguishable from its neighbours');
});

// ── one scenario across strategies ───────────────────────────────────────────

test('targets follow the lab contract: takeProfit1 is the ticket target', () => {
  // Regression: reading `takeProfit` returned null for every strategy, so no forecast ticket
  // carried a target and profit-at-TP could never be computed.
  const f = run({ evaluate: () => ({ decision: 'BUY', score: 80, takeProfit1: 4018.7, takeProfit2: 4030 }) });
  assert.equal(f.fires[0].takeProfit, 4018.7);
  // A strategy using the plain name still works.
  const g = run({ evaluate: () => ({ decision: 'BUY', score: 80, takeProfit: 4011 }) });
  assert.equal(g.fires[0].takeProfit, 4011);
});

test('a scenario reports which strategies fire, with their own scores', () => {
  const f = run({
    strategyIds: ['pin', 'trap', 'quiet'],
    evaluate: (id) => (id === 'pin' ? { decision: 'BUY', score: 97, grade: 'A+', riskRewardRatio: 3.1 }
      : id === 'trap' ? { decision: 'BUY', score: 84 } : null),
  });
  assert.equal(f.fires.length, 2);
  assert.equal(f.fires[0].strategyId, 'pin', 'highest score first');
  assert.equal(f.fires[0].score, 97);
  assert.equal(f.fires[0].rr, 3.1);
  assert.equal(f.bestScore, 97);
  assert.equal(f.bestStrategy, 'pin');
  assert.equal(f.expectedDirection, 'BUY');
  assert.equal(f.consensusDirection, 'BUY');
  assert.equal(f.agreeCount, 2);
  assert.equal(f.dissentCount, 0);
});

test('a scenario nothing backs is not a forecast at all', () => {
  assert.equal(run({ evaluate: () => null }), null);
  assert.equal(run({ evaluate: () => ({ decision: null }) }), null);
});

test('strategies already firing the same way on real bars are excluded', () => {
  // Without this the forecast would take credit for a live signal.
  const baseline = new Map([['a', 'BUY']]);
  assert.equal(run({ baseline }), null);
  // A strategy firing the OTHER way on real bars is still informative.
  const f = run({ baseline: new Map([['a', 'SELL']]) });
  assert.equal(f.fires.length, 1);
});

test('a dropped strategy is still measured, so its verdict can change', () => {
  // The whole exclusion rests on a measurement. If dropped strategies were never evaluated
  // again, the first verdict would be permanent and a strategy could never earn its way back.
  const res = runRaw({
    strategyIds: ['keep', 'dropped'],
    allowed: new Set(['keep']),
    evaluate: () => ({ decision: 'BUY', score: 80 }),
  });
  assert.deepEqual(res.firedIds.sort(), ['dropped', 'keep'], 'measurement must see both');
  assert.deepEqual(res.forecast.fires.map((f) => f.strategyId), ['keep'], 'output shows only allowed');
});

test('a scenario backed only by dropped strategies produces no forecast', () => {
  const res = runRaw({
    strategyIds: ['shape'],
    allowed: new Set(['other']),
    evaluate: () => ({ decision: 'BUY', score: 90 }),
  });
  assert.equal(res.forecast, null, 'a shape-driven-only setup must not be shown');
  assert.deepEqual(res.firedIds, ['shape'], 'but it still counts toward the measurement');
});

test('the earliest stage that fires is the one reported', () => {
  // Stage 1 = rejection bar last, stage 2 = displacement bar last. A pin strategy must be
  // credited at stage 1 rather than being re-evaluated and overwritten at stage 2.
  const seen = [];
  const f = run({
    strategyIds: ['early', 'late'],
    evaluate: (id, ctx) => {
      const stage = ctx.scenarioBars;
      seen.push(`${id}@${stage}`);
      if (id === 'early') return { decision: 'BUY', score: 70 + stage };
      return stage === 2 ? { decision: 'BUY', score: 90 } : null;
    },
  });
  assert.equal(f.fires.find((x) => x.strategyId === 'early').stage, 1);
  assert.equal(f.fires.find((x) => x.strategyId === 'early').score, 71, 'stage-1 result must be kept');
  assert.equal(f.fires.find((x) => x.strategyId === 'late').stage, 2);
  // 'early' must not be re-evaluated once it has fired.
  assert.equal(seen.filter((s) => s === 'early@2').length, 0);
});

test('a strategy disagreeing with the scenario premise is surfaced, not hidden', () => {
  const f = run({
    strategyIds: ['agree', 'dissent'],
    evaluate: (id) => (id === 'agree' ? { decision: 'BUY', score: 80 } : { decision: 'SELL', score: 88 }),
  });
  assert.equal(f.expectedDirection, 'BUY');
  assert.equal(f.fires.find((x) => x.strategyId === 'dissent').agrees, false);
  assert.equal(f.agreeCount, 1);
  assert.equal(f.dissentCount, 1);
  assert.equal(f.consensusDirection, 'SPLIT', 'one each way is a split, not a call');
  // The headline must describe support for the forecast's OWN direction, even though the
  // dissenter scored higher — otherwise the card asserts the opposite of its evidence.
  assert.equal(f.bestScore, 80);
  assert.equal(f.bestStrategy, 'agree');
});

test('a scenario only dissenters fire on is not a forecast', () => {
  // Rendered as "Touch & reject -> BUY · 88 · 0 strats · 1 against" before this: a headline
  // direction and score lifted from a strategy arguing the other way.
  const res = runRaw({
    strategyIds: ['dissent'],
    evaluate: () => ({ decision: 'SELL', score: 88 }),      // scenario expects BUY
  });
  assert.equal(res.forecast, null);
  assert.deepEqual(res.firedIds, ['dissent'], 'it still counts toward the measurement');
});

test('a throwing strategy is recorded, never silently dropped', () => {
  const f = run({
    strategyIds: ['ok', 'boom'],
    evaluate: (id) => { if (id === 'boom') throw new Error('bad candle'); return { decision: 'BUY', score: 60 }; },
  });
  assert.deepEqual(f.threw, ['boom']);
  assert.equal(f.fires.length, 1);
});

test('a throwing strategy is not counted as having fired', () => {
  // Counting a crash as a fire would corrupt the discrimination rates in both arms.
  const res = runRaw({
    strategyIds: ['boom'],
    evaluate: () => { throw new Error('bad candle'); },
  });
  assert.deepEqual(res.firedIds, []);
  assert.equal(res.forecast, null);
});

test('a forecast carries the assumed bars and its distance/ETA', () => {
  const f = run();
  assert.equal(f.scenarioBars.length, 2, 'the assumption must travel with the forecast');
  assert.ok(f.scenarioBars.every((b) => b.synthetic));
  assert.equal(f.distance.price, 18.58);
  assert.equal(f.distance.pips, 185.8);
  assert.ok(f.eta.midMinutes > 0);
  assert.ok(f.horizon.label);
  assert.equal(f.level, 4020);
  assert.equal(f.side, 'below');
});

test('an unbuildable scenario yields nothing rather than a bogus forecast', () => {
  for (const bad of [{ atr: 0 }, { timeframe: 'D1' }, { base: { ...BASE, candles: [] } }]) {
    const res = runRaw(bad);
    assert.equal(res.forecast, null);
    assert.equal(res.unbuildable, true, 'must be distinguishable from "ran but nothing fired"');
    assert.deepEqual(res.firedIds, [], 'an unbuilt scenario must not pollute the measurement');
  }
});

// ── full sweep ───────────────────────────────────────────────────────────────

test('the sweep covers every level x scenario and ranks the results', () => {
  const levels = [lvl({ price: 4030 }), lvl({ price: 4020 }), lvl({ price: 4060, side: 'above' })];
  const out = runForecasts({
    base: BASE, levels, atr: ATR, price: PRICE, pip: 0.1, symbol: 'XAUUSD', timeframe: 'M15',
    strategyIds: ['a', 'b'],
    evaluate: (id, ctx) => (ctx.scenarioBars ? { decision: 'BUY', score: 75 } : null),
  });
  assert.equal(out.candidates, 3);
  // 9 scenarios are evaluated, but an always-BUY strategy only AGREES with 5 of them: the two
  // below-levels' sweep and touch rejections (4), plus the above-level's break-and-hold (1).
  // The other 4 are dissent-only and correctly produce no forecast.
  assert.equal(out.forecasts.length, 5);
  assert.ok(out.forecasts.every((f) => f.agreeCount > 0), 'every forecast must have backing');
  assert.ok(out.forecasts.every((f) => f.rankScore > 0));
  for (let i = 1; i < out.forecasts.length; i++) {
    assert.ok(out.forecasts[i - 1].rankScore >= out.forecasts[i].rankScore, 'ranked descending');
  }
});

test('strategies that never fire are reported as silent, not as rejections', () => {
  const out = runForecasts({
    base: BASE, levels: [lvl()], atr: ATR, price: PRICE, pip: 0.1, symbol: 'XAUUSD', timeframe: 'M15',
    strategyIds: ['fires', 'needsMoreBars'],
    evaluate: (id, ctx) => (id === 'fires' && ctx.scenarioBars ? { decision: 'BUY', score: 70 } : null),
  });
  assert.deepEqual(out.silent, ['needsMoreBars']);
});

test('a strategy already live on real bars is neither silent nor a forecast', () => {
  const out = runForecasts({
    base: BASE, levels: [lvl()], atr: ATR, price: PRICE, pip: 0.1, symbol: 'XAUUSD', timeframe: 'M15',
    strategyIds: ['live'],
    evaluate: () => ({ decision: 'BUY', score: 90 }),      // fires on baseline AND scenarios
  });
  assert.equal(out.forecasts.length, 0, 'a live signal is not a prediction');
  assert.deepEqual(out.silent, [], 'and must not be mislabelled as unable to forecast');
});

test('the sweep refuses to run without the pieces it needs', () => {
  for (const bad of [
    { base: null, strategyIds: ['a'], evaluate: () => null },
    { base: BASE, strategyIds: null, evaluate: () => null },
    { base: BASE, strategyIds: ['a'], evaluate: 'nope' },
  ]) {
    const out = runForecasts(bad);
    assert.deepEqual(out.forecasts, []);
    assert.equal(out.candidates, 0);
    assert.deepEqual(out.dropped, []);
    assert.equal(out.stats.realScenarios, 0);
  }
});

// ── dropping shape-driven strategies ─────────────────────────────────────────

/** Accumulated stats where `shape` fires more on placebo than at levels. */
function measured() {
  const s = emptyStats();
  s.realScenarios = 100;
  s.placeboScenarios = 100;
  s.byStrategy = {
    good: { realFires: 20, placeboFires: 2 },     // 10x  -> level-driven
    shape: { realFires: 40, placeboFires: 58 },   // 0.69x -> dropped
  };
  return s;
}

test('shape-driven strategies never appear in forecasts', () => {
  const out = runForecasts({
    base: BASE, levels: [lvl()], atr: ATR, price: PRICE, pip: 0.1, symbol: 'XAUUSD', timeframe: 'M15',
    strategyIds: ['good', 'shape'], discrimination: measured(),
    evaluate: (id, ctx) => (ctx.scenarioBars ? { decision: 'BUY', score: id === 'shape' ? 95 : 70 } : null),
  });
  assert.ok(out.forecasts.length > 0);
  for (const f of out.forecasts) {
    assert.ok(!f.fires.some((x) => x.strategyId === 'shape'),
      'a shape-driven strategy must not appear even with the higher score');
    assert.equal(f.bestStrategy, 'good');
  }
  assert.deepEqual(out.dropped.map((d) => d.strategyId), ['shape']);
  assert.equal(out.dropped[0].lift, 0.69, 'the evidence for the exclusion travels with it');
});

test('a dropped strategy is not reported as silent', () => {
  const out = runForecasts({
    base: BASE, levels: [lvl()], atr: ATR, price: PRICE, pip: 0.1, symbol: 'XAUUSD', timeframe: 'M15',
    strategyIds: ['good', 'shape'], discrimination: measured(),
    evaluate: (id, ctx) => (ctx.scenarioBars ? { decision: 'BUY', score: 70 } : null),
  });
  // "Excluded for firing on shape alone" and "cannot be forecast this way" are different facts.
  assert.ok(!out.silent.includes('shape'));
});

test('the placebo arm runs and keeps measuring dropped strategies', () => {
  const out = runForecasts({
    base: BASE, levels: [lvl({ price: 4020 }), lvl({ price: 4060, side: 'above' })],
    atr: ATR, price: PRICE, pip: 0.1, symbol: 'XAUUSD', timeframe: 'M15',
    strategyIds: ['good', 'shape'], discrimination: measured(),
    evaluate: (id, ctx) => (ctx.scenarioBars ? { decision: 'BUY', score: 70 } : null),
  });
  assert.ok(out.placeboCount > 0, 'a control arm must actually run');
  assert.ok(out.stats.placeboScenarios > 0);
  assert.ok(out.stats.byStrategy.shape.placeboFires > 0, 'the dropped strategy stays measured');
  assert.ok(out.stats.byStrategy.shape.realFires > 0);
});

test('with no measurement yet, nothing is dropped and the page is not empty', () => {
  const out = runForecasts({
    base: BASE, levels: [lvl()], atr: ATR, price: PRICE, pip: 0.1, symbol: 'XAUUSD', timeframe: 'M15',
    strategyIds: ['a', 'b'], discrimination: null,
    evaluate: (id, ctx) => (ctx.scenarioBars ? { decision: 'BUY', score: 70 } : null),
  });
  assert.deepEqual(out.dropped, []);
  assert.ok(out.forecasts.length > 0, 'a fresh install must still produce forecasts');
});

// ── ranking ──────────────────────────────────────────────────────────────────

const fc = (over = {}) => ({
  bestScore: 80, agreeCount: 1, dissentCount: 0, levelStrength: 4,
  eta: { midMinutes: 60 }, horizon: { key: 'lte1h' }, ...over,
});

test('a near setup outranks a stronger far one', () => {
  const [first] = rankForecasts([
    fc({ bestScore: 95, eta: { midMinutes: 720 } }),      // excellent, 12h out
    fc({ bestScore: 80, eta: { midMinutes: 30 } }),       // good, within the half hour
  ]);
  assert.equal(first.bestScore, 80, 'time-to-arrival has to matter or the list is not actionable');
});

test('but time does not swamp a large score gap', () => {
  const [first] = rankForecasts([
    fc({ bestScore: 95, eta: { midMinutes: 120 } }),
    fc({ bestScore: 45, eta: { midMinutes: 20 } }),
  ]);
  assert.equal(first.bestScore, 95);
});

test('consensus lifts a forecast over a lone voice at the same score and time', () => {
  const [first] = rankForecasts([fc({ agreeCount: 1 }), fc({ agreeCount: 3 })]);
  assert.equal(first.agreeCount, 3);
});

test('a forecast where every strategy contradicts the premise is demoted', () => {
  const [first] = rankForecasts([
    fc({ bestScore: 90, agreeCount: 0, dissentCount: 2 }),
    fc({ bestScore: 70, agreeCount: 1 }),
  ]);
  assert.equal(first.bestScore, 70, 'unanimous disagreement with the premise must not lead');
});

test('ranking is total and stable, with ties broken by soonest', () => {
  const out = rankForecasts([
    fc({ eta: { midMinutes: 200 } }), fc({ eta: { midMinutes: 200 } }), fc({ eta: { midMinutes: 10 } }),
  ]);
  assert.equal(out.length, 3);
  assert.equal(out[0].eta.midMinutes, 10);
  assert.deepEqual(rankForecasts([]), []);
  assert.deepEqual(rankForecasts(null), []);
});

test('a missing ETA still ranks rather than crashing or vanishing', () => {
  const out = rankForecasts([fc({ eta: null, horizon: null })]);
  assert.equal(out.length, 1);
  assert.ok(out[0].rankScore > 0);
});

// ── bucketing ────────────────────────────────────────────────────────────────

test('forecasts land in their horizon bucket in rank order', () => {
  const groups = groupByHorizon([
    { horizon: { key: 'lte30m' }, rankScore: 9 },
    { horizon: { key: '1to3h' }, rankScore: 8 },
    { horizon: { key: 'lte30m' }, rankScore: 7 },
  ], HORIZON_BUCKETS);
  assert.equal(groups.length, 6);
  const first = groups.find((g) => g.key === 'lte30m');
  assert.deepEqual(first.forecasts.map((f) => f.rankScore), [9, 7]);
  assert.equal(groups.find((g) => g.key === 'lte1h').forecasts.length, 0, 'empty buckets still appear');
});

test('an unknown or missing horizon falls into the furthest bucket, never disappears', () => {
  const groups = groupByHorizon([{ horizon: null }, { horizon: { key: 'nonsense' } }], HORIZON_BUCKETS);
  assert.equal(groups.at(-1).forecasts.length, 2);
  assert.equal(groups.reduce((s, g) => s + g.forecasts.length, 0), 2);
});

// ── grading ──────────────────────────────────────────────────────────────────

test('forecasts grade on the same scale as signals', () => {
  // Diverging from strategyLab's thresholds would make an "A+" forecast mean something
  // different from an "A+" signal, while the challenge rules read grades from both.
  assert.equal(forecastGrade(90), 'A+');
  assert.equal(forecastGrade(85), 'A+');
  assert.equal(forecastGrade(84), 'A');
  assert.equal(forecastGrade(75), 'A');
  assert.equal(forecastGrade(74), 'B');
  assert.equal(forecastGrade(65), 'B');
  assert.equal(forecastGrade(64), 'C');
  assert.equal(forecastGrade(null), null, 'no score is not grade C');
  assert.equal(forecastGrade('abc'), null);
});

test('a forecast carries a grade, preferring the strategy own', () => {
  const stated = run({ evaluate: () => ({ decision: 'BUY', score: 70, grade: 'A+' }) });
  assert.equal(stated.grade, 'A+', "the strategy's own grade wins");
  const derived = run({ evaluate: () => ({ decision: 'BUY', score: 88 }) });
  assert.equal(derived.grade, 'A+', 'derived from score when the strategy states none');
  const low = run({ evaluate: () => ({ decision: 'BUY', score: 60 }) });
  assert.equal(low.grade, 'C');
});
