/**
 * aiMarketContext.js — the positional market read handed to the AI reviewers.
 *
 * WHY THIS EXISTS
 * The repo already computes a full institutional read — market structure with CHoCH, the key
 * liquidity map (PDH/PDL, session highs/lows, round numbers, equal highs/lows), dealing range,
 * premium/discount, drive classification, graded sweeps — but none of it ever reached an LLM
 * prompt. It was wired only to strategy engines, REST endpoints and React pages. The chart
 * reviewer in particular was handed seven fields and then ASKED to read structure off a
 * screenshot that the engine had already measured from closes.
 *
 * WHAT THIS IS NOT
 * It does not replace forecastMarketRead.js. That module is the CANDLE-level read (raw OHLC,
 * patterns, wicks, order blocks, FVGs, retests of one level). This one is the POSITIONAL read:
 * where price sits in the range, which levels matter, which way the draw points. They compose;
 * neither subsumes the other.
 *
 * It also does not reimplement the liquidity map. buildLiquidityChart() already composes
 * detectKeyLiquidityLevels + analyseStructure + classifyLevel and is battle-tested behind
 * /api/liquidity-chart. Building a second assembler would create exactly the divergence this
 * module exists to prevent.
 *
 * DISCIPLINE IS ADVISORY, AND THAT IS STRUCTURAL
 * Account risk state (daily R budget) is carried in its own `discipline` branch and rendered by
 * its own serialiser. It is deliberately kept OUT of the market read: putting account state
 * into the description of price is how a discipline layer starts silently cutting signal count.
 * Price-derived facts that happen to matter for discipline — over-extension, ADR usage — belong
 * to the market read, because they are properties of the market, not of the account.
 */
import { buildLiquidityChart } from './liquidityChart.js';
import { atr14, gradeSweep, classifyDrive } from './liquidityEngine.js';

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const r5 = (v) => (Number.isFinite(v) ? Math.round(v * 1e5) / 1e5 : v);

/** Run a detector without letting a single failure take the whole context down. */
function safe(fn, fallback = null) {
  try {
    const out = fn();
    return out === undefined ? fallback : out;
  } catch {
    return fallback;
  }
}

/**
 * The ATR every AI path should score against.
 *
 * systemDecision has NEVER carried a top-level `atr` — the value lives on the feature vector at
 * signalEngine.js `features: extractFeatures(...)`. server.js read `sd.atr ?? null`, which is
 * always undefined, so scoreChartSetup's stop-distance component (worth -15 to +5) silently
 * never fired on a single AI chart read. Resolution order is deliberate: the feature vector is
 * measured from the same candles the decision used; breakout.atr is the same ATR computed by
 * breakoutEngine on the same series; atr14 is the last resort.
 *
 * Returns null rather than 0 when nothing is available. `Number(null) === 0` would read as
 * "zero volatility" and make every stop look infinitely wide.
 */
export function resolveAtr({ systemDecision = null, breakout = null, candles = null } = {}) {
  return num(systemDecision?.features?.atr)
    ?? num(systemDecision?.atr)
    ?? num(breakout?.atr)
    ?? num(Array.isArray(candles) && candles.length ? atr14(candles) : null)
    ?? null;
}

/**
 * ADR usage, computed HERE rather than read from systemDecision.
 *
 * sd.adrUsagePercent is only populated when aggregateSignals is given `adr` AND `dailyHighLow`.
 * The chart path passes neither, so it is always 0 — forwarding it would put a fabricated
 * "0% of the daily range used" in front of the model. Passing adr into that call is not an
 * option either: signalEngine forces HOLD on exhaustion, which is signal generation.
 *
 * `dailyCandles` is expected newest-last and to INCLUDE today's forming bar.
 */
