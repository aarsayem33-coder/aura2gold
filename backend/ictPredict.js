// ICT predictions — projected sweep → breaker setups for `ict-breaker` and `ict-break-pro` only.
//
// WHY THIS EXISTS SEPARATELY FROM setupForecastRunner.js
// -----------------------------------------------------
// The generic setup forecaster deliberately reports ict-breaker as UNDETERMINABLE. Its
// scenario is "price arrives at a level and rejects", built as two canonical bars, and a
// breaker needs more than that: a sweep of a specific swing, then a close back through the
// *prior* swing on the other side, with a displacement FVG confirming it. Inventing extra
// bars inside that generic runner until ict-breaker happened to fire would have turned a
// prediction into an authored signal, so it was correctly refused.
//
// This module asks the narrower question that CAN be answered honestly:
//
//     There is an unswept swing low at L, and the swing high that preceded it sits at H.
//     IF price trades down to L, takes it, and closes back above H with displacement —
//     the literal ICT breaker sequence — what does ict-breaker say, by its own rules?
//
// Everything structural is REAL and read out of the live candles:
//   * L  — a confirmed fractal swing (the resting liquidity), not yet swept, not yet reached
//   * H  — the opposing swing that detectBreaker itself would require the reclaim to close through
//   * the target — the opposing unswept liquidity pool that buildLiquidityPlan picks
//   * the stop — the projected sweep extreme
//
// Only the PATH between them is synthetic, and it is built from L, H and ATR alone with fixed,
// deliberately unexceptional geometry (a 1.0x ATR displacement, not a flattering 2x). The bars
// are returned with every prediction so the assumption is inspectable rather than hidden.
//
// Nothing here reimplements a trading rule. ictBreaker/ictBreakPro are called through an
// injected `evaluate`, and whatever they return is what gets reported.

const n = (v) => Number(v);
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(n(v)) ? null : n(v));
const r5 = (v) => Math.round(n(v) * 1e5) / 1e5;
const r2 = (v) => Math.round(n(v) * 100) / 100;

/** The only two strategies this page predicts for. Order matters: PRO is the selective overlay. */
export const ICT_STRATEGIES = ['ict-breaker', 'ict-break-pro'];

export const ICT_SETUPS = {
  BULLISH_BREAKER: 'BULLISH_BREAKER',
  BEARISH_BREAKER: 'BEARISH_BREAKER',
};

export const ICT_DEFAULTS = {
  minDistanceAtr: 0.15,   // closer than this and it is a live signal, not a prediction
  maxDistanceAtr: 6,      // further and the arrival is speculation, not a forecast
  maxCandidates: 12,      // cost is candidates x strategies x bar-building
  minReclaimAtr: 0.6,     // structure any closer than this is not a breaker, it is noise
  maxWalkBars: 6,         // bars allowed to carry price from the sweep up to the reclaim
  minStopAtr: 0.2,        // a projected stop tighter than this is inside the noise
  stopBufferAtr: 0.15,    // extra room beyond the projected sweep extreme for the resting order
};

// Bar geometry in fractions of ATR. NOT free parameters — each is set by a gate in the real
// detectors, read out of the code rather than guessed:
//
//   detectBreaker      the sweep bar must trade BELOW the swing low and the reclaim bar must
//                      CLOSE above the prior swing high (mirrored for bearish)
//   detectDisplacement needs a 3-bar FVG completing AT the reclaim: reclaim.low > pre.high, the
//                      middle bar bullish, and |middle body| >= 0.8x ATR to count as present
//   ictBreakPro        reads the LAST bar: body >= 60% of range, range >= 1.0x ATR, breaker age
//                      <= 1 bar
//
// `displace` is 1.0 on purpose. Displacement strength feeds ictBreaker's score at 10 points per
// ATR multiple, so choosing 2.0 here would have manufactured +10 free score on every prediction.
// One ATR is an ordinary, honest displacement bar.
export const ICT_GEOMETRY = {
  sweep: { openOff: 0.10, pierce: 0.35, close: 0.40, wick: 0.05 },
  walk: { maxBody: 0.90, wick: 0.05 },
  displace: { body: 1.00, wick: 0.04 },
  reclaim: { body: 1.05, overshoot: 0.05, tail: 0.03, wick: 0.04 },
};

/** Bar interval in minutes for a timeframe label. 0 = unknown. */
export function ictBarMinutes(tf) {
  const m = /^([MH])(\d+)$/.exec(String(tf || '').toUpperCase());
  if (!m) return String(tf || '').toUpperCase() === 'D1' ? 1440 : 0;
  return m[1] === 'H' ? Number(m[2]) * 60 : Number(m[2]);
}

/**
 * Candidate breaker projections from the live structure.
 *
 * A candidate is a confirmed fractal swing that is (a) still unswept by real price, (b) on the
 * far side of the market so price has not reached it yet, and (c) has an opposing swing before
 * it for the reclaim to close through — which is exactly the pair detectBreaker looks for.
 *
 * Refusing already-swept levels is not tidiness: detectBreaker scans for the FIRST sweep after
 * the swing, so a level real price already took would put the breaker in the past. Predicting
 * one would be reporting history as a forecast.
 */
