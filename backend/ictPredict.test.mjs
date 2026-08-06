import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ICT_GEOMETRY, ICT_STRATEGIES, ICT_SETUPS,
  ictCandidates, buildIctSequence, ictBarsValid, ictScenarioContext,
  ictLimitOrder, ictDistance, ictEta, ictGrade, ictKey,
  ictMeasurements, projectIctSetup, runIctPredictions, rankIctPredictions, filterIctPredictions,
  assessIctPrediction, shouldAlertIct,
} from './ictPredict.js';
import {
  atr14, fractalSwings, detectBreaker, detectDisplacement, detectLiquidityPools, buildLiquidityPlan,
} from './liquidityEngine.js';
import { evaluateStrategy, computeStage } from './strategyLab.js';

// The whole feature rests on one claim: the projected bars are a LEGITIMATE example of the ICT
// sequence, so the real detectors recognise them. If that stops being true the predictions
// become empty, so it is asserted directly against detectBreaker/detectDisplacement rather than
// against a copy of their rules.

const TF = 'H1';
const ATR_TARGET = 5;

/**
 * A deterministic price series with real fractal structure: a rising staircase of swings so
 * fractalSwings finds highs and lows, with a controllable last price.
 *
 * Built rather than fixture-loaded so a test failure points at the code, not at a data file.
 */
function series({ bars = 300, base = 2000, step = 0.6, swing = 12, amp = 6 } = {}) {
  const out = [];
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  for (let i = 0; i < bars; i++) {
    const wave = Math.sin((i / swing) * Math.PI * 2) * amp;
    const mid = base + i * step + wave;
    const up = i % 2 === 0;
    const open = mid - (up ? 1.2 : -1.2);
    const close = mid + (up ? 1.2 : -1.2);
    out.push({
      time: new Date(t0 + i * 3600000).toISOString(),
      open: Number(open.toFixed(5)),
      high: Number((Math.max(open, close) + 1.6).toFixed(5)),
      low: Number((Math.min(open, close) - 1.6).toFixed(5)),
      close: Number(close.toFixed(5)),
      volume: 1000,
    });
  }
  return out;
}

const ctxFor = (candles, over = {}) => ({
  symbol: 'XAUUSDM', timeframe: TF, candles, pip: 0.1,
  h4Trend: null, h1Trend: null, dailyCandles: null, ...over,
});

// ── the sequence has to be a real ICT sequence ────────────────────────────────

test('the projected sequence is recognised as a breaker by the real detector', () => {
  const candles = series();
  const atr = atr14(candles);
  const { highs, lows } = fractalSwings(candles);
  const price = candles[candles.length - 1].close;
  const cands = ictCandidates(candles, { swings: { highs, lows }, price, atr });
  assert.ok(cands.length, 'the structure should offer at least one candidate');

  const c = cands.find((x) => x.setup === ICT_SETUPS.BULLISH_BREAKER) || cands[0];
  const seq = buildIctSequence({
    level: c.level, structureLevel: c.structureLevel, side: c.side,
    atr, lastCandle: candles[candles.length - 1], timeframe: TF,
  });
  assert.ok(seq.bars, `sequence should build: ${seq.reason}`);
  assert.ok(ictBarsValid(seq.bars), 'every projected bar must be a valid candle');

  const projected = [...candles, ...seq.bars];
  const breaker = detectBreaker(projected, { maxAgeBars: 50 });
  assert.ok(breaker, 'detectBreaker must see the projected sequence');
  assert.equal(breaker.ageBars, 0, 'the reclaim is the last bar, so the breaker is brand new');
  assert.equal(breaker.type, c.direction === 'BUY' ? 'BULLISH' : 'BEARISH');
});

test('the sequence carries a displacement the real detector calls present', () => {
  // ictBreaker refuses any breaker without displacement, so a sequence that does not produce a
  // qualifying FVG would silently make the whole page empty.
  const candles = series();
  const atr = atr14(candles);
  const swings = fractalSwings(candles);
  const price = candles[candles.length - 1].close;
  const [c] = ictCandidates(candles, { swings, price, atr });
  const { bars } = buildIctSequence({
    level: c.level, structureLevel: c.structureLevel, side: c.side,
    atr, lastCandle: candles[candles.length - 1], timeframe: TF,
  });
  const projected = [...candles, ...bars];
  const reclaimIdx = projected.length - 1;
  const disp = detectDisplacement(projected, reclaimIdx, c.direction === 'BUY' ? 'BULLISH' : 'BEARISH', atr14(projected));
  assert.equal(disp.present, true, 'the displacement bar must register');
  assert.ok(disp.atrMultiple >= 0.8, `displacement ${disp.atrMultiple} should clear the 0.8 floor`);
});

