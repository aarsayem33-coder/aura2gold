import test from 'node:test';
import assert from 'node:assert/strict';
import { timeframeSeconds, bucketPhase, bucketStart, formingBarFor, secsToNextBar } from './chartTime.js';

const HOUR = 3600;
const DAY = 86400;
const WEEK = 604800;
const utc = (iso) => Math.floor(Date.parse(iso) / 1000);

test('timeframeSeconds covers every timeframe the app offers', () => {
  assert.equal(timeframeSeconds('M1'), 60);
  assert.equal(timeframeSeconds('M5'), 300);
  assert.equal(timeframeSeconds('M15'), 900);
  assert.equal(timeframeSeconds('M30'), 1800);
  assert.equal(timeframeSeconds('H1'), HOUR);
  assert.equal(timeframeSeconds('H4'), 4 * HOUR);
  assert.equal(timeframeSeconds('D1'), DAY);
  assert.equal(timeframeSeconds('W1'), WEEK);
});

test('D and W honour their multiplier (it used to be ignored)', () => {
  assert.equal(timeframeSeconds('D3'), 3 * DAY, 'D3 previously returned 1 day');
  assert.equal(timeframeSeconds('W2'), 2 * WEEK, 'W2 previously returned 1 week');
});

test('unknown or variable-width timeframes disable bucketing rather than guessing', () => {
  for (const tf of ['MN1', 'MN', '', 'nonsense', 'H0', 'M0', null, undefined]) {
    assert.equal(timeframeSeconds(tf), 0, `${String(tf)} must not produce a bucket width`);
  }
});

// ── the actual bug: bar phase ──
test('a UTC-aligned feed measures phase 0 and behaves exactly as before', () => {
  const secs = ['2026-07-27T00:00:00Z', '2026-07-27T04:00:00Z', '2026-07-27T08:00:00Z'].map(utc);
  assert.equal(bucketPhase(secs, 4 * HOUR), 0);
  assert.equal(bucketStart(utc('2026-07-27T09:13:00Z'), 4 * HOUR, 0), utc('2026-07-27T08:00:00Z'));
});

test('a UTC+3 broker on H4 is bucketed on ITS boundaries, not UTC', () => {
  // Exness-style server: H4 bars open 01:00 / 05:00 / 09:00 UTC.
  const opens = ['2026-07-27T01:00:00Z', '2026-07-27T05:00:00Z', '2026-07-27T09:00:00Z', '2026-07-27T13:00:00Z'].map(utc);
  const phase = bucketPhase(opens, 4 * HOUR);
  assert.equal(phase, HOUR, 'phase should be +1h into the UTC 4-hour grid');
  // Every real bar must map to itself — the old code split these across two buckets.
  for (const o of opens) assert.equal(bucketStart(o, 4 * HOUR, phase), o);
  // A price 90 minutes into the 05:00 bar belongs to the 05:00 bar.
  assert.equal(bucketStart(utc('2026-07-27T06:30:00Z'), 4 * HOUR, phase), utc('2026-07-27T05:00:00Z'));
});

test('W1 buckets on the broker week, not the Thursday epoch week', () => {
  // Weekly bars opening Sunday 21:00 UTC.
  const opens = ['2026-07-05T21:00:00Z', '2026-07-12T21:00:00Z', '2026-07-19T21:00:00Z'].map(utc);
  const phase = bucketPhase(opens, WEEK);
  for (const o of opens) assert.equal(bucketStart(o, WEEK, phase), o, 'each weekly bar maps to itself');
  // Mid-week price stays inside its week.
  assert.equal(bucketStart(utc('2026-07-15T12:00:00Z'), WEEK, phase), utc('2026-07-12T21:00:00Z'));
  // The naive epoch bucketing lands on a Thursday — proving the old behaviour was wrong.
  const naive = Math.floor(opens[1] / WEEK) * WEEK;
  assert.notEqual(naive, opens[1]);
  assert.equal(new Date(naive * 1000).getUTCDay(), 4, 'epoch weeks start Thursday');
});

