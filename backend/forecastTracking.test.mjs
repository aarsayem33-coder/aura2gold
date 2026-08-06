import assert from 'node:assert/strict';
import test from 'node:test';
import { assessTracked, shouldAlert, TRACK_VERDICT } from './forecastTracking.js';

const NOW = Date.parse('2026-07-31T12:00:00.000Z');
// A gold BUY forecast at a level below price: sweep the low, reject, go up.
const base = (over = {}) => ({
  id: 'XAUUSD|M15|4000|SWEEP_REJECT|1',
  symbol: 'XAUUSD', timeframe: 'M15', status: 'WAITING',
  level: 4000, atr: 10, side: 'below', expectedDirection: 'BUY', scenario: 'SWEEP_REJECT',
  createdAt: '2026-07-31T11:00:00.000Z',       // an hour ago
  eta: { minMinutes: 30, maxMinutes: 180 },
  plan: { entry: 4002, stopLoss: 3994, takeProfit: 4010 },
  drift: [
    { ts: '2026-07-31T11:00:00.000Z', bestScore: 80, rankScore: 50, agree: 3 },
    { ts: '2026-07-31T12:00:00.000Z', bestScore: 80, rankScore: 50, agree: 3 },
  ],
  ...over,
});
const at = (price, over = {}) => assessTracked({ forecast: base(over), price, now: NOW });

// ── the negative verdicts, which are the point ──────────────────────────────

test('price through the level the wrong way is REVERSED, not "still valid"', () => {
  // 4000 level, price 4 ATR below it: the support that justified the BUY is gone.
  const a = at(3993);
  assert.equal(a.verdict, TRACK_VERDICT.REVERSED);
  assert.match(a.reasons[0], /through the level on the wrong side/);
  assert.match(a.suggestion, /Do not take this/);
  assert.equal(a.alertWorthy, true);
});

test('a broken premise beats a rising score', () => {
  // Order matters: a forecast whose level has been blown through is dead however good the
  // strategies looked ten minutes ago.
  const a = at(3993, { drift: [
    { bestScore: 70, rankScore: 40, agree: 2 },
    { bestScore: 95, rankScore: 70, agree: 5 },
  ] });
  assert.equal(a.verdict, TRACK_VERDICT.REVERSED, 'must not report STRENGTHENING on a dead setup');
});

test('a move that already happened is DONT_CHASE', () => {
  // Planned entry 4002; price is now 4013 — 1.1 ATR past it.
  const a = at(4013);
  assert.equal(a.verdict, TRACK_VERDICT.DONT_CHASE);
  assert.match(a.reasons[0], /already run/);
  assert.match(a.suggestion, /wait for a pullback or skip/);
  assert.equal(a.alertWorthy, true);
});

test('a mild run past entry is not yet chasing', () => {
  const a = at(4006);   // 0.4 ATR past entry
  assert.notEqual(a.verdict, TRACK_VERDICT.DONT_CHASE);
});

test('falling conviction is WEAKENING and worth an alert', () => {
  const a = at(4001, { drift: [
    { bestScore: 88, rankScore: 60, agree: 3 },
    { bestScore: 74, rankScore: 45, agree: 3 },
  ] });
  assert.equal(a.verdict, TRACK_VERDICT.WEAKENING);
  assert.equal(a.scoreChange, -14);
  assert.match(a.reasons[0], /fallen 14 points/);
  assert.equal(a.alertWorthy, true);
});

test('a strategy dropping out is weakening even when the score holds', () => {
  const a = at(4001, { drift: [
    { bestScore: 80, rankScore: 50, agree: 4 },
    { bestScore: 80, rankScore: 50, agree: 2 },
  ] });
  assert.equal(a.verdict, TRACK_VERDICT.WEAKENING);
  assert.equal(a.agreeChange, -2);
  assert.match(a.reasons.join(' '), /2 strategies have stopped backing/);
});

test('the window elapsing without arrival is STALE, and does NOT alert', () => {
  // Expiring quietly is not an emergency; it does not deserve the single alert.
  const a = assessTracked({
    forecast: base({ createdAt: '2026-07-31T08:00:00.000Z' }),   // 4h ago, eta max 180m
    price: 4001, now: NOW,
  });
  assert.equal(a.verdict, TRACK_VERDICT.STALE);
  assert.ok(a.timeLeftMinutes < 0);
  assert.equal(a.alertWorthy, false);
});