function computeAdrUsage(dailyCandles, days = 14) {
  if (!Array.isArray(dailyCandles) || dailyCandles.length < 3) {
    return { available: false, usagePercent: null, exhausted: false, adr: null, todayRange: null, note: 'no daily candles supplied' };
  }
  const completed = dailyCandles.slice(0, -1).slice(-days);
  if (completed.length < 2) {
    return { available: false, usagePercent: null, exhausted: false, adr: null, todayRange: null, note: 'not enough completed daily bars' };
  }
  const ranges = completed.map((c) => num(c.high) - num(c.low)).filter((r) => Number.isFinite(r) && r > 0);
  if (!ranges.length) return { available: false, usagePercent: null, exhausted: false, adr: null, todayRange: null, note: 'daily bars unusable' };
  const adr = ranges.reduce((s, r) => s + r, 0) / ranges.length;
  // Report the window ACTUALLY averaged, not the one requested. Callers supply as few as 8
  // daily bars, and calling a 7-day mean a "14-day average range" in front of the model is the
  // same fabricated precision this module exists to avoid.
  const usedDays = ranges.length;
  const today = dailyCandles[dailyCandles.length - 1];
  const todayRange = num(today?.high) - num(today?.low);
  if (!Number.isFinite(todayRange) || adr <= 0) {
    return { available: false, usagePercent: null, exhausted: false, adr: r5(adr), todayRange: null, note: 'today\'s range unavailable' };
  }
  const usagePercent = Math.round((todayRange / adr) * 100);
  return {
    available: true,
    usagePercent,
    exhausted: usagePercent >= 100,
    adr: r5(adr),
    todayRange: r5(todayRange),
    days: usedDays,
    note: `${usedDays}-day average range`,
  };
}

/** Signed ATR distance from EMA21 — the over-extension guard, a property of PRICE. */
function computeExtension(systemDecision, candles, atr, thresholdAtr) {
  const fromFeatures = num(systemDecision?.features?.emaDistanceAtr);
  if (fromFeatures !== null) {
    return { emaDistanceAtr: fromFeatures, extended: Math.abs(fromFeatures) >= thresholdAtr, thresholdAtr };
  }
  if (!Array.isArray(candles) || candles.length < 21 || !atr || atr <= 0) {
    return { emaDistanceAtr: null, extended: false, thresholdAtr };
  }
  const period = 21;
  const k = 2 / (period + 1);
  let ema = candles.slice(0, period).reduce((s, c) => s + num(c.close), 0) / period;
  for (let i = period; i < candles.length; i++) ema = num(candles[i].close) * k + ema * (1 - k);
  const last = num(candles[candles.length - 1].close);
  const d = Math.round(((last - ema) / atr) * 100) / 100;
  return { emaDistanceAtr: d, extended: Math.abs(d) >= thresholdAtr, thresholdAtr };
}

/**
 * Rank levels for a token budget without dropping the ones the reader needs.
 *
 * Sorting alone is not enough: the nearest level each way and the stated draw must always be
 * present, or the map contradicts the narrative sitting under it.
 */
function rankLevels(levels, { maxLevels, draw, focusLevel }) {
  const list = (levels || []).filter((l) => l && l.status !== 'INVALIDATED');
  if (list.length <= maxLevels) return list;

  const mustKeep = new Set();
  const byPrice = (p) => list.find((l) => Math.abs(num(l.price) - num(p)) < 1e-9);
  for (const p of [draw?.primary?.price, draw?.alternative?.price]) {
    const hit = p === undefined || p === null ? null : byPrice(p);
    if (hit) mustKeep.add(hit);
  }
  const above = list.filter((l) => l.side === 'above').sort((a, b) => a.distance - b.distance)[0];
  const below = list.filter((l) => l.side === 'below').sort((a, b) => a.distance - b.distance)[0];
  if (above) mustKeep.add(above);
  if (below) mustKeep.add(below);
  // The two levels bracketing the forecast/prediction level: without them the model cannot see
  // what sits between price and the thing it is being asked about.
  const focus = num(focusLevel);
  if (focus !== null) {
    const over = list.filter((l) => num(l.price) >= focus).sort((a, b) => a.price - b.price)[0];
    const under = list.filter((l) => num(l.price) < focus).sort((a, b) => b.price - a.price)[0];
    if (over) mustKeep.add(over);
    if (under) mustKeep.add(under);
  }

  const scored = [...list].sort((a, b) => {
    const fresh = (l) => (l.status === 'FRESH' ? 1 : 0);
    return (fresh(b) - fresh(a))
      || ((b.strength || 0) - (a.strength || 0))
      || ((a.distanceAtr ?? 99) - (b.distanceAtr ?? 99));
  });
  const out = [...mustKeep];
  for (const l of scored) {
    if (out.length >= maxLevels) break;
    if (!out.includes(l)) out.push(l);
  }
  return out.slice(0, maxLevels).sort((a, b) => b.price - a.price);
}