export function ictCandidates(candles, { swings, price, atr, options = {} } = {}) {
  const o = { ...ICT_DEFAULTS, ...options };
  const p = num(price);
  const a = num(atr);
  if (!Array.isArray(candles) || candles.length < 60 || p === null || !(a > 0)) return [];
  const { highs = [], lows = [] } = swings || {};
  const lastIdx = candles.length - 1;

  const out = [];

  // BULLISH: an unswept swing LOW below price. Sweep it, reclaim the swing high that preceded it.
  for (const low of lows) {
    if (!(n(low.price) < p)) continue;                                  // price has already gone under it
    const priorHigh = [...highs].reverse().find((h) => h.i < low.i);
    if (!priorHigh) continue;                                           // no structure to reclaim
    let swept = false;
    for (let j = low.i + 1; j <= lastIdx; j++) {
      if (n(candles[j].low) < n(low.price)) { swept = true; break; }
    }
    if (swept) continue;
    out.push({
      setup: ICT_SETUPS.BULLISH_BREAKER,
      direction: 'BUY',
      side: 'below',
      level: r5(low.price),
      levelIso: low.time || null,
      levelIndex: low.i,
      structureLevel: r5(priorHigh.price),
      structureIso: priorHigh.time || null,
      barsSinceLevel: lastIdx - low.i,
    });
  }

  // BEARISH: an unswept swing HIGH above price. Mirror image.
  for (const high of highs) {
    if (!(n(high.price) > p)) continue;
    const priorLow = [...lows].reverse().find((l) => l.i < high.i);
    if (!priorLow) continue;
    let swept = false;
    for (let j = high.i + 1; j <= lastIdx; j++) {
      if (n(candles[j].high) > n(high.price)) { swept = true; break; }
    }
    if (swept) continue;
    out.push({
      setup: ICT_SETUPS.BEARISH_BREAKER,
      direction: 'SELL',
      side: 'above',
      level: r5(high.price),
      levelIso: high.time || null,
      levelIndex: high.i,
      structureLevel: r5(priorLow.price),
      structureIso: priorLow.time || null,
      barsSinceLevel: lastIdx - high.i,
    });
  }

  // Distance band, nearest first. Both ends matter: a level price is already sitting on is a
  // live signal the scanner owns, and one six ATR away is a guess with a forecast's clothes on.
  return out
    .map((c) => ({ ...c, distanceAtr: r2(Math.abs(c.level - p) / a) }))
    .filter((c) => c.distanceAtr >= o.minDistanceAtr && c.distanceAtr <= o.maxDistanceAtr)
    .sort((x, y) => x.distanceAtr - y.distanceAtr)
    .slice(0, o.maxCandidates);
}

/**
 * The synthetic path from "price is here" to "the breaker has confirmed".
 *
 * Bars, in order:
 *   A          sweep — trades through the level, closes back on the reaction side
 *   W x k      walk  — optional continuation carrying price toward the structure level, so a
 *                      distant reclaim is not crammed into one implausible candle
 *   B          displacement — the strong-bodied bar detectDisplacement measures (>= 0.8x ATR)
 *   C          reclaim — closes THROUGH the structure level; also the bar ictBreakPro inspects
 *
 * Returns `{ bars }` or `{ reason }`. A refusal is a real answer and is shown on the page: a
 * swing high sitting eight ATR above the low is not a breaker anyone would trade, it is two
 * separate moves, and saying so is more useful than silently dropping the level.
 *
 * The travel budget is solved arithmetically rather than stepped in fixed increments. The first
 * draft walked 0.9 ATR per bar and then discovered the displacement bar had between 0.1 and 1.0
 * ATR of room left depending on where the rounding landed — below the 0.8 ATR floor most of the
 * time, which silently threw away about two thirds of all candidates. The walk is now divided
 * evenly into whatever is left after the displacement and reclaim bars take their fixed share,
 * so those two always get exactly the size the detectors require.
 */
