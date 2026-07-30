// Lifecycle of a setup forecast: drift while waiting, classification when price arrives.
//
// A forecast is a conditional claim — "IF price reaches this level and behaves this way, these
// strategies would fire". Its life has exactly three ends:
//
//   RESOLVED   price arrived at the level; what actually happened there is classified from the
//              real candles and compared against the forecast scenario. MATCHED means the
//              scenario played out, not that money was made — direction follow-through is
//              tracked separately, because "the sweep happened" and "the trade won" are
//              different facts and the report must not blur them.
//   EXPIRED    price never arrived inside the forecast's time window. Not a failure of the
//              scenario — the condition never occurred, and the report counts it separately.
//   SUPERSEDED the level stopped being forecastable before price ever arrived (typically the
//              re-scan no longer produces the forecast). Kept distinct from EXPIRED so "the
//              market structure changed" is not booked as "the timing was wrong".
//
// While waiting, every re-scan appends a drift point, so the page can show a forecast's score
// rising or decaying as the market moves — which the user explicitly asked to see.
//
// Everything here is pure: candles and clock come in as arguments.

const n = (v) => Number(v);
const r1 = (v) => Math.round(n(v) * 10) / 10;

export const LIFECYCLE = {
  WAITING: 'WAITING',
  RESOLVED: 'RESOLVED',
  EXPIRED: 'EXPIRED',
  SUPERSEDED: 'SUPERSEDED',
};

export const RESOLUTION_DEFAULTS = {
  touchAtr: 0.05,       // within this of the level counts as "arrived"
  pierceAtr: 0.05,      // beyond this past the level counts as traded-through
  followBars: 12,       // bars measured for follow-through after the event
  minWindowMs: 2 * 3600 * 1000,        // even a "now" forecast gets 2h to happen
  maxWindowMs: 48 * 3600 * 1000,       // nothing waits longer than 2 days
  driftCap: 96,         // drift points kept per forecast (~24h of 15-min scans)
};

/** One drift point: enough to chart quality over time, nothing more. */
export function driftEntry(forecast, nowMs = Date.now()) {
  return {
    ts: new Date(nowMs).toISOString(),
    rankScore: n(forecast?.rankScore) || 0,
    bestScore: n(forecast?.bestScore) || 0,
    agree: n(forecast?.agreeCount) || 0,
    etaMid: Number.isFinite(n(forecast?.eta?.midMinutes)) ? n(forecast.eta.midMinutes) : null,
  };
}

/** Append a drift point, keeping the FIRST entry forever (drift is measured against it). */
export function applyDrift(history, entry, cap = RESOLUTION_DEFAULTS.driftCap) {
  const h = Array.isArray(history) ? [...history, entry] : [entry];
  if (h.length <= cap) return h;
  return [h[0], ...h.slice(h.length - (cap - 1))];
}

/** Net drift: current quality minus quality when first forecast. */
export function driftSummary(history) {
  if (!Array.isArray(history) || history.length < 2) return { rank: 0, score: 0, points: history?.length || 0 };
  const first = history[0];
  const last = history[history.length - 1];
  return {
    rank: r1(n(last.rankScore) - n(first.rankScore)),
    score: r1(n(last.bestScore) - n(first.bestScore)),
    points: history.length,
  };
}

/** How long a forecast may wait: twice the outer ETA, floored and capped. */
export function forecastWindowMs(forecast, options = {}) {
  const o = { ...RESOLUTION_DEFAULTS, ...options };
  const maxEta = n(forecast?.eta?.maxMinutes);
  const ms = Number.isFinite(maxEta) ? maxEta * 2 * 60000 : o.minWindowMs;
  return Math.min(o.maxWindowMs, Math.max(o.minWindowMs, ms));
}

/**
 * Find the arrival bar and classify what price ACTUALLY did at the level.
 *
 * Uses the same closed-candle grammar as the scenario builder, so the forecast and its
 * resolution speak the same language:
 *   SWEEP_REJECT  traded through the level, closed back on the original side
 *   BREAK_HOLD    closed beyond, and the NEXT bar stayed beyond instead of reclaiming
 *   TOUCH_REJECT  reached the touch band without trading through, closed away
 *   AMBIGUOUS     arrived, but the bar fits none of the clean shapes
 *   GAPPED        a bar OPENED beyond the level without its range ever touching it —
 *                 price teleported past (weekend gap, news); no scenario can be judged
 *
 * BREAK_HOLD needs the bar AFTER the event, so with the event on the last closed bar the
 * classification is returned as PENDING_NEXT_BAR rather than guessed.
 */
