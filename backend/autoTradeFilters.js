// Which strategy × symbol × timeframe may auto-trade.
//
// Two selection models, chosen by cfg.selectionMode:
//   COMBOS — cfg.combos holds exact 'strategyId|SYMBOL|TF' triples ('*' = any in that
//            position), so you can allow "forex-confluence on GBPUSDm M15" without
//            allowing that strategy anywhere else.
//   BROAD  — the cross-product of cfg.strategies × cfg.symbols × cfg.timeframes.
//            Strategies are explicit opt-in (empty = nothing trades); an empty symbol or
//            timeframe list means "any".
//
// selectionMode is explicit so switching back to BROAD does not require deleting a
// carefully built combination list. When it is absent (older saved settings) the mode is
// inferred from whether any combinations exist, which is the previous behaviour.
//
// Pure and side-effect free so it can be unit-tested away from the server.
export function autoTradeSelectionMode(cfg) {
  const raw = String(cfg?.selectionMode || '').toUpperCase();
  if (raw === 'COMBOS' || raw === 'BROAD') return raw;
  return (Array.isArray(cfg?.combos) && cfg.combos.length) ? 'COMBOS' : 'BROAD';
}

export function autoTradeCombosAllow(cfg, strategy, symbol, tf) {
  const sym = String(symbol).toUpperCase();
  const t = String(tf).toUpperCase();
  const combos = Array.isArray(cfg?.combos) ? cfg.combos : [];

  if (autoTradeSelectionMode(cfg) === 'COMBOS') {
    // Explicit opt-in: an empty list in COMBOS mode trades nothing, rather than silently
    // falling through to the broad lists and trading more than the user selected.
    if (!combos.length) return false;
    return combos.some((c) => {
      const [cs, cSym, cTf] = String(c).split('|');
      return cs === strategy
        && (cSym === '*' || cSym === sym)
        && (cTf === '*' || cTf === t);
    });
  }

  const strategies = Array.isArray(cfg?.strategies) ? cfg.strategies : [];
  if (!strategies.length || !strategies.includes(strategy)) return false;
  const symbols = Array.isArray(cfg?.symbols) ? cfg.symbols : [];
  if (symbols.length && !symbols.includes(sym)) return false;
  const timeframes = Array.isArray(cfg?.timeframes) ? cfg.timeframes : [];
  if (timeframes.length && !timeframes.includes(t)) return false;
  return true;
}

// Normalize one user-supplied combo into 'strategyId|SYMBOL|TF', or null when invalid.
export function normalizeAutoTradeCombo(raw, { validStrategyIds, knownTimeframes }) {
  const parts = String(raw ?? '').split('|').map((p) => p.trim());
  if (parts.length !== 3) return null;
  const sid = parts[0];
  const sym = parts[1].toUpperCase();
  const tf = parts[2].toUpperCase();
  if (!sid || (validStrategyIds && !validStrategyIds.has(sid))) return null;
  if (sym !== '*' && !/^[A-Z0-9._#-]{2,20}$/.test(sym)) return null;
  if (tf !== '*' && knownTimeframes && !knownTimeframes.includes(tf)) return null;
  return `${sid}|${sym}|${tf}`;
}
