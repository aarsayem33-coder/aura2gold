import { aggregateSignals } from './signalEngine.js';
import { TRADER_DOCTRINE } from './geminiEngine.js';

/**
 * FTT Engine — Fixed-Time Trading direction prediction module.
 * Generates short-term price direction forecasts (UP / DOWN / HOLD)
 * using layered technical momentum filters on top of the existing signal engine.
 */

// ── helpers ──────────────────────────────────────────────────────────

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Parse an expiry string like '1m', '5m', '15m', '1h' into milliseconds */
function parseExpiryMs(expiry) {
  const str = String(expiry || '5m').trim().toLowerCase();
  const match = str.match(/^(\d+)\s*(m|min|h|hr|s|sec)$/);
  if (!match) return 5 * 60 * 1000; // default 5 minutes
  const value = Number(match[1]);
  switch (match[2]) {
    case 's':
    case 'sec':
      return value * 1000;
    case 'm':
    case 'min':
      return value * 60 * 1000;
    case 'h':
    case 'hr':
      return value * 60 * 60 * 1000;
    default:
      return value * 60 * 1000;
  }
}

/** Determine whether this expiry favours momentum or trend signals */
function expiryCategory(expiryMs) {
  if (expiryMs <= 3 * 60 * 1000) return 'momentum'; // ≤ 3 min
  if (expiryMs <= 10 * 60 * 1000) return 'balanced'; // 4–10 min
  return 'trend'; // 15 min+
}

// ── short-term momentum filters ─────────────────────────────────────

function rsiTrendDirection(candles, indicators) {
  // Look for RSI readings attached to the last 3 candles by time
  const rsiReadings = [];
  const sorted = [...candles].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const last3 = sorted.slice(-3);

  for (const c of last3) {
    const match = indicators.find(
      (ind) =>
        String(ind.indicator || ind.name || '').toUpperCase() === 'RSI' &&
        ind.candleTime === c.time
    );
    if (match) {
      const v = toNumber(match.value1 ?? match.rsi ?? match.value);
      if (v !== null) rsiReadings.push(v);
    }
  }

  if (rsiReadings.length < 2) return { score: 0, reason: 'Insufficient RSI history' };

  const trend = rsiReadings[rsiReadings.length - 1] - rsiReadings[0];
  if (trend > 3) return { score: 0.6, reason: `RSI rising momentum (+${trend.toFixed(1)})` };
  if (trend < -3) return { score: -0.6, reason: `RSI falling momentum (${trend.toFixed(1)})` };
  return { score: 0, reason: `RSI flat (Δ${trend.toFixed(1)})` };
}

function macdHistogramMomentum(indicators) {
  const macdEntries = indicators
    .filter((ind) => String(ind.indicator || ind.name || '').toUpperCase() === 'MACD')
    .sort((a, b) => Date.parse(a.candleTime || 0) - Date.parse(b.candleTime || 0))
    .slice(-3);

  if (macdEntries.length < 2) return { score: 0, reason: 'Insufficient MACD history' };

  const histValues = macdEntries
    .map((e) => toNumber(e.value3 ?? e.histogram))
    .filter((v) => v !== null);

  if (histValues.length < 2) return { score: 0, reason: 'MACD histogram data missing' };

  const latest = histValues[histValues.length - 1];
  const prev = histValues[histValues.length - 2];
  const delta = latest - prev;

  if (latest > 0 && delta > 0) return { score: 0.7, reason: `MACD histogram growing bullish (${latest.toFixed(4)})` };
  if (latest < 0 && delta < 0) return { score: -0.7, reason: `MACD histogram growing bearish (${latest.toFixed(4)})` };
  if (latest > 0 && delta < 0) return { score: 0.2, reason: `MACD histogram shrinking bullish` };
  if (latest < 0 && delta > 0) return { score: -0.2, reason: `MACD histogram shrinking bearish` };
  return { score: 0, reason: 'MACD histogram neutral' };
}

function priceVsEma9(price, indicators) {
  if (price === null) return { score: 0, reason: 'No price data' };

  const ema9Entry = indicators.find((ind) => {
    const name = String(ind.indicator || ind.name || '').toUpperCase();
    return name === 'EMA9' || name === 'EMA 9' || name === 'EMA_9';
  });

  const ema9 = toNumber(ema9Entry?.value1);
  if (ema9 === null) return { score: 0, reason: 'EMA9 unavailable' };

  const diff = (price - ema9) / ema9;
  if (diff > 0.001) return { score: 0.5, reason: `Price above EMA9 (+${(diff * 100).toFixed(2)}%)` };
  if (diff < -0.001) return { score: -0.5, reason: `Price below EMA9 (${(diff * 100).toFixed(2)}%)` };
  return { score: 0, reason: 'Price at EMA9' };
}

