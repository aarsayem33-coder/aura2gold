import assert from 'node:assert/strict';
import test from 'node:test';
import { forecastScoreBasis, evidencePlain, SCENARIO_PLAIN } from './forecastScoreBasis.js';
import { SCENARIOS, SCENARIO_GEOMETRY } from './setupForecast.js';

const F = {
  symbol: 'XAUUSDM', timeframe: 'M15', scenario: 'SWEEP_REJECT',
  level: 4012.5, levelType: 'PDH', levelLabel: 'Prev day high',
  levelSources: ['LIQUIDITY', 'ORDER_BLOCK'], levelConfluence: 2,
  distance: { pips: 84, atr: 1.4 },
  agreeCount: 2, dissentCount: 1,
  scenarioBars: [{}, {}],
  bestScore: 82, bestStrategy: 'liquidity-sweep-pro',
  plan: { entry: 4012, stopLoss: 4016 },
};

// ── the split that the whole panel exists for ────────────────────────────────

test('the arrival is listed as an assumption, not as a fact', () => {
  // The single most misread thing on the page: a forecast looks like a signal. If "price has not
  // got there yet" is not the first thing the panel says, everything below it is misleading.
  const b = forecastScoreBasis({ forecast: F });
  assert.match(b.assumed[0].label, /gets there/i);
  assert.match(b.assumed[0].detail, /84 pips away/);
  assert.match(b.headline, /prediction, not a signal/i);
});

test('the level and the real history are on the MEASURED side', () => {
  const b = forecastScoreBasis({ forecast: F });
  const labels = b.measured.map((m) => m.label).join(' | ');
  assert.match(labels, /The level itself/);
  assert.match(labels, /Everything before the reaction/);
  assert.match(labels, /bigger-picture trend/);
});

test('nothing appears on both sides of the split', () => {
  const b = forecastScoreBasis({ forecast: F });
  const a = new Set(b.assumed.map((x) => x.label));
  for (const m of b.measured) assert.equal(a.has(m.label), false, `${m.label} is claimed as both assumed and measured`);
});

test('the ticket is called an assumption only when a ticket actually exists', () => {
  // Claiming "the entry and stop are assumed" on a forecast with no sized ticket describes
  // nothing, and reads as a warning about a number that is not on screen.
  assert.ok(forecastScoreBasis({ forecast: F }).assumed.some((x) => /entry and stop/i.test(x.label)));
  assert.equal(
    forecastScoreBasis({ forecast: { ...F, plan: null } }).assumed.some((x) => /entry and stop/i.test(x.label)),
    false,
  );
});

// ── wording has to survive a beginner reading it ─────────────────────────────

test('every scenario has plain-English copy, and none of it leaks the enum name', () => {
  for (const s of SCENARIOS) {
    const p = SCENARIO_PLAIN[s];
    assert.ok(p, `${s} has no plain-English entry`);
    assert.doesNotMatch(p.name, /_/, `${s} name still reads like an enum`);
    assert.doesNotMatch(p.story, /_/);
    assert.ok(p.story.length > 40, `${s} story is too terse to explain anything`);
    assert.ok(p.wrongIf.length > 10, `${s} does not say what would make it wrong`);
  }
});

test('an unknown scenario degrades to readable text instead of throwing', () => {
  const b = forecastScoreBasis({ forecast: { ...F, scenario: 'WEIRD_NEW_THING' } });
  assert.equal(b.scenario.key, 'WEIRD_NEW_THING');
  assert.ok(b.scenario.story.length > 10);
  assert.equal(b.assumed.length >= 3, true);
});

test('the pierce depth is quoted from the geometry the bars were really built with', () => {
  // A number invented for the copy would drift the moment the builder is tuned, and would be
  // describing a candle that was never drawn.
  const b = forecastScoreBasis({ forecast: F });
  const size = b.assumed.find((x) => /How big/i.test(x.label));
  assert.match(size.detail, new RegExp(String(SCENARIO_GEOMETRY.sweep.pierce)));

  const custom = forecastScoreBasis({ forecast: F, geo: { ...SCENARIO_GEOMETRY, sweep: { ...SCENARIO_GEOMETRY.sweep, pierce: 0.99 } } });
  assert.match(custom.assumed.find((x) => /How big/i.test(x.label)).detail, /0\.99/);
});

test('confluence is spelled out rather than shown as a bare multiplier', () => {
  const b = forecastScoreBasis({ forecast: F });
  const lvl = b.measured.find((m) => m.label === 'The level itself');
  assert.match(lvl.detail, /2 independent things/);
  assert.match(lvl.detail, /resting liquidity/);
  assert.match(lvl.detail, /order block/);

  const single = forecastScoreBasis({ forecast: { ...F, levelSources: ['ZONE'], levelConfluence: 1 } });
  const one = single.measured.find((m) => m.label === 'The level itself');
  assert.match(one.detail, /It points at this same price/);
});

test('dissent is reported, never quietly dropped', () => {
  const b = forecastScoreBasis({ forecast: F });
  const who = b.measured.find((m) => /Which strategies/.test(m.label));
  assert.match(who.detail, /2 strategies/);
  assert.match(who.detail, /1 argued the other way/);

  const clean = forecastScoreBasis({ forecast: { ...F, dissentCount: 0 } });
  assert.match(clean.measured.find((m) => /Which strategies/.test(m.label)).detail, /No strategy argued against it/);

  const none = forecastScoreBasis({ forecast: { ...F, agreeCount: 0, dissentCount: 0 } });
  assert.match(none.measured.find((m) => /Which strategies/.test(m.label)).detail, /No strategy currently backs/);
});

// ── the placebo evidence, in words ───────────────────────────────────────────

test('a passed placebo test is stated as evidence, with the lift explained', () => {
  const e = evidencePlain({ verdict: 'LEVEL_DRIVEN', lift: 3.2, levelOnly: false });
  assert.equal(e.good, true);
  assert.match(e.headline, /Passed the placebo test/);
  assert.match(e.detail, /3\.2× more often at real levels/);
});

test('a strategy that never fires at random prices says exactly that', () => {
  const e = evidencePlain({ verdict: 'LEVEL_DRIVEN', lift: null, levelOnly: true });
  assert.match(e.detail, /never once fired at a random price/);
});

test('a failed placebo test warns instead of burying the result', () => {
  // This is the finding that should stop someone trading a forecast, so it cannot be phrased
  // as a neutral footnote.
  const e = evidencePlain({ verdict: 'SHAPE_DRIVEN', lift: 1.1, levelOnly: false });
  assert.equal(e.good, false);
  assert.match(e.headline, /Failed the placebo test/);
  assert.match(e.detail, /reacting to the SHAPE/);
  assert.match(e.detail, /weak evidence/);
});

test('unmeasured and silent are honest about knowing nothing, not neutral-positive', () => {
  for (const v of ['UNMEASURED', 'SILENT']) {
    const e = evidencePlain({ verdict: v, lift: null, levelOnly: false });
    assert.equal(e.good, null, `${v} must not read as a pass`);
  }
  const missing = evidencePlain(null);
  assert.equal(missing.good, null);
  assert.match(missing.headline, /Not measured yet/);
});

test('the caution never lets the score be read as a probability', () => {
  const b = forecastScoreBasis({ forecast: F });
  assert.match(b.caution, /never as a chance of it playing out/);
});

test('a forecast with no distance still produces a usable panel', () => {
  const b = forecastScoreBasis({ forecast: { ...F, distance: null } });
  assert.match(b.assumed[0].detail, /has not reached this level yet/);
  assert.match(b.headline, /needs price to reach/);
});
