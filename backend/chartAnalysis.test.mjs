// Pure unit tests for chartAnalysis.js — run: node backend/chartAnalysis.test.mjs
import assert from 'node:assert';
import {
  timeframeToMs, normalizeDirection, estimateDirectionalPersistence,
  buildConditionalTimeTrigger, pickTriggerLevel, assembleForexPlan,
  assembleFttPlan, buildSystemChartAnalysis,
} from './chartAnalysis.js';

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log(`  ok  ${name}`); };

// ── timeframeToMs ──
t('timeframeToMs maps units', () => {
  assert.equal(timeframeToMs('M5'), 5 * 60000);
  assert.equal(timeframeToMs('M15'), 15 * 60000);
  assert.equal(timeframeToMs('H1'), 3600000);
  assert.equal(timeframeToMs('D1'), 86400000);
  assert.equal(timeframeToMs('garbage'), 0);
});

// ── normalizeDirection ──
t('normalizeDirection collapses synonyms', () => {
  assert.equal(normalizeDirection('BUY'), 'UP');
  assert.equal(normalizeDirection('STRONG_SELL'), 'DOWN');
  assert.equal(normalizeDirection('HOLD'), 'NONE');
});

// helper: build candles with explicit up/down sequence (up: close>open)
const mkCandles = (seq, startMs = Date.parse('2026-06-26T00:00:00Z'), tfMs = 300000) =>
  seq.map((d, i) => {
    const open = 100;
    const close = d > 0 ? 101 : d < 0 ? 99 : 100;
    return { time: new Date(startMs + i * tfMs).toISOString(), open, high: 102, low: 98, close };
  });

// ── estimateDirectionalPersistence ──
t('persistence finds median up-run length', () => {
  // up-runs of lengths: 3, 1, 2  → median 2
  const seq = [1, 1, 1, -1, 1, -1, -1, 1, 1, -1, 1, 1, 1, 1];
  const r = estimateDirectionalPersistence(mkCandles(seq), 'UP');
  assert.ok(r.sampleRuns >= 3, 'should detect multiple runs');
  assert.ok(r.expectedCandles >= 1, 'expectedCandles positive');
  assert.equal(typeof r.basis, 'string');
});

t('persistence guards tiny / no-direction input', () => {
  assert.equal(estimateDirectionalPersistence([], 'UP').expectedCandles, null);
  assert.equal(estimateDirectionalPersistence(mkCandles([1, 1]), 'NONE').basis, 'insufficient-data');
  // all-down candles → no up runs
  const allDown = estimateDirectionalPersistence(mkCandles(Array(12).fill(-1)), 'UP');
  assert.equal(allDown.expectedCandles, null);
});

// ── buildConditionalTimeTrigger ──
t('time trigger sets ABOVE for UP and rolls forward', () => {
  const candles = mkCandles([1, 1, 1], Date.parse('2026-06-26T10:00:00Z'), 300000);
  const now = Date.parse('2026-06-26T10:11:00Z'); // last bar opened 10:10, closes 10:15
  const trig = buildConditionalTimeTrigger({ candles, timeframe: 'M5', level: 1.2345, direction: 'BUY', now });
  assert.equal(trig.condition, 'ABOVE');
  assert.equal(trig.level, 1.2345);
  assert.ok(Date.parse(trig.atIso) > now, 'trigger time is in the future');
  assert.equal(trig.elseAction, 'IGNORE');
});

t('time trigger sets BELOW for DOWN', () => {
  const candles = mkCandles([-1, -1], Date.parse('2026-06-26T10:00:00Z'), 900000);
  const trig = buildConditionalTimeTrigger({ candles, timeframe: 'M15', level: 50, direction: 'SELL', now: Date.parse('2026-06-26T10:05:00Z') });
  assert.equal(trig.condition, 'BELOW');
});

// ── pickTriggerLevel ──
t('pickTriggerLevel prefers breakout level', () => {
  const lvl = pickTriggerLevel({ breakout: { level: 1.5 }, supportResistance: null, direction: 'UP', price: 1.4 });
  assert.equal(lvl, 1.5);
});
t('pickTriggerLevel finds nearest resistance above for UP', () => {
  const sr = { resistance: [{ level: 1.6 }, { level: 1.45 }], support: [{ level: 1.3 }] };
  const lvl = pickTriggerLevel({ breakout: null, supportResistance: sr, direction: 'UP', price: 1.4 });
  assert.equal(lvl, 1.45);
});

