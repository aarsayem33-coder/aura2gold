import dotenv from 'dotenv';
import path from 'path';

// Force load env
dotenv.config({ path: './.env.local' });

const { analyzeAiSignalsWithGemini } = await import('./geminiEngine.js');

console.log('API KEY:', process.env.GEMINI_API_KEY ? 'present' : 'absent');

const indicators = {
  currentPrice: 0.98849,
  atr: 0.0012,
  adr: 0.0080,
  dailyHigh: 0.9920,
  dailyLow: 0.9850,
  rsi: 45,
  macd: { main: 0.0001, signal: 0.0002, hist: -0.0001 },
  bb: { upper: 0.9910, middle: 0.9880, lower: 0.9850 },
  ema20: 0.9882,
  ema50: 0.9875,
  ema200: 0.9820,
  japanesePearl: 'HOLD',
  japaneseTrend: 'NEUTRAL'
};

const result = await analyzeAiSignalsWithGemini({
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
  location: process.env.GOOGLE_CLOUD_LOCATION,
  model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  symbol: 'AUDCADm',
  tradeMode: 'FTT',
  indicators,
  news: [],
  currentPrice: 0.98849
});

console.log('Result:', JSON.stringify(result, null, 2));
