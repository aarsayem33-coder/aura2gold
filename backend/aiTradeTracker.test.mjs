import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateTrack, scoreCalibration, summariseTracks, isTradeable, directionOf,
  TRACK_STATUS, SETTLED,
} from './aiTradeTracker.js';

const bar = (h, l, c) => ({ high: h, low: l, close: c });
/** BUY 100, stop 99 (1.00 of risk), targets 101 / 102 / 103. */
const buy = (o = {}) => ({
  decision: 'BUY', entry: 100, stopLoss: 99,
  takeProfit1: 101, takeProfit2: 102, takeProfit3: 103,
  lots: 0.1, pipSize: 0.1, pipValuePerLot: 1, ...o,
});

// ── what counts as a call ────────────────────────────────────────────────────

test('only BUY and SELL are tradeable — HOLD is an answer, not a trade', () => {
  for (const d of ['BUY', 'STRONG_BUY', 'sell', 'STRONG_SELL']) assert.equal(isTradeable(d), true, d);
  for (const d of ['HOLD', '', null, 'WAIT']) assert.equal(isTradeable(d), false, String(d));
});

test('STRONG_BUY normalises to BUY rather than falling through to SELL', () => {
  // An === check on 'BUY' silently treated STRONG_BUY as the opposite call in the UI once.
  assert.equal(directionOf('STRONG_BUY'), 'BUY');
  assert.equal(directionOf('STRONG_SELL'), 'SELL');
  assert.equal(directionOf('HOLD'), null);
});

test('an analysis with no direction is NO_TRADE, not a zero-R loss', () => {
  const r = evaluateTrack(buy({ decision: 'HOLD' }), [bar(101, 99, 100)]);
  assert.equal(r.status, TRACK_STATUS.NO_TRADE);
  assert.equal(r.r, null, 'null, never 0 — a non-trade must not dilute expectancy');
});

test('a ticket with no risk cannot be measured', () => {
  assert.equal(evaluateTrack(buy({ stopLoss: 100 }), [bar(101, 99, 100)]).status, TRACK_STATUS.NO_TRADE);
  assert.equal(evaluateTrack(buy({ entry: null }), [bar(101, 99, 100)]).status, TRACK_STATUS.NO_TRADE);
});

// ── entry ────────────────────────────────────────────────────────────────────

test('a trade that never reaches its entry stays WAITING with no result', () => {
  const r = evaluateTrack(buy(), [bar(105, 101, 103), bar(106, 102, 104)]);
  assert.equal(r.status, TRACK_STATUS.WAITING);
  assert.equal(r.entered, false);
  assert.equal(r.r, null);
  assert.equal(r.mfeR, null, 'excursions are meaningless before entry');
});

test('the bar index of entry is recorded', () => {
  const r = evaluateTrack(buy(), [bar(105, 101, 103), bar(103, 99.5, 100.2)]);
  assert.equal(r.entered, true);
  assert.equal(r.barsToEntry, 1);
});

// ── outcomes, and the order rule ─────────────────────────────────────────────

test('reaching the final target closes at TP3', () => {
  const r = evaluateTrack(buy(), [bar(100.5, 99.8, 100.2), bar(103.5, 100.1, 103.2)]);
  assert.equal(r.status, TRACK_STATUS.TP3);
  assert.equal(r.r, 3, 'reward 3.00 over risk 1.00');
  assert.equal(r.settled, true);
});

test('a bar touching BOTH stop and target is a LOSS, never a win', () => {
  // Which came first inside one bar is unknowable, and assuming the target is how a losing
  // system produces a winning record.
  const r = evaluateTrack(buy(), [bar(103.5, 98.5, 101)]);
  assert.equal(r.status, TRACK_STATUS.STOPPED);
  assert.equal(r.r, -1);
});

test('a stop is exactly -1R', () => {
  const r = evaluateTrack(buy(), [bar(100.2, 98.5, 98.8)]);
  assert.equal(r.status, TRACK_STATUS.STOPPED);
  assert.equal(r.r, -1);
});

test('an intermediate target is reported while the trade is still open', () => {
  const r = evaluateTrack(buy(), [bar(101.5, 99.9, 101.2)]);
  assert.equal(r.status, TRACK_STATUS.TP1);
  assert.equal(r.hitLevel, 1);
});

