// Regression suite for the liquidity-stack audit (2026-07-13): self-sweeping levels,
// sweep polarity, HTF precedence, displacement chronology, breaker lifecycle,
// plan geometry, and order-block dedup. Each test encodes a PRODUCTION failure mode.
// Run: node backend/liquidityRegression.test.mjs
import { detectKeyLiquidityLevels, gradeSweep, detectDisplacement, detectBreaker, buildLiquidityPlan } from './liquidityEngine.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.error(`FAIL  ${name}: ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const bar = (t0, i, o, h, l, c, tfMin = 15) => ({ time: new Date(t0 + i * tfMin * 60000).toISOString(), open: o, high: h, low: l, close: c, tick_volume: 100 });
const T0 = Date.UTC(2026, 6, 13, 0, 0, 0); // Monday 00:00 UTC

// Gentle drift with one clear swing high at bar 60 (1.10500), never revisited.
function swingHighTape() {
  const rows = [];
  for (let i = 0; i < 120; i++) {
    let base = 1.1 + Math.sin(i / 9) * 0.001;
    let hi = base + 0.0004, lo = base - 0.0004;
    if (i === 60) hi = 1.10370;                       // the swing high (isolated, off the round grid)
    rows.push(bar(T0, i, base, hi, lo, base + 0.0001));
  }
  return rows;
}

test('REGRESSION: a swing level never sweeps ITSELF (formation candle is not evidence)', () => {
  const { levels } = detectKeyLiquidityLevels(swingHighTape(), { symbol: 'EURUSDM' });
  const swings = levels.filter((l) => Math.abs(l.price - 1.1037) < 0.0004);
  assert(swings.length > 0, 'expected the 1.1037 swing level to be detected');
  assert(swings.every((l) => l.fresh), `swing must be FRESH (never revisited), got swept=${swings.map((l) => l.swept)}`);
});

test('REGRESSION: PDH is FRESH until TODAY pierces it (yesterday made it, cannot sweep it)', () => {
  // Yesterday's high = 1.2000; today trades below it the whole session.
  const d1 = [
    { time: new Date(Date.UTC(2026, 6, 9)).toISOString(), open: 1.19, high: 1.1950, low: 1.185, close: 1.19 },
    { time: new Date(Date.UTC(2026, 6, 10)).toISOString(), open: 1.19, high: 1.2000, low: 1.188, close: 1.195 }, // prev completed day
    { time: new Date(Date.UTC(2026, 6, 13)).toISOString(), open: 1.195, high: 1.197, low: 1.192, close: 1.196 }, // today (forming)
  ];
  const rows = [];
  // Intraday spans yesterday (touches 1.2000) + today (stays below).
  const y0 = Date.UTC(2026, 6, 10, 12, 0, 0);
  for (let i = 0; i < 40; i++) rows.push(bar(y0, i, 1.196, i === 20 ? 1.2000 : 1.1975, 1.194, 1.196));
  const t0 = Date.UTC(2026, 6, 13, 0, 0, 0);
  for (let i = 0; i < 60; i++) rows.push(bar(t0, i, 1.195, 1.1965, 1.193, 1.1955));
  const { levels } = detectKeyLiquidityLevels(rows, { symbol: 'EURUSDM', dailyCandles: d1 });
  const pdh = levels.find((l) => l.type === 'PDH');
  assert(pdh, 'PDH must be present with dailyCandles');
  assert(pdh.fresh, 'PDH must be FRESH — only yesterday touched it, today never did');
});

