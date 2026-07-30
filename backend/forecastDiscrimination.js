// Does a strategy respond to the LEVEL, or just to the bar shape?
//
// The what-if runner can make any strategy produce an opinion by appending a synthetic bar. That
// opinion is only worth showing if the strategy is actually reacting to liquidity being taken at
// a real level. Measured against a placebo arm — identical bars at prices deliberately far from
// any known level — several strategies turned out to fire as often or MORE often on the placebo:
//
//   liq-trap-pro, swing-structure-candles, smc-fvg, h4-liquidity-pin-entry ... 0% on placebo
//   smc-two-lines 40% real vs 58% placebo, liquidity-sweep-pro 5% vs 13%
//
// Shape-driven strategies are excluded from forecasts entirely. This module owns that judgement.
//
// Two things it is careful about, because getting them wrong would be worse than not filtering:
//
//   * It never judges on a small sample. Counts accumulate across scans and a strategy stays
//     UNMEASURED — included, but flagged — until there is enough evidence either way. Excluding
//     unmeasured strategies would leave a fresh install with an empty page and no explanation.
//   * Old evidence decays. A verdict from a market regime weeks ago should not pin a strategy
//     forever, so merging applies an optional decay to the existing counts.

const n = (v) => Number(v);

export const DISCRIMINATION_DEFAULTS = {
  // A synthetic bar pierces 0.35 ATR past the level and reacts ~0.55 ATR away from it. A placebo
  // price closer than that to real structure would let the bar sweep genuine liquidity, which is
  // exactly what the control is meant to exclude — so separation must exceed the bar's reach.
  minSeparationAtr: 1.0,
  minRealScenarios: 40,      // below this, no verdict either way
  minPlaceboScenarios: 40,   // a 0% placebo rate over 5 samples proves nothing
  minLift: 1.25,             // must fire meaningfully more at levels than at non-levels
  decay: 0.9,                // applied to accumulated counts on each merge
};

export const VERDICT = {
  LEVEL_DRIVEN: 'LEVEL_DRIVEN',
  SHAPE_DRIVEN: 'SHAPE_DRIVEN',
  UNMEASURED: 'UNMEASURED',
  SILENT: 'SILENT',
};

export function emptyStats() {
  return { realScenarios: 0, placeboScenarios: 0, byStrategy: {} };
}

function slot(stats, id) {
  if (!stats.byStrategy[id]) stats.byStrategy[id] = { realFires: 0, placeboFires: 0 };
  return stats.byStrategy[id];
}

/** Record one evaluated scenario: `fired` is the set/array of strategy ids that produced a signal. */
export function recordScenario(stats, { arm, fired = [] }) {
  if (!stats || (arm !== 'real' && arm !== 'placebo')) return stats;
  if (arm === 'real') stats.realScenarios += 1; else stats.placeboScenarios += 1;
  for (const id of fired) {
    const s = slot(stats, id);
    if (arm === 'real') s.realFires += 1; else s.placeboFires += 1;
  }
  return stats;
}

/**
 * Fold a fresh scan's counts into the accumulated history, decaying what was there.
 *
 * Decay is applied to the OLD counts only, so recent scans dominate without older evidence
 * being thrown away outright.
 */
export function mergeStats(accumulated, fresh, { decay = DISCRIMINATION_DEFAULTS.decay } = {}) {
  // A non-finite decay must not propagate into the counts — NaN would silently void every
  // accumulated measurement and make each strategy permanently UNMEASURED.
  const raw = n(decay);
  const d = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
  const out = emptyStats();
  const a = accumulated || emptyStats();
  const f = fresh || emptyStats();
  out.realScenarios = (n(a.realScenarios) || 0) * d + (n(f.realScenarios) || 0);
  out.placeboScenarios = (n(a.placeboScenarios) || 0) * d + (n(f.placeboScenarios) || 0);
  for (const id of new Set([...Object.keys(a.byStrategy || {}), ...Object.keys(f.byStrategy || {})])) {
    const av = a.byStrategy?.[id] || { realFires: 0, placeboFires: 0 };
    const fv = f.byStrategy?.[id] || { realFires: 0, placeboFires: 0 };
    out.byStrategy[id] = {
      realFires: (n(av.realFires) || 0) * d + (n(fv.realFires) || 0),
      placeboFires: (n(av.placeboFires) || 0) * d + (n(fv.placeboFires) || 0),
    };
  }
  return out;
}

/**
 * Verdict for one strategy.
 *
 * A strategy that never fires anywhere is SILENT, not SHAPE_DRIVEN — it is not producing bad
 * forecasts, it simply cannot be forecast this way (most need a longer bar sequence than a
 * level-arrival scenario specifies). Conflating the two would misreport why it is absent.
 */
