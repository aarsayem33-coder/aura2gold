/**
 * Size risk by CONVICTION, not at the cap every time.
 *
 * Until now every setup — A+ or C, 3R or 1.2R — was sized at 100% of the per-trade budget. That
 * is not how risk is actually allocated: the budget is a CEILING for the best setups, not the
 * amount every trade deserves. A marginal setup taken at full size costs the same as a great one
 * when it fails, and pays less when it works.
 *
 * WHY THESE TIERS ARE FIXED RATHER THAN FITTED TO PAST RESULTS
 * The obvious move is to derive fractions from measured expectancy per grade. That would be
 * overfitting on this account's history: 188 filled trades across 20 strategies, and the signal
 * log they would be fitted against runs 1.21R per trade optimistic. Fitted weights would look
 * precise and encode noise. These tiers are instead the standard conviction ladder — full size
 * only for the setups that clear every bar, and progressively less as evidence weakens — which
 * is explainable, stable, and cannot silently drift as a bad month accumulates.
 *
 * The ceiling still binds absolutely: conviction can only ever REDUCE risk below the configured
 * per-trade budget, never raise it. A "high conviction" override that risked more than the user
 * configured would defeat the point of configuring it.
 *
 * Pure: a setup in, a fraction and a dollar amount out. No I/O, no clock, no database.
 */

const n = (v) => Number(v);
// Number(null) is 0 and 0 is finite — the coercion behind seven separate defects in this
// codebase. Every optional number goes through this rather than a bare isFinite.
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(n(v)) ? null : n(v));
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/**
 * The conviction ladder. `minFraction` guards against a tier so small the broker minimum lot
 * would exceed it anyway, which would silently push risk back UP above the tier.
 */
export const CONVICTION_TIERS = [
  { key: 'FULL', label: 'Full size', fraction: 1.00, minScore: 85, minGrade: 'A+', minRr: 2.5 },
  { key: 'HIGH', label: 'High', fraction: 0.75, minScore: 78, minGrade: 'A', minRr: 2.0 },
  { key: 'NORMAL', label: 'Normal', fraction: 0.50, minScore: 70, minGrade: 'A', minRr: 1.8 },
  { key: 'STARTER', label: 'Starter', fraction: 0.30, minScore: 60, minGrade: 'B', minRr: 1.5 },
  { key: 'MINIMUM', label: 'Minimum', fraction: 0.20, minScore: 0, minGrade: 'C', minRr: 0 },
];

const GRADE_RANK = { 'A+': 4, A: 3, B: 2, C: 1, D: 0 };
const gradeRank = (g) => GRADE_RANK[String(g || '').toUpperCase()] ?? 0;

/**
 * Which tier a setup earns.
 *
 * Every bar must be cleared, not averaged: a 90-score setup with a 1.2R draw is not a full-size
 * trade, because the reward cannot pay for the risk however clean the pattern looks. Averaging
 * the criteria would let one strong input carry a weak one, which is how a marginal setup ends
 * up at full size.
 */
export function convictionTier(setup = {}, tiers = CONVICTION_TIERS) {
  const score = num(setup.score);
  const rr = num(setup.rr ?? setup.riskRewardRatio);
  const grade = setup.grade;
  const reasons = [];

  for (const t of tiers) {
    const scoreOk = t.minScore <= 0 || (score !== null && score >= t.minScore);
    const gradeOk = gradeRank(grade) >= gradeRank(t.minGrade);
    const rrOk = t.minRr <= 0 || (rr !== null && rr >= t.minRr);
    if (scoreOk && gradeOk && rrOk) {
      return {
        tier: t.key,
        label: t.label,
        fraction: t.fraction,
        why: `${grade || '?'} · score ${score ?? '?'} · ${rr ?? '?'}R clears ${t.label.toLowerCase()}`,
      };
    }
    // Record what stopped it, so the reason a setup was cut is always available.
    if (!reasons.length || reasons[reasons.length - 1].tier !== t.key) {
      const missing = [];
      if (!scoreOk) missing.push(`score ${score ?? '?'} < ${t.minScore}`);
      if (!gradeOk) missing.push(`grade ${grade || '?'} < ${t.minGrade}`);
      if (!rrOk) missing.push(`${rr ?? '?'}R < ${t.minRr}R`);
      reasons.push({ tier: t.key, missing });
    }
  }

  const last = tiers[tiers.length - 1];
  return {
    tier: last.key, label: last.label, fraction: last.fraction,
    why: reasons.length ? `fell to ${last.label.toLowerCase()}: ${reasons[0].missing.join(', ')}` : 'no quality inputs',
  };
}

/**
 * The risk to actually put on this trade.
 *
 * `budget` is the configured per-trade ceiling. The returned amount is always at or below it —
 * conviction reduces, never raises. `floorUsd` stops a low tier collapsing under the smallest
 * position the broker will accept, which would otherwise round back up and quietly undo the cut.
 */
export function convictionRisk(setup, budget, {
  tiers = CONVICTION_TIERS, floorUsd = null, enabled = true,
} = {}) {
  const cap = num(budget);
  if (cap === null || cap <= 0) return { riskUsd: null, tier: null, fraction: null, budget: cap, why: 'no budget configured' };
  if (!enabled) {
    return { riskUsd: r2(cap), tier: 'FULL', label: 'Full size', fraction: 1, budget: r2(cap), why: 'conviction sizing is off — every setup takes the full budget' };
  }

  const t = convictionTier(setup, tiers);
  let risk = cap * t.fraction;

  const floor = num(floorUsd);
  let flooredAt = null;
  if (floor !== null && floor > 0 && risk < floor) {
    // Taking LESS than the floor is impossible at the broker, so the honest options are the
    // floor or no trade. The caller decides; this reports which happened.
    risk = Math.min(cap, floor);
    flooredAt = r2(floor);
  }

  return {
    riskUsd: r2(risk),
    tier: t.tier,
    label: t.label,
    fraction: t.fraction,
    budget: r2(cap),
    // How much was held back, which is the number that makes the behaviour visible.
    heldBackUsd: r2(cap - risk),
    flooredAt,
    why: t.why,
  };
}

/** Normalise a user-supplied tier ladder, so a bad edit cannot produce risk above the cap. */
export function normalizeTiers(raw) {
  if (!Array.isArray(raw) || !raw.length) return CONVICTION_TIERS;
  const clean = raw
    .map((t, i) => {
      const fraction = num(t?.fraction);
      return {
        key: String(t?.key || `T${i}`).toUpperCase().slice(0, 16),
        label: String(t?.label || t?.key || `Tier ${i + 1}`).slice(0, 24),
        // Clamped to (0, 1]: a fraction above 1 would risk MORE than the configured budget,
        // which is the one thing this must never do.
        fraction: fraction === null ? 0.5 : Math.max(0.05, Math.min(1, fraction)),
        minScore: Math.max(0, Math.min(100, num(t?.minScore) ?? 0)),
        minGrade: GRADE_RANK[String(t?.minGrade || '').toUpperCase()] !== undefined ? String(t.minGrade).toUpperCase() : 'C',
        minRr: Math.max(0, num(t?.minRr) ?? 0),
      };
    })
    // Strictest first, so the first match is the highest tier a setup earns.
    .sort((a, b) => b.fraction - a.fraction);
  return clean;
}
