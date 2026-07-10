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
};

export function symbolCapsFor(symbol) {
  const s = String(symbol || '').toUpperCase();
  for (const [base, caps] of Object.entries(SYMBOL_CAPS)) {
    if (s.startsWith(base)) return caps;
  }
  return null;
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
