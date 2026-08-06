import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isPendingOrder, fillIndex, replayDecision, summariseReplay, REPLAY_OUTCOME,
} from './wouldTradeReplay.js';

const bar = (o, h, l, c) => ({ open: o, high: h, low: l, close: c });
const flat = (count, p = 100) => Array.from({ length: count }, () => bar(p, p + 0.1, p - 0.1, p));

const dec = (o = {}) => ({
  direction: 'BUY', order_type: 'MARKET',
  entry_price: 100, stop_loss: 99, take_profit_1: 102, take_profit_3: 104, ...o,
});

// ── order type ───────────────────────────────────────────────────────────────

test('pending order types are recognised however the broker spells them', () => {
  for (const t of ['BUY_LIMIT', 'SELL_LIMIT', 'buy_stop', 'SELL STOP', 'LIMIT']) {
    assert.equal(isPendingOrder(t), true, `${t} is pending`);
  }
  for (const t of ['MARKET', 'market', '', null, undefined]) {
    assert.equal(isPendingOrder(t), false, `${t} is not pending`);
  }
});

// ── fill realism: the guard this whole module exists for ─────────────────────

test('a market order fills immediately by definition', () => {
  assert.equal(fillIndex(flat(10), { entry: 100, direction: 'BUY', orderType: 'MARKET' }), 0);
});

test('a buy limit fills only when price trades DOWN to it', () => {
  const bars = [bar(105, 106, 104, 105), bar(104, 105, 103, 104), bar(103, 104, 99.5, 100)];
  assert.equal(fillIndex(bars, { entry: 100, direction: 'BUY', orderType: 'BUY_LIMIT' }), 2);
});

test('a sell limit fills only when price trades UP to it', () => {
  const bars = [bar(95, 96, 94, 95), bar(96, 97, 95, 96), bar(97, 100.5, 96, 100)];
  assert.equal(fillIndex(bars, { entry: 100, direction: 'SELL', orderType: 'SELL_LIMIT' }), 2);
});

test('a pending order price never reaches NEVER fills', () => {
  // The single most important rule here. 137 EXPIRED decisions are pending orders that expired
  // because price never came back; resolving them from their planned entry would credit trades
  // that could never have opened.
  const bars = Array.from({ length: 50 }, () => bar(110, 111, 109, 110));
  assert.equal(fillIndex(bars, { entry: 100, direction: 'BUY', orderType: 'BUY_LIMIT' }), null);
});

test('an intrabar touch fills a resting order — the close is not the test', () => {
  const bars = [bar(105, 106, 99.9, 105)];   // wicked down through 100, closed back at 105
  assert.equal(fillIndex(bars, { entry: 100, direction: 'BUY', orderType: 'BUY_LIMIT' }), 0);
});

// ── replay outcomes ──────────────────────────────────────────────────────────

test('a never-filled pending order carries NO result, not a loss', () => {
  // Counting it as a loss would be as wrong as counting it as a win: the trade did not exist.
  const bars = Array.from({ length: 30 }, () => bar(110, 111, 109, 110));
  const r = replayDecision(dec({ order_type: 'BUY_LIMIT' }), bars);
  assert.equal(r.outcome, REPLAY_OUTCOME.NEVER_FILLED);
  assert.equal(r.r, null);
});

test('a target reached before the stop is a win valued in R', () => {
  const bars = [bar(100, 100.5, 99.8, 100), bar(100, 102.5, 99.9, 102)];
  const r = replayDecision(dec(), bars);
  assert.equal(r.outcome, REPLAY_OUTCOME.WIN);
  assert.equal(r.r, 2, 'reward 2, risk 1');
});

test('a stop reached first is exactly -1R', () => {
  const r = replayDecision(dec(), [bar(100, 100.2, 98.5, 99)]);
  assert.equal(r.outcome, REPLAY_OUTCOME.LOSS);
  assert.equal(r.r, -1);
});

test('one bar straddling BOTH levels is a LOSS, never a win', () => {
  // Guessing "target" on an ambiguous bar is how a losing system becomes a winning backtest.
  const r = replayDecision(dec(), [bar(100, 103, 98, 101)]);
  assert.equal(r.outcome, REPLAY_OUTCOME.LOSS);
});

test('an unresolved trade is OPEN with null R, never a silent zero', () => {
  // A zero would be counted as a scratch and drag expectancy toward the middle.
  const r = replayDecision(dec(), flat(50));
  assert.equal(r.outcome, REPLAY_OUTCOME.OPEN);
  assert.equal(r.r, null);
});

test('a target on the losing side is INVALID, never an instant win', () => {
  const r = replayDecision(dec({ take_profit_1: 99.5 }), [bar(100, 101, 99, 100)]);
  assert.equal(r.outcome, REPLAY_OUTCOME.INVALID);
  assert.equal(r.r, null);
});

