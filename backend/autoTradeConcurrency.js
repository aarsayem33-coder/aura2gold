// Concurrency limits for the auto-trader — the guard that decides whether ANOTHER real order
// may be sent to MT5.
//
// Extracted from server.js and made pure so it can be tested without a live EA. Two defects it
// exists to fix, both of which put real positions on the account beyond the configured limits:
//
//   1. The old guard counted only what the EA had already reported. Commands dispatched but not
//      yet filled were invisible, so a poll that dispatched N commands checked every one of them
//      against the SAME pre-dispatch snapshot. With maxConcurrent 2 and 1 position open, three
//      queued rows each saw "1 < 2" and all three were sent. Same hole in the approve endpoint:
//      approving three proposals before the EA's next poll queued all three.
//
//   2. Symbols were compared with ===. The server holds "XAUUSD" while the EA reports the
//      broker's own name — "XAUUSDm" on Exness — so onePerSymbol silently stopped matching and
//      let a second position open on an instrument that already had one.

/**
 * Strip a symbol to its comparable core: uppercase, alphanumerics only.
 * "XAUUSDm" -> "XAUUSDM", "EURUSD.pro" -> "EURUSDPRO", "USTEC_X100" -> "USTECX100".
 */
export function symbolKey(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Do two symbol names refer to the same instrument, allowing for broker suffixes?
 *
 * Prefix containment: "XAUUSDM" starts with "XAUUSD", so an Exness position matches an
 * unsuffixed command. Requires >= 3 characters so stray short strings cannot match everything.
 *
 * Ambiguity deliberately resolves toward TRUE. This function only ever gates opening another
 * position, so a false match declines a trade while a false miss opens one the user forbade —
 * and on a funded account those two errors are not remotely equal in cost.
 */
export function sameInstrument(a, b) {
  const x = symbolKey(a);
  const y = symbolKey(b);
  if (x.length < 3 || y.length < 3) return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
}

/**
 * Decide whether one more order may be opened.
 *
 * @param cfg       { maxConcurrent, onePerSymbol }
 * @param symbol    the instrument the new order is for
 * @param open      what the broker currently holds — positions + pending orders, magic-filtered
 * @param inFlight  commands already committed but NOT yet visible in `open`: dispatched this
 *                  poll, SENT awaiting a result, PLACED awaiting a fill, or QUEUED and certain
 *                  to dispatch. Omitting these is defect (1).
 * @returns null when the order may proceed, otherwise the human-readable reason it may not.
 */
export function concurrencyVerdict({ cfg, symbol, open = [], inFlight = [] }) {
  // An unreadable cap blocks rather than meaning "unlimited". Number(null) is 0 and 0 is
  // finite, so a bare coercion would land on "block" here by accident; it is spelled out
  // because the opposite reading — a missing cap permitting unlimited positions — is the one
  // mistake this guard exists to prevent.
  const raw = cfg?.maxConcurrent;
  const max = raw === null || raw === undefined || raw === '' || !Number.isFinite(Number(raw))
    ? 0
    : Number(raw);
  const all = [...(open || []), ...(inFlight || [])];
  if (all.length >= max) {
    const pend = (inFlight || []).length;
    return `max concurrent (${max}) reached — ${all.length} open`
      + (pend ? ` (${(open || []).length} at broker + ${pend} in flight)` : '');
  }
  if (cfg?.onePerSymbol) {
    const clash = all.find((p) => sameInstrument(p?.symbol, symbol));
    if (clash) {
      const where = (inFlight || []).includes(clash) ? 'already queued/sent for' : 'already a position/order on';
      return `${where} ${clash?.symbol || symbol} (one-per-symbol)`;
    }
  }
  return null;
}

/**
 * Which stored command rows are committed but not yet represented in the broker's report.
 *
 * A row whose ticket or position id already appears in `open` is dropped: the broker is
 * reporting it, so counting the row as well would double-count and under-trade.
 */
export function pendingCommands(rows, open = [], { excludeId = null } = {}) {
  const known = new Set();
  for (const p of open || []) {
    for (const k of [p?.id, p?.ticket, p?.positionId]) {
      if (k !== null && k !== undefined && k !== '') known.add(String(k));
    }
  }
  const seen = (v) => v !== null && v !== undefined && v !== '' && known.has(String(v));
  return (rows || [])
    .filter((r) => r && r.id !== excludeId)
    .filter((r) => !seen(r.ticket) && !seen(r.position_id) && !seen(r.positionId))
    .map((r) => ({ symbol: r.symbol, id: r.id, status: r.status }));
}
