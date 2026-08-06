import assert from 'node:assert/strict';
import test from 'node:test';
import {
  structureTrend, trendsAligned, findMitigatedZone, findSweep, confirmCandle,
  findMarketShift, nearestTarget, goldScalpPlan, GOLD_SCALP_DEFAULTS,
} from './goldScalp.js';

const bar = (o, h, l, c, i = 0) => ({
  time: new Date(Date.parse('2026-07-01T00:00:00Z') + i * 900000).toISOString(),
  open: o, high: h, low: l, close: c, volume: 100,
});

/** A rising series with clean higher highs and higher lows. */
const uptrend = (count = 80, base = 4000) => Array.from({ length: count }, (_, i) => {
  const drift = i * 1.2;
  const wob = Math.sin(i / 2.5) * 6;
  const o = base + drift + wob;
  const c = base + drift + Math.sin((i + 1) / 2.5) * 6;
  return bar(o, Math.max(o, c) + 2, Math.min(o, c) - 2, c, i);
});
const downtrend = (count = 80, base = 4000) => uptrend(count, base)
  .map((b, i) => bar(2 * base - b.open, 2 * base - b.low, 2 * base - b.high, 2 * base - b.close, i));

// ── step 1: bias ─────────────────────────────────────────────────────────────

test('structure trend reads HH/HL and LH/LL', () => {
  assert.equal(structureTrend(uptrend()), 'BULLISH');
  assert.equal(structureTrend(downtrend()), 'BEARISH');
});

test('a flat market is RANGE, not a direction', () => {
  const flat = Array.from({ length: 80 }, (_, i) => bar(100, 100.5, 99.5, 100, i));
  assert.equal(structureTrend(flat), 'RANGE');
});

test('only matching H1 and LTF trends produce a direction', () => {
  assert.equal(trendsAligned('BULLISH', 'BULLISH'), 'BUY');
  assert.equal(trendsAligned('BEARISH', 'BEARISH'), 'SELL');
});

test('misalignment is refused — the source calls it low probability', () => {
  // The transcript rates the one misaligned trade he took 5/10 and says he almost lost it.
  assert.equal(trendsAligned('BEARISH', 'BULLISH'), null);
  assert.equal(trendsAligned('BULLISH', 'BEARISH'), null);
});

test('RANGE or missing trend is refused, never guessed', () => {
  assert.equal(trendsAligned('RANGE', 'RANGE'), null);
  assert.equal(trendsAligned('BULLISH', 'RANGE'), null);
  assert.equal(trendsAligned(null, 'BULLISH'), null);
  assert.equal(trendsAligned(undefined, undefined), null);
});

// ── steps 2/3: the point of interest ─────────────────────────────────────────

/** Base + demand zone at `zoneLow`, displacement away, then a return into it on the last bar. */
const withDemandZone = ({ returnToZone = true } = {}) => {
  const cs = [];
  let i = 0;
  for (; i < 30; i++) cs.push(bar(3990, 3993, 3987, 3991, i));
  cs.push(bar(3992, 3993, 3984, 3985, i++));            // pivot: DOWN candle = demand
  cs.push(bar(3986, 4000, 3985, 3999, i++));            // displacement up (> 1 ATR)
  cs.push(bar(3999, 4008, 3998, 4007, i++));
  for (; i < 55; i++) cs.push(bar(4007, 4010, 4004, 4008, i));
  if (returnToZone) {
    cs.push(bar(4000, 4001, 3986, 3999, i++));          // trades back INTO 3984-3993
    cs.push(bar(3992, 3994, 3985, 3993, i++));          // live bar sits inside the zone
  } else {
    for (let k = 0; k < 2; k++) cs.push(bar(4020, 4024, 4018, 4022, i++)); // far away
  }
  return cs;
};

test('a zone price is sitting in right now is found', () => {
  const cs = withDemandZone();
  const z = findMitigatedZone(cs, 'BUY', 6);
  assert.ok(z, 'expected a mitigated demand zone');
  assert.ok(z.bottom <= 3993 && z.top >= 3984, `zone ${z.bottom}-${z.top} should span the pivot`);
});

test('price far from any zone gives nothing — no mid-range entries', () => {
  // This is the mistake the source is most emphatic about.
  assert.equal(findMitigatedZone(withDemandZone({ returnToZone: false }), 'BUY', 6), null);
});

test('a zone wider than the cap is a region, not a level', () => {
  const cs = withDemandZone();
  assert.equal(findMitigatedZone(cs, 'BUY', 0.5), null, 'tiny ATR makes every zone too wide');
});