test('the reclaim bar satisfies the PRO overlay read of the last candle', () => {
  // ict-break-pro inspects the LAST bar: body >= 60% of range and range >= 1x ATR. If the
  // geometry drifts below either, PRO can never qualify a prediction and the page silently
  // loses its best tier.
  const candles = series();
  const atr = atr14(candles);
  const swings = fractalSwings(candles);
  const price = candles[candles.length - 1].close;
  const [c] = ictCandidates(candles, { swings, price, atr });
  const { bars } = buildIctSequence({
    level: c.level, structureLevel: c.structureLevel, side: c.side,
    atr, lastCandle: candles[candles.length - 1], timeframe: TF,
  });
  const last = bars[bars.length - 1];
  const range = last.high - last.low;
  const body = Math.abs(last.close - last.open);
  const projectedAtr = atr14([...candles, ...bars]);
  assert.ok(body / range >= 0.6, `body ratio ${(body / range).toFixed(2)} must clear 0.60`);
  assert.ok(range / projectedAtr >= 1.0, `range ${(range / projectedAtr).toFixed(2)}x ATR must clear 1.0`);
});

test('walk bars never close through the structure level', () => {
  // A walk bar closing past the structure would BE the reclaim as far as detectBreaker is
  // concerned, and the displacement chain would then be measured off the wrong candle.
  const candles = series();
  const atr = atr14(candles);
  const swings = fractalSwings(candles);
  const price = candles[candles.length - 1].close;
  const cands = ictCandidates(candles, { swings, price, atr, options: { maxCandidates: 40, maxDistanceAtr: 12 } });
  let checked = 0;
  for (const c of cands) {
    const seq = buildIctSequence({
      level: c.level, structureLevel: c.structureLevel, side: c.side,
      atr, lastCandle: candles[candles.length - 1], timeframe: TF,
    });
    if (!seq.bars || !seq.walks) continue;
    checked += 1;
    const buy = c.direction === 'BUY';
    // Every bar except the last must stay short of the structure level.
    for (const b of seq.bars.slice(0, -1)) {
      assert.ok(buy ? b.close < c.structureLevel : b.close > c.structureLevel,
        `intermediate bar closed through the structure at ${c.structureLevel}`);
    }
    const last = seq.bars[seq.bars.length - 1];
    assert.ok(buy ? last.close > c.structureLevel : last.close < c.structureLevel,
      'the reclaim bar must close through the structure level');
  }
  assert.ok(checked > 0, 'at least one multi-bar walk should have been exercised');
});

test('a structure level too close, or too far, is refused with a reason instead of a bad sequence', () => {
  const candles = series();
  const last = candles[candles.length - 1];
  const atr = ATR_TARGET;
  // Just past the sweep bar's close (0.40 ATR above the level) but well short of the 0.6 ATR
  // that makes a reclaim mean anything.
  const near = buildIctSequence({ level: 1900, structureLevel: 1900 + atr * 0.45, side: 'below', atr, lastCandle: last, timeframe: TF });
  assert.equal(near.bars, null);
  assert.match(near.reason, /too tight/);

  const far = buildIctSequence({ level: 1900, structureLevel: 1900 + atr * 20, side: 'below', atr, lastCandle: last, timeframe: TF });
  assert.equal(far.bars, null);
  assert.match(far.reason, /beyond what one breaker sequence/);
});

test('a structure level behind the sweep is refused — reclaiming it would need no move', () => {
  const candles = series();
  const r = buildIctSequence({
    level: 1900, structureLevel: 1899, side: 'below', atr: ATR_TARGET,
    lastCandle: candles[candles.length - 1], timeframe: TF,
  });
  assert.equal(r.bars, null);
  assert.match(r.reason, /behind the sweep/);
});

// ── candidate selection ──────────────────────────────────────────────────────