/**
 * Build the positional read. Pure: no I/O, no DB, no clock beyond what the candles carry.
 *
 * @param {object[]} candles       CLOSED bars on the analysis timeframe (caller slices)
 * @param {object[]} dailyCandles  D1 bars INCLUDING today's forming bar (PDH/PDL needs [-2])
 * @param {object}   systemDecision `sd` from aggregateSignals, when the caller has one
 * @param {object}   dailyRisk     from computeDailyRiskBudget — ADVISORY ONLY
 */
export function buildAiMarketContext({
  symbol = '',
  timeframe = '',
  candles = [],
  dailyCandles = null,
  price = null,
  atr = null,
  h4Trend = null,
  h1Trend = null,
  systemDecision = null,
  focusLevel = null,
  dailyRisk = null,
  maxLevels = 12,
  maxBars = 300,
  includeSweepGrade = true,
  extensionThresholdAtr = 2,
} = {}) {
  // A flag flip rolls this back without a redeploy — it feeds a UI that is traded from.
  if (String(process?.env?.AI_CONTEXT_ENRICHMENT || '').toLowerCase() === 'off') {
    return { ok: false, reason: 'disabled', discipline: buildDiscipline(dailyRisk) };
  }
  const bars = Array.isArray(candles) ? candles.slice(-maxBars) : [];
  if (bars.length < 30) {
    return { ok: false, reason: 'not enough candles for a positional read (need 30+)', discipline: buildDiscipline(dailyRisk) };
  }

  const lc = safe(() => buildLiquidityChart(bars, { symbol, dailyCandles, maxLevels: 40 }), null);
  if (!lc || !lc.ok) {
    return { ok: false, reason: lc?.error || 'liquidity read unavailable', discipline: buildDiscipline(dailyRisk) };
  }

  const resolvedAtr = num(atr) ?? num(lc.atr) ?? null;
  const resolvedPrice = num(price) ?? num(lc.price) ?? null;

  const structure = {
    bias: lc.structure?.bias || 'RANGING',
    swingTrail: (lc.structure?.swings || []).slice(-6).map((s) => s.label).filter(Boolean),
    events: (lc.structure?.events || []).map((e) => ({ type: e.type, direction: e.direction, level: e.level, note: e.note })),
  };

  // Premium/discount. Prefer the engine's own read; fall back to the dealing range. `fit` is
  // finalised against the committed decision, so on a HOLD row it is NEUTRAL — meaning "no
  // committed side to fit against", NOT "location is neutral".
  const pd = systemDecision?.premiumDiscount || null;
  let location = null;
  if (pd && num(pd.pct) !== null) {
    location = {
      pct: num(pd.pct), zone: pd.zone || null,
      fit: String(systemDecision?.decision || '').toUpperCase() === 'HOLD' ? null : (pd.fit || null),
      rangeHigh: num(pd.rangeHigh), rangeLow: num(pd.rangeLow), equilibrium: num(pd.equilibrium),
      source: 'systemDecision',
    };
  } else if (lc.dealingRange && resolvedPrice !== null) {
    const { high, low } = lc.dealingRange;
    const span = num(high) - num(low);
    if (span > 0) {
      const pct = Math.round(((resolvedPrice - num(low)) / span) * 100);
      location = {
        pct, zone: pct >= 60 ? 'PREMIUM' : pct <= 40 ? 'DISCOUNT' : 'EQUILIBRIUM',
        fit: null, rangeHigh: num(high), rangeLow: num(low), equilibrium: r5((num(high) + num(low)) / 2),
        source: 'dealingRange',
      };
    }
  }

  const levels = rankLevels(lc.levels, { maxLevels, draw: lc.draw, focusLevel });
  const driveDir = structure.bias === 'BEARISH' ? 'BEARISH' : 'BULLISH';

  const ctx = {
    ok: true,
    symbol, timeframe,
    price: resolvedPrice,
    atr: resolvedAtr,
    barsUsed: bars.length,
    structure,
    dealingRange: lc.dealingRange,
    location,
    liquidity: {
      levels,
      draw: lc.draw || null,
      recentlySwept: (lc.recentlySwept || []).slice(0, 3).map((l) => ({ label: l.label, price: l.price, pool: l.pool })),
      nearestAbove: levels.filter((l) => l.side === 'above').sort((a, b) => a.distance - b.distance)[0] || null,
      nearestBelow: levels.filter((l) => l.side === 'below').sort((a, b) => a.distance - b.distance)[0] || null,
      counts: {
        considered: lc.consideredCount ?? null,
        shown: levels.length,
        fresh: levels.filter((l) => l.status === 'FRESH').length,
        swept: levels.filter((l) => l.status === 'SWEPT').length,
        invalidated: lc.invalidatedCount ?? 0,
      },
    },
    sweepSignal: includeSweepGrade
      ? safe(() => gradeSweep(bars, { symbol, dailyCandles, h4Trend, h1Trend }), null)
      : null,
    drive: safe(() => classifyDrive(bars, driveDir), null),
    session: systemDecision?.sessionContext || null,
    adr: computeAdrUsage(dailyCandles),
    newsRisk: systemDecision?.newsRisk || null,
    extension: computeExtension(systemDecision, bars, resolvedAtr, extensionThresholdAtr),
    smc: {
      fvgs: (systemDecision?.fvgs || []).slice(-5),
      orderBlocks: (systemDecision?.orderBlocks || []).slice(-5),
      confluences: (systemDecision?.confluences || []).slice(0, 6),
    },
    focus: null,
    discipline: buildDiscipline(dailyRisk),
    caveats: [...(lc.caveats || [])],
  };

  const focus = num(focusLevel);
  if (focus !== null && resolvedPrice !== null) {
    ctx.focus = {
      level: focus,
      side: focus >= resolvedPrice ? 'above' : 'below',
      distanceAtr: resolvedAtr ? Math.round((Math.abs(focus - resolvedPrice) / resolvedAtr) * 100) / 100 : null,
    };
  }
  return ctx;
}

