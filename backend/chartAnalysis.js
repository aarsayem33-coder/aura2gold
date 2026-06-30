// chartAnalysis.js — PURE, additive, ISOLATED helpers for the AI Chart Image feature.
//
// Two jobs, both deterministic and honest (ranges + named basis, never promises):
//   1. estimateDirectionalPersistence — "how many candles does price tend to stay in a
//      direction" from the historical run-length of same-direction closes.
//   2. buildConditionalTimeTrigger — the "at HH:MM trade only if price ABOVE/BELOW X,
//      else ignore" trigger, anchored to the next candle close + a structural level.
//
// Plus thin assemblers that normalise engine output into the API response shape and a
// full deterministic fallback builder used when Gemini vision is unavailable.
//
// PURE: no I/O, no DB, no network. Callers pass already-computed engine output + candles.

const num = (v) => (v === null || v === undefined ? NaN : Number(v));

// Local timeframe→ms (M/H/D/W). Keeps this module dependency-free.
export function timeframeToMs(tf) {
  const t = String(tf || '').trim().toUpperCase();
  const m = t.match(/^([A-Z]+)(\d+)$/);
  if (!m) return 0;
  const unit = m[1];
  const k = Number(m[2]) || 0;
  if (unit === 'M') return k * 60000;          // minutes (M1..M30)
  if (unit === 'H') return k * 3600000;        // hours
  if (unit === 'D') return k * 86400000;       // days
  if (unit === 'W') return k * 7 * 86400000;   // weeks
  return 0;
}

// Normalise any direction token to 'UP' | 'DOWN' | 'NONE'.
export function normalizeDirection(direction) {
  const d = String(direction || '').toUpperCase();
  if (d === 'UP' || d === 'BUY' || d === 'STRONG_BUY' || d === 'LONG') return 'UP';
  if (d === 'DOWN' || d === 'SELL' || d === 'STRONG_SELL' || d === 'SHORT') return 'DOWN';
  return 'NONE';
}

function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

/**
 * How long price tends to persist in `direction`, measured from the historical run-length
 * of consecutive same-direction candle closes (close>open = up, close<open = down).
 * Returns an HONEST range, never a single promise. `expectedCandles` is the median run.
 */
export function estimateDirectionalPersistence(candles, direction) {
  const dir = normalizeDirection(direction);
  const empty = { expectedCandles: null, median: null, p25: null, p75: null, avg: null, sampleRuns: 0, basis: 'insufficient-data' };
  if (dir === 'NONE' || !Array.isArray(candles) || candles.length < 10) return empty;

  // Classify each closed candle: +1 up, -1 down, 0 flat/doji.
  const dirs = [];
  for (const c of candles) {
    const o = num(c.open); const cl = num(c.close);
    if (!Number.isFinite(o) || !Number.isFinite(cl)) { dirs.push(0); continue; }
    dirs.push(cl > o ? 1 : cl < o ? -1 : 0);
  }
  const want = dir === 'UP' ? 1 : -1;

  // Collect lengths of maximal runs of the wanted direction (flats break a run).
  const runs = [];
  let cur = 0;
  for (const d of dirs) {
    if (d === want) cur += 1;
    else { if (cur > 0) runs.push(cur); cur = 0; }
  }
  if (cur > 0) runs.push(cur);
  if (!runs.length) return { ...empty, basis: 'no-runs-in-direction' };

  const sorted = [...runs].sort((a, b) => a - b);
  const avg = runs.reduce((a, b) => a + b, 0) / runs.length;
  const med = median(sorted);
  return {
    expectedCandles: Math.max(1, Math.round(med)),
    median: med,
    p25: percentile(sorted, 25),
    p75: percentile(sorted, 75),
    avg: Math.round(avg * 10) / 10,
    sampleRuns: runs.length,
    basis: `median of ${runs.length} historical ${dir.toLowerCase()} runs`,
  };
}

// Format a UTC ms instant into a "h:mm AM/PM TZ" label (BDT by default).
export function formatTriggerTime(ms, timezone = 'Asia/Dhaka', tzLabel = 'BDT') {
  if (!Number.isFinite(ms)) return null;
  try {
    const s = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(ms));
    return `${s} ${tzLabel}`;
  } catch {
    return new Date(ms).toISOString();
  }
}

/**
 * The conditional "trade window" trigger:
 *   "At <atLabel> — trade <direction> only if price is <condition> <level>, else IGNORE."
 * Anchored to the close of the currently-forming candle (rolled forward if already past).
 */
export function buildConditionalTimeTrigger({ candles, timeframe, level, direction, now = Date.now(), timezone = 'Asia/Dhaka', tzLabel = 'BDT' }) {
  const dir = normalizeDirection(direction);
  const tfMs = timeframeToMs(timeframe);
  if (!Array.isArray(candles) || !candles.length || !tfMs) {
    return { atIso: null, atLabel: null, condition: null, level: level ?? null, direction: dir, elseAction: 'IGNORE', basis: 'insufficient-data' };
  }
  const lastOpen = Date.parse(candles[candles.length - 1].time);
  let atMs = Number.isFinite(lastOpen) ? lastOpen + tfMs : now + tfMs; // close of the forming bar
  // Roll forward to the next not-yet-closed boundary.
  while (atMs <= now) atMs += tfMs;

  return {
    atIso: new Date(atMs).toISOString(),
    atLabel: formatTriggerTime(atMs, timezone, tzLabel),
    condition: dir === 'UP' ? 'ABOVE' : dir === 'DOWN' ? 'BELOW' : null,
    level: Number.isFinite(num(level)) ? Number(level) : null,
    direction: dir,
    elseAction: 'IGNORE',
    basis: 'next candle close + structural level',
  };
}

