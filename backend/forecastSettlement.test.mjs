import assert from 'node:assert/strict';
import test from 'node:test';
import { settleForecastTicket, matchRealTrade, aggregateSettled } from './forecastSettlement.js';

const PIP = 0.1;                       // gold
// A BUY ticket: entry 4000, stop 3993.5 (65 pips), ladder 4006.5 / 4013 / 4019.5 (1R/2R/3R)
const PLAN = {
  direction: 'BUY', entry: 4000, stopLoss: 3993.5,
  takeProfit: 4006.5, takeProfit2: 4013, takeProfit3: 4019.5,
  lots: 0.08, pipValuePerLot: 10,
};
const bar = (high, low, time = '2026-07-30T12:00:00.000Z') => ({ time, open: 4000, high, low, close: (high + low) / 2 });
const settle = (candles, over = {}) => settleForecastTicket({ plan: { ...PLAN, ...over }, candles, pip: PIP });

// ── hypothetical replay ──────────────────────────────────────────────────────

test('a clean run to TP1 settles as TP1 with signed pips and R', () => {
  const s = settle([bar(4007, 3999)]);
  assert.equal(s.outcome, 'TP1');
  assert.equal(s.tpLevel, 1);
  assert.equal(s.pips, 65);
  assert.equal(s.rMultiple, 1);
  assert.equal(s.estimatedProfit, 52);       // 65 pips x 0.08 lots x $10
});

test('the ladder upgrades as further targets are banked', () => {
  const s = settle([bar(4007, 3999), bar(4014, 4005), bar(4020, 4012)]);
  assert.equal(s.outcome, 'TP3');
  assert.equal(s.tpLevel, 3);
  assert.equal(s.rMultiple, 3);
  assert.equal(s.pips, 195);
});

test('a stop with no target is a LOSS with negative pips', () => {
  const s = settle([bar(4002, 3993)]);
  assert.equal(s.outcome, 'LOSS');
  assert.equal(s.pips, -65);
  assert.equal(s.rMultiple, -1);
  assert.equal(s.estimatedProfit, -52);
});

test('a bar touching BOTH stop and target is AMBIGUOUS, never a win', () => {
  // The single most important rule here: OHLC cannot say which came first, and guessing
  // "win" is how a track record becomes a lie.
  const s = settle([bar(4007, 3993)]);
  assert.equal(s.outcome, 'AMBIGUOUS');
  assert.equal(s.pips, null, 'an unknowable result must not be scored');
  assert.equal(s.rMultiple, null);
  assert.equal(s.estimatedProfit, null);
});

test('a target banked EARLIER survives a later stop collision', () => {
  const s = settle([bar(4007, 3999), bar(4014, 3993)]);
  assert.equal(s.outcome, 'TP1', 'TP1 was real money on bar 1; bar 2 cannot erase it');
  assert.equal(s.pips, 65);
});

test('a ticket still running at the end of the window is OPEN, not a result', () => {
  const s = settle([bar(4004, 3998), bar(4005, 3999)]);
  assert.equal(s.outcome, 'OPEN');
  assert.equal(s.pips, null);
  assert.ok(s.mfePips > 0, 'excursions are still measured while open');
});

test('SELL tickets mirror the arithmetic', () => {
  const sell = { direction: 'SELL', entry: 4000, stopLoss: 4006.5, takeProfit: 3993.5, takeProfit2: 3987, takeProfit3: null, lots: 0.08, pipValuePerLot: 10 };
  const win = settleForecastTicket({ plan: sell, candles: [bar(4001, 3993)], pip: PIP });
  assert.equal(win.outcome, 'TP1');
  assert.equal(win.pips, 65);
  const loss = settleForecastTicket({ plan: sell, candles: [bar(4007, 3999)], pip: PIP });
  assert.equal(loss.outcome, 'LOSS');
  assert.equal(loss.pips, -65);
});

test('targets on the wrong side of entry are ignored rather than banked instantly', () => {
  // A malformed ladder must not hand out a free win on the first bar.
  const s = settle([bar(4001, 3999)], { takeProfit: 3990, takeProfit2: null, takeProfit3: null });
  assert.equal(s.outcome, 'OPEN');
});

test('excursions are reported in pips for both sides', () => {
  const s = settle([bar(4008, 3996)]);
  assert.equal(s.mfePips, 80);
  assert.equal(s.maePips, 40);
});

test('settlement refuses to run on an unusable ticket', () => {
  assert.equal(settleForecastTicket({ plan: null, candles: [bar(4007, 3999)], pip: PIP }), null);
  assert.equal(settle([], {}), null);
  assert.equal(settle([bar(4007, 3999)], { stopLoss: 4000 }), null, 'zero risk cannot be settled');
  assert.equal(settleForecastTicket({ plan: PLAN, candles: [bar(4007, 3999)], pip: 0 }), null);
});

test('estimated profit needs a size — no lots means no money claim', () => {
  const s = settle([bar(4007, 3999)], { lots: null });
  assert.equal(s.pips, 65);
  assert.equal(s.estimatedProfit, null);
});

// ── real-trade linkage ───────────────────────────────────────────────────────