export function discriminationFor(stats, id, options = {}) {
  const o = { ...DISCRIMINATION_DEFAULTS, ...options };
  const s = stats?.byStrategy?.[id] || { realFires: 0, placeboFires: 0 };
  const realScenarios = n(stats?.realScenarios) || 0;
  const placeboScenarios = n(stats?.placeboScenarios) || 0;
  const realRate = realScenarios > 0 ? n(s.realFires) / realScenarios : 0;
  const placeboRate = placeboScenarios > 0 ? n(s.placeboFires) / placeboScenarios : 0;
  const lift = placeboRate > 0 ? realRate / placeboRate : (realRate > 0 ? Infinity : 0);
  const enough = realScenarios >= o.minRealScenarios && placeboScenarios >= o.minPlaceboScenarios;

  let verdict = VERDICT.UNMEASURED;
  if (enough) {
    if (n(s.realFires) === 0 && n(s.placeboFires) === 0) verdict = VERDICT.SILENT;
    else if (lift >= o.minLift) verdict = VERDICT.LEVEL_DRIVEN;
    else verdict = VERDICT.SHAPE_DRIVEN;
  } else if (n(s.realFires) === 0 && n(s.placeboFires) === 0 && realScenarios > 0) {
    verdict = VERDICT.SILENT;
  }

  return {
    strategyId: id,
    verdict,
    realRate: Math.round(realRate * 1000) / 1000,
    placeboRate: Math.round(placeboRate * 1000) / 1000,
    lift: Number.isFinite(lift) ? Math.round(lift * 100) / 100 : null,
    levelOnly: enough && n(s.placeboFires) === 0 && n(s.realFires) > 0,
    realScenarios: Math.round(realScenarios),
    placeboScenarios: Math.round(placeboScenarios),
  };
}

/**
 * Split strategy ids into those allowed to produce forecasts and those excluded.
 *
 * Excluding SHAPE_DRIVEN strategies before evaluation is both the point and a cost saving — a
 * dropped strategy is never evaluated against a scenario at all.
 */
export function partitionStrategies(ids, stats, options = {}) {
  const allowed = [];
  const dropped = [];
  const unmeasured = [];
  for (const id of ids || []) {
    const d = discriminationFor(stats, id, options);
    if (d.verdict === VERDICT.SHAPE_DRIVEN) dropped.push(d);
    else {
      allowed.push(id);
      if (d.verdict === VERDICT.UNMEASURED) unmeasured.push(d);
    }
  }
  return { allowed, dropped, unmeasured };
}

/**
 * Full report, for the page: every strategy, its verdict and the evidence behind it.
 *
 * Best discriminator first. A level-only strategy carries `lift: null` because its true lift is
 * infinite — treating that null as a low number would sort the very best discriminators to the
 * bottom, which is what a first cut of this did.
 */
export function discriminationReport(ids, stats, options = {}) {
  const sortKey = (d) => (d.levelOnly ? Infinity : (d.lift ?? -1));
  return (ids || [])
    .map((id) => discriminationFor(stats, id, options))
    .sort((a, b) => sortKey(b) - sortKey(a) || b.realRate - a.realRate);
}

/**
 * Placebo prices for the control arm: same side and comparable distance as the real levels, but
 * far enough from ALL known structure that the synthetic bar cannot sweep genuine liquidity.
 *
 * Returns fewer than requested when the chart is too crowded to find clean gaps — a smaller but
 * valid control beats a contaminated one.
 */
export function placeboPrices(levels, { price, atr, realLevels, options = {} } = {}) {
  const o = { ...DISCRIMINATION_DEFAULTS, ...options };
  const p = n(price), a = n(atr);
  if (!Number.isFinite(p) || !(a > 0) || !Array.isArray(realLevels)) return [];
  const known = (levels || []).map((l) => n(l.price)).filter((v) => Number.isFinite(v));
  const gap = o.minSeparationAtr * a;
  const clear = (x) => known.every((lp) => Math.abs(lp - x) >= gap);

  const out = [];
  for (const lv of realLevels) {
    const from = n(lv.price);
    if (!Number.isFinite(from)) continue;
    // Walk outwards until a price is found that keeps the level's side and is clear of structure.
    for (const mult of [1.0, -1.0, 1.5, -1.5, 2.0, -2.0, 2.5]) {
      const x = from + mult * a;
      const sameSide = lv.side === 'below' ? x < p : x > p;
      if (!sameSide || !clear(x) || out.some((q) => Math.abs(q.price - x) < gap)) continue;
      out.push({ price: Math.round(x * 1e5) / 1e5, side: lv.side, placebo: true });
      break;
    }
  }
  return out;
}
