import assert from 'node:assert/strict';
import test from 'node:test';
import {
  barMinutes, SCENARIOS, scenarioDirection, buildScenarioBars, barsAreValid,
  scenarioContext, distanceTo, etaBand, horizonBucket, HORIZON_BUCKETS,
} from './setupForecast.js';

const LAST = { time: '2026-07-30T12:00:00.000Z', open: 4020, high: 4025, low: 4018, close: 4022, volume: 500 };
const ATR = 4;                 // gold, ~$4 ATR on the timeframe under test
const PDL = 4011.4;            // level below price
const PDH = 4034.8;            // level above price

const build = (over = {}) => buildScenarioBars({
  level: PDL, side: 'below', scenario: 'SWEEP_REJECT', atr: ATR,
  lastCandle: LAST, timeframe: 'M15', ...over,
});

test('barMinutes parses M and H timeframes, rejects junk', () => {
  assert.equal(barMinutes('M15'), 15);
  assert.equal(barMinutes('m5'), 5);
  assert.equal(barMinutes('H4'), 240);
  assert.equal(barMinutes('D1'), 0);
  assert.equal(barMinutes(''), 0);
  assert.equal(barMinutes(null), 0);
});

test('scenarioDirection: a failed sweep turns away, acceptance continues', () => {
  // Sell-side liquidity below: running it and failing is a long.
  assert.equal(scenarioDirection('SWEEP_REJECT', 'below'), 'BUY');
  assert.equal(scenarioDirection('TOUCH_REJECT', 'below'), 'BUY');
  // Accepting through it is a short.
  assert.equal(scenarioDirection('BREAK_HOLD', 'below'), 'SELL');
  // Mirror image above.
  assert.equal(scenarioDirection('SWEEP_REJECT', 'above'), 'SELL');
  assert.equal(scenarioDirection('BREAK_HOLD', 'above'), 'BUY');
});

test('every scenario produces structurally valid candles on both sides', () => {
  for (const scenario of SCENARIOS) {
    for (const side of ['below', 'above']) {
      const bars = build({ scenario, side, level: side === 'below' ? PDL : PDH });
      assert.ok(bars, `${scenario}/${side} produced nothing`);
      assert.ok(barsAreValid(bars), `${scenario}/${side} produced an impossible candle`);
    }
  }
});

test('SWEEP_REJECT below: pierces the level then closes back above it', () => {
  const [sweep, follow] = build();
  assert.ok(sweep.low < PDL, 'the sweep bar must trade through the level');
  assert.ok(sweep.close > PDL, 'and must close back above it — otherwise it is a break');
  assert.ok(follow.close > sweep.close, 'the follow bar must displace upward');
});

test('SWEEP_REJECT above: pierces upward then closes back below', () => {
  const [sweep, follow] = build({ side: 'above', level: PDH });
  assert.ok(sweep.high > PDH);
  assert.ok(sweep.close < PDH);
  assert.ok(follow.close < sweep.close);
});

test('BREAK_HOLD below: closes through the level and does NOT reclaim it', () => {
  const [brk, hold] = build({ scenario: 'BREAK_HOLD' });
  assert.ok(brk.close < PDL, 'a break must close beyond the level');
  assert.ok(hold.close < PDL, 'and the next bar must hold beyond it, not reclaim');
  // This is the distinguishing property against SWEEP_REJECT.
  const [sweep] = build({ scenario: 'SWEEP_REJECT' });
  assert.ok(sweep.close > PDL && brk.close < PDL, 'sweep and break must differ at the close');
});

test('TOUCH_REJECT reaches the level exactly without trading through', () => {
  const [touch] = build({ scenario: 'TOUCH_REJECT' });
  assert.equal(touch.low, PDL, 'the low should sit on the level');
  const above = build({ scenario: 'TOUCH_REJECT', side: 'above', level: PDH });
  assert.equal(above[0].high, PDH);
});