function candleBodyRatio(candle) {
  if (!candle) return { score: 0, reason: 'No candle data' };

  const open = toNumber(candle.open);
  const close = toNumber(candle.close);
  const high = toNumber(candle.high);
  const low = toNumber(candle.low);

  if (open === null || close === null || high === null || low === null) {
    return { score: 0, reason: 'Incomplete candle data' };
  }

  const range = high - low;
  if (range <= 0) return { score: 0, reason: 'Zero range candle' };

  const body = Math.abs(close - open);
  const ratio = body / range;
  const bullish = close > open;

  if (ratio > 0.6) {
    return {
      score: bullish ? 0.6 : -0.6,
      reason: `Strong ${bullish ? 'bullish' : 'bearish'} candle (body ${(ratio * 100).toFixed(0)}%)`,
    };
  }
  if (ratio < 0.2) {
    return { score: 0, reason: `Indecision candle (body ${(ratio * 100).toFixed(0)}%)` };
  }
  return {
    score: bullish ? 0.3 : -0.3,
    reason: `Moderate ${bullish ? 'bullish' : 'bearish'} candle (body ${(ratio * 100).toFixed(0)}%)`,
  };
}

function volumeSpikeDetection(candles) {
  const sorted = [...candles].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  if (sorted.length < 5) return { score: 0, reason: 'Insufficient volume history' };

  const recent = sorted.slice(-10);
  const avgVol = recent.reduce((sum, c) => sum + (toNumber(c.volume) || 0), 0) / recent.length;
  const latestVol = toNumber(sorted[sorted.length - 1]?.volume);

  if (latestVol === null || avgVol <= 0) return { score: 0, reason: 'Volume data unavailable' };

  const ratio = latestVol / avgVol;
  const latestClose = toNumber(sorted[sorted.length - 1]?.close);
  const latestOpen = toNumber(sorted[sorted.length - 1]?.open);
  const bullish = latestClose !== null && latestOpen !== null && latestClose > latestOpen;

  if (ratio >= 1.15) {
    return {
      score: bullish ? 0.5 : -0.5,
      reason: `Volume spike ${ratio.toFixed(2)}x avg — directional commitment ${bullish ? 'UP' : 'DOWN'}`,
    };
  }
  return { score: 0, reason: `Volume normal (${ratio.toFixed(2)}x avg)` };
}

function averageBody(candles, count = 5) {
  const bodies = [...candles]
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
    .slice(-(count + 1), -1)
    .map((c) => Math.abs((toNumber(c.close) ?? 0) - (toNumber(c.open) ?? 0)))
    .filter((v) => Number.isFinite(v) && v > 0);
  if (!bodies.length) return null;
  return bodies.reduce((sum, v) => sum + v, 0) / bodies.length;
}