test('an open trade is marked to the last close, not to a target', () => {
  const r = evaluateTrack(buy(), [bar(100.6, 99.9, 100.4)]);
  assert.equal(r.status, TRACK_STATUS.RUNNING);
  assert.equal(r.r, 0.4, 'marked at 100.4 against 1.00 of risk');
  assert.equal(r.settled, false);
});

test('SELL mirrors BUY exactly', () => {
  const sell = { decision: 'SELL', entry: 100, stopLoss: 101, takeProfit1: 99, takeProfit2: 98, takeProfit3: 97, lots: 0.1, pipSize: 0.1, pipValuePerLot: 1 };
  const r = evaluateTrack(sell, [bar(100.2, 99.9, 100), bar(100.1, 96.5, 96.8)]);
  assert.equal(r.status, TRACK_STATUS.TP3);
  assert.equal(r.r, 3);
});

// ── excursions ───────────────────────────────────────────────────────────────

test('favourable and adverse excursion are BOTH tracked', () => {
  // A trade that ran 30 pips your way then stopped is a different failure from one that went
  // straight to the stop, and only the adverse side distinguishes them.
  const r = evaluateTrack(buy(), [bar(100.8, 99.7, 100.5), bar(100.6, 98.9, 99)]);
  assert.equal(r.status, TRACK_STATUS.STOPPED);
  assert.equal(r.mfeR, 0.8, 'ran 0.80 in favour before failing');
  assert.equal(r.maeR, 1.1, 'and 1.10 against — the bar wicked through the stop at 99 to 98.9');
  assert.ok(r.mfeR < r.maeR, 'the loss is visible in the excursions, not just the result');
});

test('SELL excursions swap sides correctly', () => {
  const sell = { decision: 'SELL', entry: 100, stopLoss: 101, takeProfit1: 99, lots: 0.1, pipSize: 0.1, pipValuePerLot: 1 };
  const r = evaluateTrack(sell, [bar(100.3, 99.4, 99.6)]);
  assert.equal(r.mfeR, 0.6, 'price fell 0.60 — favourable for a short');
  assert.equal(r.maeR, 0.3);
});

// ── money ────────────────────────────────────────────────────────────────────

test('money is derived from the move, lot size and pip value', () => {
  // 3.00 of price at 0.1 pip size = 30 pips, x $1/pip/lot x 0.1 lots = $3.
  const r = evaluateTrack(buy(), [bar(103.5, 99.9, 103.2)]);
  assert.equal(r.profitUsd, 3);
});

test('money is null when the sizing is unknown, never a guessed zero', () => {
  const r = evaluateTrack(buy({ lots: null }), [bar(103.5, 99.9, 103.2)]);
  assert.equal(r.r, 3, 'R still works — it needs no sizing');
  assert.equal(r.profitUsd, null);
});

// ── expiry ───────────────────────────────────────────────────────────────────

test('an unresolved trade past its window expires', () => {
  const t = buy({ expiresAt: new Date(1000).toISOString() });
  const r = evaluateTrack(t, [bar(100.6, 99.9, 100.4)], { nowMs: 999999 });
  assert.equal(r.status, TRACK_STATUS.EXPIRED);
});

test('a SETTLED trade is never overwritten by expiry', () => {
  // The result already happened; the clock cannot undo it.
  const t = buy({ expiresAt: new Date(1000).toISOString() });
  const r = evaluateTrack(t, [bar(100.5, 99.8, 100.2), bar(103.5, 100.1, 103.2)], { nowMs: 999999 });
  assert.equal(r.status, TRACK_STATUS.TP3);
});

// ── does the score predict anything? ─────────────────────────────────────────

test('calibration groups outcomes by score band', () => {
  // The question tracking exists to answer. Banded rather than fitted — a curve over a few
  // dozen analyses would describe noise.
  const rows = scoreCalibration([
    { score: 90, r: 2 }, { score: 88, r: 3 },
    { score: 78, r: -1 }, { score: 76, r: 1 },
    { score: 50, r: -1 },
  ]);
  const top = rows.find((x) => x.band === '85+');
  assert.equal(top.n, 2);
  assert.equal(top.winRate, 1);
  assert.equal(top.expectancyR, 2.5);
  const low = rows.find((x) => x.band === '0-64');
  assert.equal(low.expectancyR, -1);
});

test('unscored or unresolved analyses are excluded from calibration', () => {
  const rows = scoreCalibration([{ score: null, r: 2 }, { score: 90, r: null }]);
  assert.equal(rows.reduce((a, x) => a + x.n, 0), 0);
});

