// strategyLab.js — isolated "strategy lab". Each strategy is a SELF-CONTAINED, pure
// implementation of ONE tutorial's rules. Completely separate from the main
// aggregateSignals confluence system: these never touch or blend with live signals.
// The server logs every strategy's signals and resolves outcomes so we can MEASURE
// which strategy actually works (honest, sample-confidence-gated comparison).
//
// A strategy: evaluate(ctx) -> signal | null
//   ctx = { symbol, timeframe, candles, pip, h4Trend, h1Trend, config }
//   signal = { decision:'BUY'|'SELL', entry, stopLoss, takeProfit1, takeProfit2?,
//              takeProfit3?, riskRewardRatio, reason, barIso, meta }
// Pure: no I/O. New strategies = add one entry to STRATEGIES.

import { detectBreaker, detectLiquidityPools, buildLiquidityPlan, fractalSwings, atr14 } from './liquidityEngine.js';

const r5 = (v) => Math.round(v * 1e5) / 1e5;
const n = (v) => Number(v);

// Reject setups whose stop is too tight to be real — sub-spread / noise-level stops
// (common on M1 sweeps) produce untradeable signals and absurd position sizes. Risk must
// clear BOTH an ATR fraction (instrument/timeframe-aware) and a small absolute pip floor.
function stopTooTight(risk, atr, pip, { minStopAtr = 0.35, minStopPips = 3 } = {}) {
  const r = Math.abs(Number(risk));
  if (!(r > 0)) return true;
  const floor = Math.max(Number.isFinite(atr) ? minStopAtr * atr : 0, minStopPips * (pip || 0.0001));
  return r < floor;
}

// Build a 3-rung TP ladder for any strategy. TP1/TP2 are scaling rungs at 1R / 2R
// (where to take partials / move to break-even), TP3 is the structural objective —
// the opposing liquidity draw (breaker/trap) or the strategy's fixed target (3-step).
// Always returns strictly-ordered, correct-side targets so the outcome replay can
// never see a degenerate level (see the null-TP false-win fix in the resolver).
function tpLadder(dir, entry, risk, finalTarget) {
  const r = Math.abs(risk);
  const sign = dir === 'BUY' ? 1 : -1;
  const t1 = entry + sign * r * 1;
  const t2 = entry + sign * r * 2;
  let t3 = Number.isFinite(finalTarget) ? finalTarget : entry + sign * r * 3;
  // Structural target must sit beyond TP2; clamp defensively so the ladder never inverts.
  if (dir === 'BUY' ? t3 <= t2 : t3 >= t2) t3 = entry + sign * r * 3;
  return { takeProfit1: r5(t1), takeProfit2: r5(t2), takeProfit3: r5(t3) };
}

