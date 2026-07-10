// Curated shortlist of the most liquid, tight-spread instruments. Gold first, then
// the major USD pairs and the most-traded crosses. These give the highest-quality
// signals; everything else (exotic crosses) is available but de-prioritised.
//
// Matching is suffix-agnostic so it works across brokers: "EURUSD" matches the
// Exness "EURUSDM" symbol as well as a plain "EURUSD".
export const CURATED_BASES: string[] = [
  'XAUUSD', // Gold
  'USTEC',  // Nasdaq 100 (broker: USTECm) — forex-style signals on M5–H4 only
  'EURUSD',
  'GBPUSD',
  'USDJPY',
  'AUDUSD',
  'USDCAD',
  'USDCHF',
  'NZDUSD',
  'EURJPY',
  'GBPJPY',
];

/** Return the curated rank of a symbol (0-based), or -1 if it is not a curated major. */
export function curatedRank(symbol: string): number {
  const upper = String(symbol || '').toUpperCase();
  for (let i = 0; i < CURATED_BASES.length; i++) {
    // Match base at the start so EURUSD, EURUSDM, EURUSD.r all rank together.
    if (upper.startsWith(CURATED_BASES[i])) return i;
  }
  return -1;
}

export function isCuratedSymbol(symbol: string): boolean {
  return curatedRank(symbol) >= 0;
}

/**
 * Order a list of symbols so the curated liquid majors + gold appear first (in the
 * curated order), followed by every other symbol sorted alphabetically. De-duplicates
 * and drops empties. Pure function — does not mutate the input.
 */
export function orderSymbols(symbols: Array<string | null | undefined>): string[] {
  const unique = [...new Set(symbols.filter(Boolean).map((s) => String(s)))];
  return unique.sort((a, b) => {
    const ra = curatedRank(a);
    const rb = curatedRank(b);
    if (ra >= 0 && rb >= 0) return ra - rb;          // both curated → curated order
    if (ra >= 0) return -1;                           // a curated, b not → a first
    if (rb >= 0) return 1;                            // b curated, a not → b first
    return a.localeCompare(b);                        // neither → alphabetical
  });
}

/**
 * The curated symbols that actually exist in the available list, in curated order.
 * Useful for scanning a focused, high-liquidity set instead of all 126 instruments.
 */
export function curatedAvailable(available: Array<string | null | undefined>): string[] {
  const present = new Set(available.filter(Boolean).map((s) => String(s).toUpperCase()));
  const result: string[] = [];
  for (const sym of available) {
    if (!sym) continue;
    if (isCuratedSymbol(sym) && present.has(String(sym).toUpperCase())) {
      if (!result.includes(sym)) result.push(sym);
    }
  }
  return orderSymbols(result);
}
