import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pipSizeFor, decisionOf, tradeR, tradePips, summarise, tStatistic,
  multipleComparisonBar, groupBy, notTakenBreakdown, DECISION, NOT_TAKEN_REASONS,
} from './wouldTradeLedger.js';

const raw = (o = {}) => ({
  strategy: 'ict-breaker', symbol: 'EURUSD', timeframe: 'M5', account: '1514170986',
  direction: 'BUY', status: 'CLOSED', fill_price: 1.1000, close_price: 1.1020,
  profit: 40, risk_amount: 80, lots: 0.5, ...o,
});
/** A ledger row as the endpoint builds it. */
const row = (o = {}) => {
  const r = raw(o);
  const d = decisionOf(r);
  return { ...r, ...d, r: tradeR(r), pips: tradePips(r) };
};

// ── pip scale ────────────────────────────────────────────────────────────────

test('pip size follows the instrument, not a forex default', () => {
  assert.equal(pipSizeFor('EURUSD'), 0.0001);
  assert.equal(pipSizeFor('USDJPY'), 0.01);
  assert.equal(pipSizeFor('XAUUSD'), 0.1);
  // Index CFDs must come from SYMBOL_CAPS. Scaling USTEC as forex reported a mean stop of
  // 771,478 pips and poisoned an entire measurement.
  assert.equal(pipSizeFor('USTECm'), 1.0);
  assert.equal(pipSizeFor('USTEC_x100m'), 1.0);
});

// ── taken vs not taken ───────────────────────────────────────────────────────

test('only a filled trade counts as TAKEN', () => {
  assert.equal(decisionOf(raw({ status: 'CLOSED' })).decision, DECISION.TAKEN);
  // A CLOSED row with no fill never reached the market and must not be counted as a trade.
  assert.equal(decisionOf(raw({ status: 'CLOSED', fill_price: null })).decision, DECISION.NOT_TAKEN);
});

test('every not-taken status is explained in plain language', () => {
  for (const status of Object.keys(NOT_TAKEN_REASONS)) {
    const d = decisionOf(raw({ status, fill_price: null }));
    assert.equal(d.decision, DECISION.NOT_TAKEN);
    assert.equal(d.reason, NOT_TAKEN_REASONS[status]);
  }
});

test('an unknown status falls back to the stored reason rather than vanishing', () => {
  const d = decisionOf(raw({ status: 'WEIRD', fill_price: null, reason: 'bridge said no' }));
  assert.equal(d.decision, DECISION.NOT_TAKEN);
  assert.equal(d.reason, 'bridge said no');
});

// ── R is measured against the risk actually budgeted ─────────────────────────

test('R uses the ticket own risk, so accounts with different budgets compare', () => {
  // risk_amount ranged $10-$85 across these 10 accounts. Ranking on raw dollars would put a
  // big-risk scratch above a small-risk winner.
  assert.equal(tradeR(raw({ profit: 40, risk_amount: 80 })), 0.5);
  assert.equal(tradeR(raw({ profit: 40, risk_amount: 10 })), 4);
  assert.equal(tradeR(raw({ profit: -88.17, risk_amount: 80 })), -1.102);
});

test('R is null without a real risk, never a divide by zero or a silent zero', () => {
  assert.equal(tradeR(raw({ risk_amount: 0 })), null);
  assert.equal(tradeR(raw({ risk_amount: null })), null);
  assert.equal(tradeR(raw({ profit: null })), null);
});

test('pips are measured from the FILL and signed by direction', () => {
  // The plan is what was hoped for; the fill is what happened, and they differ by up to a pip.
  assert.equal(tradePips(raw({ direction: 'BUY', fill_price: 1.1, close_price: 1.102 })), 20);
  assert.equal(tradePips(raw({ direction: 'SELL', fill_price: 1.1, close_price: 1.098 })), 20);
  assert.equal(tradePips(raw({ direction: 'SELL', fill_price: 1.1, close_price: 1.102 })), -20);
  assert.equal(tradePips(raw({ close_price: null })), null);
});

test('JPY and gold pips scale correctly', () => {
  assert.equal(tradePips(raw({ symbol: 'USDJPY', direction: 'BUY', fill_price: 150, close_price: 150.2 })), 20);
  assert.equal(tradePips(raw({ symbol: 'XAUUSD', direction: 'BUY', fill_price: 4000, close_price: 4002 })), 20);
});

// ── summarise: real money only ───────────────────────────────────────────────

test('not-taken decisions are counted but contribute no money', () => {
  // Assuming how a trade that never existed would have finished is the exact assumption that
  // made the signal log 1.21R optimistic.
  const s = summarise([
    row({ profit: 100 }),
    row({ status: 'GUARD_SKIP', fill_price: null, profit: null }),
    row({ status: 'EXPIRED', fill_price: null, profit: null }),
  ]);
  assert.equal(s.decisions, 3);
  assert.equal(s.taken, 1);
  assert.equal(s.notTaken, 2);
  assert.equal(s.netProfit, 100, 'only the filled trade contributes');
  assert.equal(s.settled, 1);
});

test('fill rate says how much of the pipeline reaches the market', () => {
  const s = summarise([row(), row(), row({ status: 'EXPIRED', fill_price: null, profit: null })]);
  // Rates are rounded to 4dp on purpose, so compare at that precision.
  assert.equal(s.fillRate, 0.6667);
});

test('expectancy exposes a high win rate that loses money', () => {
  const trades = [
    ...Array(9).fill(0).map(() => row({ profit: 8, risk_amount: 80 })),
    row({ profit: -80, risk_amount: 80 }),
  ];
  const s = summarise(trades);
  assert.equal(s.winRate, 0.9);
  assert.ok(s.expectancy < 0, `expectancy ${s.expectancy} must be negative`);
  assert.ok(s.expectancyR < 0);
});

