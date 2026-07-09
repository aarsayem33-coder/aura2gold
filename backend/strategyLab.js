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

import { detectBreaker, detectLiquidityPools, buildLiquidityPlan, fractalSwings, atr14, detectSecondDrive, gradeSweep, detectKeyLiquidityLevels, detectDisplacement } from './liquidityEngine.js';
import { buildBreakoutCandidate, BREAKOUT_GRADE_RANK } from './breakoutEngine.js';

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

// ── Strategy 4: Little Rizzy (Massi Safi — World #2 Futures Trader, Chart Fanatics) ──────
// A trend-continuation MEASURED-MOVE pattern with a Bollinger "reality" location filter.
// Downtrend: impulse leg (swing high H → swing low L) then a bounce to a LOWER HIGH (PH) —
// the "little rizzy". The next leg projects an EQUAL distance: target = L − (H − L). Short
// the lower-high as the bounce stalls; stop just beyond it; target the measured move.
// Bollinger Bands (20, 2σ) = "reality": only take pullbacks with room to run (short from the
// upper/middle band, never when already pinned to the lower band); favor the freshest legs.
// Mirror for uptrends (BUY): pullback to a HIGHER LOW (PL), target = H + (H − L). Pure.
function bollingerBands(candles, period = 20, mult = 2) {
  if (!Array.isArray(candles) || candles.length < period) return null;
  const closes = candles.slice(-period).map((c) => n(c.close));
  const mid = closes.reduce((a, b) => a + b, 0) / period;
  const variance = closes.reduce((a, b) => a + (b - mid) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { mid, upper: mid + mult * sd, lower: mid - mult * sd, sd };
}

function littleRizzy(ctx) {
  const { candles, h4Trend = null, config = {}, pip = 0.0001 } = ctx;
  const minRR = config.minRR ?? 1.8;
  const maxAgeBars = config.maxAgeBars ?? 4;       // pullback must be fresh
  const poiAtr = config.poiAtr ?? 1.5;             // price must still be near the pullback extreme
  // Phase 1 — source the impulse from a LOCAL recent leg and bound its size, so the measured
  // move / RR can't be inflated by a stale global-max swing (the main cause of bad signals).
  const impulseLookback = Math.max(5, config.impulseLookback ?? 20); // bars before the extreme to source the impulse origin
  const impulseMaxBars = Math.max(3, config.impulseMaxBars ?? 30);   // impulse must be a steep recent leg, not a slow drift
  const minImpulseAtr = config.minImpulseAtr ?? 1.5; // impulse must be a real move…
  const maxImpulseAtr = config.maxImpulseAtr ?? 8;   // …but not an absurd range (caps measured move / RR)
  // Phase 2 — healthy retracement window (reject shallow & near-full / failed-impulse pullbacks).
  const fibLow = config.fibLow ?? 0.382;
  const fibHigh = config.fibHigh ?? 0.786;
  const fibSweetLow = config.fibSweetLow ?? 0.5;
  const fibSweetHigh = config.fibSweetHigh ?? 0.618;
  if (!Array.isArray(candles) || candles.length < 60) return null;
  if (h4Trend !== 'BULLISH' && h4Trend !== 'BEARISH') return null;   // trade WITH the trend only

  const atr = atr14(candles);
  if (!(atr > 0)) return null;
  const bb = bollingerBands(candles);
  if (!bb) return null;
  const { highs, lows } = fractalSwings(candles);
  if (highs.length < 1 || lows.length < 1) return null;
  const lastIdx = candles.length - 1;
  const c = candles[lastIdx];
  const price = n(c.close);
  const prev = candles[lastIdx - 1];
  const dir = h4Trend === 'BEARISH' ? 'SELL' : 'BUY';

  // Phase 3 — next-higher-TF stage must not contradict the trade (reuse the shared HTF gate).
  const htfAgree = stageHtfAgreement(ctx, dir);
  if (htfAgree === 'oppose') return null;
  const htfBonus = htfAgree === 'agree' ? 6 : 0;
  const htfNote = htfAgree === 'agree' ? ' — HTF aligned' : '';

  if (dir === 'SELL') {
    // Impulse low L = most recent swing low; H = the LOCAL impulse origin (highest swing high
    // within impulseLookback bars before L — not the global max, which inflated the move).
    const L = lows[lows.length - 1];
    const priorHighs = highs.filter((h) => h.i < L.i && (L.i - h.i) <= impulseLookback);
    if (!priorHighs.length) return null;
    const H = priorHighs.reduce((a, b) => (b.price > a.price ? b : a));
    if ((L.i - H.i) > impulseMaxBars) return null;         // impulse must be a steep recent leg
    const D = H.price - L.price;                           // impulse height = measured move
    if (!(D > 0) || D / atr < minImpulseAtr || D / atr > maxImpulseAtr) return null; // realistic impulse only

    // Pullback high PH = most recent swing high AFTER L that is a LOWER HIGH (below H).
    const after = highs.filter((h) => h.i > L.i && h.price < H.price);
    if (!after.length) return null;
    const PH = after[after.length - 1];
    if (lastIdx - PH.i > maxAgeBars) return null;          // pullback must be fresh
    if (!(PH.price > L.price)) return null;
    const retr = (PH.price - L.price) / D;                 // how far the bounce retraced the impulse
    if (retr < fibLow || retr > fibHigh) return null;      // healthy depth only (not shallow / not failed)

    if (!(PH.price >= bb.mid)) return null;                // room to fall (top/middle of "reality")
    if (price <= bb.lower) return null;                    // already out of reality down → expect bounce
    if (!(price < PH.price)) return null;                  // bounce stalling below the lower high
    if ((PH.price - price) > poiAtr * atr) return null;    // still near the entry zone (don't chase)
    if (!reversalCandle(c, prev, 'SELL')) return null;     // Phase 2 — a real rejection candle, not any down bar
    const microBreak = n(c.low) < n(prev.low);             // momentum resuming down (scoring bonus, not a gate)

    const entry = price;
    const stop = PH.price + 0.25 * atr;                    // just beyond the lower high / trend line
    const firstTarget = L.price;                           // realistic first objective = the impulse low
    const measuredTarget = L.price - D;                    // equal-leg projection = the TP3 runner
    const risk = stop - entry, reward = entry - firstTarget;
    if (!(risk > 0) || !(reward > 0)) return null;
    const rr = reward / risk;                              // RR to the REALISTIC first target (not the fantasy move)
    if (rr < minRR) return null;
    if (stopTooTight(risk, atr, pip, config)) return null;

    const ladder = tpLadder('SELL', entry, risk, measuredTarget); // TP1/TP2 = 1R/2R rungs, TP3 = measured move
    let score = 50;
    score += Math.min(15, Math.round((D / atr) * 2));      // impulse strength (capped)
    score += Math.min(10, Math.round((rr - minRR) * 4));   // realistic RR above the floor (capped — no fantasy)
    score += (retr >= fibSweetLow && retr <= fibSweetHigh) ? 8 : 3; // pullback depth quality
    if (PH.price >= bb.upper) score += 6; else if (PH.price >= (bb.mid + bb.upper) / 2) score += 3; // more room to fall
    if (lastIdx - PH.i <= 1) score += 6;                   // freshest leg
    if (microBreak) score += 5;                            // bounce already failing
    score += htfBonus;
    score = Math.max(40, Math.min(95, score));

    return {
      decision: 'SELL', score,
      grade: score >= 85 ? 'A+' : score >= 75 ? 'A' : score >= 65 ? 'B' : 'C',
      entry: r5(entry), stopLoss: r5(stop), ...ladder,
      riskRewardRatio: Math.round(rr * 100) / 100,
      reason: `Little Rizzy SELL: ${Math.round(retr * 100)}% pullback to lower high ${r5(PH.price)} after impulse ${r5(H.price)}→${r5(L.price)} (${(D / atr).toFixed(1)}×ATR); first target ${r5(firstTarget)}, measured move ${r5(measuredTarget)}${htfNote}`,
      barIso: c.time,
      meta: { swingHigh: r5(H.price), impulseLow: r5(L.price), pullbackHigh: r5(PH.price), measuredMove: r5(D), retrace: Math.round(retr * 100) / 100, firstTarget: r5(firstTarget), measuredTarget: r5(measuredTarget), bbMid: r5(bb.mid), bbUpper: r5(bb.upper), legAgeBars: lastIdx - PH.i, htf: htfAgree, h4Trend },
    };
  }

  // BUY (uptrend): impulse up (L → H, LOCAL origin), pullback to a HIGHER LOW (PL); TP3 = H + (H − L).
  const H = highs[highs.length - 1];
  const priorLows = lows.filter((l) => l.i < H.i && (H.i - l.i) <= impulseLookback);
  if (!priorLows.length) return null;
  const L = priorLows.reduce((a, b) => (b.price < a.price ? b : a));
  if ((H.i - L.i) > impulseMaxBars) return null;
  const D = H.price - L.price;
  if (!(D > 0) || D / atr < minImpulseAtr || D / atr > maxImpulseAtr) return null;

  const after = lows.filter((l) => l.i > H.i && l.price > L.price);
  if (!after.length) return null;
  const PL = after[after.length - 1];
  if (lastIdx - PL.i > maxAgeBars) return null;
  if (!(PL.price < H.price)) return null;
  const retr = (H.price - PL.price) / D;
  if (retr < fibLow || retr > fibHigh) return null;

  if (!(PL.price <= bb.mid)) return null;                  // room to rise
  if (price >= bb.upper) return null;                      // already out of reality up
  if (!(price > PL.price)) return null;                    // bounce-down stalling above the higher low
  if ((price - PL.price) > poiAtr * atr) return null;      // still near the entry zone
  if (!reversalCandle(c, prev, 'BUY')) return null;        // Phase 2 — real rejection candle
  const microBreak = n(c.high) > n(prev.high);

  const entry = price;
  const stop = PL.price - 0.25 * atr;
  const firstTarget = H.price;
  const measuredTarget = H.price + D;
  const risk = entry - stop, reward = firstTarget - entry;
  if (!(risk > 0) || !(reward > 0)) return null;
  const rr = reward / risk;
  if (rr < minRR) return null;
  if (stopTooTight(risk, atr, pip, config)) return null;

  const ladder = tpLadder('BUY', entry, risk, measuredTarget);
  let score = 50;
  score += Math.min(15, Math.round((D / atr) * 2));
  score += Math.min(10, Math.round((rr - minRR) * 4));
  score += (retr >= fibSweetLow && retr <= fibSweetHigh) ? 8 : 3;
  if (PL.price <= bb.lower) score += 6; else if (PL.price <= (bb.mid + bb.lower) / 2) score += 3;
  if (lastIdx - PL.i <= 1) score += 6;
  if (microBreak) score += 5;
  score += htfBonus;
  score = Math.max(40, Math.min(95, score));

  return {
    decision: 'BUY', score,
    grade: score >= 85 ? 'A+' : score >= 75 ? 'A' : score >= 65 ? 'B' : 'C',
    entry: r5(entry), stopLoss: r5(stop), ...ladder,
    riskRewardRatio: Math.round(rr * 100) / 100,
    reason: `Little Rizzy BUY: ${Math.round(retr * 100)}% pullback to higher low ${r5(PL.price)} after impulse ${r5(L.price)}→${r5(H.price)} (${(D / atr).toFixed(1)}×ATR); first target ${r5(firstTarget)}, measured move ${r5(measuredTarget)}${htfNote}`,
    barIso: c.time,
    meta: { swingLow: r5(L.price), impulseHigh: r5(H.price), pullbackLow: r5(PL.price), measuredMove: r5(D), retrace: Math.round(retr * 100) / 100, firstTarget: r5(firstTarget), measuredTarget: r5(measuredTarget), bbMid: r5(bb.mid), bbLower: r5(bb.lower), legAgeBars: lastIdx - PL.i, htf: htfAgree, h4Trend },
  };
}

// ── Stage classifier (Stan Weinstein / Ted Zack — Stage Analysis) ────────────
// Reads the 4-stage price cycle from SMA 10/20/30/40 + their slope + alignment. Used
// both by the Stage Analysis strategy AND (exported) as an advisory filter for the
// other strategies (e.g. "ICT BUY + Stage 2 = stronger"). Pure; needs ≥45 closes.
function smaOf(values, period, endIdx) {
  if (endIdx === undefined) endIdx = values.length - 1;
  if (endIdx + 1 < period || endIdx >= values.length) return null;
  let s = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) s += values[i];
  return s / period;
}
export function computeStage(candles) {
  if (!Array.isArray(candles) || candles.length < 45) return null;
  const closes = candles.map((c) => n(c.close)).filter((v) => Number.isFinite(v));
  if (closes.length < 45) return null;
  const last = closes.length - 1;
  const price = closes[last];
  const sma10 = smaOf(closes, 10), sma20 = smaOf(closes, 20), sma30 = smaOf(closes, 30), sma40 = smaOf(closes, 40);
  if ([sma10, sma20, sma30, sma40].some((v) => v === null)) return null;

  // Slope (rate of change) of the key 30/40 SMAs over the last 5 bars, as a fraction.
  const sma30Prev = smaOf(closes, 30, last - 5);
  const sma40Prev = smaOf(closes, 40, last - 5);
  const slope30 = sma30Prev ? (sma30 - sma30Prev) / sma30Prev : 0;
  const slope40 = sma40Prev ? (sma40 - sma40Prev) / sma40Prev : 0;
  // Longer-trend slope (≈20 bars) — distinguishes Stage 1 (basing after down) vs Stage 3 (topping after up).
  const sma40Long = smaOf(closes, 40, last - 20);
  const longSlope = sma40Long ? (sma40 - sma40Long) / sma40Long : 0;

  const bullStack = sma10 > sma20 && sma20 > sma30 && sma30 > sma40;
  const bearStack = sma10 < sma20 && sma20 < sma30 && sma30 < sma40;
  const aboveAll = price > sma10 && price > sma30 && price > sma40;
  const belowAll = price < sma10 && price < sma30 && price < sma40;

  let stage, label;
  if (aboveAll && bullStack && slope30 > 0) { stage = 2; label = 'Stage 2 — Advancing (uptrend)'; }
  else if (belowAll && bearStack && slope30 < 0) { stage = 4; label = 'Stage 4 — Declining (downtrend)'; }
  else if (longSlope >= 0) { stage = 3; label = 'Stage 3 — Topping (distribution / range)'; }
  else { stage = 1; label = 'Stage 1 — Basing (accumulation / range)'; }

  return { stage, label, price, sma10, sma20, sma30, sma40, slope30, slope40, longSlope, bullStack, bearStack, aboveAll, belowAll };
}

// ── Strategy 5: Stage Analysis (Ted Zack / Stan Weinstein) ───────────────────
// Trades ONLY the actionable stages: Stage 2 (advancing) → BUY, Stage 4 (declining) →
// SELL. Entry is the continuation pullback that bases near the 10-SMA and resumes the
// trend; stop beyond the 30/40-SMA stage support/resistance; measured target. Waits
// through Stage 1 (basing) and Stage 3 (topping) — the chop zones. HTF-aligned. Pure.
// Reversal / continuation candle confirmation at a pullback (engulfing, strong body, or pin).
// Shared by Stage Analysis and Little Rizzy — a real turn candle, not just any up/down bar.
function reversalCandle(c, prev, dir) {
  const o = n(c.open), cl = n(c.close), hi = n(c.high), lo = n(c.low);
  if (![o, cl, hi, lo].every(Number.isFinite)) return false;
  const range = hi - lo;
  if (!(range > 0)) return false;
  const body = Math.abs(cl - o);
  const lowerWick = Math.min(o, cl) - lo;
  const upperWick = hi - Math.max(o, cl);
  const po = prev ? n(prev.open) : null, pc = prev ? n(prev.close) : null;
  if (dir === 'BUY') {
    const bull = cl > o;
    const strongBody = bull && body >= range * 0.5;
    const pin = bull && lowerWick >= body * 1.5 && lowerWick >= range * 0.4;
    const engulf = bull && po !== null && pc !== null && pc < po && cl >= po && o <= pc;
    return strongBody || pin || engulf;
  }
  const bear = cl < o;
  const strongBodyD = bear && body >= range * 0.5;
  const pinD = bear && upperWick >= body * 1.5 && upperWick >= range * 0.4;
  const engulfD = bear && po !== null && pc !== null && pc > po && cl <= po && o >= pc;
  return strongBodyD || pinD || engulfD;
}

// 5) Multi-timeframe stage agreement. Computes the stage on the next-higher TF (ctx.htfCandles,
// supplied by the server) and reports whether it confirms, contradicts, or is neutral vs the
// signal direction. Graceful 'neutral' when no higher-TF candles are available.
function stageHtfAgreement(ctx, dir) {
  const htf = ctx && ctx.htfCandles;
  if (!Array.isArray(htf) || htf.length < 45) return 'neutral';
  const hs = computeStage(htf);
  if (!hs) return 'neutral';
  if (dir === 'BUY') {
    if (hs.stage === 4) return 'oppose';   // higher TF declining — don't buy into it
    if (hs.stage === 2) return 'agree';
    return 'neutral';
  }
  if (hs.stage === 2) return 'oppose';     // higher TF advancing — don't sell into it
  if (hs.stage === 4) return 'agree';
  return 'neutral';
}

