import { assessNewsRisk } from './economicCalendar.js';
import { calculateADX } from './aiSignalsIndicators.js';
import { detectSecondDrive } from './liquidityEngine.js';

function normalizeIndicatorKey(name) {
  return String(name || '').trim().toUpperCase();
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function envNumber(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const number = Number(process.env[name]);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

/** Map an MT5 timeframe label to its bar length in milliseconds. */
function timeframeToMs(tf) {
  const t = String(tf || 'M5').trim().toUpperCase();
  const map = {
    M1: 60000, M2: 120000, M3: 180000, M5: 300000, M10: 600000, M15: 900000,
    M30: 1800000, H1: 3600000, H4: 14400000, D1: 86400000, W1: 604800000,
  };
  return map[t] || 300000;
}

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high = Number(candles[i].high);
    const low = Number(candles[i].low);
    const prevClose = Number(candles[i - 1].close);
    if (isNaN(high) || isNaN(low) || isNaN(prevClose)) continue;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }
  if (trs.length < period) return null;
  let atr = trs.slice(0, period).reduce((sum, val) => sum + val, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

function calculateEMA(candles, period) {
  if (candles.length < period) return null;
  const k = 2 / (period + 1);
  let ema = candles.slice(0, period).reduce((sum, c) => sum + Number(c.close), 0) / period;
  for (let i = period; i < candles.length; i++) {
    ema = Number(candles[i].close) * k + ema * (1 - k);
  }
  return ema;
}

function calculateRSI(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = Number(candles[i].close) - Number(candles[i - 1].close);
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  
  for (let i = period + 1; i < candles.length; i++) {
    const diff = Number(candles[i].close) - Number(candles[i - 1].close);
    if (diff > 0) {
      avgGain = (avgGain * (period - 1) + diff) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) - diff) / period;
    }
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateMACDVal(candles, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (candles.length < slowPeriod) return null;
  const fastEmaList = [];
  const slowEmaList = [];
  let fastEma = Number(candles[0].close);
  let slowEma = Number(candles[0].close);
  const kFast = 2 / (fastPeriod + 1);
  const kSlow = 2 / (slowPeriod + 1);
  
  for (let i = 0; i < candles.length; i++) {
    fastEma = Number(candles[i].close) * kFast + fastEma * (1 - kFast);
    slowEma = Number(candles[i].close) * kSlow + slowEma * (1 - kSlow);
    fastEmaList.push(fastEma);
    slowEmaList.push(slowEma);
  }
  
  const macdLine = [];
  for (let i = 0; i < candles.length; i++) {
    macdLine.push(fastEmaList[i] - slowEmaList[i]);
  }
  
  let signalLine = macdLine[0];
  const kSignal = 2 / (signalPeriod + 1);
  for (let i = 0; i < macdLine.length; i++) {
    signalLine = macdLine[i] * kSignal + signalLine * (1 - kSignal);
  }
  
  const latestMacd = macdLine[macdLine.length - 1];
  const latestSignal = signalLine;
  return {
    main: latestMacd,
    signal: latestSignal,
    histogram: latestMacd - latestSignal
  };
}

function calculateBollingerBandsVal(candles, period = 20, stdDevMultiplier = 2) {
  if (candles.length < period) return null;
  const slice = candles.slice(-period);
  const closes = slice.map(c => Number(c.close));
  const middle = closes.reduce((sum, c) => sum + c, 0) / period;
  const variance = closes.reduce((sum, c) => sum + Math.pow(c - middle, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  return {
    middle,
    upper: middle + stdDevMultiplier * stdDev,
    lower: middle - stdDevMultiplier * stdDev
  };
}

function calculateStochasticVal(candles, period = 14, smoothK = 3) {
  if (candles.length < period) return null;
  const kValues = [];
  for (let i = period - 1; i < candles.length; i++) {
    const subset = candles.slice(i - period + 1, i + 1);
    const highs = subset.map(c => Number(c.high));
    const lows = subset.map(c => Number(c.low));
    const highestHigh = Math.max(...highs);
    const lowestLow = Math.min(...lows);
    const currentClose = Number(subset[subset.length - 1].close);
    const k = highestHigh === lowestLow ? 50 : ((currentClose - lowestLow) / (highestHigh - lowestLow)) * 100;
    kValues.push(k);
  }
  if (kValues.length < smoothK) return null;
  const smoothedK = [];
  for (let i = smoothK - 1; i < kValues.length; i++) {
    const window = kValues.slice(i - smoothK + 1, i + 1);
    smoothedK.push(window.reduce((sum, v) => sum + v, 0) / smoothK);
  }
  const percentK = smoothedK[smoothedK.length - 1];
  const percentD = smoothedK.length >= smoothK
    ? smoothedK.slice(-smoothK).reduce((sum, v) => sum + v, 0) / smoothK
    : percentK;
  return {
    k: percentK,
    d: percentD
  };
}

function detectFVGs(candles) {
  const fvgs = [];
  if (candles.length < 3) return fvgs;
  for (let i = 2; i < candles.length; i++) {
    const c1 = candles[i];
    const c2 = candles[i - 1];
    const c3 = candles[i - 2];
    const h3 = Number(c3.high);
    const l1 = Number(c1.low);
    if (!isNaN(h3) && !isNaN(l1) && l1 > h3 && Number(c2.close) > Number(c2.open)) {
      fvgs.push({
        type: 'BULLISH',
        top: l1,
        bottom: h3,
        midpoint: (l1 + h3) / 2,
        time: c2.time,
      });
    }
    const l3 = Number(c3.low);
    const h1 = Number(c1.high);
    if (!isNaN(l3) && !isNaN(h1) && h1 < l3 && Number(c2.close) < Number(c2.open)) {
      fvgs.push({
        type: 'BEARISH',
        top: l3,
        bottom: h1,
        midpoint: (l3 + h1) / 2,
        time: c2.time,
      });
    }
  }
  return fvgs;
}

function detectOrderBlocks(candles) {
  const obs = [];
  if (candles.length < 10) return obs;
  for (let i = 3; i < candles.length - 2; i++) {
    const c = candles[i];
    const h = Number(c.high);
    const l = Number(c.low);
    if (isNaN(h) || isNaN(l)) continue;
    const isSwingHigh = h > Number(candles[i-1].high) && h > Number(candles[i-2].high) &&
                        h > Number(candles[i+1].high) && h > Number(candles[i+2].high);
    const isSwingLow = l < Number(candles[i-1].low) && l < Number(candles[i-2].low) &&
                       l < Number(candles[i+1].low) && l < Number(candles[i+2].low);
    if (isSwingHigh) {
      for (let j = i + 1; j < candles.length; j++) {
        if (Number(candles[j].close) > h) {
          let lowestBearish = null;
          let minLow = Infinity;
          for (let k = i; k < j; k++) {
            const ck = candles[k];
            if (Number(ck.close) < Number(ck.open) && Number(ck.low) < minLow) {
              minLow = Number(ck.low);
              lowestBearish = ck;
            }
          }
          if (lowestBearish) {
            obs.push({
              type: 'BULLISH',
              top: Math.max(Number(lowestBearish.open), Number(lowestBearish.close)),
              bottom: Number(lowestBearish.low),
              time: lowestBearish.time,
            });
          }
          break;
        }
      }
    }
    if (isSwingLow) {
      for (let j = i + 1; j < candles.length; j++) {
        if (Number(candles[j].close) < l) {
          let highestBullish = null;
          let maxHigh = -Infinity;
          for (let k = i; k < j; k++) {
            const ck = candles[k];
            if (Number(ck.close) > Number(ck.open) && Number(ck.high) > maxHigh) {
              maxHigh = Number(ck.high);
              highestBullish = ck;
            }
          }
          if (highestBullish) {
            obs.push({
              type: 'BEARISH',
              top: Number(highestBullish.high),
              bottom: Math.min(Number(highestBullish.open), Number(highestBullish.close)),
              time: highestBullish.time,
            });
          }
          break;
        }
      }
    }
  }
  return obs;
}

function detectMarketStructure(candles) {
  const swingHighs = [];
  const swingLows = [];
  if (candles.length < 15) return { bosBullish: false, bosBearish: false };

  for (let i = 2; i < candles.length - 2; i++) {
    const h = Number(candles[i].high);
    const l = Number(candles[i].low);
    if (isNaN(h) || isNaN(l)) continue;
    
    const isSwingHigh = h > Number(candles[i-1].high) && h > Number(candles[i-2].high) &&
                        h > Number(candles[i+1].high) && h > Number(candles[i+2].high);
    const isSwingLow = l < Number(candles[i-1].low) && l < Number(candles[i-2].low) &&
                       l < Number(candles[i+1].low) && l < Number(candles[i+2].low);
    
    if (isSwingHigh) swingHighs.push({ price: h, time: candles[i].time });
    if (isSwingLow) swingLows.push({ price: l, time: candles[i].time });
  }

  if (swingHighs.length === 0 || swingLows.length === 0) {
    return { bosBullish: false, bosBearish: false, lastSwingHigh: 0, lastSwingLow: 0 };
  }

  const lastSwingHigh = swingHighs[swingHighs.length - 1].price;
  const lastSwingLow = swingLows[swingLows.length - 1].price;
  const latestClose = Number(candles[candles.length - 1].close);

  const bosBullish = latestClose > lastSwingHigh;
  const bosBearish = latestClose < lastSwingLow;

  return { bosBullish, bosBearish, lastSwingHigh, lastSwingLow };
}

function detectLiquiditySweeps(candles) {
  if (candles.length < 15) return { sweepBullish: false, sweepBearish: false };
  
  const lastCandle = candles[candles.length - 1];
  const low = Number(lastCandle.low);
  const high = Number(lastCandle.high);
  const close = Number(lastCandle.close);
  
  const prevCandles = candles.slice(0, -1);
  const lows = prevCandles.map(c => Number(c.low)).filter(v => !isNaN(v));
  const highs = prevCandles.map(c => Number(c.high)).filter(v => !isNaN(v));
  
  const lowestPrev = Math.min(...lows);
  const highestPrev = Math.max(...highs);
  
  const sweepBullish = low < lowestPrev && close > lowestPrev;
  const sweepBearish = high > highestPrev && close < highestPrev;
  
  return { sweepBullish, sweepBearish };
}

function detectSupportResistance(candles, atr) {
  const swingHighs = [];
  const swingLows = [];
  if (candles.length < 15) return { support: [], resistance: [] };

  const atrVal = atr || 1.0;
  
  for (let i = 2; i < candles.length - 2; i++) {
    const h = Number(candles[i].high);
    const l = Number(candles[i].low);
    if (isNaN(h) || isNaN(l)) continue;
    
    const isSwingHigh = h > Number(candles[i-1].high) && h > Number(candles[i-2].high) &&
                        h > Number(candles[i+1].high) && h > Number(candles[i+2].high);
    const isSwingLow = l < Number(candles[i-1].low) && l < Number(candles[i-2].low) &&
                       l < Number(candles[i+1].low) && l < Number(candles[i+2].low);
    
    if (isSwingHigh) swingHighs.push(h);
    if (isSwingLow) swingLows.push(l);
  }

  const currentPrice = Number(candles[candles.length - 1].close);

  const groupLevels = (prices) => {
    const zones = [];
    const threshold = 0.35 * atrVal;
    
    for (const price of prices) {
      let foundGroup = false;
      for (const zone of zones) {
        if (Math.abs(zone.level - price) <= threshold) {
          zone.count++;
          zone.level = (zone.level * (zone.count - 1) + price) / zone.count;
          foundGroup = true;
          break;
        }
      }
      if (!foundGroup) {
        zones.push({ level: price, count: 1 });
      }
    }
    return zones;
  };

  const resistanceZones = groupLevels(swingHighs)
    .filter(z => z.level > currentPrice)
    .sort((a, b) => a.level - b.level); // Closest resistance first

  const supportZones = groupLevels(swingLows)
    .filter(z => z.level < currentPrice)
    .sort((a, b) => b.level - a.level); // Closest support first

  return {
    support: supportZones.slice(0, 3).map(z => ({ level: Number(z.level.toFixed(5)), strength: z.count })),
    resistance: resistanceZones.slice(0, 3).map(z => ({ level: Number(z.level.toFixed(5)), strength: z.count }))
  };
}

const SESSION_WINDOWS = {
  USD: { timezone: 'America/New_York', start: '12:30', end: '14:30', label: 'New York stop-hunt window' },
  XAU: { timezone: 'America/New_York', start: '12:30', end: '14:30', label: 'New York gold/USD stop-hunt window' },
  CAD: { timezone: 'America/New_York', start: '12:30', end: '14:30', label: 'New York CAD stop-hunt window' },
  EUR: { timezone: 'Europe/London', start: '07:00', end: '10:00', label: 'London EUR stop-hunt window' },
  GBP: { timezone: 'Europe/London', start: '07:00', end: '10:00', label: 'London GBP stop-hunt window' },
  CHF: { timezone: 'Europe/London', start: '07:00', end: '10:00', label: 'London CHF stop-hunt window' },
  JPY: { timezone: 'Asia/Tokyo', start: '08:00', end: '10:30', label: 'Tokyo JPY stop-hunt window' },
  AUD: { timezone: 'Australia/Sydney', start: '08:00', end: '10:30', label: 'Sydney AUD stop-hunt window' },
  NZD: { timezone: 'Pacific/Auckland', start: '08:00', end: '10:30', label: 'Auckland NZD stop-hunt window' },
  CNY: { timezone: 'Asia/Shanghai', start: '09:00', end: '11:00', label: 'Shanghai CNY stop-hunt window' },
  CNH: { timezone: 'Asia/Shanghai', start: '09:00', end: '11:00', label: 'Shanghai CNH stop-hunt window' },
};

const FX_CODES = ['XAU', 'XAG', 'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF', 'CNH', 'CNY'];

function symbolCurrencies(symbol) {
  const clean = String(symbol || '').toUpperCase().replace(/[^A-Z]/g, '');
  const base = FX_CODES.find((code) => clean.startsWith(code));
  if (!base) return [];
  const quote = FX_CODES.find((code) => clean.slice(base.length).startsWith(code));
  return quote ? [base, quote] : [base];
}

function localMinutes(timezone, date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    return Number.isFinite(hour) && Number.isFinite(minute) ? (hour * 60 + minute) : null;
  } catch {
    return null;
  }
}

function hhmmToMinutes(value) {
  const [h, m] = String(value || '00:00').split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

function getTradingSessionContext(symbol, now = new Date()) {
  const currencies = symbolCurrencies(symbol);
  const windows = currencies
    .map((currency) => ({ currency, ...SESSION_WINDOWS[currency] }))
    .filter((item) => item.timezone);
  const active = [];
  for (const window of windows) {
    const mins = localMinutes(window.timezone, now);
    if (mins === null) continue;
    const start = hhmmToMinutes(window.start);
    const end = hhmmToMinutes(window.end);
    const inWindow = start <= end ? mins >= start && mins <= end : mins >= start || mins <= end;
    if (inWindow) active.push(window);
  }
  return {
    currencies,
    windows: windows.map((w) => ({ currency: w.currency, timezone: w.timezone, start: w.start, end: w.end, label: w.label })),
    active: active.map((w) => ({ currency: w.currency, timezone: w.timezone, start: w.start, end: w.end, label: w.label })),
    activeStopHuntWindow: active.length > 0,
    reason: active.length ? active.map((w) => `${w.currency} ${w.label}`).join(', ') : 'No mapped stop-hunt window active',
  };
}

function detectCandlestickPatterns(candles, atr = null, levels = []) {
  const out = [];
  if (!candles || candles.length < 2) return out;
  const data = candles.slice(-6).map((c) => ({
    ...c,
    open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close),
  })).filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite));
  if (data.length < 2) return out;
  const c = data[data.length - 1];
  const p = data[data.length - 2];
  const range = c.high - c.low;
  if (range <= 0) return out;
  const body = Math.abs(c.close - c.open);
  const bodyRatio = body / range;
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const curBull = c.close > c.open;
  const curBear = c.close < c.open;
  const prevBull = p.close > p.open;
  const prevBear = p.close < p.open;
  const prevBody = Math.abs(p.close - p.open);

  if (curBull && prevBear && c.close >= p.open && c.open <= p.close && body > prevBody) out.push({ name: 'Bullish Engulfing', direction: 'bullish', strength: 0.9, reason: 'Current candle fully engulfed prior bearish body' });
  if (curBear && prevBull && c.open >= p.close && c.close <= p.open && body > prevBody) out.push({ name: 'Bearish Engulfing', direction: 'bearish', strength: 0.9, reason: 'Current candle fully engulfed prior bullish body' });
  if (bodyRatio <= 0.1) out.push({ name: 'Doji', direction: 'neutral', strength: 0.2, reason: 'Indecision candle; avoid weak entries' });
  if (bodyRatio <= 0.35 && lowerWick >= body * 2 && upperWick <= Math.max(body, range * 0.15)) out.push({ name: 'Bullish Pinbar', direction: 'bullish', strength: 0.75, reason: 'Long lower wick shows downside rejection' });
  if (bodyRatio <= 0.35 && upperWick >= body * 2 && lowerWick <= Math.max(body, range * 0.15)) out.push({ name: 'Bearish Pinbar', direction: 'bearish', strength: 0.75, reason: 'Long upper wick shows upside rejection' });
  if (bodyRatio >= 0.65) out.push({ name: curBull ? 'Bullish Breakout Candle' : 'Bearish Breakout Candle', direction: curBull ? 'bullish' : 'bearish', strength: 0.7, reason: `Large body candle (${Math.round(bodyRatio * 100)}%) shows momentum` });

  if (data.length >= 3) {
    const a = data[data.length - 3];
    const b = data[data.length - 2];
    const bRange = b.high - b.low;
    const bSmall = bRange > 0 && Math.abs(b.close - b.open) / bRange < 0.35;
    if (a.close < a.open && bSmall && curBull && c.close > (a.open + a.close) / 2) out.push({ name: 'Morning Star', direction: 'bullish', strength: 0.85, reason: 'Three-candle bullish reversal pattern' });
    if (a.close > a.open && bSmall && curBear && c.close < (a.open + a.close) / 2) out.push({ name: 'Evening Star', direction: 'bearish', strength: 0.85, reason: 'Three-candle bearish reversal pattern' });
    const threeBull = data.slice(-3).every((x) => x.close > x.open) && data[data.length - 1].close > data[data.length - 2].close && data[data.length - 2].close > data[data.length - 3].close;
    const threeBear = data.slice(-3).every((x) => x.close < x.open) && data[data.length - 1].close < data[data.length - 2].close && data[data.length - 2].close < data[data.length - 3].close;
    if (threeBull) out.push({ name: '3-Bar Continuation', direction: 'bullish', strength: 0.65, reason: 'Three consecutive bullish continuation candles' });
    if (threeBear) out.push({ name: '3-Bar Continuation', direction: 'bearish', strength: 0.65, reason: 'Three consecutive bearish continuation candles' });
  }

  // ── Context qualification (ATR-relative size + location) ──
  // The same shape is not equally tradable everywhere. A pattern is stronger
  // when (a) its candle is large enough to matter versus current volatility,
  // and (b) it forms at a structural level (support/resistance/zone). Adjust
  // each directional pattern's strength so the downstream DAT-trigger gate
  // (strength >= 0.65) reflects context, not just shape — a tiny mid-range
  // "breakout" drops below the gate, a pinbar rejecting a key level rises.
  const atrVal = Number.isFinite(atr) && atr > 0 ? atr : null;
  const levelList = (Array.isArray(levels) ? levels : []).map(Number).filter(Number.isFinite);
  const rangeAtr = atrVal ? range / atrVal : null;
  const nearestLevelAtr = (price) => {
    if (!atrVal || !levelList.length || !Number.isFinite(price)) return null;
    let best = Infinity;
    for (const lvl of levelList) best = Math.min(best, Math.abs(price - lvl));
    return best / atrVal; // distance to closest level, measured in ATRs
  };
  for (const pat of out) {
    pat.rangeAtr = rangeAtr !== null ? Number(rangeAtr.toFixed(2)) : null;
    if (pat.direction === 'neutral') continue; // leave Doji/indecision untouched
    let mult = 1;
    const notes = [];
    // (a) ATR-relative size — penalise insignificant candles, reward expansion.
    if (rangeAtr !== null) {
      if (rangeAtr < 0.5) { mult *= 0.6; notes.push(`small ${rangeAtr.toFixed(2)}xATR`); }
      else if (rangeAtr < 0.8) { mult *= 0.85; notes.push(`below-avg ${rangeAtr.toFixed(2)}xATR`); }
      else if (rangeAtr >= 1.2) { mult *= 1.1; notes.push(`expansion ${rangeAtr.toFixed(2)}xATR`); }
    }
    // (b) location — test the pattern's rejection edge against key levels.
    const edge = pat.direction === 'bullish' ? c.low : c.high;
    const distAtr = nearestLevelAtr(edge);
    pat.levelDistAtr = distAtr !== null ? Number(distAtr.toFixed(2)) : null;
    if (distAtr !== null) {
      if (distAtr <= 0.5) { mult *= 1.15; notes.push(`at level ${distAtr.toFixed(2)}xATR`); }
      else if (distAtr > 1.5) { mult *= 0.85; notes.push(`no level ${distAtr.toFixed(2)}xATR`); }
    }
    if (mult !== 1) {
      pat.strength = Math.max(0, Math.min(0.98, pat.strength * mult));
      pat.reason += ` [${notes.join(', ')}]`;
    }
  }
  return out;
}

/**
 * Deterministic, pure feature snapshot for a signal. Computed once inside
 * aggregateSignals and attached to systemDecision.features so the live report
 * path and the historical replay read IDENTICAL features (no calibration-bucket
 * drift between live and backtest). Candle-derived metrics are computed here;
 * higher-context values needing data beyond the single candle array (ADX, HTF
 * bias, ADR usage) are injected by the caller. No I/O, no input mutation.
 */
function extractFeatures(candles, context = {}) {
  const { adxValue = null, htfBias = null, adrUsagePercent = null } = context;
  const data = (candles || [])
    .map((c) => ({
      open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close),
      volume: c.volume === null || c.volume === undefined ? null : Number(c.volume),
      spread: c.spread === null || c.spread === undefined ? null : Number(c.spread),
    }))
    .filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite));
  if (!data.length) return { valid: false };

  const last = data[data.length - 1];
  const range = last.high - last.low;
  const body = Math.abs(last.close - last.open);
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const pct = (n) => range > 0 ? Math.round((n / range) * 1000) / 10 : 0;
  const maxWick = Math.max(upperWick, lowerWick);

  const atr = calculateATR(data, 14);
  const ema = calculateEMA(data, 21);

  let volumeRatio = null;
  const vols = data.slice(-21, -1).map((c) => c.volume).filter((v) => Number.isFinite(v) && v >= 0);
  if (Number.isFinite(last.volume) && vols.length >= 5) {
    const avg = vols.reduce((s, v) => s + v, 0) / vols.length;
    if (avg > 0) volumeRatio = Math.round((last.volume / avg) * 100) / 100;
  }

  return {
    valid: true,
    bodyPct: pct(body),                 // % of candle range occupied by the body
    upperWickPct: pct(upperWick),
    lowerWickPct: pct(lowerWick),
    wickToBody: body > 0 ? Math.round((maxWick / body) * 100) / 100 : null,            // dominant wick / body
    closePosition: range > 0 ? Math.round(((last.close - last.low) / range) * 100) / 100 : 0.5, // 0=closed on low, 1=on high
    rangeVsAtr: atr && atr > 0 ? Math.round((range / atr) * 100) / 100 : null,
    atr: atr ? Math.round(atr * 1e6) / 1e6 : null,
    volumeRatio,                        // current volume vs trailing-20 average
    spread: Number.isFinite(last.spread) ? last.spread : null,
    emaDistanceAtr: (ema !== null && atr && atr > 0) ? Math.round(((last.close - ema) / atr) * 100) / 100 : null, // signed ATR units from EMA21
    adxValue: Number.isFinite(adxValue) ? Math.round(adxValue * 10) / 10 : null,
    htfBias: htfBias || null,
    adrUsagePercent: Number.isFinite(adrUsagePercent) ? Math.round(adrUsagePercent * 10) / 10 : null,
  };
}