const FORECAST = {
  symbol: 'XAUUSD', expectedDirection: 'BUY',
  arrivedIso: '2026-07-30T12:00:00.000Z',
  plan: { direction: 'BUY', entry: 4000 },
};
const trade = (over = {}) => ({
  ticket: 111, symbol: 'XAUUSD', direction: 'BUY', strategy: 'liq-trap-pro',
  fillPrice: 4000.4, lots: 0.08, profit: 52.4,
  openedAt: '2026-07-30T12:20:00.000Z', closedAt: '2026-07-30T14:00:00.000Z', ...over,
});
const link = (trades, over = {}) => matchRealTrade({ forecast: FORECAST, trades, pip: PIP, ...over });

test('a real trade at the forecast entry, after arrival, links with its P&L', () => {
  const m = link([trade()]);
  assert.equal(m.ambiguous, false);
  assert.equal(m.ticket, 111);
  assert.equal(m.profit, 52.4);
  assert.equal(m.entryGapPips, 4);
  assert.equal(m.minutesAfterArrival, 20);
  assert.match(m.reason, /same symbol\+direction/);
});

test('trades on another symbol or the other side never link', () => {
  assert.equal(link([trade({ symbol: 'EURUSD' })]), null);
  assert.equal(link([trade({ direction: 'SELL' })]), null);
});

test('a trade opened BEFORE the level was reached was not taken on this forecast', () => {
  assert.equal(link([trade({ openedAt: '2026-07-30T11:00:00.000Z' })]), null);
  // A trade far past the window is a different decision.
  assert.equal(link([trade({ openedAt: '2026-07-31T02:00:00.000Z' })]), null);
});

test('a fill too far from the forecast entry is a different trade', () => {
  assert.equal(link([trade({ fillPrice: 4009 })]), null, '90 pips away is not this ticket');
  assert.ok(link([trade({ fillPrice: 4002 })]), '20 pips is inside tolerance');
});

test('two equally plausible trades report ambiguity instead of guessing', () => {
  // Attaching real money to the wrong prediction corrupts the one non-hypothetical number
  // in the whole report, so a tie must refuse rather than pick.
  const m = link([trade({ ticket: 111, fillPrice: 4000.4 }), trade({ ticket: 222, fillPrice: 4000.5 })]);
  assert.equal(m.ambiguous, true);
  assert.equal(m.candidateCount, 2);
  assert.match(m.reason, /multiple trades/);
});

test('a clearly closer trade wins over a distant one', () => {
  const m = link([trade({ ticket: 111, fillPrice: 4002.4 }), trade({ ticket: 222, fillPrice: 4000.1 })]);
  assert.equal(m.ambiguous, false);
  assert.equal(m.ticket, 222);
});

test('linkage degrades safely on missing data', () => {
  assert.equal(link([]), null);
  assert.equal(link(null), null);
  assert.equal(link([trade({ fillPrice: null })]), null);
  assert.equal(link([trade({ openedAt: 'garbage' })]), null);
  assert.equal(matchRealTrade({ forecast: FORECAST, trades: [trade()], pip: 0 }), null);
});

test('snake_case rows from the DB link the same as camelCase', () => {
  const m = link([{ ticket: 9, symbol: 'XAUUSD', direction: 'BUY', fill_price: 4000.2, profit: 30, opened_at: '2026-07-30T12:10:00.000Z' }]);
  assert.equal(m.ticket, 9);
  assert.equal(m.profit, 30);
});

// ── aggregation ──────────────────────────────────────────────────────────────

const settled = (over = {}) => ({ hitOutcome: 'TP1', hitPips: 65, realPnl: null, ...over });

test('aggregation separates settled results from open and ambiguous ones', () => {
  const rows = [
    settled({ hitOutcome: 'TP1', hitPips: 65 }),
    settled({ hitOutcome: 'LOSS', hitPips: -65 }),
    settled({ hitOutcome: 'AMBIGUOUS', hitPips: null }),
    settled({ hitOutcome: 'OPEN', hitPips: null }),
  ];
  const [g] = aggregateSettled(rows, () => 'all');
  assert.equal(g.matched, 4);
  assert.equal(g.settled, 2, 'ambiguous and open must not count toward a win rate');
  assert.equal(g.wins, 1);
  assert.equal(g.losses, 1);
  assert.equal(g.ambiguous, 1);
  assert.equal(g.open, 1);
  assert.equal(g.winRate, 50);
  assert.equal(g.pips, 0);
});

test('real P&L only counts rows that actually had a trade', () => {
  const [g] = aggregateSettled([
    settled({ realPnl: 52.4 }), settled({ realPnl: -18 }), settled({ realPnl: null }),
  ], () => 'all');
  assert.equal(g.realTrades, 2);
  assert.equal(g.realPnl, 34.4);
});

test('aggregation groups by any key and sorts by volume', () => {
  const rows = [
    settled({ strategy: 'a' }), settled({ strategy: 'a' }), settled({ strategy: 'b' }),
  ];
  const out = aggregateSettled(rows, (r) => r.strategy);
  assert.equal(out[0].key, 'a');
  assert.equal(out[0].matched, 2);
  assert.equal(out.length, 2);
});

test('rows with no grouping key are skipped, not bucketed under undefined', () => {
  const out = aggregateSettled([settled({ s: 'a' }), settled({ s: null })], (r) => r.s);
  assert.equal(out.length, 1);
  assert.equal(out[0].matched, 1);
});
