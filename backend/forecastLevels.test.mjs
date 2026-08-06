import assert from 'node:assert/strict';
import test from 'node:test';
import {
  orderBlockLevels, zoneLevels, retestLevels, dedupeLevels,
  interleaveBySource, mergeForecastLevels, sourceGroup,
} from './forecastLevels.js';

const P = 4000, ATR = 10, PIP = 0.1;
const ob = (over = {}) => ({ type: 'BULLISH', top: 3990, bottom: 3985, active: true, unmitigated: true, mitigated: false, invalidated: false, actionable: true, sourceIndex: 100, ...over });

// ── order blocks ─────────────────────────────────────────────────────────────

test('a demand block is levelled at its TOP, a supply block at its BOTTOM', () => {
  // Price returns to the near edge. Using the midpoint would forecast arrival deeper than the
  // strategies need and mark reached setups unreached.
  const [bull] = orderBlockLevels([ob()], { price: P, atr: ATR, pip: PIP });
  assert.equal(bull.price, 3990, 'bullish OB uses top (proximal from above)');
  const [bear] = orderBlockLevels([ob({ type: 'BEARISH', top: 4015, bottom: 4010 })], { price: P, atr: ATR, pip: PIP });
  assert.equal(bear.price, 4010, 'bearish OB uses bottom (proximal from below)');
});

test('mitigated, invalidated and inactive blocks are dropped', () => {
  // A mitigated block has already been traded through: its orders are filled and there is
  // nothing left there to react to.
  for (const dead of [{ mitigated: true }, { invalidated: true }, { unmitigated: false }, { active: false }]) {
    assert.equal(orderBlockLevels([ob(dead)], { price: P, atr: ATR, pip: PIP }).length, 0, JSON.stringify(dead));
  }
  assert.equal(orderBlockLevels([ob()], { price: P, atr: ATR, pip: PIP }).length, 1, 'a live block survives');
});

test('a block on the wrong side of price is not a pullback target', () => {
  // Demand ABOVE price means price is already below it — the premise "price will come back down
  // to it" is false.
  assert.equal(orderBlockLevels([ob({ top: 4020, bottom: 4015 })], { price: P, atr: ATR, pip: PIP }).length, 0);
  assert.equal(orderBlockLevels([ob({ type: 'BEARISH', top: 3990, bottom: 3985 })], { price: P, atr: ATR, pip: PIP }).length, 0);
});

test('a block wider than 1.5 ATR is a region, not a level', () => {
  assert.equal(orderBlockLevels([ob({ top: 3990, bottom: 3970 })], { price: P, atr: ATR, pip: PIP }).length, 0);
  const tight = orderBlockLevels([ob({ top: 3990, bottom: 3987 })], { price: P, atr: ATR, pip: PIP });
  assert.equal(tight.length, 1);
  assert.ok(tight[0].strength >= 4, 'a tight block scores higher than a sprawling one');
});

test('order block levels carry the zone and the geometry the runner reads', () => {
  const [l] = orderBlockLevels([ob()], { price: P, atr: ATR, pip: PIP });
  assert.equal(l.side, 'below');
  assert.equal(l.distance, 10);
  assert.equal(l.distanceAtr, 1);
  assert.equal(l.distancePips, 100);
  assert.equal(l.obTop, 3990);
  assert.equal(l.obBottom, 3985);
  assert.equal(l.swept, false, 'an unmitigated block is unswept or the runner would skip it');
});

// ── zones ────────────────────────────────────────────────────────────────────

test('zones keep their touch count as strength and drop single touches', () => {
  const out = zoneLevels({
    support: [{ level: 3980, strength: 3 }, { level: 3970, strength: 1 }],
    resistance: [{ level: 4030, strength: 4 }],
  }, { price: P, atr: ATR, pip: PIP });
  assert.deepEqual(out.map((l) => l.price), [4030, 3980]);
  assert.equal(out[0].strength, 4);
  assert.equal(out[1].touches, 3);
  assert.ok(!out.some((l) => l.price === 3970), 'one touch is a candle, not a zone');
});

test('support above price is not support', () => {
  // The detector labels from history; price has since broken through, so the label lags.
  const out = zoneLevels({ support: [{ level: 4050, strength: 4 }], resistance: [{ level: 3950, strength: 4 }] },
    { price: P, atr: ATR, pip: PIP });
  assert.equal(out.length, 0);
});

// ── retests ──────────────────────────────────────────────────────────────────