function stageAnalysis(ctx) {
  const { candles, h4Trend = null, config = {}, pip = 0.0001 } = ctx;
  const minRR = config.minRR ?? 1.8;
  const pullbackAtr = config.pullbackAtr ?? 1.0;     // entry must sit within this many ATR of the 10-SMA (the surf line)
  const tpR = config.tpR ?? 2.5;
  const lookback = Math.max(2, config.pullbackLookback ?? 4); // bars to look back for the genuine dip to the surf line
  const minSlope = config.minSlope ?? 0.0006;        // 3) minimum 30-SMA slope (fraction over 5 bars) — skip flat drift
  const maxExtAtr = config.maxExtAtr ?? 1.2;         // 3) over-extension guard — skip entries this far past the 10-SMA
  const baseBars = Math.max(4, config.baseBars ?? 6);        // 5) consolidation length for a base-breakout
  const baseMaxAtr = config.baseMaxAtr ?? 1.6;               // 5) base range must be at most this tight (×ATR)
  const breakoutBufferAtr = config.breakoutBufferAtr ?? 0.05; // 5) close must clear the base edge by this much
  if (!Array.isArray(candles) || candles.length < 60) return null;

  const stage = computeStage(candles);
  if (!stage || (stage.stage !== 2 && stage.stage !== 4)) return null;   // act only in Stage 2 / 4
  const atr = atr14(candles);
  if (!(atr > 0)) return null;
  const lastIdx = candles.length - 1;
  const c = candles[lastIdx];
  const prev = candles[lastIdx - 1];
  const price = n(c.close);
  const dir = stage.stage === 2 ? 'BUY' : 'SELL';

  // 5) Multi-timeframe stage agreement — reject when the next-higher TF is in the opposite
  //    actionable stage; bonus when it confirms. Graceful no-op if no HTF candles supplied.
  const htfAgree = stageHtfAgreement(ctx, dir);
  if (htfAgree === 'oppose') return null;
  const htfBonus = htfAgree === 'agree' ? 6 : 0;
  const htfNote = htfAgree === 'agree' ? ' — HTF aligned' : '';

  // Recent pullback window (the bars leading into — and including — the signal bar).
  const window = candles.slice(Math.max(0, lastIdx - lookback), lastIdx + 1);
  const pullbackLow = Math.min(...window.map((b) => n(b.low)));
  const pullbackHigh = Math.max(...window.map((b) => n(b.high)));

  // Shared signal builder: enforces sane/min stop, computes the ladder, clamps & grades.
  const build = (decision, entry, stop, extraScore, reason) => {
    const risk = decision === 'BUY' ? entry - stop : stop - entry;
    if (!(risk > 0) || risk / atr > 6) return null;                      // sane stop distance
    if (stopTooTight(risk, atr, pip, config)) return null;
    const target = decision === 'BUY' ? entry + risk * tpR : entry - risk * tpR;
    const rr = tpR;
    if (!(rr >= minRR)) return null;
    const ladder = tpLadder(decision, entry, risk, target);
    let score = Math.max(40, Math.min(95, 55 + extraScore + htfBonus));
    return {
      decision, score,
      grade: score >= 85 ? 'A+' : score >= 75 ? 'A' : score >= 65 ? 'B' : 'C',
      entry: r5(entry), stopLoss: r5(stop), ...ladder,
      riskRewardRatio: Math.round(rr * 100) / 100,
      reason,
      barIso: c.time,
      meta: { stage: stage.stage, sma10: r5(stage.sma10), sma20: r5(stage.sma20), sma30: r5(stage.sma30), sma40: r5(stage.sma40), slope30: stage.slope30, h4Trend, htf: htfAgree },
    };
  };

  // ── BUY: Stage 2 continuation ──────────────────────────────────────────────
  const buyPullback = () => {
    if (h4Trend === 'BEARISH') return null;                              // don't fight a bearish HTF
    if (!stage.bullStack || stage.slope30 < minSlope) return null;       // 3) clear trend, not flat drift
    // 1) Precise pullback-and-reclaim: dipped to/through the 10-SMA, then closed back above it.
    if (!(pullbackLow <= stage.sma10) || !(price > stage.sma10)) return null;
    if (pullbackLow < stage.sma30) return null;                          // 3) healthy dip holds above 30-SMA
    if (price - stage.sma10 > maxExtAtr * atr) return null;              // 3) over-extension guard
    if (Math.abs(price - stage.sma10) > pullbackAtr * atr) return null;
    if (!reversalCandle(c, prev, 'BUY')) return null;               // 4) candle confirmation
    // 1) Higher-low structure (when we have two fractal lows to compare).
    const { lows } = fractalSwings(candles);
    const recentLow = lows.length ? lows[lows.length - 1].price : pullbackLow;
    const priorLow = lows.length >= 2 ? lows[lows.length - 2].price : null;
    if (priorLow !== null && !(recentLow > priorLow)) return null;       // demand a higher low
    const stop = Math.min(recentLow, pullbackLow) - 0.1 * atr;           // 2) tight structural stop
    let extra = 0;
    if (stage.aboveAll && stage.bullStack) extra += 10;
    extra += Math.min(15, Math.round(stage.slope30 * 2000));
    if (h4Trend === 'BULLISH') extra += 8;
    extra += Math.max(0, 8 - Math.round((Math.abs(price - stage.sma10) / atr) * 8));
    if (priorLow !== null && recentLow > priorLow) extra += 6;
    return build('BUY', price, stop, extra,
      `Stage 2 continuation: pulled back to 10-SMA ${r5(stage.sma10)} (held above 30-SMA ${r5(stage.sma30)}) and reclaimed with a bullish candle${priorLow !== null ? ' on a higher low' : ''}${htfNote}`);
  };

  // 5) Base-breakout: a tight consolidation above the 30-SMA that breaks out — the
  //    highest-precision continuation. Base = the bars before the signal bar.
  const buyBreakout = () => {
    if (h4Trend === 'BEARISH') return null;
    if (!stage.bullStack || stage.slope30 < minSlope) return null;
    const base = candles.slice(Math.max(0, lastIdx - baseBars), lastIdx); // excludes the current bar
    if (base.length < 4) return null;
    const baseHigh = Math.max(...base.map((b) => n(b.high)));
    const baseLow = Math.min(...base.map((b) => n(b.low)));
    if (!((baseHigh - baseLow) <= baseMaxAtr * atr)) return null;        // tight consolidation
    if (baseLow < stage.sma30) return null;                              // base sits above 30-SMA
    if (!(price > baseHigh + breakoutBufferAtr * atr)) return null;      // breakout close
    if (price - baseHigh > maxExtAtr * atr) return null;                 // don't chase the breakout
    if (!reversalCandle(c, prev, 'BUY')) return null;               // strong breakout candle
    const stop = baseLow - 0.1 * atr;                                    // beyond the base
    let extra = 0;
    if (stage.aboveAll && stage.bullStack) extra += 10;
    extra += Math.min(15, Math.round(stage.slope30 * 2000));
    if (h4Trend === 'BULLISH') extra += 8;
    extra += 6;                                                          // base-breakout precision
    return build('BUY', price, stop, extra,
      `Stage 2 base-breakout: ${base.length}-bar consolidation above 30-SMA ${r5(stage.sma30)} broke out above ${r5(baseHigh)} with a bullish candle${htfNote}`);
  };

  // ── SELL: Stage 4 continuation (mirror) ─────────────────────────────────────
  const sellPullback = () => {
    if (h4Trend === 'BULLISH') return null;
    if (!stage.bearStack || stage.slope30 > -minSlope) return null;
    if (!(pullbackHigh >= stage.sma10) || !(price < stage.sma10)) return null;
    if (pullbackHigh > stage.sma30) return null;
    if (stage.sma10 - price > maxExtAtr * atr) return null;
    if (Math.abs(price - stage.sma10) > pullbackAtr * atr) return null;
    if (!reversalCandle(c, prev, 'SELL')) return null;
    const { highs } = fractalSwings(candles);
    const recentHigh = highs.length ? highs[highs.length - 1].price : pullbackHigh;
    const priorHigh = highs.length >= 2 ? highs[highs.length - 2].price : null;
    if (priorHigh !== null && !(recentHigh < priorHigh)) return null;     // demand a lower high
    const stop = Math.max(recentHigh, pullbackHigh) + 0.1 * atr;
    let extra = 0;
    if (stage.belowAll && stage.bearStack) extra += 10;
    extra += Math.min(15, Math.round(Math.abs(stage.slope30) * 2000));
    if (h4Trend === 'BEARISH') extra += 8;
    extra += Math.max(0, 8 - Math.round((Math.abs(price - stage.sma10) / atr) * 8));
    if (priorHigh !== null && recentHigh < priorHigh) extra += 6;
    return build('SELL', price, stop, extra,
      `Stage 4 continuation: rallied to 10-SMA ${r5(stage.sma10)} (stayed below 30-SMA ${r5(stage.sma30)}) and rejected with a bearish candle${priorHigh !== null ? ' on a lower high' : ''}${htfNote}`);
  };

  const sellBreakout = () => {
    if (h4Trend === 'BULLISH') return null;
    if (!stage.bearStack || stage.slope30 > -minSlope) return null;
    const base = candles.slice(Math.max(0, lastIdx - baseBars), lastIdx);
    if (base.length < 4) return null;
    const baseHigh = Math.max(...base.map((b) => n(b.high)));
    const baseLow = Math.min(...base.map((b) => n(b.low)));
    if (!((baseHigh - baseLow) <= baseMaxAtr * atr)) return null;
    if (baseHigh > stage.sma30) return null;                             // base sits below 30-SMA
    if (!(price < baseLow - breakoutBufferAtr * atr)) return null;       // breakdown close
    if (baseLow - price > maxExtAtr * atr) return null;
    if (!reversalCandle(c, prev, 'SELL')) return null;
    const stop = baseHigh + 0.1 * atr;
    let extra = 0;
    if (stage.belowAll && stage.bearStack) extra += 10;
    extra += Math.min(15, Math.round(Math.abs(stage.slope30) * 2000));
    if (h4Trend === 'BEARISH') extra += 8;
    extra += 6;
    return build('SELL', price, stop, extra,
      `Stage 4 base-breakdown: ${base.length}-bar consolidation below 30-SMA ${r5(stage.sma30)} broke down below ${r5(baseLow)} with a bearish candle${htfNote}`);
  };

  if (dir === 'BUY') return buyPullback() || buyBreakout();
  return sellPullback() || sellBreakout();
}

// ── Candlestick pattern library ──────────────────────────────────────────────
// Pure detector. Returns the strongest BULLISH and BEARISH pattern found on the last
// 1–3 closed candles (weight = reliability), plus a neutral-doji flag. A neutral doji
// is NEVER directional on its own — it only marks indecision. Directional dojis
// (dragonfly = bullish, gravestone = bearish) count, but weakly.
function candleParts(c) {
  const o = n(c.open), cl = n(c.close), hi = n(c.high), lo = n(c.low);
  const range = hi - lo, body = Math.abs(cl - o);
  return { o, cl, hi, lo, range, body, upper: hi - Math.max(o, cl), lower: Math.min(o, cl) - lo, bull: cl > o, bear: cl < o };
}
export function detectCandlePatterns(candles) {
  const i = candles.length - 1;
  if (i < 2) return { bull: null, bear: null, doji: false };
  const c0 = candleParts(candles[i]), c1 = candleParts(candles[i - 1]), c2 = candleParts(candles[i - 2]);
  if (!(c0.range > 0)) return { bull: null, bear: null, doji: false };
  const bulls = [], bears = [];
  const doji = c0.body <= c0.range * 0.1;

  // Single-candle
  if (doji && c0.lower >= c0.range * 0.6 && c0.upper <= c0.range * 0.15) bulls.push({ name: 'dragonfly doji', weight: 4 });
  if (doji && c0.upper >= c0.range * 0.6 && c0.lower <= c0.range * 0.15) bears.push({ name: 'gravestone doji', weight: 4 });
  if (c0.body > 0 && c0.lower >= c0.body * 2 && c0.upper <= c0.body * 0.8) bulls.push({ name: 'hammer / bullish pin', weight: 6 });
  if (c0.body > 0 && c0.upper >= c0.body * 2 && c0.lower <= c0.body * 0.8) bears.push({ name: 'shooting star / bearish pin', weight: 6 });
  if (c0.bull && c0.body >= c0.range * 0.8) bulls.push({ name: 'strong bullish candle', weight: 5 });
  if (c0.bear && c0.body >= c0.range * 0.8) bears.push({ name: 'strong bearish candle', weight: 5 });

  // Two-candle (current vs previous)
  if (c0.bull && c1.bear && c0.cl >= c1.o && c0.o <= c1.cl && c0.body > c1.body) bulls.push({ name: 'bullish engulfing', weight: 8 });
  if (c0.bear && c1.bull && c0.cl <= c1.o && c0.o >= c1.cl && c0.body > c1.body) bears.push({ name: 'bearish engulfing', weight: 8 });
  const mid1 = (c1.o + c1.cl) / 2;
  if (c0.bull && c1.bear && c0.o <= c1.lo && c0.cl > mid1 && c0.cl < c1.o) bulls.push({ name: 'piercing line', weight: 6 });
  if (c0.bear && c1.bull && c0.o >= c1.hi && c0.cl < mid1 && c0.cl > c1.o) bears.push({ name: 'dark cloud cover', weight: 6 });
  const tol = c0.range * 0.1;
  if (c0.bull && c1.bear && Math.abs(c0.lo - c1.lo) <= tol) bulls.push({ name: 'tweezer bottom', weight: 5 });
  if (c0.bear && c1.bull && Math.abs(c0.hi - c1.hi) <= tol) bears.push({ name: 'tweezer top', weight: 5 });

  // Three-candle stars
  const c1Small = c1.body <= c1.range * 0.4;
  if (c2.bear && c2.body >= c2.range * 0.5 && c1Small && c0.bull && c0.cl >= (c2.o + c2.cl) / 2) bulls.push({ name: 'morning star', weight: 9 });
  if (c2.bull && c2.body >= c2.range * 0.5 && c1Small && c0.bear && c0.cl <= (c2.o + c2.cl) / 2) bears.push({ name: 'evening star', weight: 9 });

  const best = (arr) => (arr.length ? arr.reduce((a, b) => (b.weight > a.weight ? b : a)) : null);
  return { bull: best(bulls), bear: best(bears), doji };
}

// ── Strategy 6: Swing Structure Candles ──────────────────────────────────────
// Reads the swing skeleton (HH/HL = uptrend, LH/LL = downtrend), ranks its strength by the
// number of confirming swings (2 = weak/early, 3 = preferred, 4+ = strongest with an
// over-extension guard), then fires a DIRECTION on a candlestick trigger:
//   • Continuation — in an uptrend, a bullish trigger at a pullback to the latest higher
//     low → BUY (mirror: bearish trigger at the latest lower high in a downtrend → SELL).
//   • Reversal — a strong bearish trigger rejecting a fresh higher high → SELL (mirror:
//     strong bullish trigger at a fresh lower low → BUY); countertrend, needs a strong pattern.
// 2-swing structures fire only on a strong pattern (engulfing/star). A volatility-contraction
// read (tight base / inside bar before the trigger) adds a quality bonus and tucks the stop to
// the base. Every setup is then confirmed top-down against the next LOWER timeframe (ltfVerdict):
// CONTRADICT → skip, CONFIRM → small score bump, NEUTRAL/MISSING → allowed only if the main score is strong.
// Stop beyond the swing (+ATR buffer), TP1/TP2 = 1R/2R, TP3 = opposing swing / measured move. Min 1.8R. Pure.
function risingTail(arr) {
  if (!arr.length) return 0;
  let k = 1;
  for (let i = arr.length - 1; i > 0; i--) { if (arr[i].price > arr[i - 1].price) k++; else break; }
  return k;
}
function fallingTail(arr) {
  if (!arr.length) return 0;
  let k = 1;
  for (let i = arr.length - 1; i > 0; i--) { if (arr[i].price < arr[i - 1].price) k++; else break; }
  return k;
}
function avgLeg(arr, count) {
  if (arr.length < 2) return 0;
  const tail = arr.slice(-Math.max(2, count));
  let s = 0, k = 0;
  for (let i = 1; i < tail.length; i++) { s += Math.abs(tail[i].price - tail[i - 1].price); k++; }
  return k ? s / k : 0;
}
// Volatility contraction before the trigger — the "really tight, narrow base" the swing
// pros wait for (contraction precedes expansion; works on any instrument, unlike stock
// gap/volume cues). Measures the price SPAN of the bars JUST BEFORE the trigger candle
// (excludes the trigger itself, which is usually a wide breakout/rejection bar) vs ATR,
// and flags an inside bar tightening into the trigger. Pure; returns the base extremes so
// the caller can tuck the stop to the base (tighter stop → better RR, same target).
function baseContraction(candles, atr, { contractionWindow = 5, contractionAtr = 1.5 } = {}) {
  const len = candles.length;
  if (len < contractionWindow + 2 || !(atr > 0)) return { contracted: false, ratio: null, insideBar: false, baseLow: null, baseHigh: null };
  const win = candles.slice(len - 1 - contractionWindow, len - 1); // bars before the trigger
  let hi = -Infinity, lo = Infinity;
  for (const k of win) { hi = Math.max(hi, n(k.high)); lo = Math.min(lo, n(k.low)); }
  const span = hi - lo;
  const ratio = span > 0 ? span / atr : Infinity;
  const tight = span > 0 && ratio <= contractionAtr;
  const a = candles[len - 2], b = candles[len - 3];           // bar before trigger inside its prior?
  const insideBar = !!(a && b && n(a.high) <= n(b.high) && n(a.low) >= n(b.low));
  return { contracted: tight || insideBar, ratio: Number.isFinite(ratio) ? Math.round(ratio * 100) / 100 : null, insideBar, baseLow: lo, baseHigh: hi };
}

// Flat-base / equal-highs (equal-lows) breakout with a CONFIRMED CLOSE beyond the level.
// The swing pros' "the strongest charts break a horizontal level and don't retest", fused
// with the candle-pattern rule that a break is only real once a candle CLOSES beyond the
// level (a wick-through that closes back inside is a trap) and the breakout bar isn't a
// big-momentum climax candle (those trap FOMO entries). Reuses detectLiquidityPools for the
// equal-level shelf (touches ≥ 2) and targets the next draw on liquidity. Returns a breakout
// descriptor { decision, stop, target, pat, level, strength } or null. Pure.
function flatBaseBreakout(candles, atr, pools, h4Trend, config) {
  const { breakoutBufferAtr = 0.05, breakoutMaxChaseAtr = 1.0, breakoutClimaxAtr = 2.2, breakoutBaseLookback = 20 } = config;
  const len = candles.length;
  if (!pools || len < breakoutBaseLookback + 2 || !(atr > 0)) return null;
  const c = candles[len - 1], prev = candles[len - 2];
  const close = n(c.close), open = n(c.open), hi = n(c.high), lo = n(c.low);
  if (hi - lo > breakoutClimaxAtr * atr) return null;          // anti-climax: skip the big-momentum trap candle
  const win = candles.slice(len - 1 - breakoutBaseLookback, len - 1);
  let baseHigh = -Infinity, baseLow = Infinity;
  for (const k of win) { baseHigh = Math.max(baseHigh, n(k.high)); baseLow = Math.min(baseLow, n(k.low)); }
  const prevClose = n(prev.close);

  // BUY: confirmed close above an equal-high shelf (flat top) we were consolidating under.
  if (close > open && h4Trend !== 'BEARISH') {
    const pool = (pools.buySide || []).filter((p) => p.equal && p.price < close && p.price <= baseHigh + 0.1 * atr)
      .sort((a, b) => b.price - a.price)[0];                    // highest equal-high below the close = the broken resistance
    if (pool) {
      const beyond = close - pool.price;
      if (beyond >= breakoutBufferAtr * atr && beyond <= breakoutMaxChaseAtr * atr && prevClose <= pool.price + 0.1 * atr) {
        const stop = Math.min(baseLow, lo) - 0.3 * atr;
        const target = (pools.targetAbove && pools.targetAbove.price > close) ? pools.targetAbove.price : null;
        return { decision: 'BUY', stop, target, level: pool.price, pat: { name: 'confirmed-close breakout (equal highs)', weight: 7 } };
      }
    }
  }
  // SELL: mirror — confirmed close below an equal-low shelf (flat bottom).
  if (close < open && h4Trend !== 'BULLISH') {
    const pool = (pools.sellSide || []).filter((p) => p.equal && p.price > close && p.price >= baseLow - 0.1 * atr)
      .sort((a, b) => a.price - b.price)[0];                    // lowest equal-low above the close = the broken support
    if (pool) {
      const beyond = pool.price - close;
      if (beyond >= breakoutBufferAtr * atr && beyond <= breakoutMaxChaseAtr * atr && prevClose >= pool.price - 0.1 * atr) {
        const stop = Math.max(baseHigh, hi) + 0.3 * atr;
        const target = (pools.targetBelow && pools.targetBelow.price < close) ? pools.targetBelow.price : null;
        return { decision: 'SELL', stop, target, level: pool.price, pat: { name: 'confirmed-close breakdown (equal lows)', weight: 7 } };
      }
    }
  }
  return null;
}