// ── Strategy 1: ICT Breaker (Maine — "$10M ICT Blueprint", Chart Fanatics) ───
// Sweep a swing low/high → close back through the prior swing (a "breaker") WITH
// displacement (institutionally-sponsored) → enter the breaker, stop beyond the
// sweep, target the opposing resting liquidity (draw on liquidity). HTF-aligned,
// minimum RR. Only fires on a freshly-confirmed breaker (dedup by the reclaim bar).
function ictBreaker(ctx) {
  const { candles, h4Trend = null, config = {}, pip = 0.0001 } = ctx;
  const minRR = config.minRR ?? 2;
  const maxAgeBars = config.maxAgeBars ?? 3;
  if (!Array.isArray(candles) || candles.length < 60) return null;

  const breaker = detectBreaker(candles, { maxAgeBars: 50 });
  if (!breaker) return null;
  if (breaker.ageBars > maxAgeBars) return null;                 // only act on a fresh breaker
  if (!breaker.displacement || !breaker.displacement.present) return null; // require displacement

  const pools = detectLiquidityPools(candles);
  const plan = buildLiquidityPlan(breaker, pools);
  if (!plan) return null;                                        // no opposing liquidity to target
  if (!(plan.rr >= minRR)) return null;                          // RR floor (ICT: min 2R)
  if (stopTooTight(plan.entry - plan.stop, atr14(candles), pip, config)) return null; // reject sub-spread stops

  const dir = plan.direction;                                    // BUY (bullish breaker) / SELL
  // Top-down: don't take a breaker against a clearly-trending higher timeframe.
  if (h4Trend === 'BULLISH' && dir === 'SELL') return null;
  if (h4Trend === 'BEARISH' && dir === 'BUY') return null;

  // Confidence score (0-100, deterministic) from the components that make an ICT
  // breaker high-quality: displacement strength, R:R, HTF alignment, stacked-equal
  // target liquidity, and freshness. Lets you rank/filter signals like the main engine.
  let score = 50;
  score += Math.min(20, Math.round(breaker.displacement.atrMultiple * 10)); // displacement strength
  score += Math.min(15, Math.round((plan.rr - 2) * 5));                     // R:R above the 2R floor
  if ((dir === 'BUY' && h4Trend === 'BULLISH') || (dir === 'SELL' && h4Trend === 'BEARISH')) score += 10; // explicit HTF alignment
  if (plan.targetEqual) score += 8;                                         // target = stacked equal highs/lows
  if (breaker.ageBars === 0) score += 5;                                    // freshest possible
  score = Math.max(40, Math.min(95, score));

  // TP ladder: 1R / 2R scaling rungs, with TP3 = the opposing liquidity pool (the draw).
  const ladder = tpLadder(dir, plan.entry, Math.abs(plan.entry - plan.stop), plan.target);

  return {
    decision: dir,
    score,
    grade: score >= 85 ? 'A+' : score >= 75 ? 'A' : score >= 65 ? 'B' : 'C',
    entry: r5(plan.entry),
    stopLoss: r5(plan.stop),
    ...ladder,                            // TP3 = opposing liquidity pool = the draw
    riskRewardRatio: plan.rr,
    reason: `${breaker.type} breaker + displacement ${breaker.displacement.atrMultiple}× → ${plan.targetType}${plan.targetEqual ? ' (equal highs/lows)' : ''} ${plan.target}; sweep ${breaker.sweepLevel}`,
    barIso: breaker.confirmedIso,         // dedup anchor: one signal per breaker
    meta: {
      breakerType: breaker.type,
      sweepLevel: breaker.sweepLevel,
      structureLevel: breaker.structureLevel,
      displacementAtr: breaker.displacement.atrMultiple,
      targetType: plan.targetType,
      targetEqual: plan.targetEqual,
    },
  };
}

