// Contract maths derived from the BROKER's own symbol specs (reported by the EA),
// rather than a hardcoded guess table. Pure functions so the money maths is testable.
//
// A spec is what MT5 reports for a symbol:
//   { point, digits, tickValue, tickSize, contractSize, stopsLevel, freezeLevel,
//     spread, volMin, volMax, volStep }
// tickValue is the account-currency value of ONE tickSize of price movement, per 1.00
// lot — the only reliable way to price a move, since contract sizes differ per symbol
// and per broker (Exness alone lists both USTECm and a x100 variant).

/** Account-currency value of a 1.0 move in PRICE, per 1.00 lot. null if unknown. */
export function valuePerPricePerLot(spec) {
  if (!spec) return null;
  const tv = Number(spec.tickValue), ts = Number(spec.tickSize);
  if (!(tv > 0) || !(ts > 0)) return null;
  return tv / ts;
}

/** Account-currency value of one PIP, per 1.00 lot, for a given pip size. */
export function valuePerPipPerLot(spec, pipSize) {
  const perPrice = valuePerPricePerLot(spec);
  if (perPrice === null || !(Number(pipSize) > 0)) return null;
  return perPrice * Number(pipSize);
}

/** Broker's minimum SL/TP distance from price, expressed in PRICE. null if unknown. */
export function minStopDistance(spec) {
  if (!spec) return null;
  const pt = Number(spec.point), lvl = Number(spec.stopsLevel);
  if (!(pt > 0) || !Number.isFinite(lvl) || lvl < 0) return null;
  return lvl * pt;
}

/** Current spread expressed in PRICE. null if unknown. */
export function spreadPrice(spec) {
  if (!spec) return null;
  const pt = Number(spec.point), sp = Number(spec.spread);
  if (!(pt > 0) || !Number.isFinite(sp) || sp < 0) return null;
  return sp * pt;
}

/** Clamp a lot size to the broker's volume min/max/step. */
export function normalizeLots(spec, lots) {
  let v = Number(lots);
  if (!Number.isFinite(v)) return null;
  const step = Number(spec?.volStep), min = Number(spec?.volMin), max = Number(spec?.volMax);
  if (step > 0) v = Math.round(v / step) * step;
  if (Number.isFinite(min) && min > 0 && v < min) v = min;
  if (Number.isFinite(max) && max > 0 && v > max) v = max;
  return Math.round(v * 100) / 100;
}

/** Margin the broker will hold for this position, from the terminal's own calculation. */
export function marginRequired(spec, lots) {
  const per = Number(spec?.marginPerLot);
  const v = Number(lots);
  if (!(per > 0) || !(v > 0)) return null;
  return Math.round(per * v * 100) / 100;
}

/**
 * Can the account actually open this position?
 *   BLOCKED  margin exceeds free margin -> the broker rejects it outright
 *   BLOCKED  margin would consume more than `maxUsePct` of free margin (default 80%)
 *   WARN     margin uses more than `warnUsePct` (default 30%) — little room left
 * Returns ok:true and null figures when the broker has not reported margin data, so an
 * unknown symbol is never blocked on a guess.
 */
export function assessMargin(spec, lots, freeMargin, { maxUsePct = 80, warnUsePct = 30 } = {}) {
  const out = { ok: true, blocked: false, reason: null, required: null, usePct: null };
  const required = marginRequired(spec, lots);
  const free = Number(freeMargin);
  if (required === null || !(free > 0)) return out;          // unknown -> do not guess
  out.required = required;
  out.usePct = Math.round((required / free) * 1000) / 10;
  if (required > free) {
    out.ok = false; out.blocked = true;
    out.reason = 'not enough free margin to open this position';
    return out;
  }
  if (out.usePct > maxUsePct) {
    out.ok = false; out.blocked = true;
    out.reason = `would tie up ${out.usePct}% of free margin`;
    return out;
  }
  if (out.usePct > warnUsePct) {
    out.ok = false;
    out.reason = `uses ${out.usePct}% of free margin`;
  }
  return out;
}

/**
 * Is this stop placeable and sane at the broker?
 *   BLOCKED  stop closer than the broker's minimum distance -> MT5 rejects with 10016
 *   BLOCKED  stop under 3x the spread -> the spread alone takes it out
 *   WARN     stop under 8x the spread -> thin cushion for ordinary noise
 */
export function assessStopDistance(spec, stopDistancePrice) {
  const out = { ok: true, blocked: false, reason: null, spreads: null, minDistance: null };
  const d = Number(stopDistancePrice);
  if (!(d > 0)) { out.ok = false; out.blocked = true; out.reason = 'stop distance must be greater than zero'; return out; }
  const minD = minStopDistance(spec);
  out.minDistance = minD;
  if (minD !== null && minD > 0 && d < minD) {
    out.ok = false; out.blocked = true;
    out.reason = `closer than the broker's minimum stop distance`;
    return out;
  }
  const sp = spreadPrice(spec);
  if (sp !== null && sp > 0) {
    out.spreads = d / sp;
    if (out.spreads < 3) { out.ok = false; out.blocked = true; out.reason = 'stop is under 3x the spread'; return out; }
    if (out.spreads < 8) { out.ok = false; out.reason = 'stop is under 8x the spread'; }
  }
  return out;
}