test('an already-swept swing is not a candidate — that breaker would be in the past', () => {
  const candles = series();
  const swings = fractalSwings(candles);
  const price = candles[candles.length - 1].close;
  const atr = atr14(candles);
  const cands = ictCandidates(candles, { swings, price, atr, options: { maxCandidates: 50, maxDistanceAtr: 20 } });
  const lastIdx = candles.length - 1;
  for (const c of cands) {
    const buy = c.direction === 'BUY';
    for (let j = c.levelIndex + 1; j <= lastIdx; j++) {
      const through = buy ? candles[j].low < c.level : candles[j].high > c.level;
      assert.equal(through, false, `level ${c.level} was already taken at bar ${j}`);
    }
  }
});

test('candidates sit on the far side of price and inside the distance band', () => {
  const candles = series();
  const swings = fractalSwings(candles);
  const price = candles[candles.length - 1].close;
  const atr = atr14(candles);
  const cands = ictCandidates(candles, { swings, price, atr });
  assert.ok(cands.length);
  for (const c of cands) {
    if (c.direction === 'BUY') assert.ok(c.level < price, 'a bullish candidate sweeps a low BELOW price');
    else assert.ok(c.level > price, 'a bearish candidate sweeps a high ABOVE price');
    assert.ok(c.distanceAtr >= 0.15 && c.distanceAtr <= 6, `distance ${c.distanceAtr} outside the band`);
  }
  // Nearest first: the list is meant to be actionable, not merely complete.
  const ds = cands.map((c) => c.distanceAtr);
  assert.deepEqual(ds, [...ds].sort((a, b) => a - b));
});

// ── the limit order ──────────────────────────────────────────────────────────

test('a buy limit rests below price at the level, with the stop beyond the projected sweep', () => {
  const o = ictLimitOrder({
    level: 1990, side: 'below', direction: 'BUY', atr: 10, price: 2000, pip: 0.1,
    targets: { takeProfit1: 2010, takeProfit2: 2020, takeProfit3: 2050 },
  });
  assert.equal(o.type, 'BUY_LIMIT');
  assert.equal(o.entry, 1990);
  assert.ok(o.stopLoss < o.entry, 'the stop must be on the losing side');
  const sweep = (ICT_GEOMETRY.sweep.pierce + 0.15) * 10;
  assert.ok(Math.abs((1990 - o.stopLoss) - sweep) < 1e-6, 'the stop sits beyond the projected sweep extreme');
  assert.equal(o.rr, Math.round((2050 - 1990) / (1990 - o.stopLoss) * 100) / 100);
  assert.equal(o.distance.pips, 100);
});

test('a target on the wrong side of the entry is dropped, not nudged into place', () => {
  const o = ictLimitOrder({
    level: 1990, side: 'below', direction: 'BUY', atr: 10, price: 2000, pip: 0.1,
    targets: { takeProfit1: 1980, takeProfit2: 2020, takeProfit3: null },
  });
  assert.equal(o.takeProfit1, null, 'a "target" below a buy entry is not a target');
  assert.equal(o.takeProfit2, 2020);
  assert.equal(o.rr, Math.round((2020 - 1990) / (1990 - o.stopLoss) * 100) / 100, 'RR uses the furthest VALID target');
});

test('a limit on the wrong side of the market is refused outright', () => {
  // A "buy limit" above price is a stop order in disguise, and the whole premise is that price
  // has not arrived yet.
  assert.equal(ictLimitOrder({ level: 2010, side: 'above', direction: 'BUY', atr: 10, price: 2000, pip: 0.1 }), null);
  assert.equal(ictLimitOrder({ level: 1990, side: 'below', direction: 'SELL', atr: 10, price: 2000, pip: 0.1 }), null);
});

test('a stop inside the noise is refused rather than sized', () => {
  assert.equal(
    ictLimitOrder({ level: 1990, side: 'below', direction: 'BUY', atr: 10, price: 2000, pip: 0.1, options: { stopBufferAtr: 0, minStopAtr: 0.9 } }),
    null,
  );
});

// ── distance, ETA, grading ───────────────────────────────────────────────────

test('distance is reported in pips and ATR, and pips is null when no pip size is known', () => {
  assert.deepEqual(ictDistance({ price: 2000, to: 1990, atr: 5, pip: 0.1 }), { price: 10, pips: 100, atr: 2 });
  assert.equal(ictDistance({ price: 2000, to: 1990, atr: 5, pip: null }).pips, null);
  assert.equal(ictDistance({ price: null, to: 1990, atr: 5, pip: 0.1 }), null);
});

