/**
 * Score and grade the AI's proposed chart setup.
 *
 * WHY THIS IS DETERMINISTIC AND NOT THE MODEL'S OWN NUMBER
 * The vision model already reports a `confidence` and a `riskReward`. Neither can be trusted as
 * the headline:
 *   - riskReward is self-reported arithmetic on prices it also chose, so a model that mis-places
 *     a target reports a great R:R for a trade that cannot happen. Every price relationship here
 *     is RECOMPUTED from the entry/stop/target actually returned.
 *   - confidence is self-assessment. This session measured a 97% "win rate" that was really
 *     -0.74R, so a number a system assigns to its own output is the last thing that should lead.
 *
 * The score is therefore built from things that can be checked: geometry, reward-to-risk measured
 * to the final target, independent agreement from the deterministic engines, higher-timeframe
 * alignment, stop sanity, and data freshness. The model's confidence contributes, but capped, so
 * it can nudge a grade and never carry one.
 *
 * Grades use the SAME bands as strategyLab/forecastGrade (85/75/65) so an A here means the same
 * band as an A on a signal, plus a D for setups that are measurably poor rather than merely weak.
 *
 * Pure: numbers in, verdict out. No I/O, no clock, no side effects.
 */

const n = (v) => Number(v);
// Number(null) is 0 and 0 is finite — the coercion that produced five separate defects in this
// codebase. Every optional price goes through this instead of a bare isFinite.
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(n(v)) ? null : n(v));

export const SETUP_GRADE_BANDS = { 'A+': 85, A: 75, B: 65, C: 50 };

/** Grade from a score. Null score => null grade, never a failing letter. */
export function setupGrade(score) {
  if (score === null || score === undefined || score === '') return null;
  const v = n(score);
  if (!Number.isFinite(v)) return null;
  if (v >= SETUP_GRADE_BANDS['A+']) return 'A+';
  if (v >= SETUP_GRADE_BANDS.A) return 'A';
  if (v >= SETUP_GRADE_BANDS.B) return 'B';
  if (v >= SETUP_GRADE_BANDS.C) return 'C';
  return 'D';
}

/**
 * Check the plan is a tradeable shape before scoring it.
 *
 * A target on the losing side or a stop on the winning side is not a weak setup — it is a
 * broken ticket, and scoring it at all would let it reach a user as an opportunity. This is the
 * same class of defect as the 29 MT5 "10016 Invalid stops" rejections, where TP1 sat behind the
 * market: the arithmetic looked fine and the trade could never exist.
 */
export function validateGeometry({ direction, entry, stopLoss, takeProfit1, takeProfit3 }) {
  const dir = String(direction || '').toUpperCase();
  const errors = [];
  if (dir !== 'BUY' && dir !== 'SELL') errors.push('no tradeable direction');
  const e = num(entry), s = num(stopLoss);
  const t1 = num(takeProfit1), t3 = num(takeProfit3);
  if (e === null) errors.push('no entry price');
  if (s === null) errors.push('no stop loss');
  if (t1 === null && t3 === null) errors.push('no take profit');
  if (errors.length) return { valid: false, errors };

  const buy = dir === 'BUY';
  if (buy ? s >= e : s <= e) errors.push('stop is on the winning side of entry');
  for (const [label, tp] of [['TP1', t1], ['TP3', t3]]) {
    if (tp === null) continue;
    if (buy ? tp <= e : tp >= e) errors.push(`${label} is behind the entry`);
  }
  if (Math.abs(e - s) === 0) errors.push('zero risk — entry equals stop');
  return { valid: errors.length === 0, errors };
}

/**
 * Reward-to-risk, measured to the FINAL target.
 *
 * Deliberately not TP1: TP1 is roughly 1R by construction on most ladders, so computing R:R from
 * it stamps "RR 1" on every ticket regardless of the actual draw — a real bug that once tripped
 * the challenge minimum-RR gate on every forecast.
 */
export function measuredRr({ direction, entry, stopLoss, takeProfit1, takeProfit3 }) {
  const g = validateGeometry({ direction, entry, stopLoss, takeProfit1, takeProfit3 });
  if (!g.valid) return null;
  const e = num(entry), s = num(stopLoss);
  const target = num(takeProfit3) ?? num(takeProfit1);
  const risk = Math.abs(e - s);
  const reward = Math.abs(target - e);
  if (!(risk > 0) || !(reward > 0)) return null;
  return Math.round((reward / risk) * 100) / 100;
}

/**
 * Score the setup 0-100 from checkable evidence.
 *
 * Every component is named in the returned breakdown so a grade can always be explained — an
 * unexplained score is indistinguishable from a guess.
 */
