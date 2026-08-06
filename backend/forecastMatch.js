// Relating forecasts to other things: to a trade awaiting approval, and to a strategy's
// track record.
//
// Two jobs, both of which are easy to get subtly wrong in a way that misleads:
//
//   matchTradeToForecast()  "the trade you are about to approve is the setup the system
//                            predicted at 4064.96" — but only when the evidence really says so.
//   strategyMatchRates()    per-strategy match rate over a window, with a minimum sample,
//                            because 100% off one resolved forecast is noise, not a track record.

import { sameInstrument } from './autoTradeConcurrency.js';

const n = (v) => Number(v);
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(n(v)) ? null : n(v));
const r1 = (v) => Math.round(n(v) * 10) / 10;

// ── trade ↔ forecast ─────────────────────────────────────────────────────────

export const MATCH_DEFAULTS = {
  entryTolPips: 30,     // how far the trade's entry may sit from the forecast's
  levelTolAtr: 0.5,     // or, failing that, how close to the forecast LEVEL it may be
  minScore: 0.45,       // below this the resemblance is too weak to assert
};

/**
 * Find the forecast a pending trade most resembles.
 *
 * Symbol uses sameInstrument() so a broker suffix (XAUUSDm) still matches an XAUUSD forecast —
 * the same defect that silently broke the one-per-symbol guard would otherwise silently break
 * this label too.
 *
 * Scored rather than boolean, because "close" is a spectrum: an exact entry on the same
 * timeframe deserves a stronger claim than a trade merely near the level. Returns null when
 * nothing clears the bar — an absent label is honest, a wrong one is not.
 */
export function matchTradeToForecast(trade, forecasts, { pip, options = {} } = {}) {
  const o = { ...MATCH_DEFAULTS, ...options };
  const pv = num(pip);
  if (!trade || !Array.isArray(forecasts) || !forecasts.length || pv === null) return null;

  const dir = String(trade.direction || '').toUpperCase();
  const entry = num(trade.entry ?? trade.entry_price);
  if (!dir || entry === null) return null;

  const scored = [];
  for (const f of forecasts) {
    if (!sameInstrument(f.symbol, trade.symbol)) continue;
    // Direction must agree. A forecast pointing the other way is not "a close match" in any
    // sense a trader would accept.
    const fDir = String(f.plan?.direction || f.expectedDirection || '').toUpperCase();
    if (!fDir || fDir !== dir) continue;

    const level = num(f.level);
    const fEntry = num(f.plan?.entry);
    const atr = num(f.atr);
    const entryGapPips = fEntry === null ? null : Math.abs(entry - fEntry) / pv;
    const levelGapPips = level === null ? null : Math.abs(entry - level) / pv;
    const levelTolPips = atr && atr > 0 ? (atr * o.levelTolAtr) / pv : o.entryTolPips;

    // Score the resemblance. Entry proximity carries the most weight; timeframe and the
    // strategy actually appearing in the forecast are corroboration, not the basis.
    let score = 0;
    const reasons = [];
    if (entryGapPips !== null && entryGapPips <= o.entryTolPips) {
      score += 0.55 * (1 - entryGapPips / o.entryTolPips);
      reasons.push(`entry ${r1(entryGapPips)} pips from the forecast entry`);
    }
    if (levelGapPips !== null && levelGapPips <= levelTolPips) {
      // Weighted to clear minScore on its own: a trade entering AT the forecast level IS that
      // setup, even when the forecast carried no ticket to compare entries against. Weighted
      // below the entry term, so it lands on CLOSE rather than STRONG.
      score += 0.5 * (1 - levelGapPips / levelTolPips);
      reasons.push(`${r1(levelGapPips)} pips from the ${f.levelLabel || f.levelType || 'forecast level'}`);
    }
    if (score <= 0) continue;                    // neither anchor is near: not this forecast
    if (trade.timeframe && f.timeframe && String(trade.timeframe) === String(f.timeframe)) {
      score += 0.1;
      reasons.push(`same timeframe (${f.timeframe})`);
    }
    const fires = Array.isArray(f.fires) ? f.fires : [];
    if (trade.strategy && fires.some((x) => x.strategyId === trade.strategy)) {
      score += 0.1;
      reasons.push(`${trade.strategy} is one of the strategies backing it`);
    }
    scored.push({ forecast: f, score: Math.min(1, score), reasons, entryGapPips, levelGapPips });
  }

  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (best.score < o.minScore) return null;

  return {
    forecastId: best.forecast.id,
    symbol: best.forecast.symbol,
    timeframe: best.forecast.timeframe,
    scenario: best.forecast.scenario,
    level: num(best.forecast.level),
    levelLabel: best.forecast.levelLabel || best.forecast.levelType || null,
    direction: String(best.forecast.plan?.direction || best.forecast.expectedDirection || '').toUpperCase(),
    forecastScore: num(best.forecast.bestScore),
    bestStrategy: best.forecast.bestStrategy || null,
    // STRONG only when the entry itself lines up; CLOSE when it is the level that matches.
    strength: best.score >= 0.75 ? 'STRONG' : 'CLOSE',
    confidence: Math.round(best.score * 100),
    entryGapPips: best.entryGapPips === null ? null : r1(best.entryGapPips),
    reasons: best.reasons,
    alternatives: scored.length - 1,
  };
}

