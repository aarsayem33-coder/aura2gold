// Instrument capabilities — the single source of truth for what each NON-FOREX
// instrument is allowed to do. Forex majors need no entry here (null caps = all
// systems enabled, forex defaults apply). Add an index/CFD = one entry.
//
// Design rule: DATA ≠ SIGNALS. The EA streams every timeframe for every symbol
// (D1 feeds PDH/PDL key levels and the stage filter; M1 feeds nothing harmful) —
// these caps gate SIGNAL GENERATION AND DELIVERY, never candle ingestion.
export const SYMBOL_CAPS = {
  USTEC: {
    assetClass: 'INDEX',
    label: 'Nasdaq 100',
    // Index CFDs are USD-macro instruments: CPI/NFP/FOMC/PCE/GDP move them like a
    // USD pair — used by the news engine since USTEC can't be parsed as a pair.
    newsCurrency: 'USD',
    // Signals only on intraday swing TFs: M1 index CFD ticks are spread-noise, and
    // D1 "next-candle" style calls make no sense on a 23/5 session instrument.
    signalTimeframes: ['M5', 'M15', 'M30', 'H1', 'H4'],
    fixedTime: false,      // no fixed-time/next-candle bets until validated
    forecasts: false,      // execution forecasts assume 24/5 FX session behavior
    // Exness USTECm contract characteristics (verify in MT5 specs if broker differs):
    // digits 2, 1 "pip" = 1.0 index point, ~$1 per point per 1.0 lot, contract size 1.
    digits: 2,
    pipSize: 1.0,
    pipValuePerLot: 1,
    contractSize: 1,
    pipUnit: 'points',
    roundStep: { step: 50, major: 100 },
  },
  // Exness ALSO lists a x100 contract (USTEC_x100m) alongside the standard USTECm.
  // Same index, 100x the contract size: ~$100 per point per lot, not $1. This MUST be
  // its own entry — a 2026-07-26 auto-trade sized 0.44 lots for a $10 risk budget on
  // the x100 symbol and lost $944 when the stop hit (0.44 x 21.49 pts x $100 = $945.56,
  // i.e. ~100x the intended risk) because the generic USTEC prefix matched first.
  // The $100/point figure is measured from that fill, not assumed.
  USTEC_X100: {
    assetClass: 'INDEX',
    label: 'Nasdaq 100 (x100 contract)',
    newsCurrency: 'USD',
    signalTimeframes: ['M5', 'M15', 'M30', 'H1', 'H4'],
    fixedTime: false,
    forecasts: false,
    digits: 2,
    pipSize: 1.0,
    pipValuePerLot: 100,
    contractSize: 100,
    pipUnit: 'points',
    roundStep: { step: 50, major: 100 },
  },
};

// Longest matching prefix wins, so a more specific contract variant (USTEC_X100) is
// never shadowed by its generic base (USTEC). Order in SYMBOL_CAPS is then irrelevant.
export function symbolCapsFor(symbol) {
  const s = String(symbol || '').toUpperCase();
  let best = null, bestLen = -1;
  for (const [base, caps] of Object.entries(SYMBOL_CAPS)) {
    if (s.startsWith(base) && base.length > bestLen) { best = caps; bestLen = base.length; }
  }
  return best;
}

// Signal-generation gates. No caps entry (forex) = everything allowed.
export function symbolAllowsSignalTf(symbol, tf) {
  const caps = symbolCapsFor(symbol);
  if (!caps || !Array.isArray(caps.signalTimeframes)) return true;
  return caps.signalTimeframes.includes(String(tf || '').toUpperCase());
}
export function symbolAllowsFixedTime(symbol) {
  const caps = symbolCapsFor(symbol);
  return !caps || caps.fixedTime !== false;
}
export function symbolAllowsForecast(symbol) {
  const caps = symbolCapsFor(symbol);
  return !caps || caps.forecasts !== false;
}

// News linkage for instruments that aren't currency pairs (USTEC → USD events).
export function indexNewsCurrencyFor(symbol) {
  const caps = symbolCapsFor(symbol);
  return caps?.newsCurrency || null;
}