test('missing prices or candles are reported, not resolved', () => {
  assert.equal(replayDecision(dec({ stop_loss: null }), flat(5)).outcome, REPLAY_OUTCOME.INVALID);
  assert.equal(replayDecision(dec(), []).outcome, REPLAY_OUTCOME.NO_DATA);
  assert.equal(replayDecision(dec(), null).outcome, REPLAY_OUTCOME.NO_DATA);
});

test('SELL mirrors BUY exactly', () => {
  const up = [bar(100, 100.2, 99.9, 100), bar(100, 102.5, 99.9, 102)];
  const dn = [bar(100, 100.1, 99.8, 100), bar(100, 100.1, 97.5, 98)];
  const b = replayDecision(dec(), up);
  const s = replayDecision(dec({ direction: 'SELL', stop_loss: 101, take_profit_1: 98 }), dn);
  assert.equal(b.outcome, s.outcome);
  assert.equal(b.r, s.r);
});

test('resolution starts at the FILL bar, not the decision bar', () => {
  // A limit filled on bar 2 must not be charged for what happened on bars 0-1.
  const bars = [bar(105, 106, 104, 105), bar(104, 105, 103, 104), bar(103, 104, 99.9, 100), bar(100, 102.5, 99.9, 102)];
  const r = replayDecision(dec({ order_type: 'BUY_LIMIT' }), bars);
  assert.equal(r.filledAtIdx, 2);
  assert.equal(r.outcome, REPLAY_OUTCOME.WIN);
});

test('TP3 is asked separately rather than blended with TP1', () => {
  const bars = [bar(100, 100.2, 99.9, 100), bar(100, 102.5, 99.9, 102)];
  assert.equal(replayDecision(dec(), bars, { target: 'tp1' }).r, 2);
  // TP3 at 104 is not reached in this window, so it is OPEN rather than a 4R win.
  assert.equal(replayDecision(dec(), bars, { target: 'tp3' }).outcome, REPLAY_OUTCOME.OPEN);
});

test('TP3 falls back to TP1 when the ladder has no third rung', () => {
  const bars = [bar(100, 100.2, 99.9, 100), bar(100, 102.5, 99.9, 102)];
  assert.equal(replayDecision(dec({ take_profit_3: null }), bars, { target: 'tp3' }).r, 2);
});

// ── aggregation ──────────────────────────────────────────────────────────────

const R = (outcome, r) => ({ outcome, r });

test('never-filled and open replays never dilute expectancy', () => {
  const s = summariseReplay([
    R(REPLAY_OUTCOME.WIN, 2), R(REPLAY_OUTCOME.LOSS, -1),
    R(REPLAY_OUTCOME.NEVER_FILLED, null), R(REPLAY_OUTCOME.OPEN, null),
  ]);
  assert.equal(s.replayed, 4);
  assert.equal(s.settled, 2);
  assert.equal(s.neverFilled, 1);
  assert.equal(s.stillOpen, 1);
  assert.equal(s.expectancyR, 0.5, 'only the two settled replays count');
});

test('fill rate exposes adverse selection on pending orders', () => {
  // A strategy whose orders mostly never fill has no edge to measure, however good the filled
  // ones look — this is the 30%-fill limit-order result that was already rejected once.
  const s = summariseReplay([
    R(REPLAY_OUTCOME.WIN, 2),
    R(REPLAY_OUTCOME.NEVER_FILLED, null), R(REPLAY_OUTCOME.NEVER_FILLED, null),
    R(REPLAY_OUTCOME.NEVER_FILLED, null),
  ]);
  assert.equal(s.fillRate, 0.25);
  assert.equal(s.neverFilled, 3);
});

test('estimated money is netR at one constant risk and scales with it', () => {
  const rows = [R(REPLAY_OUTCOME.WIN, 2), R(REPLAY_OUTCOME.LOSS, -1)];
  assert.equal(summariseReplay(rows, { riskPerTrade: 80 }).estimatedProfit, 80);
  assert.equal(summariseReplay(rows, { riskPerTrade: 10 }).estimatedProfit, 10);
});

test('nothing settled means NaN expectancy, not a flattering zero', () => {
  const s = summariseReplay([R(REPLAY_OUTCOME.NEVER_FILLED, null)]);
  assert.ok(Number.isNaN(s.expectancyR));
  assert.equal(s.netR, 0);
  assert.equal(summariseReplay([]).replayed, 0);
});

test('a high win rate that still loses money is exposed by expectancy', () => {
  const rows = [...Array(9).fill(0).map(() => R(REPLAY_OUTCOME.WIN, 0.1)), R(REPLAY_OUTCOME.LOSS, -1)];
  const s = summariseReplay(rows);
  assert.equal(s.winRate, 0.9);
  assert.ok(s.expectancyR < 0, `expectancy ${s.expectancyR} must be negative`);
});