test('intra-bar snapshots cannot outvote the real bar phase', () => {
  const opens = ['2026-07-27T01:00:00Z', '2026-07-27T05:00:00Z', '2026-07-27T09:00:00Z'].map(utc);
  // Many scattered snapshots of the forming bar, each at a different offset.
  const noise = [];
  for (let i = 1; i <= 20; i++) noise.push(utc('2026-07-27T09:00:00Z') + i * 37);
  assert.equal(bucketPhase([...opens, ...noise], 4 * HOUR), HOUR);
});

test('bucketStart is stable for times before the phase offset', () => {
  const phase = HOUR;
  const t = utc('2026-07-27T00:30:00Z');            // earlier than the 01:00 boundary
  const start = bucketStart(t, 4 * HOUR, phase);
  assert.ok(start <= t, 'bucket must not start after the sample');
  assert.ok(t - start < 4 * HOUR, 'sample must fall inside its bucket');
  assert.equal(start, utc('2026-07-26T21:00:00Z'));
});

// ── forming bar ──
test('forming bar fills the current period at the last close', () => {
  const phase = 0;
  const lastClosed = { time: utc('2026-07-27T08:00:00Z'), close: 1.2345 };
  const now = Date.parse('2026-07-27T09:20:00Z');
  const bar = formingBarFor(lastClosed, HOUR, phase, now);
  assert.ok(bar);
  assert.equal(bar.time, utc('2026-07-27T09:00:00Z'));
  assert.deepEqual([bar.open, bar.high, bar.low, bar.close], [1.2345, 1.2345, 1.2345, 1.2345]);
  assert.equal(bar.volume, 0);
});

test('no forming bar when a real bar already covers the period', () => {
  const lastClosed = { time: utc('2026-07-27T09:00:00Z'), close: 1.5 };
  assert.equal(formingBarFor(lastClosed, HOUR, 0, Date.parse('2026-07-27T09:30:00Z')), null);
});

test('no forming bar across a weekend or feed outage', () => {
  // Friday close, checked on Sunday: the current period is many bars ahead.
  const lastClosed = { time: utc('2026-07-24T20:00:00Z'), close: 1.5 };
  const sunday = Date.parse('2026-07-26T12:00:00Z');
  assert.equal(formingBarFor(lastClosed, HOUR, 0, sunday), null,
    'must not invent a flat candle across a gap that never traded');
  // One period later is still fine.
  assert.ok(formingBarFor(lastClosed, HOUR, 0, Date.parse('2026-07-24T21:30:00Z')));
});

test('forming bar refuses garbage input instead of drawing a zero candle', () => {
  const t = utc('2026-07-27T08:00:00Z');
  const now = Date.parse('2026-07-27T09:20:00Z');
  assert.equal(formingBarFor(null, HOUR, 0, now), null);
  assert.equal(formingBarFor({ time: t, close: 0 }, HOUR, 0, now), null);
  assert.equal(formingBarFor({ time: t, close: -1 }, HOUR, 0, now), null);
  assert.equal(formingBarFor({ time: t, close: NaN }, HOUR, 0, now), null);
  assert.equal(formingBarFor({ time: t, close: 1.5 }, 0, 0, now), null, 'unknown timeframe');
});

// ── countdown ──
test('countdown lands on the broker boundary, not the UTC one', () => {
  const phase = HOUR;                                  // UTC+3 style H4 grid
  const now = Date.parse('2026-07-27T06:30:00Z');      // inside the 05:00 bar
  // 05:00 + 4h = 09:00, so 2h30m remain.
  assert.equal(secsToNextBar(4 * HOUR, phase, now), 2.5 * HOUR);
});

test('countdown is always within (0, tfSec]', () => {
  for (const tf of ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1']) {
    const tfSec = timeframeSeconds(tf);
    for (const phase of [0, 60, HOUR, 3 * HOUR]) {
      for (const t of ['2026-07-27T00:00:00Z', '2026-07-27T06:30:11Z', '2026-07-29T23:59:59Z']) {
        const s = secsToNextBar(tfSec, phase % tfSec, Date.parse(t));
        assert.ok(s > 0 && s <= tfSec, `${tf} phase ${phase} at ${t} gave ${s}`);
      }
    }
  }
});

test('countdown returns null for an unknown timeframe', () => {
  assert.equal(secsToNextBar(0, 0, Date.now()), null);
});
