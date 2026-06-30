// Tests for the Fixed-Time Fusion ensemble strategy (registered in strategyLab.js).
// Run: node backend/fixedTimeFusion.test.mjs
import assert from 'node:assert';
import { STRATEGIES, evaluateStrategy, strategyTimeframes } from './strategyLab.js';

let passed = 0;
function test(name, fn) { try { fn(); console.log(`  ok  ${name}`); passed++; } catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; } }

const PIP = 0.0001;
const MIN = 60 * 1000;

// Build N M1 candles. `drift` pips/bar (signed) + small noise; close near the bar extreme in
// the drift direction so body/close-position confirm the trend (feeds the short-horizon read).
function series(n, driftPips, startTime = Date.UTC(2026, 0, 5, 13, 0, 0)) {
  const out = [];
  let price = 1.1000;
  for (let i = 0; i < n; i++) {
    const open = price;
    const move = driftPips * PIP;
    const close = open + move;
    const high = Math.max(open, close) + Math.abs(move) * 0.15;
    const low = Math.min(open, close) - Math.abs(move) * 0.15;
    out.push({
      time: new Date(startTime + i * MIN).toISOString(),
      open, high, low, close, volume: 100 + (i % 5) * 10,
    });
    price = close;
  }
  return out;
}

function ctxFor(candles, over = {}) {
  return { symbol: 'EURUSDM', timeframe: 'M1', candles, pip: PIP, h4Trend: 'NEUTRAL', h1Trend: 'NEUTRAL', ...over };
}

test('registered with M1→H1 timeframes', () => {
  assert.ok(STRATEGIES['fixed-time-fusion'], 'fixed-time-fusion must be in the registry');
  const tfs = strategyTimeframes('fixed-time-fusion');
  assert.ok(tfs.includes('M1') && tfs.includes('H1'), `expected M1..H1, got ${tfs}`);
});

test('returns null (no throw) on insufficient data', () => {
  assert.strictEqual(evaluateStrategy('fixed-time-fusion', ctxFor(series(20, 2))), null);
});

test('never fires SELL on a clean, strong uptrend', () => {
  const sig = evaluateStrategy('fixed-time-fusion', ctxFor(series(120, 3), { h4Trend: 'BULLISH', h1Trend: 'BULLISH' }));
  if (sig) {
    assert.strictEqual(sig.decision, 'BUY', `uptrend should only ever fire BUY, got ${sig.decision}`);
    assert.ok(sig.score >= 72, `score must clear the gate, got ${sig.score}`);
    assert.ok(sig.entry > 0 && sig.stopLoss < sig.entry && sig.takeProfit1 > sig.entry, 'BUY plan geometry must be valid');
    assert.ok(sig.meta && sig.meta.agreeVoters >= 3, `selective: needs >=3 agreeing voters, got ${sig.meta?.agreeVoters}`);
  }
});

test('H4 conflict is a hard veto (never BUY into a bearish H4)', () => {
  const sig = evaluateStrategy('fixed-time-fusion', ctxFor(series(120, 3), { h4Trend: 'BEARISH', h1Trend: 'BEARISH' }));
  assert.ok(sig === null || sig.decision !== 'BUY', `must not BUY against a bearish H4, got ${sig?.decision}`);
});

test('symmetric: never fires BUY on a clean, strong downtrend', () => {
  const sig = evaluateStrategy('fixed-time-fusion', ctxFor(series(120, -3), { h4Trend: 'BEARISH', h1Trend: 'BEARISH' }));
  if (sig) assert.strictEqual(sig.decision, 'SELL', `downtrend should only ever fire SELL, got ${sig.decision}`);
});

test('deterministic — same input yields same output', () => {
  const c = series(120, 3);
  const a = JSON.stringify(evaluateStrategy('fixed-time-fusion', ctxFor(c, { h4Trend: 'BULLISH' })));
  const b = JSON.stringify(evaluateStrategy('fixed-time-fusion', ctxFor(c, { h4Trend: 'BULLISH' })));
  assert.strictEqual(a, b);
});

console.log(`\n${passed} passed`);