// ── Strategy 2: Market Mechanics 3-Step (Brett — "SIMPLE 3-Step Trick") ──────
// The literal Direction → Location → Execution framework, mechanically encoded:
//   1. DIRECTION  — trade WITH the higher-timeframe (H4) trend only. No bias, no trade.
//   2. LOCATION   — only act when price is at the right side of the swing range:
//                   BUY in DISCOUNT (below the 50% equilibrium), SELL in PREMIUM
//                   (above it). The range = most recent fractal swing high↔low.
//   3. EXECUTION  — on the just-closed candle, require all THREE pure-PA confluences:
//                   (a) strong rejection candle (engulfing OR pin-with-displacement),
//                   (b) break & close in the bias direction (close beyond prior extreme),
//                   (c) failure to continue against the bias (no fresh counter-extreme).
// Stop beyond the rejection candle (Brett's "if I can't define my stop, I don't trade");
// take profit at a fixed 3R (his demo default). Self-contained, pure, dedup by signal bar.
function marketMechanics3Step(ctx) {
  const { candles, h4Trend = null, config = {}, pip = 0.0001 } = ctx;
  const tpR = config.tpR ?? 3;                 // Brett's demo target = 3R
  const maxDiscountPremiumPct = config.maxZonePct ?? 0.5; // must be past equilibrium
  if (!Array.isArray(candles) || candles.length < 60) return null;

  // STEP 1 — DIRECTION (higher-timeframe trend is the only bias source).
  if (h4Trend !== 'BULLISH' && h4Trend !== 'BEARISH') return null;
  const dir = h4Trend === 'BULLISH' ? 'BUY' : 'SELL';

  // Swing range from the most recent fractal swing high & low (defines premium/discount).
  const { highs, lows } = fractalSwings(candles);
  if (!highs.length || !lows.length) return null;
  const swingHigh = highs[highs.length - 1];
  const swingLow = lows[lows.length - 1];
  const hi = swingHigh.price, lo = swingLow.price;
  if (!(hi > lo)) return null;
  const eq = (hi + lo) / 2;

  const lastIdx = candles.length - 1;
  const c = candles[lastIdx];
  const prev = candles[lastIdx - 1];
  const price = n(c.close);

  // STEP 2 — LOCATION (premium/discount gate). Buy cheap, sell expensive only.
  const range = hi - lo;
  const posInRange = (price - lo) / range;     // 0 = swing low, 1 = swing high
  if (dir === 'BUY' && posInRange > maxDiscountPremiumPct) return null;   // not in discount
  if (dir === 'SELL' && posInRange < (1 - maxDiscountPremiumPct)) return null; // not in premium

  // STEP 2b — POINT OF INTEREST. Brett is explicit: don't enter in the middle of nowhere —
  // you only execute AT the demand (BUY) / supply (SELL) zone, i.e. the swing extreme that
  // anchors the range. Require price within poiAtr×ATR of that extreme (the "last line of
  // defence" in discount / the unmitigated supply in premium). This is the difference
  // between "somewhere past 50%" and an actual A+ location.
  const atr = atr14(candles) || range * 0.02;
  const poiAtr = config.poiAtr ?? 2;
  if (dir === 'BUY' && (price - lo) > poiAtr * atr) return null;    // not at the demand extreme
  if (dir === 'SELL' && (hi - price) > poiAtr * atr) return null;   // not at the supply extreme

  // STEP 3 — EXECUTION confluences on the just-closed candle.
  const body = Math.abs(n(c.close) - n(c.open));
  const prevBody = Math.abs(n(prev.close) - n(prev.open));
  const upperWick = n(c.high) - Math.max(n(c.close), n(c.open));
  const lowerWick = Math.min(n(c.close), n(c.open)) - n(c.low);
  if (!(body > 0)) return null;

  let rejection, breakClose, failAgainst, stop;
  if (dir === 'BUY') {
    const bull = n(c.close) > n(c.open);
    const engulf = bull && body > prevBody && n(c.close) >= n(prev.high);   // engulfing
    const pin = bull && lowerWick >= body * 1.5;                            // pin + displacement
    rejection = engulf || pin;                                             // confluence (a)
    breakClose = bull && n(c.close) > n(prev.high);                        // confluence (b)
    failAgainst = n(c.low) >= n(prev.low) && n(prev.low) >= swingLow.price; // confluence (c)
    stop = Math.min(n(c.low), n(prev.low));
  } else {
    const bear = n(c.close) < n(c.open);
    const engulf = bear && body > prevBody && n(c.close) <= n(prev.low);
    const pin = bear && upperWick >= body * 1.5;
    rejection = engulf || pin;
    breakClose = bear && n(c.close) < n(prev.low);
    failAgainst = n(c.high) <= n(prev.high) && n(prev.high) <= swingHigh.price;
    stop = Math.max(n(c.high), n(prev.high));
  }
  if (!(rejection && breakClose && failAgainst)) return null;

  const risk = dir === 'BUY' ? price - stop : stop - price;
  if (!(risk > 0)) return null;
  if (stopTooTight(risk, atr, pip, config)) return null;          // reject sub-spread / noise stops
  // TP ladder: 1R / 2R partial rungs, TP3 = Brett's fixed structural target (tpR, default 3R).
  const finalTarget = dir === 'BUY' ? price + risk * tpR : price - risk * tpR;
  const ladder = tpLadder(dir, price, risk, finalTarget);

  // Deterministic confidence: base + how deep into discount/premium + rejection strength.
  let score = 55;
  const depth = dir === 'BUY' ? (maxDiscountPremiumPct - posInRange) : (posInRange - (1 - maxDiscountPremiumPct));
  score += Math.min(15, Math.round(depth * 60));            // deeper in zone = better price
  score += Math.min(15, Math.round((body / Math.max(prevBody, 1e-9)) * 5)); // rejection strength
  score += 10;                                              // explicit HTF alignment (always true here)
  score = Math.max(40, Math.min(95, score));

  return {
    decision: dir,
    score,
    grade: score >= 85 ? 'A+' : score >= 75 ? 'A' : score >= 65 ? 'B' : 'C',
    entry: r5(price),
    stopLoss: r5(stop),
    ...ladder,
    riskRewardRatio: tpR,
    reason: `3-step ${dir}: H4 ${h4Trend} + ${dir === 'BUY' ? 'discount' : 'premium'} (${Math.round(posInRange * 100)}% of range) at ${dir === 'BUY' ? 'demand' : 'supply'} POI + rejection/break-close/no-continuation → ${tpR}R`,
    barIso: c.time,                            // one signal per closed candle
    meta: {
      h4Trend, equilibrium: r5(eq), swingHigh: r5(hi), swingLow: r5(lo),
      posInRangePct: Math.round(posInRange * 100),
    },
  };
}