// ── Detector-gate calibration ────────────────────────────────────────────────
//
// A synthetic bar is only worth evaluating if it is a legitimate example of the pattern. These
// thresholds are copied from the live detectors — detectLiquidityPinRejection (the strictest),
// liquiditySweepPro, the pinbar classifier and ict-breaker's reclaim. If one of them changes,
// these tests should fail so the geometry gets re-calibrated instead of quietly producing bars
// that every strategy refuses.
const PIN = { minRangeAtr: 0.6, maxBodyRatio: 0.4, minWickRatio: 0.45, minClosePosition: 0.6, minSweepAtr: 0.08 };
const LSP = { maxSweepAtr: 0.9, zoneMinWickRatio: 0.3, zoneMinClosePosition: 0.55, maxBodyRatio: 0.65 };
const RECLAIM_MIN_BODY_RATIO = 0.6;      // ict-breaker minBodyRatio

/** Measure a bar the way the detectors measure it, for a rejection in `dir`. */
function metrics(bar, level, dir, atr) {
  const { open: o, high: h, low: l, close: c } = bar;
  const range = h - l;
  const buy = dir === 'BUY';
  return {
    range, rangeAtr: range / atr,
    bodyRatio: Math.abs(c - o) / range,
    // wick measured from the BODY edge, not the close — matches liquidityEngine.js:361/378
    wickRatio: (buy ? Math.min(o, c) - l : h - Math.max(o, c)) / range,
    closePosition: (buy ? c - l : h - c) / range,
    pierceAtr: (buy ? level - l : h - level) / atr,
    closedWithRejection: buy ? c > o : c < o,
    closedBackInside: buy ? c > level : c < level,
    openedInside: buy ? o > level : o < level,
    // pinbar classifier, signalEngine.js:542
    lowerWick: buy ? Math.min(o, c) - l : h - Math.max(o, c),
    oppositeWick: buy ? h - Math.max(o, c) : Math.min(o, c) - l,
    body: Math.abs(c - o),
  };
}

test('the sweep bar closes WITH the rejection — the cl>o gate every detector applies', () => {
  // Regression: the first geometry closed the body the wrong way, so detectLiquidityPinRejection
  // (line 358 `cl > o`) and liquiditySweepPro (line 691) both rejected every sweep forecast.
  const buy = metrics(build()[0], PDL, 'BUY', ATR);
  assert.equal(buy.closedWithRejection, true, 'a bullish sweep must close above its open');
  const sell = metrics(build({ side: 'above', level: PDH })[0], PDH, 'SELL', ATR);
  assert.equal(sell.closedWithRejection, true, 'a bearish sweep must close below its open');
});

test('the sweep bar passes every detectLiquidityPinRejection gate on both sides', () => {
  for (const [side, level, dir] of [['below', PDL, 'BUY'], ['above', PDH, 'SELL']]) {
    const m = metrics(build({ side, level })[0], level, dir, ATR);
    assert.ok(m.openedInside, `${side}: must open on the original side of the level`);
    assert.ok(m.closedBackInside, `${side}: must close back inside`);
    assert.ok(m.rangeAtr >= PIN.minRangeAtr, `${side}: range ${m.rangeAtr.toFixed(3)} < ${PIN.minRangeAtr} ATR`);
    assert.ok(m.bodyRatio <= PIN.maxBodyRatio, `${side}: bodyRatio ${m.bodyRatio.toFixed(3)} > ${PIN.maxBodyRatio}`);
    assert.ok(m.wickRatio >= PIN.minWickRatio, `${side}: wickRatio ${m.wickRatio.toFixed(3)} < ${PIN.minWickRatio}`);
    assert.ok(m.closePosition >= PIN.minClosePosition, `${side}: closePosition ${m.closePosition.toFixed(3)} < ${PIN.minClosePosition}`);
    // Deep enough to be a real sweep, shallow enough not to be a break.
    assert.ok(m.pierceAtr >= PIN.minSweepAtr, `${side}: pierce ${m.pierceAtr.toFixed(3)} below the sweep floor`);
    assert.ok(m.pierceAtr <= LSP.maxSweepAtr, `${side}: pierce ${m.pierceAtr.toFixed(3)} exceeds maxSweepAtr`);
  }
});