test('REGRESSION: displacement formed BEFORE the reclaim does not confirm it (chronology)', () => {
  // FVG completes at bar 30; reclaim is at bar 40. Old code (reclaimIdx-1 window) could
  // never see this one anyway, so ALSO check: at reclaimIdx the pre-formed gap of the
  // OLD off-by-one window is rejected. We assert the window start: i >= reclaimIdx.
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push(bar(T0, i, 1.1, 1.1006, 1.0994, 1.1));
  // gap at bars 28-30 (c3 high 1.1006 < c low): make bar 30 low far above bar 28 high
  rows[29] = bar(T0, 29, 1.1, 1.1030, 1.0999, 1.1029);   // impulse
  rows[30] = bar(T0, 30, 1.1029, 1.1040, 1.1012, 1.1035); // gap: low 1.1012 > bar28 high 1.1006
  // Bars after the gap hold ABOVE it (still-open) — otherwise the fill check voids it.
  for (let i = 31; i < 60; i++) rows[i] = bar(T0, i, 1.1035, 1.1045, 1.1015, 1.1038);
  const atr = 0.0012;
  const atReclaim40 = detectDisplacement(rows, 40, 'BULLISH', atr, { minAtr: 0.5 });
  assert(!atReclaim40.present, 'a gap 10 bars before the reclaim must not confirm it');
  const atReclaim31 = detectDisplacement(rows, 30, 'BULLISH', atr, { minAtr: 0.5 });
  assert(atReclaim31.present, 'the gap completing AT the reclaim bar must still count');

  const exactFill = rows.map((c) => ({ ...c }));
  exactFill[31].low = 1.1006; // exactly the far edge of the completed bullish FVG
  assert(!detectDisplacement(exactFill, 30, 'BULLISH', atr, { minAtr: 0.5 }).present, 'an exact full fill must retire bullish displacement');

  const mirror = exactFill.map((c) => ({ ...c, open: 2.2 - c.open, high: 2.2 - c.low, low: 2.2 - c.high, close: 2.2 - c.close }));
  assert(!detectDisplacement(mirror, 30, 'BEARISH', atr, { minAtr: 0.5 }).present, 'an exact full fill must retire bearish displacement');
});

test('REGRESSION: plan builder rejects directionally-invalid stops and skips too-close pools', () => {
  const pools = {
    buySide: [
      { price: 1.1010, swept: false, type: 'BSL', equal: false }, // barely above entry → poor RR, skip
      { price: 1.1060, swept: false, type: 'BSL', equal: true },  // the real target
    ],
    sellSide: [],
    targetAbove: { price: 1.1010, swept: false, type: 'BSL', equal: false },
    targetBelow: null,
  };
  const badStop = buildLiquidityPlan({ type: 'BULLISH', entry: 1.1000, stop: 1.1005 }, pools);
  assert(badStop === null, 'stop above a BULLISH entry must be rejected');
  const plan = buildLiquidityPlan({ type: 'BULLISH', entry: 1.1000, stop: 1.0980 }, pools, { minRR: 1.0 });
  assert(plan && plan.target === 1.106, `must skip the 0.5R pool and take the next (got ${plan && plan.target})`);
});

function breakerTape() {
  const rows = [];
  const add = (o, h, l, c) => rows.push(bar(T0, rows.length, o, h, l, c, 15));
  add(105, 107, 104, 106);
  add(106, 108, 105, 107);
  add(107, 120, 106, 108); // old, determinable opposing target
  add(108, 108, 104, 105);
  add(104, 106, 103, 105);
  add(106, 108, 105, 107);
  add(107, 109, 106, 108); // prior structure high
  add(108, 108, 104, 105);
  add(105, 106, 101, 102);
  add(102, 103, 100, 101); // old source low
  add(101, 104, 101, 103);
  add(103, 106, 102, 105);
  add(105, 107, 103, 106);
  for (let i = 0; i < 45; i++) add(105, 107, 103, 105); // source becomes old; no new strict fractal
  add(106, 107, 98, 99);   // sweep, breaker zone body 99-106
  add(99, 102, 98.5, 101);
  add(101, 112, 100, 110); // recent reclaim above 109
  add(110, 114, 109, 113);
  return rows;
}

function mirrorTape(rows, pivot = 110) {
  return rows.map((c) => ({ ...c, open: 2 * pivot - c.open, high: 2 * pivot - c.low, low: 2 * pivot - c.high, close: 2 * pivot - c.close }));
}

test('REGRESSION: breaker age is from reclaim, not old source, mirrored', () => {
  const bull = detectBreaker(breakerTape(), { maxAgeBars: 3 });
  const bear = detectBreaker(mirrorTape(breakerTape()), { maxAgeBars: 3 });
  assert(bull?.type === 'BULLISH' && bull.ageBars === 1, 'old bullish source with recent reclaim must remain eligible');
  assert(bear?.type === 'BEARISH' && bear.ageBars === 1, 'old bearish source with recent reclaim must remain eligible');
});