// ── Strategy 3: Liquidity Trap (Marco Acetony — "EASY Liquidity TRAP", Chart Fanatics) ──
// Pure liquidity-trap reversal. The ONE strict rule: never enter until resting liquidity
// is TAKEN (the false move that traps retail), then trade the reversal toward the OPPOSING
// liquidity pool. Distinct from ict-breaker — it does NOT require a close back through a
// prior swing or displacement; the SWEEP + close-back-inside (the trap rejection) is the
// trigger, period. Buy only AFTER a low is swept; sell only AFTER a high is swept.
//   bullish trap: swing low swept (lower low) → candle closes back ABOVE it → BUY,
//                 stop below the sweep extreme, target nearest unswept BSL above.
//   bearish trap: mirror.
function liquidityTrap(ctx) {
  const { candles, h4Trend = null, config = {}, pip = 0.0001 } = ctx;
  const minRR = config.minRR ?? 2;
  const maxAgeBars = config.maxAgeBars ?? 4;     // trap must be fresh
  if (!Array.isArray(candles) || candles.length < 60) return null;

  const { highs, lows } = fractalSwings(candles);
  const pools = detectLiquidityPools(candles);
  const lastIdx = candles.length - 1;
  const price = n(candles[lastIdx].close);

  // Most recent BULLISH trap: a swing low swept then reclaimed (close back above).
  let bull = null;
  for (let k = lows.length - 1; k >= 0; k--) {
    const low = lows[k];
    let sweepIdx = -1;
    for (let j = low.i + 1; j < candles.length; j++) { if (n(candles[j].low) < low.price) { sweepIdx = j; break; } }
    if (sweepIdx === -1 || lastIdx - sweepIdx > maxAgeBars) continue;
    let rejIdx = -1;
    for (let j = sweepIdx; j < candles.length; j++) { if (n(candles[j].close) > low.price) { rejIdx = j; break; } }
    if (rejIdx === -1 || lastIdx - rejIdx > maxAgeBars) continue;
    const target = pools.targetAbove;                          // opposing draw on liquidity
    if (!target) continue;
    // Enter at the reclaim (trap) candle close — Marco executes once the low is TAKEN and
    // price closes back inside, not chasing the latest price. Stop below the sweep extreme
    // of the trap excursion (sweep → reclaim).
    const entryB = n(candles[rejIdx].close);
    const sweepLow = Math.min(...candles.slice(sweepIdx, rejIdx + 1).map((x) => n(x.low)));
    const risk = entryB - sweepLow, reward = target.price - entryB;
    if (!(risk > 0) || !(reward > 0) || reward / risk < minRR) continue;
    bull = { sweptLevel: low.price, sweepIdx, rejIdx, sweepLow, entry: entryB, target, rr: reward / risk };
    break;
  }

  // Most recent BEARISH trap: a swing high swept then reclaimed (close back below).
  let bear = null;
  for (let k = highs.length - 1; k >= 0; k--) {
    const high = highs[k];
    let sweepIdx = -1;
    for (let j = high.i + 1; j < candles.length; j++) { if (n(candles[j].high) > high.price) { sweepIdx = j; break; } }
    if (sweepIdx === -1 || lastIdx - sweepIdx > maxAgeBars) continue;
    let rejIdx = -1;
    for (let j = sweepIdx; j < candles.length; j++) { if (n(candles[j].close) < high.price) { rejIdx = j; break; } }
    if (rejIdx === -1 || lastIdx - rejIdx > maxAgeBars) continue;
    const target = pools.targetBelow;
    if (!target) continue;
    const entryB = n(candles[rejIdx].close);
    const sweepHigh = Math.max(...candles.slice(sweepIdx, rejIdx + 1).map((x) => n(x.high)));
    const risk = sweepHigh - entryB, reward = entryB - target.price;
    if (!(risk > 0) || !(reward > 0) || reward / risk < minRR) continue;
    bear = { sweptLevel: high.price, sweepIdx, rejIdx, sweepHigh, entry: entryB, target, rr: reward / risk };
    break;
  }

  // Pick the freshest trap (most recent reclaim).
  let dir, t, entry, stop, rr;
  if (bull && bear) { if (bull.rejIdx >= bear.rejIdx) { dir = 'BUY'; t = bull; } else { dir = 'SELL'; t = bear; } }
  else if (bull) { dir = 'BUY'; t = bull; }
  else if (bear) { dir = 'SELL'; t = bear; }
  else return null;

  entry = t.entry;
  stop = dir === 'BUY' ? t.sweepLow : t.sweepHigh;
  rr = t.rr;

  // Top-down: don't fade a clearly-trending higher timeframe (mirror of ict-breaker).
  if (h4Trend === 'BULLISH' && dir === 'SELL') return null;
  if (h4Trend === 'BEARISH' && dir === 'BUY') return null;

  if (stopTooTight(entry - stop, atr14(candles), pip, config)) return null; // reject sub-spread stops

  // TP ladder: 1R / 2R scaling rungs, TP3 = the opposing liquidity pool (the draw).
  const ladder = tpLadder(dir, entry, Math.abs(entry - stop), t.target.price);

  let score = 52;
  score += Math.min(18, Math.round((rr - 2) * 6));                 // R:R above the 2R floor
  if (t.target.equal) score += 8;                                  // target = stacked equal highs/lows
  if ((dir === 'BUY' && h4Trend === 'BULLISH') || (dir === 'SELL' && h4Trend === 'BEARISH')) score += 10;
  if (lastIdx - t.rejIdx <= 1) score += 7;                         // freshest reclaim
  score = Math.max(40, Math.min(95, score));

  return {
    decision: dir,
    score,
    grade: score >= 85 ? 'A+' : score >= 75 ? 'A' : score >= 65 ? 'B' : 'C',
    entry: r5(entry),
    stopLoss: r5(stop),
    ...ladder,                                // TP3 = opposing resting liquidity = the draw
    riskRewardRatio: Math.round(rr * 100) / 100,
    reason: `Liquidity trap ${dir}: ${dir === 'BUY' ? 'low' : 'high'} ${r5(t.sweptLevel)} swept then reclaimed → target ${t.target.type}${t.target.equal ? ' (equal)' : ''} ${t.target.price}`,
    barIso: candles[t.rejIdx].time,           // dedup: one signal per reclaim bar
    meta: {
      sweptLevel: r5(t.sweptLevel),
      targetType: t.target.type,
      targetEqual: t.target.equal,
      ageBars: lastIdx - t.rejIdx,
      h4Trend,
    },
  };
}