test('the sweep bar also reads as a textbook pinbar', () => {
  for (const [side, level, dir] of [['below', PDL, 'BUY'], ['above', PDH, 'SELL']]) {
    const m = metrics(build({ side, level })[0], level, dir, ATR);
    assert.ok(m.bodyRatio <= 0.35, `${side}: bodyRatio ${m.bodyRatio.toFixed(3)} too fat for a pinbar`);
    assert.ok(m.lowerWick >= m.body * 2, `${side}: rejection wick must be at least twice the body`);
    assert.ok(m.oppositeWick <= Math.max(m.body, m.range * 0.15), `${side}: opposite wick too long`);
  }
});

test('the second bar displaces with conviction, satisfying the reclaim body gate', () => {
  for (const [side, level, dir] of [['below', PDL, 'BUY'], ['above', PDH, 'SELL']]) {
    const [b1, b2] = build({ side, level });
    const m = metrics(b2, level, dir, ATR);
    assert.ok(m.bodyRatio >= RECLAIM_MIN_BODY_RATIO,
      `${side}: reclaim bodyRatio ${m.bodyRatio.toFixed(3)} < ${RECLAIM_MIN_BODY_RATIO}`);
    assert.ok(m.closedWithRejection, `${side}: the displacement must continue the rejection`);
    const away = dir === 'BUY' ? b2.close > b1.close : b2.close < b1.close;
    assert.ok(away, `${side}: bar 2 must extend away from the level`);
  }
});

test('TOUCH_REJECT is a ZONE reject, not a sweep, and passes the zone gates', () => {
  for (const [side, level, dir] of [['below', PDL, 'BUY'], ['above', PDH, 'SELL']]) {
    const m = metrics(build({ scenario: 'TOUCH_REJECT', side, level })[0], level, dir, ATR);
    // No pierce at all: correctly disqualified from SWEEP_REJECT, which needs depth >= floor.
    assert.equal(m.pierceAtr, 0, `${side}: a touch must not trade through the level`);
    assert.ok(m.wickRatio >= LSP.zoneMinWickRatio, `${side}: wickRatio ${m.wickRatio.toFixed(3)} < zone minimum`);
    assert.ok(m.closePosition >= LSP.zoneMinClosePosition, `${side}: closePosition below zone minimum`);
    assert.ok(m.bodyRatio <= LSP.maxBodyRatio, `${side}: bodyRatio ${m.bodyRatio.toFixed(3)} > ${LSP.maxBodyRatio}`);
    assert.ok(m.closedWithRejection && m.closedBackInside);
  }
});

test('BREAK_HOLD is decisive, not a limp poke', () => {
  for (const [side, level] of [['below', PDL], ['above', PDH]]) {
    const [b1, b2] = build({ scenario: 'BREAK_HOLD', side, level });
    const range = b1.high - b1.low;
    const bodyRatio = Math.abs(b1.close - b1.open) / range;
    // breakoutEngine.js rejects limp bodies; acceptance has to look like acceptance.
    assert.ok(bodyRatio >= RECLAIM_MIN_BODY_RATIO, `${side}: break bodyRatio ${bodyRatio.toFixed(3)} too weak`);
    assert.ok(range / ATR >= PIN.minRangeAtr, `${side}: break range too small`);
    const beyond = side === 'below' ? (v) => v < level : (v) => v > level;
    assert.ok(beyond(b1.close) && beyond(b2.close), `${side}: both bars must stay beyond the level`);
  }
});