/** Normalise the risk budget into the advisory envelope. Never consumed by scoring. */
function buildDiscipline(dailyRisk) {
  if (!dailyRisk || dailyRisk.available === false) {
    return { available: false, advisoryOnly: true };
  }
  return {
    available: true,
    settledR: num(dailyRisk.settledR),
    dailyStopR: num(dailyRisk.dailyStopR),
    remainingR: num(dailyRisk.remainingR),
    limitHit: Boolean(dailyRisk.limitHit),
    wins: num(dailyRisk.wins) ?? 0,
    losses: num(dailyRisk.losses) ?? 0,
    openCount: num(dailyRisk.openCount) ?? 0,
    note: dailyRisk.note || null,
    advisoryOnly: true,
  };
}

// ── serialisation ────────────────────────────────────────────────────────────
// Line-oriented text, not pretty JSON: the same content costs roughly 2.5x the tokens as
// JSON.stringify(x, null, 2), and the liquidity map is the largest new block in the prompt.

// Truncates as well as pads: a value wider than its column silently ran into the next one,
// which produced rows like `BROKEN_ACCEPTED-0.52` where the status ate the distance.
const pad = (v, w) => {
  const s = String(v ?? '');
  return (s.length >= w ? `${s.slice(0, w - 1)} ` : s.padEnd(w));
};

// Display forms for level status. BROKEN_ACCEPTED is the only one that does not fit the
// column, and "BROKEN" reads better anyway — the legend explains what it means.
const STATUS_LABEL = { BROKEN_ACCEPTED: 'BROKEN' };
const statusOf = (s) => STATUS_LABEL[s] || s || '?';

