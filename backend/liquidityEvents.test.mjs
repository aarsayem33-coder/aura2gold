import assert from 'node:assert/strict';
import test from 'node:test';
import {
  directionFor, statusFromClassification, sweepIndex, followThroughPips,
  resolveEvent, summariseEvents, excursionPips, EVENT_STATUS,
} from './liquidityEvents.js';

const bar = (o, h, l, c) => ({ open: o, high: h, low: l, close: c });
/** A level at 100 with buy-side liquidity resting above it. */
const above = { level_price: 100, side: 'above' };
const below = { level_price: 100, side: 'below' };

// ── the direction mapping, which is the whole actionable output ───────────────

test('buy-side liquidity reclaimed points SELL, broken-and-held points BUY', () => {
  assert.equal(directionFor('above', EVENT_STATUS.RECLAIMED), 'SELL');
  assert.equal(directionFor('above', EVENT_STATUS.BROKE_AND_HELD), 'BUY');
});

test('sell-side liquidity mirrors it exactly', () => {
  assert.equal(directionFor('below', EVENT_STATUS.RECLAIMED), 'BUY');
  assert.equal(directionFor('below', EVENT_STATUS.BROKE_AND_HELD), 'SELL');
});

test('an unresolved event has no direction, never a default', () => {
  // A default here would put a tradeable arrow next to a level that did nothing.
  for (const s of [EVENT_STATUS.WAITING, EVENT_STATUS.NO_FOLLOW_THROUGH, EVENT_STATUS.DEAD]) {
    assert.equal(directionFor('above', s), null);
    assert.equal(directionFor('below', s), null);
  }
});

// ── vocabulary shared with the chart ─────────────────────────────────────────

test('the chart classifier vocabulary maps in exactly one place', () => {
  // A second classifier would give the table and the chart different answers about the same
  // level with no way to tell which was right.
  assert.equal(statusFromClassification('SWEPT'), EVENT_STATUS.RECLAIMED);
  assert.equal(statusFromClassification('BROKEN_ACCEPTED'), EVENT_STATUS.BROKE_AND_HELD);
  assert.equal(statusFromClassification('INVALIDATED'), EVENT_STATUS.DEAD);
  assert.equal(statusFromClassification('FRESH'), EVENT_STATUS.WAITING);
  assert.equal(statusFromClassification('TESTED'), EVENT_STATUS.NO_FOLLOW_THROUGH);
  assert.equal(statusFromClassification('REJECTED'), EVENT_STATUS.NO_FOLLOW_THROUGH);
  assert.equal(statusFromClassification('nonsense'), EVENT_STATUS.WAITING);
});

// ── when liquidity was actually taken ────────────────────────────────────────

test('the sweep bar is the first trade BEYOND the level, not the alert bar', () => {
  // The alert fires on approach; the sweep can be several bars later. Measuring from the alert
  // would credit moves that happened before the level was ever touched.
  const bars = [bar(98, 99.5, 97, 99), bar(99, 99.9, 98.5, 99.8), bar(99.8, 100.6, 99.5, 100.2)];
  assert.equal(sweepIndex(bars, { price: 100, side: 'above' }), 2);
});

test('a level never traded through has no sweep bar', () => {
  const bars = [bar(98, 99.5, 97, 99), bar(99, 99.9, 98.5, 99.8)];
  assert.equal(sweepIndex(bars, { price: 100, side: 'above' }), null);
});

test('sell-side liquidity is swept by trading BELOW', () => {
  const bars = [bar(102, 103, 101, 102), bar(102, 102.5, 99.4, 100.5)];
  assert.equal(sweepIndex(bars, { price: 100, side: 'below' }), 1);
});

// ── follow-through is signed by the implied direction ────────────────────────

test('follow-through is positive when the implied direction worked', () => {
  // A reclaim above points SELL, so falling counts as success — an unsigned distance could not
  // be compared across the two plans.
  const bars = [bar(100, 100.5, 99, 99.5), bar(99.5, 99.6, 98, 98.2)];
  const pips = followThroughPips(bars, above, EVENT_STATUS.RECLAIMED, 0, 0.01);
  assert.equal(pips, 200, 'fell 2.00 from the level at 0.01 per pip');
});