export function buildIctSequence({
  level, structureLevel, side, atr, lastCandle, timeframe, geo = ICT_GEOMETRY, options = {},
}) {
  const o = { ...ICT_DEFAULTS, ...options };
  const L = num(level);
  const H = num(structureLevel);
  const a = num(atr);
  const mins = ictBarMinutes(timeframe);
  const refuse = (reason) => ({ bars: null, reason });
  if (L === null || H === null || !(a > 0) || !(mins > 0) || !lastCandle) return refuse('missing level, structure, ATR or timeframe');
  if (side !== 'below' && side !== 'above') return refuse('the level is not on a recognised side of price');

  const lastMs = Date.parse(lastCandle.time);
  if (!Number.isFinite(lastMs)) return refuse('the last real candle has no usable timestamp');

  const below = side === 'below';
  // `s` mirrors the entire construction: +1 builds the bullish case off a level below price,
  // -1 reflects it. One shape, reflected, is what stops the two sides drifting apart.
  const s = below ? 1 : -1;
  const vol = n(lastCandle.volume) || 0;
  let i = 0;
  const bar = (open, close, ahead, behind) => {
    // `ahead` extends in the reaction direction, `behind` against it. Reflection turns those
    // into high/low correctly for either side without a second hand-written branch.
    const hi = below ? ahead : behind;
    const lo = below ? behind : ahead;
    i += 1;
    return {
      time: new Date(lastMs + i * mins * 60000).toISOString(),
      open: r5(open), high: r5(Math.max(hi, open, close)), low: r5(Math.min(lo, open, close)),
      close: r5(close), volume: vol, synthetic: true,
    };
  };
  // Signed helpers: `fwd` moves in the reaction direction, `past` moves through the level.
  const fwd = (from, f) => from + s * a * f;
  const past = (from, f) => from - s * a * f;

  const g = geo;
  // A — the bar that takes the liquidity and closes back across the level.
  const aOpen = fwd(L, g.sweep.openOff);
  const aClose = fwd(L, g.sweep.close);
  const sweepExtreme = past(L, g.sweep.pierce);
  const bars = [bar(aOpen, aClose, fwd(aClose, g.sweep.wick), sweepExtreme)];

  // How far the reclaim still has to travel, and how many bars it honestly needs.
  const target = fwd(H, g.reclaim.overshoot);          // close must clear H, not merely touch it
  const remaining = (target - aClose) * s;             // signed into "distance in the reaction direction"
  if (!(remaining > 0)) {
    return refuse('the structure level sits behind the sweep — reclaiming it would need no move at all');
  }
  const needAtr = remaining / a;
  if (needAtr < o.minReclaimAtr) {
    return refuse(`the structure level is only ${r2(needAtr)}x ATR from the sweep — too tight to be a breaker`);
  }

  // Budget: the displacement and reclaim bars take a FIXED share (the sizes the detectors
  // demand); walk bars carry whatever is left, divided evenly so none of them exceeds a
  // plausible single-bar move.
  const fixed = g.displace.body + g.reclaim.body;
  const walkTotal = needAtr - fixed;
  const walks = walkTotal > 0 ? Math.ceil(walkTotal / g.walk.maxBody) : 0;
  if (walks > o.maxWalkBars) {
    return refuse(`the reclaim is ${r2(needAtr)}x ATR away — beyond what one breaker sequence can plausibly cover`);
  }
  const perWalk = walks > 0 ? walkTotal / walks : 0;

  // When the structure sits closer than the two fixed bars need, the reclaim simply closes
  // further past it. That overshoot is real (a strong displacement does blow through) but it is
  // reported, because it is the one place the projection claims more travel than the setup needs.
  const overshootAtr = walks > 0 ? 0 : r2(Math.max(0, fixed - needAtr));

  let cursor = aClose;
  for (let w = 0; w < walks; w += 1) {
    const open = cursor;
    const close = fwd(open, perWalk);
    bars.push(bar(open, close, fwd(close, g.walk.wick), past(open, g.walk.wick)));
    cursor = close;
  }

  // B — displacement. Its body is what detectDisplacement measures (>= 0.8x ATR to register),
  // and it must stop short of the structure level or detectBreaker would treat IT as the reclaim
  // and measure the displacement chain off the wrong bar.
  const bOpen = cursor;
  const bClose = fwd(bOpen, g.displace.body);
  if ((bClose - target) * s >= 0) {
    return refuse('the displacement bar would close through the structure level — the sequence cannot be staged');
  }
  bars.push(bar(bOpen, bClose, fwd(bClose, g.displace.wick), past(bOpen, g.displace.wick)));

  // C — the reclaim. Closes through the structure level, and is sized so it also satisfies the
  // PRO overlay's read of the last bar (range >= 1x ATR, body >= 60% of range).
  const cOpen = bClose;
  const bodyAtr = Math.max(g.reclaim.body, (target - cOpen) * s / a);
  const cClose = fwd(cOpen, bodyAtr);
  // The small tail behind the open is what creates the FVG detectDisplacement needs: the reclaim
  // low must sit above the high of the bar two back.
  bars.push(bar(cOpen, cClose, fwd(cClose, g.reclaim.wick), past(cOpen, g.reclaim.tail)));

  return { bars, walks, needAtr: r2(needAtr), overshootAtr, reason: null };
}

/** Every synthetic bar must be a valid candle, or the strategies and the chart both lie. */
export function ictBarsValid(bars) {
  if (!Array.isArray(bars) || bars.length < 3) return false;
  return bars.every((b) => {
    const { open, high, low, close } = b;
    return [open, high, low, close].every((v) => Number.isFinite(v) && v > 0)
      && low <= open && open <= high && low <= close && close <= high;
  });
}

/**
 * The real candle history with the projected sequence appended.
 *
 * Higher-timeframe fields pass through untouched, so every HTF gate ictBreaker applies is still
 * judged against actual market state. That matters here more than anywhere: the H4 filter is the
 * one thing stopping this from projecting counter-trend breakers all day.
 */
export function ictScenarioContext(baseCtx, bars) {
  if (!baseCtx || !Array.isArray(baseCtx.candles) || !ictBarsValid(bars)) return null;
  return { ...baseCtx, candles: [...baseCtx.candles, ...bars], scenarioBars: bars.length, projected: true };
}

/** Stable identity, so re-scanning the same idea updates a row rather than duplicating it. */
export function ictKey({ symbol, timeframe, level, setup }) {
  return `${symbol}|${timeframe}|${(Math.round(n(level) * 1e5) / 1e5).toFixed(5)}|${setup}`;
}

/** Same grade bands the strategies use, so an A+ prediction means an A+ signal's score band. */
export function ictGrade(score) {
  if (score === null || score === undefined || score === '') return null;
  const v = n(score);
  if (!Number.isFinite(v)) return null;
  return v >= 85 ? 'A+' : v >= 75 ? 'A' : v >= 65 ? 'B' : 'C';
}