function detectOteZone(candles) {
  const recent = (candles || []).slice(-80).map((c) => ({ time: c.time, high: Number(c.high), low: Number(c.low), close: Number(c.close) })).filter((c) => [c.high, c.low, c.close].every(Number.isFinite));
  if (recent.length < 20) return { active: false, direction: 'neutral', zone: null, reason: 'Not enough candles for OTE' };
  let lowIdx = 0;
  let highIdx = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].low < recent[lowIdx].low) lowIdx = i;
    if (recent[i].high > recent[highIdx].high) highIdx = i;
  }
  const current = recent[recent.length - 1].close;
  if (lowIdx < highIdx) {
    const low = recent[lowIdx].low;
    const high = recent[highIdx].high;
    const range = high - low;
    if (range <= 0) return { active: false, direction: 'neutral', zone: null, reason: 'Invalid OTE range' };
    const zoneHigh = high - range * 0.5;
    const zoneLow = high - range * 0.786;
    return { active: current >= zoneLow && current <= zoneHigh, direction: 'bullish', zone: { low: zoneLow, high: zoneHigh, swingLow: low, swingHigh: high }, reason: 'Bullish OTE 50%-78.6% retracement after impulse' };
  }
  if (highIdx < lowIdx) {
    const high = recent[highIdx].high;
    const low = recent[lowIdx].low;
    const range = high - low;
    if (range <= 0) return { active: false, direction: 'neutral', zone: null, reason: 'Invalid OTE range' };
    const zoneLow = low + range * 0.5;
    const zoneHigh = low + range * 0.786;
    return { active: current >= zoneLow && current <= zoneHigh, direction: 'bearish', zone: { low: zoneLow, high: zoneHigh, swingLow: low, swingHigh: high }, reason: 'Bearish OTE 50%-78.6% retracement after impulse' };
  }
  return { active: false, direction: 'neutral', zone: null, reason: 'No clear impulse for OTE' };
}