test('an empty set has NaN expectancy, not a flattering zero', () => {
  const s = summarise([]);
  assert.ok(Number.isNaN(s.expectancy));
  assert.ok(Number.isNaN(s.expectancyR));
  assert.equal(s.settled, 0);
  assert.equal(s.fillRate, null);
});

test('a set with only not-taken decisions reports no expectancy', () => {
  const s = summarise([row({ status: 'ERROR', fill_price: null, profit: null })]);
  assert.equal(s.taken, 0);
  assert.ok(Number.isNaN(s.expectancy));
  assert.equal(s.netProfit, 0);
});

test('drawdown and losing streak are reported — a total hides both', () => {
  const s = summarise([
    row({ profit: 100 }), row({ profit: -50 }), row({ profit: -50 }), row({ profit: -50 }), row({ profit: 100 }),
  ]);
  assert.equal(s.worstLossStreak, 3);
  assert.equal(s.maxDrawdown, 150);
});

test('profit factor is Infinity with no losses and null with no trades', () => {
  assert.equal(summarise([row({ profit: 10 })]).profitFactor, Infinity);
  assert.equal(summarise([]).profitFactor, null);
});

test('pips and lots accumulate only over filled trades', () => {
  const s = summarise([
    row({ direction: 'BUY', fill_price: 1.1, close_price: 1.102, lots: 0.5 }),
    row({ status: 'EXPIRED', fill_price: null, close_price: null, profit: null, lots: 2 }),
  ]);
  assert.equal(s.netPips, 20);
  assert.equal(s.totalLots, 0.5);
});

// ── significance ─────────────────────────────────────────────────────────────

test('the correction bar rises with the number of combos searched', () => {
  const one = multipleComparisonBar(1);
  const many = multipleComparisonBar(500);
  assert.ok(one.criticalT > 1.9 && one.criticalT < 2.1, `single-test bar ~1.96, got ${one.criticalT}`);
  assert.ok(many.criticalT > one.criticalT);
  assert.ok(many.criticalT > 3.5, `500 combos needs a much higher bar, got ${many.criticalT}`);
});

test('t-statistic needs at least two trades with R', () => {
  assert.equal(tStatistic([row()]).t, null);
  assert.equal(tStatistic([]).t, null);
});

test('identical results give no variance and therefore no t-statistic', () => {
  // A zero standard error would otherwise report infinite confidence from five trades.
  const t = tStatistic(Array(5).fill(0).map(() => row({ profit: 80, risk_amount: 80 })));
  assert.equal(t.sd, 0);
  assert.equal(t.t, null);
});

// ── grouping ─────────────────────────────────────────────────────────────────

test('account is a groupable dimension — 10 of them ran in six weeks', () => {
  const rows = [
    row({ account: 'A', profit: 100 }), row({ account: 'A', profit: 50 }),
    row({ account: 'B', profit: -200 }),
  ];
  const { rows: out } = groupBy(rows, ['account'], { minTrades: 1 });
  assert.equal(out.length, 2);
  assert.equal(out[0].account, 'A');
  assert.equal(out[0].netProfit, 150);
  assert.equal(out[1].netProfit, -200);
});

test('grouping splits by every requested dimension', () => {
  const rows = [
    row({ strategy: 'a', symbol: 'EURUSD', timeframe: 'M5' }),
    row({ strategy: 'a', symbol: 'EURUSD', timeframe: 'M15' }),
    row({ strategy: 'b', symbol: 'XAUUSD', timeframe: 'M5' }),
  ];
  assert.equal(groupBy(rows, ['strategy'], { minTrades: 1 }).rows.length, 2);
  assert.equal(groupBy(rows, ['strategy', 'symbol', 'timeframe'], { minTrades: 1 }).rows.length, 3);
});

test('combos below the trade floor sort last however profitable they look', () => {
  const rows = [
    ...Array(20).fill(0).map(() => row({ strategy: 'solid', profit: 5 })),
    ...Array(2).fill(0).map(() => row({ strategy: 'fluke', profit: 400 })),
  ];
  const { rows: out } = groupBy(rows, ['strategy'], { minTrades: 10 });
  assert.equal(out[0].strategy, 'solid', 'a 2-trade $800 combo must not outrank a 20-trade one');
  assert.equal(out[1].belowSampleFloor, true);
});

test('a group of only not-taken decisions still appears, with its count', () => {
  // These are the combos being dropped entirely; hiding them would hide the problem.
  const rows = [row({ strategy: 'never', status: 'GUARD_SKIP', fill_price: null, profit: null })];
  const { rows: out } = groupBy(rows, ['strategy'], { minTrades: 1 });
  assert.equal(out[0].decisions, 1);
  assert.equal(out[0].taken, 0);
  assert.equal(out[0].notTaken, 1);
});

// ── not-taken breakdown ──────────────────────────────────────────────────────

test('missed decisions are ranked by cause with a share of the total', () => {
  const rows = [
    row({ status: 'EXPIRED', fill_price: null, profit: null }),
    row({ status: 'EXPIRED', fill_price: null, profit: null }),
    row({ status: 'GUARD_SKIP', fill_price: null, profit: null }),
    row({ profit: 10 }),
  ];
  const out = notTakenBreakdown(rows);
  assert.equal(out.length, 2);
  assert.equal(out[0].status, 'EXPIRED');
  assert.equal(out[0].count, 2);
  assert.equal(out[0].share, 0.6667, 'share is of missed decisions, not of all');
  assert.equal(out[0].reason, NOT_TAKEN_REASONS.EXPIRED);
});

test('taken trades never appear in the missed breakdown', () => {
  assert.equal(notTakenBreakdown([row({ profit: 10 })]).length, 0);
});