test('the ETA covers arrival PLUS the bars the sequence itself needs', () => {
  // A prediction is not complete when price arrives; it is complete when the breaker confirms.
  const eta = ictEta({ distanceAtr: 2, timeframe: 'H1', setupBars: 3 });
  assert.equal(eta.arriveMinutes, 240);            // 2 ATR at half an ATR per bar = 4 H1 bars
  assert.equal(eta.midMinutes, 240 + 3 * 60);
  assert.equal(eta.minMinutes, Math.round(eta.midMinutes / 2));
  assert.equal(eta.maxMinutes, eta.midMinutes * 2);
  assert.equal(ictEta({ distanceAtr: 2, timeframe: 'NOPE' }), null);
});

test('grades use the same bands as the strategies, and a missing score is unknown not failing', () => {
  assert.equal(ictGrade(90), 'A+');
  assert.equal(ictGrade(78), 'A');
  assert.equal(ictGrade(66), 'B');
  assert.equal(ictGrade(50), 'C');
  // Number(null) is 0 and 0 is finite — grading a MISSING score as C would read to a downstream
  // guard as a failing setup rather than an unknown one.
  assert.equal(ictGrade(null), null);
  assert.equal(ictGrade(undefined), null);
  assert.equal(ictGrade(''), null);
});

test('the key is stable at 5dp so two nearby forex levels do not collide', () => {
  const a = ictKey({ symbol: 'GBPUSD', timeframe: 'M15', level: 1.33124, setup: 'BULLISH_BREAKER' });
  const b = ictKey({ symbol: 'GBPUSD', timeframe: 'M15', level: 1.33501, setup: 'BULLISH_BREAKER' });
  assert.notEqual(a, b);
  assert.equal(a, ictKey({ symbol: 'GBPUSD', timeframe: 'M15', level: 1.331240001, setup: 'BULLISH_BREAKER' }));
});

// ── measurements ─────────────────────────────────────────────────────────────

test('gates are readable even when PRO did not fire and supplies no meta', () => {
  // The setups where PRO refused are exactly the ones where "which gate failed?" matters, so a
  // blank panel there would be the worst possible behaviour.
  const bar = { open: 100, high: 111, low: 99.7, close: 110.5 };
  const m = ictMeasurements({ meta: {} }, { reclaimBar: bar, atr: 10, stage: 2 });
  const byLabel = Object.fromEntries(m.gates.map((g) => [g.label, g]));
  assert.equal(byLabel['Reclaim body'].pass, true);
  assert.equal(byLabel['Reclaim range'].pass, true);
  assert.equal(byLabel['Breaker age'].pass, true);
  assert.equal(byLabel.Stage.pass, false, 'stage 2 is the one gate the projection cannot guarantee');
  assert.equal(byLabel.Stage.value, 'stage 2');
});

test('PRO meta wins over the derived values when it is present', () => {
  const m = ictMeasurements({ meta: { pro: true, bodyRatio: 0.42, rangeAtr: 0.5, breakerAgeBars: 3, stage: 1, roomAtr: 6, displacementAtr: 1.5 } },
    { reclaimBar: { open: 100, high: 111, low: 99.7, close: 110.5 }, atr: 10 });
  assert.equal(m.pro, true);
  assert.equal(m.gates.find((g) => g.label === 'Reclaim body').pass, false);
  assert.equal(m.gates.find((g) => g.label === 'Breaker age').pass, false);
  assert.equal(m.bonuses.find((b) => b.label === 'Room to draw').pass, true);
  assert.equal(m.bonuses.find((b) => b.label === 'Displacement').pass, true);
});

// ── end to end, against the real strategies ──────────────────────────────────

