import assert from 'node:assert/strict';
import test from 'node:test';
import { formingBarFor, isLiveBar, bucketStart, LIVE_BAR_MAX_AGE_MS } from './chartTime.js';

const TF = 300;                                   // M5
const NOW = Date.UTC(2026, 7, 5, 14, 22, 30);     // mid-period
const open = bucketStart(Math.floor(NOW / 1000), TF, 0);
const closed = { time: open - TF, close: 4200 };
const live = (o = {}) => ({
  time: open, open: 4200, high: 4210, low: 4195, close: 4205, volume: 120,
  receivedAt: new Date(NOW - 500).toISOString(), ...o,
});

// ── the real forming bar wins ────────────────────────────────────────────────

test('a fresh forming bar is drawn with its REAL OHLC', () => {
  // This is the whole point: the feed streams true intrabar movement every second, and the
  // chart used to throw it away in favour of a flat placeholder.
  const b = formingBarFor(closed, TF, 0, NOW, live());
  assert.equal(b.live, true);
  assert.equal(b.open, 4200);
  assert.equal(b.high, 4210);
  assert.equal(b.low, 4195);
  assert.equal(b.close, 4205);
  assert.equal(b.volume, 120);
  assert.notEqual(b.high, b.low, 'a real bar has range — the placeholder never did');
});

test('the bar sits in the CURRENT period, not the feed timestamp', () => {
  assert.equal(formingBarFor(closed, TF, 0, NOW, live()).time, open);
});

// ── staleness ────────────────────────────────────────────────────────────────

test('a stale forming bar falls back to the inert placeholder', () => {
  // Beyond the tolerance the price on screen is old enough that animating it would claim
  // something the feed cannot support.
  const old = live({ receivedAt: new Date(NOW - 10000).toISOString() });
  const b = formingBarFor(closed, TF, 0, NOW, old);
  assert.equal(b.stale, true);
  assert.equal(b.live, undefined);
  assert.equal(b.open, b.close, 'flat — no invented movement');
  assert.equal(b.high, b.low);
});

test('freshness is judged on ARRIVAL, not the bar timestamp', () => {
  // A forming bar keeps the period's opening time for the whole period, so its own timestamp
  // says nothing about whether the feed is alive.
  assert.equal(isLiveBar(live({ receivedAt: null }), TF, 0, NOW), false);
  assert.equal(isLiveBar(live({ receivedAt: 'nonsense' }), TF, 0, NOW), false);
  assert.equal(isLiveBar(live(), TF, 0, NOW), true);
});

test('the tolerance boundary is respected', () => {
  const at = (ageMs) => isLiveBar(live({ receivedAt: new Date(NOW - ageMs).toISOString() }), TF, 0, NOW);
  assert.equal(at(LIVE_BAR_MAX_AGE_MS - 1), true);
  assert.equal(at(LIVE_BAR_MAX_AGE_MS + 1), false);
});

test('a forming bar for the WRONG period is not live', () => {
  assert.equal(isLiveBar(live({ time: open - TF }), TF, 0, NOW), false);
});

// ── the invariant guard ──────────────────────────────────────────────────────

test('a broken high/low is corrected rather than mis-drawn', () => {
  // A bar whose high sits below its close would render wrong and every indicator computed from
  // it would inherit the error.
  const b = formingBarFor(closed, TF, 0, NOW, live({ high: 4190, low: 4220, close: 4205, open: 4200 }));
  assert.ok(b.high >= b.close && b.high >= b.open);
  assert.ok(b.low <= b.close && b.low <= b.open);
});

test('nonsense prices fall back rather than drawing zero', () => {
  for (const bad of [{ close: 0 }, { open: NaN }, { low: null }]) {
    const b = formingBarFor(closed, TF, 0, NOW, live(bad));
    assert.equal(b.stale, true, `${JSON.stringify(bad)} must not draw as live`);
  }
});

// ── the fallback's own guards, unchanged ─────────────────────────────────────

test('no placeholder is drawn across a gap of more than one period', () => {
  // A weekend or outage puts the current period many bars ahead; a flat bar there invents a
  // candle across time that never traded.
  const ancient = { time: open - TF * 40, close: 4200 };
  assert.equal(formingBarFor(ancient, TF, 0, NOW, null), null);
});

test('no bar at all when a real closed bar already covers the period', () => {
  assert.equal(formingBarFor({ time: open, close: 4200 }, TF, 0, NOW, null), null);
});

test('missing inputs return null rather than throwing', () => {
  assert.equal(formingBarFor(null, TF, 0, NOW, null), null);
  assert.equal(formingBarFor(closed, 0, 0, NOW, null), null);
});

// ── the duplicate-timestamp trap ─────────────────────────────────────────────

test('the live bar sits at EXACTLY the period open, so callers can dedupe on time', () => {
  // The chart appends this to the closed series. Now that the feed streams the real forming
  // bar, that series usually already ends with it — and appending a second bar at the same
  // timestamp makes lightweight-charts reject the whole series:
  //   "data must be asc ordered by time, index=252, time=1785940200, prev time=1785940200"
  // Callers compare forming.time against the last bar's time, which only works if this is
  // exactly the bucket start rather than the arrival moment.
  const b = formingBarFor(closed, TF, 0, NOW, live());
  assert.equal(b.time, open);
  assert.equal(b.time % TF, 0, 'aligned to the period grid');
});

test('the placeholder also lands exactly on the period open', () => {
  const b = formingBarFor(closed, TF, 0, NOW, null);
  assert.equal(b.time, open);
});