function classifyEntryCandle(candles, direction) {
  const sorted = [...candles].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const c = sorted[sorted.length - 1];
  const p = sorted[sorted.length - 2];
  if (!c) return { patterns: [], warnings: ['No entry candle data'], score: -20 };

  const open = toNumber(c.open);
  const close = toNumber(c.close);
  const high = toNumber(c.high);
  const low = toNumber(c.low);
  if (open === null || close === null || high === null || low === null) {
    return { patterns: [], warnings: ['Incomplete entry candle data'], score: -20 };
  }

  const range = high - low;
  if (range <= 0) return { patterns: ['Four-price doji'], warnings: ['No candle range'], score: -30 };

  const body = Math.abs(close - open);
  const bodyRatio = body / range;
  const upperWick = high - Math.max(open, close);
  const lowerWick = Math.min(open, close) - low;
  const bullish = close > open;
  const bearish = close < open;
  const wantsUp = direction === 'UP';
  const patterns = [];
  const warnings = [];
  let score = 0;

  if (bodyRatio <= 0.1) {
    if (lowerWick > range * 0.6 && upperWick <= range * 0.15) patterns.push('Dragonfly doji');
    else if (upperWick > range * 0.6 && lowerWick <= range * 0.15) patterns.push('Gravestone doji');
    else patterns.push('Doji');
    warnings.push('Indecision candle at entry');
    score -= 35;
  } else if (upperWick > body && lowerWick > body) {
    patterns.push('Spinning top');
    warnings.push('Two-sided wick rejection');
    score -= 25;
  }

  const avgBody = averageBody(sorted, 5);
  if (avgBody && body >= avgBody * 2) {
    patterns.push(`${bullish ? 'Bullish' : bearish ? 'Bearish' : 'Neutral'} momentum candle`);
    score += wantsUp === bullish ? 18 : wantsUp === bearish ? 18 : -12;
  }

  if (p) {
    const po = toNumber(p.open);
    const pc = toNumber(p.close);
    if (po !== null && pc !== null) {
      const prevBull = pc > po;
      const prevBear = pc < po;
      if (bullish && prevBear && close >= po && open <= pc) {
        patterns.push('Bullish engulfing');
        score += wantsUp ? 22 : -18;
      }
      if (bearish && prevBull && open >= pc && close <= po) {
        patterns.push('Bearish engulfing');
        score += !wantsUp ? 22 : -18;
      }
    }
  }

  if (bodyRatio <= 0.35 && lowerWick >= body * 2 && upperWick <= Math.max(body, range * 0.15)) {
    patterns.push('Hammer / bullish pinbar');
    score += wantsUp ? 18 : -22;
  }
  if (bodyRatio <= 0.35 && upperWick >= body * 2 && lowerWick <= Math.max(body, range * 0.15)) {
    patterns.push('Shooting star / bearish pinbar');
    score += !wantsUp ? 18 : -22;
  }
  if (bodyRatio >= 0.65) {
    patterns.push(`${bullish ? 'Bullish' : bearish ? 'Bearish' : 'Neutral'} breakout body`);
    score += wantsUp === bullish ? 12 : wantsUp === bearish ? 12 : -12;
  }

  const againstWick = wantsUp ? upperWick : lowerWick;
  if (againstWick >= Math.max(body * 1.5, range * 0.35)) {
    warnings.push('Strong wick rejection against direction');
    score -= 30;
  }
  if (direction !== 'HOLD' && ((wantsUp && bearish) || (!wantsUp && bullish))) {
    warnings.push('Entry candle color conflicts with direction');
    score -= 20;
  }

  return { patterns, warnings, score, bodyRatio, range };
}

function assessVolatility(candles) {
  const sorted = [...candles].sort((a, b) => Date.parse(a.time) - Date.parse(b.time)).slice(-20);
  if (sorted.length < 8) return { state: 'UNKNOWN', score: 0, warnings: ['Limited volatility history'] };
  const ranges = sorted
    .map((c) => {
      const high = toNumber(c.high);
      const low = toNumber(c.low);
      return high !== null && low !== null ? high - low : null;
    })
    .filter((v) => v !== null && v > 0);
  if (ranges.length < 8) return { state: 'UNKNOWN', score: 0, warnings: ['Invalid volatility history'] };
  const latest = ranges[ranges.length - 1];
  const avg = ranges.slice(0, -1).reduce((sum, v) => sum + v, 0) / Math.max(1, ranges.length - 1);
  const ratio = avg > 0 ? latest / avg : 1;
  if (ratio >= 2.2) return { state: 'HIGH_SPIKE', score: -30, warnings: [`Abnormal volatility spike (${ratio.toFixed(2)}x range)`] };
  if (ratio <= 0.35) return { state: 'LOW_CHOP', score: -20, warnings: [`Compressed/choppy range (${ratio.toFixed(2)}x range)`] };
  return { state: 'NORMAL', score: 10, warnings: [] };
}

function highestHighLowestLow(candles) {
  const highs = candles.map((c) => toNumber(c.high)).filter((v) => v !== null);
  const lows = candles.map((c) => toNumber(c.low)).filter((v) => v !== null);
  if (!highs.length || !lows.length) return null;
  return { high: Math.max(...highs), low: Math.min(...lows) };
}

