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

/**
 * The effective mode for ONE strategy.
 *
 * The global mode is the fallback; `strategyModes` lets a proven strategy skip the approval
 * queue while everything else still waits — or the reverse, forcing review on one strategy
 * while the desk is otherwise on AUTO.
 *
 * OFF and SHADOW are MASTER switches that a per-strategy entry can never override. "Stop
 * trading" and "log only" have to mean exactly that, or the global control becomes a
 * suggestion — and the one moment you reach for it is the moment you need it absolute.
 */
/** Normalised instrument name — broker suffixes must not defeat a filter (XAUUSDm = XAUUSD). */
function normSym(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
/**
 * Does a configured list match this value? An EMPTY list means "any" — the scope simply is
 * not narrowed on that axis. Symbols compare by prefix in either direction so USTEC matches
 * USTEC_X100M and XAUUSDm matches XAUUSD, which is how the broker actually names them.
 */
function listMatches(list, value, { symbol = false } = {}) {
  if (!Array.isArray(list) || !list.length) return true;
  if (value === null || value === undefined || value === '') return false;
  if (!symbol) {
    const v = String(value).toUpperCase();
    return list.some((x) => String(x || '').toUpperCase() === v);
  }
  const v = normSym(value);
  if (!v) return false;
  return list.some((x) => {
    const n = normSym(x);
    return n !== '' && (n === v || v.startsWith(n) || n.startsWith(v));
  });
}

/**
 * The effective mode for ONE candidate trade.
 *
 * `strategyModes[strategyId]` may be either:
 *   'AUTO' | 'ASK'                                        — applies to every trade (legacy)
 *   { mode, symbols[], timeframes[], sessions[] }          — applies only inside that scope
 *
 * A scoped override that does NOT match the candidate falls back to the desk mode rather
 * than to the other live mode. That is the safe direction: narrowing "ict-breaker is AUTO on
 * XAUUSD M5" must leave EURUSD on the desk's ASK, never silently promote it to AUTO.
 *
 * OFF and SHADOW are desk-wide interlocks and are never overridable — a per-strategy AUTO
 * must not be able to dispatch orders while the desk is off or the EA bridge is down.
 */
export function resolveStrategyMode(globalMode, strategyModes, strategyId, ctx = {}) {
  const g = String(globalMode || 'OFF').toUpperCase();
  if (g === 'OFF' || g === 'SHADOW') return g;
  const raw = strategyModes && typeof strategyModes === 'object' ? strategyModes[strategyId] : null;
  if (!raw) return g;

  // Legacy string form: unscoped, applies everywhere.
  if (typeof raw === 'string') {
    const per = raw.toUpperCase();
    return per === 'AUTO' || per === 'ASK' ? per : g;
  }
  if (typeof raw !== 'object') return g;

  const per = String(raw.mode || '').toUpperCase();
  // Only the two live modes are overridable; anything unrecognised falls back rather than
  // guessing, so a typo in the config cannot silently start auto-trading a strategy.
  if (per !== 'AUTO' && per !== 'ASK') return g;

  const scoped = listMatches(raw.symbols, ctx.symbol, { symbol: true })
    && listMatches(raw.timeframes, ctx.timeframe)
    && listMatches(raw.sessions, ctx.session);
  return scoped ? per : g;
}

/**
 * Coerce one saved entry into the object form, dropping anything unrecognised.
 *
 * Kept beside the resolver so the sanitiser and the resolver cannot drift on what a valid
 * entry is — a rule the sanitiser accepts but the resolver ignores would show as enabled in
 * the UI while doing nothing to real orders.
 */
export function normalizeStrategyMode(raw, { knownTimeframes = [], knownSessions = [] } = {}) {
  const clean = (list, allowed) => {
    if (!Array.isArray(list)) return [];
    const up = [...new Set(list.map((x) => String(x || '').trim().toUpperCase()).filter(Boolean))];
    return allowed && allowed.length ? up.filter((x) => allowed.includes(x)) : up;
  };
  if (typeof raw === 'string') {
    const m = raw.toUpperCase();
    return m === 'AUTO' || m === 'ASK' ? { mode: m, symbols: [], timeframes: [], sessions: [] } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const mode = String(raw.mode || '').toUpperCase();
  if (mode !== 'AUTO' && mode !== 'ASK') return null;
  return {
    mode,
    symbols: clean(raw.symbols).slice(0, 40),
    timeframes: clean(raw.timeframes, knownTimeframes).slice(0, 12),
    sessions: clean(raw.sessions, knownSessions).slice(0, 8),
  };
}