test('unusable input returns null rather than a zone', () => {
  assert.equal(findMitigatedZone([], 'BUY', 6), null);
  assert.equal(findMitigatedZone(null, 'BUY', 6), null);
  assert.equal(findMitigatedZone(withDemandZone(), 'BUY', 0), null);
});

// ── step 4a: the sweep ───────────────────────────────────────────────────────

/** A swing low at 3980, then a pierce below it that either reclaims or does not. */
const withSweep = ({ reclaim = true } = {}) => {
  const cs = [];
  let i = 0;
  for (; i < 12; i++) cs.push(bar(4000, 4004, 3996, 4001, i));
  cs.push(bar(3998, 4000, 3980, 3999, i++));            // the swing low being set
  for (; i < 28; i++) cs.push(bar(4000, 4006, 3996, 4003, i));
  if (reclaim) cs.push(bar(3990, 3996, 3974, 3994, i++)); // pierced 3980, closed back ABOVE
  else cs.push(bar(3990, 3992, 3970, 3972, i++));         // pierced and STAYED through
  cs.push(bar(3994, 4000, 3992, 3999, i++));
  return cs;
};

test('a swept-and-reclaimed level is a sweep, and reports the protected low', () => {
  const s = findSweep(withSweep(), 'BUY');
  assert.ok(s, 'expected a sweep');
  assert.equal(s.protectedExtreme, 3974, 'the stop anchors to the low that did the sweeping');
});

test('a pierce that stays through is a breakout, not a sweep', () => {
  // Trading this as a sweep is precisely the "false breakout" the source warns about.
  const s = findSweep(withSweep({ reclaim: false }), 'BUY');
  assert.ok(!s || s.protectedExtreme !== 3970, 'an unreclaimed pierce must not qualify');
});

test('a stale sweep is refused', () => {
  const cs = withSweep();
  for (let k = 0; k < 20; k++) cs.push(bar(4000, 4004, 3998, 4002, 40 + k));
  assert.equal(findSweep(cs, 'BUY'), null, 'beyond maxSweepAgeBars it is no longer this setup');
});

// ── the confirming candle ────────────────────────────────────────────────────

test('the confirming candle needs a real body in the trade direction', () => {
  assert.equal(confirmCandle(bar(100, 106, 99, 105), 'BUY'), true);
  assert.equal(confirmCandle(bar(105, 106, 99, 100), 'BUY'), false, 'wrong direction');
  assert.equal(confirmCandle(bar(100, 110, 90, 100.5), 'BUY'), false, 'doji body is not confirmation');
  assert.equal(confirmCandle(bar(105, 106, 99, 100), 'SELL'), true);
  assert.equal(confirmCandle(null, 'BUY'), false);
});

// ── step 5: the target ───────────────────────────────────────────────────────

test('the target is the NEAREST opposing swing, not the furthest', () => {
  // "Target the nearest logical liquidity" — a scalp, not a runner.
  const cs = uptrend(80, 4000);
  const entry = Number(cs[cs.length - 1].close);
  const t = nearestTarget(cs, 'BUY', entry, 5);
  if (t !== null) {
    const higher = cs.map((c) => Number(c.high)).filter((h) => h > entry);
    assert.ok(t <= Math.max(...higher), 'must not exceed the highest available level');
    assert.ok(t > entry, 'target must be ahead of price');
  }
});

test('a target inside the noise is refused', () => {
  const cs = uptrend(80, 4000);
  const entry = Number(cs[cs.length - 1].close);
  assert.equal(nearestTarget(cs, 'BUY', entry, 1e6), null, 'huge ATR makes every level noise');
});

// ── market shift ─────────────────────────────────────────────────────────────

test('a market shift reports its level and whether price returned', () => {
  const cs = [];
  let i = 0;
  for (; i < 12; i++) cs.push(bar(4000, 4004, 3996, 3998, i));
  cs.push(bar(3998, 4012, 3996, 4000, i++));            // the internal high at 4012
  for (; i < 26; i++) cs.push(bar(3995, 3999, 3988, 3992, i));
  cs.push(bar(3992, 4020, 3990, 4018, i++));            // closes THROUGH 4012 = shift
  cs.push(bar(4018, 4020, 4000, 4002, i++));            // pulls back
  const m = findMarketShift(cs, 'BUY');
  assert.ok(m, 'expected a shift');
  assert.equal(m.brokeLevel, 4012);
  assert.equal(typeof m.returned, 'boolean');
});