// Lower-timeframe confirmation for the swing setup. Reuses the SAME swing + candle
// detectors on the next-lower TF (e.g. M5 for an M15 setup) and grades whether the
// lower TF's micro-structure/trigger AGREES with the proposed direction:
//   CONFIRM    — lower TF is forming structure in-direction (rising lows for BUY /
//                falling highs for SELL) OR shows an in-direction candle trigger.
//   CONTRADICT — lower TF shows a strong opposite trigger or a fresh opposite break.
//   NEUTRAL    — neither; lower TF is undecided.
//   MISSING    — no/insufficient lower-TF data (caller decides strict vs lenient).
// Pure. Only reads candles up to the latest closed bar, so no lookahead vs the main TF.
function ltfVerdict(decision, ltfCandles) {
  if (!Array.isArray(ltfCandles) || ltfCandles.length < 30) return 'MISSING';
  const { highs, lows } = fractalSwings(ltfCandles);
  if (highs.length < 2 || lows.length < 2) return 'NEUTRAL';
  const pat = detectCandlePatterns(ltfCandles);
  const up = Math.min(risingTail(highs), risingTail(lows));     // forming HH+HL
  const down = Math.min(fallingTail(highs), fallingTail(lows));  // forming LH+LL
  const lastLow = lows[lows.length - 1].price;
  const prevLow = lows[lows.length - 2].price;
  const lastHigh = highs[highs.length - 1].price;
  const prevHigh = highs[highs.length - 2].price;
  if (decision === 'BUY') {
    const strongBear = pat.bear && pat.bear.weight >= 6;
    const freshLowerLow = lastLow < prevLow && down >= 2;
    if (strongBear || freshLowerLow) return 'CONTRADICT';
    const risingStructure = up >= 2 || lastLow > prevLow;
    if (risingStructure || (pat.bull && pat.bull.weight >= 5)) return 'CONFIRM';
    return 'NEUTRAL';
  }
  // SELL (mirror)
  const strongBull = pat.bull && pat.bull.weight >= 6;
  const freshHigherHigh = lastHigh > prevHigh && up >= 2;
  if (strongBull || freshHigherHigh) return 'CONTRADICT';
  const fallingStructure = down >= 2 || lastHigh < prevHigh;
  if (fallingStructure || (pat.bear && pat.bear.weight >= 5)) return 'CONFIRM';
  return 'NEUTRAL';
}

function swingStructureCandles(ctx) {
  const { candles, h4Trend = null, config = {}, pip = 0.0001, ltfCandles = null, ltfTimeframe = null } = ctx;
  const minRR = config.minRR ?? 1.8;
  const minSwings = Math.max(2, config.minSwings ?? 2);
  const nearAtr = config.nearAtr ?? 1.5;        // entry must be within this many ATR of the swing pivot (no chasing)
  const overextAtr = config.overextAtr ?? 3.0;  // 4+ swing over-extension guard
  const tpR = config.tpR ?? 2.5;
  if (!Array.isArray(candles) || candles.length < 60) return null;
  const atr = atr14(candles);
  if (!(atr > 0)) return null;
  const { highs, lows } = fractalSwings(candles);
  if (highs.length < 2 || lows.length < 2) return null;

  const lastIdx = candles.length - 1;
  const c = candles[lastIdx];
  const price = n(c.close);
  const patterns = detectCandlePatterns(candles);
  const contraction = baseContraction(candles, atr, config); // tight base before the trigger?
  const pools = (config.breakoutEnabled ?? true) ? detectLiquidityPools(candles) : null; // equal-high/low shelves

  const upStrength = Math.min(risingTail(highs), risingTail(lows));     // confirming HH+HL swings
  const downStrength = Math.min(fallingTail(highs), fallingTail(lows)); // confirming LH+LL swings
  const latestHigh = highs[highs.length - 1];
  const latestLow = lows[lows.length - 1];

  // Shared builder: enforce sane/min stop & RR, compute the ladder, score & grade.
  const build = (decision, entry, stop, finalTarget, strength, pat, kind, locScore) => {
    let risk = decision === 'BUY' ? entry - stop : stop - entry;
    if (!(risk > 0) || risk / atr > 8) return null;
    if (stopTooTight(risk, atr, pip, config)) return null;
    // Tight base → tuck the stop to the base extreme if that's tighter, still tradable, and
    // keeps RR (same target). Mirrors the pro "stop at low of day" on a narrow breakout.
    if (contraction.contracted && (config.contractionTightenStop ?? true)) {
      const tightStop = decision === 'BUY' ? contraction.baseLow - 0.1 * atr : contraction.baseHigh + 0.1 * atr;
      const tightRisk = decision === 'BUY' ? entry - tightStop : tightStop - entry;
      if (tightRisk > 0 && tightRisk < risk && !stopTooTight(tightRisk, atr, pip, config)
        && Math.abs(finalTarget - entry) / tightRisk >= minRR) {
        stop = tightStop; risk = tightRisk;
      }
    }
    const rr = Math.abs(finalTarget - entry) / risk;
    if (!(rr >= minRR)) return null;
    // ── Lower-timeframe confirmation gate (top-down: main-TF setup → LTF timing) ──
    const ltfReq = config.ltfRequired ?? true;
    const verdict = ltfVerdict(decision, ltfCandles);
    if (verdict === 'CONTRADICT') return null;              // LTF disagrees → skip
    if (verdict === 'MISSING' && ltfReq) return null;       // strict: no LTF data → skip
    const ladder = tpLadder(decision, entry, risk, finalTarget);
    let score = 52;
    score += strength >= 4 ? 14 : strength === 3 ? 10 : 4;             // swing-strength ranking
    score += Math.min(14, Math.round((pat?.weight ?? 0) * 1.5));       // pattern reliability
    score += locScore;                                                 // location (near the pivot)
    const leg = decision === 'BUY' ? avgLeg(lows, strength + 1) : avgLeg(highs, strength + 1);
    score += Math.min(6, Math.round(leg / atr));                       // bigger swing legs = stronger
    if ((decision === 'BUY' && h4Trend === 'BULLISH') || (decision === 'SELL' && h4Trend === 'BEARISH')) score += 6;
    if (kind.startsWith('reversal')) score -= 4;                       // countertrend discount
    if (verdict === 'CONFIRM') score += (config.ltfConfirmBonus ?? 6); // LTF agrees → modest bump
    if (contraction.contracted) score += (config.contractionBonus ?? 6) + (contraction.insideBar ? 2 : 0); // coiled base → expansion edge
    score = Math.max(40, Math.min(95, score));
    // NEUTRAL (or MISSING when not strict): allow only if the main setup is strong on its own.
    if ((verdict === 'NEUTRAL' || verdict === 'MISSING') && score < (config.ltfNeutralFloor ?? 70)) return null;
    const setup = kind === 'breakout'
      ? `Breakout: confirmed close ${decision === 'BUY' ? 'above equal-highs' : 'below equal-lows'} flat base`
      : kind === 'continuation'
        ? `Continuation: ${strength}-swing ${decision === 'BUY' ? 'uptrend' : 'downtrend'} structure, ${decision === 'BUY' ? 'higher-low pullback' : 'lower-high pullback'}`
        : `Reversal: ${strength}-swing ${decision === 'BUY' ? 'downtrend' : 'uptrend'} structure, ${decision === 'BUY' ? 'lower-low rejection' : 'higher-high rejection'}`;
    return {
      decision, score,
      grade: score >= 85 ? 'A+' : score >= 75 ? 'A' : score >= 65 ? 'B' : 'C',
      entry: r5(entry), stopLoss: r5(stop), ...ladder,
      riskRewardRatio: Math.round(rr * 100) / 100,
      reason: `${setup} + ${pat?.name}${contraction.contracted ? ` · tight base${contraction.insideBar ? ' (inside bar)' : ''}` : ''} · ${ltfTimeframe || 'LTF'} ${verdict.toLowerCase()}`,
      barIso: c.time,
      meta: { v: 2, kind, strength, pattern: pat?.name, patternWeight: pat?.weight, upStrength, downStrength, latestHigh: r5(latestHigh.price), latestLow: r5(latestLow.price), h4Trend, ltf: { timeframe: ltfTimeframe, verdict }, contraction: { contracted: contraction.contracted, ratio: contraction.ratio, insideBar: contraction.insideBar } },
    };
  };

  // ── UPTREND structure (HH + HL) ──
  if (upStrength >= minSwings && upStrength >= downStrength) {
    // Continuation BUY: pullback near the latest higher low + bullish trigger.
    if (h4Trend !== 'BEARISH') {
      const pat = patterns.bull;
      const nearHL = price >= latestLow.price && (price - latestLow.price) <= nearAtr * atr;
      const strongOnly = upStrength < 3;                              // 2-swing needs a strong pattern
      const overext = upStrength >= 4 && (price - latestLow.price) > overextAtr * atr;
      if (nearHL && pat && (!strongOnly || pat.weight >= 8) && !overext) {
        const stop = latestLow.price - 0.3 * atr;
        const target = Math.max(latestHigh.price, price + (price - stop) * tpR);
        const locScore = Math.max(0, 6 - Math.round(((price - latestLow.price) / atr) * 4));
        const sig = build('BUY', price, stop, target, upStrength, pat, 'continuation', locScore);
        if (sig) return sig;
      }
    }
    // Reversal SELL: strong bearish trigger rejecting a fresh higher high.
    const patB = patterns.bear;
    const nearHH = n(c.high) >= latestHigh.price || Math.abs(latestHigh.price - price) <= nearAtr * atr;
    if (nearHH && patB && patB.weight >= 6) {
      const stop = Math.max(n(c.high), latestHigh.price) + 0.3 * atr;
      const target = Math.min(latestLow.price, price - (stop - price) * minRR);
      const locScore = Math.max(0, 6 - Math.round((Math.abs(latestHigh.price - price) / atr) * 4));
      const sig = build('SELL', price, stop, target, upStrength, patB, 'reversal-sell', locScore);
      if (sig) return sig;
    }
  }

  // ── DOWNTREND structure (LH + LL) ──
  if (downStrength >= minSwings && downStrength >= upStrength) {
    // Continuation SELL: pullback near the latest lower high + bearish trigger.
    if (h4Trend !== 'BULLISH') {
      const pat = patterns.bear;
      const nearLH = price <= latestHigh.price && (latestHigh.price - price) <= nearAtr * atr;
      const strongOnly = downStrength < 3;
      const overext = downStrength >= 4 && (latestHigh.price - price) > overextAtr * atr;
      if (nearLH && pat && (!strongOnly || pat.weight >= 8) && !overext) {
        const stop = latestHigh.price + 0.3 * atr;
        const target = Math.min(latestLow.price, price - (stop - price) * tpR);
        const locScore = Math.max(0, 6 - Math.round(((latestHigh.price - price) / atr) * 4));
        const sig = build('SELL', price, stop, target, downStrength, pat, 'continuation', locScore);
        if (sig) return sig;
      }
    }
    // Reversal BUY: strong bullish trigger at a fresh lower low.
    const patBull = patterns.bull;
    const nearLL = n(c.low) <= latestLow.price || Math.abs(price - latestLow.price) <= nearAtr * atr;
    if (nearLL && patBull && patBull.weight >= 6) {
      const stop = Math.min(n(c.low), latestLow.price) - 0.3 * atr;
      const target = Math.max(latestHigh.price, price + (price - stop) * minRR);
      const locScore = Math.max(0, 6 - Math.round((Math.abs(price - latestLow.price) / atr) * 4));
      const sig = build('BUY', price, stop, target, downStrength, patBull, 'reversal-buy', locScore);
      if (sig) return sig;
    }
  }

  // ── FLAT-BASE / EQUAL-HIGHS(LOWS) BREAKOUT (confirmed close beyond the level) ──
  // Fallback after the swing-pullback / reversal setups: catches the consolidation breakout
  // they miss (price coils under a horizontal shelf, then CLOSES through it). The confirmed-
  // close + anti-climax rules live in flatBaseBreakout; HTF bias is enforced there too.
  if (pools) {
    const bo = flatBaseBreakout(candles, atr, pools, h4Trend, config);
    if (bo) {
      const risk0 = bo.decision === 'BUY' ? price - bo.stop : bo.stop - price;
      if (risk0 > 0) {
        let finalTarget = bo.decision === 'BUY' ? price + risk0 * tpR : price - risk0 * tpR;
        if (Number.isFinite(bo.target)) finalTarget = bo.decision === 'BUY' ? Math.max(finalTarget, bo.target) : Math.min(finalTarget, bo.target);
        const strength = Math.max(2, bo.decision === 'BUY' ? upStrength : downStrength);
        const sig = build(bo.decision, price, bo.stop, finalTarget, strength, bo.pat, 'breakout', 4);
        if (sig) return sig;
      }
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// SMC ENGINES — Smart Money Concepts (course distillation). SMC reduces to three
// concepts: market structure, liquidity, and the fair value gap. None of the
// engines above use the FVG (the course's most-emphasised concept), so these add
// it plus the two frameworks built on it: the Market Makers Model (external↔
// internal) and Candle Continuity. Pure, self-contained, deduped vs the above.
// ═══════════════════════════════════════════════════════════════════════════

// Most recent CONFIRMED sweep + reclaim ("no sweep, no trade"): a fractal swing a
// later bar pierced, then a bar CLOSED back inside. dir 'BULLISH' = a low was swept
// (look BUY), 'BEARISH' = a high (look SELL). extreme = the wick beyond the level.
function smcRecentSweep(candles, { lookback = 50 } = {}) {
  const { highs, lows } = fractalSwings(candles);
  const last = candles.length - 1;
  let best = null;
  const scan = (points, side) => {
    for (const p of points) {
      for (let j = p.i + 1; j < candles.length; j++) {
        const pierced = side === 'low' ? n(candles[j].low) < p.price : n(candles[j].high) > p.price;
        if (!pierced) continue;
        for (let k = j; k < candles.length; k++) {
          const reclaimed = side === 'low' ? n(candles[k].close) > p.price : n(candles[k].close) < p.price;
          if (reclaimed) {
            if (last - k <= lookback && (!best || k > best.reclaimIdx)) {
              let ext = side === 'low' ? Infinity : -Infinity;
              for (let m = j; m <= k; m++) ext = side === 'low' ? Math.min(ext, n(candles[m].low)) : Math.max(ext, n(candles[m].high));
              best = { dir: side === 'low' ? 'BULLISH' : 'BEARISH', sweepLevel: r5(p.price), sweepIdx: j, reclaimIdx: k, reclaimIso: candles[k].time, extreme: r5(ext) };
            }
            break;
          }
        }
        break;
      }
    }
  };
  scan(lows, 'low');
  scan(highs, 'high');
  return best;
}

// Freshest displacement fair value gap in `dir`, created at/after sinceIdx.
// Bullish FVG: candle3.low > candle1.high (gap below price). low/high = gap edges.
function smcFreshFvg(candles, dir, atr, { sinceIdx = 0, minDispAtr = 0.6 } = {}) {
  const lastIdx = candles.length - 1;
  let best = null;
  for (let i = Math.max(sinceIdx, 2); i <= lastIdx; i++) {
    const c1 = candles[i - 2], c2 = candles[i - 1], c3 = candles[i];
    const bull = n(c3.low) > n(c1.high) && n(c2.close) > n(c2.open);
    const bear = n(c3.high) < n(c1.low) && n(c2.close) < n(c2.open);
    if (dir === 'BULLISH' ? !bull : !bear) continue;
    const disp = Math.abs(n(c2.close) - n(c2.open)) / (atr || 1);
    if (disp < minDispAtr) continue;
    const low = dir === 'BULLISH' ? n(c1.high) : n(c3.high);
    const high = dir === 'BULLISH' ? n(c3.low) : n(c1.low);
    best = { low: r5(low), high: r5(high), mid: r5((low + high) / 2), createIdx: i, createIso: c3.time, dispAtr: Math.round(disp * 100) / 100 };
  }
  return best;
}

// Dealing range = the most recent fractal swing high & low (external liquidity).
function smcDealingRange(candles) {
  const { highs, lows } = fractalSwings(candles);
  if (!highs.length || !lows.length) return null;
  const hi = highs[highs.length - 1], lo = lows[lows.length - 1];
  const high = Math.max(hi.price, lo.price), low = Math.min(hi.price, lo.price);
  if (!(high > low)) return null;
  return { high: r5(high), low: r5(low), eq: r5((high + low) / 2), hiIdx: hi.i, loIdx: lo.i };
}

const smcGrade = (score) => (score >= 85 ? 'A+' : score >= 75 ? 'A' : score >= 65 ? 'B' : 'C');

// ── SMC 1: Fair Value Gap — sweep → displacement FVG (after the sweep) → 50% entry ──
function smcFvg(ctx) {
  const { candles, h4Trend = null, config = {}, pip = 0.0001 } = ctx;
  const minRR = config.minRR ?? 2;
  if (!Array.isArray(candles) || candles.length < 60) return null;
  const atr = atr14(candles); if (!atr) return null;

  const sweep = smcRecentSweep(candles, { lookback: config.sweepLookback ?? 50 });
  if (!sweep) return null;                                          // no sweep, no trade
  const dir = sweep.dir, decision = dir === 'BULLISH' ? 'BUY' : 'SELL';
  if (h4Trend === 'BULLISH' && decision === 'SELL') return null;
  if (h4Trend === 'BEARISH' && decision === 'BUY') return null;

  const fvg = smcFreshFvg(candles, dir, atr, { sinceIdx: sweep.sweepIdx, minDispAtr: config.dispAtr ?? 0.6 });
  if (!fvg) return null;                                            // FVG must form AFTER the sweep
  const price = n(candles[candles.length - 1].close);
  if (dir === 'BULLISH' ? price <= fvg.mid : price >= fvg.mid) return null; // pullback still pending

  const buf = atr * (config.stopBufAtr ?? 0.2);
  const entry = fvg.mid;
  const stop = dir === 'BULLISH' ? sweep.extreme - buf : sweep.extreme + buf;
  const risk = Math.abs(entry - stop);
  if (stopTooTight(risk, atr, pip, config)) return null;

  const pools = detectLiquidityPools(candles);
  const tgt = dir === 'BULLISH' ? pools.targetAbove : pools.targetBelow;
  const target = tgt ? tgt.price : (dir === 'BULLISH' ? entry + 3 * risk : entry - 3 * risk);
  const rr = Math.round(Math.abs(target - entry) / risk * 100) / 100;
  if (!(rr >= minRR)) return null;

  const range = smcDealingRange(candles);
  const discountBuy = !!range && decision === 'BUY' && entry <= range.eq;
  const premiumSell = !!range && decision === 'SELL' && entry >= range.eq;

  let score = 50;
  score += Math.min(18, Math.round(fvg.dispAtr * 12));
  score += Math.min(15, Math.round((rr - minRR) * 5));
  if ((decision === 'BUY' && h4Trend === 'BULLISH') || (decision === 'SELL' && h4Trend === 'BEARISH')) score += 10;
  if (discountBuy || premiumSell) score += 8;
  if (tgt && tgt.equal) score += 5;
  score = Math.max(40, Math.min(95, score));

  const ladder = tpLadder(decision, entry, risk, target);
  return {
    decision, score, grade: smcGrade(score),
    entry: r5(entry), stopLoss: r5(stop), ...ladder, riskRewardRatio: rr,
    reason: `Sweep ${sweep.sweepLevel} reclaimed → FVG ${fvg.low}-${fvg.high} (disp ${fvg.dispAtr}×) → 50% @ ${r5(entry)}; draw ${tgt ? tgt.type + ' ' + tgt.price : '3R'}`,
    barIso: fvg.createIso,
    meta: { sweepLevel: sweep.sweepLevel, fvgLow: fvg.low, fvgHigh: fvg.high, dispAtr: fvg.dispAtr, location: discountBuy ? 'discount' : premiumSell ? 'premium' : 'mid' },
  };
}

// ── SMC 2: Market Makers Model — sweep the range extreme, enter a discount/premium
// FVG (smart-money reversal), target the OPPOSITE external extreme (orig. consolidation).
function smcMmxm(ctx) {
  const { candles, h4Trend = null, config = {}, pip = 0.0001 } = ctx;
  const minRR = config.minRR ?? 2.5;
  if (!Array.isArray(candles) || candles.length < 80) return null;
  const atr = atr14(candles); if (!atr) return null;

  const range = smcDealingRange(candles);
  if (!range) return null;
  const sweep = smcRecentSweep(candles, { lookback: config.sweepLookback ?? 60 });
  if (!sweep) return null;
  const dir = sweep.dir, decision = dir === 'BULLISH' ? 'BUY' : 'SELL';
  if (h4Trend === 'BULLISH' && decision === 'SELL') return null;
  if (h4Trend === 'BEARISH' && decision === 'BUY') return null;

  // Must have swept the RANGE extreme (external liquidity), not an internal swing.
  const tol = atr * (config.extremeTolAtr ?? 1.0);
  if (dir === 'BULLISH' ? Math.abs(sweep.sweepLevel - range.low) > tol : Math.abs(sweep.sweepLevel - range.high) > tol) return null;

  const fvg = smcFreshFvg(candles, dir, atr, { sinceIdx: sweep.sweepIdx, minDispAtr: config.dispAtr ?? 0.6 });
  if (!fvg) return null;
  const entry = fvg.mid;
  if (decision === 'BUY' ? entry > range.eq : entry < range.eq) return null; // discount/premium only
  const price = n(candles[candles.length - 1].close);
  if (dir === 'BULLISH' ? price <= entry : price >= entry) return null;

  const buf = atr * (config.stopBufAtr ?? 0.2);
  const stop = dir === 'BULLISH' ? sweep.extreme - buf : sweep.extreme + buf;
  const risk = Math.abs(entry - stop);
  if (stopTooTight(risk, atr, pip, config)) return null;

  const target = decision === 'BUY' ? range.high : range.low;   // opposite external extreme
  const rr = Math.round(Math.abs(target - entry) / risk * 100) / 100;
  if (!(rr >= minRR)) return null;

  let score = 52;
  score += Math.min(16, Math.round(fvg.dispAtr * 11));
  score += Math.min(15, Math.round((rr - minRR) * 4));
  if ((decision === 'BUY' && h4Trend === 'BULLISH') || (decision === 'SELL' && h4Trend === 'BEARISH')) score += 10;
  score += 6;                                                   // external-extreme sweep required
  score = Math.max(40, Math.min(95, score));

  const ladder = tpLadder(decision, entry, risk, target);
  return {
    decision, score, grade: smcGrade(score),
    entry: r5(entry), stopLoss: r5(stop), ...ladder, riskRewardRatio: rr,
    reason: `MMXM ${decision}: swept range ${dir === 'BULLISH' ? 'low' : 'high'} ${sweep.sweepLevel} → ${decision === 'BUY' ? 'discount' : 'premium'} FVG @ ${r5(entry)} → target ${decision === 'BUY' ? 'high' : 'low'} ${r5(target)}`,
    barIso: fvg.createIso,
    meta: { rangeHigh: range.high, rangeLow: range.low, eq: range.eq, sweepLevel: sweep.sweepLevel, dispAtr: fvg.dispAtr },
  };
}

// ── SMC 3: Candle Continuity — after a sweep establishes the draw, each candle
// follows the prior's direction; enter just beyond the OPENING price of the
// continuation candle, stop beyond the sweep extreme, target opposing liquidity.
function smcCct(ctx) {
  const { candles, h4Trend = null, config = {}, pip = 0.0001 } = ctx;
  const minRR = config.minRR ?? 2;
  if (!Array.isArray(candles) || candles.length < 60) return null;
  const atr = atr14(candles); if (!atr) return null;

  const sweep = smcRecentSweep(candles, { lookback: config.sweepLookback ?? 40 });
  if (!sweep) return null;
  const dir = sweep.dir, decision = dir === 'BULLISH' ? 'BUY' : 'SELL';
  if (h4Trend === 'BULLISH' && decision === 'SELL') return null;
  if (h4Trend === 'BEARISH' && decision === 'BUY') return null;
  if (candles.length - 1 - sweep.reclaimIdx > (config.maxAgeBars ?? 6)) return null; // draw must be fresh

  const last = candles.length - 1, c0 = candles[last], c1 = candles[last - 1];
  const cont = dir === 'BULLISH'
    ? (n(c0.close) > n(c0.open) && n(c1.close) > n(c1.open))
    : (n(c0.close) < n(c0.open) && n(c1.close) < n(c1.open));
  if (!cont) return null;                                       // two confirming closes in the draw direction

  const entry = n(c0.open);                                     // continuation-candle open
  const buf = atr * (config.stopBufAtr ?? 0.2);
  const stop = dir === 'BULLISH' ? sweep.extreme - buf : sweep.extreme + buf;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0) || stopTooTight(risk, atr, pip, config)) return null;

  const pools = detectLiquidityPools(candles);
  const tgt = dir === 'BULLISH' ? pools.targetAbove : pools.targetBelow;
  const target = tgt ? tgt.price : (dir === 'BULLISH' ? entry + 3 * risk : entry - 3 * risk);
  const rr = Math.round(Math.abs(target - entry) / risk * 100) / 100;
  if (!(rr >= minRR)) return null;

  const bodyAtr = Math.abs(n(c0.close) - n(c0.open)) / atr;
  let score = 48;
  score += Math.min(16, Math.round(bodyAtr * 12));
  score += Math.min(15, Math.round((rr - minRR) * 5));
  if ((decision === 'BUY' && h4Trend === 'BULLISH') || (decision === 'SELL' && h4Trend === 'BEARISH')) score += 10;
  if (tgt && tgt.equal) score += 5;
  score = Math.max(40, Math.min(95, score));

  const ladder = tpLadder(decision, entry, risk, target);
  return {
    decision, score, grade: smcGrade(score),
    entry: r5(entry), stopLoss: r5(stop), ...ladder, riskRewardRatio: rr,
    reason: `Candle continuity ${decision} after sweep ${sweep.sweepLevel}: ${dir === 'BULLISH' ? 'two bullish closes' : 'two bearish closes'} → enter open ${r5(entry)}; draw ${tgt ? tgt.type + ' ' + tgt.price : '3R'}`,
    barIso: c0.time,
    meta: { sweepLevel: sweep.sweepLevel, bodyAtr: Math.round(bodyAtr * 100) / 100 },
  };
}

// ── Session helpers (New York / ET, DST-aware via Intl) ──────────────────────
// The course's day-trading setups are anchored to New York time. We derive the ET
// wall-clock from each candle's UTC time so EST↔EDT is handled automatically.
function etMinutes(iso) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(iso));
  const h = Number(p.find((x) => x.type === 'hour').value) % 24;
  const m = Number(p.find((x) => x.type === 'minute').value);
  return h * 60 + m;
}
// Most recent candle that OPENS at the target ET minute-of-day (within tolerance).
function lastSessionOpen(candles, targetMin, tolMin = 8) {
  for (let i = candles.length - 1; i >= 0; i--) {
    if (Math.abs(etMinutes(candles[i].time) - targetMin) <= tolMin) return { idx: i, price: r5(n(candles[i].open)) };
  }
  return null;
}