function detectBpr(fvgs, close) {
  const bullish = (fvgs || []).filter((f) => f.type === 'BULLISH').slice(-5);
  const bearish = (fvgs || []).filter((f) => f.type === 'BEARISH').slice(-5);
  for (const b of bullish) {
    for (const s of bearish) {
      const low = Math.max(Number(b.bottom), Number(s.bottom));
      const high = Math.min(Number(b.top), Number(s.top));
      if (Number.isFinite(low) && Number.isFinite(high) && low < high) {
        return { active: close >= low && close <= high, zone: { low, high }, reason: 'Bullish and bearish FVG overlap creates Balanced Price Range' };
      }
    }
  }
  return { active: false, zone: null, reason: 'No active BPR overlap' };
}

function detectAmdPhase(candles, atrVal, struct, sweep, sessionContext) {
  const recent = (candles || []).slice(-24).map((c) => ({ high: Number(c.high), low: Number(c.low), close: Number(c.close) })).filter((c) => [c.high, c.low, c.close].every(Number.isFinite));
  if (recent.length < 12) return { phase: 'UNKNOWN', direction: 'neutral', active: false, reason: 'Not enough candles for AMD' };
  const rangeHigh = Math.max(...recent.slice(0, -1).map((c) => c.high));
  const rangeLow = Math.min(...recent.slice(0, -1).map((c) => c.low));
  const range = rangeHigh - rangeLow;
  const accumulation = atrVal > 0 && range <= atrVal * 3.5;
  if (!accumulation) return { phase: 'TRENDING', direction: 'neutral', active: false, range: { high: rangeHigh, low: rangeLow }, reason: 'No tight accumulation range' };
  if (sweep.sweepBullish || struct.bosBullish) return { phase: sweep.sweepBullish ? 'MANIPULATION_TO_DISTRIBUTION' : 'DISTRIBUTION', direction: 'bullish', active: sessionContext.activeStopHuntWindow, range: { high: rangeHigh, low: rangeLow }, reason: 'Accumulation followed by sell-side sweep / bullish structure shift' };
  if (sweep.sweepBearish || struct.bosBearish) return { phase: sweep.sweepBearish ? 'MANIPULATION_TO_DISTRIBUTION' : 'DISTRIBUTION', direction: 'bearish', active: sessionContext.activeStopHuntWindow, range: { high: rangeHigh, low: rangeLow }, reason: 'Accumulation followed by buy-side sweep / bearish structure shift' };
  return { phase: 'ACCUMULATION', direction: 'neutral', active: sessionContext.activeStopHuntWindow, range: { high: rangeHigh, low: rangeLow }, reason: 'Sideways accumulation detected; wait for manipulation sweep' };
}

function pipSizeForSymbol(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (s.includes('XAU') || s.includes('GOLD')) return 0.01;
  if (s.includes('JPY')) return 0.01;
  return 0.0001;
}

function estimatePipValuePerLot(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (s.includes('XAU') || s.includes('GOLD')) return 1;
  if (s.includes('JPY')) return 9;
  return 10;
}

function contractSizeForSymbol(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (s.includes('XAU') || s.includes('GOLD')) return 100;
  return 100000;
}