export function classifyArrival(candles, { level, side, atr, options = {} }) {
  const o = { ...RESOLUTION_DEFAULTS, ...options };
  const L = n(level);
  const a = n(atr);
  if (!Array.isArray(candles) || !candles.length || !Number.isFinite(L) || !(a > 0)) return null;
  const below = side === 'below';
  const touch = o.touchAtr * a;
  const pierce = o.pierceAtr * a;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const [op, hi, lo, cl] = [n(c.open), n(c.high), n(c.low), n(c.close)];
    if (![op, hi, lo, cl].every(Number.isFinite)) continue;

    // "Reached" means the bar's RANGE intersects the touch band around the level. Testing only
    // the near extreme misreads a bar sitting entirely beyond the level as an arrival — which
    // is precisely the gap case that must classify as GAPPED instead.
    const reached = below
      ? lo <= L + touch && hi >= L - touch
      : hi >= L - touch && lo <= L + touch;
    const openedBeyond = below ? op < L - pierce : op > L + pierce;
    if (openedBeyond && !reached) {
      return { arrivedIdx: i, arrivedIso: c.time || null, actual: 'GAPPED' };
    }
    if (!reached) continue;

    const pierced = below ? lo < L - pierce : hi > L + pierce;
    const closedBeyond = below ? cl < L : cl > L;

    if (pierced && !closedBeyond) {
      return { arrivedIdx: i, arrivedIso: c.time || null, actual: 'SWEEP_REJECT' };
    }
    if (closedBeyond) {
      const next = candles[i + 1];
      if (!next) return { arrivedIdx: i, arrivedIso: c.time || null, actual: 'PENDING_NEXT_BAR' };
      const nextClose = n(next.close);
      const held = below ? nextClose < L : nextClose > L;
      return { arrivedIdx: i, arrivedIso: c.time || null, actual: held ? 'BREAK_HOLD' : 'SWEEP_REJECT' };
    }
    if (!pierced) {
      return { arrivedIdx: i, arrivedIso: c.time || null, actual: 'TOUCH_REJECT' };
    }
    return { arrivedIdx: i, arrivedIso: c.time || null, actual: 'AMBIGUOUS' };
  }
  return null;   // never arrived
}

/** Follow-through after the event: best and worst excursion in the expected direction. */
export function followThrough(candles, arrivedIdx, { direction, pip, bars = RESOLUTION_DEFAULTS.followBars }) {
  const start = arrivedIdx + 1;
  const slice = (candles || []).slice(start, start + bars);
  const ref = n(candles?.[arrivedIdx]?.close);
  const pv = n(pip);
  if (!slice.length || !Number.isFinite(ref) || !(pv > 0)) return null;
  const buy = String(direction).toUpperCase() === 'BUY';
  // Both start at 0, so an excursion that never went against the trade reports 0 rather than a
  // negative number — for a clean rejection that is the correct and meaningful answer.
  let mfe = 0, mae = 0;
  for (const c of slice) {
    const hi = n(c.high), lo = n(c.low);
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) continue;
    mfe = Math.max(mfe, buy ? hi - ref : ref - lo);
    mae = Math.max(mae, buy ? ref - lo : hi - ref);
  }
  return { mfePips: r1(mfe / pv), maePips: r1(mae / pv), barsMeasured: slice.length };
}

/**
 * Resolve one stored forecast against candles SINCE it was made.
 *
 * Returns null when nothing changes (still waiting, window still open); otherwise the fields
 * to persist. `matched` compares the actual behaviour to the forecast scenario; GAPPED and
 * AMBIGUOUS resolve with matched=false but keep the actual label so the report can show WHY.
 */
export function resolveForecast(row, candlesSince, { nowMs = Date.now(), pip, options = {} } = {}) {
  const o = { ...RESOLUTION_DEFAULTS, ...options };
  const madeMs = Date.parse(row?.createdAt || '');
  if (!Number.isFinite(madeMs)) return null;

  const arrival = classifyArrival(candlesSince, {
    level: row.level, side: row.side, atr: row.atr, options: o,
  });

  if (!arrival) {
    const windowMs = forecastWindowMs({ eta: { maxMinutes: row.etaMaxMinutes } }, o);
    if (nowMs - madeMs > windowMs) {
      return { status: LIFECYCLE.EXPIRED, resolvedAt: new Date(nowMs).toISOString() };
    }
    return null;
  }
  if (arrival.actual === 'PENDING_NEXT_BAR') return null;   // one more closed bar decides it

  const matched = arrival.actual === row.scenario;
  const follow = followThrough(candlesSince, arrival.arrivedIdx, {
    direction: row.expectedDirection, pip,
  });
  const actualMinutes = (() => {
    const t = Date.parse(arrival.arrivedIso || '');
    return Number.isFinite(t) ? Math.max(0, Math.round((t - madeMs) / 60000)) : null;
  })();

  return {
    status: LIFECYCLE.RESOLVED,
    resolvedAt: new Date(nowMs).toISOString(),
    actual: arrival.actual,
    matched,
    arrivedIso: arrival.arrivedIso,
    actualMinutes,
    mfePips: follow?.mfePips ?? null,
    maePips: follow?.maePips ?? null,
  };
}