// ── SMC 4: Two-Lines session reversal ────────────────────────────────────────
// Lines = the 17:00 and 00:00 (midnight) ET opens. Price above BOTH → sell-bias,
// below BOTH → buy-bias, between → no trade. Inside a kill zone, a weakness candle
// (a swing extreme it rejected) + a confirming opposite-side close fires: enter the
// 50% of the confirmation candle, stop beyond the weakness wick, fixed tpR target.
function smcTwoLines(ctx) {
  const { candles, config = {}, pip = 0.0001, h4Trend = null } = ctx;
  const tpR = config.tpR ?? 3;
  if (!Array.isArray(candles) || candles.length < 60) return null;
  const atr = atr14(candles); if (!atr) return null;

  const l17 = lastSessionOpen(candles, 17 * 60), l00 = lastSessionOpen(candles, 0);
  if (!l17 || !l00) return null;
  const last = candles.length - 1, conf = candles[last], weak = candles[last - 1];
  const price = n(conf.close);
  const above = price > l17.price && price > l00.price;
  const below = price < l17.price && price < l00.price;
  if (!above && !below) return null;                        // between the lines = stand aside

  const em = etMinutes(conf.time);
  const inKz = (em >= 120 && em <= 300) || (em >= 420 && em <= 600); // London 02–05, NY 07–10 ET
  if ((config.killZones ?? true) && !inKz) return null;

  const decision = below ? 'BUY' : 'SELL';
  const win = candles.slice(Math.max(0, last - 7), last - 1);
  let entry, stop;
  if (decision === 'BUY') {
    const priorLow = Math.min(...win.map((x) => n(x.low)));
    if (!(n(weak.low) <= priorLow)) return null;            // weakness took a recent low
    if (!(n(conf.close) > n(conf.open))) return null;       // confirmation closes bullish
    entry = r5((n(conf.high) + n(conf.low)) / 2);           // 50% of the confirmation candle
    stop = r5(n(weak.low) - atr * (config.stopBufAtr ?? 0.15));
  } else {
    const priorHigh = Math.max(...win.map((x) => n(x.high)));
    if (!(n(weak.high) >= priorHigh)) return null;
    if (!(n(conf.close) < n(conf.open))) return null;
    entry = r5((n(conf.high) + n(conf.low)) / 2);
    stop = r5(n(weak.high) + atr * (config.stopBufAtr ?? 0.15));
  }
  const risk = Math.abs(entry - stop);
  if (stopTooTight(risk, atr, pip, config)) return null;
  const target = decision === 'BUY' ? r5(entry + tpR * risk) : r5(entry - tpR * risk);

  const bodyAtr = Math.abs(n(conf.close) - n(conf.open)) / atr;
  let score = 50;
  score += Math.min(16, Math.round(bodyAtr * 12));
  score += Math.min(10, tpR * 2);
  if ((decision === 'BUY' && h4Trend === 'BULLISH') || (decision === 'SELL' && h4Trend === 'BEARISH')) score += 8;
  if (em >= 120 && em <= 300) score += 4;                   // London kill zone (best)
  score = Math.max(40, Math.min(95, score));

  const ladder = tpLadder(decision, entry, risk, target);
  return {
    decision, score, grade: smcGrade(score),
    entry, stopLoss: stop, ...ladder, riskRewardRatio: Math.round(Math.abs(target - entry) / risk * 100) / 100,
    reason: `Two-lines ${decision}: price ${below ? 'below' : 'above'} 17:00(${l17.price}) & 00:00(${l00.price}) → weakness + confirmation, enter 50% @ ${entry} (${tpR}R)`,
    barIso: conf.time,
    meta: { line17: l17.price, line00: l00.price, bias: below ? 'buy' : 'sell', etMin: em },
  };
}

