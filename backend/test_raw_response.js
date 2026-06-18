import dotenv from 'dotenv';
import path from 'path';

// Force load env
dotenv.config({ path: './.env.local' });

const { buildAiSignalsPrompt, isGeminiConfigured } = await import('./geminiEngine.js');

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

const prompt = buildAiSignalsPrompt({
  symbol: 'AUDCADm',
  tradeMode: 'FTT',
  indicators,
  news: [],
  currentPrice: 0.98849
});

const body = JSON.stringify({
  contents: [{ role: 'user', parts: [{ text: prompt }] }],
  generationConfig: {
    temperature: 0.15,
    topP: 0.9,
    maxOutputTokens: 8192,
    responseMimeType: 'application/json',
    thinkingConfig: {
      thinkingBudget: 0
    }
  }
});

const apiKey = process.env.GEMINI_API_KEY;
const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

async function run() {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    
    console.log('Status:', res.status);
    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    console.log('RAW MODEL RESPONSE:\n', JSON.stringify(json, null, 2));
  } catch (err) {
    console.error('Error:', err.message);
  }
}

run();