// ── per-strategy match rate ──────────────────────────────────────────────────

export const RATE_DEFAULTS = {
  minSample: 3,        // below this a rate is not a track record
};

export const RATE_WINDOWS = ['today', 'yesterday', '7d', '30d', 'custom'];

/**
 * Resolve a named window to an absolute [from, to) in UTC ms.
 *
 * `today` and `yesterday` follow the caller's offset rather than UTC, because a trader's
 * "today" is their day — a UTC boundary would roll the numbers over at 6am local here.
 */
export function resolveWindow(range, { now = Date.now(), offsetMinutes = 0, from = null, to = null } = {}) {
  const dayMs = 86400000;
  const shift = offsetMinutes * 60000;
  const localMidnight = Math.floor((now + shift) / dayMs) * dayMs - shift;
  switch (String(range || '30d')) {
    case 'today': return { from: localMidnight, to: now, label: 'today' };
    case 'yesterday': return { from: localMidnight - dayMs, to: localMidnight, label: 'yesterday' };
    case '7d': return { from: now - 7 * dayMs, to: now, label: 'last 7 days' };
    case '30d': return { from: now - 30 * dayMs, to: now, label: 'last 30 days' };
    case 'custom': {
      const a = Date.parse(from || '');
      const b = Date.parse(to || '');
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
      return { from: a, to: b, label: 'custom range' };
    }
    default: return { from: now - 30 * dayMs, to: now, label: 'last 30 days' };
  }
}

/**
 * Match rate per strategy over resolved forecasts.
 *
 * `perfect` is the star. It requires BOTH a 100% match rate and at least `minSample` resolved
 * forecasts — a single lucky forecast reads as 100% and would put a star on a strategy with no
 * track record at all, which is worse than showing nothing.
 */
export function strategyMatchRates(rows, { minSample = RATE_DEFAULTS.minSample } = {}) {
  const m = new Map();
  for (const r of rows || []) {
    const k = r?.strategy || r?.best_strategy;
    if (!k) continue;
    if (!m.has(k)) m.set(k, { strategy: k, resolved: 0, matched: 0 });
    const g = m.get(k);
    g.resolved += 1;
    if (r.matched === 1 || r.matched === true) g.matched += 1;
  }
  return [...m.values()]
    .map((g) => {
      const rate = g.resolved > 0 ? Math.round((g.matched / g.resolved) * 1000) / 10 : null;
      const enough = g.resolved >= minSample;
      return {
        ...g,
        matchRate: rate,
        perfect: enough && g.matched === g.resolved && g.resolved > 0,
        // A 100% rate that has not earned its star yet — shown, but not starred.
        provisional: !enough && g.matched === g.resolved && g.resolved > 0,
        minSample,
      };
    })
    .sort((a, b) => (b.matchRate ?? -1) - (a.matchRate ?? -1) || b.resolved - a.resolved);
}
