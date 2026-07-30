import assert from 'node:assert/strict';
import test from 'node:test';
import {
  emptyStats, recordScenario, mergeStats, discriminationFor, partitionStrategies,
  discriminationReport, placeboPrices, VERDICT, DISCRIMINATION_DEFAULTS,
} from './forecastDiscrimination.js';

/** Build stats with given fire counts over `real`/`placebo` scenario counts. */
function stats({ real = 100, placebo = 100, by = {} } = {}) {
  const s = emptyStats();
  s.realScenarios = real;
  s.placeboScenarios = placebo;
  for (const [id, v] of Object.entries(by)) s.byStrategy[id] = { realFires: v[0], placeboFires: v[1] };
  return s;
}

test('recordScenario tallies each arm separately', () => {
  const s = emptyStats();
  recordScenario(s, { arm: 'real', fired: ['a', 'b'] });
  recordScenario(s, { arm: 'real', fired: ['a'] });
  recordScenario(s, { arm: 'placebo', fired: ['b'] });
  assert.equal(s.realScenarios, 2);
  assert.equal(s.placeboScenarios, 1);
  assert.deepEqual(s.byStrategy.a, { realFires: 2, placeboFires: 0 });
  assert.deepEqual(s.byStrategy.b, { realFires: 1, placeboFires: 1 });
});

test('recordScenario ignores an unknown arm rather than corrupting the tally', () => {
  const s = emptyStats();
  recordScenario(s, { arm: 'nonsense', fired: ['a'] });
  assert.equal(s.realScenarios, 0);
  assert.equal(s.placeboScenarios, 0);
  assert.deepEqual(s.byStrategy, {});
});

test('a strategy firing only at real levels is LEVEL_DRIVEN', () => {
  // liq-trap-pro measured 8% at levels, 0% on placebo.
  const d = discriminationFor(stats({ by: { lt: [8, 0] } }), 'lt');
  assert.equal(d.verdict, VERDICT.LEVEL_DRIVEN);
  assert.equal(d.levelOnly, true);
  assert.equal(d.lift, null, 'an infinite lift is reported as null, not Infinity');
  assert.equal(d.realRate, 0.08);
  assert.equal(d.placeboRate, 0);
});

test('a strategy firing as often or more on placebo is SHAPE_DRIVEN', () => {
  // smc-two-lines measured 40% real vs 58% placebo — fires MORE without a level.
  const two = discriminationFor(stats({ by: { two: [40, 58] } }), 'two');
  assert.equal(two.verdict, VERDICT.SHAPE_DRIVEN);
  assert.equal(two.lift, 0.69);
  // liquidity-sweep-pro measured 5% vs 13%.
  assert.equal(discriminationFor(stats({ by: { lsp: [5, 13] } }), 'lsp').verdict, VERDICT.SHAPE_DRIVEN);
  // And one that barely prefers levels is still not good enough at the 1.25 threshold.
  assert.equal(discriminationFor(stats({ by: { meh: [11, 10] } }), 'meh').verdict, VERDICT.SHAPE_DRIVEN);
});

test('the lift threshold is the dividing line, and it is inclusive', () => {
  assert.equal(discriminationFor(stats({ by: { x: [125, 100] } }), 'x').verdict, VERDICT.LEVEL_DRIVEN);
  assert.equal(discriminationFor(stats({ by: { x: [124, 100] } }), 'x').verdict, VERDICT.SHAPE_DRIVEN);
});

test('no verdict is reached on a small sample, in either direction', () => {
  // The original measurement had only 45 placebo scenarios; a 0% rate over 5 proves nothing.
  const thin = stats({ real: 10, placebo: 5, by: { a: [4, 0] } });
  const d = discriminationFor(thin, 'a');
  assert.equal(d.verdict, VERDICT.UNMEASURED);
  assert.equal(d.levelOnly, false, 'level-only must not be claimed without enough placebo samples');
  // Plenty of real scenarios but almost no control is still unmeasured.
  assert.equal(discriminationFor(stats({ real: 500, placebo: 3, by: { a: [50, 0] } }), 'a').verdict, VERDICT.UNMEASURED);
  // And the reverse.
  assert.equal(discriminationFor(stats({ real: 3, placebo: 500, by: { a: [1, 90] } }), 'a').verdict, VERDICT.UNMEASURED);
});