/** @returns {string} '' when there is nothing to say, so callers can interpolate blindly. */
export function formatAiMarketContext(ctx, { maxLevels = 12, includeSmc = true } = {}) {
  if (!ctx || !ctx.ok) return '';
  const L = [];
  const px = ctx.price ?? '?';
  const atr = ctx.atr ?? '?';

  L.push(`=== DETERMINISTIC MARKET READ — ${ctx.symbol} ${ctx.timeframe} (measured from closed bars, not inferred) ===`);
  const sess = ctx.session?.label || ctx.session?.key;
  L.push(`Price ${px} · ATR(14) ${atr}${sess ? ` · Session ${sess}` : ''}`);

  L.push(`Structure: ${ctx.structure.bias}${ctx.structure.swingTrail.length ? ` — last swings ${ctx.structure.swingTrail.join(' · ')}` : ''}`);
  if (ctx.structure.events.length) {
    for (const e of ctx.structure.events) L.push(`Structure event: ${e.type} ${e.direction} @ ${e.level} — ${e.note}`);
  } else {
    L.push('Structure event: none — no close has broken the prior swing either way');
  }

  if (ctx.dealingRange) L.push(`Dealing range ${ctx.dealingRange.low} - ${ctx.dealingRange.high}`);
  if (ctx.location) {
    const fit = ctx.location.fit ? ` (fit for the committed side: ${ctx.location.fit})` : '';
    L.push(`Location: ${ctx.location.pct}% of range -> ${ctx.location.zone}${fit}`);
  }
  if (ctx.drive?.label && ctx.drive.label !== 'NONE') L.push(`Drive: ${ctx.drive.label}${ctx.drive.note ? ` — ${ctx.drive.note}` : ''}`);
  if (ctx.extension?.emaDistanceAtr !== null && ctx.extension?.emaDistanceAtr !== undefined) {
    L.push(`Over-extension: ${ctx.extension.emaDistanceAtr >= 0 ? '+' : ''}${ctx.extension.emaDistanceAtr}x ATR from EMA21 (stretched at >= ${ctx.extension.thresholdAtr}x) — ${ctx.extension.extended ? 'STRETCHED' : 'not stretched'}`);
  }
  if (ctx.adr?.available) {
    L.push(`ADR: ${ctx.adr.usagePercent}% of the ${ctx.adr.note} used today — ${ctx.adr.exhausted ? 'EXHAUSTED' : 'not exhausted'}`);
  }
  if (ctx.newsRisk && (ctx.newsRisk.block || ctx.newsRisk.caution)) {
    L.push(`News risk: ${ctx.newsRisk.block ? 'BLOCK' : 'caution'}${ctx.newsRisk.reason ? ` — ${ctx.newsRisk.reason}` : ''}`);
  }

  // Liquidity map
  const c = ctx.liquidity.counts;
  L.push('');
  L.push(`LIQUIDITY MAP — ${c.considered ?? '?'} levels considered, ${c.shown} shown, ${c.fresh} fresh, ${c.swept} swept`);
  const rows = ctx.liquidity.levels.slice(0, maxLevels);
  if (!rows.length) {
    L.push('  (no levels within reach)');
  } else {
    L.push(`  ${pad('side', 6)}${pad('price', 11)}${pad('label', 24)}${pad('str', 5)}${pad('status', 9)}${pad('dist(ATR)', 11)}scope`);
    for (const l of rows) {
      const dist = l.distanceAtr === null || l.distanceAtr === undefined ? '?' : `${l.side === 'above' ? '+' : '-'}${Math.abs(l.distanceAtr)}`;
      L.push(`  ${pad(l.side, 6)}${pad(l.price, 11)}${pad(l.label, 24)}${pad(l.strength, 5)}${pad(statusOf(l.status), 9)}${pad(dist, 11)}${l.scope}${l.inducement ? '  <- inducement' : ''}`);
    }
  }
  const d = ctx.liquidity.draw;
  if (d?.primary) {
    L.push(`Draw on liquidity: PRIMARY ${d.primary.price} ${d.primary.label} (${d.primary.pool}, ${d.primary.scope}) — ${d.basis}`);
    if (d.alternative) L.push(`  ALTERNATIVE ${d.alternative.price} ${d.alternative.label} (${d.alternative.pool}, ${d.alternative.scope})`);
    if (d.invalidation) L.push(`  Invalidation: ${d.invalidation}`);
  } else {
    L.push('Draw on liquidity: none — no fresh pool on either side');
  }
  if (ctx.liquidity.recentlySwept.length) {
    L.push(`Recently swept: ${ctx.liquidity.recentlySwept.map((s) => `${s.label} ${s.price}`).join(' · ')}`);
  }

  // Graded sweep
  L.push('');
  if (ctx.sweepSignal?.decision) {
    const s = ctx.sweepSignal;
    L.push(`GRADED SWEEP SIGNAL: ${s.decision} grade ${s.grade} (${s.score}) — ${s.reason || ''}`);
  } else {
    L.push('GRADED SWEEP SIGNAL: none — no qualifying sweep in the recent window');
  }

  if (includeSmc) {
    const fv = ctx.smc.fvgs.length, ob = ctx.smc.orderBlocks.length;
    if (fv || ob) L.push(`SMC OBJECTS: ${fv} unfilled FVG(s), ${ob} order block(s) in view`);
    if (ctx.smc.confluences.length) {
      L.push(`TOP CONFLUENCES: ${ctx.smc.confluences.map((x) => x.name || x.label || x).slice(0, 6).join(' · ')}`);
    }
  }

  L.push('');
  L.push('KEY: `str` = OBVIOUSNESS 1-5 (how many desks watch it), not probability. `status` = what price');
  L.push('already DID there — FRESH untouched, SWEPT wicked+reclaimed, BROKEN closed beyond, TESTED held,');
  L.push('REJECTED pushed away. EXTERNAL = outside the dealing range (a draw); INTERNAL = inducement fuel.');
  if (ctx.caveats.length) L.push(`Caveats: ${ctx.caveats.join(' ')}`);

  return L.join('\n');
}

