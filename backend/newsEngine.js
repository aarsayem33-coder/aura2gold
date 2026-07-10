/**
 * newsEngine.js — News-reaction signal builder.
 *
 * Acts like a 30-year desk trader preparing for a scheduled release:
 *   1. Find upcoming events (high / medium / low impact).
 *   2. Map each event's currency to the affected symbols, PRIORITISING open positions.
 *   3. Read the current chart structure (via aggregateSignals) for each affected symbol.
 *   4. Build "what-if" reaction scenarios (bullish vs bearish surprise) and a pro recommendation.
 *
 * This is deterministic rule-based analysis (no AI dependency) so it works even when Gemini
 * is unavailable. Directional bias for a release is CONDITIONAL on the actual vs forecast,
 * never a blind pre-news directional bet.
 */

import { aggregateSignals } from './signalEngine.js';
import { getEconomicEvents, symbolCurrencies } from './economicCalendar.js';
import { indexNewsCurrencyFor } from './instruments.js';

const CODES = ['XAU', 'XAG', 'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF', 'CNH', 'CNY', 'SGD', 'HKD', 'SEK', 'NOK', 'MXN', 'ZAR', 'TRY'];

/** Parse a broker symbol (e.g. XAUUSDm, EURUSDm) into { base, quote }. */
export function parsePair(symbol) {
  const s = String(symbol || '').toUpperCase().replace(/[^A-Z]/g, '');
  const base = CODES.find((c) => s.startsWith(c));
  if (!base) return null;
  const rest = s.slice(base.length);
  const quote = CODES.find((c) => rest.startsWith(c));
  if (!quote) return null;
  return { base, quote };
}

/** Tracked symbols whose base or quote currency matches the event currency. */
export function affectedSymbols(currency, trackedSymbols = []) {
  const cur = String(currency || '').toUpperCase();
  const out = [];
  for (const sym of trackedSymbols) {
    const p = parsePair(sym);
    if (!p) {
      // Not a currency pair — index CFDs (USTEC etc.) are macro-sensitive (CPI/NFP/
      // FOMC move the Nasdaq like a USD pair) but can't be parsed as base/quote.
      if (indexNewsCurrencyFor(sym) === cur) out.push(sym);
      continue;
    }
    if (p.base === cur || p.quote === cur) out.push(sym);
  }
  return out;
}

/**
 * Resulting pair direction for a currency surprise.
 * surprise: 'bullish' (currency strengthens) | 'bearish' (currency weakens).
 * Returns 'UP' | 'DOWN' | 'NEUTRAL' for the pair.
 */
export function surpriseToPairDirection(symbol, currency, surprise) {
  const p = parsePair(symbol);
  if (!p) return 'NEUTRAL';
  if (surprise === 'neutral' || !surprise) return 'NEUTRAL';
  const strong = surprise === 'bullish';
  if (p.base === currency) return strong ? 'UP' : 'DOWN';
  if (p.quote === currency) return strong ? 'DOWN' : 'UP';
  return 'NEUTRAL';
}

const IMPACT_RANK = { HIGH: 3, MODERATE: 2, LOW: 1, NONE: 0, HOLIDAY: 0 };
export function impactRank(impact) {
  return IMPACT_RANK[String(impact || 'NONE').toUpperCase()] ?? 0;
}


function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function recentHighLow(candles, lookback = 20) {
  const slice = (candles || []).slice(-lookback);
  let high = -Infinity;
  let low = Infinity;
  for (const c of slice) {
    const h = num(c.high);
    const l = num(c.low);
    if (h !== null && h > high) high = h;
    if (l !== null && l < low) low = l;
  }
  return {
    high: high === -Infinity ? null : high,
    low: low === Infinity ? null : low,
  };
}

/**
 * Build a news-reaction signal for one (event, symbol) pair.
 * deps.getCandles(symbol, timeframe, limit) -> candle array.
 */