test('the real ICT strategies fire on a projected setup and hand back a usable ticket', () => {
  const candles = series();
  const atr = atr14(candles);
  const swings = fractalSwings(candles);
  const price = candles[candles.length - 1].close;
  const out = runIctPredictions({
    base: ctxFor(candles), swings, atr, price, pip: 0.1,
    symbol: 'XAUUSDM', timeframe: TF, evaluate: evaluateStrategy, stageOf: computeStage,
  });
  assert.ok(out.predictions.length, 'the projected sequences should produce predictions');
  for (const p of out.predictions) {
    assert.ok(ICT_STRATEGIES.includes(p.bestStrategy), 'only the two ICT engines may lead a prediction');
    for (const f of p.fires) {
      assert.ok(ICT_STRATEGIES.includes(f.strategyId), `${f.strategyId} does not belong on this page`);
      assert.equal(f.decision, p.direction, 'a fire against the setup direction must not be counted as backing');
    }
    const buy = p.direction === 'BUY';
    assert.ok(buy ? p.level < price : p.level > price);
    if (p.limitOrder) {
      assert.equal(p.limitOrder.type, buy ? 'BUY_LIMIT' : 'SELL_LIMIT');
      assert.ok(buy ? p.limitOrder.stopLoss < p.limitOrder.entry : p.limitOrder.stopLoss > p.limitOrder.entry);
      assert.equal(p.limitOrder.entry, p.level, 'the resting order is anchored to the REAL level');
    }
    assert.ok(p.projectedBars.length >= 3, 'sweep, displacement and reclaim at minimum');
    assert.ok(p.scoreBasis.assumed.length, 'the assumed score components must be disclosed');
  }
});

test('a strategy already calling the same direction live is excluded, not counted as a prediction', () => {
  const candles = series();
  const atr = atr14(candles);
  const swings = fractalSwings(candles);
  const price = candles[candles.length - 1].close;
  const base = ctxFor(candles);
  // Start from a candidate that DOES produce a prediction, so the exclusion is what changes the
  // answer rather than the setup simply not firing.
  const live = runIctPredictions({
    base, swings, atr, price, pip: 0.1, symbol: 'XAUUSDM', timeframe: TF, evaluate: evaluateStrategy,
  }).predictions[0];
  assert.ok(live, 'need a firing prediction to test the exclusion against');
  const c = ictCandidates(candles, { swings, price, atr }).find((x) => x.level === live.level);

  const out = projectIctSetup({
    base, candidate: c, atr, price, pip: 0.1, symbol: 'XAUUSDM', timeframe: TF,
    evaluate: evaluateStrategy,
    baseline: new Map(ICT_STRATEGIES.map((id) => [id, c.direction])),
  });
  assert.equal(out.fired, false, 'nothing may be reported when every fire is already live');
  assert.ok(out.refused.some((r) => /already calling/.test(r.reason)),
    'the strategy that would have fired must be excluded for being live, not for its filters');
});

test('the projected context never mutates the real candles or the HTF fields', () => {
  // The HTF trend is the only thing stopping this from projecting counter-trend breakers all
  // day, so it must survive into the scenario untouched.
  const candles = series();
  const before = candles.length;
  const base = ctxFor(candles, { h4Trend: 'BEARISH', h1Trend: 'BULLISH' });
  const ctx = ictScenarioContext(base, [
    { open: 1, high: 2, low: 0.5, close: 1.5 }, { open: 1.5, high: 3, low: 1.4, close: 2.9 }, { open: 2.9, high: 4, low: 2.8, close: 3.9 },
  ]);
  assert.equal(candles.length, before, 'the real series must not be mutated');
  assert.equal(ctx.candles.length, before + 3);
  assert.equal(ctx.h4Trend, 'BEARISH');
  assert.equal(ctx.h1Trend, 'BULLISH');
  assert.equal(ctx.projected, true);
});

test('an invalid projected bar set produces no context at all', () => {
  const base = ctxFor(series());
  assert.equal(ictScenarioContext(base, [{ open: 1, high: 0.5, low: 2, close: 1 }, { open: 1, high: 2, low: 0.5, close: 1.5 }, { open: 1, high: 2, low: 0.5, close: 1.5 }]), null);
  assert.equal(ictScenarioContext(base, []), null);
  assert.equal(ictBarsValid([{ open: 1, high: 2, low: 0.5, close: 1.5 }]), false, 'fewer than three bars is not a sequence');
});

// ── ranking and filtering ────────────────────────────────────────────────────

test('a nearer setup outranks a distant one of equal score, and PRO breaks a tie', () => {
  const mk = (over) => ({ bestScore: 80, rr: 3, proQualified: false, eta: { midMinutes: 60 }, ...over });
  const [near, far] = rankIctPredictions([mk({ eta: { midMinutes: 600 } }), mk({ eta: { midMinutes: 30 } })]);
  assert.equal(near.eta.midMinutes, 30, 'the sooner condition ranks first');
  assert.ok(near.rankScore > far.rankScore);

  const [pro, plain] = rankIctPredictions([mk({}), mk({ proQualified: true })]);
  assert.equal(pro.proQualified, true, 'the PRO-qualified setup wins an otherwise identical comparison');
  assert.ok(plain.rankScore < pro.rankScore);
});

