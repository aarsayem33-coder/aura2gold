import {
  calculateADX,
  calculateMACD,
  convertToHeikinAshi,
} from './aiSignalsIndicators.js';

const BUY_DECISIONS = new Set(['BUY', 'STRONG_BUY']);
const SELL_DECISIONS = new Set(['SELL', 'STRONG_SELL']);

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeDecision(decision) {
  return String(decision || '').toUpperCase();
}

function normalizeTrigger(trigger) {
  return String(trigger || 'LIMIT_PULLBACK').toUpperCase().replace(/\s+/g, '_');
}

function directionFromDecision(decision) {
  const normalized = normalizeDecision(decision);
  if (BUY_DECISIONS.has(normalized)) return 'BUY';
  if (SELL_DECISIONS.has(normalized)) return 'SELL';
  return 'HOLD';
}

function latestClosed(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  return candles.length >= 2 ? candles[candles.length - 2] : candles[candles.length - 1];
}

function getCurrentPrice({ currentPrice, entryCandles }) {
  const direct = asNumber(currentPrice);
  if (direct !== null) return direct;
  const latest = Array.isArray(entryCandles) ? entryCandles[entryCandles.length - 1] : null;
  return asNumber(latest?.close);
}

function priceTouched({ direction, trigger, currentPrice, entryPrice, tolerance, entryCandles = [] }) {
  if (currentPrice === null || entryPrice === null) return false;
  const band = Math.max(asNumber(tolerance) || 0, 0);
  if (trigger === 'BREAKOUT_CONFIRMATION') {
    return direction === 'BUY'
      ? currentPrice >= entryPrice + band
      : currentPrice <= entryPrice - band;
  }
  const recentCandles = Array.isArray(entryCandles) ? entryCandles.slice(-3) : [];
  if (recentCandles.length) {
    return recentCandles.some((candle) => {
      const high = asNumber(candle.high);
      const low = asNumber(candle.low);
      if (direction === 'BUY') return low !== null && low <= entryPrice + band;
      return high !== null && high >= entryPrice - band;
    });
  }
  return direction === 'BUY'
    ? currentPrice <= entryPrice + band
    : currentPrice >= entryPrice - band;
}

function macdImproving(candles, direction) {
  if (!Array.isArray(candles) || candles.length < 35) return { ok: false, reason: 'insufficient MACD candles' };
  const current = calculateMACD(candles);
  const previous = calculateMACD(candles.slice(0, -1));
  if (!current || !previous) return { ok: false, reason: 'MACD unavailable' };
  const currentHist = asNumber(current.histogram);
  const previousHist = asNumber(previous.histogram);
  if (currentHist === null || previousHist === null) return { ok: false, reason: 'MACD histogram unavailable' };
  const ok = direction === 'BUY'
    ? currentHist > previousHist || current.crossover === 'bullish_confirmed'
    : currentHist < previousHist || current.crossover === 'bearish_confirmed';
  return {
    ok,
    reason: ok
      ? `MACD histogram ${direction === 'BUY' ? 'improving' : 'weakening'} (${previousHist.toFixed(6)} -> ${currentHist.toFixed(6)})`
      : `MACD not confirming (${previousHist.toFixed(6)} -> ${currentHist.toFixed(6)})`,
    current,
    previous,
  };
}

function heikinAshiConfirming(candles, direction) {
  if (!Array.isArray(candles) || candles.length < 3) return { ok: false, reason: 'insufficient Heikin-Ashi candles' };
  const ha = convertToHeikinAshi(candles);
  const closed = latestClosed(ha);
  if (!closed) return { ok: false, reason: 'Heikin-Ashi unavailable' };
  const green = Number(closed.close) > Number(closed.open);
  const ok = direction === 'BUY' ? green : !green;
  return {
    ok,
    reason: ok
      ? `last closed Heikin-Ashi candle is ${green ? 'green' : 'red'}`
      : `last closed Heikin-Ashi candle is ${green ? 'green' : 'red'}, not ${direction === 'BUY' ? 'green' : 'red'}`,
    candle: closed,
  };
}

function adxConfirming(candles, direction) {
  if (!Array.isArray(candles) || candles.length < 40) return { ok: false, reason: 'insufficient ADX candles' };
  const adx = calculateADX(candles);
  if (!adx) return { ok: false, reason: 'ADX unavailable' };
  const strong = Number(adx.adx) >= 25;
  const directional = direction === 'BUY'
    ? Number(adx.diPlus) > Number(adx.diMinus)
    : Number(adx.diMinus) > Number(adx.diPlus);
  return {
    ok: strong && directional,
    reason: strong && directional
      ? `ADX confirms ${direction} trend (${adx.adx.toFixed(1)})`
      : `ADX not confirming (${Number(adx.adx || 0).toFixed(1)}, DI+ ${Number(adx.diPlus || 0).toFixed(1)}, DI- ${Number(adx.diMinus || 0).toFixed(1)})`,
    adx,
  };
}

