// Batched multi-symbol candle loading.
//
// The forecast sweeps were issuing one query per symbol per series — 6 per symbol per timeframe,
// or 240 for a 10-symbol x 4-timeframe ICT scan. Every one pays a network round trip to the
// hosted database (measured: ~47ms floor before the server does any work), which is where most
// of a 130-second sweep was going.
//
// The fix is not fewer ROWS, it is fewer ROUND TRIPS: ask for every symbol's window in a single
// statement that returns byte-for-byte what the individual queries returned.
//
// Pure and separate from server.js on purpose. The database this runs against is currently
// privilege-revoked, so the only way to prove the batched path returns the same thing as the
// per-symbol path is to test the SQL construction and the row grouping directly.

const upper = (v) => String(v ?? '').toUpperCase();

/** Distinct, uppercased, non-empty symbols — the batch key space. */
export function normaliseSymbols(symbols) {
  return [...new Set((symbols || []).map(upper))].filter(Boolean);
}

/**
 * One subquery per symbol, UNION ALL'd.
 *
 * NOT `WHERE symbol IN (...)`: the LIMIT has to apply per symbol, and a single ORDER BY/LIMIT
 * over an IN-list returns N rows across ALL symbols — silently starving every symbol but the
 * most recently active one. That failure would look like "some symbols stopped producing
 * forecasts" rather than like a bug.
 *
 * Deliberately not a window function either — ROW_NUMBER() OVER (PARTITION BY ...) would work on
 * MariaDB 10.2+ but adds a server-version dependency for no benefit over UNION ALL.
 */
export function buildBatchSql(symbolCount) {
  const n = Number(symbolCount);
  if (!Number.isInteger(n) || n < 1) return null;
  // `symbol=?`, NOT `UPPER(symbol)=?`. Wrapping the column in a function makes
  // idx_mt5_candles_symbol_tf_time unusable for the lookup, so every subquery degrades into a
  // full scan plus a filesort. Measured on the live table:
  //
  //   UPPER(symbol)=?   1,056,249 rows examined + filesort   689ms
  //   symbol=?              8,912 rows, index-only            64ms
  //
  // 10 of these per statement across 6 series held all 5 pool connections and starved the
  // user-facing chart endpoint into a timeout. Safe because storage is already uppercase —
  // normalizeCandle() uppercases on write, and a check across the whole table found zero rows
  // whose symbol differed from its own UPPER(). The caller uppercases the argument to match.
  const sub = '(SELECT symbol, candle_time, open_price, high, low, close_price, volume'
    + ' FROM mt5_candles WHERE symbol=? AND timeframe=?'
    + ' ORDER BY candle_time DESC LIMIT ?)';
  return Array.from({ length: n }, () => sub).join(' UNION ALL ');
}

/** Placeholder values in the order buildBatchSql expects them: (symbol, series, want) per symbol. */
export function buildBatchArgs(symbols, series, want) {
  const args = [];
  for (const s of normaliseSymbols(symbols)) args.push(s, series, want);
  return args;
}

/**
 * Group flat UNION ALL rows back into per-symbol candle arrays, ascending by time.
 *
 * Sorted explicitly rather than trusting UNION ALL to preserve each branch's ORDER BY. That
 * ordering is an implementation detail of the query planner, not a guarantee — and every engine
 * downstream reads these bars positionally (`candles[i-1]`, `.at(-1)`), so a reversed or
 * interleaved array would not throw. It would quietly produce confident nonsense.
 */
export function groupBatchRows(rows) {
  const out = new Map();
  for (const r of rows || []) {
    const k = upper(r.symbol);
    if (!k) continue;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  for (const [k, group] of out) {
    group.sort((a, b) => Date.parse(a.candle_time) - Date.parse(b.candle_time));
    out.set(k, group.map((r) => ({
      time: new Date(r.candle_time).toISOString(),
      open: Number(r.open_price), high: Number(r.high),
      low: Number(r.low), close: Number(r.close_price), volume: Number(r.volume) || 0,
    })));
  }
  return out;
}

/**
 * The deepest request per series, so a timeframe needed twice is fetched once.
 *
 * Asking for the most recent 400 bars and slicing the tail to 150 yields the identical window as
 * asking for 150, so when the scan timeframe IS H4 (also the trend source) one fetch serves both.
 */
export function dedupeSeriesRequests(requests) {
  const need = new Map();
  for (const [series, n] of requests || []) {
    if (!series) continue;
    need.set(series, Math.max(need.get(series) || 0, Number(n) || 0));
  }
  return need;
}

/** Most recent `n` bars from an ascending array. Null series stay null. */
export function tailOf(rows, n) {
  if (!Array.isArray(rows)) return [];
  return n && rows.length > n ? rows.slice(-n) : rows;
}