function calculateIchimokuSnapshot(candles) {
  const sorted = [...candles]
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
    .filter((c) => toNumber(c.high) !== null && toNumber(c.low) !== null && toNumber(c.close) !== null);
  if (sorted.length < 52) return null;

  const latest = sorted[sorted.length - 1];
  const close = toNumber(latest.close);
  const tenkanRange = highestHighLowestLow(sorted.slice(-9));
  const kijunRange = highestHighLowestLow(sorted.slice(-26));
  const spanBRange = highestHighLowestLow(sorted.slice(-52));
  if (close === null || !tenkanRange || !kijunRange || !spanBRange) return null;

  const tenkan = (tenkanRange.high + tenkanRange.low) / 2;
  const kijun = (kijunRange.high + kijunRange.low) / 2;
  const senkouA = (tenkan + kijun) / 2;
  const senkouB = (spanBRange.high + spanBRange.low) / 2;
  const cloudTop = Math.max(senkouA, senkouB);
  const cloudBottom = Math.min(senkouA, senkouB);
  const position = close > cloudTop ? 'ABOVE_CLOUD' : close < cloudBottom ? 'BELOW_CLOUD' : 'INSIDE_CLOUD';
  const chikouRef = toNumber(sorted[sorted.length - 27]?.close);
  const ranges = sorted.slice(-20).map((c) => {
    const high = toNumber(c.high);
    const low = toNumber(c.low);
    return high !== null && low !== null ? high - low : null;
  }).filter((v) => v !== null && v > 0);
  const avgRange = ranges.length ? ranges.reduce((sum, v) => sum + v, 0) / ranges.length : 0;
  const cloudThickness = Math.abs(senkouA - senkouB);

  return {
    tenkan,
    kijun,
    senkouA,
    senkouB,
    cloudTop,
    cloudBottom,
    position,
    chikouDirection: chikouRef === null ? 'UNKNOWN' : close > chikouRef ? 'BULLISH' : close < chikouRef ? 'BEARISH' : 'NEUTRAL',
    cloudDirection: senkouA > senkouB ? 'BULLISH' : senkouA < senkouB ? 'BEARISH' : 'NEUTRAL',
    tkDirection: tenkan > kijun ? 'BULLISH' : tenkan < kijun ? 'BEARISH' : 'NEUTRAL',
    cloudFlat: avgRange > 0 ? cloudThickness <= avgRange * 0.15 : false,
  };
}

function assessIchimoku(candles, direction) {
  const snapshot = calculateIchimokuSnapshot(candles);
  if (!snapshot || direction === 'HOLD') {
    return { score: 0, signal: 'UNKNOWN', state: snapshot?.position || 'UNKNOWN', reasons: [], warnings: [], details: snapshot };
  }

  const wantsUp = direction === 'UP';
  const tkAgrees = wantsUp ? snapshot.tkDirection === 'BULLISH' : snapshot.tkDirection === 'BEARISH';
  const chikouAgrees = wantsUp ? snapshot.chikouDirection === 'BULLISH' : snapshot.chikouDirection === 'BEARISH';
  const cloudAgrees = wantsUp ? snapshot.position === 'ABOVE_CLOUD' : snapshot.position === 'BELOW_CLOUD';
  const cloudOpposes = wantsUp ? snapshot.position === 'BELOW_CLOUD' : snapshot.position === 'ABOVE_CLOUD';
  const reasons = [];
  const warnings = [];
  let score = 0;
  let signal = 'NEUTRAL';

  if (cloudAgrees && tkAgrees && chikouAgrees) {
    score += 10;
    signal = 'CONFIRMS';
    reasons.push(`Ichimoku confirms ${direction}: price ${wantsUp ? 'above' : 'below'} cloud, TK aligned, Chikou confirms`);
  } else if (snapshot.position === 'INSIDE_CLOUD') {
    score -= 8;
    signal = tkAgrees ? 'PARTIAL' : 'CONFLICTS';
    warnings.push('Price is inside Ichimoku cloud');
    if (tkAgrees) {
      score += 5;
      reasons.push('Tenkan/Kijun leans with FTT direction inside cloud');
    }
  } else if (cloudOpposes || !tkAgrees) {
    score -= 12;
    signal = 'CONFLICTS';
    warnings.push(`Ichimoku disagrees with ${direction} setup`);
  } else if (tkAgrees) {
    score += 5;
    signal = 'PARTIAL';
    reasons.push('Ichimoku Tenkan/Kijun agrees with FTT direction');
  }

  if (snapshot.cloudFlat && score > 0) {
    score -= 3;
    warnings.push('Ichimoku cloud is flat/thin, trend confirmation is weaker');
  }

  return { score, signal, state: snapshot.position, reasons, warnings, details: snapshot };
}