test('both sides are exact mirrors, so tuning cannot drift them apart', () => {
  for (const scenario of SCENARIOS) {
    const lo = build({ scenario, side: 'below', level: PDL });
    const up = build({ scenario, side: 'above', level: PDH });
    lo.forEach((b, i) => {
      const u = up[i];
      // Distance of each OHLC point from its own level should match to the rounding epsilon.
      const dLo = [PDL - b.low, PDL - b.high, PDL - b.open, PDL - b.close];
      const dUp = [u.high - PDH, u.low - PDH, u.open - PDH, u.close - PDH];
      dLo.forEach((d, k) => assert.ok(Math.abs(d - dUp[k]) < 1e-4,
        `${scenario} bar${i + 1} point ${k}: ${d} vs mirrored ${dUp[k]}`));
    });
  }
});

test('geometry holds across volatility regimes and instruments', () => {
  // The ratios are ATR-relative, so they must survive a 0.0008-ATR forex pair and a 30-ATR index.
  for (const [atr, level] of [[0.0008, 1.0842], [0.4, 148.55], [8.98, 3995.83], [30, 18500]]) {
    for (const [side, dir] of [['below', 'BUY'], ['above', 'SELL']]) {
      const bars = build({ atr, level, side });
      assert.ok(barsAreValid(bars), `atr ${atr} ${side}: invalid candles`);
      const m = metrics(bars[0], level, dir, atr);
      assert.ok(m.rangeAtr >= PIN.minRangeAtr, `atr ${atr} ${side}: range gate`);
      assert.ok(m.bodyRatio <= PIN.maxBodyRatio, `atr ${atr} ${side}: body gate`);
      assert.ok(m.wickRatio >= PIN.minWickRatio, `atr ${atr} ${side}: wick gate`);
      assert.ok(m.closePosition >= PIN.minClosePosition, `atr ${atr} ${side}: close gate`);
      assert.ok(m.closedWithRejection, `atr ${atr} ${side}: rejection close`);
    }
  }
});

test('sweep depth and reaction size scale with ATR, not fixed pips', () => {
  const calm = build({ atr: 1 });
  const wild = build({ atr: 10 });
  const calmDepth = PDL - calm[0].low;
  const wildDepth = PDL - wild[0].low;
  assert.ok(wildDepth > calmDepth * 5, 'a volatile market must get a proportionally deeper sweep');
});

test('bars continue the real series at the timeframe interval', () => {
  const bars = build({ timeframe: 'H1' });
  assert.equal(bars[0].time, '2026-07-30T13:00:00.000Z');
  assert.equal(bars[1].time, '2026-07-30T14:00:00.000Z');
  const m5 = build({ timeframe: 'M5' });
  assert.equal(m5[0].time, '2026-07-30T12:05:00.000Z');
});

test('bars are flagged synthetic so nothing downstream mistakes them for real data', () => {
  for (const b of build()) assert.equal(b.synthetic, true);
});

test('builder refuses to invent bars from unusable inputs', () => {
  assert.equal(build({ atr: 0 }), null);
  assert.equal(build({ atr: NaN }), null);
  assert.equal(build({ level: NaN }), null);
  assert.equal(build({ timeframe: 'D1' }), null);
  assert.equal(build({ lastCandle: null }), null);
  assert.equal(build({ lastCandle: { ...LAST, time: 'not-a-date' } }), null);
  assert.equal(build({ scenario: 'MOON' }), null);
});

test('barsAreValid rejects impossible candles', () => {
  assert.equal(barsAreValid([]), false);
  assert.equal(barsAreValid(null), false);
  assert.equal(barsAreValid([{ open: 1, high: 2, low: 3, close: 1 }]), false);   // low above high
  assert.equal(barsAreValid([{ open: 5, high: 2, low: 1, close: 1 }]), false);   // open above high
  assert.equal(barsAreValid([{ open: 1, high: 2, low: 1, close: 9 }]), false);   // close above high
  assert.equal(barsAreValid([{ open: 1, high: 2, low: 1, close: NaN }]), false);
  assert.equal(barsAreValid([{ open: 1, high: 2, low: 1, close: 1.5 }]), true);
});

