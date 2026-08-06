// What a forecast was actually WORTH, and whether you actually traded it.
//
// A matched scenario is not a won trade. "Price swept the PDL and rejected, as predicted" and
// "the ticket made money" are different claims, and the report must not let the first stand in
// for the second. This module answers the second, twice over:
//
//   settleForecastTicket()  hypothetical: replay the forecast's own entry/SL/TP against the real
//                           candles that followed, in pips and R.
//   matchRealTrade()        actual: link the forecast to a trade you really placed, and report
//                           its broker P&L — only when the evidence is strong enough to name it.
//
// The replay follows the same conservative grammar the forex settler already uses: a bar that
// touches both the stop and a target is AMBIGUOUS, never a win. Inflating a coin-flip bar into a
// win is exactly how a track record becomes a lie.

const n = (v) => Number(v);
const r1 = (v) => Math.round(n(v) * 10) / 10;
const r2 = (v) => Math.round(n(v) * 100) / 100;
const finPos = (v) => (Number.isFinite(n(v)) && n(v) > 0 ? n(v) : null);
// Number(null) and Number('') are 0, and 0 is finite — so a plain Number.isFinite check treats
// "no trade" as "a trade that made exactly nothing", inflating the trade count and diluting
// average P&L. Every nullable numeric here must go through this.
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(n(v)) ? null : n(v));

export const SETTLE_DEFAULTS = {
  maxBars: 96,          // how far past arrival to follow the ticket before calling it open
};

/**
 * Replay a forecast's ticket over the candles from arrival onward.
 *
 * Entry is assumed filled at the forecast's entry price on arrival — these are conditional
 * tickets, so this measures "was the plan any good", not "did a real fill happen". Anything
 * still open at the end of the window is OPEN, never silently a win or a loss.
 */
export function settleForecastTicket({ plan, candles, pip, maxBars = SETTLE_DEFAULTS.maxBars }) {
  const entry = finPos(plan?.entry);
  const sl = finPos(plan?.stopLoss);
  const pv = finPos(pip);
  if (entry === null || sl === null || pv === null || !Array.isArray(candles) || !candles.length) return null;

  const isBuy = String(plan.direction).toUpperCase() === 'BUY';
  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) return null;
  const tps = [plan.takeProfit, plan.takeProfit2, plan.takeProfit3]
    .map((t) => finPos(t))
    .map((t) => (t === null ? null : (isBuy ? (t > entry ? t : null) : (t < entry ? t : null))));

  let outcome = 'OPEN';
  let exitPrice = null;
  let resolvedAt = null;
  let tpLevel = 0;
  let mfe = 0, mae = 0;

  const slice = candles.slice(0, maxBars);
  for (const c of slice) {
    const hi = n(c.high), lo = n(c.low);
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) continue;
    mfe = Math.max(mfe, isBuy ? hi - entry : entry - lo);
    mae = Math.max(mae, isBuy ? entry - lo : hi - entry);

    const hitSl = isBuy ? lo <= sl : hi >= sl;
    let hitLevel = 0;
    tps.forEach((t, i) => {
      if (t === null) return;
      const hit = isBuy ? hi >= t : lo <= t;
      if (hit) hitLevel = Math.max(hitLevel, i + 1);
    });

    if (hitSl && hitLevel === 0) {
      outcome = 'LOSS'; exitPrice = sl; resolvedAt = c.time || null;
      break;
    }
    if (hitSl && hitLevel > 0) {
      // Both on one bar: the path is unknowable from OHLC alone. A target banked on an EARLIER
      // bar still stands; only an unbanked collision is ambiguous.
      if (tpLevel === 0) { outcome = 'AMBIGUOUS'; resolvedAt = c.time || null; }
      break;
    }
    if (hitLevel > tpLevel) {
      tpLevel = hitLevel;
      outcome = `TP${hitLevel}`;
      exitPrice = tps[hitLevel - 1];
      resolvedAt = c.time || null;
      if (hitLevel === 3) break;                 // full ladder banked
    }
  }

  const pips = outcome === 'AMBIGUOUS' || outcome === 'OPEN' || exitPrice === null
    ? null
    : r1(((isBuy ? exitPrice - entry : entry - exitPrice)) / pv);
  const rMultiple = pips === null ? null : r2(((isBuy ? exitPrice - entry : entry - exitPrice)) / risk);

  return {
    outcome, tpLevel,
    exitPrice: exitPrice === null ? null : r2(exitPrice),
    pips, rMultiple,
    resolvedAt,
    mfePips: r1(mfe / pv),
    maePips: r1(mae / pv),
    barsMeasured: slice.length,
    // Money only when a size was attached; the report shows it as hypothetical.
    estimatedProfit: pips === null || !finPos(plan?.lots) || !finPos(plan?.pipValuePerLot)
      ? null
      : r2(pips * n(plan.lots) * n(plan.pipValuePerLot)),
  };
}

