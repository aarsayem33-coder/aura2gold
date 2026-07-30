import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LIFECYCLE, driftEntry, applyDrift, driftSummary, forecastWindowMs,
  classifyArrival, followThrough, resolveForecast, RESOLUTION_DEFAULTS,
} from './forecastLifecycle.js';

const ATR = 8.98;
const PDL = 3995.83;                       // level below price, gold
const bar = (open, high, low, close, iso = '2026-07-30T12:00:00.000Z') => ({ time: iso, open, high, low, close });

// ── drift ────────────────────────────────────────────────────────────────────

test('drift entries capture quality over time and summarise against the first', () => {
  const f = (rank, score) => ({ rankScore: rank, bestScore: score, agreeCount: 2, eta: { midMinutes: 90 } });
  let h = applyDrift(null, driftEntry(f(50, 80), 1000));
  h = applyDrift(h, driftEntry(f(58, 85), 2000));
  h = applyDrift(h, driftEntry(f(44, 76), 3000));
  const s = driftSummary(h);
  assert.equal(s.rank, -6);       // 44 - 50
  assert.equal(s.score, -4);      // 76 - 80
  assert.equal(s.points, 3);
  assert.deepEqual(driftSummary([h[0]]), { rank: 0, score: 0, points: 1 });
  assert.deepEqual(driftSummary(null), { rank: 0, score: 0, points: 0 });
});

test('the drift cap keeps the FIRST point — drift is measured against it', () => {
  let h = null;
  for (let i = 0; i < 200; i++) h = applyDrift(h, { ts: String(i), rankScore: i, bestScore: i }, 10);
  assert.equal(h.length, 10);
  assert.equal(h[0].rankScore, 0, 'losing the first point would silently re-base all drift');
  assert.equal(h.at(-1).rankScore, 199);
});

// ── window ───────────────────────────────────────────────────────────────────

test('the waiting window is twice the outer ETA, floored at 2h and capped at 48h', () => {
  assert.equal(forecastWindowMs({ eta: { maxMinutes: 286 } }), 286 * 2 * 60000);
  assert.equal(forecastWindowMs({ eta: { maxMinutes: 10 } }), RESOLUTION_DEFAULTS.minWindowMs);
  assert.equal(forecastWindowMs({ eta: { maxMinutes: 100000 } }), RESOLUTION_DEFAULTS.maxWindowMs);
  assert.equal(forecastWindowMs({}), RESOLUTION_DEFAULTS.minWindowMs);
});

// ── arrival classification ───────────────────────────────────────────────────

const cls = (candles) => classifyArrival(candles, { level: PDL, side: 'below', atr: ATR });

test('no arrival while price stays away from the level', () => {
  assert.equal(cls([bar(4030, 4035, 4020, 4028), bar(4028, 4040, 4025, 4038)]), null);
});

test('a pierce that closes back inside is a SWEEP_REJECT', () => {
  // Trades 3 below the level (> 0.45 pierce threshold), closes 2.7 back above.
  const r = cls([bar(3998, 3999, PDL - 3, PDL + 2.7)]);
  assert.equal(r.actual, 'SWEEP_REJECT');
  assert.equal(r.arrivedIdx, 0);
});

test('a close beyond that HOLDS on the next bar is a BREAK_HOLD', () => {
  const r = cls([bar(3998, 3999, 3990, 3992), bar(3992, 3994, 3988, 3989)]);
  assert.equal(r.actual, 'BREAK_HOLD');
});

test('a close beyond that is reclaimed next bar is a SWEEP_REJECT, not a break', () => {
  // The event bar alone looks like a break; the reclaim reveals it was a deep sweep.
  const r = cls([bar(3998, 3999, 3990, 3992), bar(3992, 4001, 3991, 3999.5)]);
  assert.equal(r.actual, 'SWEEP_REJECT');
});

test('a close beyond on the LAST closed bar waits for the next bar', () => {
  const r = cls([bar(3998, 3999, 3990, 3992)]);
  assert.equal(r.actual, 'PENDING_NEXT_BAR', 'break vs deep sweep cannot be judged yet');
});

test('reaching the touch band without piercing is a TOUCH_REJECT', () => {
  // Low comes within 0.05 ATR (0.449) of the level, never through it.
  const r = cls([bar(3999, 4000, PDL + 0.2, 3998.5)]);
  assert.equal(r.actual, 'TOUCH_REJECT');
});

test('a bar that opens beyond the level without touching it is GAPPED', () => {
  // Weekend gap: price teleported below without ever trading the level.
  const r = cls([bar(3990, 3991, 3985, 3987)]);
  assert.equal(r.actual, 'GAPPED');
});

test('the FIRST qualifying bar decides — later bars cannot rewrite the story', () => {
  const r = cls([
    bar(3999, 4000, PDL + 0.2, 3998.5),          // touch-reject first
    bar(3998, 3999, PDL - 3, PDL + 2.7),         // a sweep later
  ]);
  assert.equal(r.actual, 'TOUCH_REJECT');
  assert.equal(r.arrivedIdx, 0);
});

test('classification mirrors correctly for a level above price', () => {
  const PDH = 4116.38;
  const up = (candles) => classifyArrival(candles, { level: PDH, side: 'above', atr: ATR });
  assert.equal(up([bar(4113, PDH + 3, 4112, PDH - 2.7)]).actual, 'SWEEP_REJECT');
  assert.equal(up([bar(4113, 4122, 4112, 4120), bar(4120, 4124, 4119, 4122)]).actual, 'BREAK_HOLD');
  assert.equal(up([bar(4113, PDH - 0.2, 4112, 4114)]).actual, 'TOUCH_REJECT');
  assert.equal(up([bar(4122, 4125, 4120, 4123)]).actual, 'GAPPED');
});