/**
 * Distance from live price to a price, in both pips and ATR.
 *
 * Pips is the number the user asked to filter on, and it is the one that means something at the
 * broker; ATR is what makes it comparable across gold and EURUSD.
 */
export function ictDistance({ price, to, atr, pip }) {
  const p = num(price), t = num(to), a = num(atr), pv = num(pip);
  if (p === null || t === null) return null;
  const d = Math.abs(t - p);
  return {
    price: r5(d),
    pips: pv !== null && pv > 0 ? Math.round((d / pv) * 10) / 10 : null,
    atr: a !== null && a > 0 ? r2(d / a) : null,
  };
}

/**
 * Rough time for price to reach the level, as a band rather than a point.
 *
 * Same assumption the setup forecaster uses (about half an ATR of travel per bar) so the two
 * pages cannot quote different ETAs for the same distance. `setupBars` adds the bars the
 * projected sequence itself needs — the prediction is not complete when price arrives, it is
 * complete when the breaker confirms.
 */
export function ictEta({ distanceAtr, timeframe, setupBars = 0, atrPerBar = 0.5 }) {
  const d = num(distanceAtr);
  const mins = ictBarMinutes(timeframe);
  if (d === null || !(mins > 0) || !(atrPerBar > 0)) return null;
  const arrive = Math.round((Math.max(0, d) / atrPerBar) * mins);
  const complete = arrive + Math.max(0, Math.round(setupBars)) * mins;
  return {
    arriveMinutes: arrive,
    minMinutes: Math.max(1, Math.round(complete / 2)),
    midMinutes: complete,
    maxMinutes: complete * 2,
  };
}

/**
 * The resting order the prediction implies.
 *
 * Deliberately anchored to the REAL level, not to the strategy's synthetic entry. ictBreaker
 * enters at the breaker zone, whose exact price is a product of the bar shapes this module
 * invented — resting a real order there would be trading my geometry. The level, the projected
 * sweep depth and the target are all read from the market, so those are what the order uses:
 *
 *   entry   the level itself — a BUY LIMIT under price at the swing low being swept
 *   stop    beyond the projected sweep extreme, the price that says the sweep did not fail
 *   target  the strategy's own TP ladder, which buildLiquidityPlan set at real opposing liquidity
 *
 * A LIMIT, never a stop order: the whole premise is that price has not arrived yet.
 */
export function ictLimitOrder({
  level, side, direction, atr, price, pip, targets = {}, options = {},
}) {
  const o = { ...ICT_DEFAULTS, ...options };
  const L = num(level), a = num(atr), p = num(price);
  if (L === null || !(a > 0)) return null;
  const buy = String(direction).toUpperCase() === 'BUY';
  if (side !== (buy ? 'below' : 'above')) return null;      // a buy limit must rest below price

  const sweepDepth = ICT_GEOMETRY.sweep.pierce + o.stopBufferAtr;
  const stopLoss = buy ? L - a * sweepDepth : L + a * sweepDepth;
  const risk = Math.abs(L - stopLoss);
  if (!(risk > 0) || risk / a < o.minStopAtr) return null;

  // Targets come from the strategy. Anything on the wrong side of the entry is dropped rather
  // than nudged into place — a target that does not clear the entry is not a target.
  const ok = (v) => {
    const x = num(v);
    if (x === null) return null;
    return (buy ? x > L : x < L) ? r5(x) : null;
  };
  const tp1 = ok(targets.takeProfit1), tp2 = ok(targets.takeProfit2), tp3 = ok(targets.takeProfit3);
  const final = tp3 ?? tp2 ?? tp1;

  return {
    type: buy ? 'BUY_LIMIT' : 'SELL_LIMIT',
    direction: buy ? 'BUY' : 'SELL',
    entry: r5(L),
    stopLoss: r5(stopLoss),
    takeProfit1: tp1, takeProfit2: tp2, takeProfit3: tp3,
    stopPips: pip && n(pip) > 0 ? Math.round((risk / n(pip)) * 10) / 10 : null,
    stopAtr: r2(risk / a),
    rr: final === null ? null : r2(Math.abs(final - L) / risk),
    distance: ictDistance({ price: p, to: L, atr: a, pip }),
    // Said plainly, because a resting order at a level price has not reached is exactly the kind
    // of thing that looks like a guarantee on a dashboard.
    note: buy
      ? 'Rests under price at the swing low. Fills only if price trades down into the liquidity; the stop sits beyond the projected sweep.'
      : 'Rests above price at the swing high. Fills only if price trades up into the liquidity; the stop sits beyond the projected sweep.',
  };
}

/**
 * The measured components behind an ict-break-pro decision, pulled out of the fire's own meta.
 *
 * These are the four filters the 2026-07-27 study of 1,040 settled signals actually kept, plus
 * the two that only add score. Surfacing them individually is the difference between "score 88"
 * and "score 88 BECAUSE the reclaim body is 74%, the bar spans 1.4x ATR and the draw is 5x ATR
 * away" — the second can be argued with.
 */