export const STRATEGIES = {
  'ict-breaker': {
    id: 'ict-breaker',
    name: 'ICT Breaker',
    source: 'Maine — "The SIMPLE $10M ICT Blueprint" (Chart Fanatics)',
    description: 'Liquidity sweep → close back through the prior swing (breaker) with displacement, entered at the breaker with stop beyond the sweep, targeting the opposing resting liquidity. HTF-aligned, minimum 2R.',
    timeframes: ['M15', 'M30', 'H1'],
    config: { minRR: 2, maxAgeBars: 3 },
    evaluate: ictBreaker,
  },
  'market-mechanics-3step': {
    id: 'market-mechanics-3step',
    name: 'Market Mechanics 3-Step',
    source: 'Brett — "Price Action Was Hard Until This SIMPLE 3-Step Trick"',
    description: 'Direction (trade with the H4 trend) → Location (only BUY in discount / SELL in premium of the swing range) → Execution (strong rejection candle + break-and-close in bias + failure to continue against bias). Stop beyond the rejection candle, fixed 3R target.',
    timeframes: ['M5', 'M15', 'M30', 'H1'],
    config: { tpR: 3, maxZonePct: 0.5 },
    evaluate: marketMechanics3Step,
  },
  'liquidity-trap': {
    id: 'liquidity-trap',
    name: 'Liquidity Trap',
    source: 'Marco Acetony — "STEAL This EASY Liquidity TRAP Strategy" (Chart Fanatics)',
    description: 'Wait for resting liquidity to be swept (the trap that catches retail), then trade the reversal toward the opposing liquidity pool. Strict rule: never buy until a low is taken, never sell until a high is taken. Sweep + close-back-inside is the trigger (no breaker/displacement required). HTF-aligned, minimum 2R.',
    timeframes: ['M5', 'M15', 'M30', 'H1'],
    config: { minRR: 2, maxAgeBars: 4 },
    evaluate: liquidityTrap,
  },
};

export function listStrategies() {
  return Object.values(STRATEGIES).map(({ evaluate, ...meta }) => meta);
}

export function evaluateStrategy(id, ctx) {
  const s = STRATEGIES[id];
  if (!s) return null;
  try { return s.evaluate({ ...ctx, config: { ...(s.config || {}), ...(ctx.config || {}) } }); }
  catch { return null; }
}

export function strategyTimeframes(id) {
  const s = STRATEGIES[id];
  return s ? (s.timeframes || ['M15']) : ['M15'];
}