test('a reclaim that never traded back below reports zero favourable, not a fake win', () => {
  const bars = [bar(100.1, 101.5, 100.05, 101)];
  const pips = followThroughPips(bars, above, EVENT_STATUS.RECLAIMED, 0, 0.01);
  assert.ok(pips <= 0, `price never fell below the level, got ${pips}`);
});

test('favourable and adverse excursion are BOTH reported', () => {
  // Reporting only the favourable side flatters every event: a reclaim that ran 10 pips your way
  // and 100 against would read "+10" and look like it worked.
  const bars = [bar(100, 101.5, 99.9, 101)];
  const ex = excursionPips(bars, above, EVENT_STATUS.RECLAIMED, 0, 0.01);
  assert.equal(ex.favourable, 10, 'dipped 0.10 below the level');
  assert.equal(ex.adverse, 150, 'but ran 1.50 above it');
  assert.ok(ex.adverse > ex.favourable, 'this event did NOT work, and the numbers say so');
});

test('a break-and-hold above is measured upward', () => {
  const bars = [bar(100, 100.5, 99.9, 100.4), bar(100.4, 102, 100.3, 101.8)];
  assert.equal(followThroughPips(bars, above, EVENT_STATUS.BROKE_AND_HELD, 0, 0.01), 200);
});

test('an unresolved status has no follow-through figure', () => {
  const bars = [bar(100, 100.5, 99, 99.5)];
  assert.equal(followThroughPips(bars, above, EVENT_STATUS.WAITING, 0, 0.01), null);
  assert.equal(followThroughPips(bars, above, EVENT_STATUS.RECLAIMED, 0, null), null);
});

// ── provisional versus confirmed ─────────────────────────────────────────────

/** Swept above 100 then sold off hard — a textbook confirmed rejection. */
const reclaimedHard = [
  bar(98, 99, 97.5, 98.8), bar(98.8, 99.6, 98.5, 99.4),
  bar(99.4, 101.0, 99.2, 99.1),          // wick beyond 100, closed back inside
  bar(99.1, 99.2, 96.0, 96.3),           // displacement away
  bar(96.3, 96.5, 95.0, 95.2),
];

test('a reclaim with displacement is CONFIRMED and points the right way', () => {
  const r = resolveEvent(above, reclaimedHard, { atr: 1.2, pipSize: 0.01 });
  assert.equal(r.status, EVENT_STATUS.RECLAIMED);
  assert.equal(r.confirmed, true);
  assert.equal(r.direction, 'SELL');
  assert.match(r.evidence, /displacement/);
  assert.ok(r.followThroughPips > 0);
});

test('a reclaim with no displacement is provisional, NOT confirmed', () => {
  // A limp wick that drifts back is the setup that loses; calling it confirmed would dress up a
  // coin flip as a result.
  const limp = [
    bar(98, 99, 97.5, 98.8), bar(98.8, 99.6, 98.5, 99.4),
    bar(99.4, 100.3, 99.2, 99.6),        // barely beyond, closed back
    bar(99.6, 99.8, 99.4, 99.7),         // nothing happens
    bar(99.7, 99.9, 99.5, 99.6),
  ];
  const r = resolveEvent(above, limp, { atr: 1.2, pipSize: 0.01 });
  assert.equal(r.status, EVENT_STATUS.RECLAIMED);
  assert.equal(r.confirmed, false);
  assert.match(r.evidence, /no displacement yet/);
  assert.equal(r.direction, 'SELL', 'a provisional event still reports its direction');
});

test('a break with a held retest is CONFIRMED', () => {
  const held = [
    bar(98, 99, 97.5, 98.8),
    bar(98.8, 101, 98.6, 100.8),         // body closed beyond
    bar(100.8, 101.5, 100.5, 101.2),     // second close beyond
    bar(101.2, 101.4, 99.9, 100.6),      // retest down to the level
    bar(100.6, 101.2, 100.4, 101.0),     // held above
    bar(101.0, 101.8, 100.8, 101.6),     // still above
  ];
  const r = resolveEvent(above, held, { atr: 1.0, pipSize: 0.01, minHoldBars: 2 });
  assert.equal(r.status, EVENT_STATUS.BROKE_AND_HELD);
  assert.equal(r.confirmed, true);
  assert.equal(r.direction, 'BUY');
  assert.match(r.evidence, /retest held/);
});