test('the pip-distance filter is applied to the resting entry, and a missing distance never passes', () => {
  const rows = [
    { symbol: 'XAUUSDM', timeframe: 'M15', setup: 'BULLISH_BREAKER', direction: 'BUY', grade: 'A', bestScore: 80, rr: 3, proQualified: true, distance: { pips: 40 }, fires: [{ strategyId: 'ict-breaker' }] },
    { symbol: 'XAUUSDM', timeframe: 'H1', setup: 'BEARISH_BREAKER', direction: 'SELL', grade: 'B', bestScore: 68, rr: 2, proQualified: false, distance: { pips: 300 }, fires: [{ strategyId: 'ict-break-pro' }] },
    { symbol: 'EURUSDM', timeframe: 'M15', setup: 'BULLISH_BREAKER', direction: 'BUY', grade: 'A', bestScore: 90, rr: 5, proQualified: true, distance: { pips: null }, fires: [] },
  ];
  assert.equal(filterIctPredictions(rows, { maxPips: 100 }).length, 1);
  assert.equal(filterIctPredictions(rows, { minPips: 100 }).length, 1);
  assert.equal(filterIctPredictions(rows, { proOnly: true, maxPips: 100 }).length, 1);
  assert.equal(filterIctPredictions(rows, { symbol: 'EURUSDM' }).length, 1);
  assert.equal(filterIctPredictions(rows, { timeframe: 'M15', direction: 'BUY' }).length, 2);
  assert.equal(filterIctPredictions(rows, { minScore: 85 }).length, 1);
  assert.equal(filterIctPredictions(rows, { minRR: 4 }).length, 1);
  assert.equal(filterIctPredictions(rows, { strategy: 'ict-break-pro' }).length, 1);
  assert.equal(filterIctPredictions(rows, {}).length, 3, 'no filters means no filtering');
});

// ── tracking: the sweep is the prediction, not the invalidation ──────────────

const TRACKED = {
  direction: 'BUY', level: 1990, structureLevel: 2010, atr: 10, status: 'WAITING',
  distance: { atr: 1 }, eta: { maxMinutes: 120 }, createdAt: '2026-01-01T00:00:00.000Z',
};
const NOW = Date.parse('2026-01-01T00:30:00.000Z');

test('a reclaim outranks everything else — at that point the breaker exists', () => {
  const r = assessIctPrediction({ prediction: TRACKED, price: 2015, extreme: 1985, reclaimed: true, now: NOW });
  assert.equal(r.verdict, 'CONFIRMED');
  assert.equal(r.alertWorthy, true);
});

test('price trading through the pool is SWEPT_WAITING, not a broken premise', () => {
  // The generic forecast tracker calls this REVERSED. On an ICT page that reading is backwards:
  // the sweep is the setup starting.
  const r = assessIctPrediction({ prediction: TRACKED, price: 1989, extreme: 1985, now: NOW });
  assert.equal(r.verdict, 'SWEPT_WAITING');
  assert.equal(r.throughAtr, 0.5);
  assert.match(r.suggestion, /needs a conviction close/);
});

test('price accepting well through the pool without reclaiming is the real failure', () => {
  const r = assessIctPrediction({ prediction: TRACKED, price: 1975, extreme: 1974, now: NOW });
  assert.equal(r.verdict, 'FAILED_SWEEP');
  assert.equal(r.alertWorthy, true);
  assert.match(r.suggestion, /flipped to resistance/);
});

test('the sweep is measured from the EXTREME, not the close — a wick takes liquidity', () => {
  // Judging on the close alone would miss every wick sweep, which is most of them.
  const r = assessIctPrediction({ prediction: TRACKED, price: 1995, extreme: 1988, now: NOW });
  assert.equal(r.verdict, 'SWEPT_WAITING');
});