export function ictMeasurements(fire, { proConfig = {}, reclaimBar = null, atr = null, stage: stageIn = null } = {}) {
  const m = fire?.meta || {};
  const cfg = { minBodyRatio: 0.6, minRangeAtr: 1.0, maxBreakerAge: 1, avoidStage: 2, roomBonusAtr: 4, ...proConfig };
  const gate = (label, value, pass, detail) => ({ label, value, pass, detail });

  // Body and range are read off the projected reclaim bar when PRO did not fire, so the panel
  // still answers "which gate failed?" instead of going blank on exactly the setups where the
  // question matters. Both are knowable from the bar itself — no inference required.
  const a = num(atr);
  let barBody = null, barRange = null;
  if (reclaimBar && a !== null && a > 0) {
    const rng = n(reclaimBar.high) - n(reclaimBar.low);
    if (rng > 0) {
      barBody = Math.abs(n(reclaimBar.close) - n(reclaimBar.open)) / rng;
      barRange = rng / a;
    }
  }
  const bodyRatio = num(m.bodyRatio) ?? (barBody === null ? null : r2(barBody));
  const rangeAtr = num(m.rangeAtr) ?? (barRange === null ? null : r2(barRange));
  const ageBars = num(m.breakerAgeBars) ?? (reclaimBar ? 0 : null);   // the reclaim IS the last bar
  const stage = num(m.stage) ?? num(stageIn);
  const roomAtr = num(m.roomAtr);
  const dispAtr = num(m.displacementAtr);

  return {
    pro: Boolean(m.pro),
    baseScore: num(m.baseScore),
    displacementAtr: dispAtr,
    targetType: m.targetType || null,
    targetEqual: Boolean(m.targetEqual),
    sweepLevel: num(m.sweepLevel),
    structureLevel: num(m.structureLevel),
    // Gates — the four that both raised win rate AND raised distance travelled in the study.
    gates: [
      gate('Reclaim body', bodyRatio === null ? null : `${Math.round(bodyRatio * 100)}%`,
        bodyRatio === null ? null : bodyRatio >= cfg.minBodyRatio,
        `conviction close, not a doji (needs ${Math.round(cfg.minBodyRatio * 100)}%)`),
      gate('Reclaim range', rangeAtr === null ? null : `${r2(rangeAtr)}x ATR`,
        rangeAtr === null ? null : rangeAtr >= cfg.minRangeAtr,
        `a real displacement bar, not drift (needs ${cfg.minRangeAtr}x)`),
      gate('Breaker age', ageBars === null ? null : `${ageBars} bar${ageBars === 1 ? '' : 's'}`,
        ageBars === null ? null : ageBars <= cfg.maxBreakerAge,
        `the level is still live (max ${cfg.maxBreakerAge})`),
      gate('Stage', stage === null ? null : `stage ${stage}`,
        stage === null ? null : stage !== cfg.avoidStage,
        `stage ${cfg.avoidStage} measured worst by a distance (73% win, 1.88x ATR travel)`),
    ],
    // Bonuses — score only. Room-to-draw was 100% on discovery but only 21 validation trades,
    // so it was never allowed to gate anything and is not allowed to here either.
    bonuses: [
      gate('Room to draw', roomAtr === null ? null : `${r2(roomAtr)}x ATR`,
        roomAtr === null ? null : roomAtr >= cfg.roomBonusAtr, 'space to run before the opposing liquidity'),
      gate('Displacement', dispAtr === null ? null : `${r2(dispAtr)}x ATR`,
        dispAtr === null ? null : dispAtr >= 1.3, 'institutionally sponsored break (strong at 1.3x)'),
    ],
  };
}

/**
 * Project ONE candidate and read what the ICT strategies say about it.
 *
 * `baseline` holds what each strategy is already calling on the REAL bars. A strategy already
 * shouting BUY tells us nothing about the hypothetical, and counting it here would let the page
 * take credit for live signals it did not predict.
 */