function spreadWarning(latestCandle) {
  const spread = toNumber(latestCandle?.spread);
  const high = toNumber(latestCandle?.high);
  const low = toNumber(latestCandle?.low);
  if (spread === null || high === null || low === null || high <= low) return null;
  // MT5 spread is broker points, so only treat extreme ratios as warnings without hard failing.
  const range = high - low;
  if (spread > 0 && range > 0 && spread / 100000 > range * 0.6) return 'Spread appears wide relative to candle range';
  return null;
}

function buildFttQuality({ direction, confidence, candles, aggregate, momentumScore, trendScore, noiseFilterActive }) {
  const latestCandle = aggregate.latestCandle;
  const candle = classifyEntryCandle(candles, direction);
  const volatility = assessVolatility(candles);
  const ichimoku = assessIchimoku(candles, direction);
  const qualityReasons = [];
  const riskWarnings = [...candle.warnings, ...volatility.warnings];
  const rejectionReasons = [...(aggregate.systemDecision?.rejectionReasons || [])];
  const spread = spreadWarning(latestCandle);
  if (spread) riskWarnings.push(spread);

  let qualityScore = Math.round(confidence + candle.score + volatility.score + ichimoku.score);
  qualityReasons.push(...ichimoku.reasons);
  riskWarnings.push(...ichimoku.warnings);
  const adxValue = toNumber(aggregate.systemDecision?.adxValue);
  if (adxValue !== null) {
    if (adxValue < 18) {
      qualityScore -= 25;
      riskWarnings.push(`Ranging/choppy regime (ADX ${adxValue.toFixed(1)})`);
    } else if (adxValue < 22) {
      qualityScore -= 10;
      riskWarnings.push(`Developing regime (ADX ${adxValue.toFixed(1)})`);
    } else {
      qualityScore += 5;
      qualityReasons.push(`Regime supports movement (ADX ${adxValue.toFixed(1)})`);
    }
  }
  if (direction !== 'HOLD' && Math.sign(momentumScore) === Math.sign(trendScore) && Math.abs(momentumScore) > 0.2 && Math.abs(trendScore) > 0.2) {
    qualityScore += 10;
    qualityReasons.push('Trend and short-term momentum agree');
  } else if (direction !== 'HOLD') {
    qualityScore -= 10;
    riskWarnings.push('Trend and momentum are not fully aligned');
  }
  if (noiseFilterActive) {
    qualityScore -= 12;
    riskWarnings.push('Mid-candle noise filter active');
  }
  if (candle.patterns.length) qualityReasons.push(`Entry pattern: ${candle.patterns.join(', ')}`);
  if (volatility.state === 'NORMAL') qualityReasons.push('Volatility is normal');

  qualityScore = Math.max(0, Math.min(100, qualityScore));
  const hardReject = direction === 'HOLD' || volatility.state === 'HIGH_SPIKE' || candle.warnings.some((w) => /Indecision|Two-sided|Strong wick/.test(w)) || (adxValue !== null && adxValue < 18);
  let qualityTier = 'WATCH_ONLY';
  if (hardReject) qualityTier = direction === 'HOLD' ? 'NO_TRADE' : 'WATCH_ONLY';
  else if (confidence >= 80 && qualityScore >= 82 && riskWarnings.length <= 1) qualityTier = 'QUALITY_SIGNAL';
  else if (confidence >= 75 && qualityScore >= 62) qualityTier = 'TRADE_SIGNAL';

  return {
    qualityTier,
    qualityScore,
    qualityReasons,
    riskWarnings,
    rejectionReasons,
    volatilityState: volatility.state,
    ichimokuState: ichimoku.state,
    ichimokuSignal: ichimoku.signal,
    ichimokuDetails: ichimoku.details,
    detectedPatterns: candle.patterns,
    candleBodyRatio: candle.bodyRatio ?? null,
    tradeAllowed: qualityTier === 'QUALITY_SIGNAL' || qualityTier === 'TRADE_SIGNAL',
  };
}

// ── main prediction generator ───────────────────────────────────────