/**
 * The advisory block. Wording is load-bearing: without an explicit, repeated prohibition the
 * model treats a spent risk budget as a reason to mark the setup down, which silently converts
 * a discipline aid into a signal filter.
 */
export function formatDisciplineAdvisory(discipline) {
  if (!discipline || !discipline.available) return '';
  const d = discipline;
  const L = [];
  L.push('=== TRADING DISCIPLINE STATE (ADVISORY — READ IT, DO NOT SCORE IT) ===');
  L.push(`Today: ${d.wins} win(s) / ${d.losses} loss(es) settled, net ${d.settledR ?? '?'}R, ${d.openCount} position(s) still open.`);
  // Past the stop, remainingR goes negative, and "room remaining: -11R" reads as nonsense —
  // it is an overshoot, not room. Say which it is rather than leaving the model to interpret
  // a negative quantity of something that cannot be negative.
  const rem = num(d.remainingR);
  const room = rem === null ? 'unknown'
    : rem >= 0 ? `Room remaining: ${rem}R.`
      : `EXCEEDED by ${Math.abs(rem)}R — already past the stop.`;
  L.push(`Daily stop: -${Math.abs(d.dailyStopR ?? 0)}R. ${room}`);
  if (d.limitHit) L.push('DAILY STOP REACHED — the playbook says the desk stops trading today.');
  L.push('');
  L.push('HOW TO USE THIS BLOCK. THIS IS A HARD RULE, NOT A PREFERENCE:');
  L.push('This describes the DESK\'s state today. It says nothing about whether THIS setup is good.');
  L.push('It is position-management information for the human, and it MUST NOT change your verdict,');
  L.push('your score, your confidence, your direction, or your entry/stop/target.');
  L.push('');
  L.push('A setup that is an A is still an A on a day the desk is down 2R. The market has no memory');
  L.push('of this morning\'s fills. If you mark a good setup down because the account had a bad day,');
  L.push('you have destroyed the only thing this review is for — an independent read of the setup.');
  L.push('');
  L.push('  - Do NOT move TAKE to WATCH or SKIP because the daily stop is hit.');
  L.push('  - Do NOT reduce your score or confidence because of the R budget.');
  L.push('  - Do NOT turn BUY/SELL into NO_TRADE because of anything in this block.');
  L.push('  - Do NOT list the R budget as a risk to the trade — it is not one.');
  L.push('  - DO put one sentence about it in `discipline_note`, addressed to the human, so they');
  L.push('    see it before they size the position. That field is the ONLY place it belongs.');
  L.push('');
  L.push('Judge this setup on structure, liquidity, location and reward-to-risk. The risk budget');
  L.push('decides whether the HUMAN takes the trade. It never decides whether the SETUP is good.');
  return L.join('\n');
}