// Pick the most relevant breakout/structural level for the trigger condition.
export function pickTriggerLevel({ breakout, supportResistance, direction, price }) {
  const dir = normalizeDirection(direction);
  if (breakout && Number.isFinite(num(breakout.level))) return Number(breakout.level);
  const sr = supportResistance || {};
  const p = num(price);
  if (dir === 'UP') {
    // nearest resistance above price (the level to break/hold above)
    const res = (sr.resistance || []).map((z) => num(z.level ?? z)).filter((v) => Number.isFinite(v) && (!Number.isFinite(p) || v >= p)).sort((a, b) => a - b);
    if (res.length) return res[0];
  } else if (dir === 'DOWN') {
    const sup = (sr.support || []).map((z) => num(z.level ?? z)).filter((v) => Number.isFinite(v) && (!Number.isFinite(p) || v <= p)).sort((a, b) => b - a);
    if (sup.length) return sup[0];
  }
  return Number.isFinite(p) ? p : null;
}

// ── Response assemblers (normalise engine output into the API shape) ─────────

export function assembleForexPlan({ systemDecision, sizing }) {
  const sd = systemDecision || {};
  if (!sd.decision || sd.decision === 'HOLD') {
    return { decision: 'HOLD', entry: sd.entryPrice ?? null, stopLoss: null, takeProfit1: null, takeProfit2: null, takeProfit3: null, riskReward: null, lots: null, stopPips: null, lossAtStop: null, riskLevel: 'NONE', invalidation: sd.slReason || null, note: 'No deterministic forex setup — WAIT.' };
  }
  return {
    decision: sd.decision,
    entry: sd.entryPrice ?? null,
    stopLoss: sd.stopLoss ?? null,
    takeProfit1: sd.takeProfit1 ?? null,
    takeProfit2: sd.takeProfit2 ?? null,
    takeProfit3: sd.takeProfit3 ?? null,
    riskReward: sd.riskRewardRatio ?? null,
    lots: sizing?.suggestedLots ?? null,
    stopPips: sizing?.stopPips ?? null,
    lossAtStop: sizing?.lossAtStop ?? null,
    riskLevel: sd.adrExhausted ? 'HIGH' : (sd.regime === 'trending' ? 'MEDIUM' : 'MEDIUM'),
    invalidation: sd.slReason || null,
    grade: sd.grade ?? null,
  };
}

export function assembleFttPlan({ fttPrediction, persistence, timeTrigger }) {
  const ftt = fttPrediction || {};
  const tfMap = ftt.indicators?.timeframeMapping || {};
  return {
    direction: normalizeDirection(ftt.direction) === 'NONE' ? 'HOLD' : normalizeDirection(ftt.direction),
    confidence: ftt.confidence ?? null,
    expiry: tfMap.entry ? null : null, // expiry is chosen at request time; see suggestedExpiry below
    suggestedTimeframe: tfMap.entry || null,
    timeframeLadder: tfMap.entry ? tfMap : null,
    expectedCandlesInDirection: persistence?.expectedCandles ?? null,
    persistenceRange: persistence && persistence.p25 != null ? { low: persistence.p25, high: persistence.p75, basis: persistence.basis } : null,
    timeTrigger: timeTrigger || null,
    reasoning: ftt.reasoning || null,
  };
}

/**
 * Full deterministic fallback analysis (no image read — analyses the live symbol|tf).
 * All inputs are pre-computed by the caller from the live engines; this stays pure.
 */
export function buildSystemChartAnalysis({
  symbol, timeframe, tradeMode = 'BOTH',
  systemDecision = {}, fttPrediction = {}, breakout = null, sizing = null,
  candles = [], strategies = [], supportResistance = null, timezone = 'Asia/Dhaka',
}) {
  const mode = String(tradeMode || 'BOTH').toUpperCase();
  const sd = systemDecision || {};
  const price = num(sd.entryPrice ?? (candles.length ? candles[candles.length - 1].close : NaN));

  // Direction for FTT/persistence: prefer FTT engine, else the system decision.
  const fttDir = normalizeDirection(fttPrediction?.direction);
  const dir = fttDir !== 'NONE' ? fttDir : normalizeDirection(sd.decision);

  const persistence = estimateDirectionalPersistence(candles, dir);
  const level = pickTriggerLevel({ breakout, supportResistance: supportResistance || sd.supportResistance, direction: dir, price });
  const timeTrigger = buildConditionalTimeTrigger({ candles, timeframe, level, direction: dir, timezone });

  const detection = {
    trend: sd.htfBias || (breakout?.trend ?? null),
    regime: sd.regime ?? null,
    structure: sd.confluences ? sd.confluences.slice(0, 6) : [],
    srZones: supportResistance || sd.supportResistance || { support: [], resistance: [] },
    breakout: breakout ? { phase: breakout.phase, direction: breakout.direction, grade: breakout.grade, level: breakout.level, displacement: !!(breakout.displacement && breakout.displacement.present) } : null,
    grade: sd.grade ?? null,
  };

  return {
    symbol,
    timeframe,
    detection,
    forexPlan: (mode === 'FOREX' || mode === 'BOTH') ? assembleForexPlan({ systemDecision: sd, sizing }) : null,
    fttPlan: (mode === 'FTT' || mode === 'BOTH') ? assembleFttPlan({ fttPrediction, persistence, timeTrigger }) : null,
    breakout: detection.breakout,
    timeTrigger,
    strategies: Array.isArray(strategies) ? strategies : [],
    honesty: [
      'Deterministic system analysis of LIVE data for this symbol/timeframe — not a read of your uploaded image.',
      'Directional-persistence and timing are estimates (ranges), never guarantees.',
    ],
  };
}