export function generateFttPrediction({
  symbol,
  expiry = '5m',
  candles = [],
  indicators = [],
  marketLevels = [],
  accountSnapshot = null,
  adr = null,
  dailyHighLow = null,
  h4Candles = [],
  h1Candles = [],
  skipNews = false,
}) {
  const expiryMs = parseExpiryMs(expiry);
  const category = expiryCategory(expiryMs);

  // Scaled Timeframe mapping for Fixed-Time Trading
  function getFttTimeframeMapping(expStr) {
    const exp = String(expStr || '5m').trim().toLowerCase();
    if (exp === '1m' || exp === '2m' || exp === '3m' || exp === '4m') {
      return { bias: 'M5', trend: 'M3', entry: 'M1', confirmation: 'M1' };
    }
    if (exp === '5m') {
      return { bias: 'M15', trend: 'M5', entry: 'M2', confirmation: 'M1' };
    }
    if (exp === '10m') {
      return { bias: 'M15', trend: 'M5', entry: 'M3', confirmation: 'M1' };
    }
    if (exp === '15m' || exp === '20m') {
      return { bias: 'M30', trend: 'M15', entry: 'M5', confirmation: 'M1' };
    }
    if (exp === '30m' || exp === '40m') {
      return { bias: 'H1', trend: 'M30', entry: 'M5', confirmation: 'M1' };
    }
    return { bias: 'H4', trend: 'H1', entry: 'M15', confirmation: 'M5' };
  }

  const tfConfig = getFttTimeframeMapping(expiry);

  // 1. Run the upgraded institutional signal aggregator
  const aggregate = aggregateSignals({
    symbol,
    timeframe: null,
    candles,
    indicators,
    marketLevels,
    accountSnapshot,
    adr,
    dailyHighLow,
    h4Candles,
    h1Candles,
    skipNews,
  });

  const latestCandle = aggregate.latestCandle;
  const close = toNumber(latestCandle?.close);

  // 2. Apply short-term momentum filters
  const momentumFilters = [];
  momentumFilters.push(rsiTrendDirection(candles, indicators));
  momentumFilters.push(macdHistogramMomentum(indicators));
  momentumFilters.push(priceVsEma9(close, indicators));
  momentumFilters.push(candleBodyRatio(latestCandle));
  momentumFilters.push(volumeSpikeDetection(candles));

  // 3. Weight momentum vs trend based on expiry category
  let momentumWeight, trendWeight;
  switch (category) {
    case 'momentum':
      momentumWeight = 0.7;
      trendWeight = 0.3;
      break;
    case 'balanced':
      momentumWeight = 0.5;
      trendWeight = 0.5;
      break;
    case 'trend':
      momentumWeight = 0.3;
      trendWeight = 0.7;
      break;
    default:
      momentumWeight = 0.5;
      trendWeight = 0.5;
  }

  const validFilters = momentumFilters.filter((f) => f.score !== 0);
  const momentumScore =
    validFilters.length > 0
      ? validFilters.reduce((sum, f) => sum + f.score, 0) / validFilters.length
      : 0;

  const positiveFilterCount = momentumFilters.filter((f) => f.score > 0).length;
  const strongFilterCount = momentumFilters.filter((f) => f.score >= 0.5).length;

  // Blend: Institutional score + short-term momentum filters
  const trendScore = aggregate.tradableCompositeScore ?? aggregate.compositeScore ?? 0;
  const blendedScore = trendWeight * trendScore + momentumWeight * momentumScore;

  // 4. Convert to direction + confidence
  let direction = 'HOLD';
  if (blendedScore >= 0.15) direction = 'UP';
  else if (blendedScore <= -0.15) direction = 'DOWN';

  // Confidence scaling
  const rawConfidence = Math.abs(blendedScore);
  const baseConfidence = Math.max(20, Math.min(95, Math.round(30 + (rawConfidence * 45))));
  const trendEdgeBonus = Math.round(Math.max(0, Math.abs(trendScore) - 0.35) * 10);
  const momentumEdgeBonus = Math.round(Math.max(0, Math.abs(momentumScore) - 0.25) * 8);
  const agreementBonus =
    (direction === 'UP' && trendScore > 0 && momentumScore > 0) ||
    (direction === 'DOWN' && trendScore < 0 && momentumScore < 0)
      ? 8
      : 0;
  const qualityBonus = Math.min(10, (positiveFilterCount * 2) + (strongFilterCount * 2));

  let finalConfidence = Math.min(95, baseConfidence + trendEdgeBonus + momentumEdgeBonus + agreementBonus + qualityBonus);

  // 4a. Calculate timing instruction and noise-reduction check
  const entryTf = tfConfig.entry;
  
  function timeframeToMs(tframe) {
    const t = String(tframe || 'M5').trim().toUpperCase();
    if (t === 'M1') return 60000;
    if (t === 'M2') return 120000;
    if (t === 'M3') return 180000;
    if (t === 'M5') return 300000;
    if (t === 'M15') return 900000;
    if (t === 'M30') return 1800000;
    if (t === 'H1') return 3600000;
    return 300000;
  }

  const tfMs = timeframeToMs(entryTf);
  const nowMs = Date.now();
  const openTimeMs = latestCandle ? new Date(latestCandle.time).getTime() : nowMs;
  const elapsedMs = Math.max(0, nowMs - openTimeMs);
  const remainingMs = tfMs - (elapsedMs % tfMs);
  const remainingSeconds = Math.round(remainingMs / 1000);
  const elapsedSeconds = (tfMs / 1000) - remainingSeconds;

  let entryTimingInstruction = 'HOLD_NO_TRADE';
  let timingTip = 'Stay flat. No trade setup is currently active.';
  let noiseFilterActive = false;

  const immediateSecs = Math.min(30, (tfMs / 1000) * 0.1);
  const waitSecs = Math.min(30, (tfMs / 1000) * 0.1);

  // Noise reduction filter check: Are we outside the candle boundary?
  const isCloseBoundary = remainingSeconds <= waitSecs || elapsedSeconds <= immediateSecs;

  if (direction !== 'HOLD') {
    const ema9Entry = indicators.find((ind) => {
      const name = String(ind.indicator || ind.name || '').toUpperCase();
      return name === 'EMA9' || name === 'EMA 9' || name === 'EMA_9';
    });
    const ema9 = ema9Entry ? toNumber(ema9Entry.value1) : null;
    const ema9PriceStr = ema9 ? ema9.toFixed(close > 100 ? 2 : 5) : null;

    if (!isCloseBoundary) {
      // Noise reduction filter: keep the direction but damp the confidence score to reflect mid-candle risk
      noiseFilterActive = true;
      entryTimingInstruction = 'WAIT_FOR_NEXT_CANDLE';
      timingTip = `⏳ Noise Filter Active (Fractional Damping): Setup formed mid-candle. Confidence damped by 0.80.`;
      
      finalConfidence = Math.round(finalConfidence * 0.80); // Damped confidence
      
      // Filter out low-confidence mid-candle noise by overriding to HOLD if damped confidence is below 55%
      if (finalConfidence < 55) {
        direction = 'HOLD';
      }
    } else {
      if (remainingSeconds <= waitSecs) {
        entryTimingInstruction = 'WAIT_FOR_NEXT_CANDLE';
        timingTip = `Current candle is closing in ${remainingSeconds}s. Wait for the new candle open to enter immediately.`;
      } else {
        entryTimingInstruction = 'IMMEDIATE_ENTRY';
        timingTip = `New candle just opened (${remainingSeconds}s remaining on ${entryTf}). Execute entry now for maximum momentum.`;
      }
    }
  }

  // 5. Build reasoning with Institutional Confluences details
  const activeConfluences = aggregate.systemDecision?.confluences || [];
  const confluenceText = activeConfluences.map(c => `${c.name} (+${c.points})`).join(', ');
  const quality = buildFttQuality({
    direction,
    confidence: finalConfidence,
    candles,
    aggregate,
    momentumScore,
    trendScore,
    noiseFilterActive,
  });

  const reasoning = [
    `Grade: ${aggregate.systemDecision?.grade || 'No Trade'}`,
    `FTT Quality: ${quality.qualityTier} (${quality.qualityScore}/100)`,
    `Confluences: ${confluenceText || 'None'}`,
    `Expiry: ${expiry} (${category} mode)`,
    `Trend: ${trendScore.toFixed(2)}, Momentum: ${momentumScore.toFixed(2)}`,
    noiseFilterActive ? 'Noise filter overridden setup to HOLD.' : 'Candle close setup confirmed.'
  ].join('; ');

  return {
    direction,
    confidence: finalConfidence,
    entryPrice: close,
    reasoning,
    entryTimingInstruction,
    timingTip,
    indicators: {
      compositeScore: blendedScore,
      blendedScore,
      trendScore,
      rawTrendScore: aggregate.rawCompositeScore ?? trendScore,
      momentumScore,
      category,
      momentumWeight,
      trendWeight,
      bullishSignals: aggregate.bullishSignals,
      bearishSignals: aggregate.bearishSignals,
      momentumFilters: momentumFilters.map((f) => ({ score: f.score, reason: f.reason })),
      systemDecision: aggregate.decision,
      entryTimingInstruction,
      timingTip,
      remainingSeconds,
      grade: aggregate.systemDecision?.grade,
      confluences: activeConfluences,
      buyScore: aggregate.systemDecision?.buyScore,
      sellScore: aggregate.systemDecision?.sellScore,
      noiseFilterActive,
      timeframeMapping: tfConfig,
      qualityTier: quality.qualityTier,
      qualityScore: quality.qualityScore,
      qualityReasons: quality.qualityReasons,
      riskWarnings: quality.riskWarnings,
      rejectionReasons: quality.rejectionReasons,
      volatilityState: quality.volatilityState,
      detectedPatterns: quality.detectedPatterns,
      candleBodyRatio: quality.candleBodyRatio,
      tradeAllowed: quality.tradeAllowed,
    },
  };
}