export function buildSymbolNewsSignal({ event, symbol, position = null, deps, now = Date.now() }) {
  const entryCandles = deps.getCandles(symbol, 'M15', 200) || [];
  const h1 = deps.getCandles(symbol, 'H1', 150) || [];
  const h4 = deps.getCandles(symbol, 'H4', 150) || [];

  let agg = null;
  try {
    agg = aggregateSignals({ symbol, timeframe: 'M15', candles: entryCandles, indicators: [], h1Candles: h1, h4Candles: h4 });
  } catch {
    agg = null;
  }

  const price = num(agg?.marketContext?.price ?? entryCandles[entryCandles.length - 1]?.close);
  const htfBias = agg?.systemDecision?.htfBias || agg?.marketContext?.h4Trend || 'NEUTRAL';
  const composite = num(agg?.compositeScore) ?? 0;
  const levels = recentHighLow(entryCandles, 20);
  const digits = /XAU|GOLD|XAG/.test(symbol.toUpperCase()) ? 2 : (/JPY/.test(symbol.toUpperCase()) ? 3 : 5);
  const fmt = (v) => (v === null || v === undefined ? 'n/a' : Number(v).toFixed(digits));

  const bullDir = surpriseToPairDirection(symbol, event.currency, 'bullish'); // currency-strong scenario
  const bearDir = surpriseToPairDirection(symbol, event.currency, 'bearish'); // currency-weak scenario

  // Which scenario aligns with the existing higher-timeframe trend = the continuation play.
  const trendDir = htfBias === 'BULLISH' ? 'UP' : htfBias === 'BEARISH' ? 'DOWN' : 'NEUTRAL';
  const continuationOn = trendDir !== 'NEUTRAL' && (bullDir === trendDir ? 'bullish' : bearDir === trendDir ? 'bearish' : null);

  const scenarios = [
    {
      trigger: `${event.currency} comes in HOT (actual > forecast)`,
      currencyEffect: `${event.currency} strengthens`,
      pairDirection: bullDir,
      watchLevel: bullDir === 'UP' ? levels.high : levels.low,
      note: bullDir === trendDir
        ? `Aligns with the ${htfBias.toLowerCase()} ${symbol} trend → continuation breakout favoured.`
        : `Counter to the current ${htfBias.toLowerCase()} bias → expect a sharp reversal/whipsaw; wait for confirmation.`,
    },
    {
      trigger: `${event.currency} comes in SOFT (actual < forecast)`,
      currencyEffect: `${event.currency} weakens`,
      pairDirection: bearDir,
      watchLevel: bearDir === 'UP' ? levels.high : levels.low,
      note: bearDir === trendDir
        ? `Aligns with the ${htfBias.toLowerCase()} ${symbol} trend → continuation breakout favoured.`
        : `Counter to the current ${htfBias.toLowerCase()} bias → expect a sharp reversal/whipsaw; wait for confirmation.`,
    },
  ];

  // Professional recommendation (desk-trader voice).
  const minutesUntil = Math.round((event.timestampUtc - now) / 60000);
  const recParts = [];
  if (position) {
    const side = String(position.type || '').toUpperCase().includes('SELL') ? 'SHORT' : 'LONG';
    const riskScenario = side === 'LONG' ? scenarios.find((s) => s.pairDirection === 'DOWN') : scenarios.find((s) => s.pairDirection === 'UP');
    recParts.push(`⚠ You are ${side} ${position.volume ?? ''} ${symbol} (open P/L ${position.profit ?? 'n/a'}).`);
    if (riskScenario) recParts.push(`Adverse case: ${riskScenario.trigger} → ${symbol} ${riskScenario.pairDirection}. Tighten stop or hedge before ${minutesUntil}m.`);
  }
  recParts.push(`Do NOT open fresh positions in the ±30m window. Trade the post-release breakout: go with whichever side closes a 5–15m candle beyond ${fmt(levels.high)} (long) or ${fmt(levels.low)} (short), with an ATR-based stop.`);
  if (continuationOn) recParts.push(`Bias: a ${continuationOn} surprise would extend the existing ${htfBias.toLowerCase()} trend — that's the higher-probability continuation.`);

  const priority = impactRank(event.impact) * 10 + (position ? 5 : 0) + (Math.abs(composite) >= 0.3 ? 1 : 0);

  return {
    id: `${event.id}|${symbol}`,
    symbol,
    event: {
      id: event.id,
      title: event.title,
      currency: event.currency,
      impact: event.impact,
      timeIso: event.timeIso,
      minutesUntil,
      forecast: event.forecast,
      previous: event.previous,
      actual: event.actual,
    },
    hasPosition: Boolean(position),
    positionSide: position ? (String(position.type || '').toUpperCase().includes('SELL') ? 'SELL' : 'BUY') : null,
    price,
    htfBias,
    compositeScore: composite,
    grade: agg?.systemDecision?.grade || null,
    keyLevels: { recentHigh: levels.high, recentLow: levels.low },
    scenarios,
    recommendation: recParts.join(' '),
    priority,
  };
}