// ── the positive verdicts ───────────────────────────────────────────────────

test('rising conviction is STRENGTHENING and stays quiet', () => {
  const a = at(4001, { drift: [
    { bestScore: 74, rankScore: 45, agree: 2 },
    { bestScore: 88, rankScore: 62, agree: 4 },
  ] });
  assert.equal(a.verdict, TRACK_VERDICT.STRENGTHENING);
  assert.equal(a.scoreChange, 14);
  assert.equal(a.agreeChange, 2);
  assert.equal(a.alertWorthy, false, 'good news must never spend the single alert');
});

test('proximity sharpens the suggestion', () => {
  const near = at(4002, { drift: [
    { bestScore: 74, rankScore: 45, agree: 2 }, { bestScore: 88, rankScore: 62, agree: 3 },
  ] });
  assert.match(near.suggestion, /order ready/);
  const far = at(4040, { level: 4000, plan: { entry: 4002 }, drift: [
    { bestScore: 74, rankScore: 45, agree: 2 }, { bestScore: 88, rankScore: 62, agree: 3 },
  ] });
  assert.ok(!/order ready/.test(far.suggestion));
});

test('no material change is HOLDING', () => {
  const a = at(4001);
  assert.equal(a.verdict, TRACK_VERDICT.HOLDING);
  assert.equal(a.scoreChange, 0);
  assert.equal(a.alertWorthy, false);
});

test('a finished forecast is CLOSED and judged no further', () => {
  for (const status of ['RESOLVED', 'EXPIRED', 'SUPERSEDED']) {
    const a = assessTracked({ forecast: base({ status }), price: 3990, now: NOW });
    assert.equal(a.verdict, TRACK_VERDICT.CLOSED, status);
    assert.equal(a.alertWorthy, false);
  }
});

// ── mirrored side ───────────────────────────────────────────────────────────

test('a SELL forecast at a level above price mirrors correctly', () => {
  const sell = {
    ...base(), level: 4100, side: 'above', expectedDirection: 'SELL',
    plan: { entry: 4098, stopLoss: 4106, takeProfit: 4090 },
  };
  // Price above the level = the resistance broke = reversed.
  assert.equal(assessTracked({ forecast: sell, price: 4107, now: NOW }).verdict, TRACK_VERDICT.REVERSED);
  // Price well below the entry = the sell already ran without us.
  assert.equal(assessTracked({ forecast: sell, price: 4087, now: NOW }).verdict, TRACK_VERDICT.DONT_CHASE);
  // Just above the level, quiet = holding.
  assert.equal(assessTracked({ forecast: sell, price: 4099, now: NOW }).verdict, TRACK_VERDICT.HOLDING);
});

// ── numbers the page shows ──────────────────────────────────────────────────

test('distance, time left and score change are reported for display', () => {
  const a = at(4004);
  assert.equal(a.distanceNow, 4);
  assert.equal(a.distanceAtr, 0.4);
  assert.equal(a.timeLeftMinutes, 120, 'eta max 180 minus 60 elapsed');
  assert.equal(a.scoreChange, 0);
});

test('missing price or drift degrades without throwing', () => {
  const a = assessTracked({ forecast: base({ drift: [] }), price: null, now: NOW });
  assert.ok(a.verdict);
  assert.equal(a.scoreChange, 0);
  assert.equal(a.distanceNow, null);
  assert.ok(assessTracked({ forecast: {}, price: 100, now: NOW }).verdict);
});

// ── the single alert ────────────────────────────────────────────────────────

test('exactly one alert ever fires per tracked forecast', () => {
  const bad = at(3993);
  assert.equal(shouldAlert(bad, { alertedAt: null }), true, 'first adverse verdict alerts');
  assert.equal(shouldAlert(bad, { alertedAt: '2026-07-31T11:30:00.000Z' }), false,
    'a tracked setup that wobbles must not send a dozen mails');
});

test('good news never consumes the alert', () => {
  const good = at(4001, { drift: [
    { bestScore: 70, rankScore: 40, agree: 2 }, { bestScore: 90, rankScore: 65, agree: 4 },
  ] });
  assert.equal(shouldAlert(good, {}), false);
  assert.equal(shouldAlert(at(4001), {}), false, 'HOLDING is not alert-worthy');
});