test('no shift when nothing was broken', () => {
  const flat = Array.from({ length: 60 }, (_, i) => bar(100, 100.4, 99.6, 100, i));
  assert.equal(findMarketShift(flat, 'BUY'), null);
});

// ── the full plan ────────────────────────────────────────────────────────────

test('a plan refuses when the higher timeframe disagrees', () => {
  // No amount of lower-timeframe quality overrides step 1.
  assert.equal(goldScalpPlan({ candles: uptrend(), h1Trend: 'BEARISH', pip: 0.1 }), null);
});

test('a plan refuses without enough history rather than guessing', () => {
  assert.equal(goldScalpPlan({ candles: uptrend(20), h1Trend: 'BULLISH', pip: 0.1 }), null);
  assert.equal(goldScalpPlan({ candles: [], h1Trend: 'BULLISH', pip: 0.1 }), null);
  assert.equal(goldScalpPlan({ candles: null, h1Trend: 'BULLISH', pip: 0.1 }), null);
});

test('the MSS variant is stricter than the sweep variant, never looser', () => {
  // Same candles: anything MSS accepts, SWEEP must also accept.
  const cs = withDemandZone();
  const sweep = goldScalpPlan({ candles: cs, h1Trend: 'BULLISH', pip: 0.1, variant: 'SWEEP', options: { requireConfirmCandle: false } });
  const mss = goldScalpPlan({ candles: cs, h1Trend: 'BULLISH', pip: 0.1, variant: 'MSS', options: { requireConfirmCandle: false } });
  if (mss) assert.ok(sweep, 'MSS accepted a setup SWEEP rejected — the variants are inverted');
});

/**
 * A series built to satisfy EVERY step at once — aligned HH/HL structure, an unmitigated
 * demand zone price is sitting in, a swing low swept and reclaimed on the live bar, and a
 * higher swing left as the target. Hand-placed because fractal pivots need strictly distinct
 * neighbours; repeated bars silently produce no swings at all.
 */
const fullSetup = () => {
  const rows = [
    [3990, 3993, 3987, 3991], [3991, 3994, 3988, 3992], [3992, 3993, 3985, 3987],
    [3987, 3989, 3978, 3980],                                   // swing LOW 3978
    [3980, 3986, 3979, 3985], [3985, 3990, 3984, 3989], [3989, 3996, 3988, 3995],
    [3995, 4002, 3994, 4000],                                   // swing HIGH 4002
    [4000, 4001, 3995, 3997], [3997, 3999, 3993, 3995], [3995, 3997, 3990, 3992],
    [3992, 3994, 3988, 3993],                                   // swing LOW 3988 (higher)
    [3993, 3999, 3992, 3998], [3998, 4006, 3997, 4005], [4005, 4012, 4004, 4011],
    [4011, 4018, 4010, 4016],                                   // swing HIGH 4018 (higher)
    [4016, 4017, 4010, 4012], [4012, 4014, 4008, 4010],
    [4010, 4011, 4003, 4004],                                   // demand pivot -> zone 4003-4011
    [4004, 4016, 4003, 4014], [4014, 4022, 4013, 4020],         // displacement out (> 1 ATR)
    [4020, 4024, 4018, 4022], [4022, 4026, 4020, 4024],
    [4024, 4030, 4022, 4028],                                   // swing HIGH 4030 = the target
    [4028, 4029, 4022, 4024], [4024, 4028, 4018, 4020],
    [4020, 4022, 4014, 4016],                                   // swing LOW 4014 = liquidity
    // Highs decline monotonically from here so no later fractal high can invert the trend.
    [4016, 4021, 4015, 4019], [4019, 4020, 4016, 4018], [4018, 4019, 4015, 4017],
    [4017, 4018, 4015.5, 4016], [4016, 4017, 4014.5, 4015],
    [4008, 4020, 4006, 4018],                                   // TRIGGER: sweeps 4014, dips
  ];                                                            //  into the zone, reclaims
  // Monotonic warm-up: satisfies the 60-bar minimum without inventing extra fractals.
  const warm = Array.from({ length: 30 }, (_, k) => { const o = 3950 + k; return [o, o + 3, o - 2, o + 1]; });
  return [...warm, ...rows].map((r, i) => bar(r[0], r[1], r[2], r[3], i));
};