// ── SMC 5: Asian Range Sweep ─────────────────────────────────────────────────
// The Asian range (ET 20:00–24:00) is liquidity. In the London manipulation window
// (01:30–05:00 ET) price sweeps the Asian high/low then reclaims — trade the reversal
// toward the OPPOSITE Asian extreme. Stop beyond the swept extreme, min RR.
function smcAsianSweep(ctx) {
  const { candles, config = {}, pip = 0.0001, h4Trend = null } = ctx;
  const minRR = config.minRR ?? 2;
  if (!Array.isArray(candles) || candles.length < 80) return null;
  const atr = atr14(candles); if (!atr) return null;

  const last = candles.length - 1;
  const em = etMinutes(candles[last].time);
  if ((config.windowOnly ?? true) && !(em >= 90 && em <= 300)) return null; // 01:30–05:00 ET

  // Asian range = high/low of the most recent ET 20:00–24:00 block (look back bounded).
  const look = config.asianLookback ?? 130;
  let aHigh = -Infinity, aLow = Infinity, found = 0;
  for (let i = last; i >= Math.max(0, last - look); i--) {
    if (etMinutes(candles[i].time) >= 20 * 60) { aHigh = Math.max(aHigh, n(candles[i].high)); aLow = Math.min(aLow, n(candles[i].low)); found++; }
    else if (found > 0) break;                              // exited the Asian block (contiguous)
  }
  if (found < 3 || !Number.isFinite(aHigh) || !Number.isFinite(aLow) || !(aHigh > aLow)) return null;

  // Sweep + reclaim of an Asian extreme within the last few bars.
  let decision = null, swept = null, ext = null;
  for (let i = last; i >= Math.max(0, last - (config.sweepScan ?? 14)); i--) {
    if (n(candles[i].high) > aHigh && n(candles[last].close) < aHigh) {
      decision = 'SELL'; swept = r5(aHigh); ext = Math.max(...candles.slice(i, last + 1).map((x) => n(x.high))); break;
    }
    if (n(candles[i].low) < aLow && n(candles[last].close) > aLow) {
      decision = 'BUY'; swept = r5(aLow); ext = Math.min(...candles.slice(i, last + 1).map((x) => n(x.low))); break;
    }
  }
  if (!decision) return null;

  const buf = atr * (config.stopBufAtr ?? 0.2);
  const entry = r5(n(candles[last].close));
  const stop = decision === 'BUY' ? r5(ext - buf) : r5(ext + buf);
  const risk = Math.abs(entry - stop);
  if (stopTooTight(risk, atr, pip, config)) return null;
  const target = decision === 'BUY' ? r5(aHigh) : r5(aLow);  // opposite Asian extreme
  const rr = Math.round(Math.abs(target - entry) / risk * 100) / 100;
  if (!(rr >= minRR)) return null;

  let score = 50;
  score += Math.min(15, Math.round((rr - minRR) * 5));
  if ((decision === 'BUY' && h4Trend === 'BULLISH') || (decision === 'SELL' && h4Trend === 'BEARISH')) score += 8;
  score += 6;                                                // manipulation-window sweep
  score = Math.max(40, Math.min(95, score));

  const ladder = tpLadder(decision, entry, risk, target);
  return {
    decision, score, grade: smcGrade(score),
    entry, stopLoss: stop, ...ladder, riskRewardRatio: rr,
    reason: `Asian sweep ${decision}: swept Asian ${decision === 'BUY' ? 'low' : 'high'} ${swept} in London window → target opposite extreme ${target}`,
    barIso: candles[last].time,
    meta: { asianHigh: r5(aHigh), asianLow: r5(aLow), sweptLevel: swept, etMin: em },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ICT+ — an IMPROVED ICT breaker. Does NOT touch the original `ict-breaker`
// (the live winner). Takes the same breaker base and stacks the course's A+
// filters: a fair-value-gap SNIPER entry (50% of the displacement gap instead of
// the breaker zone — tighter fill, better RR), a premium/discount gate, the
// "never take the first drive" second-drive gate, dual HTF (H4+H1) alignment, an
// equal-highs target, and a stacked-confluence floor. Higher RR bar, fewer/cleaner
// signals. Reuses smcDealingRange/smcGrade above.
// ═══════════════════════════════════════════════════════════════════════════
function ictPlus(ctx) {
  const { candles, h4Trend = null, h1Trend = null, config = {}, pip = 0.0001 } = ctx;
  const minRR = config.minRR ?? 3;
  const maxAgeBars = config.maxAgeBars ?? 3;
  const minConfluences = config.minConfluences ?? 4;
  if (!Array.isArray(candles) || candles.length < 80) return null;
  const atr = atr14(candles); if (!atr) return null;

  const breaker = detectBreaker(candles, { maxAgeBars: 50 });
  if (!breaker) return null;
  if (breaker.ageBars > maxAgeBars) return null;                 // fresh breaker only
  const disp = breaker.displacement;
  if (!disp || !disp.present) return null;                       // ICT+ REQUIRES the displacement FVG

  const dir = breaker.type, decision = dir === 'BULLISH' ? 'BUY' : 'SELL';
  if (h4Trend === 'BULLISH' && decision === 'SELL') return null; // HTF hard gate (same discipline)
  if (h4Trend === 'BEARISH' && decision === 'BUY') return null;

  // Improvement 1 — FVG sniper entry: the 50% of the displacement gap, not the breaker zone.
  const gapLow = Math.min(disp.gapLow, disp.gapHigh), gapHigh = Math.max(disp.gapLow, disp.gapHigh);
  const entry = r5((gapLow + gapHigh) / 2);
  const price = n(candles[candles.length - 1].close);
  if (dir === 'BULLISH' ? price <= entry : price >= entry) return null; // pullback still pending

  const stop = breaker.stop;                                     // beyond the sweep (robust anchor)
  const risk = Math.abs(entry - stop);
  if (!(risk > 0) || stopTooTight(risk, atr, pip, config)) return null;

  const pools = detectLiquidityPools(candles);
  const tgt = dir === 'BULLISH' ? pools.targetAbove : pools.targetBelow;
  const target = tgt ? tgt.price : (dir === 'BULLISH' ? entry + minRR * risk : entry - minRR * risk);
  const rr = Math.round(Math.abs(target - entry) / risk * 100) / 100;
  if (!(rr >= minRR)) return null;

  // ── Stacked confluences (the "+") ──
  const range = smcDealingRange(candles);
  const pdOk = !!range && (decision === 'BUY' ? entry <= range.eq : entry >= range.eq);   // discount/premium
  const secondDrive = !!detectSecondDrive(candles, dir).isSecondDrive;                    // never the first drive
  const htf4 = (decision === 'BUY' && h4Trend === 'BULLISH') || (decision === 'SELL' && h4Trend === 'BEARISH');
  const htf1 = (decision === 'BUY' && h1Trend === 'BULLISH') || (decision === 'SELL' && h1Trend === 'BEARISH');
  const strongDisp = disp.atrMultiple >= (config.strongDispAtr ?? 1.3);
  const equalTarget = !!(tgt && tgt.equal);
  const fresh = breaker.ageBars === 0;
  const confluences = [pdOk, secondDrive, htf4, htf1, strongDisp, equalTarget, fresh].filter(Boolean).length;
  if (confluences < minConfluences) return null;                 // only stacked, A-grade setups fire

  let score = 55;
  score += Math.min(16, Math.round(disp.atrMultiple * 8));
  score += Math.min(12, Math.round((rr - minRR) * 4));
  if (pdOk) score += 6;
  if (secondDrive) score += 6;
  if (htf4) score += 6;
  if (htf1) score += 4;
  if (equalTarget) score += 4;
  if (fresh) score += 3;
  score = Math.max(45, Math.min(98, score));

  const ladder = tpLadder(decision, entry, risk, target);
  return {
    decision, score, grade: smcGrade(score),
    entry, stopLoss: r5(stop), ...ladder, riskRewardRatio: rr,
    reason: `ICT+ ${dir} breaker → FVG 50% entry @ ${entry} (disp ${disp.atrMultiple}×, ${confluences} confluences${pdOk ? ', ' + (decision === 'BUY' ? 'discount' : 'premium') : ''}${secondDrive ? ', 2nd-drive' : ''}) → draw ${tgt ? tgt.type + ' ' + tgt.price : minRR + 'R'}`,
    barIso: breaker.confirmedIso,
    meta: {
      breakerType: breaker.type, sweepLevel: breaker.sweepLevel, structureLevel: breaker.structureLevel,
      fvgLow: r5(gapLow), fvgHigh: r5(gapHigh), dispAtr: disp.atrMultiple, confluences,
      pd: pdOk ? (decision === 'BUY' ? 'discount' : 'premium') : 'off', secondDrive, htf4, htf1, equalTarget,
    },
  };
}

// ── Strategy: 3-Candle Safety Check (Exhaustion → Indecision → Confirmation) ──
// "Don't trade single candles — trade a SEQUENCE that tells a story." Reads the last
// three CLOSED candles as an ordered combo and validates it through 5 context filters
// (structure, level, HTF momentum, session, volume). Two modes: REVERSAL (combo against
// the local move at a level) and CONTINUATION (HTF-aligned pullback that resumes). Pure;
// reuses detectCandlePatterns / fractalSwings / atr14 / tpLadder. Isolated lab strategy.
function isInsideBar(inner, outer) {
  return n(inner.high) <= n(outer.high) && n(inner.low) >= n(outer.low);
}
// Session quality from a candle's UTC hour. London 07–16, New York 12–21 (overlap = best);
// Asian (~21–07) is low-participation "retail noise" per the playbook.
function sessionQuality(timeIso) {
  const ms = Date.parse(timeIso);
  if (!Number.isFinite(ms)) return { session: 'UNKNOWN', score: 0 };
  const h = new Date(ms).getUTCHours();
  const london = h >= 7 && h < 16;
  const ny = h >= 12 && h < 21;
  if (london && ny) return { session: 'LONDON/NY', score: 8 };
  if (london || ny) return { session: london ? 'LONDON' : 'NEWYORK', score: 6 };
  return { session: 'ASIAN', score: -4 };
}
// Volume story. REVERSAL: confirmation volume expands (new direction takes control).
// CONTINUATION: pullback (c2,c1) quieter than the trend baseline, then confirmation explodes.
// Gracefully no-ops (ok:true, bonus:0) when the feed carries no usable volume.
function volumePattern(closed, kind, idxC0) {
  const vol = (c) => { const v = Number(c && c.volume); return Number.isFinite(v) && v > 0 ? v : null; };
  const c0v = vol(closed[idxC0]); const c1v = vol(closed[idxC0 - 1]); const c2v = vol(closed[idxC0 - 2]);
  const base = [];
  for (let k = Math.max(0, idxC0 - 12); k <= idxC0 - 3; k++) { const v = vol(closed[k]); if (v) base.push(v); }
  const avg = base.length ? base.reduce((a, b) => a + b, 0) / base.length : null;
  if (c0v == null || avg == null) return { ok: true, bonus: 0, note: 'no-vol-data' };
  if (kind === 'CONTINUATION') {
    const pb = [c2v, c1v].filter((v) => v != null);
    const pbAvg = pb.length ? pb.reduce((a, b) => a + b, 0) / pb.length : avg;
    const decreasing = pbAvg <= avg;
    const expanding = c0v >= avg * 1.1;
    let bonus = 0; if (decreasing) bonus += 4; if (expanding) bonus += 5;
    return { ok: expanding, bonus, note: `pullback${decreasing ? '↓' : '~'}·conf${expanding ? '↑' : '~'}` };
  }
  const increasing = c0v >= avg * 1.1;
  return { ok: increasing, bonus: increasing ? 6 : 0, note: `conf${increasing ? '↑' : '~'}` };
}

function threeCandleCombo(ctx) {
  const { candles, h4Trend = null, h1Trend = null, config = {}, pip = 0.0001 } = ctx;
  const minRR = config.minRR ?? 1.8;
  if (!Array.isArray(candles) || candles.length < 40) return null;
  const closed = candles;                 // lab feeds CLOSED bars; last = the just-closed confirmation
  const i = closed.length - 1;
  const atr = atr14(closed);
  if (!(atr > 0)) return null;

  const c0 = candleParts(closed[i]);      // confirmation
  const c1 = candleParts(closed[i - 1]);  // indecision
  const c2 = candleParts(closed[i - 2]);  // exhaustion
  if (!(c0.range > 0) || !(c1.range > 0) || !(c2.range > 0)) return null;

  // ── Step 1 — Exhaustion (c2): rejection wick / small body / spinning top ──
  const smallBody2 = c2.body <= c2.range * 0.4;
  const bearExhaust = smallBody2 && c2.upper >= c2.range * 0.4 && c2.upper >= c2.lower; // shooting-star-like → SELL bias
  const bullExhaust = smallBody2 && c2.lower >= c2.range * 0.4 && c2.lower >= c2.upper; // hammer-like → BUY bias
  const spin = smallBody2 && c2.upper >= c2.range * 0.25 && c2.lower >= c2.range * 0.25;
  if (!(bearExhaust || bullExhaust || spin)) return null;
  const exPat = detectCandlePatterns(closed.slice(0, i - 1)); // pattern read AT c2 (last of the slice)

  // ── Step 2 — Indecision (c1): doji / inside bar / small body ──
  const isDoji = c1.body <= c1.range * 0.1;
  const inside = isInsideBar(closed[i - 1], closed[i - 2]);
  const smallBody1 = c1.body <= c1.range * 0.4;
  if (!(isDoji || inside || smallBody1)) return null;
  const indecisionLabel = isDoji ? 'doji' : inside ? 'inside-bar' : 'small-body';

  // ── Step 3 — Confirmation (c0): strong body / engulfing / gap, taking out BOTH prior candles ──
  const confPat = detectCandlePatterns(closed);
  const priorHigh = Math.max(c1.hi, c2.hi);
  const priorLow = Math.min(c1.lo, c2.lo);
  const bullEngulf = !!(confPat.bull && confPat.bull.name === 'bullish engulfing');
  const bearEngulf = !!(confPat.bear && confPat.bear.name === 'bearish engulfing');
  const strongBull = c0.bull && c0.body >= c0.range * 0.6 && c0.upper <= c0.body * 0.6;
  const strongBear = c0.bear && c0.body >= c0.range * 0.6 && c0.lower <= c0.body * 0.6;
  const gapUp = c0.o > priorHigh;
  const gapDown = c0.o < priorLow;
  const confBuy = (strongBull || bullEngulf || gapUp) && c0.cl > priorHigh;   // closed beyond BOTH prior candles
  const confSell = (strongBear || bearEngulf || gapDown) && c0.cl < priorLow;

  // Candidate direction: from the exhaustion bias, else (spinning top) from the confirmation.
  let dir = bullExhaust ? 'BUY' : bearExhaust ? 'SELL' : (confBuy ? 'BUY' : confSell ? 'SELL' : null);
  if (!dir) return null;
  if (dir === 'BUY' && !confBuy) return null;
  if (dir === 'SELL' && !confSell) return null;
  const confLabel = (dir === 'BUY' ? (bullEngulf ? 'bullish engulfing' : gapUp ? 'gap-up' : 'strong bull') : (bearEngulf ? 'bearish engulfing' : gapDown ? 'gap-down' : 'strong bear'));

  // ── Filter 3 — HTF momentum (hard gate): never fight a clear higher-timeframe trend ──
  if (dir === 'BUY' && h4Trend === 'BEARISH') return null;
  if (dir === 'SELL' && h4Trend === 'BULLISH') return null;
  const htfAligned = (dir === 'BUY' && h4Trend === 'BULLISH') || (dir === 'SELL' && h4Trend === 'BEARISH');
  const kind = htfAligned ? 'CONTINUATION' : 'REVERSAL';

  // ── Filter 2 — Level significance: exhaustion extreme sits at a prior swing level ──
  const { highs, lows } = fractalSwings(closed);
  const exTreme = dir === 'SELL' ? c2.hi : c2.lo;
  const levels = dir === 'SELL' ? highs : lows;
  const atLevel = levels.some((s) => s.i < i - 2 && Math.abs(n(s.price) - exTreme) <= 0.6 * atr);
  if ((config.requireLevel ?? true) && kind === 'REVERSAL' && !atLevel) return null; // reversal at a random level = noise

  // ── Filter 4 — Session timing ──
  const sess = sessionQuality(closed[i].time);
  if ((config.sessionFilter ?? false) && sess.score < 0) return null;

  // ── Filter 5 — Volume confirmation ──
  const volp = volumePattern(closed, kind, i);
  if ((config.volumeFilter ?? true) && !volp.ok) return null;

  // ── Levels: entry = confirmation close; stop beyond the whole combo; structural TP3 ──
  const entry = c0.cl;
  const buffer = 0.1 * atr;
  const stop = dir === 'BUY' ? priorLow - buffer : priorHigh + buffer;
  let risk = dir === 'BUY' ? entry - stop : stop - entry;
  if (!(risk > 0) || risk / atr > 8) return null;
  if (stopTooTight(risk, atr, pip, config)) return null;
  const oppSwing = dir === 'BUY'
    ? (highs.length ? n(highs[highs.length - 1].price) : null)
    : (lows.length ? n(lows[lows.length - 1].price) : null);
  const finalTarget = (Number.isFinite(oppSwing) && (dir === 'BUY' ? oppSwing > entry : oppSwing < entry)) ? oppSwing : null;
  const ladder = tpLadder(dir, entry, risk, finalTarget);
  const rr = Math.abs(ladder.takeProfit3 - entry) / risk;
  if (!(rr >= minRR)) return null;

  // ── Score & grade ──
  let score = 50;
  const exWick = dir === 'SELL' ? c2.upper : c2.lower;
  score += Math.min(10, Math.round((exWick / atr) * 6));                          // exhaustion rejection strength
  const exWeight = dir === 'SELL' ? (exPat.bear?.weight ?? 0) : (exPat.bull?.weight ?? 0);
  score += Math.min(8, exWeight);                                                 // named exhaustion pattern
  if (bullEngulf || bearEngulf) score += 8; else score += Math.min(8, Math.round((c0.body / c0.range) * 8));
  if (gapUp || gapDown) score += 4;                                               // gap conviction
  score += kind === 'CONTINUATION' ? 6 : -2;                                      // continuation (HTF-aligned) is safer
  if (atLevel) score += 6;                                                        // F2
  score += sess.score;                                                           // F4
  score += volp.bonus;                                                          // F5
  if (htfAligned) score += 6;                                                    // F3
  if (h1Trend && ((dir === 'BUY' && h1Trend === 'BULLISH') || (dir === 'SELL' && h1Trend === 'BEARISH'))) score += 3;
  score = Math.max(40, Math.min(95, Math.round(score)));
  const grade = score >= 85 ? 'A+' : score >= 75 ? 'A' : score >= 65 ? 'B' : 'C';

  return {
    decision: dir, score, grade,
    entry: r5(entry), stopLoss: r5(stop), ...ladder,
    riskRewardRatio: Math.round(rr * 100) / 100,
    reason: `${kind === 'CONTINUATION' ? 'Continuation' : 'Reversal'} ${dir}: ${dir === 'SELL' ? 'shooting-star' : 'hammer'}/exhaustion → ${indecisionLabel} → ${confLabel} taking out the prior 2 candles${atLevel ? ' at level' : ''} · ${sess.session} · vol ${volp.note} · ${htfAligned ? 'HTF aligned' : 'HTF neutral'} (${rr.toFixed(1)}R)`,
    barIso: closed[i].time,
    meta: {
      v: 1, kind,
      exhaustion: { type: bullExhaust ? 'hammer' : bearExhaust ? 'shootingStar' : 'spinningTop', pattern: dir === 'SELL' ? exPat.bear?.name : exPat.bull?.name, wickAtr: Math.round((exWick / atr) * 100) / 100 },
      indecision: indecisionLabel,
      confirmation: { type: confLabel, brokeBothCandles: true },
      filters: { atLevel, session: sess.session, sessionScore: sess.score, volume: volp.note, htfAligned, h4Trend, h1Trend },
    },
  };
}

// ── Strategy: Failed-Break Reversion (the "ICT broke and reverted" condition) ──
// This is the COMPLEMENT to a breakout/BOS strategy, NOT a change to it. It fires ONLY
// when a break of a recent N-bar high/low CLOSES beyond the level and then FAILS — a
// later candle (within `confirmBars`) closes back INSIDE. That failed break is exactly
// the whipsaw that traps continuation traders ("market took it back to the previous
// position"). We fade it: enter on the reclaim close, stop beyond the failed-break
// extreme, target the opposite side of the broken range (the reversion). Self-selecting:
// it only exists in the reverting condition, so the lab measures whether that condition
// is tradable the other way. Pure price action, dedup by the reclaim bar. Untouched ICT.
function failedBreakReversion(ctx) {
  const { candles, h4Trend = null, config = {}, pip = 0.0001 } = ctx;
  const ref = config.ref ?? 10;              // bars that define the broken level
  const confirmBars = config.confirmBars ?? 3; // window to reclaim back inside
  const maxAgeBars = config.maxAgeBars ?? 2;   // reclaim must be fresh (near the last bar)
  const minRR = config.minRR ?? 1.5;
  const stopBufAtr = config.stopBufAtr ?? 0.1;
  if (!Array.isArray(candles) || candles.length < ref + confirmBars + 6) return null;
  const atr = atr14(candles);
  if (!(atr > 0)) return null;
  const lastIdx = candles.length - 1;

  const build = (dir, entry, stop, target, brkIdx, reclaimIdx, level) => {
    const risk = dir === 'BUY' ? entry - stop : stop - entry;
    const reward = dir === 'BUY' ? target - entry : entry - target;
    if (!(risk > 0) || !(reward > 0)) return null;
    const rr = reward / risk;
    if (rr < minRR) return null;
    if (stopTooTight(risk, atr, pip, config)) return null;
    const ladder = tpLadder(dir, entry, risk, target);   // TP3 = the reversion target (opposite range side)
    let score = 52;
    score += Math.min(15, Math.round((rr - minRR) * 6));                 // RR above the floor
    // A failed break that was COUNTER to the higher-timeframe trend = the cleanest fade
    // (a real trap against the dominant flow), so the reversion aligns WITH the H4 trend.
    if ((dir === 'SELL' && h4Trend === 'BEARISH') || (dir === 'BUY' && h4Trend === 'BULLISH')) score += 12;
    if (lastIdx - reclaimIdx === 0) score += 6;                          // reclaim just closed (freshest)
    if (reclaimIdx - brkIdx === 1) score += 4;                          // immediate failure (sharp trap)
    score = Math.max(40, Math.min(95, score));
    return {
      decision: dir,
      score,
      grade: score >= 85 ? 'A+' : score >= 75 ? 'A' : score >= 65 ? 'B' : 'C',
      entry: r5(entry),
      stopLoss: r5(stop),
      ...ladder,
      riskRewardRatio: Math.round(rr * 100) / 100,
      reason: `Failed ${dir === 'SELL' ? 'up-break' : 'down-break'}: close beyond ${r5(level)} reverted back inside (trap) → fade to opposite range side ${r5(target)}`,
      barIso: candles[reclaimIdx].time,        // dedup: one signal per reclaim bar
      meta: { brokenLevel: r5(level), failExtreme: r5(dir === 'SELL' ? stop - stopBufAtr * atr : stop + stopBufAtr * atr), target: r5(target), ageBars: lastIdx - reclaimIdx, h4Trend },
    };
  };

  // Scan the freshest reclaim bars; for each, look back up to confirmBars for the break it undid.
  for (let reclaim = lastIdx; reclaim >= lastIdx - maxAgeBars && reclaim > ref + 1; reclaim--) {
    for (let brk = reclaim - 1; brk >= reclaim - confirmBars && brk > ref; brk--) {
      const refHigh = Math.max(...candles.slice(brk - ref, brk).map((c) => n(c.high)).filter(Number.isFinite));
      const refLow = Math.min(...candles.slice(brk - ref, brk).map((c) => n(c.low)).filter(Number.isFinite));
      if (!Number.isFinite(refHigh) || !Number.isFinite(refLow)) continue;
      const brkClose = n(candles[brk].close);
      // Failed UP-break (bull trap) → SELL the reversion.
      if (brkClose > refHigh && n(candles[reclaim].close) < refHigh) {
        const failHigh = Math.max(...candles.slice(brk, reclaim + 1).map((c) => n(c.high)));
        const sig = build('SELL', n(candles[reclaim].close), failHigh + stopBufAtr * atr, refLow, brk, reclaim, refHigh);
        if (sig) return sig;
      }
      // Failed DOWN-break (bear trap) → BUY the reversion.
      if (brkClose < refLow && n(candles[reclaim].close) > refLow) {
        const failLow = Math.min(...candles.slice(brk, reclaim + 1).map((c) => n(c.low)));
        const sig = build('BUY', n(candles[reclaim].close), failLow - stopBufAtr * atr, refHigh, brk, reclaim, refLow);
        if (sig) return sig;
      }
    }
  }
  return null;
}

// ─── Fixed-Time Fusion — ENSEMBLE engine (meta, not a single tutorial) ───────
// Purpose-built for FIXED-TIME (next-candle direction) trades. It does NOT invent a new
// edge; it VOTES: it polls a panel of the existing lab strategies, a confirmed breakout, a
// native live-market read (EMA trend + slope + structure), and a short-horizon next-candle
// read, weights each vote, and only fires when enough independent sources AGREE (selective).
// A clear H4 conflict is a hard veto. Honest by design: it's framed fixed-time and the lab's
// fixed-time win-rate measures whether the fusion actually beats its components.
function ftfEma(values, period) {
  if (!values.length) return NaN;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

// Native "live market" read from candles: EMA9 vs EMA21 + recent slope. Pure, fast — this is
// the in-module stand-in for the live aggregateSignals direction (strategyLab stays isolated).
function ftfLiveRead(candles) {
  const closes = candles.slice(-40).map((c) => Number(c.close)).filter(Number.isFinite);
  if (closes.length < 25) return { dir: null, strength: 0, note: '' };
  const e9 = ftfEma(closes.slice(-30), 9);
  const e21 = ftfEma(closes.slice(-30), 21);
  const slope = closes[closes.length - 1] - closes[closes.length - 5];
  if (e9 > e21 && slope > 0) return { dir: 'BUY', strength: 0.85, note: 'EMA9>21 + rising' };
  if (e9 < e21 && slope < 0) return { dir: 'SELL', strength: 0.85, note: 'EMA9<21 + falling' };
  return { dir: null, strength: 0, note: '' };
}

// Short-horizon next-candle read: the last candle's body/close-position + 3-bar momentum.
function ftfShortHorizon(candles) {
  const c = candles.slice(-4);
  if (c.length < 4) return { dir: null, strength: 0, note: '' };
  const last = c[c.length - 1];
  const o = Number(last.open), h = Number(last.high), l = Number(last.low), cl = Number(last.close);
  const range = Math.max(h - l, 1e-9);
  const closePos = (cl - l) / range;
  const bull = cl > o;
  let up = 0, dn = 0;
  for (let i = 1; i < c.length; i++) { if (Number(c[i].close) > Number(c[i - 1].close)) up++; else dn++; }
  if (bull && closePos > 0.6 && up > dn) return { dir: 'BUY', strength: 0.5 + closePos * 0.5, note: `close@${Math.round(closePos * 100)}%` };
  if (!bull && closePos < 0.4 && dn > up) return { dir: 'SELL', strength: 0.5 + (1 - closePos) * 0.5, note: `close@${Math.round(closePos * 100)}%` };
  return { dir: null, strength: 0, note: '' };
}

// Session weight from the bar's UTC hour: London–NY overlap best, Asian quiet weakest.
function ftfSessionWeight(iso) {
  const h = new Date(iso).getUTCHours();
  if (!Number.isFinite(h)) return 1;
  if (h >= 12 && h < 16) return 1.12;                       // London–NY overlap
  if ((h >= 7 && h < 12) || (h >= 16 && h < 21)) return 1.0; // London or NY single
  if (h >= 21 || h < 3) return 0.9;                          // Sydney / late
  return 0.85;                                               // Asian quiet
}

function fixedTimeFusion(ctx) {
  const { candles, config = {} } = ctx;
  if (!candles || candles.length < 60) return null;
  const last = candles[candles.length - 1];
  const close = Number(last.close);
  const atr = atr14(candles) || 0;
  if (!(close > 0) || !(atr > 0)) return null;

  const votes = []; // { src, dir, weight }

  // 1) Panel of existing lab strategies — each casts a weighted directional vote.
  const panel = [
    ['ICT breaker', ictBreaker, 1.0], ['Liquidity trap', liquidityTrap, 1.0],
    ['Market mechanics', marketMechanics3Step, 1.0], ['Little Rizzy', littleRizzy, 0.8],
    ['SMC FVG', smcFvg, 0.8], ['Stage analysis', stageAnalysis, 0.7], ['3-candle combo', threeCandleCombo, 0.9],
  ];
  for (const [name, fn, w] of panel) {
    let s = null;
    try { s = fn({ ...ctx, config: {} }); } catch { s = null; }
    if (s && (s.decision === 'BUY' || s.decision === 'SELL')) {
      const conf = Math.min(1, Math.max(0.4, (Number(s.score) || 60) / 100));
      votes.push({ src: name, dir: s.decision, weight: w * conf });
    }
  }

  // 2) Breakout vote — a confirmed, well-graded break in a direction.
  try {
    const bk = buildBreakoutCandidate({ symbol: ctx.symbol, timeframe: ctx.timeframe, candles });
    if (bk && bk.phase === 'CONFIRMED' && bk.grade !== 'C' && (bk.direction === 'BUY' || bk.direction === 'SELL')) {
      votes.push({ src: 'Breakout', dir: bk.direction, weight: (BREAKOUT_GRADE_RANK[bk.grade] >= 2 ? 1.2 : 1.0) });
    }
  } catch { /* breakout is one optional voter */ }

  // 3) Native live-market read. 4) Short-horizon next-candle read.
  const live = ftfLiveRead(candles);
  if (live.dir) votes.push({ src: 'Live read', dir: live.dir, weight: live.strength });
  const sh = ftfShortHorizon(candles);
  if (sh.dir) votes.push({ src: 'Momentum', dir: sh.dir, weight: 0.9 * sh.strength });

  if (!votes.length) return null;
  let buy = 0, sell = 0;
  for (const v of votes) { if (v.dir === 'BUY') buy += v.weight; else sell += v.weight; }
  const total = buy + sell;
  if (total <= 0) return null;
  const dir = buy >= sell ? 'BUY' : 'SELL';
  const agreement = Math.max(buy, sell) / total;
  const agreeVoters = votes.filter((v) => v.dir === dir).length;

  // HTF alignment (h4Trend/h1Trend come from the context).
  const htfAligned = (dir === 'BUY' && (ctx.h4Trend === 'BULLISH' || ctx.h1Trend === 'BULLISH'))
    || (dir === 'SELL' && (ctx.h4Trend === 'BEARISH' || ctx.h1Trend === 'BEARISH'));
  const htfConflict = (dir === 'BUY' && ctx.h4Trend === 'BEARISH') || (dir === 'SELL' && ctx.h4Trend === 'BULLISH');
  if (htfConflict) return null; // never fight a clear H4 trend

  const sess = ftfSessionWeight(last.time);
  let score = Math.min(98, Math.round((40 + agreement * 45 + Math.min(agreeVoters, 5) * 3) * sess));
  if (htfAligned) score = Math.min(98, score + 5);

  // Selective gates (config-tunable).
  const minScore = config.minScore ?? 72;
  const minAgreement = config.minAgreement ?? 0.68;
  const minVoters = config.minVoters ?? 3;
  if (agreeVoters < minVoters || agreement < minAgreement || score < minScore) return null;

  const slDist = atr;
  const tpDist = atr * 1.5;
  const stopLoss = dir === 'BUY' ? close - slDist : close + slDist;
  const takeProfit1 = dir === 'BUY' ? close + tpDist : close - tpDist;
  const topVoters = votes.filter((v) => v.dir === dir).sort((a, b) => b.weight - a.weight).slice(0, 4).map((v) => v.src);
  return {
    decision: dir,
    score,
    grade: score >= 85 ? 'A+' : score >= 78 ? 'A' : 'B',
    entry: close, stopLoss, takeProfit1,
    takeProfit2: dir === 'BUY' ? close + tpDist * 1.5 : close - tpDist * 1.5,
    riskRewardRatio: 1.5,
    reason: `Fusion ${dir} — ${agreeVoters}/${votes.length} sources agree (${Math.round(agreement * 100)}%): ${topVoters.join(', ')}${htfAligned ? ' · H4 aligned' : ''}`,
    barIso: last.time,
    meta: {
      agreement: Math.round(agreement * 100), agreeVoters, totalVoters: votes.length,
      buyWeight: Math.round(buy * 100) / 100, sellWeight: Math.round(sell * 100) / 100,
      htfAligned, sessionWeight: sess,
      sources: votes.map((v) => ({ src: v.src, dir: v.dir, w: Math.round(v.weight * 100) / 100 })),
    },
  };
}

// ─── Strategy confluence engine (shared by forex-confluence + fixed-time-confluence) ──
// Diverse panel: ONE representative per logic family so agreement = independent confirmation,
// not several SMC clones detecting the same setup. Each votes a direction; ≥2 agreeing fires,
// graded up for 3/4/all + situational modifiers (HTF, session, location, key-level proximity).
const CONFLUENCE_PANEL = [
  ['ICT Breaker', ictBreaker],            // structure / ICT
  ['Liquidity Trap', liquidityTrap],      // reversal / liquidity
  ['Little Rizzy', littleRizzy],          // trend / continuation
  ['Market Mechanics', marketMechanics3Step], // location / mechanics
  ['SMC FVG', smcFvg],                    // SMC representative
  ['Liquidity Sweep Pro', liquiditySweepPro], // graded sweep
];

// Run the panel; return the agreeing side (≥2, no tie) or null.
function evalConfluencePanel(ctx) {
  const votes = [];
  for (const [name, fn] of CONFLUENCE_PANEL) {
    let s = null;
    try { s = fn({ ...ctx, config: {} }); } catch { s = null; }
    if (s && (s.decision === 'BUY' || s.decision === 'SELL')) votes.push({ name, dir: s.decision, score: Number(s.score) || 60, sig: s });
  }
  const buy = votes.filter((v) => v.dir === 'BUY');
  const sell = votes.filter((v) => v.dir === 'SELL');
  const dir = buy.length > sell.length ? 'BUY' : sell.length > buy.length ? 'SELL' : null; // tie = conflicting = no confluence
  if (!dir) return null;
  const winners = dir === 'BUY' ? buy : sell;
  if (winners.length < 2) return null;
  const avgScore = winners.reduce((a, v) => a + v.score, 0) / winners.length;
  return { dir, agree: winners.length, winners, avgScore, total: votes.length };
}

// Situational context for the agreeing direction: premium/discount location, session, HTF, key level.
function confluenceSituation(ctx, dir) {
  const candles = ctx.candles;
  const last = candles[candles.length - 1];
  const price = Number(last.close);
  const win = candles.slice(-60);
  const hi = Math.max(...win.map((c) => Number(c.high)).filter(Number.isFinite));
  const lo = Math.min(...win.map((c) => Number(c.low)).filter(Number.isFinite));
  const pct = hi > lo ? ((price - lo) / (hi - lo)) * 100 : 50;
  const goodLocation = dir === 'BUY' ? pct < 45 : pct > 55;        // buy discount / sell premium
  const h = new Date(last.time).getUTCHours();
  const goodSession = Number.isFinite(h) && h >= 7 && h < 21;       // London+NY span (gold moves most)
  const htfAligned = dir === 'BUY' ? (ctx.h4Trend === 'BULLISH' || ctx.h1Trend === 'BULLISH') : (ctx.h4Trend === 'BEARISH' || ctx.h1Trend === 'BEARISH');
  const htfConflict = dir === 'BUY' ? ctx.h4Trend === 'BEARISH' : ctx.h4Trend === 'BULLISH';
  let atKeyLevel = false;
  try {
    const { levels } = detectKeyLiquidityLevels(candles, { symbol: ctx.symbol });
    const atr = atr14(candles) || 0;
    atKeyLevel = atr > 0 && levels.some((l) => l.strength >= 3 && l.distanceAtr != null && l.distanceAtr <= 0.4);
  } catch { /* key levels optional */ }
  return { pct: Math.round(pct), goodLocation, goodSession, htfAligned, htfConflict, atKeyLevel };
}

// Grade 2/3/4+ agreement, modulated by component quality + situation. Gold rewarded for session.
function gradeConfluence(agree, avgScore, sit, symbol) {
  const gold = /XAU|GOLD/.test(String(symbol || '').toUpperCase());
  let score = 50;
  score += agree >= 5 ? 35 : agree === 4 ? 30 : agree === 3 ? 22 : 12; // agree >= 2
  score += Math.max(0, Math.min(15, ((avgScore - 60) / 40) * 15));
  if (sit.htfAligned) score += 6;
  if (sit.goodSession) score += gold ? 6 : 5;
  if (sit.goodLocation) score += 5;
  if (sit.atKeyLevel) score += 6;
  score = Math.min(98, Math.round(score));
  const grade = score >= 85 ? 'A+' : score >= 75 ? 'A' : score >= 65 ? 'B' : 'C';
  return { score, grade };
}

// FOREX confluence — gold-first. Anchors the TP/SL plan to the strongest agreeing component's
// structure (no fuzzy blending); never fights a clear H4 trend.
function forexConfluence(ctx) {
  const cfg = ctx.config || {};
  const c = evalConfluencePanel(ctx);
  if (!c) return null;
  const sit = confluenceSituation(ctx, c.dir);
  if (sit.htfConflict) return null;
  const { score, grade } = gradeConfluence(c.agree, c.avgScore, sit, ctx.symbol);
  if (score < (cfg.minScore ?? 65)) return null;
  const anchor = c.winners
    .filter((v) => [v.sig.entry, v.sig.stopLoss, v.sig.takeProfit1].every((x) => Number.isFinite(x)))
    .sort((a, b) => b.score - a.score)[0];
  if (!anchor) return null;
  const p = anchor.sig;
  // Each agreeing component's OWN score is shown (e.g. "ICT Breaker 85, Liquidity Trap 78") — no
  // floor gates them (every strategy already only fires on its own valid setup), but the scores
  // are surfaced so the quality of the confluence is visible, and they feed the grade via avgScore.
  const parts = c.winners.map((v) => `${v.name} ${Math.round(v.score)}`);
  const components = c.winners.map((v) => ({ name: v.name, score: Math.round(v.score), grade: v.sig.grade ?? null }));
  return {
    decision: c.dir, score, grade,
    entry: p.entry, stopLoss: p.stopLoss, takeProfit1: p.takeProfit1, takeProfit2: p.takeProfit2 ?? null, takeProfit3: p.takeProfit3 ?? null,
    riskRewardRatio: p.riskRewardRatio ?? null,
    reason: `Forex confluence: ${c.agree} agree ${c.dir} (${parts.join(', ')}); anchored to ${anchor.name}${sit.htfAligned ? ' · H4 aligned' : ''}${sit.goodLocation ? ` · ${c.dir === 'BUY' ? 'discount' : 'premium'}` : ''}${sit.atKeyLevel ? ' · at key level' : ''}`,
    barIso: p.barIso || ctx.candles[ctx.candles.length - 1].time, // dedup on the anchor setup
    meta: { agree: c.agree, components, avgComponentScore: Math.round(c.avgScore), situation: sit, anchor: anchor.name },
  };
}

// FIXED-TIME confluence — next-candle direction by agreement count. Entry=close, ATR-framed plan.
function fixedTimeConfluence(ctx) {
  const cfg = ctx.config || {};
  const c = evalConfluencePanel(ctx);
  if (!c) return null;
  const sit = confluenceSituation(ctx, c.dir);
  if (sit.htfConflict) return null;
  const { score, grade } = gradeConfluence(c.agree, c.avgScore, sit, ctx.symbol);
  if (score < (cfg.minScore ?? 65)) return null;
  const last = ctx.candles[ctx.candles.length - 1];
  const close = Number(last.close);
  const atr = atr14(ctx.candles) || 0;
  if (!(close > 0) || !(atr > 0)) return null;
  const slDist = atr, tpDist = atr * 1.5;
  const parts = c.winners.map((v) => `${v.name} ${Math.round(v.score)}`);
  const components = c.winners.map((v) => ({ name: v.name, score: Math.round(v.score), grade: v.sig.grade ?? null }));
  return {
    decision: c.dir, score, grade,
    entry: close,
    stopLoss: c.dir === 'BUY' ? close - slDist : close + slDist,
    takeProfit1: c.dir === 'BUY' ? close + tpDist : close - tpDist,
    takeProfit2: c.dir === 'BUY' ? close + tpDist * 1.5 : close - tpDist * 1.5,
    takeProfit3: null, riskRewardRatio: 1.5,
    reason: `Fixed-time confluence: ${c.agree} agree ${c.dir} (${parts.join(', ')})${sit.htfAligned ? ' · H4 aligned' : ''}${sit.goodSession ? ' · active session' : ''}`,
    barIso: last.time, // fixed-time = per-bar
    meta: { agree: c.agree, components, avgComponentScore: Math.round(c.avgScore), situation: sit },
  };
}

// Liquidity Sweep Pro — thin wrapper over gradeSweep (the 5-component model). gradeSweep returns
// a fully-formed lab signal (or null). No dailyCandles in the lab ctx, so PDH/PDL aren't in the
// obvious-pool set here — session highs/lows, round numbers, and equal highs/lows are.
function liquiditySweepPro(ctx) {
  const cfg = ctx.config || {};
  const sig = gradeSweep(ctx.candles, { symbol: ctx.symbol, h4Trend: ctx.h4Trend, h1Trend: ctx.h1Trend, minRR: cfg.minRR ?? 1.8, minGrade: cfg.minGrade ?? 'B' });
  if (!sig) return null;
  // gradeSweep doesn't enforce the lab's minimum-stop rule, so M1 sweeps could emit sub-spread
  // stops (e.g. a 0.3-pip stop → RR 100+, inflated score, absurd lot size — untradeable). Apply
  // the SAME stopTooTight guard every other engine uses; rejects only the broken setups.
  const risk = Math.abs(Number(sig.entry) - Number(sig.stopLoss));
  if (stopTooTight(risk, atr14(ctx.candles), ctx.pip, cfg)) return null;
  return sig;
}

// ─── Gold Desk — XAU Session Raid (DEDICATED XAUUSD forex engine) ────────────
// Gold-only. Encodes the psychology that makes gold different from FX majors:
//   • Gold is the retail magnet — stop clusters are denser and MORE obvious (round
//     dollars, session extremes), so the raid → reclaim → displacement sequence is
//     cleaner than anywhere else (the user's two best engines — ict-breaker 81% and
//     liquidity-sweep-pro 80% — are both sweep models; this specializes that edge).
//   • Session AMD (Power of 3): Asia ACCUMULATES the range, London MANIPULATES (the
//     Judas swing that raids the obvious level), London/NY DISTRIBUTE the true move.
//     Signals fire only in London/NY (Asia = accumulation, not a TP/SL trade).
//   • Gold's wicks are violent: stop buffer is wider (0.3×ATR) and the minimum stop
//     floor is $0.80 (8 gold-pips) so no sub-spread stop can ever pass.
// Sequence (all closed-bar confirmed): sweep of an OBVIOUS key level (round number /
// session high-low / equal highs-lows, strength ≥3) → close back inside (the trap) →
// DISPLACEMENT away (institutional sponsorship, FVG) → enter the FVG 50% pullback
// (sniper) or the reclaim close while fresh; stop beyond the raid wick; TP1/TP2 =
// 1R/2R, TP3 = the opposing resting liquidity (the draw). Min 2R. Forex (TP/SL)
// framing ONLY by design — this is not a next-candle call. Pure; isolated.
function xauSessionRaid(ctx) {
  const { candles, symbol = '', h4Trend = null, h1Trend = null, config = {}, pip = 0.1 } = ctx;
  if (!/XAU|GOLD/.test(String(symbol).toUpperCase())) return null;   // dedicated: gold only
  const minRR = config.minRR ?? 2;
  const maxAgeBars = config.maxAgeBars ?? 5;                          // raid must be fresh
  const levelTolAtr = config.levelTolAtr ?? 0.3;                      // sweep must hit a KEY level
  const chaseAtr = config.chaseAtr ?? 1.2;                            // never chase gold
  if (!Array.isArray(candles) || candles.length < 80) return null;
  const atr = atr14(candles);
  if (!(atr > 0)) return null;
  const lastIdx = candles.length - 1;
  const price = n(candles[lastIdx].close);

  // Session gate (UTC): London 07–16 / NY 12–21; the 12–16 overlap is gold's engine room.
  const hour = new Date(candles[lastIdx].time).getUTCHours();
  const inLondon = hour >= 7 && hour < 16;
  const inNy = hour >= 12 && hour < 21;
  if ((config.sessionsOnly ?? true) && !inLondon && !inNy) return null;
  const inOverlap = hour >= 12 && hour < 16;

  // 1) The raid: most recent sweep + reclaim (close back inside).
  const sweep = smcRecentSweep(candles, { lookback: config.sweepLookback ?? 40 });
  if (!sweep) return null;
  if (lastIdx - sweep.reclaimIdx > maxAgeBars) return null;           // stale raid = no trade
  const dir = sweep.dir, decision = dir === 'BULLISH' ? 'BUY' : 'SELL';
  if (h4Trend === 'BULLISH' && decision === 'SELL') return null;      // never fight a clear H4
  if (h4Trend === 'BEARISH' && decision === 'BUY') return null;

  // 2) The raided level must be OBVIOUS — where gold's retail stops actually rest.
  //    Round dollars / session extremes / equal highs-lows, strength ≥ 3.
  let raidLevel = null;
  try {
    const { levels } = detectKeyLiquidityLevels(candles, { symbol });
    raidLevel = (levels || [])
      .filter((l) => l.strength >= (config.minLevelStrength ?? 3) && Math.abs(l.price - sweep.sweepLevel) <= levelTolAtr * atr)
      .sort((a, b) => b.strength - a.strength)[0] || null;
  } catch { raidLevel = null; }
  if (!raidLevel) return null;                                        // random swing raid = noise, skip

  // 3) Displacement AFTER the reclaim — the institutional footprint (FVG).
  const disp = detectDisplacement(candles, sweep.reclaimIdx, dir, atr, { minAtr: config.dispMinAtr ?? 0.8 });
  if (!disp.present) return null;

  // 4) Entry: the FVG 50% (sniper pullback) when price has displaced beyond it;
  //    else the reclaim close while the raid is fresh (≤1 bar old).
  let entry, entryMode;
  const gapMid = (disp.gapLow + disp.gapHigh) / 2;
  if (dir === 'BULLISH' ? price > gapMid : price < gapMid) { entry = gapMid; entryMode = 'FVG 50% pullback'; }
  else if (lastIdx - sweep.reclaimIdx <= 1) { entry = n(candles[sweep.reclaimIdx].close); entryMode = 'reclaim close'; }
  else return null;                                                   // neither sniper nor fresh = chase, skip
  if (Math.abs(price - entry) > chaseAtr * atr) return null;          // anti-chase guard

  // 5) Stop beyond the raid wick with gold's wider buffer; hard $ floor via stopTooTight.
  const stop = dir === 'BULLISH' ? sweep.extreme - 0.3 * atr : sweep.extreme + 0.3 * atr;
  const risk = Math.abs(entry - stop);
  if (stopTooTight(risk, atr, pip, { minStopAtr: config.minStopAtr ?? 0.4, minStopPips: config.minStopPips ?? 8 })) return null;

  // 6) Target = the opposing resting liquidity (the draw). Min 2R to it.
  const pools = detectLiquidityPools(candles);
  const tgt = dir === 'BULLISH' ? pools.targetAbove : pools.targetBelow;
  const target = tgt ? tgt.price : (dir === 'BULLISH' ? entry + 3 * risk : entry - 3 * risk);
  const rr = Math.round(Math.abs(target - entry) / risk * 100) / 100;
  if (!(rr >= minRR)) return null;

  // 7) Deterministic score — the gold-desk checklist.
  let score = 50;
  score += Math.min(16, Math.round(disp.atrMultiple * 10));           // displacement strength
  score += Math.min(12, Math.round((rr - minRR) * 4));                // RR above the 2R floor
  score += raidLevel.strength >= 5 ? 10 : raidLevel.strength === 4 ? 8 : 6; // level obviousness
  score += inOverlap ? 8 : 5;                                         // session quality
  if ((decision === 'BUY' && h4Trend === 'BULLISH') || (decision === 'SELL' && h4Trend === 'BEARISH')) score += 8;
  if ((decision === 'BUY' && h1Trend === 'BULLISH') || (decision === 'SELL' && h1Trend === 'BEARISH')) score += 4;
  if (lastIdx - sweep.reclaimIdx <= 1) score += 5;                    // freshest raid
  if (tgt && tgt.equal) score += 4;                                   // draw = stacked equal highs/lows
  score = Math.max(40, Math.min(95, score));

  const ladder = tpLadder(decision, entry, risk, target);
  return {
    decision, score, grade: smcGrade(score),
    entry: r5(entry), stopLoss: r5(stop), ...ladder, riskRewardRatio: rr,
    reason: `Gold raid ${decision}: swept ${raidLevel.label || raidLevel.type} ${r5(sweep.sweepLevel)} (str ${raidLevel.strength}/5) → reclaim + displacement ${disp.atrMultiple}× → ${entryMode} @ ${r5(entry)}; draw ${tgt ? `${tgt.type} ${tgt.price}` : '3R'} · ${inOverlap ? 'LDN/NY overlap' : inLondon ? 'London' : 'New York'}`,
    barIso: sweep.reclaimIso,                                          // dedup: one signal per raid
    meta: {
      raidedLevel: { type: raidLevel.type, label: raidLevel.label, price: raidLevel.price, strength: raidLevel.strength },
      sweepLevel: sweep.sweepLevel, sweepExtreme: sweep.extreme, dispAtr: disp.atrMultiple,
      entryMode, session: inOverlap ? 'OVERLAP' : inLondon ? 'LONDON' : 'NY', h4Trend, h1Trend,
    },
  };
}

// ─── Special Forex Sniper — composite institutional PRE-ENTRY engine ─────────
// Forex-only. Hunts the highest-quality confluence of the lab's proven ingredients
// (obvious-level sweep/reclaim OR breaker, displacement FVG, structure, premium/
// discount, session, dual-HTF, second drive) and — the special part — ALERTS BEFORE
// THE ENTRY: it fires while price is still ~6–15 pips (ideal 10–12) on the approach
// side of the sniper limit, with momentum drifting toward it, so the trade can be
// taken within ~5 minutes. Never chases: price ran past the entry = no signal.
//
// HONESTY: signals carry meta.requiresFill — the outcome resolver replays them as a
// LIMIT order (no fill → EXPIRED, excluded from the win rate; fill → TP/SL replay
// from the fill bar with conservative fill-bar handling). The win rate you see is
// the win rate of trades you could actually have taken at the stated entry/RR.
//
// M1 is scanned but hard-gated to EXCEPTIONAL setups only (score ≥90, strong
// displacement, RR ≥2.5, London/NY, no HTF conflict, tight fast gap).
function specialForexSniper(ctx) {
  const { candles, symbol = '', timeframe = 'M15', h4Trend = null, h1Trend = null, config = {}, pip = 0.0001 } = ctx;
  const minScore = config.minScore ?? 75;
  const minRR = config.minRR ?? 2.0;
  const minPre = config.minPreEntryPips ?? 4;
  const idealPre = config.idealPreEntryPips ?? 12;
  const maxPre = config.maxPreEntryPips ?? 18;
  const enterNowPips = config.enterNowPips ?? 3;
  const minTargetPips = config.minTargetPips ?? 20;   // pips-VALUE floor: 2R on a tiny target is not profit
  const maxChaseAtr = config.maxChaseAtr ?? 1.2;
  const maxAgeBars = config.maxAgeBars ?? 12;         // the pullback into the FVG takes bars — the pip-gap gate keeps alerts price-fresh
  if (!Array.isArray(candles) || candles.length < 80) return null;
  const atr = atr14(candles);
  if (!(atr > 0)) return null;
  const lastIdx = candles.length - 1;
  const price = n(candles[lastIdx].close);
  const tfU = String(timeframe).toUpperCase();

  // Session quality (UTC): London 07–16 / NY 12–21, overlap 12–16 weighted highest.
  const hour = new Date(candles[lastIdx].time).getUTCHours();
  const inLondon = hour >= 7 && hour < 16;
  const inNy = hour >= 12 && hour < 21;
  const inOverlap = hour >= 12 && hour < 16;
  const sessionScore = inOverlap ? 10 : (inLondon || inNy) ? 7 : 3;

  // 1) Institutional trigger — an OBVIOUS-level sweep+reclaim (retail stops taken,
  //    trap sprung) preferred; a fresh displaced breaker as the alternative.
  const sweep = smcRecentSweep(candles, { lookback: config.sweepLookback ?? 40 });
  let keyLevels = [];
  try { keyLevels = detectKeyLiquidityLevels(candles, { symbol }).levels || []; } catch { keyLevels = []; }
  // Obvious-level match is a QUALITY BONUS, not a hard requirement: a sweep+reclaim with
  // displacement is institutionally meaningful on its own (the proven lsp edge) — an obvious
  // raided level (session H/L, round number, equal H/L) scores it higher, its absence scores
  // it lower. Gate-bisection showed the hard requirement starved the trigger to near-zero.
  const raidLevel = sweep
    ? keyLevels.filter((l) => l.strength >= (config.minLevelStrength ?? 3) && Math.abs(l.price - sweep.sweepLevel) <= (config.levelTolAtr ?? 0.6) * atr).sort((a, b) => b.strength - a.strength)[0] || null
    : null;
  const breaker = detectBreaker(candles, { maxAgeBars: 50 });
  const freshBreaker = breaker && breaker.ageBars <= maxAgeBars && breaker.displacement?.present ? breaker : null;

  let dir, trigger, levelStrength, triggerIso, disp, rawStop;
  if (sweep && lastIdx - sweep.reclaimIdx <= maxAgeBars) {
    dir = sweep.dir; trigger = 'sweep'; levelStrength = raidLevel ? raidLevel.strength : 0; triggerIso = sweep.reclaimIso;
    disp = detectDisplacement(candles, sweep.reclaimIdx, dir, atr, { minAtr: config.dispMinAtr ?? 0.6 });
    rawStop = sweep.extreme;
  } else if (freshBreaker) {
    dir = freshBreaker.type; trigger = 'breaker'; levelStrength = 3; triggerIso = freshBreaker.confirmedIso;
    disp = freshBreaker.displacement;
    rawStop = freshBreaker.stop;
  } else return null;
  if (!disp || !disp.present) return null;                       // displacement = institutional sponsorship, mandatory
  const decision = dir === 'BULLISH' ? 'BUY' : 'SELL';
  if (h4Trend === 'BULLISH' && decision === 'SELL') return null; // never fight a clear H4
  if (h4Trend === 'BEARISH' && decision === 'BUY') return null;

  // 2) Sniper entry = the 50% of the displacement FVG (limit fill, tight stop).
  const gapLow = Math.min(disp.gapLow, disp.gapHigh);
  const gapHigh = Math.max(disp.gapLow, disp.gapHigh);
  const entry = (gapLow + gapHigh) / 2;
  const stop = dir === 'BULLISH' ? Math.min(rawStop, gapLow) - 0.2 * atr : Math.max(rawStop, gapHigh) + 0.2 * atr;
  const risk = Math.abs(entry - stop);
  if (stopTooTight(risk, atr, pip, { minStopAtr: config.minStopAtr ?? 0.35, minStopPips: config.minStopPips ?? 5 })) return null;

  // 3) TP3 structural priority: opposing fresh liquidity → session H/L → PDH/PDL →
  //    equal highs/lows → 3R fallback. Mid-range with no logical draw = handled by RR floor.
  const pools = detectLiquidityPools(candles);
  const opposing = dir === 'BULLISH' ? pools.targetAbove : pools.targetBelow;
  const sideWanted = dir === 'BULLISH' ? 'above' : 'below';
  const validTarget = (p) => Number.isFinite(p) && (dir === 'BULLISH' ? p > entry : p < entry);
  const pickLevel = (match) => {
    const c = keyLevels.filter((l) => l.side === sideWanted && l.fresh && match(l.type) && validTarget(l.price)).sort((a, b) => a.distance - b.distance)[0];
    return c ? c.price : null;
  };
  let target = opposing && validTarget(opposing.price) ? opposing.price : null;
  let targetType = target != null ? `${opposing.type}${opposing.equal ? ' (equal)' : ''}` : null;
  if (target == null) { target = pickLevel((t) => /^(ASIAN|LONDON|NY)_/.test(t)); if (target != null) targetType = 'session level'; }
  if (target == null) { target = pickLevel((t) => /^PD[HL]$/.test(t)); if (target != null) targetType = 'prev-day level'; }
  if (target == null) { target = pickLevel((t) => /EQUAL/.test(t)); if (target != null) targetType = 'equal highs/lows'; }
  if (target == null) { target = dir === 'BULLISH' ? entry + 3 * risk : entry - 3 * risk; targetType = '3R'; }
  const reward = Math.abs(target - entry);
  const rr = Math.round((reward / risk) * 100) / 100;
  if (rr < minRR) return null;                                   // RR floor
  if (reward / pip < minTargetPips) return null;                 // pips-value floor

  // 4) PRE-ENTRY timing gate — the special behavior. Alert while price is still on the
  //    approach side, minPre–maxPre pips from the limit, drifting toward it (the "fillable
  //    within ~5 minutes" proxy). Price ran past the entry = the snipe is gone, skip.
  const gapPips = Math.abs(price - entry) / pip;
  const approaching = dir === 'BULLISH' ? price > entry : price < entry;
  let timingQuality, entryMode;
  if (approaching) {
    if (gapPips < minPre || gapPips > maxPre) return null;
    if (Math.abs(price - entry) > maxChaseAtr * atr) return null;
    // Drift toward the entry over the last ~3 bars = timing BONUS (not a hard gate — one
    // counter-candle mid-pullback would otherwise randomly veto perfectly good approaches).
    const back = n(candles[Math.max(0, lastIdx - 3)].close);
    const toward = dir === 'BULLISH' ? price < back : price > back;
    timingQuality = Math.max(2, 8 - Math.round(Math.abs(gapPips - idealPre) / 3)) + (toward ? 2 : 0); // ≈10 at the ideal 10–12p band
    entryMode = `pre-entry ${Math.round(gapPips)}p out`;
  } else {
    if (gapPips > enterNowPips) return null;                     // beyond the entry = chased, gone
    timingQuality = 8;
    entryMode = 'enter-now zone';
  }

  // 5) Structure, location, second drive.
  const { highs, lows } = fractalSwings(candles);
  const upSwings = Math.min(risingTail(highs), risingTail(lows));
  const downSwings = Math.min(fallingTail(highs), fallingTail(lows));
  const structureOk = decision === 'BUY' ? upSwings >= 2 : downSwings >= 2;
  const range = smcDealingRange(candles);
  const pdOk = !!range && (decision === 'BUY' ? entry <= range.eq : entry >= range.eq);
  const secondDrive = !!detectSecondDrive(candles, dir).isSecondDrive;
  const htf4 = (decision === 'BUY' && h4Trend === 'BULLISH') || (decision === 'SELL' && h4Trend === 'BEARISH');
  const htf1 = (decision === 'BUY' && h1Trend === 'BULLISH') || (decision === 'SELL' && h1Trend === 'BEARISH');

  // 6) Deterministic 100-point budget: 20 liquidity · 15 displacement · 15 HTF ·
  //    10 location · 10 session · 10 RR · 10 structure · 10 timing (+3 second drive).
  let score = 0;
  // Liquidity trigger: obvious raided level scores highest; a plain sweep+displacement (the
  // proven lsp edge) still earns a solid base; breaker reclaim in between.
  score += trigger === 'sweep' ? (levelStrength >= 5 ? 20 : levelStrength === 4 ? 17 : levelStrength === 3 ? 15 : 12) : 14;
  score += Math.min(15, Math.round((disp.atrMultiple ?? 1) * 10));
  // HTF: aligned scores full; NEUTRAL (no clear trend — the usual state) is not a defect and
  // earns the midpoint; hard opposition was already vetoed above.
  score += htf4 ? 10 : (h4Trend === null ? 5 : 2);
  score += htf1 ? 5 : 2;
  score += (pdOk ? 5 : 0) + (raidLevel ? 5 : 2);
  score += sessionScore;
  score += Math.min(10, 4 + Math.round((rr - minRR) * 4));
  // Structure: a sweep REVERSAL rarely shows trend structure at the trigger — that's the
  // nature of the setup, not a flaw; aligned trend structure is the bonus case.
  score += structureOk ? 10 : 6;
  score += timingQuality;
  if (secondDrive) score += 3;
  score = Math.max(40, Math.min(97, Math.round(score)));
  if (score < minScore) return null;                             // elite-only: below 75 stays silent

  // 7) M1 hard gate — exceptional setups only, otherwise M1 is ignored entirely.
  if (tfU === 'M1') {
    const exceptional = score >= (config.m1ExceptionalScore ?? 90)
      && (disp.atrMultiple ?? 0) >= 1.2
      && rr >= (config.m1MinRR ?? 2.5)
      && (inLondon || inNy)
      && gapPips <= idealPre;
    if (!exceptional) return null;
  }

  const ladder = tpLadder(decision, entry, risk, target);
  return {
    decision, score, grade: smcGrade(score),
    entry: r5(entry), stopLoss: r5(stop), ...ladder, riskRewardRatio: rr,
    reason: `Sniper ${decision}: ${trigger === 'sweep' ? `swept ${raidLevel ? `${raidLevel.label || raidLevel.type} ` : ''}${r5(sweep.sweepLevel)}${raidLevel ? ` (str ${levelStrength}/5)` : ''}` : `${dir.toLowerCase()} breaker reclaim`} + displacement ${disp.atrMultiple}× → LIMIT ${r5(entry)} (${entryMode}); stop ${r5(stop)}; draw ${targetType} ${r5(target)} · ${rr}R${htf4 ? ' · H4 aligned' : ''}${secondDrive ? ' · 2nd drive' : ''} · ${inOverlap ? 'LDN/NY overlap' : inLondon ? 'London' : inNy ? 'New York' : 'off-session'}`,
    barIso: triggerIso,                                          // dedup: ONE signal per raid/breaker
    meta: {
      v: 1, trigger, requiresFill: true, preEntryAlert: true,
      limitEntry: r5(entry), preEntryPips: Math.round(gapPips * 10) / 10, entryMode,
      raidedLevel: raidLevel ? { type: raidLevel.type, label: raidLevel.label, strength: raidLevel.strength } : null,
      dispAtr: disp.atrMultiple, targetType, rrToTarget: rr,
      session: inOverlap ? 'OVERLAP' : inLondon ? 'LONDON' : inNy ? 'NY' : 'OFF',
      htf4, htf1, secondDrive, structure: decision === 'BUY' ? `${upSwings}-swing up` : `${downSwings}-swing down`,
    },
  };
}

export const STRATEGIES = {
  'special-forex-sniper': {
    id: 'special-forex-sniper',
    name: 'Special Forex Sniper',
    source: 'Composite institutional forex engine — liquidity, structure, displacement, RR, and PRE-ENTRY timing (alerts 10–12 pips before the entry)',
    description: 'FOREX-ONLY sniper that alerts BEFORE the entry: it fires while price is still ~6–15 pips (ideal 10–12) on the approach side of the planned limit with momentum drifting toward it — so the trade can be taken within ~5 minutes; price that has run past the entry is never chased. Setup = an OBVIOUS-level liquidity sweep + reclaim (PDH/PDL, session highs/lows, round numbers, equal highs/lows, strength ≥3) or a fresh displaced breaker, confirmed by a displacement FVG (entry = its 50%), stop beyond the raid wick, structure (HH/HL·LH/LL), premium/discount location, second-drive preference and dual-HTF agreement (never fights a clear H4). Profit discipline: minimum 2R to a STRUCTURAL TP3 (opposing fresh liquidity → session H/L → prev-day H/L → equal extremes → 3R) AND a minimum 20-pip target — RR alone is not profit. Scored on a 100-point institutional checklist; below 75 stays silent. M1 is scanned but hard-gated to EXCEPTIONAL setups only (score ≥90, strong displacement, RR ≥2.5, London/NY, tight fast gap). HONEST MEASUREMENT: signals are resolved as LIMIT orders — if price never fills the entry the signal EXPIRES and is excluded from the win rate, so the recorded performance is only of trades that could actually be taken.',
    timeframes: ['M1', 'M5', 'M15', 'M30', 'H1'],
    config: { minScore: 75, minRR: 2.0, minPreEntryPips: 4, idealPreEntryPips: 12, maxPreEntryPips: 18, enterNowPips: 3, minTargetPips: 20, maxChaseAtr: 1.2, maxAgeBars: 12, minLevelStrength: 3, levelTolAtr: 0.6, dispMinAtr: 0.6, minStopPips: 5, minStopAtr: 0.35, m1ExceptionalScore: 90, m1MinRR: 2.5, sweepLookback: 40 },
    evaluate: specialForexSniper,
  },
  'xau-session-raid': {
    id: 'xau-session-raid',
    name: 'Gold Desk — XAU Session Raid',
    source: 'Dedicated XAUUSD engine — session AMD (Power of 3) + obvious-level raid, distilled from the lab\'s two best sweep models',
    description: 'GOLD ONLY (returns nothing on any other symbol) and FOREX (TP/SL) framing only by design. Encodes gold\'s crowd psychology: gold is the retail magnet, so stops cluster at OBVIOUS levels (round dollars, session highs/lows, equal highs/lows) and the market is structured around raiding them — Asia accumulates the range, London manipulates it (the Judas swing), London/NY distribute the true move. The engine fires only in London/NY when: an obvious key level (strength ≥3) is SWEPT then RECLAIMED (the trap), followed by DISPLACEMENT (FVG — institutional sponsorship). Entry at the FVG 50% pullback (sniper) or the fresh reclaim close; stop beyond the raid wick + 0.3×ATR (gold-wide buffer, hard $0.80 minimum stop); TP1/TP2 = 1R/2R, TP3 = the opposing resting liquidity. Never fights a clear H4 trend; never chases (>1.2×ATR from entry = skip). Min 2R. Scored on the gold-desk checklist: displacement strength, level obviousness, session (overlap best), dual-HTF alignment, raid freshness, equal-highs/lows draw.',
    timeframes: ['M5', 'M15', 'M30', 'H1'],
    config: { minRR: 2, maxAgeBars: 5, levelTolAtr: 0.3, chaseAtr: 1.2, minLevelStrength: 3, dispMinAtr: 0.8, minStopAtr: 0.4, minStopPips: 8, sessionsOnly: true, sweepLookback: 40 },
    evaluate: xauSessionRaid,
  },
  'liquidity-sweep-pro': {
    id: 'liquidity-sweep-pro',
    name: 'Liquidity Sweep Pro',
    source: 'High-probability 5-component sweep model (advanced sweep tutorial)',
    description: 'Only takes a sweep when all 5 institutional checks line up: (1) HTF context (never fights a clear H4/H1 trend); (2) the swept level is an OBVIOUS pool — session high/low, round number, or equal highs/lows (strength≥3), not a random swing; (3) a REJECTION candle (≥30% wick that closed back inside the level); (4) DISPLACEMENT (a strong opposite-direction move / FVG after the sweep); (5) a MARKET-STRUCTURE SHIFT (close beyond the prior minor swing in the new direction). Enter at the rejection close, stop beyond the sweep wick, target the opposing fresh liquidity (≥1.8R). Grades each sweep A+→F and only fires ≥B — the tutorial discipline: never enter on the sweep alone. Reuses detectKeyLiquidityLevels + detectDisplacement + fractal structure. Isolated lab strategy.',
    timeframes: ['M5', 'M15', 'M30', 'H1'],
    config: { minRR: 1.8, minGrade: 'B' },
    evaluate: liquiditySweepPro,
  },
  'forex-confluence': {
    id: 'forex-confluence',
    name: 'Forex Confluence (Gold-first)',
    source: 'Ensemble (meta) — fires when 2-4 DIVERSE strategies agree on direction; gold-optimised forex',
    description: 'A gold-first FOREX confluence engine for the TP/SL side. Each bar it polls a DIVERSE panel — one representative per logic family (ICT structure, liquidity reversal, trend continuation, mechanics/location, SMC, graded sweep) so agreement is independent confirmation, not several SMC clones detecting the same setup. Fires only when ≥2 agree on the SAME direction (no tie), graded UP for 3/4/all-agree and modulated by situation: HTF (H4/H1) alignment, active session (London/NY — where gold moves most), premium/discount location, and proximity to a fresh KEY liquidity level (PDH/PDL, round number, session high/low). Never fights a clear H4 trend (hard veto). The TP/SL plan is ANCHORED to the strongest agreeing component\'s structure (no fuzzy blending) — its entry/stop/targets. Score 50 + agreement bonus (2→+12, 3→+22, 4→+30) + component quality + modifiers; grade B(≥65)/A(≥75)/A+(≥85). Isolated lab strategy; reads existing strategies, changes none. Best on gold then majors.',
    timeframes: ['M5', 'M15', 'M30', 'H1', 'H4'],
    config: { minScore: 65 },
    evaluate: forexConfluence,
  },
  'fixed-time-confluence': {
    id: 'fixed-time-confluence',
    name: 'Fixed-Time Confluence',
    source: 'Ensemble (meta) — next-candle direction by how many DIVERSE strategies agree',
    description: 'A FIXED-TIME (next-candle) confluence engine, distinct from fixed-time-fusion (which weights live read + breakout). This one is the explicit AGREEMENT-COUNT model: it polls the same diverse panel (one per family — ICT, liquidity reversal, trend, mechanics, SMC, graded sweep) and fires an UP/DOWN call only when ≥2 agree on the SAME direction, graded UP for 3/4/all-agree. Score modulated by HTF alignment, active session, premium/discount location, and key-level proximity; never fires against a clear H4 trend. Entry at the close, ATR-framed for the forex measurement; the lab scores it BOTH ways (fixed-time direction win-rate + as-traded) so you can see whether more agreement = higher accuracy. Isolated; reads existing strategies, changes none.',
    timeframes: ['M1', 'M5', 'M15', 'M30', 'H1'],
    config: { minScore: 65 },
    evaluate: fixedTimeConfluence,
  },
  'fixed-time-fusion': {
    id: 'fixed-time-fusion',
    name: 'Fixed-Time Fusion',
    source: 'Ensemble (meta) — existing lab strategies + live-market read + breakout, voted for next-candle direction',
    description: 'A DEDICATED fixed-time (next-candle) engine. It does not add a new edge — it VOTES. Each pass it polls a panel of the existing lab strategies (ICT breaker, liquidity trap, market-mechanics, little-rizzy, SMC-FVG, stage analysis, 3-candle combo), a CONFIRMED graded breakout, a native live-market read (EMA9/21 + slope), and a short-horizon next-candle read (last-candle body/close-position + 3-bar momentum). Each source casts a weighted UP/DOWN vote; the call fires ONLY when ≥3 independent sources agree, agreement ≥68%, the confluence score ≥72, and there is no opposing H4 trend (hard veto). London–NY overlap is weighted up, Asian hours down. Deliberately SELECTIVE — it stays silent far more often than it speaks. Entry at the close; the lab measures it BOTH ways (fixed-time direction win-rate + a 1.5R forex framing) so you can see honestly whether the fusion beats its parts.',
    timeframes: ['M1', 'M5', 'M15', 'M30', 'H1'],
    config: { minScore: 72, minAgreement: 0.68, minVoters: 3 },
    evaluate: fixedTimeFusion,
  },
  'three-candle-combo': {
    id: 'three-candle-combo',
    name: '3-Candle Safety Check',
    source: 'Exhaustion → Indecision → Confirmation sequence + 5 context filters',
    description: 'Trades a 3-candle SEQUENCE, not a single candle: (1) EXHAUSTION — a shooting-star / hammer / spinning-top rejection; (2) INDECISION — a doji, inside bar, or small-bodied stalemate; (3) CONFIRMATION — a strong-bodied / engulfing / gapping candle that closes beyond BOTH prior candles ("takes out the previous two"). Two modes: REVERSAL (combo against the local move at a significant level) and CONTINUATION (HTF-aligned pullback that resumes). Five context filters gate/score it: market structure, level significance (exhaustion at a prior swing level), HTF momentum alignment (hard gate — never fight a clear H4 trend), session timing (London/NY > Asian), and volume confirmation (reversals expand into confirmation; continuations show a quiet pullback then an explosive confirmation). Entry at the confirmation close, stop beyond the whole combo (+ATR), TP1/TP2 = 1R/2R, TP3 = opposing swing / measured move. Minimum 1.8R. Isolated lab strategy — never blends into live signals.',
    timeframes: ['M5', 'M15', 'M30', 'H1', 'H4'],
    config: { minRR: 1.8, requireLevel: true, sessionFilter: false, volumeFilter: true },
    evaluate: threeCandleCombo,
  },
  'ict-breaker': {
    id: 'ict-breaker',
    name: 'ICT Breaker',
    source: 'Maine — "The SIMPLE $10M ICT Blueprint" (Chart Fanatics)',
    description: 'Liquidity sweep → close back through the prior swing (breaker) with displacement, entered at the breaker with stop beyond the sweep, targeting the opposing resting liquidity. HTF-aligned, minimum 2R.',
    timeframes: ['M15', 'M30', 'H1'],
    config: { minRR: 2, maxAgeBars: 3 },
    evaluate: ictBreaker,
  },
  'ict-plus': {
    id: 'ict-plus',
    name: 'ICT+',
    source: 'ICT breaker, upgraded — FVG sniper entry + premium/discount + second-drive + dual-HTF confluence',
    description: 'An improved ICT breaker (the original ict-breaker is untouched). Same sweep → breaker + displacement base, then stacks A+ filters: enter the 50% of the displacement FAIR VALUE GAP (sniper fill, not the breaker zone) for a tighter stop and better RR; only in the discount (buy) / premium (sell) half of the dealing range; only on a SECOND drive (skips the first-drive fakeout); aligned with both H4 and H1; bonus for an equal-highs/lows target and a fresh breaker. Requires a minimum stacked-confluence count and a higher 3R floor — fewer, cleaner signals. Stop beyond the sweep.',
    timeframes: ['M15', 'M30', 'H1', 'H4'],
    config: { minRR: 3, maxAgeBars: 3, minConfluences: 4, strongDispAtr: 1.3 },
    evaluate: ictPlus,
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
  'little-rizzy': {
    id: 'little-rizzy',
    name: 'Little Rizzy',
    source: 'Massi Safi — World #2 Futures Trader (Chart Fanatics)',
    description: 'Trend-continuation measured move. The impulse is a LOCAL recent leg (bounded lookback + steepness + sane ATR size — no stale global-max), the pullback to a lower-high (downtrend) / higher-low (uptrend) — the "little rizzy" — must be a healthy 38–79% retracement (best 50–61.8%), and entry needs a real rejection candle, not just any bar. RR is gated/shown against the realistic first target (the impulse extreme); the equal-leg measured move (low − D sell / high + D buy) is the TP3 runner. Bollinger Bands (20, 2σ) = "reality": only pullbacks with room to run; next-higher-TF stage must not contradict. Stop just beyond the swing, minimum 1.8R.',
    timeframes: ['M15', 'M30', 'H1', 'H4'],
    config: { minRR: 1.8, maxAgeBars: 4, poiAtr: 1.5 },
    evaluate: littleRizzy,
  },
  'stage-analysis': {
    id: 'stage-analysis',
    name: 'Stage Analysis',
    source: 'Ted Zack / Stan Weinstein — Stage Analysis (Chart Fanatics)',
    description: 'Weinstein 4-stage price cycle (SMA 10/20/30/40 + slope + alignment). Acts only in the actionable stages: Stage 2 (advancing) BUY and Stage 4 (declining) SELL. Two precise entries: (a) pullback-and-reclaim — a genuine dip to/through the 10-SMA (holding above the 30-SMA) that closes back through it on a confirming candle and higher-low/lower-high structure; (b) base-breakout — a tight consolidation above/below the 30-SMA that breaks out. Tight structural stop beyond the swing/base; over-extension and slope gates filter chop; next-higher-TF stage must not contradict. Waits through Stage 1 (basing) and Stage 3 (topping). HTF-aligned, minimum 1.8R. Best on higher timeframes.',
    timeframes: ['H1', 'H4', 'D1'],
    config: { minRR: 1.8, pullbackAtr: 1.0, tpR: 2.5 },
    evaluate: stageAnalysis,
  },
  'swing-structure-candles': {
    id: 'swing-structure-candles',
    name: 'Swing Structure Candles',
    source: 'Swing structure (HH/HL · LH/LL) + candlestick triggers',
    description: 'Reads the swing skeleton — higher highs + higher lows (uptrend) or lower highs + lower lows (downtrend) — and ranks its strength by the number of confirming swings (2 = weak/early, fires only on a strong pattern; 3 = preferred; 4+ = strongest, with an over-extension guard). Then a candlestick trigger gives the direction: CONTINUATION (bullish trigger at a pullback to the latest higher low → BUY; bearish trigger at the latest lower high → SELL), REVERSAL (strong bearish trigger rejecting a fresh higher high → SELL; strong bullish trigger at a fresh lower low → BUY), or a FLAT-BASE BREAKOUT (price coils under a horizontal equal-highs shelf, then a candle CLOSES above it → BUY; mirror equal-lows breakdown → SELL) — the breakout demands a confirmed close beyond the level (wick-through that closes back inside = trap, skipped) and rejects big-momentum climax candles. Pattern library: hammer/shooting-star/pin, dragonfly/gravestone doji, engulfing, piercing/dark-cloud, tweezers, morning/evening star — a neutral doji is never directional on its own. A VOLATILITY-CONTRACTION read (tight base / inside bar before the trigger) adds a quality bonus and tucks the stop to the base (better RR). Before firing, the setup is confirmed top-down against the next LOWER timeframe (M15→M5, M30→M15, H1→M30, H4→H1): the lower TF must agree — CONTRADICT → skip, NEUTRAL/MISSING → allowed only if the main setup is strong. Stop beyond the swing/base (+ATR buffer), TP1/TP2 = 1R/2R, TP3 = opposing swing / draw on liquidity / measured move. HTF-aligned, minimum 1.8R. Best on M15–H4.',
    timeframes: ['M15', 'M30', 'H1', 'H4'],
    config: { minRR: 1.8, minSwings: 2, nearAtr: 1.5, overextAtr: 3.0, tpR: 2.5, ltfRequired: true, ltfConfirmBonus: 6, ltfNeutralFloor: 70, contractionWindow: 5, contractionAtr: 1.5, contractionBonus: 6, contractionTightenStop: true, breakoutEnabled: true, breakoutBufferAtr: 0.05, breakoutMaxChaseAtr: 1.0, breakoutClimaxAtr: 2.2, breakoutBaseLookback: 20 },
    evaluate: swingStructureCandles,
  },
  'smc-fvg': {
    id: 'smc-fvg',
    name: 'SMC Fair Value Gap',
    source: 'Smart Money Concepts core — liquidity sweep → displacement FVG → 50% mitigation',
    description: 'Liquidity sweep of a swing extreme (taken then reclaimed) → a displacement leg that prints a fair value gap AFTER the sweep → enter the 50% of that gap on the pullback, stop beyond the sweep, target the opposing resting liquidity (draw). Discount-for-buy / premium-for-sell bonus. HTF-aligned, minimum 2R.',
    timeframes: ['M5', 'M15', 'M30', 'H1'],
    config: { minRR: 2, dispAtr: 0.6, sweepLookback: 50, stopBufAtr: 0.2 },
    evaluate: smcFvg,
  },
  'smc-mmxm': {
    id: 'smc-mmxm',
    name: 'Market Makers Model',
    source: 'Smart Money Concepts — market makers buy/sell model (external↔internal)',
    description: 'Dealing range = most recent external swing high↔low. Price sweeps the range extreme (external liquidity), then a displacement FVG forms in the discount (buy) / premium (sell) half — the smart-money reversal. Enter the FVG 50%, stop beyond the swept extreme, target the OPPOSITE external extreme (original consolidation). HTF-aligned, minimum 2.5R.',
    timeframes: ['M15', 'M30', 'H1', 'H4'],
    config: { minRR: 2.5, dispAtr: 0.6, sweepLookback: 60, extremeTolAtr: 1.0, stopBufAtr: 0.2 },
    evaluate: smcMmxm,
  },
  'smc-cct': {
    id: 'smc-cct',
    name: 'Candle Continuity',
    source: 'Smart Money Concepts — candle continuity theory',
    description: 'After a liquidity sweep establishes the draw, price delivers one direction: each candle follows the previous candle\'s direction. With two confirming closes in the draw direction, enter just beyond the OPENING price of the continuation candle, stop beyond the sweep extreme, target the opposing liquidity. Fires only on a fresh draw (recent reclaim) and with the HTF trend. Minimum 2R.',
    timeframes: ['M5', 'M15', 'M30', 'H1'],
    config: { minRR: 2, sweepLookback: 40, maxAgeBars: 6, stopBufAtr: 0.2 },
    evaluate: smcCct,
  },
  'smc-two-lines': {
    id: 'smc-two-lines',
    name: 'Two-Lines Session',
    source: 'Smart Money Concepts — "two lines" (17:00 + midnight open) session reversal',
    description: 'The 17:00 and 00:00 New York opens are the two lines. Price above BOTH = sell-bias, below BOTH = buy-bias, between = no trade. Inside a kill zone (London 02–05 / NY 07–10 ET), a weakness candle that rejected a recent swing extreme plus a confirming opposite-side close fires: enter the 50% of the confirmation candle, stop beyond the weakness wick, fixed 3R. ET clock is DST-aware. Intraday only.',
    timeframes: ['M15', 'M30', 'H1'],
    config: { tpR: 3, killZones: true, stopBufAtr: 0.15 },
    evaluate: smcTwoLines,
  },
  'failed-break-reversion': {
    id: 'failed-break-reversion',
    name: 'Failed Break Reversion',
    source: 'Complement to ICT/breakout — fades the breakout that fails and reverts (the whipsaw condition)',
    description: 'Fires ONLY when a break of a recent N-bar high/low CLOSES beyond the level and then FAILS — a later candle (within confirmBars) closes back inside. That failed break is the trap that catches continuation traders (price "takes it back to the previous position"). Fades it: enter on the reclaim close, stop beyond the failed-break extreme, target the opposite side of the broken range. Self-selecting — it only exists in the reverting/whipsaw condition that hurts breakout systems, so the lab measures whether that condition is tradable the other way. Higher quality when the failed break was counter to the H4 trend (the reversion then aligns with H4). Pure price action, dedup by the reclaim bar. Completely separate from the live ICT signal engine.',
    timeframes: ['M5', 'M15', 'M30', 'H1'],
    config: { ref: 10, confirmBars: 3, maxAgeBars: 2, minRR: 1.5, stopBufAtr: 0.1 },
    evaluate: failedBreakReversion,
  },
  'smc-asian-sweep': {
    id: 'smc-asian-sweep',
    name: 'Asian Range Sweep',
    source: 'Smart Money Concepts — Asian range sweep / London manipulation',
    description: 'The Asian range (ET 20:00–24:00 high/low) is resting liquidity. In the London manipulation window (01:30–05:00 ET) price sweeps the Asian high or low then reclaims — trade the reversal toward the OPPOSITE Asian extreme, stop beyond the swept extreme. ET clock is DST-aware. Fires only inside the window; intraday only. Minimum 2R.',
    timeframes: ['M5', 'M15', 'M30'],
    config: { minRR: 2, windowOnly: true, asianLookback: 130, sweepScan: 14, stopBufAtr: 0.2 },
    evaluate: smcAsianSweep,
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