/** Build a series with a pivot high at `lvl`, a break above it, and a controllable aftermath. */
const retestSeries = ({ lvl = 4000, after = 'hold' } = {}) => {
  const bars = [];
  const push = (o, h, l, c) => bars.push({ open: o, high: h, low: l, close: c });
  for (let i = 0; i < 12; i++) push(3960, 3965, 3955, 3962);      // base
  push(3990, lvl, 3985, 3995);                                     // the pivot high
  for (let i = 0; i < 8; i++) push(3970, 3975, 3965, 3972);        // pull back away
  push(3980, 4005, 3978, 4004);                                    // close through the level
  for (let i = 0; i < 8; i++) push(4020, 4030, 4015, 4025);        // run 2+ ATR beyond
  if (after === 'touched') push(4020, 4025, 3998, 4022);           // came back and tested it
  if (after === 'invalidated') push(4010, 4012, 3980, 3985);       // closed back below
  if (after === 'hold') for (let i = 0; i < 4; i++) push(4020, 4030, 4015, 4025);
  return bars;
};

test('a broken high that has not been retested becomes a support candidate', () => {
  const cs = retestSeries();
  const price = Number(cs[cs.length - 1].close);
  const out = retestLevels(cs, { price, atr: ATR, pip: PIP });
  const hit = out.find((l) => l.type === 'RETEST_SUPPORT');
  assert.ok(hit, `expected a flipped level, got ${JSON.stringify(out)}`);
  assert.equal(hit.price, 4000);
  assert.equal(hit.side, 'below');
  assert.ok(hit.breakReachAtr >= 2);
});

test('a level already retested is dropped, not down-weighted', () => {
  // Its retest is history; the strategies that trade retests have had their chance.
  const out = retestLevels(retestSeries({ after: 'touched' }), { price: 4022, atr: ATR, pip: PIP });
  assert.ok(!out.some((l) => l.price === 4000), 'already tested');
});

test('a close back through the level invalidates the flip', () => {
  const out = retestLevels(retestSeries({ after: 'invalidated' }), { price: 3985, atr: ATR, pip: PIP });
  assert.ok(!out.some((l) => l.price === 4000));
});

test('a wick through is not a break', () => {
  // Barely clearing the level then stalling never established the flip.
  const bars = [];
  for (let i = 0; i < 12; i++) bars.push({ open: 3960, high: 3965, low: 3955, close: 3962 });
  bars.push({ open: 3990, high: 4000, low: 3985, close: 3995 });
  for (let i = 0; i < 8; i++) bars.push({ open: 3970, high: 3975, low: 3965, close: 3972 });
  bars.push({ open: 3998, high: 4001, low: 3996, close: 4000.5 });   // scrapes past by 0.05 ATR
  for (let i = 0; i < 10; i++) bars.push({ open: 4000.5, high: 4001, low: 4000.2, close: 4000.6 });
  assert.equal(retestLevels(bars, { price: 4000.6, atr: ATR, pip: PIP }).length, 0);
});

test('too few candles yields nothing rather than guessing', () => {
  assert.deepEqual(retestLevels([{ open: 1, high: 2, low: 0, close: 1 }], { price: 1, atr: ATR }), []);
  assert.deepEqual(retestLevels(null, { price: 1, atr: ATR }), []);
});

// ── dedupe / confluence ──────────────────────────────────────────────────────

test('the same price from two sources collapses into one level carrying both', () => {
  // Forecasting it twice would double-count every arrival and inflate any hit-rate grouped by
  // level.
  const out = dedupeLevels([
    { type: 'PDH', price: 4020, side: 'above', strength: 3, distance: 20 },
    { type: 'ORDER_BLOCK', price: 4020.4, side: 'above', strength: 3, distance: 20.4 },
  ], { atr: ATR });
  assert.equal(out.length, 1);
  assert.equal(out[0].confluence, 2);
  assert.deepEqual(out[0].sources.sort(), ['ORDER_BLOCK', 'PDH']);
  assert.equal(out[0].strength, 4, 'confluence earns a point');
});

test('levels further apart than the tolerance stay separate', () => {
  const out = dedupeLevels([
    { type: 'PDH', price: 4020, side: 'above', strength: 3, distance: 20 },
    { type: 'ORDER_BLOCK', price: 4025, side: 'above', strength: 3, distance: 25 },
  ], { atr: ATR });
  assert.equal(out.length, 2);
});

test('levels on opposite sides never merge', () => {
  // A support at 4000.1 and a resistance at 3999.9 are not the same trade.
  const out = dedupeLevels([
    { type: 'SUPPORT_ZONE', price: 3999.9, side: 'below', strength: 3, distance: 0.1 },
    { type: 'RESISTANCE_ZONE', price: 4000.1, side: 'above', strength: 3, distance: 0.1 },
  ], { atr: ATR });
  assert.equal(out.length, 2);
});