export function projectIctSetup({
  base, candidate, atr, price, pip, symbol, timeframe,
  strategyIds = ICT_STRATEGIES, evaluate, baseline = new Map(), stageOf = null, options = {},
}) {
  if (!base || typeof evaluate !== 'function' || !candidate) return null;
  const seq = buildIctSequence({
    level: candidate.level, structureLevel: candidate.structureLevel, side: candidate.side,
    atr, lastCandle: base.candles?.[base.candles.length - 1], timeframe, options,
  });
  const bars = seq?.bars;
  if (!bars) return { candidate, unbuildable: seq?.reason || 'the projected sequence could not be built' };

  const ctx = ictScenarioContext(base, bars);
  if (!ctx) return { candidate, unbuildable: 'the projected bars did not form valid candles' };

  const fires = [];
  const refused = [];
  for (const id of strategyIds) {
    let res = null;
    try { res = evaluate(id, ctx); } catch { res = null; }
    if (!res?.decision) { refused.push({ strategyId: id, reason: 'its own filters rejected the projected setup' }); continue; }
    const decision = String(res.decision).toUpperCase();
    if (baseline.get(id) === decision) {
      refused.push({ strategyId: id, reason: `already calling ${decision} on the live bars — this is a signal, not a prediction` });
      continue;
    }
    if (decision !== candidate.direction) {
      // The sequence is a bullish breaker by construction, so a SELL here means the strategy read
      // the surrounding structure differently. Worth reporting, never worth rebranding.
      refused.push({ strategyId: id, reason: `read the projected sequence as ${decision}, against the ${candidate.direction} the setup implies` });
      continue;
    }
    fires.push({
      strategyId: id,
      decision,
      score: num(res.score),
      grade: res.grade || ictGrade(res.score),
      entry: num(res.entry),
      stopLoss: num(res.stopLoss),
      takeProfit1: num(res.takeProfit1),
      takeProfit2: num(res.takeProfit2),
      takeProfit3: num(res.takeProfit3),
      rr: num(res.riskRewardRatio),
      reason: String(res.reason || '').slice(0, 400),
      entryOrderType: res.meta?.entryOrderType || 'MARKET',
      meta: res.meta || {},
    });
  }
  if (!fires.length) return { candidate, refused, fired: false };

  fires.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  // PRO leading is the interesting case and it is called out explicitly: it means the setup
  // survived the selective overlay, which historically kept about one signal in three.
  const proFire = fires.find((f) => f.strategyId === 'ict-break-pro') || null;
  const lead = proFire || fires[0];

  const targets = {
    takeProfit1: lead.takeProfit1, takeProfit2: lead.takeProfit2, takeProfit3: lead.takeProfit3,
  };
  const limitOrder = ictLimitOrder({
    level: candidate.level, side: candidate.side, direction: candidate.direction,
    atr, price, pip, targets, options,
  });
  const setupBars = bars.length;
  const eta = ictEta({ distanceAtr: candidate.distanceAtr, timeframe, setupBars });
  let stage = null;
  if (typeof stageOf === 'function') {
    try { stage = num(stageOf(ctx.candles)?.stage ?? stageOf(ctx.candles)); } catch { stage = null; }
  }

  return {
    key: ictKey({ symbol, timeframe, level: candidate.level, setup: candidate.setup }),
    symbol, timeframe,
    setup: candidate.setup,
    direction: candidate.direction,
    side: candidate.side,
    level: candidate.level,
    levelIso: candidate.levelIso,
    levelLabel: candidate.levelLabel || null,
    levelType: candidate.levelType || null,
    levelStrength: candidate.levelStrength ?? null,
    structureLevel: candidate.structureLevel,
    atr: r5(atr),
    priceAtForecast: r5(price),
    distance: ictDistance({ price, to: candidate.level, atr, pip }),
    eta,
    setupBars,
    fires,
    refused,
    proQualified: Boolean(proFire),
    bestStrategy: lead.strategyId,
    bestScore: lead.score,
    grade: lead.grade || ictGrade(lead.score),
    rr: lead.rr,
    // What ictBreaker itself would do: a MARKET entry at the breaker once the reclaim closes.
    // Kept beside the limit order rather than instead of it, because the two are different trades.
    strategyPlan: {
      strategyId: lead.strategyId,
      orderType: lead.entryOrderType,
      direction: lead.decision,
      entry: lead.entry, stopLoss: lead.stopLoss,
      takeProfit1: lead.takeProfit1, takeProfit2: lead.takeProfit2, takeProfit3: lead.takeProfit3,
      rr: lead.rr,
      note: 'What the strategy would do once the reclaim closes: a market entry at the breaker. Its exact prices depend on the projected bar shapes below.',
    },
    limitOrder,
    measurements: ictMeasurements(lead, {
      ...options, reclaimBar: bars[bars.length - 1], atr, stage,
    }),
    // WHERE THE SCORE COMES FROM. ictBreaker builds its score from five components, and two of
    // them are decided by the geometry this module chose rather than by the market. Printing a
    // 95 without saying that would be presenting an assumption as a measurement — and would
    // explain why nearly every prediction on this page scores in the nineties.
    scoreBasis: {
      assumed: [
        `displacement fixed at ${ICT_GEOMETRY.displace.body}x ATR (worth up to +${Math.round(ICT_GEOMETRY.displace.body * 10)} score)`,
        'breaker age 0 bars, because the projected reclaim is the last bar (+5 score)',
      ],
      measured: [
        'higher-timeframe alignment (+10) — read from the real H4 trend',
        'target quality (+8 for stacked equal highs/lows) — a real liquidity pool',
        'risk:reward above the 2R floor — real level to real target',
        'stage — computed on the real candles, and the only PRO gate that can fail here',
      ],
      caution: 'A conditional score, not a probability. It assumes the textbook sequence below actually happens.',
    },
    projection: {
      walks: seq.walks,
      reclaimAtr: seq.needAtr,
      overshootAtr: seq.overshootAtr,
      bars: bars.length,
    },
    projectedBars: bars,
  };
}

/**
 * Rank by conviction AND how soon the condition could be met.
 *
 * A 95 that needs price to travel five ATR should not outrank an 80 sitting half an ATR away,
 * and a setup that cleared the PRO overlay is worth more than the same score without it —
 * that overlay was validated out-of-sample at 92% against an 88% baseline, so it is evidence,
 * not a preference.
 */
export function rankIctPredictions(predictions) {
  const scored = (Array.isArray(predictions) ? predictions : []).map((p) => {
    const score = num(p.bestScore) ?? 0;
    const mid = num(p.eta?.midMinutes);
    const proximity = mid === null ? 0.5 : 180 / (180 + Math.max(0, mid));
    const pro = p.proQualified ? 1.12 : 1;
    const rrBoost = Math.min(1.1, 0.95 + (num(p.rr) ?? 2) * 0.03);
    const rank = score * (0.45 + 0.55 * proximity) * pro * rrBoost;
    return { ...p, rankScore: r2(rank), proximity: r2(proximity) };
  });
  return scored.sort((a, b) => b.rankScore - a.rankScore
    || (num(a.eta?.midMinutes) ?? 0) - (num(b.eta?.midMinutes) ?? 0));
}