// ── Gemini-safe prompt builder ──────────────────────────────────────

export function buildFttAiPrompt({ symbol, expiry, signalSummary, recentCandles = [] }) {
  const price = signalSummary?.entryPrice ?? signalSummary?.indicators?.compositeScore ?? 'N/A';
  const direction = signalSummary?.direction || 'N/A';
  const confidence = signalSummary?.confidence || 'N/A';
  const filters = signalSummary?.indicators?.momentumFilters || [];

  const candleSummary = recentCandles.slice(-10).map((c) => ({
    time: c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));

  return `${TRADER_DOCTRINE}

=== TASK: FIXED-TIME TRADE (FTT) DIRECTION ===
This is a FIXED-TIME / binary-style trade: after entry there is NO stop loss and NO take
profit — the trade simply settles at expiry. So the ONLY question that matters is:
will the CLOSE price be ABOVE (UP) or BELOW (DOWN) the current price ${price} after ${expiry}?

EXTRA FTT DISCIPLINE (on top of the doctrine above):
- Be even MORE conservative than for normal forex — you cannot manage risk after entry.
- REJECT gambling-style noise: never force a trade just because one candle is green/red.
  Require the higher-TF context (direction) AND a lower-TF confirmation to agree.
- The expiry must give the move room: prefer setups that play out over ~3-5 candles of
  the entry timeframe, not a single random candle. If ${expiry} is very short and the
  market is choppy/mid-range, output HOLD.
- A deterministic engine has ALREADY scored direction/momentum below — read that math
  FIRST, then decide. If momentum, trend and structure do not align, output HOLD.
- If high-impact news is imminent, or volatility/spread is abnormal, output HOLD.
- For UP: market should be bullish on the analysis TF (price holding above key MAs or
  reacting up from support) with RSI/ momentum supportive. For DOWN: the mirror image.
- Do NOT sell the low / buy the high after an extended move — that invites reversal.

The deterministic system read:
- System direction: ${direction} (confidence ${confidence}%)
- Composite trend score: ${signalSummary?.indicators?.trendScore ?? 'N/A'}
- Momentum score: ${signalSummary?.indicators?.momentumScore ?? 'N/A'}
- Blended score: ${signalSummary?.indicators?.blendedScore ?? 'N/A'}
- Setup grade: ${signalSummary?.indicators?.grade ?? 'N/A'}

Momentum filter details:
${filters.map((f) => `- ${f.reason} (score: ${f.score})`).join('\n')}

Recent candle data (last entry is the live forming candle):
${JSON.stringify(candleSummary, null, 2)}

Return STRICT JSON ONLY:
{
  "direction": "UP" | "DOWN" | "HOLD",
  "final_verdict": "TRADE_ALLOWED" | "WAIT" | "NO_TRADE" | "TRADE_REJECTED",
  "market_regime": "TRENDING" | "RANGING" | "VOLATILE_NEWS" | "UNCLEAR",
  "setup_score": 0-100,
  "confidence": 0-95,
  "reasoning": "Concise professional rationale: regime, higher-TF direction, lower-TF confirmation, whether the close is likely above/below entry within ${expiry}, and why. Be honest — never claim a guaranteed win. If it is not a clean setup, say HOLD and explain what you are waiting for."
}`;
}