function stopInvalidated({ direction, currentPrice, stopLoss, invalidationPrice, entryCandles = [] }) {
  if (currentPrice === null) return false;
  const levels = [asNumber(stopLoss), asNumber(invalidationPrice)].filter((v) => v !== null);
  if (!levels.length) return false;
  const recentCandles = Array.isArray(entryCandles) ? entryCandles.slice(-3) : [];
  if (recentCandles.length) {
    return levels.some((level) => recentCandles.some((candle) => {
      const high = asNumber(candle.high);
      const low = asNumber(candle.low);
      if (direction === 'BUY') return low !== null && low <= level;
      return high !== null && high >= level;
    }));
  }
  return levels.some((level) => direction === 'BUY' ? currentPrice <= level : currentPrice >= level);
}

export function extractInvalidationPrice(text) {
  if (!text || typeof text !== 'string') return null;
  const matches = text.match(/\d+(?:\.\d+)?/g);
  if (!matches?.length) return null;
  const numbers = matches.map(Number).filter(Number.isFinite);
  if (!numbers.length) return null;
  return numbers.find((n) => n > 0) ?? null;
}

export function evaluateTrackedProjection({ projection, currentPrice, entryCandles = [], trendCandles = [], nowMs = Date.now() }) {
  const decision = normalizeDecision(projection?.decision);
  const direction = directionFromDecision(decision);
  const trigger = normalizeTrigger(projection?.trade_trigger || projection?.tradeTrigger);
  const entryPrice = asNumber(projection?.entry_price ?? projection?.entryPrice);
  const stopLoss = asNumber(projection?.stop_loss ?? projection?.stopLoss);
  const invalidationPrice = asNumber(projection?.invalidation_price ?? projection?.invalidationPrice)
    ?? extractInvalidationPrice(projection?.invalidation);
  const price = getCurrentPrice({ currentPrice, entryCandles });
  const expiresAtMs = Date.parse(projection?.expires_at || projection?.expiresAt || '');
  const checks = [];

  if (Number.isFinite(expiresAtMs) && nowMs >= expiresAtMs) {
    return { status: 'EXPIRED', currentPrice: price, reason: 'tracking window expired', checks };
  }

  if (direction === 'HOLD' || entryPrice === null) {
    return { status: 'PENDING', currentPrice: price, reason: 'non-actionable decision or missing entry price', checks };
  }

  if (stopInvalidated({ direction, currentPrice: price, stopLoss, invalidationPrice, entryCandles })) {
    return { status: 'INVALIDATED', currentPrice: price, reason: 'stop-loss or invalidation level crossed', checks };
  }

  const tolerance = asNumber(projection?.tolerance) || 0;
  const touched = priceTouched({ direction, trigger, currentPrice: price, entryPrice, tolerance, entryCandles });
  checks.push({ name: 'price_touch', ok: touched, reason: touched ? 'entry condition touched' : 'waiting for entry price' });
  if (!touched) {
    return { status: 'PENDING', currentPrice: price, reason: 'waiting for entry price', checks };
  }

  const mode = String(projection?.trade_mode || projection?.tradeMode || '').toUpperCase();
  const indicatorChecks = [];
  if (trigger === 'BREAKOUT_CONFIRMATION') {
    indicatorChecks.push(adxConfirming(trendCandles.length ? trendCandles : entryCandles, direction));
  } else if (mode === 'FTT') {
    indicatorChecks.push(heikinAshiConfirming(entryCandles, direction));
    indicatorChecks.push(macdImproving(entryCandles, direction));
  } else {
    indicatorChecks.push(macdImproving(entryCandles, direction));
  }

  for (const check of indicatorChecks) {
    checks.push({ name: 'indicator_confirmation', ok: check.ok, reason: check.reason, details: check.adx || check.current || check.candle || null });
  }

  if (indicatorChecks.every((check) => check.ok)) {
    return { status: 'TRIGGERED', currentPrice: price, reason: 'entry touched and local indicators confirmed', checks };
  }

  return { status: 'PENDING', currentPrice: price, reason: 'entry touched; waiting for indicator confirmation', checks };
}
