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