test('a break with no retest is provisional — untested is not proven', () => {
  const noRetest = [
    bar(98, 99, 97.5, 98.8),
    bar(98.8, 101, 98.6, 100.8),
    bar(100.8, 102.5, 100.7, 102.2),
    bar(102.2, 103, 102.0, 102.8),
  ];
  const r = resolveEvent(above, noRetest, { atr: 1.0, pipSize: 0.01 });
  assert.equal(r.status, EVENT_STATUS.BROKE_AND_HELD);
  assert.equal(r.confirmed, false);
  assert.match(r.evidence, /no retest yet/);
});

test('a level never revisited stays WAITING with no direction', () => {
  const quiet = [bar(97, 97.5, 96.5, 97), bar(97, 97.4, 96.6, 97.1), bar(97.1, 97.3, 96.8, 97)];
  const r = resolveEvent(above, quiet, { atr: 1, pipSize: 0.01 });
  assert.equal(r.status, EVENT_STATUS.WAITING);
  assert.equal(r.direction, null);
  assert.equal(r.confirmed, false);
});

test('too few candles resolves to WAITING rather than guessing', () => {
  assert.equal(resolveEvent(above, [], { atr: 1 }).status, EVENT_STATUS.WAITING);
  assert.equal(resolveEvent(above, null, { atr: 1 }).status, EVENT_STATUS.WAITING);
  assert.equal(resolveEvent({ level_price: null, side: 'above' }, reclaimedHard, { atr: 1 }).status, EVENT_STATUS.WAITING);
});

test('sell-side liquidity resolves as the mirror image', () => {
  const swept = [
    bar(102, 103, 101.5, 102.2), bar(102.2, 102.5, 101.8, 102),
    bar(102, 102.2, 99.0, 100.9),        // wicked below 100, closed back above
    bar(100.9, 104, 100.8, 103.8),       // displacement up
    bar(103.8, 105, 103.5, 104.8),
  ];
  const r = resolveEvent(below, swept, { atr: 1.2, pipSize: 0.01 });
  assert.equal(r.status, EVENT_STATUS.RECLAIMED);
  assert.equal(r.direction, 'BUY');
  assert.ok(r.followThroughPips > 0);
});

// ── summary ──────────────────────────────────────────────────────────────────

const ev = (status, confirmed, pips = 10) => ({ status, confirmed, followThroughPips: pips });

test('confirmed and provisional hit rates are counted separately', () => {
  // Pooling them lets unconfirmed coin flips inflate a rate meant to describe tradeable setups.
  const s = summariseEvents([
    ev(EVENT_STATUS.RECLAIMED, true, 30),
    ev(EVENT_STATUS.RECLAIMED, false, -5),
    ev(EVENT_STATUS.BROKE_AND_HELD, true, 20),
    ev(EVENT_STATUS.WAITING, false),
    ev(EVENT_STATUS.NO_FOLLOW_THROUGH, false),
  ]);
  assert.equal(s.alerts, 5);
  assert.equal(s.resolved, 3);
  assert.equal(s.waiting, 1);
  assert.equal(s.noFollowThrough, 1);
  assert.ok(Math.abs(s.reclaimRate - 0.667) < 0.001);
  assert.equal(s.confirmed.resolved, 2);
  assert.equal(s.confirmed.reclaimRate, 0.5, 'only the confirmed pair counts here');
});

test('the confirmation rate exposes alerts on levels that do nothing', () => {
  const s = summariseEvents([
    ev(EVENT_STATUS.RECLAIMED, false), ev(EVENT_STATUS.RECLAIMED, false),
    ev(EVENT_STATUS.RECLAIMED, false), ev(EVENT_STATUS.BROKE_AND_HELD, true),
  ]);
  assert.equal(s.confirmed.confirmationRate, 0.25);
});

test('an empty set reports nulls, not flattering zeros', () => {
  const s = summariseEvents([]);
  assert.equal(s.alerts, 0);
  assert.equal(s.reclaimRate, null);
  assert.equal(s.avgFollowThroughPips, null);
  assert.equal(s.confirmed.confirmationRate, null);
});

test('average follow-through ignores events that have none', () => {
  const s = summariseEvents([
    ev(EVENT_STATUS.RECLAIMED, true, 30),
    { status: EVENT_STATUS.BROKE_AND_HELD, confirmed: true, followThroughPips: null },
  ]);
  assert.equal(s.avgFollowThroughPips, 30);
});