test('junk candles are skipped, not classified', () => {
  const r = cls([bar(NaN, NaN, NaN, NaN), bar(3998, 3999, PDL - 3, PDL + 2.7)]);
  assert.equal(r.arrivedIdx, 1);
  assert.equal(cls([]), null);
  assert.equal(classifyArrival([bar(1, 2, 0.5, 1)], { level: NaN, side: 'below', atr: ATR }), null);
  assert.equal(classifyArrival([bar(1, 2, 0.5, 1)], { level: PDL, side: 'below', atr: 0 }), null);
});

// ── follow-through ───────────────────────────────────────────────────────────

test('follow-through measures excursions from the event close, in pips', () => {
  const candles = [
    bar(3998, 3999, PDL - 3, 3998.5),            // event bar, close 3998.5
    bar(3998.5, 4003.5, 3997.5, 4002),           // +5.0 / -1.0
    bar(4002, 4006.5, 4000, 4005),               // +8.0 / (3997.5 still the low)
  ];
  const f = followThrough(candles, 0, { direction: 'BUY', pip: 0.1 });
  assert.equal(f.mfePips, 80);        // 3998.5 -> 4006.5
  assert.equal(f.maePips, 10);        // 3998.5 -> 3997.5
  assert.equal(f.barsMeasured, 2);
});

test('follow-through for a SELL mirrors the arithmetic', () => {
  const candles = [
    bar(4113, 4119, 4112, 4113.5),
    bar(4113.5, 4114.5, 4108.5, 4109),           // favourable 5.0, adverse 1.0
  ];
  const f = followThrough(candles, 0, { direction: 'SELL', pip: 0.1 });
  assert.equal(f.mfePips, 50);
  assert.equal(f.maePips, 10);
});

test('follow-through with no bars after the event is null, not zeros', () => {
  assert.equal(followThrough([bar(1, 2, 0.5, 1)], 0, { direction: 'BUY', pip: 0.1 }), null);
});

// ── full resolution ──────────────────────────────────────────────────────────

const ROW = {
  createdAt: '2026-07-30T10:00:00.000Z',
  level: PDL, side: 'below', atr: ATR,
  scenario: 'SWEEP_REJECT', expectedDirection: 'BUY',
  etaMaxMinutes: 286,
};
const at = (min) => Date.parse('2026-07-30T10:00:00.000Z') + min * 60000;

test('a matching arrival resolves MATCHED with timing and excursions', () => {
  const candles = [
    bar(4030, 4032, 4020, 4025, '2026-07-30T11:00:00.000Z'),
    bar(4000, 4001, PDL - 3, PDL + 2.7, '2026-07-30T12:30:00.000Z'),     // the sweep
    bar(PDL + 2.7, 4008, PDL + 1, 4006, '2026-07-30T12:45:00.000Z'),
  ];
  const r = resolveForecast(ROW, candles, { nowMs: at(200), pip: 0.1 });
  assert.equal(r.status, LIFECYCLE.RESOLVED);
  assert.equal(r.actual, 'SWEEP_REJECT');
  assert.equal(r.matched, true);
  assert.equal(r.actualMinutes, 150);
  assert.ok(r.mfePips > 0);
});

test('the wrong behaviour at the level resolves MISMATCH with the actual named', () => {
  const candles = [
    bar(4000, 4001, 3990, 3992, '2026-07-30T12:00:00.000Z'),
    bar(3992, 3993, 3988, 3989, '2026-07-30T12:15:00.000Z'),             // held: a break
  ];
  const r = resolveForecast(ROW, candles, { nowMs: at(200), pip: 0.1 });
  assert.equal(r.status, LIFECYCLE.RESOLVED);
  assert.equal(r.matched, false);
  assert.equal(r.actual, 'BREAK_HOLD', 'the report needs WHAT happened, not just "wrong"');
});

test('still waiting inside the window changes nothing', () => {
  const candles = [bar(4030, 4032, 4020, 4025, '2026-07-30T11:00:00.000Z')];
  assert.equal(resolveForecast(ROW, candles, { nowMs: at(60), pip: 0.1 }), null);
});

test('no arrival past the window expires', () => {
  const candles = [bar(4030, 4032, 4020, 4025, '2026-07-30T11:00:00.000Z')];
  const r = resolveForecast(ROW, candles, { nowMs: at(286 * 2 + 1), pip: 0.1 });
  assert.equal(r.status, LIFECYCLE.EXPIRED);
});

test('an arrival pending its confirming bar is not resolved early', () => {
  const candles = [bar(4000, 4001, 3990, 3992, '2026-07-30T12:00:00.000Z')];   // closed beyond, no next bar yet
  assert.equal(resolveForecast(ROW, candles, { nowMs: at(200), pip: 0.1 }), null);
});

test('a gap past the level resolves as GAPPED, never as a scenario verdict', () => {
  const candles = [bar(3985, 3988, 3980, 3982, '2026-07-30T12:00:00.000Z')];
  const r = resolveForecast(ROW, candles, { nowMs: at(200), pip: 0.1 });
  assert.equal(r.status, LIFECYCLE.RESOLVED);
  assert.equal(r.actual, 'GAPPED');
  assert.equal(r.matched, false);
});

test('a corrupt createdAt refuses to resolve rather than misdating everything', () => {
  assert.equal(resolveForecast({ ...ROW, createdAt: 'garbage' }, [], { nowMs: at(999), pip: 0.1 }), null);
});