test('REGRESSION: stop touch and breaker-zone mitigation invalidate, mirrored', () => {
  const base = breakerTape();
  assert(detectBreaker(base)?.type === 'BULLISH', 'bull control must be alive');
  assert(detectBreaker(mirrorTape(base))?.type === 'BEARISH', 'bear control must be alive');

  const stopTouch = base.concat([bar(T0, base.length, 113, 114, 98, 112)]);
  const mitigation = base.concat([bar(T0, base.length, 113, 115, 106, 114)]);
  assert(detectBreaker(stopTouch) === null, 'exact bullish stop touch must invalidate');
  assert(detectBreaker(mirrorTape(stopTouch)) === null, 'exact bearish stop touch must invalidate');
  assert(detectBreaker(mitigation) === null, 'bullish breaker-zone touch must consume the setup');
  assert(detectBreaker(mirrorTape(mitigation)) === null, 'bearish breaker-zone touch must consume the setup');
});

test('REGRESSION: determinable target completion invalidates breaker, mirrored', () => {
  const base = breakerTape();
  const bull = detectBreaker(base);
  const bear = detectBreaker(mirrorTape(base));
  assert(bull?.target === 120 && bear?.target === 100, 'controls must expose mirrored determinable targets');
  const completed = base.concat([bar(T0, base.length, 113, 120, 109, 119)]);
  assert(detectBreaker(completed) === null, 'bull target touch completes breaker');
  assert(detectBreaker(mirrorTape(completed)) === null, 'bear target touch completes breaker');
});

test('REGRESSION: opposite confirmed structure shift invalidates breaker, mirrored', () => {
  const rows = breakerTape();
  const add = (o, h, l, c) => rows.push(bar(T0, rows.length, o, h, l, c));
  add(113, 116, 110, 114);
  add(114, 116, 111, 113);
  add(113, 114, 108, 110); // post-reclaim swing low
  add(110, 115, 109, 113);
  add(113, 116, 110, 114); // confirms the swing
  add(114, 115, 107, 107.5); // close below 108, still above breaker zone
  assert(detectBreaker(rows) === null, 'bearish shift must invalidate bullish breaker');
  assert(detectBreaker(mirrorTape(rows)) === null, 'bullish shift must invalidate bearish breaker');
});

test('REGRESSION: plan validates type/raw RR, uses full candidates, and never invents a target, mirrored', () => {
  const bullPools = {
    buySide: [{ price: 100.995, swept: false, type: 'BSL' }],
    sellSide: [],
    targetCandidatesAbove: [
      { price: 100.995, swept: false, type: 'BSL', equal: false }, // raw 0.995R must not round up to pass
      { price: 102, swept: false, type: 'BSL', equal: true },
    ],
  };
  const bearPools = {
    buySide: [],
    sellSide: [{ price: 99.005, swept: false, type: 'SSL' }],
    targetCandidatesBelow: [
      { price: 99.005, swept: false, type: 'SSL', equal: false },
      { price: 98, swept: false, type: 'SSL', equal: true },
    ],
  };
  assert(buildLiquidityPlan({ type: 'SIDEWAYS', entry: 100, stop: 99 }, bullPools) === null, 'unknown breaker type rejected');
  assert(buildLiquidityPlan({ type: 'BULLISH', entry: 100, stop: 99 }, { ...bullPools, targetCandidatesAbove: bullPools.targetCandidatesAbove.slice(0, 1) }, { minRR: 1 }) === null, 'rounded-up 0.995R rejected');
  assert(buildLiquidityPlan({ type: 'BEARISH', entry: 100, stop: 101 }, { ...bearPools, targetCandidatesBelow: bearPools.targetCandidatesBelow.slice(0, 1) }, { minRR: 1 }) === null, 'mirrored rounded-up 0.995R rejected');
  assert(buildLiquidityPlan({ type: 'BULLISH', entry: 100, stop: 99 }, bullPools, { minRR: 1 })?.target === 102, 'full bullish candidates searched beyond capped display');
  assert(buildLiquidityPlan({ type: 'BEARISH', entry: 100, stop: 101 }, bearPools, { minRR: 1 })?.target === 98, 'full bearish candidates searched beyond capped display');
  assert(buildLiquidityPlan({ type: 'BULLISH', entry: 100, stop: 99 }, { buySide: [], sellSide: [] }) === null, 'no real BSL means no fantasy target');
  assert(buildLiquidityPlan({ type: 'BEARISH', entry: 100, stop: 101 }, { buySide: [], sellSide: [] }) === null, 'no real SSL means no fantasy target');
});

console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