test('scenarioContext appends to real candles and preserves HTF context', () => {
  const base = { candles: [LAST], htfTrend: 'UP', dailyBars: [{ x: 1 }], symbol: 'XAUUSD' };
  const bars = build();
  const ctx = scenarioContext(base, bars);
  assert.equal(ctx.candles.length, 3);
  assert.deepEqual(ctx.candles[0], LAST, 'real history must survive untouched');
  assert.equal(ctx.candles.at(-1).synthetic, true);
  // HTF state is real market data and must pass through unmodified.
  assert.equal(ctx.htfTrend, 'UP');
  assert.deepEqual(ctx.dailyBars, base.dailyBars);
  assert.equal(ctx.scenarioBars, 2);
  // And the caller's array is never mutated.
  assert.equal(base.candles.length, 1);
});

test('scenarioContext refuses bad input rather than producing a misleading context', () => {
  assert.equal(scenarioContext(null, build()), null);
  assert.equal(scenarioContext({ candles: 'nope' }, build()), null);
  assert.equal(scenarioContext({ candles: [LAST] }, [{ open: 1, high: 1, low: 5, close: 1 }]), null);
});

test('distanceTo reports absolute distance in price, pips and ATR', () => {
  const d = distanceTo({ price: 4022, level: PDL, atr: ATR, pip: 0.1 });
  assert.equal(d.price, 10.6);
  assert.equal(d.pips, 106);
  assert.equal(d.atr, 2.65);
  // Direction-agnostic: above and below the same distance read the same.
  assert.equal(distanceTo({ price: 4000, level: 4010, atr: ATR }).price, 10);
  assert.equal(distanceTo({ price: 4020, level: 4010, atr: ATR }).price, 10);
  // Missing pip size degrades to null rather than a wrong number.
  assert.equal(distanceTo({ price: 4022, level: PDL, atr: ATR }).pips, null);
  assert.equal(distanceTo({ price: NaN, level: PDL }), null);
});

test('etaBand brackets the estimate instead of pretending to a single number', () => {
  const eta = etaBand({ distanceAtr: 2, timeframe: 'M15', atrPerBar: 0.5 });
  assert.equal(eta.midMinutes, 60);          // 2 ATR / 0.5 per bar = 4 bars = 60m
  assert.equal(eta.minMinutes, 30);
  assert.equal(eta.maxMinutes, 120);
  assert.ok(eta.minMinutes < eta.midMinutes && eta.midMinutes < eta.maxMinutes);
  // Already there.
  assert.deepEqual(etaBand({ distanceAtr: 0, timeframe: 'M15' }), { minMinutes: 0, midMinutes: 0, maxMinutes: 0 });
  assert.equal(etaBand({ distanceAtr: 2, timeframe: 'D1' }), null);
  assert.equal(etaBand({ distanceAtr: NaN, timeframe: 'M15' }), null);
});

test('horizon buckets cover the full range with no gaps', () => {
  assert.equal(horizonBucket(5).label, '≤30m');
  assert.equal(horizonBucket(30).label, '≤30m');
  assert.equal(horizonBucket(31).label, '≤1h');
  assert.equal(horizonBucket(60).label, '≤1h');
  assert.equal(horizonBucket(90).label, '1–3h');
  assert.equal(horizonBucket(180).label, '1–3h');
  assert.equal(horizonBucket(240).label, '3–6h');
  assert.equal(horizonBucket(600).label, '6–12h');
  assert.equal(horizonBucket(720).label, '6–12h');
  assert.equal(horizonBucket(721).label, '12h+');
  assert.equal(horizonBucket(99999).label, '12h+');
  assert.equal(horizonBucket(NaN), null);
  assert.equal(HORIZON_BUCKETS.length, 6);
});