test('the full framework fires on a setup that satisfies every step', () => {
  const p = goldScalpPlan({ candles: fullSetup(), h1Trend: 'BULLISH', pip: 0.1, variant: 'SWEEP' });
  assert.ok(p, 'expected a plan');
  assert.equal(p.decision, 'BUY');
  assert.equal(p.entry, 4018);
  assert.equal(p.stopLoss, 4006, 'stop sits under the low that swept liquidity');
  assert.equal(p.takeProfit3, 4030, 'target is the NEAREST swing high, not the furthest');
  assert.equal(p.riskRewardRatio, 1);
  assert.equal(p.meta.sweptLevel, 4014);
  assert.equal(p.meta.zoneBottom, 4003);
});

test('any plan produced has coherent geometry', () => {
  const series = [fullSetup(), uptrend(), downtrend(), withDemandZone(), withSweep()];
  let produced = 0;
  for (const cs of series) {
    for (const h1 of ['BULLISH', 'BEARISH']) {
      for (const variant of ['SWEEP', 'MSS']) {
        const p = goldScalpPlan({ candles: cs, h1Trend: h1, pip: 0.1, variant, options: { requireConfirmCandle: false } });
        if (!p) continue;
        produced++;
        const buy = p.decision === 'BUY';
        assert.ok(buy ? p.stopLoss < p.entry : p.stopLoss > p.entry, 'stop on the losing side');
        assert.ok(buy ? p.takeProfit3 > p.entry : p.takeProfit3 < p.entry, 'target ahead of entry');
        assert.ok(buy ? p.takeProfit1 > p.entry : p.takeProfit1 < p.entry, 'TP1 ahead of entry');
        assert.ok(p.riskRewardRatio > 0, 'RR must be positive');
        assert.ok(p.score >= 40 && p.score <= 95, `score ${p.score} out of band`);
        assert.ok(['A+', 'A', 'B', 'C'].includes(p.grade));
        assert.equal(p.meta.variant, variant);
      }
    }
  }
  assert.ok(produced > 0, 'the synthetic series must produce at least one plan or the test is vacuous');
});

test('the confirming candle is a real gate, not decoration', () => {
  // Same setup, but the trigger bar is turned into a doji: the plan must disappear.
  const cs = fullSetup();
  const last = cs[cs.length - 1];
  cs[cs.length - 1] = { ...last, open: 4017.5, close: 4018 };   // body ~3% of range
  assert.equal(goldScalpPlan({ candles: cs, h1Trend: 'BULLISH', pip: 0.1, variant: 'SWEEP' }), null);
  assert.ok(goldScalpPlan({ candles: cs, h1Trend: 'BULLISH', pip: 0.1, variant: 'SWEEP', options: { requireConfirmCandle: false } }),
    'with the knob off the same setup should still fire');
});

test('there is no minimum RR gate — the source targets the nearest level', () => {
  // A 2R floor would reject the strategy's own logic. RR is recorded, not gated.
  assert.equal(GOLD_SCALP_DEFAULTS.minRR, undefined);
});

test('the sub-spread stop floor is inherited from the lab-wide fix', () => {
  assert.equal(GOLD_SCALP_DEFAULTS.minStopAtr, 0.35);
  assert.equal(GOLD_SCALP_DEFAULTS.minStopPips, 3);
});

test('the plan is deterministic', () => {
  const args = { candles: withDemandZone(), h1Trend: 'BULLISH', pip: 0.1, variant: 'SWEEP', options: { requireConfirmCandle: false } };
  assert.deepEqual(goldScalpPlan(args), goldScalpPlan(args));
});

test('the signal is anchored to the SWEEP bar, so one setup is one signal', () => {
  // The setup stays true while price sits in the zone. Anchoring to the current bar would
  // re-emit the same trade every bar and multiply one setup into a dozen.
  const cs = fullSetup();
  const p = goldScalpPlan({ candles: cs, h1Trend: 'BULLISH', pip: 0.1, variant: 'SWEEP' });
  assert.ok(p);
  assert.equal(p.barIso, cs[cs.length - 1].time, 'the sweep IS the last bar in this fixture');
  // Append a bar that keeps the setup alive: the anchor must NOT advance with it.
  const held = [...cs, { ...cs[cs.length - 1], time: '2026-09-01T00:00:00.000Z', open: 4014, high: 4022, low: 4012, close: 4020 }];
  const p2 = goldScalpPlan({ candles: held, h1Trend: 'BULLISH', pip: 0.1, variant: 'SWEEP' });
  if (p2) assert.notEqual(p2.barIso, held[held.length - 1].time, 'anchor must not follow the live bar');
});