/**
 * Full ICT sweep for one symbol/timeframe.
 *
 * `levels` is optional enrichment from detectKeyLiquidityLevels — it does not decide anything,
 * it only names what a swing ALSO is (a PDL, equal lows, the London low). A swing that is also
 * the previous day's low is the same level either way; the label just makes it readable.
 */
export function runIctPredictions({
  base, swings, atr, price, pip, symbol, timeframe,
  levels = [], strategyIds = ICT_STRATEGIES, evaluate, stageOf = null, options = {},
}) {
  const o = { ...ICT_DEFAULTS, ...options };
  const empty = { predictions: [], candidates: 0, unbuildable: [], refused: [] };
  if (!base || typeof evaluate !== 'function') return empty;

  const candidates = ictCandidates(base.candles, { swings, price, atr, options: o });
  if (!candidates.length) return empty;

  // What is each strategy already saying for real? Established once, not per candidate.
  const baseline = new Map();
  for (const id of strategyIds) {
    try {
      const r = evaluate(id, base);
      if (r?.decision) baseline.set(id, String(r.decision).toUpperCase());
    } catch { /* a live-path failure is not this feature's problem to report */ }
  }

  const tol = n(atr) * 0.15;
  const label = (levelPrice) => {
    const hit = (levels || [])
      .filter((l) => Number.isFinite(n(l.price)) && Math.abs(n(l.price) - levelPrice) <= tol)
      .sort((a, b) => (n(b.strength) || 0) - (n(a.strength) || 0))[0];
    return hit ? { levelType: hit.type || null, levelLabel: hit.label || null, levelStrength: num(hit.strength) } : {};
  };

  const predictions = [];
  const unbuildable = [];
  const refused = [];
  for (const c of candidates) {
    const enriched = { ...c, ...label(c.level) };
    const out = projectIctSetup({
      base, candidate: enriched, atr, price, pip, symbol, timeframe,
      strategyIds, evaluate, baseline, stageOf, options: o,
    });
    if (!out) continue;
    if (out.unbuildable) { unbuildable.push({ level: c.level, setup: c.setup, reason: out.unbuildable }); continue; }
    if (!out.key) {
      for (const r of out.refused || []) {
        if (!refused.some((x) => x.strategyId === r.strategyId && x.reason === r.reason)) refused.push(r);
      }
      continue;
    }
    predictions.push(out);
  }

  return {
    predictions: rankIctPredictions(predictions),
    candidates: candidates.length,
    unbuildable,
    refused,
  };
}

export const ICT_TRACK = {
  APPROACHING: 'APPROACHING',
  AT_THE_POOL: 'AT_THE_POOL',
  SWEPT_WAITING: 'SWEPT_WAITING',
  CONFIRMED: 'CONFIRMED',
  FAILED_SWEEP: 'FAILED_SWEEP',
  DRIFTED_AWAY: 'DRIFTED_AWAY',
  STALE: 'STALE',
  CLOSED: 'CLOSED',
};

export const ICT_TRACK_DEFAULTS = {
  atPoolAtr: 0.25,      // this close to the pool, an order should already be resting
  sweptAtr: 0.05,       // trading this far through the level counts as the grab
  acceptAtr: 1.25,      // this far through WITHOUT reclaiming means price accepted, not swept
  awayAtr: 2.5,         // drifting this much further away than when predicted
};

/**
 * Health of one ICT prediction against what price has actually done since.
 *
 * The generic forecast tracker cannot be reused here, and reusing it would have been actively
 * wrong: it calls a level break "REVERSED — the premise is gone", but on this page the break IS
 * the prediction. A sweep is the setup starting, not the setup failing. What kills an ICT
 * prediction is price ACCEPTING through the pool — trading well beyond it and not closing back
 * through the structure — which is the opposite reading of the same event.
 *
 * Order matters: a confirmed reclaim beats everything, because at that point the breaker exists
 * and the only question left is the trade.
 */