function moneyRound(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function isSessionActive() {
  const now = new Date();
  const day = now.getUTCDay();
  const hour = now.getUTCHours();

  // Forex market is closed from Friday 21:00 UTC to Sunday 21:00 UTC
  const isWeekend = 
    (day === 5 && hour >= 21) || // Friday after 21:00 UTC
    (day === 6) ||                // Saturday (all day)
    (day === 0 && hour < 21);    // Sunday before 21:00 UTC

  if (isWeekend) return false;

  const londonActive = hour >= 8 && hour < 16;
  const nyActive = hour >= 13 && hour < 21;
  return londonActive || nyActive;
}

function detectRsiDivergence(candles, indicators) {
  const rsiData = [];
  const priceData = [];
  
  for (let i = candles.length - 20; i < candles.length; i++) {
    if (i < 0) continue;
    const c = candles[i];
    const rsiEntry = indicators.find(ind => 
      normalizeIndicatorKey(ind.indicator || ind.name) === 'RSI' && 
      ind.candleTime === c.time
    );
    let rsiVal = rsiEntry ? toNumber(rsiEntry.value1 ?? rsiEntry.rsi ?? rsiEntry.value) : null;
    if (rsiVal === null && i >= 14) {
      const subset = candles.slice(0, i + 1);
      rsiVal = calculateRSI(subset, 14);
    }
    if (rsiVal !== null) {
      rsiData.push(rsiVal);
      priceData.push({ low: Number(c.low), high: Number(c.high), close: Number(c.close), time: c.time });
    }
  }

  if (rsiData.length < 8) return { divBullish: false, divBearish: false };

  const len = rsiData.length;
  const currentPrice = priceData[len - 1];
  const currentRsi = rsiData[len - 1];

  let divBullish = false;
  let divBearish = false;

  let prevLowestPriceIdx = -1;
  let prevLowestPrice = Infinity;
  for (let i = 0; i < len - 4; i++) {
    if (priceData[i].low < prevLowestPrice) {
      prevLowestPrice = priceData[i].low;
      prevLowestPriceIdx = i;
    }
  }

  if (prevLowestPriceIdx !== -1) {
    const prevLowestRsi = rsiData[prevLowestPriceIdx];
    if (currentPrice.low < prevLowestPrice && currentRsi > prevLowestRsi && currentRsi < 42) {
      divBullish = true;
    }
  }

  let prevHighestPriceIdx = -1;
  let prevHighestPrice = -Infinity;
  for (let i = 0; i < len - 4; i++) {
    if (priceData[i].high > prevHighestPrice) {
      prevHighestPrice = priceData[i].high;
      prevHighestPriceIdx = i;
    }
  }

  if (prevHighestPriceIdx !== -1) {
    const prevHighestRsi = rsiData[prevHighestPriceIdx];
    if (currentPrice.high > prevHighestPrice && currentRsi < prevHighestRsi && currentRsi > 58) {
      divBearish = true;
    }
  }

  return { divBullish, divBearish };
}

function getTimeframeTrend(candles) {
  if (!candles || candles.length < 5) return 'NEUTRAL';
  if (candles.length >= 50) {
    const ema20 = calculateEMA(candles, 20);
    const ema50 = calculateEMA(candles, 50);
    if (ema20 !== null && ema50 !== null) {
      return ema20 > ema50 ? 'BULLISH' : ema20 < ema50 ? 'BEARISH' : 'NEUTRAL';
    }
  }
  if (candles.length >= 15) {
    const ema5 = calculateEMA(candles, 5);
    const ema15 = calculateEMA(candles, 15);
    if (ema5 !== null && ema15 !== null) {
      return ema5 > ema15 ? 'BULLISH' : ema5 < ema15 ? 'BEARISH' : 'NEUTRAL';
    }
  }
  const close = Number(candles[candles.length - 1]?.close);
  const open = Number(candles[0]?.close);
  if (!isNaN(close) && !isNaN(open)) {
    return close > open ? 'BULLISH' : close < open ? 'BEARISH' : 'NEUTRAL';
  }
  return 'NEUTRAL';
}

function latestByIndicator(indicators) {
  const map = new Map();
  for (const indicator of indicators || []) {
    const key = normalizeIndicatorKey(indicator.indicator || indicator.name || indicator.type);
    if (!key) continue;
    const existing = map.get(key);
    const currentTime = Date.parse(indicator.candleTime || indicator.time || indicator.timestamp || indicator.receivedAt || 0) || 0;
    const existingTime = existing ? Date.parse(existing.candleTime || existing.time || existing.timestamp || existing.receivedAt || 0) || 0 : -1;
    if (!existing || currentTime >= existingTime) {
      map.set(key, indicator);
    }
  }
  return map;
}

function inferDecision(score) {
  if (score >= 0.6) return 'STRONG_BUY';
  if (score >= 0.3) return 'BUY';
  if (score <= -0.6) return 'STRONG_SELL';
  if (score <= -0.3) return 'SELL';
  return 'HOLD';
}

function pushSignal(list, name, direction, weight, strength, reason, metadata = {}) {
  list.push({ name, direction, weight, strength, reason, ...metadata });
}

function aggregateSignals({ 
  symbol, 
  timeframe, 
  candles = [], 
  indicators = [], 
  marketLevels = [], 
  accountSnapshot = null, 
  adr = null, 
  dailyHighLow = null,
  h4Candles = [],
  h1Candles = [],
  skipNews = false
}) {
  const latestIndicators = latestByIndicator(indicators);
  const latestCandles = [...candles]
    .filter((candle) => !symbol || candle.symbol === symbol)
    .filter((candle) => !timeframe || candle.timeframe === timeframe)
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const latestCandle = latestCandles[latestCandles.length - 1] || null;
  const recentCandles = latestCandles.slice(-20);
  const close = toNumber(latestCandle?.close);
  const open = toNumber(latestCandle?.open);
  const high = toNumber(latestCandle?.high);
  const low = toNumber(latestCandle?.low);
  const signals = [];
  let buyScore = 0;
  let sellScore = 0;
  const confluences = [];
  const sym = String(symbol || '').toUpperCase();
  const digits = (sym.includes('JPY') || sym.includes('XAU') || sym.includes('GOLD')) ? 3 : 5;

  // Preserve indicator calculations for Signal Grid UI
  let rsi = toNumber(latestIndicators.get('RSI')?.value1 ?? latestIndicators.get('RSI')?.rsi ?? latestIndicators.get('RSI')?.value);
  if (rsi === null && latestCandles.length >= 15) {
    rsi = calculateRSI(latestCandles, 14);
  }
  if (rsi !== null) {
    if (rsi <= 30) pushSignal(signals, 'RSI', 'buy', 1, 1, `Oversold RSI ${rsi.toFixed(1)}`, { value: rsi });
    else if (rsi >= 70) pushSignal(signals, 'RSI', 'sell', 1, -1, `Overbought RSI ${rsi.toFixed(1)}`, { value: rsi });
    else pushSignal(signals, 'RSI', 'neutral', 0.5, 0, `Neutral RSI ${rsi.toFixed(1)}`, { value: rsi });
  }

  let macdMain = null, macdSignal = null, macdHist = null;
  const macd = latestIndicators.get('MACD');
  if (macd) {
    macdMain = toNumber(macd.value1 ?? macd.main);
    macdSignal = toNumber(macd.value2 ?? macd.signal);
    macdHist = toNumber(macd.value3 ?? macd.histogram);
  } else if (latestCandles.length >= 26) {
    const calcMacd = calculateMACDVal(latestCandles);
    if (calcMacd) {
      macdMain = calcMacd.main;
      macdSignal = calcMacd.signal;
      macdHist = calcMacd.histogram;
    }
  }
  if (macdMain !== null && macdSignal !== null) {
    const bullish = macdMain > macdSignal;
    pushSignal(signals, 'MACD', bullish ? 'buy' : 'sell', 1.1, bullish ? 1 : -1, bullish ? 'MACD bullish crossover' : 'MACD bearish crossover', { main: macdMain, signal: macdSignal, hist: macdHist });
  }

  let bbMiddle = null, bbUpper = null, bbLower = null;
  const bb = latestIndicators.get('BOLLINGER') || latestIndicators.get('BB');
  if (bb) {
    bbMiddle = toNumber(bb.value1 ?? bb.middle);
    bbUpper = toNumber(bb.value2 ?? bb.upper);
    bbLower = toNumber(bb.value3 ?? bb.lower);
  } else if (latestCandles.length >= 20) {
    const calcBb = calculateBollingerBandsVal(latestCandles);
    if (calcBb) {
      bbMiddle = calcBb.middle;
      bbUpper = calcBb.upper;
      bbLower = calcBb.lower;
    }
  }
  if (bbUpper !== null && bbLower !== null && close !== null) {
    if (close >= bbUpper) pushSignal(signals, 'BOLLINGER', 'sell', 0.8, -0.9, 'Price at upper band', { upper: bbUpper, middle: bbMiddle, lower: bbLower });
    else if (close <= bbLower) pushSignal(signals, 'BOLLINGER', 'buy', 0.8, 0.9, 'Price at lower band', { upper: bbUpper, middle: bbMiddle, lower: bbLower });
    else pushSignal(signals, 'BOLLINGER', 'neutral', 0.4, 0, 'Price inside Bollinger channel', { upper: bbUpper, middle: bbMiddle, lower: bbLower });
  }

  let stochK = null, stochD = null;
  const stochastic = latestIndicators.get('STOCHASTIC') || latestIndicators.get('STOCH');
  if (stochastic) {
    stochK = toNumber(stochastic.value4 ?? stochastic.k ?? stochastic.value1);
    stochD = toNumber(stochastic.value5 ?? stochastic.d ?? stochastic.value2);
  } else if (latestCandles.length >= 17) {
    const calcStoch = calculateStochasticVal(latestCandles);
    if (calcStoch) {
      stochK = calcStoch.k;
      stochD = calcStoch.d;
    }
  }
  if (stochK !== null && stochD !== null) {
    const bullish = stochK > stochD && stochK < 30;
    const bearish = stochK < stochD && stochK > 70;
    if (bullish) pushSignal(signals, 'STOCHASTIC', 'buy', 0.9, 0.8, 'Stochastic oversold crossover', { k: stochK, d: stochD });
    else if (bearish) pushSignal(signals, 'STOCHASTIC', 'sell', 0.9, -0.8, 'Stochastic overbought crossover', { k: stochK, d: stochD });
    else pushSignal(signals, 'STOCHASTIC', 'neutral', 0.4, 0, 'Stochastic neutral', { k: stochK, d: stochD });
  }

  const adx = latestIndicators.get('ADX');
  let adxValue = null;
  let adxPlusDi = null;
  let adxMinusDi = null;
  let adxSource = null;
  if (adx) {
    const value = toNumber(adx.value1 ?? adx.adx ?? adx.value);
    const plusDi = toNumber(adx.value4 ?? adx.plusDi);
    const minusDi = toNumber(adx.value5 ?? adx.minusDi);
    if (value !== null) { adxValue = value; adxSource = 'feed'; }
    if (plusDi !== null) adxPlusDi = plusDi;
    if (minusDi !== null) adxMinusDi = minusDi;
  }
  // Phase 9: internal ADX fallback. The regime engine below keys off adxValue —
  // when the MT5 feed does not push ADX it would otherwise stay null and the
  // trend/reversion multipliers + ranging filter would silently no-op. Compute
  // ADX from the candles so regime tuning works regardless of the feed.
  if (adxValue === null) {
    const computed = calculateADX(latestCandles, 14);
    if (computed && Number.isFinite(computed.adx)) {
      adxValue = computed.adx;
      adxPlusDi = Number.isFinite(computed.diPlus) ? computed.diPlus : null;
      adxMinusDi = Number.isFinite(computed.diMinus) ? computed.diMinus : null;
      adxSource = 'internal';
    } else if (latestCandles.length >= 28) {
      // Genuine failure despite enough history (calculateADX needs ~28 bars):
      // surface it instead of silently running with neutral regime multipliers.
      console.warn(`[Regime] ADX unavailable for ${sym} ${timeframe || ''} (feed empty, internal calc returned null on ${latestCandles.length} candles) — regime tuning neutral for this bar.`);
    }
  }
  if (adxValue !== null && adxPlusDi !== null && adxMinusDi !== null) {
    const strong = adxValue >= 25;
    const bullish = adxPlusDi > adxMinusDi;
    pushSignal(signals, 'ADX', strong ? (bullish ? 'buy' : 'sell') : 'neutral', 1, bullish ? 0.6 : -0.6, `${strong ? 'Strong trend confirmed' : 'Weak trend'} (${adxSource})`, { value: adxValue, plusDi: adxPlusDi, minusDi: adxMinusDi, source: adxSource });
  }

  const atrValRaw = calculateATR(latestCandles, 14);
  const preliminaryAtr = atrValRaw && atrValRaw > 0
    ? atrValRaw
    : (sym.includes('XAU') || sym.includes('GOLD') ? 2.50 : sym.includes('JPY') ? 0.25 : 0.0015);

  // ─── REGIME TUNING MULTIPLIERS ───
  let trendMultiplier = 1.0;
  let reversionMultiplier = 1.0;
  if (adxValue !== null) {
    if (adxValue < 20) {
      trendMultiplier = 0.4;
      reversionMultiplier = 1.5;
    } else if (adxValue >= 25) {
      trendMultiplier = 1.3;
      reversionMultiplier = 0.5;
    }
  }

  // 1. Higher Timeframe Bias
  const h4Trend = getTimeframeTrend(h4Candles);
  if (h4Trend === 'BULLISH') {
    const pts = Math.round(20 * trendMultiplier);
    buyScore += pts;
    confluences.push({ name: 'H4 Trend Match', type: 'bullish', points: pts, reason: 'H4 structure is bullish (EMA20 > EMA50)' });
  } else if (h4Trend === 'BEARISH') {
    const pts = Math.round(20 * trendMultiplier);
    sellScore += pts;
    confluences.push({ name: 'H4 Trend Match', type: 'bearish', points: pts, reason: 'H4 structure is bearish (EMA20 < EMA50)' });
  }

  const h1Trend = getTimeframeTrend(h1Candles);
  if (h1Trend === 'BULLISH') {
    const pts = Math.round(15 * trendMultiplier);
    buyScore += pts;
    confluences.push({ name: 'H1 Trend Match', type: 'bullish', points: pts, reason: 'H1 structure is bullish (EMA20 > EMA50)' });
  } else if (h1Trend === 'BEARISH') {
    const pts = Math.round(15 * trendMultiplier);
    sellScore += pts;
    confluences.push({ name: 'H1 Trend Match', type: 'bearish', points: pts, reason: 'H1 structure is bearish (EMA20 < EMA50)' });
  }
  const htfBias = h4Trend !== 'NEUTRAL' ? h4Trend : h1Trend;

  // 2. Market Structure (BOS / CHOCH)
  const struct = detectMarketStructure(latestCandles);
  if (struct.bosBullish) {
    const pts = Math.round(15 * trendMultiplier);
    buyScore += pts;
    confluences.push({ name: 'BOS Confirmed', type: 'bullish', points: pts, reason: `Bullish Break of Structure above swing high (${struct.lastSwingHigh.toFixed(digits)})` });
  } else if (struct.bosBearish) {
    const pts = Math.round(15 * trendMultiplier);
    sellScore += pts;
    confluences.push({ name: 'BOS Confirmed', type: 'bearish', points: pts, reason: `Bearish Break of Structure below swing low (${struct.lastSwingLow.toFixed(digits)})` });
  }

  // 3. Liquidity Sweep Detection
  const sweep = detectLiquiditySweeps(latestCandles);
  if (sweep.sweepBullish) {
    const pts = Math.round(15 * reversionMultiplier);
    buyScore += pts;
    confluences.push({ name: 'Liquidity Sweep', type: 'bullish', points: pts, reason: 'Bullish liquidity sweep (stop hunt) below previous low detected' });
  } else if (sweep.sweepBearish) {
    const pts = Math.round(15 * reversionMultiplier);
    sellScore += pts;
    confluences.push({ name: 'Liquidity Sweep', type: 'bearish', points: pts, reason: 'Bearish liquidity sweep (stop hunt) above previous high detected' });
  }

  // 4. Fair Value Gaps (FVG)
  const fvgs = detectFVGs(latestCandles);
  let bullishFvgRetest = false;
  let bearishFvgRetest = false;
  if (close !== null && fvgs.length > 0) {
    const bullishFvgs = fvgs.filter(f => f.type === 'BULLISH');
    if (bullishFvgs.length > 0) {
      const f = bullishFvgs[bullishFvgs.length - 1];
      if (close >= f.bottom && close <= f.top) bullishFvgRetest = true;
    }
    const bearishFvgs = fvgs.filter(f => f.type === 'BEARISH');
    if (bearishFvgs.length > 0) {
      const f = bearishFvgs[bearishFvgs.length - 1];
      if (close >= f.bottom && close <= f.top) bearishFvgRetest = true;
    }
  }
  if (bullishFvgRetest) {
    const pts = Math.round(10 * reversionMultiplier);
    buyScore += pts;
    confluences.push({ name: 'FVG Retest', type: 'bullish', points: pts, reason: 'Price retraced into bullish Fair Value Gap zone' });
  } else if (bearishFvgRetest) {
    const pts = Math.round(10 * reversionMultiplier);
    sellScore += pts;
    confluences.push({ name: 'FVG Retest', type: 'bearish', points: pts, reason: 'Price retraced into bearish Fair Value Gap zone' });
  }

  // 5. Order Blocks (OB)
  const obs = detectOrderBlocks(latestCandles);
  let insideBullishOb = false;
  let insideBearishOb = false;
  if (close !== null && obs.length > 0) {
    const bullishOBs = obs.filter(ob => ob.type === 'BULLISH' && ob.bottom < close);
    if (bullishOBs.length > 0) {
      const ob = bullishOBs[bullishOBs.length - 1];
      if (close >= ob.bottom && close <= ob.top) insideBullishOb = true;
    }
    const bearishOBs = obs.filter(ob => ob.type === 'BEARISH' && ob.top > close);
    if (bearishOBs.length > 0) {
      const ob = bearishOBs[bearishOBs.length - 1];
      if (close >= ob.bottom && close <= ob.top) insideBearishOb = true;
    }
  }
  if (insideBullishOb) {
    const pts = Math.round(10 * reversionMultiplier);
    buyScore += pts;
    confluences.push({ name: 'Order Block', type: 'bullish', points: pts, reason: 'Price is consolidating within Bullish Order Block' });
  } else if (insideBearishOb) {
    const pts = Math.round(10 * reversionMultiplier);
    sellScore += pts;
    confluences.push({ name: 'Order Block', type: 'bearish', points: pts, reason: 'Price is consolidating within Bearish Order Block' });
  }

  // 6. Session Active Filter
  if (isSessionActive()) {
    buyScore += 5;
    sellScore += 5;
    confluences.push({ name: 'Session Active', type: 'both', points: 5, reason: 'Trade session matches active London / New York open hours' });
  }

  // 7. Volume Surge Detection
  if (recentCandles.length >= 10 && close !== null) {
    const avgVolume = recentCandles.reduce((sum, candle) => sum + (toNumber(candle.volume) || 0), 0) / recentCandles.length;
    const latestVolume = toNumber(latestCandle?.volume);
    if (latestVolume !== null && avgVolume > 0 && latestVolume > avgVolume * 1.2) {
      const isBullishCandle = close > open;
      if (isBullishCandle) {
        buyScore += 5;
        confluences.push({ name: 'Volume Surge', type: 'bullish', points: 5, reason: `Volume spike (${(latestVolume/avgVolume).toFixed(2)}x avg) on bullish bar` });
      } else {
        sellScore += 5;
        confluences.push({ name: 'Volume Surge', type: 'bearish', points: 5, reason: `Volume spike (${(latestVolume/avgVolume).toFixed(2)}x avg) on bearish bar` });
      }
    }
  }

  // 8. Economic News Filter — real, from the MT5-native economic calendar.
  // No AI involved: pure structured matching of {currency, impact, time} for this symbol.
  // skipNews: used by the historical replay/backtest — the economic calendar only
  // holds current/upcoming events, so applying "news in 20m" to bars from days ago
  // is wrong (it would veto the whole backtest whenever a high-impact event is
  // currently near). Treat as no news risk in that mode.
  const newsRisk = skipNews
    ? { block: false, caution: false, reason: null, minutesUntil: null, event: null }
    : assessNewsRisk(symbol, Date.now());
  if (newsRisk.block) {
    // Award no points; a hard block is applied to the final decision below.
    confluences.push({ name: 'High-Impact News', type: 'both', points: 0, reason: `No Trade — ${newsRisk.reason}` });
  } else if (newsRisk.caution) {
    // Approaching news: do not add the "clear" bonus and flag caution.
    confluences.push({ name: 'News Caution', type: 'both', points: 0, reason: newsRisk.reason });
  } else {
    buyScore += 5;
    sellScore += 5;
    confluences.push({ name: 'No High Impact News', type: 'both', points: 5, reason: 'Economic calendar clear (±30m window)' });
  }

  // 9. Precision Entries (EMA stack alignment confluence)
  let emaAlignedBullish = false;
  let emaAlignedBearish = false;
  let emaReason = '';
  if (latestCandles.length >= 200) {
    const ema20Val = calculateEMA(latestCandles, 20);
    const ema50Val = calculateEMA(latestCandles, 50);
    const ema200Val = calculateEMA(latestCandles, 200);
    emaAlignedBullish = ema20Val && ema50Val && ema200Val && ema20Val > ema50Val && ema50Val > ema200Val;
    emaAlignedBearish = ema20Val && ema50Val && ema200Val && ema20Val < ema50Val && ema50Val < ema200Val;
    emaReason = 'EMA alignment stack active (EMA20 > EMA50 > EMA200)';
  } else if (latestCandles.length >= 25) {
    const ema5 = calculateEMA(latestCandles, 5);
    const ema10 = calculateEMA(latestCandles, 10);
    const ema20 = calculateEMA(latestCandles, 20);
    emaAlignedBullish = ema5 && ema10 && ema20 && ema5 > ema10 && ema10 > ema20;
    emaAlignedBearish = ema5 && ema10 && ema20 && ema5 < ema10 && ema10 < ema20;
    emaReason = 'EMA alignment stack active (EMA5 > EMA10 > EMA20)';
  }
  if (emaAlignedBullish) {
    const pts = Math.round(5 * trendMultiplier);
    buyScore += pts;
    confluences.push({ name: 'EMA Alignment', type: 'bullish', points: pts, reason: `Bullish ${emaReason}` });
  } else if (emaAlignedBearish) {
    const pts = Math.round(5 * trendMultiplier);
    sellScore += pts;
    confluences.push({ name: 'EMA Alignment', type: 'bearish', points: pts, reason: `Bearish ${emaReason}` });
  }

  // 10. RSI Divergence
  const rsiDiv = detectRsiDivergence(latestCandles, indicators);
  if (rsiDiv.divBullish) {
    const pts = Math.round(5 * reversionMultiplier);
    buyScore += pts;
    confluences.push({ name: 'RSI Divergence', type: 'bullish', points: pts, reason: 'Bullish Regular Divergence detected' });
  } else if (rsiDiv.divBearish) {
    const pts = Math.round(5 * reversionMultiplier);
    sellScore += pts;
    confluences.push({ name: 'RSI Divergence', type: 'bearish', points: pts, reason: 'Bearish Regular Divergence detected' });
  }

  // 11. MACD Momentum — short-term momentum confluence (MACD line vs signal + histogram slope).
  // MACD was previously only surfaced in the Signal Grid; here it contributes to conviction.
  if (macdMain !== null && macdSignal !== null) {
    const macdBullish = macdMain > macdSignal;
    const histStr = macdHist !== null ? ` (hist ${macdHist.toFixed(digits)})` : '';
    if (macdBullish) {
      const pts = Math.round(5 * trendMultiplier);
      buyScore += pts;
      confluences.push({ name: 'MACD Momentum', type: 'bullish', points: pts, reason: `MACD line above signal${histStr}` });
    } else {
      const pts = Math.round(5 * trendMultiplier);
      sellScore += pts;
      confluences.push({ name: 'MACD Momentum', type: 'bearish', points: pts, reason: `MACD line below signal${histStr}` });
    }
  }

  // 12. DAT + SMC/ICT upgrade: Direction, Area, Trigger must agree for higher-quality Forex signals.
  const supportResistance = detectSupportResistance(latestCandles, preliminaryAtr);
  const sessionContext = getTradingSessionContext(symbol);
  const structuralLevels = [
    ...supportResistance.support.map((z) => z.level),
    ...supportResistance.resistance.map((z) => z.level),
  ];
  const candlePatterns = detectCandlestickPatterns(latestCandles, preliminaryAtr, structuralLevels);
  const ote = detectOteZone(latestCandles);
  const bpr = detectBpr(fvgs, close);
  const amd = detectAmdPhase(latestCandles, preliminaryAtr, struct, sweep, sessionContext);

  const bullishTrigger = candlePatterns.find((p) => p.direction === 'bullish' && p.strength >= 0.65);
  const bearishTrigger = candlePatterns.find((p) => p.direction === 'bearish' && p.strength >= 0.65);
  const dojiTrigger = candlePatterns.find((p) => p.name === 'Doji');

  if (bullishTrigger) {
    const pts = Math.round(10 * bullishTrigger.strength);
    buyScore += pts;
    confluences.push({ name: 'DAT Trigger', type: 'bullish', points: pts, reason: `${bullishTrigger.name}: ${bullishTrigger.reason}` });
  }
  if (bearishTrigger) {
    const pts = Math.round(10 * bearishTrigger.strength);
    sellScore += pts;
    confluences.push({ name: 'DAT Trigger', type: 'bearish', points: pts, reason: `${bearishTrigger.name}: ${bearishTrigger.reason}` });
  }
  if (dojiTrigger) {
    confluences.push({ name: 'DAT Trigger Warning', type: 'both', points: 0, reason: dojiTrigger.reason });
  }

  if (ote.active && ote.direction === 'bullish') {
    buyScore += 8;
    confluences.push({ name: 'OTE Zone', type: 'bullish', points: 8, reason: ote.reason });
  } else if (ote.active && ote.direction === 'bearish') {
    sellScore += 8;
    confluences.push({ name: 'OTE Zone', type: 'bearish', points: 8, reason: ote.reason });
  }

  if (bpr.active) {
    buyScore += 3;
    sellScore += 3;
    confluences.push({ name: 'BPR Zone', type: 'both', points: 3, reason: bpr.reason });
  }

  if (amd.active && amd.direction === 'bullish') {
    buyScore += 12;
    confluences.push({ name: 'AMD Stop Hunt', type: 'bullish', points: 12, reason: `${amd.reason} during ${sessionContext.reason}` });
  } else if (amd.active && amd.direction === 'bearish') {
    sellScore += 12;
    confluences.push({ name: 'AMD Stop Hunt', type: 'bearish', points: 12, reason: `${amd.reason} during ${sessionContext.reason}` });
  } else if (sessionContext.activeStopHuntWindow && amd.phase === 'ACCUMULATION') {
    confluences.push({ name: 'AMD Wait', type: 'both', points: 0, reason: `${amd.reason} inside ${sessionContext.reason}` });
  }

  const nearSupport = close !== null && supportResistance.support.some((z) => Math.abs(close - z.level) <= preliminaryAtr * 0.6);
  const nearResistance = close !== null && supportResistance.resistance.some((z) => Math.abs(close - z.level) <= preliminaryAtr * 0.6);
  if (nearSupport) {
    buyScore += 5;
    confluences.push({ name: 'DAT Area', type: 'bullish', points: 5, reason: 'Price is near mapped support zone' });
  }
  if (nearResistance) {
    sellScore += 5;
    confluences.push({ name: 'DAT Area', type: 'bearish', points: 5, reason: 'Price is near mapped resistance zone' });
  }

  const candidateDirection = buyScore > sellScore ? 'BUY' : sellScore > buyScore ? 'SELL' : 'HOLD';
  const datDirectionPass = candidateDirection === 'BUY'
    ? htfBias !== 'BEARISH'
    : candidateDirection === 'SELL'
      ? htfBias !== 'BULLISH'
      : false;
  const datAreaPass = candidateDirection === 'BUY'
    ? Boolean(nearSupport || insideBullishOb || bullishFvgRetest || sweep.sweepBullish || (ote.active && ote.direction === 'bullish') || bpr.active || (amd.active && amd.direction === 'bullish'))
    : candidateDirection === 'SELL'
      ? Boolean(nearResistance || insideBearishOb || bearishFvgRetest || sweep.sweepBearish || (ote.active && ote.direction === 'bearish') || bpr.active || (amd.active && amd.direction === 'bearish'))
      : false;
  const datTriggerPass = candidateDirection === 'BUY'
    ? Boolean(bullishTrigger || struct.bosBullish || sweep.sweepBullish)
    : candidateDirection === 'SELL'
      ? Boolean(bearishTrigger || struct.bosBearish || sweep.sweepBearish)
      : false;
  const datScore = [datDirectionPass, datAreaPass, datTriggerPass].filter(Boolean).length;
  const datFramework = {
    direction: { pass: datDirectionPass, value: candidateDirection, reason: `HTF bias ${htfBias}` },
    area: { pass: datAreaPass, reason: datAreaPass ? 'Price is at SMC/SR/OTE/BPR area' : 'No high-quality area confluence' },
    trigger: { pass: datTriggerPass, pattern: candidateDirection === 'BUY' ? bullishTrigger?.name || null : bearishTrigger?.name || null, reason: datTriggerPass ? 'Candle/structure trigger confirmed' : 'No trigger candle or structure break yet' },
    score: datScore,
  };

  // Map scores to final output direction & grading scale
  let direction = 'HOLD';
  let score = 0;
  let grade = 'No Trade';

  // ─── PRECISION GATES ───
  // These filters dramatically reduce false signals in choppy / conflicted / ranging
  // markets. They are the difference between a noisy 45% system and a selective one.
  const MIN_SCORE = envNumber('FOREX_MIN_SCORE', 65, { min: 50, max: 90 });
  const MIN_NET_CONVICTION = envNumber('FOREX_MIN_NET_CONVICTION', 15, { min: 5, max: 50 });
  const ALLOW_DAT_2_OF_3 = envBool('FOREX_ALLOW_DAT_2_OF_3', true);
  const MIN_RR = envNumber('FOREX_MIN_RR', 2, { min: 1, max: 5 });
  const netConviction = Math.abs(buyScore - sellScore);
  const rejectionReasons = [];

  // Gate 1 — Net conviction: reject two-sided markets where both directions score high.
  const hasConviction = netConviction >= MIN_NET_CONVICTION;
  if (!hasConviction && (buyScore >= MIN_SCORE || sellScore >= MIN_SCORE)) {
    rejectionReasons.push(`Conflicted market (buy ${buyScore} vs sell ${sellScore}, net ${netConviction} < ${MIN_NET_CONVICTION})`);
  }

  // Gate 2 — Higher-timeframe alignment: never trade against a clearly-trending H4.
  // (H4 takes priority; if H4 is neutral we defer to H1.)
  const buyAgainstHtf = htfBias === 'BEARISH';
  const sellAgainstHtf = htfBias === 'BULLISH';

  // Gate 3 — Regime filter: in a ranging market (ADX < 20) trend/breakout setups fail.
  // Require materially higher conviction before taking a trade in a dead regime.
  const isRanging = adxValue !== null && adxValue < 20;
  const regimeAdjustedMinScore = isRanging ? MIN_SCORE + 15 : MIN_SCORE;
  if (isRanging) rejectionReasons.push(`Ranging regime (ADX ${adxValue.toFixed(1)} < 20)`);

  // ─── Second-drive gate (Spec 1, flag-gated, default OFF) ───
  // On BREAKOUT/SHAKEOUT triggers (BOS or liquidity sweep), require the move to be a
  // SECOND drive (after a failed-first/shakeout or a retest), not the raw first break —
  // Fabio's "never take the first drive". Clean continuation pullbacks are NOT gated.
  // `drive` is computed unconditionally so the advisory badge always has data; the gate
  // only *enforces* it when SECOND_DRIVE_GATE is on.
  const SECOND_DRIVE_GATE = envBool('SECOND_DRIVE_GATE', false);
  const driveDir = candidateDirection === 'BUY' ? 'BULLISH' : candidateDirection === 'SELL' ? 'BEARISH' : null;
  const isBreakoutOrShakeout = driveDir === 'BULLISH'
    ? Boolean(struct.bosBullish || sweep.sweepBullish)
    : driveDir === 'BEARISH'
      ? Boolean(struct.bosBearish || sweep.sweepBearish)
      : false;
  const drive = driveDir
    ? detectSecondDrive(latestCandles, driveDir)
    : { isSecondDrive: false, firstDriveIdx: null, basis: null, label: 'NONE', note: 'No directional bias', edge: null, drives: 0 };

  let datTriggerPassGated = datTriggerPass;
  if (SECOND_DRIVE_GATE && datTriggerPass && isBreakoutOrShakeout && driveDir && !drive.isSecondDrive) {
    datTriggerPassGated = false;
    rejectionReasons.push('First drive — waiting for second');
  }

  // ─── Premium / discount (advisory location) ───
  // Where price sits in the last ~60-bar dealing range (0%=low, 100%=high). Buy discount,
  // sell premium. `fit` is direction-aware: GOOD when the side matches the zone (buy in
  // discount / sell in premium), POOR when it fights it. Surfaced on dashboard + alerts.
  let premiumDiscount = null;
  {
    const r5 = (v) => Math.round(v * 1e5) / 1e5;
    const pdWindow = latestCandles.slice(-60);
    if (pdWindow.length >= 10) {
      const rangeHigh = Math.max(...pdWindow.map((c) => Number(c.high)).filter(Number.isFinite));
      const rangeLow = Math.min(...pdWindow.map((c) => Number(c.low)).filter(Number.isFinite));
      const px = Number(latestCandle?.close);
      if (Number.isFinite(rangeHigh) && Number.isFinite(rangeLow) && rangeHigh > rangeLow && Number.isFinite(px)) {
        const pct = Math.max(0, Math.min(100, Math.round(((px - rangeLow) / (rangeHigh - rangeLow)) * 100)));
        const zone = pct > 55 ? 'PREMIUM' : pct < 45 ? 'DISCOUNT' : 'EQUILIBRIUM';
        // fit is finalized later against the COMMITTED decision (HOLD → NEUTRAL).
        premiumDiscount = { pct, zone, fit: 'NEUTRAL', rangeHigh: r5(rangeHigh), rangeLow: r5(rangeLow), equilibrium: r5((rangeHigh + rangeLow) / 2) };
      }
    }
  }

  const datTradePass = datDirectionPass && datAreaPass && datTriggerPassGated;
  const relaxedDatTradePass = ALLOW_DAT_2_OF_3 && datTriggerPassGated && datScore >= 2;
  const datQualifies = datTradePass || relaxedDatTradePass;

  const buyQualifies =
    buyScore >= regimeAdjustedMinScore &&
    buyScore > sellScore &&
    hasConviction &&
    !buyAgainstHtf &&
    datDirectionPass &&
    datQualifies;

  const sellQualifies =
    sellScore >= regimeAdjustedMinScore &&
    sellScore > buyScore &&
    hasConviction &&
    !sellAgainstHtf &&
    datDirectionPass &&
    datQualifies;

  if (buyQualifies) {
    score = Math.min(100, buyScore);
    direction = score >= 90 ? 'STRONG_BUY' : 'BUY';
    grade = score >= 90 ? 'A+ Setup' : score >= 80 ? 'A Setup' : 'B Setup';
  } else if (sellQualifies) {
    score = Math.min(100, sellScore);
    direction = score >= 90 ? 'STRONG_SELL' : 'SELL';
    grade = score >= 90 ? 'A+ Setup' : score >= 80 ? 'A Setup' : 'B Setup';
  } else {
    score = Math.max(buyScore, sellScore);
    direction = 'HOLD';
    if ((buyScore >= MIN_SCORE || sellScore >= MIN_SCORE) && !datQualifies) {
      rejectionReasons.push(`DAT incomplete (Direction ${datDirectionPass ? 'pass' : 'fail'}, Area ${datAreaPass ? 'pass' : 'fail'}, Trigger ${datTriggerPass ? 'pass' : 'fail'})`);
    }
    // Explain WHY a high-scoring setup was rejected so the UI / AI layer can learn from it.
    if ((buyScore >= MIN_SCORE && buyAgainstHtf) || (sellScore >= MIN_SCORE && sellAgainstHtf)) {
      rejectionReasons.push(`Counter-trend vs H4/H1 bias (${htfBias})`);
    }
    grade = rejectionReasons.length ? `No Trade (${rejectionReasons[0]})` : 'No Trade';
  }

  let calcDirection = direction;
  if (direction === 'HOLD') {
    const maxScore = Math.max(buyScore, sellScore);
    if (maxScore >= 65) {
      if (buyScore > sellScore && !buyAgainstHtf && hasConviction) {
        calcDirection = 'BUY';
      } else if (sellScore > buyScore && !sellAgainstHtf && hasConviction) {
        calcDirection = 'SELL';
      }
    }
  }

  let atrVal = atrValRaw;
  // Directional composite in [-1, +1]: positive = bullish conviction, negative = bearish.
  // Derived from the net buy/sell score difference so downstream consumers (FTT blend,
  // Gemini fallback) get a correctly-signed bias instead of an always-positive magnitude.
  const rawCompositeScore = Math.max(-1, Math.min(1, (buyScore - sellScore) / 100));  if (atrVal === null || atrVal <= 0) {
    const sym = String(symbol).toUpperCase();
    if (sym.includes('XAU') || sym.includes('GOLD')) {
      atrVal = 2.50;
    } else if (sym.includes('JPY')) {
      atrVal = 0.25;
    } else {
      atrVal = 0.0015;
    }
  }

  // ADR Exhaustion Filter
  let adrExhausted = false;
  let adrUsagePercent = 0;
  if (adr && dailyHighLow && adr > 0) {
    const currentRange = dailyHighLow.high - dailyHighLow.low;
    adrUsagePercent = (currentRange / adr) * 100;
    if (adrUsagePercent >= 90) {
      adrExhausted = true;
    }
  }

  // If ADR is exhausted, degrade buy/sell scores
  if (adrExhausted && direction !== 'HOLD') {
    direction = 'HOLD';
    grade = 'No Trade (ADR Exhausted)';
    score = Math.round(score * 0.4);
  }

  // News hard-block: a high-impact, currency-relevant release inside ±30m forces HOLD.
  // Opt-in NEWS_MODE='react' keeps the setup as a post-release breakout play instead.
  const newsReactMode = String(process.env.NEWS_MODE || 'avoid').toLowerCase() === 'react';
  let newsReactBreakout = false;
  if (newsRisk.block && direction !== 'HOLD') {
    if (newsReactMode) {
      newsReactBreakout = true;
      grade = `News-Reaction (${newsRisk.event?.title || 'event'})`;
      rejectionReasons.unshift(`React mode: trade ${newsRisk.event?.title || 'news'} breakout, not pre-release`);
    } else {
      direction = 'HOLD';
      grade = `No Trade (High Impact News: ${newsRisk.event?.title || 'event'})`;
      score = Math.round(score * 0.3);
      rejectionReasons.unshift(newsRisk.reason);
    }
  }

  // Doji / indecision guard: reject entries on very low-body candles (consolidation / noise).
  let bodyRatio = null;
  if (close !== null && open !== null && high !== null && low !== null) {
    const range = high - low;
    if (range > 0) bodyRatio = Math.abs(close - open) / range;
  }
  if (bodyRatio !== null && bodyRatio < 0.12 && direction !== 'HOLD') {
    direction = 'HOLD';
    grade = `No Trade (Indecision candle, body ${(bodyRatio * 100).toFixed(0)}%)`;
    rejectionReasons.unshift('Indecision / doji candle (low body ratio)');
  }

  // Precise SL / TP calculations
  let sl = null;
  let slTip = "No active trade setup.";
  let tp1 = null;
  let tp2 = null;
  let tp3 = null;
  let tpTip = "";
  let rr = null;

  if (close !== null) {
    // Determine swing low/high of the recent candles for structural stops
    const recentLow = Math.min(...recentCandles.slice(-10).map(c => Number(c.low)).filter(v => !isNaN(v)));
    const recentHigh = Math.max(...recentCandles.slice(-10).map(c => Number(c.high)).filter(v => !isNaN(v)));

    if (calcDirection.includes('BUY')) {
      const bullishOBs = obs.filter(ob => ob.type === 'BULLISH' && ob.bottom < close);
      bullishOBs.sort((a, b) => b.bottom - a.bottom);
      const nearestOB = bullishOBs[0];

      // Structural Stop: Choose the lowest between the recent swing low and the nearest Order Block bottom
      let structuralStop = recentLow;
      if (nearestOB && nearestOB.bottom < structuralStop) {
        structuralStop = nearestOB.bottom;
      }
      
      // Add a small safety buffer (0.3 * ATR) and clamp the distance between 1.2x ATR and 4.0x ATR
      let targetSl = structuralStop - (0.3 * atrVal);
      const minSl = close - (4.0 * atrVal);
      const maxSl = close - (1.2 * atrVal);
      sl = Math.max(minSl, Math.min(maxSl, targetSl));

      slTip = `Structure-based: Set below recent swing low/Order Block structure (${sl.toFixed(digits)}) with safety buffer.`;

      tp1 = close + 1.0 * Math.abs(close - sl);
      tp2 = close + 2.0 * Math.abs(close - sl);
      tp3 = close + 3.0 * Math.abs(close - sl);
      tpTip = "Fixed Risk-Reward: TP1 (1:1 R:R), TP2 (1:2 R:R), TP3 (1:3 R:R)";
      rr = 2.0;
    } else if (calcDirection.includes('SELL')) {
      const bearishOBs = obs.filter(ob => ob.type === 'BEARISH' && ob.top > close);
      bearishOBs.sort((a, b) => a.top - b.top);
      const nearestBearishOB = bearishOBs[0];

      // Structural Stop: Choose the highest between the recent swing high and the nearest Order Block top
      let structuralStop = recentHigh;
      if (nearestBearishOB && nearestBearishOB.top > structuralStop) {
        structuralStop = nearestBearishOB.top;
      }

      // Add a small safety buffer (0.3 * ATR) and clamp the distance between 1.2x ATR and 4.0x ATR
      let targetSl = structuralStop + (0.3 * atrVal);
      const minSl = close + (1.2 * atrVal);
      const maxSl = close + (4.0 * atrVal);
      sl = Math.min(maxSl, Math.max(minSl, targetSl));

      slTip = `Structure-based: Set above recent swing high/Order Block structure (${sl.toFixed(digits)}) with safety buffer.`;

      tp1 = close - 1.0 * Math.abs(close - sl);
      tp2 = close - 2.0 * Math.abs(close - sl);
      tp3 = close - 3.0 * Math.abs(close - sl);
      tpTip = "Fixed Risk-Reward: TP1 (1:1 R:R), TP2 (1:2 R:R), TP3 (1:3 R:R)";
      rr = 2.0;
    }
  }

  // ─── Realistic RR to nearest opposing structure + entry-trigger quality ───
  // The fixed TPs above are mechanical (always 1:2). The *realistic* RR measures the
  // distance to the nearest opposing liquidity/structure that price must clear — a far
  // more honest read on whether an IMMEDIATE entry is worth taking.
  let realisticRR = rr;
  let realisticTarget = null;
  let entryTrigger = direction === 'HOLD' ? 'HOLD_NO_TRADE' : 'IMMEDIATE';
  if (close !== null && sl !== null && direction !== 'HOLD') {
    const riskDist = Math.abs(close - sl);
    const candidates = [];
    if (direction.includes('BUY')) {
      obs.filter((ob) => ob.type === 'BEARISH' && ob.bottom > close).forEach((ob) => candidates.push(ob.bottom));
      if (struct.lastSwingHigh && struct.lastSwingHigh > close) candidates.push(struct.lastSwingHigh);
      if (bbUpper !== null && bbUpper > close) candidates.push(bbUpper);
      if (candidates.length) realisticTarget = Math.min(...candidates);
    } else {
      obs.filter((ob) => ob.type === 'BULLISH' && ob.top < close).forEach((ob) => candidates.push(ob.top));
      if (struct.lastSwingLow && struct.lastSwingLow < close) candidates.push(struct.lastSwingLow);
      if (bbLower !== null && bbLower < close) candidates.push(bbLower);
      if (candidates.length) realisticTarget = Math.max(...candidates);
    }
    if (realisticTarget !== null && riskDist > 0) {
      realisticRR = Math.round((Math.abs(realisticTarget - close) / riskDist) * 100) / 100;
      if (direction.includes('BUY')) {
        tp1 = realisticTarget;
        tp2 = close + 2.0 * riskDist;
        tp3 = close + 3.0 * riskDist;
      } else {
        tp1 = realisticTarget;
        tp2 = close - 2.0 * riskDist;
        tp3 = close - 3.0 * riskDist;
      }
      tpTip = `Structure-aware targets: TP1 at nearest opposing liquidity/SR (${realisticTarget.toFixed(digits)}), TP2/TP3 at 2R/3R extension.`;
      // Thin room to the next structure -> don't chase market; prefer a pullback entry.
      if (realisticRR < 1.5) entryTrigger = 'LIMIT_PULLBACK';
    }
  }
  if (direction !== 'HOLD' && realisticRR !== null && realisticRR < MIN_RR) {
    direction = 'HOLD';
    grade = `No Trade (RR ${realisticRR}:1 < ${MIN_RR}:1)`;
    score = Math.round(score * 0.6);
    entryTrigger = 'HOLD_NO_TRADE';
    rejectionReasons.unshift(`Risk/reward below 1:${MIN_RR} minimum (${realisticRR}:1)`);
  }
  // Approaching (but not blocking) news -> avoid aggressive immediate entries.
  if (newsRisk.caution && entryTrigger === 'IMMEDIATE') entryTrigger = 'LIMIT_PULLBACK';
  // React mode on a blocking event -> wait for the post-release breakout.
  if (newsReactBreakout && direction !== 'HOLD') entryTrigger = 'BREAKOUT_CONFIRMATION';

  // ─── Entry timing (ported from FTT): when to enter vs wait for the candle close ───
  let entryTimingInstruction = 'HOLD_NO_TRADE';
  let timingTip = 'No active setup — stay flat.';
  let remainingSeconds = null;
  if (direction !== 'HOLD' && latestCandle) {
    const tfMs = timeframeToMs(timeframe);
    const nowMs = Date.now();
    const openMs = Date.parse(latestCandle.time) || nowMs;
    const elapsed = Math.max(0, nowMs - openMs);
    const remainingMs = tfMs - (elapsed % tfMs);
    remainingSeconds = Math.round(remainingMs / 1000);
    const waitSec = Math.min(30, (tfMs / 1000) * 0.1);
    if (remainingSeconds <= waitSec) {
      entryTimingInstruction = 'WAIT_FOR_NEXT_CANDLE';
      timingTip = `Current ${timeframe || ''} candle closes in ${remainingSeconds}s — wait for the next open to enter cleanly.`;
    } else if (entryTrigger === 'LIMIT_PULLBACK') {
      entryTimingInstruction = 'WAIT_FOR_PULLBACK';
      timingTip = `Thin room to structure (RR ${realisticRR ?? 'n/a'}). Wait for a pullback toward entry instead of chasing.`;
    } else {
      entryTimingInstruction = 'IMMEDIATE_ENTRY';
      timingTip = `${remainingSeconds}s left on this ${timeframe || ''} candle — entry window is open.`;
    }
  }

  const strategyTags = [];
  if (datScore === 3) strategyTags.push('DAT');
  if (amd.active) strategyTags.push('AMD');
  if (insideBullishOb || insideBearishOb || bullishFvgRetest || bearishFvgRetest || sweep.sweepBullish || sweep.sweepBearish) strategyTags.push('SMC');
  if (ote.active) strategyTags.push('OTE');
  if (bpr.active) strategyTags.push('BPR');
  if (newsReactBreakout || newsRisk.caution || newsRisk.block) strategyTags.push('NEWS_AWARE');
  const strategyType = strategyTags.length ? strategyTags.join('+') : 'SYSTEM_CONFLUENCE';

  const riskPercent = Math.min(2, Math.max(0.1, Number(process.env.FOREX_SIGNAL_RISK_PERCENT || 1)));
  const leverage = Math.max(1, Number(process.env.FOREX_SIGNAL_LEVERAGE || 500));
  const accountEquity = toNumber(accountSnapshot?.equity);
  const accountBalance = toNumber(accountSnapshot?.balance);
  const configuredFallbackEquity = Number(process.env.FOREX_SIGNAL_DEFAULT_EQUITY || 1000);
  const fallbackEquity = Number.isFinite(configuredFallbackEquity) && configuredFallbackEquity > 0 ? configuredFallbackEquity : 1000;
  const equity = accountEquity > 0 ? accountEquity : accountBalance > 0 ? accountBalance : fallbackEquity;
  const stopDistance = close !== null && sl !== null ? Math.abs(close - sl) : null;
  const stopPips = stopDistance !== null ? Math.round((stopDistance / pipSizeForSymbol(symbol)) * 10) / 10 : null;
  const riskAmount = equity !== null ? Math.round(equity * (riskPercent / 100) * 100) / 100 : null;
  const pipValue = estimatePipValuePerLot(symbol);
  const pipSize = pipSizeForSymbol(symbol);
  const contractSize = contractSizeForSymbol(symbol);
  const suggestedLotSize = riskAmount !== null && riskAmount > 0 && stopPips && stopPips > 0
    ? Math.max(0.01, Math.round((riskAmount / (stopPips * pipValue)) * 100) / 100)
    : null;
  const notionalValue = close !== null && suggestedLotSize !== null
    ? moneyRound(close * contractSize * suggestedLotSize)
    : null;
  const marginRequired = notionalValue !== null ? moneyRound(notionalValue / leverage) : null;
  const calcProfit = (target) => {
    if (target === null || target === undefined || close === null || suggestedLotSize === null) return null;
    const targetPips = Math.abs(target - close) / pipSize;
    return moneyRound(targetPips * pipValue * suggestedLotSize);
  };
  const lossAtStop = stopPips !== null && suggestedLotSize !== null
    ? moneyRound(stopPips * pipValue * suggestedLotSize)
    : riskAmount;
  const riskPlan = {
    riskPercent,
    maxRiskPercent: 2,
    leverage,
    multiplier: `${leverage}x`,
    contractSize,
    equity,
    riskAmount,
    amountToRisk: riskAmount,
    stopDistance,
    stopPips,
    estimatedPipValuePerLot: pipValue,
    suggestedLotSize,
    notionalValue,
    marginRequired,
    amountToInvestApprox: marginRequired,
    lossAtStop,
    maxLoss: lossAtStop,
    profitAtTp1: calcProfit(tp1),
    profitAtTp2: calcProfit(tp2),
    profitAtTp3: calcProfit(tp3),
    minRiskRewardRequired: MIN_RR,
    passed: direction !== 'HOLD' && (realisticRR === null || realisticRR >= MIN_RR),
  };

  const triggerPassed = datFramework?.trigger?.pass === true;
  let signalQuality = 'WATCH';
  if (direction !== 'HOLD' && riskPlan.passed) {
    if (score >= 80 && datScore === 3 && (realisticRR === null || realisticRR >= MIN_RR)) {
      signalQuality = 'A+ SIGNAL';
    } else if (score >= 70 && datScore >= 2 && triggerPassed && (realisticRR === null || realisticRR >= MIN_RR)) {
      signalQuality = 'A SIGNAL';
    } else if (score >= MIN_SCORE && triggerPassed && (realisticRR === null || realisticRR >= MIN_RR)) {
      signalQuality = 'B SIGNAL';
    }
  }

  // Finalize the premium/discount FIT against the COMMITTED decision, not the raw
  // buyScore-vs-sellScore lean. On a HOLD / no-trade row the location is advisory
  // only, so the trade-fit (✓/⚠) is suppressed (NEUTRAL) — the zone + % still show.
  if (premiumDiscount) {
    const committed = direction === 'HOLD' ? null : (direction.includes('BUY') ? 'BUY' : 'SELL');
    premiumDiscount.fit = !committed ? 'NEUTRAL'
      : (committed === 'BUY' && premiumDiscount.zone === 'DISCOUNT') || (committed === 'SELL' && premiumDiscount.zone === 'PREMIUM') ? 'GOOD'
      : (committed === 'BUY' && premiumDiscount.zone === 'PREMIUM') || (committed === 'SELL' && premiumDiscount.zone === 'DISCOUNT') ? 'POOR'
      : 'NEUTRAL';
  }

  const systemDecision = {
    decision: direction,
    confidence: score,
    compositeScore: score / 100,
    rawCompositeScore,
    tradableCompositeScore: direction === 'HOLD' ? 0 : rawCompositeScore,
    entryPrice: close,
    stopLoss: sl,
    slTip,
    takeProfit1: tp1,
    takeProfit2: tp2,
    takeProfit3: tp3,
    tpTip,
    riskRewardRatio: realisticRR,
    fixedRiskRewardRatio: rr,
    realisticTarget,
    entryTrigger,
    entryTimingInstruction,
    timingTip,
    remainingSeconds,
    bodyRatio,
    strategyType,
    strategyTags,
    signalQuality,
    datFramework,
    candlePatterns,
    ote,
    bpr,
    amd,
    sessionContext,
    riskPlan,
    entryReason: datFramework.trigger.reason,
    slReason: slTip,
    tpReason: tpTip,
    newsRisk: {
      block: newsRisk.block,
      caution: newsRisk.caution,
      reason: newsRisk.reason,
      minutesUntil: newsRisk.minutesUntil,
      event: newsRisk.event
        ? { title: newsRisk.event.title, currency: newsRisk.event.currency, impact: newsRisk.event.impact, timeIso: newsRisk.event.timeIso }
        : null,
    },
    adrExhausted,
    adrUsagePercent,
    netConviction,
    adxValue,
    adxSource,
    regime: adxValue === null ? 'unknown' : (adxValue < 20 ? 'ranging' : (adxValue >= 25 ? 'trending' : 'developing')),
    htfBias,
    rejectionReasons,
    drive,                              // advisory drive label (1st vs 2nd drive); gate enforced only when SECOND_DRIVE_GATE=on
    premiumDiscount,                    // advisory location: { pct, zone, fit } — buy discount / sell premium
    fvgs: fvgs.slice(-5),
    orderBlocks: obs.slice(-5),
    confluences,
    buyScore,
    sellScore,
    grade,
    supportResistance,
    features: extractFeatures(latestCandles, { adxValue, htfBias, adrUsagePercent }),
  };

  const spread = latestCandle?.spread ?? null;

  return {
    symbol,
    timeframe,
    decision: direction,
    confidence: score,
    compositeScore: direction === 'HOLD' ? 0 : rawCompositeScore,
    rawCompositeScore,
    tradableCompositeScore: direction === 'HOLD' ? 0 : rawCompositeScore,
    bullishSignals: signals.filter(s => s.strength > 0).length,
    bearishSignals: signals.filter(s => s.strength < 0).length,
    signals,
    latestCandle,
    indicatorsSnapshot: Object.fromEntries([...latestIndicators.entries()].map(([key, value]) => [key, value])),
    marketContext: {
      price: close,
      open,
      high,
      low,
      spread,
      recentCandles: recentCandles.slice(-20),
      accountSnapshot,
      nearestLevel: marketLevels[0] || null,
      h4Trend,
      h1Trend,
      supportResistance
    },
    datFramework,
    candlePatterns,
    ote,
    bpr,
    amd,
    sessionContext,
    riskPlan,
    strategyType,
    systemDecision,
  };
}

export {
  aggregateSignals,
  extractFeatures,
  calculateATR,
  calculateEMA,
  detectFVGs,
  detectOrderBlocks,
  detectMarketStructure,
  detectLiquiditySweeps,
  detectSupportResistance,
  getTimeframeTrend,
  timeframeToMs,
};
