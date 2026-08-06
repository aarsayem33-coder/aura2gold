/**
 * Has this kind of setup actually worked before?
 *
 * Powers the badge on a forecast card. The question sounds simple — "does this combo win more
 * than 70% of the time?" — and the honest answer depends entirely on how finely you slice.
 *
 * WHY THE BADGE IS NOT ON strategy x symbol x timeframe x level
 * That is the natural grouping and it cannot be measured here. Across 781 resolved forecasts it
 * produces 405 distinct combos with a MEDIAN SAMPLE OF 1 and a maximum of 13. A "80% match rate"
 * on that grouping means 4 out of 5, and with 405 combos being scanned several will hit 100% on
 * pure chance. A green tick there would be a random number generator wearing a badge.
 *
 * So the badge is computed on the finest grouping that has real samples, a floor is enforced,
 * and the grouping it actually used is reported alongside — a badge that will not say what it
 * measured is worse than no badge.
 *
 * Pure: resolved rows in, rates out. No I/O, no clock, no database.
 */

const n = (v) => Number(v);
// Number(null) is 0 and 0 is finite — the coercion behind seven separate defects here.
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(n(v)) ? null : n(v));
const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);

/**
 * Groupings from finest to coarsest. Each forecast is matched against the FIRST one that clears
 * the sample floor, so a card gets the most specific evidence that actually exists rather than
 * either a noisy fine slice or a uselessly broad one.
 */
export const GROUPINGS = [
  { key: 'strategy|symbol|timeframe|levelType', label: 'strategy · symbol · timeframe · level', of: (r) => [r.strategy, r.symbol, r.timeframe, r.levelType] },
  { key: 'strategy|symbol|timeframe', label: 'strategy · symbol · timeframe', of: (r) => [r.strategy, r.symbol, r.timeframe] },
  { key: 'strategy|timeframe|levelType', label: 'strategy · timeframe · level', of: (r) => [r.strategy, r.timeframe, r.levelType] },
  { key: 'strategy|levelType', label: 'strategy · level type', of: (r) => [r.strategy, r.levelType] },
  { key: 'strategy|timeframe', label: 'strategy · timeframe', of: (r) => [r.strategy, r.timeframe] },
  { key: 'strategy', label: 'strategy overall', of: (r) => [r.strategy] },
];

export const TRACK_DEFAULTS = {
  minSample: 20,        // below this a rate is not evidence, however good it looks
  minWinRate: 0.70,
  minMatchRate: 0.80,
};

/** Build a lookup of rates for every grouping, from resolved forecast rows. */
export function buildTrackRecord(rows, { minSample = TRACK_DEFAULTS.minSample } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const tables = new Map();

  for (const g of GROUPINGS) {
    const buckets = new Map();
    for (const r of list) {
      const parts = g.of(r);
      if (parts.some((p) => p === null || p === undefined || p === '')) continue;
      const key = parts.join('|');
      if (!buckets.has(key)) buckets.set(key, { n: 0, matched: 0, settled: 0, wins: 0 });
      const b = buckets.get(key);
      b.n += 1;
      if (r.matched) b.matched += 1;
      // A forecast that never produced a result is counted in `n` but not in the win rate —
      // dividing wins by all forecasts would understate every strategy that waits for its setup.
      const hr = num(r.hitR);
      if (hr !== null) { b.settled += 1; if (hr > 0) b.wins += 1; }
    }
    const clean = new Map();
    for (const [key, b] of buckets) {
      clean.set(key, {
        n: b.n,
        matched: b.matched,
        settled: b.settled,
        wins: b.wins,
        matchRate: b.n ? r3(b.matched / b.n) : null,
        // Null rather than 0 when nothing settled: a strategy with no resolved trades has no
        // win rate, and a zero would rank it below a genuine loser.
        winRate: b.settled ? r3(b.wins / b.settled) : null,
        enoughSample: b.n >= minSample,
      });
    }
    tables.set(g.key, clean);
  }
  return { tables, minSample, totalResolved: list.length };
}

/**
 * The badge for one forecast.
 *
 * Walks the groupings finest-first and returns the first that clears the sample floor. `qualifies`
 * is only true when a real rate clears a real threshold on a real sample — all three, or the tick
 * does not appear.
 */
export function trackRecordFor(forecast, record, {
  minWinRate = TRACK_DEFAULTS.minWinRate,
  minMatchRate = TRACK_DEFAULTS.minMatchRate,
} = {}) {
  if (!record?.tables) return { qualifies: false, reason: 'no history loaded' };
  const probe = {
    strategy: forecast?.bestStrategy ?? forecast?.strategy ?? null,
    symbol: forecast?.symbol ?? null,
    timeframe: forecast?.timeframe ?? null,
    levelType: forecast?.levelType ?? forecast?.level_type ?? null,
  };

  for (const g of GROUPINGS) {
    const parts = g.of(probe);
    if (parts.some((p) => p === null || p === undefined || p === '')) continue;
    const hit = record.tables.get(g.key)?.get(parts.join('|'));
    if (!hit || !hit.enoughSample) continue;

    const winOk = hit.winRate !== null && hit.winRate >= minWinRate;
    const matchOk = hit.matchRate !== null && hit.matchRate >= minMatchRate;
    return {
      qualifies: winOk || matchOk,
      // Which bar it cleared, so the tick is never ambiguous about what it is claiming.
      basis: winOk && matchOk ? 'both' : winOk ? 'win rate' : matchOk ? 'match rate' : null,
      grouping: g.label,
      groupingKey: g.key,
      n: hit.n,
      settled: hit.settled,
      winRate: hit.winRate,
      matchRate: hit.matchRate,
      thresholds: { minWinRate, minMatchRate, minSample: record.minSample },
      reason: winOk || matchOk
        ? `${g.label}: ${hit.winRate !== null ? `${Math.round(hit.winRate * 100)}% win` : 'no settled trades'} · ${Math.round((hit.matchRate ?? 0) * 100)}% match over ${hit.n}`
        : `${g.label}: ${hit.winRate !== null ? `${Math.round(hit.winRate * 100)}% win` : 'no win rate'} · ${Math.round((hit.matchRate ?? 0) * 100)}% match over ${hit.n} — below the bar`,
    };
  }

  return {
    qualifies: false,
    grouping: null,
    // Said plainly: no grouping had enough history, which is different from "it performed badly".
    reason: `no grouping reached ${record.minSample} resolved forecasts — not enough history to judge this combo`,
  };
}
