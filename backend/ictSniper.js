/**
 * ICT Sniper — enter the moment an ict-breaker setup says "enter now", with no stop attached.
 *
 * THE TRADE-OFF THIS EXISTS TO MAKE
 * The ict-breaker family loses its edge fast: measured on this account, the strategy is +2.2R
 * ideal and -0.03R once real delay is included, and the entire edge dies within the first five
 * minutes. Waiting for a sized ticket with a valid stop costs exactly that time — and 29 of 29
 * of this account's MT5 rejections were "10016 invalid stops" caused by the stop or target being
 * unusable at the moment of sending. A bare market order cannot be rejected for that reason.
 *
 * So the order goes in naked and the stop follows a few seconds later. That is deliberate, and
 * it is the ONLY reason to skip the stop on entry — not because the position should run without
 * one.
 *
 * THE STOP IS DERIVED BACKWARDS, AND THAT MATTERS
 * Normally risk is fixed and the stop distance decides the lot size. Here the LOT SIZE is given
 * (it comes from the signal, as the user asked) and the risk is a fixed dollar amount, so the
 * only free variable left is DISTANCE:
 *
 *     stopPips = riskUsd / (lots x pipValuePerLot)
 *
 * That inverts the usual relationship: a bigger lot size produces a TIGHTER stop, not a larger
 * loss. At 1.5 lots on a $10/pip pair, a $40 budget buys a 2.7-pip stop — inside the noise band
 * that measured -0.496R over 38 trades on this account. The number is therefore always returned
 * alongside the price so the caller can surface it rather than discover it after the fill.
 *
 * Pure: signal and config in, decision out. No I/O, no clock, no broker calls.
 */

import { priceAt } from './ictOrderResize.js';

const n = (v) => Number(v);
// Number(null) is 0 and 0 is finite — the coercion behind seven separate defects in this
// codebase. Every optional number goes through this rather than a bare isFinite.
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(n(v)) ? null : n(v));

/** Only the ict-breaker family. Nothing else enters without a stop. */
export const SNIPER_STRATEGIES = new Set(['ict-breaker', 'ict-break-pro']);

export const SNIPER_DEFAULTS = {
  enabled: false,          // OFF until deliberately switched on — it places live market orders
  symbols: [],             // empty = none, never "all": an empty allowlist on real orders is a loaded gun
  timeframes: [],          // same
  minGrade: 'A',
  maxConcurrent: 3,
  maxPerDay: 10,
  stopDelaySeconds: 10,    // how long the position runs bare before the stop is attached
  // This mode's OWN risk budget, deliberately separate from Account & Sizing.
  //
  // It is not conviction-scaled and does not follow the per-trade percentage, because it is not
  // sizing a trade — the lot size already came from the signal. It is the dollar floor placed
  // under a position that is already open.
  //
  // Counter-intuitive but important: with lots fixed, a BIGGER budget buys a WIDER stop. At 1.5
  // lots on a $10/pip pair, $40 gives 2.7 pips and $80 gives 5.3 — so raising this moves the
  // stop OUT of the noise band rather than deeper into it. It also doubles the loss when hit.
  riskUsd: 80,
};

const GRADE_RANK = { 'A+': 4, A: 3, B: 2, C: 1, D: 0 };
const gradeRank = (g) => GRADE_RANK[String(g || '').toUpperCase()] ?? 0;

/**
 * Should this "enter now" signal become a live market order?
 *
 * Gates are ordered cheapest-first and each returns its own reason, so a skip is always
 * explainable on the page rather than appearing as silence.
 */