export function scoreChartSetup({
  direction, entry, stopLoss, takeProfit1, takeProfit2, takeProfit3,
  aiConfidence = null,
  strategyMatch = null,
  htfBias = null,
  atr = null,
  spread = null,
  dataFresh = true,
} = {}) {
  const geometry = validateGeometry({ direction, entry, stopLoss, takeProfit1, takeProfit3 });
  if (!geometry.valid) {
    return { score: null, grade: null, rr: null, geometry, breakdown: [], note: `Unusable ticket: ${geometry.errors.join('; ')}` };
  }

  const rr = measuredRr({ direction, entry, stopLoss, takeProfit1, takeProfit3 });
  const buy = String(direction).toUpperCase() === 'BUY';
  const risk = Math.abs(num(entry) - num(stopLoss));
  const breakdown = [];
  let score = 45;                                  // a valid but unremarkable ticket starts here
  breakdown.push({ factor: 'valid ticket', points: 45, why: 'geometry checks out' });

  // Reward to risk, measured. The dominant component, because it is the one thing that decides
  // whether a given win rate makes money.
  if (rr !== null) {
    const pts = rr >= 3 ? 20 : rr >= 2 ? 15 : rr >= 1.5 ? 9 : rr >= 1 ? 3 : -8;
    score += pts;
    breakdown.push({ factor: 'reward:risk', points: pts, why: `${rr}R to the final target` });
  }

  // Independent agreement. The AI read the chart before seeing engine output, so overlap here is
  // genuine corroboration rather than an echo.
  if (strategyMatch && strategyMatch.verdict) {
    const agree = (strategyMatch.agreeing || []).length;
    const oppose = (strategyMatch.opposing || []).length;
    const pts = strategyMatch.verdict === 'ALIGNED' ? Math.min(14, 6 + agree * 3)
      : strategyMatch.verdict === 'MIXED' ? Math.max(-4, agree - oppose * 2)
        : strategyMatch.verdict === 'CONTRARY' ? -12 : 0;
    score += pts;
    breakdown.push({
      factor: 'engine agreement', points: pts,
      why: strategyMatch.verdict === 'CONTRARY' ? `all ${oppose} firing strategies disagree`
        : agree || oppose ? `${agree} agree, ${oppose} disagree` : 'no strategies firing',
    });
  }

  // Higher-timeframe alignment. Trading against a clear HTF trend is the most common way a
  // technically clean setup still loses.
  if (htfBias) {
    const hb = String(htfBias).toUpperCase();
    if (hb === 'BULLISH' || hb === 'BEARISH') {
      const aligned = (buy && hb === 'BULLISH') || (!buy && hb === 'BEARISH');
      const pts = aligned ? 8 : -10;
      score += pts;
      breakdown.push({ factor: 'higher timeframe', points: pts, why: aligned ? `with the ${hb.toLowerCase()} bias` : `AGAINST the ${hb.toLowerCase()} bias` });
    }
  }

  // Stop sanity. A stop inside the spread or a fraction of ATR is taken out by noise rather than
  // by the market being wrong — the RR-106 defect, and the cause of the sub-3-pip stops that
  // forced 1-3 lot sizes on the live account.
  const a = num(atr), sp = num(spread);
  if (a !== null && a > 0) {
    const stopAtr = risk / a;
    const pts = stopAtr < 0.2 ? -15 : stopAtr < 0.35 ? -6 : stopAtr > 3 ? -5 : 5;
    score += pts;
    breakdown.push({
      factor: 'stop distance', points: pts,
      why: stopAtr < 0.35 ? `only ${stopAtr.toFixed(2)}x ATR — inside the noise`
        : stopAtr > 3 ? `${stopAtr.toFixed(1)}x ATR — very wide` : `${stopAtr.toFixed(2)}x ATR`,
    });
  }
  if (sp !== null && sp > 0 && risk < sp * 2) {
    score -= 12;
    breakdown.push({ factor: 'spread', points: -12, why: `stop is only ${(risk / sp).toFixed(1)}x the spread` });
  }

  // The model's own confidence: capped low on purpose. It is self-assessment, and this session
  // measured how badly a system can mis-rate its own output.
  const conf = num(aiConfidence);
  if (conf !== null) {
    const pts = Math.round(Math.max(-5, Math.min(8, (conf - 55) / 5)));
    score += pts;
    breakdown.push({ factor: 'AI confidence', points: pts, why: `model reported ${conf} (capped contribution)` });
  }

  // Stale candles mean the read describes a market that has moved on.
  if (dataFresh === false) {
    score -= 10;
    breakdown.push({ factor: 'data freshness', points: -10, why: 'candles are not live' });
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, grade: setupGrade(score), rr, geometry, breakdown, note: null };
}