test('a bearish prediction mirrors: through means ABOVE the pool', () => {
  const bear = { ...TRACKED, direction: 'SELL', level: 2010, structureLevel: 1990 };
  assert.equal(assessIctPrediction({ prediction: bear, price: 2011, extreme: 2015, now: NOW }).verdict, 'SWEPT_WAITING');
  assert.equal(assessIctPrediction({ prediction: bear, price: 2025, extreme: 2026, now: NOW }).verdict, 'FAILED_SWEEP');
  assert.equal(assessIctPrediction({ prediction: bear, price: 2008, extreme: 2008, now: NOW }).verdict, 'AT_THE_POOL');
});

test('an expired window without arrival is STALE, and drifting away is not fatal', () => {
  const late = Date.parse('2026-01-01T03:00:00.000Z');
  assert.equal(assessIctPrediction({ prediction: TRACKED, price: 2005, extreme: 2005, now: late }).verdict, 'STALE');
  const drift = assessIctPrediction({ prediction: TRACKED, price: 2030, extreme: 2030, now: NOW });
  assert.equal(drift.verdict, 'DRIFTED_AWAY');
  assert.equal(drift.alertWorthy, false, 'walking away is news, not an emergency');
});

test('a resolved prediction is CLOSED and judged no further', () => {
  const r = assessIctPrediction({ prediction: { ...TRACKED, status: 'RESOLVED' }, price: 1900, extreme: 1900, now: NOW });
  assert.equal(r.verdict, 'CLOSED');
  assert.equal(r.alertWorthy, false);
});

test('exactly one alert per prediction, ever', () => {
  const hot = assessIctPrediction({ prediction: TRACKED, price: 1989, extreme: 1985, now: NOW });
  assert.equal(shouldAlertIct(hot, { alertedAt: null }), true);
  assert.equal(shouldAlertIct(hot, { alertedAt: '2026-01-01T00:10:00.000Z' }), false);
  const quiet = assessIctPrediction({ prediction: TRACKED, price: 2005, extreme: 2005, now: NOW });
  assert.equal(shouldAlertIct(quiet, {}), false, 'good news never mails');
});

// ── the ticket the strategy hands back has to survive arithmetic ─────────────

test('every projected ticket has its stop on the losing side and targets on the winning side', () => {
  const candles = series();
  const atr = atr14(candles);
  const swings = fractalSwings(candles);
  const price = candles[candles.length - 1].close;
  const out = runIctPredictions({
    base: ctxFor(candles), swings, atr, price, pip: 0.1,
    symbol: 'XAUUSDM', timeframe: TF, evaluate: evaluateStrategy, stageOf: computeStage,
  });
  assert.ok(out.predictions.length);
  for (const p of out.predictions) {
    const buy = p.direction === 'BUY';
    const t = p.strategyPlan;
    assert.ok(buy ? t.stopLoss < t.entry : t.stopLoss > t.entry, 'stop on the wrong side of entry');
    for (const tp of [t.takeProfit1, t.takeProfit2, t.takeProfit3]) {
      if (tp === null || tp === undefined) continue;
      assert.ok(buy ? tp > t.entry : tp < t.entry, `target ${tp} is on the wrong side of entry ${t.entry}`);
    }
    assert.ok((p.rr ?? 0) >= 1.5, `RR ${p.rr} below the strategies' own floor`);
  }
});

test('the projected plan agrees with what buildLiquidityPlan derives from the same bars', () => {
  // The ticket must come from the strategies, not from anything invented here. Rebuilding it
  // independently from the detectors is the check that nothing in between rewrote a price.
  const candles = series();
  const atr = atr14(candles);
  const swings = fractalSwings(candles);
  const price = candles[candles.length - 1].close;
  const out = runIctPredictions({
    base: ctxFor(candles), swings, atr, price, pip: 0.1,
    symbol: 'XAUUSDM', timeframe: TF, evaluate: evaluateStrategy, stageOf: computeStage,
  });
  const p = out.predictions[0];
  const projected = [...candles, ...p.projectedBars];
  const plan = buildLiquidityPlan(detectBreaker(projected, { maxAgeBars: 50 }), detectLiquidityPools(projected));
  assert.ok(plan, 'the detectors should build the same plan');
  assert.equal(plan.direction, p.strategyPlan.direction);
  assert.ok(Math.abs(plan.entry - p.strategyPlan.entry) < 1e-4, 'entry must come from the detector, unmodified');
  assert.ok(Math.abs(plan.stop - p.strategyPlan.stopLoss) < 1e-4, 'stop must come from the detector, unmodified');
});
