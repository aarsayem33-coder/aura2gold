// Pure tests for the 3-Candle Safety Check engine — run: node backend/threeCandle.test.mjs
import assert from 'node:assert';
import { STRATEGIES } from './strategyLab.js';

const evaluate = STRATEGIES['three-candle-combo'].evaluate;
let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log(`  ok  ${name}`); };

const TF = 900000; // M15 in ms
const START = Date.parse('2026-06-26T08:00:00Z'); // confirmation lands in London/NY hours
const mk = (ms, o, h, l, c, v = 100) => ({ time: new Date(ms).toISOString(), open: o, high: h, low: l, close: c, volume: v });

// 40-bar rising base; returns { candles, top } (top = last close).
function baseUptrend(bars = 40, vol = 100) {
  const arr = []; let price = 100;
  for (let k = 0; k < bars; k++) {
    const open = price, close = price + 0.5, high = close + 0.2, low = open - 0.2;
    arr.push(mk(START + k * TF, open, high, low, close, vol));
    price = close;
  }
  return { candles: arr, top: price };
}
const tms = (base) => START + base.length * TF; // next timestamp after the base

// Combo builders (append exactly 3 candles to a base ending at price T).
function shootingStar(T, ms, v = 100) { return mk(ms, T, T + 2, T - 0.1, T + 0.1, v); }   // exhaustion (SELL bias)
function hammer(T, ms, v = 100) { return mk(ms, T, T + 0.2, T - 2, T + 0.1, v); }          // exhaustion (BUY bias)
function dojiBar(T, ms, v = 100) { return mk(ms, T + 0.1, T + 0.5, T - 0.3, T + 0.12, v); } // indecision
function bigBear(T, ms, v = 100) { return mk(ms, T + 0.1, T + 0.2, T - 2, T - 1.8, v); }    // confirmation down (breaks both)
function bigBull(T, ms, v = 100) { return mk(ms, T - 0.1, T + 2, T - 0.2, T + 1.9, v); }    // confirmation up (breaks both)

const cfg = (over = {}) => ({ minRR: 1.5, requireLevel: false, sessionFilter: false, volumeFilter: false, ...over });

// ── Positive: REVERSAL SELL (uptrend → shooting star → doji → bearish breakout, HTF neutral) ──
t('reversal SELL fires on the full sequence', () => {
  const { candles, top } = baseUptrend();
  const ms = tms(candles);
  candles.push(shootingStar(top, ms), dojiBar(top, ms + TF), bigBear(top, ms + 2 * TF));
  const sig = evaluate({ symbol: 'EURUSDM', timeframe: 'M15', candles, pip: 0.0001, h4Trend: null, h1Trend: null, config: cfg() });
  assert.ok(sig, 'should return a signal');
  assert.equal(sig.decision, 'SELL');
  assert.equal(sig.meta.kind, 'REVERSAL');
  assert.ok(sig.stopLoss > sig.entry, 'SELL stop above entry');
  assert.ok(sig.riskRewardRatio >= 1.5);
});

// ── Positive: CONTINUATION BUY (uptrend pullback → hammer → doji → bullish breakout, HTF bullish) ──
t('continuation BUY fires when HTF-aligned', () => {
  const { candles, top } = baseUptrend();
  const ms = tms(candles);
  candles.push(hammer(top, ms), dojiBar(top, ms + TF), bigBull(top, ms + 2 * TF));
  const sig = evaluate({ symbol: 'EURUSDM', timeframe: 'M15', candles, pip: 0.0001, h4Trend: 'BULLISH', h1Trend: 'BULLISH', config: cfg() });
  assert.ok(sig, 'should return a signal');
  assert.equal(sig.decision, 'BUY');
  assert.equal(sig.meta.kind, 'CONTINUATION');
  assert.ok(sig.stopLoss < sig.entry, 'BUY stop below entry');
});

// ── Negative: no indecision (c1 is a big trend candle) ──
t('rejects when the middle candle is not indecision', () => {
  const { candles, top } = baseUptrend();
  const ms = tms(candles);
  candles.push(shootingStar(top, ms), mk(ms + TF, top, top + 2.5, top - 0.1, top + 2.3), bigBear(top, ms + 2 * TF)); // big bull middle
  const sig = evaluate({ symbol: 'EURUSDM', timeframe: 'M15', candles, pip: 0.0001, h4Trend: null, config: cfg() });
  assert.equal(sig, null);
});

// ── Negative: HTF opposes the trade (BUY combo but H4 bearish) ──
t('hard-gates a BUY against a bearish H4', () => {
  const { candles, top } = baseUptrend();
  const ms = tms(candles);
  candles.push(hammer(top, ms), dojiBar(top, ms + TF), bigBull(top, ms + 2 * TF));
  const sig = evaluate({ symbol: 'EURUSDM', timeframe: 'M15', candles, pip: 0.0001, h4Trend: 'BEARISH', config: cfg() });
  assert.equal(sig, null);
});

// ── Negative: confirmation fails to take out both prior candles ──
t('rejects a weak confirmation that does not break both candles', () => {
  const { candles, top } = baseUptrend();
  const ms = tms(candles);
  // small down candle that does NOT close below priorLow
  candles.push(shootingStar(top, ms), dojiBar(top, ms + TF), mk(ms + 2 * TF, top, top + 0.1, top - 0.2, top - 0.05));
  const sig = evaluate({ symbol: 'EURUSDM', timeframe: 'M15', candles, pip: 0.0001, h4Trend: null, config: cfg() });
  assert.equal(sig, null);
});

// ── Filter: volume gate blocks a continuation with no expansion ──
t('volume filter rejects continuation without confirmation expansion', () => {
  const { candles, top } = baseUptrend(40, 100);
  const ms = tms(candles);
  // confirmation volume LOWER than baseline (no expansion)
  candles.push(hammer(top, ms, 100), dojiBar(top, ms + TF, 100), bigBull(top, ms + 2 * TF, 20));
  const sig = evaluate({ symbol: 'EURUSDM', timeframe: 'M15', candles, pip: 0.0001, h4Trend: 'BULLISH', config: cfg({ volumeFilter: true }) });
  assert.equal(sig, null);
});

// ── Filter: level gate blocks a reversal with no significant level (requireLevel) ──
t('requireLevel rejects a reversal at a random level', () => {
  const { candles, top } = baseUptrend();
  const ms = tms(candles);
  candles.push(shootingStar(top, ms), dojiBar(top, ms + TF), bigBear(top, ms + 2 * TF));
  const sig = evaluate({ symbol: 'EURUSDM', timeframe: 'M15', candles, pip: 0.0001, h4Trend: null, config: cfg({ requireLevel: true }) });
  // monotonic base has no prior swing high near the fresh top → no level → gated
  assert.equal(sig, null);
});

console.log(`\nthreeCandle: ${passed} tests passed.`);