export function shouldFire(signal, cfg = {}, { openSymbols = [], firedIds = [], todayCount = 0 } = {}) {
  const c = { ...SNIPER_DEFAULTS, ...cfg };
  const skip = (reason) => ({ fire: false, reason });

  if (c.enabled !== true) return skip('sniper mode is off');

  const strategy = String(signal?.strategy || '');
  if (!SNIPER_STRATEGIES.has(strategy)) return skip(`${strategy || 'unknown strategy'} is not in the ict-breaker family`);

  const symbol = String(signal?.symbol || '').toUpperCase();
  // Empty list means NONE, never all. On live market orders an "empty = everything" default is
  // the difference between a quiet config and an account-wide surprise.
  if (!c.symbols.length || !c.symbols.map((s) => String(s).toUpperCase()).includes(symbol)) {
    return skip(`${symbol || 'symbol'} is not enabled for sniper`);
  }

  const timeframe = String(signal?.timeframe || '').toUpperCase();
  if (!c.timeframes.length || !c.timeframes.map((t) => String(t).toUpperCase()).includes(timeframe)) {
    return skip(`${timeframe || 'timeframe'} is not enabled for sniper`);
  }

  if (gradeRank(signal?.grade ?? signal?.latest_grade) < gradeRank(c.minGrade)) {
    return skip(`grade ${signal?.grade || '-'} is below ${c.minGrade}`);
  }

  // One position per symbol — the user's rule, and it is checked against what is actually open
  // at the broker rather than against our own row count.
  if (openSymbols.map((s) => String(s).toUpperCase()).includes(symbol)) {
    return skip(`${symbol} already has a position running`);
  }

  if (openSymbols.length >= (num(c.maxConcurrent) ?? 3)) {
    return skip(`max concurrent (${c.maxConcurrent}) reached`);
  }
  if (todayCount >= (num(c.maxPerDay) ?? 10)) {
    return skip(`daily cap of ${c.maxPerDay} sniper entries reached`);
  }

  // The signal log is the durable dedupe: one entry per signal, however many times the alert
  // sweep revisits it.
  const id = signal?.id ?? signal?.signalId;
  if (id && firedIds.includes(id)) return skip('already fired for this signal');

  const lots = num(signal?.lots ?? signal?.suggestedLotSize ?? signal?.sizing?.lots);
  if (lots === null || lots <= 0) return skip('no lot size on the signal to trade with');

  return { fire: true, reason: `${strategy} ${symbol} ${timeframe} ${signal?.grade || ''} — enter now`, lots };
}

/**
 * The protective stop, attached AFTER the fill.
 *
 * `riskUsd` is a fixed dollar amount from Account & Sizing — deliberately not conviction-scaled,
 * because this stop is a floor under an already-open position rather than a sizing decision.
 *
 * Returns `stopPips` alongside the price precisely because the derivation runs backwards: with
 * the lot size given, a fixed dollar risk can produce a stop far tighter than the market's noise,
 * and the caller must be able to see that before it is sent.
 */
export function sniperStop({
  fillPrice, direction, lots, riskUsd, pipSize, pipValuePerLot, digits = null,
  minStopPips = 5,
}) {
  const entry = num(fillPrice), l = num(lots), risk = num(riskUsd);
  const ps = num(pipSize), pv = num(pipValuePerLot);
  if (entry === null || l === null || risk === null || ps === null || pv === null
      || l <= 0 || risk <= 0 || ps <= 0 || pv <= 0) {
    return { ok: false, error: 'need a fill price, lot size, risk budget and pip value' };
  }

  const stopPips = risk / (l * pv);
  const price = priceAt({ entry, direction, pips: stopPips, pipSize: ps, side: 'stop', digits });
  return {
    ok: true,
    stopLoss: price,
    stopPips: Math.round(stopPips * 10) / 10,
    riskUsd: Math.round(risk * 100) / 100,
    lots: l,
    // Surfaced, never enforced here: the user asked for a fixed dollar stop and this reports
    // when that lands inside the noise rather than quietly widening it.
    tooTight: stopPips < minStopPips,
    warning: stopPips < minStopPips
      ? `${Math.round(stopPips * 10) / 10}-pip stop — under ${minStopPips} pips measured -0.496R over 38 trades on this account. ${l} lots is what makes it this tight.`
      : null,
  };
}

/** Normalise a saved controller config so a bad edit cannot widen what trades. */
export function normalizeSniperConfig(raw = {}) {
  const arr = (v) => (Array.isArray(v) ? v.map((x) => String(x).toUpperCase()).filter(Boolean) : []);
  return {
    enabled: raw.enabled === true,
    symbols: arr(raw.symbols),
    timeframes: arr(raw.timeframes),
    minGrade: GRADE_RANK[String(raw.minGrade || '').toUpperCase()] !== undefined ? String(raw.minGrade).toUpperCase() : 'A',
    maxConcurrent: Math.max(1, Math.min(10, num(raw.maxConcurrent) ?? SNIPER_DEFAULTS.maxConcurrent)),
    maxPerDay: Math.max(1, Math.min(100, num(raw.maxPerDay) ?? SNIPER_DEFAULTS.maxPerDay)),
    // Clamped: zero would attach the stop before the fill is reported, and a long delay leaves
    // the position unprotected for exactly that long.
    stopDelaySeconds: Math.max(3, Math.min(120, num(raw.stopDelaySeconds) ?? SNIPER_DEFAULTS.stopDelaySeconds)),
    // Clamped at both ends for opposite reasons: below $1 the stop lands on top of the fill and
    // the broker refuses it, and an unbounded value would let a typo put the whole account on
    // one position. $500 is 5% of a $10,000 balance — already far past anything sane here.
    riskUsd: Math.max(1, Math.min(500, num(raw.riskUsd) ?? SNIPER_DEFAULTS.riskUsd)),
  };
}