/**
 * Link a forecast to a trade actually placed.
 *
 * Deliberately strict, and it reports WHY it matched. A loose join here would attach real money
 * to the wrong prediction and quietly corrupt the only number in this report that is not
 * hypothetical — so an ambiguous case returns null rather than a guess.
 */
export function matchRealTrade({ forecast, trades, pip, tolerancePips = 25, windowMinutes = 240 }) {
  const pv = finPos(pip);
  const entry = finPos(forecast?.plan?.entry);
  const arrivedMs = Date.parse(forecast?.arrivedIso || forecast?.resolvedAt || '');
  if (pv === null || entry === null || !Array.isArray(trades) || !trades.length) return null;

  const dir = String(forecast?.plan?.direction || forecast?.expectedDirection || '').toUpperCase();
  const symbol = String(forecast?.symbol || '').toUpperCase();
  const tol = tolerancePips * pv;

  const candidates = trades
    .filter((t) => String(t.symbol || '').toUpperCase() === symbol)
    .filter((t) => String(t.direction || '').toUpperCase() === dir)
    .map((t) => {
      const openedMs = Date.parse(t.openedAt || t.opened_at || '');
      const fill = finPos(t.fillPrice ?? t.fill_price ?? t.entryPrice ?? t.entry_price);
      if (!Number.isFinite(openedMs) || fill === null) return null;
      const driftMin = Number.isFinite(arrivedMs) ? (openedMs - arrivedMs) / 60000 : null;
      const priceGapPips = Math.abs(fill - entry) / pv;
      return { trade: t, openedMs, fill, driftMin, priceGapPips };
    })
    .filter(Boolean)
    // Opened after the level was reached (a trade placed BEFORE the condition occurred was not
    // taken on this forecast) and inside the window.
    .filter((c) => c.driftMin === null || (c.driftMin >= -5 && c.driftMin <= windowMinutes))
    .filter((c) => Math.abs(c.fill - entry) <= tol)
    .sort((a, b) => a.priceGapPips - b.priceGapPips || Math.abs(a.driftMin ?? 0) - Math.abs(b.driftMin ?? 0));

  if (!candidates.length) return null;
  // More than one plausible trade means the attribution is not safe to assert.
  if (candidates.length > 1) {
    const [a, b] = candidates;
    const separated = b.priceGapPips - a.priceGapPips > tolerancePips * 0.4;
    if (!separated) return { ambiguous: true, candidateCount: candidates.length, reason: 'multiple trades fit this forecast equally well' };
  }

  const best = candidates[0];
  const t = best.trade;
  return {
    ambiguous: false,
    ticket: t.ticket ?? null,
    strategy: t.strategy ?? null,
    lots: finPos(t.lots),
    fillPrice: r2(best.fill),
    profit: num(t.profit) === null ? null : r2(t.profit),
    closedAt: t.closedAt || t.closed_at || null,
    openedAt: t.openedAt || t.opened_at || null,
    entryGapPips: r1(best.priceGapPips),
    minutesAfterArrival: best.driftMin === null ? null : Math.round(best.driftMin),
    reason: `same symbol+direction, filled ${r1(best.priceGapPips)} pips from the forecast entry`
      + (best.driftMin === null ? '' : ` ${Math.round(best.driftMin)} min after arrival`),
  };
}

/** Aggregate settled forecasts into a row per grouping key. */
export function aggregateSettled(rows, keyFn) {
  const m = new Map();
  for (const r of rows || []) {
    const k = keyFn(r);
    if (!k) continue;
    if (!m.has(k)) m.set(k, { key: k, matched: 0, settled: 0, wins: 0, losses: 0, ambiguous: 0, open: 0, pips: 0, realPnl: 0, realTrades: 0 });
    const g = m.get(k);
    g.matched += 1;
    const o = String(r.hitOutcome || '');
    if (o === 'OPEN' || !o) g.open += 1;
    else if (o === 'AMBIGUOUS') g.ambiguous += 1;
    else {
      g.settled += 1;
      if (o === 'LOSS') g.losses += 1; else g.wins += 1;
      const p = num(r.hitPips);
      if (p !== null) g.pips += p;
    }
    const real = num(r.realPnl);
    if (real !== null) { g.realPnl += real; g.realTrades += 1; }
  }
  return [...m.values()]
    .map((g) => ({
      ...g,
      pips: r1(g.pips),
      realPnl: r2(g.realPnl),
      winRate: g.settled > 0 ? Math.round((g.wins / g.settled) * 1000) / 10 : null,
    }))
    .sort((a, b) => b.matched - a.matched || b.pips - a.pips);
}