// ── assembleForexPlan ──
t('assembleForexPlan passes through a real setup + sizing', () => {
  const sd = { decision: 'BUY', entryPrice: 1.1, stopLoss: 1.09, takeProfit1: 1.12, takeProfit2: 1.13, takeProfit3: 1.14, riskRewardRatio: 2, regime: 'trending', grade: 'A' };
  const plan = assembleForexPlan({ systemDecision: sd, sizing: { suggestedLots: 0.25, stopPips: 100, lossAtStop: 25 } });
  assert.equal(plan.decision, 'BUY');
  assert.equal(plan.lots, 0.25);
  assert.equal(plan.riskReward, 2);
});
t('assembleForexPlan returns HOLD shape when no setup', () => {
  const plan = assembleForexPlan({ systemDecision: { decision: 'HOLD', entryPrice: 1.1 }, sizing: null });
  assert.equal(plan.decision, 'HOLD');
  assert.equal(plan.lots, null);
});

// ── assembleFttPlan ──
t('assembleFttPlan carries persistence + trigger', () => {
  const ftt = { direction: 'UP', confidence: 62, reasoning: 'x', indicators: { timeframeMapping: { bias: 'H4', trend: 'M15', entry: 'M5', confirmation: 'M1' } } };
  const plan = assembleFttPlan({ fttPrediction: ftt, persistence: { expectedCandles: 3, p25: 2, p75: 5, basis: 'median of 8 up runs' }, timeTrigger: { atLabel: '6:30 PM BDT', condition: 'ABOVE', level: 1.2 } });
  assert.equal(plan.direction, 'UP');
  assert.equal(plan.expectedCandlesInDirection, 3);
  assert.equal(plan.suggestedTimeframe, 'M5');
  assert.equal(plan.timeTrigger.condition, 'ABOVE');
});

// ── buildSystemChartAnalysis (fallback) ──
t('buildSystemChartAnalysis assembles a complete BOTH-mode result', () => {
  const candles = mkCandles([1, 1, -1, 1, 1, 1, -1, 1, 1, 1, 1], Date.parse('2026-06-26T09:00:00Z'), 300000);
  const out = buildSystemChartAnalysis({
    symbol: 'XAUUSDM', timeframe: 'M5', tradeMode: 'BOTH',
    systemDecision: { decision: 'BUY', entryPrice: 2000, stopLoss: 1990, takeProfit1: 2010, riskRewardRatio: 1.8, htfBias: 'BULLISH', regime: 'trending', grade: 'A', supportResistance: { support: [{ level: 1990 }], resistance: [{ level: 2010 }] } },
    fttPrediction: { direction: 'UP', confidence: 60, indicators: { timeframeMapping: { entry: 'M5' } } },
    breakout: { phase: 'CONFIRMED', direction: 'BUY', grade: 'A', level: 2005, displacement: { present: true } },
    sizing: { suggestedLots: 0.1, stopPips: 100, lossAtStop: 10 },
    candles, strategies: [{ id: 'ict-breaker', decision: 'BUY', score: 80 }],
  });
  assert.equal(out.forexPlan.decision, 'BUY');
  assert.equal(out.fttPlan.direction, 'UP');
  assert.ok(out.fttPlan.timeTrigger.atIso, 'has a time trigger');
  assert.equal(out.breakout.phase, 'CONFIRMED');
  assert.ok(out.honesty.length >= 1);
});

t('buildSystemChartAnalysis honours FOREX-only / FTT-only modes', () => {
  const candles = mkCandles(Array(12).fill(1));
  const fx = buildSystemChartAnalysis({ symbol: 'EURUSDM', timeframe: 'M15', tradeMode: 'FOREX', systemDecision: { decision: 'BUY', entryPrice: 1.1 }, candles });
  assert.ok(fx.forexPlan);
  assert.equal(fx.fttPlan, null);
  const ft = buildSystemChartAnalysis({ symbol: 'EURUSDM', timeframe: 'M15', tradeMode: 'FTT', fttPrediction: { direction: 'DOWN' }, candles });
  assert.equal(ft.forexPlan, null);
  assert.ok(ft.fttPlan);
});

console.log(`\nchartAnalysis: ${passed} tests passed.`);