// ── summary ──────────────────────────────────────────────────────────────────

test('expectancy exposes a high win rate that loses money', () => {
  const s = summariseTracks([
    ...Array(9).fill(0).map(() => ({ status: 'TP1', r: 0.1, profitUsd: 1 })),
    { status: 'STOPPED', r: -1, profitUsd: -10 },
  ]);
  assert.equal(s.winRate, 0.9);
  assert.ok(s.expectancyR < 0, `expectancy ${s.expectancyR} must be negative`);
});

test('open and closed money are reported separately', () => {
  // Blending an unrealised mark into a realised total produces a number describing neither.
  const s = summariseTracks([
    { status: 'RUNNING', r: 0.5, profitUsd: 5 },
    { status: 'TP3', r: 3, profitUsd: 30 },
  ]);
  assert.equal(s.openProfitUsd, 5);
  assert.equal(s.closedProfitUsd, 30);
  assert.equal(s.open, 1);
  assert.equal(s.settled, 1);
});

test('nothing settled means NaN expectancy, not a flattering zero', () => {
  const s = summariseTracks([{ status: 'WAITING', r: null }]);
  assert.ok(Number.isNaN(s.expectancyR));
  assert.equal(s.waiting, 1);
});

test('the settled set is exactly the closed outcomes', () => {
  assert.deepEqual([...SETTLED].sort(), ['STOPPED', 'TP1', 'TP2', 'TP3']);
});

// ── every return path must be bind-safe ──────────────────────────────────────
// The resolver binds these fields straight into an UPDATE, and mysql2 rejects `undefined`
// outright ("Bind parameters must not contain undefined"). The early NO_TRADE returns used to
// omit exitPrice/barsHeld/settled, so every HOLD analysis — which this system tracks on purpose
// for honest calibration — threw on resolve and retried forever.

const BOUND_FIELDS = ['status', 'entered', 'r', 'profitUsd', 'mfeR', 'maeR',
  'currentPrice', 'exitPrice', 'barsHeld', 'note', 'settled'];

const bars = [
  { time: '2026-01-01T00:00:00.000Z', open: 100, high: 101, low: 99, close: 100.5 },
  { time: '2026-01-01T00:15:00.000Z', open: 100.5, high: 102, low: 100, close: 101.5 },
];

test('no return path leaves a bound field undefined', () => {
  const cases = [
    ['HOLD with no ticket', { decision: 'HOLD' }],
    ['direction but no entry', { decision: 'BUY', stopLoss: 99 }],
    ['direction but no stop', { decision: 'BUY', entry: 100 }],
    ['entry equals stop', { decision: 'BUY', entry: 100, stopLoss: 100 }],
    ['unreadable decision', { decision: 'MAYBE?', entry: 100, stopLoss: 99 }],
    ['normal open trade', { decision: 'BUY', entry: 100, stopLoss: 99, takeProfit1: 105 }],
    ['no candles at all', { decision: 'BUY', entry: 100, stopLoss: 99 }, []],
  ];
  for (const [label, track, candles = bars] of cases) {
    const ev = evaluateTrack(track, candles);
    for (const f of BOUND_FIELDS) {
      assert.notEqual(ev[f], undefined, `${label}: "${f}" is undefined — mysql2 would reject the UPDATE`);
    }
  }
});

test('a HOLD resolves to NO_TRADE with nulls, not undefined', () => {
  const ev = evaluateTrack({ decision: 'HOLD' }, bars);
  assert.equal(ev.status, 'NO_TRADE');
  assert.equal(ev.entered, false);
  assert.equal(ev.settled, false);
  assert.equal(ev.exitPrice, null);
  assert.equal(ev.barsHeld, 0);
  assert.equal(ev.r, null);
  assert.match(ev.note, /did not call a direction/);
});

test('the NO_TRADE shape carries every key the normal return does', () => {
  // Guards the real failure mode: a field added to the main return but forgotten in noTrade()
  // would be undefined again, and only in production on HOLD rows.
  const normal = evaluateTrack({ decision: 'BUY', entry: 100, stopLoss: 99, takeProfit1: 105 }, bars);
  const held = evaluateTrack({ decision: 'HOLD' }, bars);
  for (const k of Object.keys(normal)) {
    assert.ok(k in held, `NO_TRADE is missing "${k}" that the normal return provides`);
  }
});