/**
 * Build the full list of news-reaction signals.
 * @param {object} opts
 *   - now: epoch ms
 *   - horizonHours: how far ahead to scan (default 24)
 *   - minImpact: 'LOW' | 'MODERATE' | 'HIGH' (default 'LOW' = include all)
 *   - trackedSymbols: string[]
 *   - openTrades: [{symbol,type,volume,profit}]
 *   - getCandles(symbol, timeframe, limit)
 *   - maxSymbolsPerEvent: cap non-position symbols per event (default 6)
 */
export function buildNewsSignals(opts = {}) {
  const {
    now = Date.now(),
    horizonHours = 24,
    minImpact = 'LOW',
    trackedSymbols = [],
    openTrades = [],
    getCandles = () => [],
    maxSymbolsPerEvent = 6,
  } = opts;

  const events = getEconomicEvents({
    from: now - 30 * 60 * 1000,
    to: now + horizonHours * 60 * 60 * 1000,
    minImpact,
  });

  // Index open positions by symbol (uppercased) for quick lookup + prioritisation.
  const positionBySymbol = new Map();
  for (const t of openTrades) {
    if (t && t.symbol) positionBySymbol.set(String(t.symbol).toUpperCase(), t);
  }
  const positionSymbols = new Set(positionBySymbol.keys());

  const signals = [];
  const seen = new Set();

  for (const event of events) {
    if (!event.currency) continue;
    let symbols = affectedSymbols(event.currency, trackedSymbols);
    if (!symbols.length) continue;

    // Prioritise symbols with open positions; cap the rest to keep the scan light.
    const withPos = symbols.filter((s) => positionSymbols.has(String(s).toUpperCase()));
    const withoutPos = symbols.filter((s) => !positionSymbols.has(String(s).toUpperCase())).slice(0, maxSymbolsPerEvent);
    symbols = [...withPos, ...withoutPos];

    for (const symbol of symbols) {
      const key = `${event.id}|${String(symbol).toUpperCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const position = positionBySymbol.get(String(symbol).toUpperCase()) || null;
      try {
        signals.push(buildSymbolNewsSignal({ event, symbol, position, deps: { getCandles }, now }));
      } catch {
        /* skip a symbol that fails to analyse rather than failing the whole scan */
      }
    }
  }

  // Highest priority first (impact desc, open positions first, imminence next).
  signals.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return (a.event.minutesUntil ?? 1e9) - (b.event.minutesUntil ?? 1e9);
  });

  return signals;
}


/**
 * Compute the "surprise" of a released event: actual vs forecast (fallback previous).
 * Returns { bias: 'bullish'|'bearish'|'neutral', deltaPct, basis }.
 * NOTE: higher actual = currency-positive is the common case (growth/inflation/jobs).
 * Rate-cut/unemployment-style inversions exist; we keep the common-case heuristic and
 * let the realized price reaction (below) confirm direction.
 */
export function computeSurprise(event) {
  const actual = Number(event?.actual);
  if (!Number.isFinite(actual)) return { bias: 'neutral', deltaPct: 0, basis: 'no actual' };
  const ref = Number.isFinite(Number(event?.forecast)) ? Number(event.forecast)
    : Number.isFinite(Number(event?.previous)) ? Number(event.previous) : null;
  if (ref === null) return { bias: 'neutral', deltaPct: 0, basis: 'no forecast/previous' };
  const diff = actual - ref;
  const deltaPct = ref !== 0 ? (diff / Math.abs(ref)) * 100 : (diff !== 0 ? Math.sign(diff) * 100 : 0);
  const eps = Math.abs(ref) * 0.001; // ignore negligible diffs

  if (Math.abs(diff) <= eps) {
    return { bias: 'neutral', deltaPct, basis: Number.isFinite(Number(event?.forecast)) ? 'vs forecast' : 'vs previous' };
  }

  // Check if the event title represents an inverted metric (e.g. higher unemployment is bad/bearish)
  const titleUpper = String(event?.title || '').toUpperCase();
  const isInverted = [
    'UNEMPLOYMENT',
    'JOBLESS CLAIMS',
    'CLAIM'
  ].some(keyword => titleUpper.includes(keyword)) && !titleUpper.includes('EMPLOYMENT CHANGE');

  const isBullishSurprise = diff > 0 ? !isInverted : isInverted;
  const bias = isBullishSurprise ? 'bullish' : 'bearish';

  return {
    bias,
    deltaPct,
    basis: Number.isFinite(Number(event?.forecast)) ? 'vs forecast' : 'vs previous'
  };
}

function closeAtOrAfter(candles, tsMs) {
  // First candle at/after a timestamp -> its close (price around the release).
  for (const c of candles) {
    if (Date.parse(c.time) >= tsMs) { const v = num(c.close); if (v !== null) return v; }
  }
  return null;
}

/**
 * Build a POST-NEWS entry signal for one (released event, symbol).
 * Combines the surprise direction with the REALIZED post-release price reaction, and
 * gates entry to AFTER the +blackoutMins window (strict "wait then enter").
 *
 * @returns signal with status 'WAITING' (pre +30m) or 'ACTIVE' (tradeable now).
 */
export function buildPostNewsSignal({ event, symbol, deps, now = Date.now(), blackoutMins = 30, windowHours = 4 }) {
  const surprise = computeSurprise(event);
  const releaseMs = event.timestampUtc;
  const tradeableAt = releaseMs + blackoutMins * 60 * 1000;
  const expiresAt = releaseMs + windowHours * 60 * 60 * 1000;

  const expectedDir = surpriseToPairDirection(symbol, event.currency, surprise.bias); // 'UP'|'DOWN'|'NEUTRAL'

  // Realized reaction since the release (uses M5 candles).
  const m5 = deps.getCandles(symbol, 'M5', 300) || [];
  const releaseClose = closeAtOrAfter(m5, releaseMs);
  const lastClose = num(m5[m5.length - 1]?.close);
  let realizedDir = 'NEUTRAL';
  let realizedMovePct = 0;
  if (releaseClose !== null && lastClose !== null && releaseClose !== 0) {
    realizedMovePct = ((lastClose - releaseClose) / Math.abs(releaseClose)) * 100;
    if (lastClose > releaseClose) realizedDir = 'UP';
    else if (lastClose < releaseClose) realizedDir = 'DOWN';
  }

  // Current structure for entry/SL/TP + bias.
  let agg = null;
  try {
    agg = aggregateSignals({ symbol, timeframe: 'M5', candles: m5, indicators: [],
      h1Candles: deps.getCandles(symbol, 'H1', 150), h4Candles: deps.getCandles(symbol, 'H4', 150) });
  } catch { agg = null; }
  const sd = agg?.systemDecision || null;
  const price = num(sd?.entryPrice ?? lastClose);

  // Final direction: prefer the realized post-news reaction (the market has spoken);
  // surprise agreement and system-structure agreement raise confidence.
  let direction = realizedDir !== 'NEUTRAL' ? realizedDir : expectedDir;
  const sysDir = sd ? (String(sd.decision).includes('BUY') ? 'UP' : String(sd.decision).includes('SELL') ? 'DOWN' : 'NEUTRAL') : 'NEUTRAL';

  let confidence = 45;
  if (direction !== 'NEUTRAL') {
    if (expectedDir === direction) confidence += 20;        // surprise agrees
    if (sysDir === direction) confidence += 20;             // structure agrees
    if (Math.abs(realizedMovePct) >= 0.1) confidence += 10; // decisive reaction
    confidence = Math.min(90, confidence);
  } else {
    confidence = 25;
  }

  // ATR-ish SL/TP from system decision when available.
  const sl = sd?.stopLoss ?? null;
  const tp1 = sd?.takeProfit1 ?? null;
  const tp2 = sd?.takeProfit2 ?? null;
  const status = now >= tradeableAt ? 'ACTIVE' : 'WAITING';
  const minutesToTradeable = Math.max(0, Math.round((tradeableAt - now) / 60000));

  return {
    id: `postnews|${event.id}|${symbol}`,
    symbol,
    event: {
      id: event.id, title: event.title, currency: event.currency, impact: event.impact,
      timeIso: event.timeIso, actual: event.actual, forecast: event.forecast, previous: event.previous,
    },
    surprise,
    expectedDir,
    realizedDir,
    realizedMovePct: Math.round(realizedMovePct * 1000) / 1000,
    direction,
    confidence,
    price,
    stopLoss: sl,
    takeProfit1: tp1,
    takeProfit2: tp2,
    htfBias: sd?.htfBias || 'NEUTRAL',
    status,
    tradeableAtIso: new Date(tradeableAt).toISOString(),
    expiresAtIso: new Date(expiresAt).toISOString(),
    minutesToTradeable,
    note: status === 'WAITING'
      ? `Blackout: no entry until +${blackoutMins}m after the release. Signal activates in ${minutesToTradeable}m.`
      : `Post-news window open. Surprise was ${surprise.bias} (${surprise.basis}); market reacted ${realizedDir}. Trade ${direction} with confirmation.`,
  };
}