test('a strategy that never fires anywhere is SILENT, not SHAPE_DRIVEN', () => {
  // ict-breaker and friends need a longer bar sequence than a level-arrival scenario specifies.
  // Reporting them as shape-driven would misstate why they are absent.
  assert.equal(discriminationFor(stats({ by: { ict: [0, 0] } }), 'ict').verdict, VERDICT.SILENT);
  // Even before there is enough sample to judge discrimination.
  assert.equal(discriminationFor(stats({ real: 5, placebo: 2, by: { ict: [0, 0] } }), 'ict').verdict, VERDICT.SILENT);
  // But with no scenarios run at all, nothing is known.
  assert.equal(discriminationFor(emptyStats(), 'ict').verdict, VERDICT.UNMEASURED);
});

test('an unknown strategy reads as no evidence, not as a failure', () => {
  const d = discriminationFor(stats(), 'never-seen');
  assert.equal(d.realRate, 0);
  assert.equal(d.placeboRate, 0);
  assert.equal(d.verdict, VERDICT.SILENT);
  assert.equal(discriminationFor(null, 'x').verdict, VERDICT.UNMEASURED);
  assert.equal(discriminationFor(undefined, 'x').verdict, VERDICT.UNMEASURED);
});

// ── accumulation and decay ───────────────────────────────────────────────────

test('merging accumulates evidence across scans', () => {
  const a = stats({ real: 20, placebo: 20, by: { x: [4, 1] } });
  const b = stats({ real: 30, placebo: 30, by: { x: [6, 2] } });
  const m = mergeStats(a, b, { decay: 1 });
  assert.equal(m.realScenarios, 50);
  assert.equal(m.placeboScenarios, 50);
  assert.deepEqual(m.byStrategy.x, { realFires: 10, placeboFires: 3 });
});

test('decay weights recent scans over old ones without discarding history', () => {
  const old = stats({ real: 100, placebo: 100, by: { x: [50, 50] } });
  const fresh = stats({ real: 10, placebo: 10, by: { x: [10, 0] } });
  const m = mergeStats(old, fresh, { decay: 0.5 });
  assert.equal(m.realScenarios, 60);          // 100*0.5 + 10
  assert.equal(m.byStrategy.x.realFires, 35); // 50*0.5 + 10
  assert.equal(m.byStrategy.x.placeboFires, 25);
  // A strategy whose behaviour changed should move toward the new evidence.
  const before = discriminationFor(old, 'x').lift;
  const after = discriminationFor(m, 'x').lift;
  assert.ok(after > before, `lift should rise as the strategy stops firing on placebo (${before} -> ${after})`);
});

test('merging tolerates missing or empty sides', () => {
  const s = stats({ by: { x: [1, 1] } });
  assert.deepEqual(mergeStats(null, s, { decay: 1 }).byStrategy.x, { realFires: 1, placeboFires: 1 });
  assert.deepEqual(mergeStats(s, null, { decay: 1 }).byStrategy.x, { realFires: 1, placeboFires: 1 });
  assert.deepEqual(mergeStats(null, null).byStrategy, {});
  // A strategy present on only one side still survives the merge.
  const m = mergeStats(stats({ by: { a: [1, 0] } }), stats({ by: { b: [2, 0] } }), { decay: 1 });
  assert.ok(m.byStrategy.a && m.byStrategy.b);
});

test('decay is clamped so a bad value cannot inflate history', () => {
  const s = stats({ real: 10, placebo: 10, by: { x: [5, 0] } });
  assert.equal(mergeStats(s, emptyStats(), { decay: 99 }).realScenarios, 10);
  assert.equal(mergeStats(s, emptyStats(), { decay: -5 }).realScenarios, 0);
  assert.equal(mergeStats(s, emptyStats(), { decay: NaN }).realScenarios, 0);
});

// ── partitioning ─────────────────────────────────────────────────────────────

test('shape-driven strategies are dropped, level-driven and unproven are kept', () => {
  const s = stats({
    by: {
      good: [20, 2],      // 10x lift  -> keep
      pure: [8, 0],       // level-only -> keep
      shape: [40, 58],    // 0.69x      -> drop
      weak: [5, 13],      // 0.41x      -> drop
      quiet: [0, 0],      // silent     -> keep (absent for a different reason)
    },
  });
  const { allowed, dropped } = partitionStrategies(['good', 'pure', 'shape', 'weak', 'quiet'], s);
  assert.deepEqual(allowed, ['good', 'pure', 'quiet']);
  assert.deepEqual(dropped.map((d) => d.strategyId), ['shape', 'weak']);
  // The reason travels with the drop so the page can explain the exclusion.
  assert.equal(dropped[0].lift, 0.69);
  assert.equal(dropped[0].verdict, VERDICT.SHAPE_DRIVEN);
});