test('the strongest member survives a cluster', () => {
  const out = dedupeLevels([
    { type: 'ZONE_WEAK', price: 4020, side: 'above', strength: 2, distance: 20 },
    { type: 'PDH', price: 4020.2, side: 'above', strength: 4, distance: 20.2 },
  ], { atr: ATR });
  assert.equal(out[0].type, 'PDH');
});

test('confluence cannot push strength past the scale', () => {
  const out = dedupeLevels([
    { type: 'PDH', price: 4020, side: 'above', strength: 5, distance: 20 },
    { type: 'ORDER_BLOCK', price: 4020.1, side: 'above', strength: 3, distance: 20.1 },
    { type: 'RESISTANCE_ZONE', price: 4020.2, side: 'above', strength: 3, distance: 20.2 },
  ], { atr: ATR });
  assert.equal(out[0].strength, 5);
  assert.equal(out[0].confluence, 3);
});

// ── quota ────────────────────────────────────────────────────────────────────

test('a dense source cannot starve the others', () => {
  // This is the regression the interleave exists to prevent: S/R zones are far denser than daily
  // liquidity, so a plain nearest-N cut would quietly stop forecasting PDH/PDL entirely.
  const zones = Array.from({ length: 30 }, (_, i) => ({ type: 'SUPPORT_ZONE', price: 3999 - i, distance: 1 + i }));
  const liq = [{ type: 'PDL', price: 3900, distance: 100 }, { type: 'ASIAN_LOW', price: 3890, distance: 110 }];
  const out = interleaveBySource([...zones, ...liq], { limit: 8 });
  assert.ok(out.some((l) => l.type === 'PDL'), 'liquidity must survive the cap');
  assert.ok(out.some((l) => l.type === 'ASIAN_LOW'));
  assert.equal(out.length, 8);
});

test('within a source the caller ordering is preserved', () => {
  const out = interleaveBySource([
    { type: 'PDH', price: 1, distance: 1 }, { type: 'PDL', price: 2, distance: 2 }, { type: 'ASIAN_HIGH', price: 3, distance: 3 },
  ], { limit: 10 });
  assert.deepEqual(out.map((l) => l.price), [1, 2, 3]);
});

test('quota never invents levels when a source is empty', () => {
  const out = interleaveBySource([{ type: 'PDH', price: 1, distance: 1 }], { limit: 20 });
  assert.equal(out.length, 1, 'the round-robin must terminate, not spin');
});

test('source groups map every level type', () => {
  assert.equal(sourceGroup('ORDER_BLOCK'), 'ORDER_BLOCK');
  assert.equal(sourceGroup('SUPPORT_ZONE'), 'ZONE');
  assert.equal(sourceGroup('RETEST_SUPPORT'), 'RETEST');
  assert.equal(sourceGroup('PDH'), 'LIQUIDITY');
  assert.equal(sourceGroup(null), 'LIQUIDITY');
});

// ── merge ────────────────────────────────────────────────────────────────────

test('the merged pool spans every source and reports what each contributed', () => {
  const out = mergeForecastLevels({
    keyLevels: [{ type: 'PDH', price: 4030, side: 'above', strength: 4, distance: 30 }],
    orderBlocks: [ob()],
    supportResistance: { support: [{ level: 3975, strength: 3 }], resistance: [{ level: 4040, strength: 3 }] },
    candles: retestSeries(),
    price: P, atr: ATR, pip: PIP, limit: 20,
  });
  const types = new Set(out.levels.map((l) => sourceGroup(l.type)));
  assert.ok(types.has('LIQUIDITY'), 'liquidity present');
  assert.ok(types.has('ORDER_BLOCK'), 'order blocks present');
  assert.ok(types.has('ZONE'), 'zones present');
  assert.equal(out.counts.raw.ORDER_BLOCK, 1);
  assert.ok(out.counts.kept.LIQUIDITY >= 1);
});

test('a broken merge degrades to the liquidity levels rather than throwing', () => {
  // Every extra source is optional; a detector returning junk must not take the scan down.
  const out = mergeForecastLevels({
    keyLevels: [{ type: 'PDH', price: 4030, side: 'above', strength: 4, distance: 30 }],
    orderBlocks: null, supportResistance: 'nonsense', candles: undefined,
    price: P, atr: ATR, pip: PIP,
  });
  assert.equal(out.levels.length, 1);
  assert.equal(out.levels[0].type, 'PDH');
});

test('the merge is deterministic', () => {
  const args = {
    keyLevels: [{ type: 'PDH', price: 4030, side: 'above', strength: 4, distance: 30 }],
    orderBlocks: [ob()],
    supportResistance: { support: [{ level: 3975, strength: 3 }] },
    candles: retestSeries(), price: P, atr: ATR, pip: PIP,
  };
  assert.deepEqual(mergeForecastLevels(args), mergeForecastLevels(args));
});