export function assessIctPrediction({
  prediction, price, extreme = null, reclaimed = false, now = Date.now(), options = {},
}) {
  const o = { ...ICT_TRACK_DEFAULTS, ...options };
  const p = prediction || {};
  const level = num(p.level);
  const a = num(p.atr);
  const live = num(price);
  const buy = String(p.direction || '').toUpperCase() === 'BUY';
  const reasons = [];

  const madeMs = Date.parse(p.createdAt || '');
  const etaMax = num(p.eta?.maxMinutes);
  const elapsed = Number.isFinite(madeMs) ? Math.round((now - madeMs) / 60000) : null;
  const timeLeftMinutes = etaMax !== null && elapsed !== null ? Math.round(etaMax - elapsed) : null;

  const base = { timeLeftMinutes, distanceAtr: null, throughAtr: null, reasons, alertWorthy: false };
  if (p.status && p.status !== 'WAITING') {
    return { ...base, verdict: ICT_TRACK.CLOSED, reasons: [`prediction is ${String(p.status).toLowerCase()}`] };
  }
  if (level === null || live === null || !(a > 0)) {
    return { ...base, verdict: ICT_TRACK.APPROACHING, reasons: ['not enough live data to judge this yet'] };
  }

  const distanceAtr = r2(Math.abs(live - level) / a);
  // How far the FURTHEST point traded through the pool — the wick is the sweep, not the close.
  const far = num(extreme) ?? live;
  const throughAtr = r2((buy ? level - far : far - level) / a);
  const out = { ...base, distanceAtr, throughAtr };

  // 1. The breaker exists. Nothing else matters.
  if (reclaimed) {
    reasons.push('price closed back through the structure level — the breaker has confirmed');
    return {
      ...out, verdict: ICT_TRACK.CONFIRMED, alertWorthy: true,
      suggestion: `The sequence played out. ${buy ? 'Bullish' : 'Bearish'} breaker is live at ${p.structureLevel ?? 'the structure level'}; the resting limit at ${level} should already be filled.`,
    };
  }

  // 2. Price accepted through the pool instead of failing there. This is THE failure mode of the
  //    model, and it is a different event from the sweep even though both trade through the level.
  if (throughAtr >= o.acceptAtr) {
    reasons.push(`price is ${throughAtr} ATR beyond the pool with no reclaim — it accepted through rather than failing`);
    return {
      ...out, verdict: ICT_TRACK.FAILED_SWEEP, alertWorthy: true,
      suggestion: `Liquidity was taken and price kept going. This is no longer a breaker; ${level} has flipped to ${buy ? 'resistance' : 'support'} against you.`,
    };
  }

  // 3. The grab happened and the reclaim has not. This is the live, watch-it-now state.
  if (throughAtr >= o.sweptAtr) {
    reasons.push(`the pool at ${level} has been taken; waiting on a close back through ${p.structureLevel ?? 'the structure level'}`);
    return {
      ...out, verdict: ICT_TRACK.SWEPT_WAITING, alertWorthy: true,
      suggestion: 'The sweep is in. The trade needs a conviction close back through the structure — without it this is just a level giving way.',
    };
  }

  // 4. The window ran out before price ever got there.
  if (timeLeftMinutes !== null && timeLeftMinutes < 0) {
    reasons.push(`${Math.abs(timeLeftMinutes)} min past the outer estimate and price never reached the pool`);
    return {
      ...out, verdict: ICT_TRACK.STALE,
      suggestion: 'The pool is still unswept, but the clock that made this actionable has expired. Re-scan rather than trusting the old ETA.',
    };
  }

  // 5. Moving the wrong way. Not fatal — the pool is still there — but the plan has gone cold.
  const predictedAtr = num(p.distance?.atr);
  if (predictedAtr !== null && distanceAtr - predictedAtr >= o.awayAtr) {
    reasons.push(`price is ${r2(distanceAtr - predictedAtr)} ATR further from the pool than when this was predicted`);
    return {
      ...out, verdict: ICT_TRACK.DRIFTED_AWAY,
      suggestion: 'Price is walking away from the level. The setup is intact but the timing estimate is worthless now.',
    };
  }

  if (distanceAtr <= o.atPoolAtr) {
    reasons.push(`price is ${distanceAtr} ATR from the pool`);
    return {
      ...out, verdict: ICT_TRACK.AT_THE_POOL, alertWorthy: true,
      suggestion: 'Price is at the liquidity. If the limit is not already resting, it is about to be too late to place it.',
    };
  }

  reasons.push(`${distanceAtr} ATR to go, nothing has changed`);
  return { ...out, verdict: ICT_TRACK.APPROACHING, suggestion: 'Still waiting on price to reach the pool.' };
}

/**
 * Should the ONE alert fire now?
 *
 * Exactly one per prediction, ever. A setup that hovers around its pool for an hour would
 * otherwise send a dozen mails and train the reader to ignore all of them.
 */
export function shouldAlertIct(assessment, { alertedAt = null } = {}) {
  if (alertedAt) return false;
  return Boolean(assessment?.alertWorthy);
}

/**
 * Client-side style filtering, shared by the API so the page and the server agree on what a
 * filter means. Pip distance is the one the user asked for by name and it is applied to the
 * LIMIT entry — that is the price an order would actually rest at.
 */
export function filterIctPredictions(predictions, f = {}) {
  const list = Array.isArray(predictions) ? predictions : [];
  const minScore = num(f.minScore);
  const maxPips = num(f.maxPips);
  const minPips = num(f.minPips);
  const minRR = num(f.minRR);
  return list.filter((p) => {
    if (f.symbol && p.symbol !== f.symbol) return false;
    if (f.timeframe && p.timeframe !== f.timeframe) return false;
    if (f.setup && p.setup !== f.setup) return false;
    if (f.direction && p.direction !== f.direction) return false;
    if (f.grade && p.grade !== f.grade) return false;
    if (f.strategy && !(p.fires || []).some((x) => x.strategyId === f.strategy)) return false;
    if (f.proOnly && !p.proQualified) return false;
    if (minScore !== null && (num(p.bestScore) ?? 0) < minScore) return false;
    if (minRR !== null && (num(p.rr) ?? 0) < minRR) return false;
    const pips = num(p.distance?.pips);
    if (maxPips !== null && (pips === null || pips > maxPips)) return false;
    if (minPips !== null && (pips === null || pips < minPips)) return false;
    return true;
  });
}