test('nothing is dropped before there is evidence to drop it on', () => {
  // A fresh install must not show an empty page. Unproven strategies are kept but flagged.
  const thin = stats({ real: 6, placebo: 4, by: { a: [1, 3] } });
  const { allowed, dropped, unmeasured } = partitionStrategies(['a'], thin);
  assert.deepEqual(allowed, ['a']);
  assert.deepEqual(dropped, []);
  assert.deepEqual(unmeasured.map((d) => d.strategyId), ['a']);
  // With no stats at all, everything is allowed.
  assert.deepEqual(partitionStrategies(['a', 'b'], null).allowed, ['a', 'b']);
  assert.deepEqual(partitionStrategies(['a', 'b'], null).dropped, []);
});

test('partitioning handles an empty or missing id list', () => {
  assert.deepEqual(partitionStrategies([], stats()).allowed, []);
  assert.deepEqual(partitionStrategies(null, stats()).allowed, []);
});

test('the report ranks the most level-driven first and includes the evidence', () => {
  const s = stats({ by: { shape: [40, 58], good: [20, 2], pure: [8, 0] } });
  const rep = discriminationReport(['shape', 'good', 'pure'], s);
  assert.equal(rep.length, 3);
  assert.equal(rep.at(-1).strategyId, 'shape', 'the worst discriminator ranks last');
  assert.ok(rep.every((r) => 'realRate' in r && 'placeboRate' in r && 'realScenarios' in r));
});

// ── placebo price selection ──────────────────────────────────────────────────

const ATR = 8.98;
const PRICE = 4038.58;

test('placebo prices clear every known level by more than the bar can reach', () => {
  const levels = [{ price: 4020 }, { price: 4000 }, { price: 4060 }];
  const real = [{ price: 4020, side: 'below' }];
  const out = placeboPrices(levels, { price: PRICE, atr: ATR, realLevels: real });
  assert.ok(out.length >= 1);
  for (const p of out) {
    for (const l of levels) {
      assert.ok(Math.abs(p.price - l.price) >= DISCRIMINATION_DEFAULTS.minSeparationAtr * ATR,
        `placebo ${p.price} is only ${Math.abs(p.price - l.price).toFixed(2)} from level ${l.price}`);
    }
  }
});

test('placebo prices keep the real level side relative to current price', () => {
  const real = [{ price: 4020, side: 'below' }, { price: 4070, side: 'above' }];
  const out = placeboPrices([{ price: 4020 }, { price: 4070 }], { price: PRICE, atr: ATR, realLevels: real });
  for (const p of out) {
    if (p.side === 'below') assert.ok(p.price < PRICE, `${p.price} marked below but is above price`);
    else assert.ok(p.price > PRICE, `${p.price} marked above but is below price`);
  }
});

test('placebo prices are marked, so they can never be mistaken for real levels', () => {
  const out = placeboPrices([{ price: 4020 }], { price: PRICE, atr: ATR, realLevels: [{ price: 4020, side: 'below' }] });
  assert.ok(out.every((p) => p.placebo === true));
});

test('a crowded chart yields fewer placebos rather than contaminated ones', () => {
  // Levels every 0.3 ATR across the whole range: no clean gap exists.
  const levels = Array.from({ length: 60 }, (_, i) => ({ price: 3900 + i * ATR * 0.3 }));
  const out = placeboPrices(levels, { price: PRICE, atr: ATR, realLevels: [{ price: 4020, side: 'below' }] });
  assert.equal(out.length, 0, 'better to have no control than a control that sweeps real liquidity');
});

test('placebo prices do not duplicate each other', () => {
  const real = [{ price: 4020, side: 'below' }, { price: 4020.5, side: 'below' }];
  const out = placeboPrices([{ price: 4020 }, { price: 4020.5 }], { price: PRICE, atr: ATR, realLevels: real });
  const seen = new Set(out.map((p) => p.price));
  assert.equal(seen.size, out.length);
});

test('placebo selection degrades safely on bad input', () => {
  assert.deepEqual(placeboPrices([], { price: NaN, atr: ATR, realLevels: [] }), []);
  assert.deepEqual(placeboPrices([], { price: PRICE, atr: 0, realLevels: [] }), []);
  assert.deepEqual(placeboPrices([], { price: PRICE, atr: ATR, realLevels: null }), []);
  assert.deepEqual(placeboPrices(null, { price: PRICE, atr: ATR, realLevels: [{ price: NaN, side: 'below' }] }), []);
});
