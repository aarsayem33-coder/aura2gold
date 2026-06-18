/**
 * Mathematical calculations and technical indicators for AI Signals.
 * Clean, pure functions that operate on candle arrays.
 */

// Helper to convert candle values to numbers
function getCandlesWithNumbers(candles) {
  return candles.map(c => ({
    time: c.time,
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume || 0),
  })).filter(c => !isNaN(c.open) && !isNaN(c.high) && !isNaN(c.low) && !isNaN(c.close));
}

// 1. EMA (Exponential Moving Average)
export function calculateEMA(candles, period) {
  const data = getCandlesWithNumbers(candles);
  if (data.length < period) return null;
  const k = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((sum, c) => sum + c.close, 0) / period;
  for (let i = period; i < data.length; i++) {
    ema = data[i].close * k + ema * (1 - k);
  }
  return ema;
}

// 2. SMA (Simple Moving Average)
export function calculateSMA(values, period) {
  if (values.length < period) return null;
  const sma = [];
  for (let i = period - 1; i < values.length; i++) {
    const sum = values.slice(i - period + 1, i + 1).reduce((s, v) => s + v, 0);
    sma.push(sum / period);
  }
  return sma;
}

// 3. RSI (Relative Strength Index)
export function calculateRSI(candles, period = 14) {
  const data = getCandlesWithNumbers(candles);
  if (data.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = data[i].close - data[i - 1].close;
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < data.length; i++) {
    const diff = data[i].close - data[i - 1].close;
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

// 4. Bollinger Bands
export function calculateBollingerBands(candles, period = 20, stdDevMultiplier = 2) {
  const data = getCandlesWithNumbers(candles);
  if (data.length < period) return null;
  const slice = data.slice(-period);
  const closes = slice.map(c => c.close);
  const middle = closes.reduce((sum, c) => sum + c, 0) / period;
  const variance = closes.reduce((sum, c) => sum + Math.pow(c - middle, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  const latestClose = data[data.length - 1].close;
  
  let relation = "Inside bands";
  if (latestClose >= middle + stdDevMultiplier * stdDev) {
    relation = "Price hugging or above upper band";
  } else if (latestClose <= middle - stdDevMultiplier * stdDev) {
    relation = "Price hugging or below lower band";
  }

  return {
    middle,
    upper: middle + stdDevMultiplier * stdDev,
    lower: middle - stdDevMultiplier * stdDev,
    relation
  };
}

// 5. MACD (Moving Average Convergence Divergence)
export function calculateMACD(candles, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const data = getCandlesWithNumbers(candles);
  if (data.length < slowPeriod) return null;
  
  // Calculate fast EMA and slow EMA series
  const fastEmaList = [];
  const slowEmaList = [];
  let fastEma = data[0].close;
  let slowEma = data[0].close;
  const kFast = 2 / (fastPeriod + 1);
  const kSlow = 2 / (slowPeriod + 1);

  for (let i = 0; i < data.length; i++) {
    fastEma = data[i].close * kFast + fastEma * (1 - kFast);
    slowEma = data[i].close * kSlow + slowEma * (1 - kSlow);
    fastEmaList.push(fastEma);
    slowEmaList.push(slowEma);
  }

  const macdLine = [];
  for (let i = 0; i < data.length; i++) {
    macdLine.push(fastEmaList[i] - slowEmaList[i]);
  }

  // Calculate signal line list (EMA of MACD line)
  const signalLine = [];
  let sigEma = macdLine[0];
  const kSignal = 2 / (signalPeriod + 1);
  for (let i = 0; i < macdLine.length; i++) {
    sigEma = macdLine[i] * kSignal + sigEma * (1 - kSignal);
    signalLine.push(sigEma);
  }

  const latestMacd = macdLine[macdLine.length - 1];
  const latestSignal = signalLine[signalLine.length - 1];
  const prevMacd = macdLine[macdLine.length - 2];
  const prevSignal = signalLine[signalLine.length - 2];

  let crossover = "none";
  if (prevMacd <= prevSignal && latestMacd > latestSignal) {
    crossover = "bullish_confirmed";
  } else if (prevMacd >= prevSignal && latestMacd < latestSignal) {
    crossover = "bearish_confirmed";
  } else if (latestMacd > latestSignal) {
    crossover = "bullish_lean";
  } else {
    crossover = "bearish_lean";
  }

  return {
    macdLine: latestMacd,
    signalLine: latestSignal,
    histogram: latestMacd - latestSignal,
    crossover
  };
}

// 6. Heikin-Ashi Candles Conversion
export function convertToHeikinAshi(candles) {
  const data = getCandlesWithNumbers(candles);
  if (data.length === 0) return [];
  
  const haCandles = [];
  // First candle
  const first = data[0];
  let prevOpen = (first.open + first.close) / 2;
  let prevClose = (first.open + first.high + first.low + first.close) / 4;
  
  haCandles.push({
    time: first.time,
    open: prevOpen,
    close: prevClose,
    high: Math.max(first.high, prevOpen, prevClose),
    low: Math.min(first.low, prevOpen, prevClose),
  });

  for (let i = 1; i < data.length; i++) {
    const c = data[i];
    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const haOpen = (prevOpen + prevClose) / 2;
    const haHigh = Math.max(c.high, haOpen, haClose);
    const haLow = Math.min(c.low, haOpen, haClose);

    haCandles.push({
      time: c.time,
      open: haOpen,
      close: haClose,
      high: haHigh,
      low: haLow,
    });

    prevOpen = haOpen;
    prevClose = haClose;
  }
  return haCandles;
}

// 7. Ichimoku Cloud (Tenkan-Sen / Kijun-Sen)
export function calculateIchimoku(candles, tenkanPeriod = 9, kijunPeriod = 26) {
  // Can be calculated on standard candles or Heikin-Ashi candles
  const data = getCandlesWithNumbers(candles);
  if (data.length < kijunPeriod) return null;

  const ichimoku = [];
  for (let i = kijunPeriod - 1; i < data.length; i++) {
    // Tenkan
    const tenkanSubset = data.slice(i - tenkanPeriod + 1, i + 1);
    const tenkanHigh = Math.max(...tenkanSubset.map(c => c.high));
    const tenkanLow = Math.min(...tenkanSubset.map(c => c.low));
    const tenkan = (tenkanHigh + tenkanLow) / 2;

    // Kijun
    const kijunSubset = data.slice(i - kijunPeriod + 1, i + 1);
    const kijunHigh = Math.max(...kijunSubset.map(c => c.high));
    const kijunLow = Math.min(...kijunSubset.map(c => c.low));
    const kijun = (kijunHigh + kijunLow) / 2;

    ichimoku.push({
      time: data[i].time,
      tenkan,
      kijun
    });
  }

  return ichimoku;
}

// 8. On-Balance Volume (OBV)
export function calculateOBV(candles) {
  const data = getCandlesWithNumbers(candles);
  if (data.length < 2) return 0;
  
  let obv = 0;
  const obvValues = [0];

  for (let i = 1; i < data.length; i++) {
    const close = data[i].close;
    const prevClose = data[i - 1].close;
    const volume = data[i].volume;

    if (close > prevClose) {
      obv += volume;
    } else if (close < prevClose) {
      obv -= volume;
    }
    obvValues.push(obv);
  }

  // Detect divergence or slope
  const latestObv = obvValues[obvValues.length - 1];
  const prevObv = obvValues[obvValues.length - 5] || obvValues[0];
  const trend = latestObv > prevObv ? "Rising OBV (Buying Pressure)" : latestObv < prevObv ? "Falling OBV (Selling Pressure)" : "Flat OBV";

  return {
    value: latestObv,
    trend
  };
}

// 9. Accumulation/Distribution Line (A/D Line)
export function calculateADLine(candles) {
  const data = getCandlesWithNumbers(candles);
  if (data.length === 0) return { value: 0, trend: "Neutral" };

  let ad = 0;
  const adValues = [];

  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    const range = c.high - c.low;
    let multiplier = 0;
    if (range > 0) {
      multiplier = ((c.close - c.low) - (c.high - c.close)) / range;
    }
    const mfv = multiplier * c.volume;
    ad += mfv;
    adValues.push(ad);
  }

  const latestAd = adValues[adValues.length - 1];
  const prevAd = adValues[adValues.length - 5] || adValues[0];
  const trend = latestAd > prevAd ? "Accumulation (Buying Interest)" : latestAd < prevAd ? "Distribution (Selling Interest)" : "Neutral";

  return {
    value: latestAd,
    trend
  };
}

// 10. ADX (Average Directional Index)
export function calculateADX(candles, period = 14) {
  const data = getCandlesWithNumbers(candles);
  if (data.length < period * 2) return null; // Needs enough history for smoothing

  const tr = [];
  const plusDM = [];
  const minusDM = [];

  for (let i = 1; i < data.length; i++) {
    const current = data[i];
    const prev = data[i - 1];

    // True Range
    const val1 = current.high - current.low;
    const val2 = Math.abs(current.high - prev.close);
    const val3 = Math.abs(current.low - prev.close);
    tr.push(Math.max(val1, val2, val3));

    // Directional Movement
    const upMove = current.high - prev.high;
    const downMove = prev.low - current.low;

    if (upMove > downMove && upMove > 0) {
      plusDM.push(upMove);
    } else {
      plusDM.push(0);
    }

    if (downMove > upMove && downMove > 0) {
      minusDM.push(downMove);
    } else {
      minusDM.push(0);
    }
  }

  // Smoothings using Wilder's smoothing technique:
  // First value is simple sum
  let smoothTR = tr.slice(0, period).reduce((sum, v) => sum + v, 0);
  let smoothPlusDM = plusDM.slice(0, period).reduce((sum, v) => sum + v, 0);
  let smoothMinusDM = minusDM.slice(0, period).reduce((sum, v) => sum + v, 0);

  const diPlusList = [];
  const diMinusList = [];
  const dxList = [];

  const addDi = (str, sP, sM) => {
    const dip = str === 0 ? 0 : (sP / str) * 100;
    const dim = str === 0 ? 0 : (sM / str) * 100;
    diPlusList.push(dip);
    diMinusList.push(dim);
    const diff = Math.abs(dip - dim);
    const sum = dip + dim;
    const dx = sum === 0 ? 0 : (diff / sum) * 100;
    dxList.push(dx);
  };

  addDi(smoothTR, smoothPlusDM, smoothMinusDM);

  for (let i = period; i < tr.length; i++) {
    smoothTR = smoothTR - (smoothTR / period) + tr[i];
    smoothPlusDM = smoothPlusDM - (smoothPlusDM / period) + plusDM[i];
    smoothMinusDM = smoothMinusDM - (smoothMinusDM / period) + minusDM[i];
    addDi(smoothTR, smoothPlusDM, smoothMinusDM);
  }

  // Calculate ADX (SMA/Wilder of DX)
  if (dxList.length < period) return null;
  let adx = dxList.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  for (let i = period; i < dxList.length; i++) {
    adx = (adx * (period - 1) + dxList[i]) / period;
  }

  const latestAdx = adx;
  const latestDiPlus = diPlusList[diPlusList.length - 1];
  const latestDiMinus = diMinusList[diMinusList.length - 1];

  let trendStrength = "Weak or Nonexistent Trend";
  if (latestAdx > 40) trendStrength = "Very Strong Trend";
  else if (latestAdx > 25) trendStrength = "Strong Trend";
  else if (latestAdx > 20) trendStrength = "Moderate Trend";

  let trendDirection = "Ranging/Unclear";
  if (latestAdx > 20) {
    trendDirection = latestDiPlus > latestDiMinus ? "Uptrend (DI+ > DI-)" : "Downtrend (DI- > DI+)";
  }

  return {
    adx: latestAdx,
    diPlus: latestDiPlus,
    diMinus: latestDiMinus,
    trendStrength,
    trendDirection
  };
}

// 11. Aroon Indicator (Aroon Up, Aroon Down)
export function calculateAroon(candles, period = 25) {
  const data = getCandlesWithNumbers(candles);
  if (data.length < period) return null;

  const aroonUpList = [];
  const aroonDownList = [];

  for (let i = period - 1; i < data.length; i++) {
    const subset = data.slice(i - period + 1, i + 1);
    const highs = subset.map(c => c.high);
    const lows = subset.map(c => c.low);

    // Find index of highest high and lowest low
    let highestIndex = 0;
    let highestValue = -Infinity;
    let lowestIndex = 0;
    let lowestValue = Infinity;

    for (let j = 0; j < subset.length; j++) {
      if (highs[j] >= highestValue) {
        highestValue = highs[j];
        highestIndex = j;
      }
      if (lows[j] <= lowestValue) {
        lowestValue = lows[j];
        lowestIndex = j;
      }
    }

    const daysSinceHigh = period - 1 - highestIndex;
    const daysSinceLow = period - 1 - lowestIndex;

    const aroonUp = ((period - daysSinceHigh) / period) * 100;
    const aroonDown = ((period - daysSinceLow) / period) * 100;

    aroonUpList.push(aroonUp);
    aroonDownList.push(aroonDown);
  }

  const latestUp = aroonUpList[aroonUpList.length - 1];
  const latestDown = aroonDownList[aroonDownList.length - 1];
  const oscillator = latestUp - latestDown;

  let state = "Ranging / Consolidation";
  if (latestUp > 70 && latestDown < 30) {
    state = "Strong Uptrend";
  } else if (latestDown > 70 && latestUp < 30) {
    state = "Strong Downtrend";
  } else if (latestUp > latestDown) {
    state = "Bullish bias";
  } else if (latestDown > latestUp) {
    state = "Bearish bias";
  }

  return {
    aroonUp: latestUp,
    aroonDown: latestDown,
    oscillator,
    state
  };
}

// 12. Stochastic Oscillator
export function calculateStochastic(candles, period = 14, smoothK = 3, smoothD = 3) {
  const data = getCandlesWithNumbers(candles);
  if (data.length < period) return null;

  const kValues = [];
  for (let i = period - 1; i < data.length; i++) {
    const subset = data.slice(i - period + 1, i + 1);
    const highs = subset.map(c => c.high);
    const lows = subset.map(c => c.low);
    const highestHigh = Math.max(...highs);
    const lowestLow = Math.min(...lows);
    const currentClose = subset[subset.length - 1].close;

    const k = highestHigh === lowestLow ? 50 : ((currentClose - lowestLow) / (highestHigh - lowestLow)) * 100;
    kValues.push(k);
  }

  if (kValues.length < smoothK) return null;

  // Smooth %K
  const smoothedK = [];
  for (let i = smoothK - 1; i < kValues.length; i++) {
    const window = kValues.slice(i - smoothK + 1, i + 1);
    smoothedK.push(window.reduce((sum, v) => sum + v, 0) / smoothK);
  }

  // Smooth %D (SMA of %K)
  if (smoothedK.length < smoothD) return null;
  const smoothedD = [];
  for (let i = smoothD - 1; i < smoothedK.length; i++) {
    const window = smoothedK.slice(i - smoothD + 1, i + 1);
    smoothedD.push(window.reduce((sum, v) => sum + v, 0) / smoothD);
  }

  const latestK = smoothedK[smoothedK.length - 1];
  const latestD = smoothedD[smoothedD.length - 1];

  let state = "Neutral";
  if (latestK > 80) state = "Overbought";
  else if (latestK < 20) state = "Oversold";

  return {
    k: latestK,
    d: latestD,
    state
  };
}
