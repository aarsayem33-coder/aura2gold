// Tests for the Books-Institutional pair (registered in strategyLab.js) — the fused
// engine distilled from the 7 trading books in GUIDES/KNOWLEDGE. Two engines, two
// behaviours: forex = level trade with structural stop/targets; fixed-time = veto-first
// next-candle call. Run: node backend/booksInstitutional.test.mjs
import assert from 'node:assert';
import { STRATEGIES, evaluateStrategy, strategyTimeframes } from './strategyLab.js';

let passed = 0;
function test(name, fn) { try { fn(); console.log(`  ok  ${name}`); passed++; } catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; } }

const PIP = 0.0001;
const MIN = 15 * 60 * 1000; // M15 bars

// Realistic trending tape: drift + sine swing + deterministic pseudo-noise, with
// proportional wicks (never tied highs/lows, so fractal swings can form).
function wavy(count, driftPips, { start = 1.1000, amp = 20, period = 30, startTime = Date.UTC(2026, 0, 5, 8, 0, 0), volume = null } = {}) {
  const out = [];
  let prevClose = start;
  for (let i = 0; i < count; i++) {
    const base = start + (driftPips * i + amp * Math.sin((2 * Math.PI * i) / period)) * PIP;
    const close = base + ((i * 7919) % 13 - 6) * 0.3 * PIP;
    const open = prevClose;
    const wick = 0.4 * Math.abs(close - open) + ((i * 31) % 7) * 0.2 * PIP;
    out.push({
      time: new Date(startTime + i * MIN).toISOString(),
      open, high: Math.max(open, close) + wick, low: Math.min(open, close) - wick, close, volume,
    });
    prevClose = close;
  }
  return out;
}

// Monotone drift (tied wicks by design — a degenerate tape both engines must survive).
function monotone(count, driftPips) {
  const out = [];
  let price = 1.1000;
  for (let i = 0; i < count; i++) {
    const open = price, close = open + driftPips * PIP;
    out.push({
      time: new Date(Date.UTC(2026, 0, 5, 8, 0, 0) + i * MIN).toISOString(),
      open, high: Math.max(open, close) + 2 * PIP, low: Math.min(open, close) - 2 * PIP, close, volume: null,
    });
    price = close;
  }
  return out;
}

function ctxFor(candles, over = {}) {
  return { symbol: 'EURUSDM', timeframe: 'M15', candles, pip: PIP, h4Trend: 'NEUTRAL', h1Trend: 'NEUTRAL', ...over };
}

// Walk the tape forward; collect every fire (prefix-by-prefix, like the live scanner).
function walk(strategy, candles, over = {}) {
  const fires = [];
  for (let end = 140; end <= candles.length; end++) {
    const sig = evaluateStrategy(strategy, ctxFor(candles.slice(0, end), over));
    if (sig) fires.push(sig);
  }
  return fires;
}

const BULL_TAPE = wavy(400, 1.5);
const BEAR_TAPE = wavy(400, -1.5, { start: 1.1600 });

// ── registration ─────────────────────────────────────────────────────────────
test('both engines are registered with their intended timeframes', () => {
  assert.ok(STRATEGIES['books-institutional-forex'], 'forex twin must be in the registry');
  assert.ok(STRATEGIES['books-institutional-fixed-time'], 'fixed-time twin must be in the registry');
  const fx = strategyTimeframes('books-institutional-forex');
  const ft = strategyTimeframes('books-institutional-fixed-time');
  assert.ok(fx.includes('M15') && fx.includes('H4') && !fx.includes('M1'), `forex = M15..H4 (books: no M1 price action), got ${fx}`);
  assert.ok(ft.includes('M1') && ft.includes('H1'), `fixed-time = M1..H1, got ${ft}`);
});

// ── shared safety ────────────────────────────────────────────────────────────
test('both return null (no throw) on insufficient data', () => {
  assert.strictEqual(evaluateStrategy('books-institutional-forex', ctxFor(wavy(60, 2))), null);
  assert.strictEqual(evaluateStrategy('books-institutional-fixed-time', ctxFor(wavy(60, 2))), null);
});

test('choppy tape is vetoed by both (the unanimous first gate)', () => {
  const flat = wavy(200, 0, { amp: 2, period: 10 });
  for (let end = 140; end <= flat.length; end += 10) {
    assert.strictEqual(evaluateStrategy('books-institutional-forex', ctxFor(flat.slice(0, end))), null);
    assert.strictEqual(evaluateStrategy('books-institutional-fixed-time', ctxFor(flat.slice(0, end))), null);
  }
});

test('H4 conflict is a hard veto for both (never BUY into a bearish H4)', () => {
  const fx = walk('books-institutional-forex', BULL_TAPE, { h4Trend: 'BEARISH', h1Trend: 'BEARISH' });
  assert.ok(fx.every((s) => s.decision !== 'BUY'), `forex must never BUY against a bearish H4 (${fx.length} fires)`);
  const ft = walk('books-institutional-fixed-time', BULL_TAPE, { h4Trend: 'BEARISH', h1Trend: 'BEARISH' });
  assert.ok(ft.every((s) => s.decision !== 'BUY'), `fixed-time must never BUY against a bearish H4 (${ft.length} fires)`);
});

// ── forex twin ───────────────────────────────────────────────────────────────
test('forex: fires on a trending tape, always with-trend, valid ≥2R ladder at a level', () => {
  const fires = walk('books-institutional-forex', BULL_TAPE, { h4Trend: 'BULLISH', h1Trend: 'BULLISH' });
  assert.ok(fires.length >= 1, 'must fire at least once on a 400-bar trending tape');
  for (const s of fires) {
    assert.strictEqual(s.decision, 'BUY', `bullish tape must only fire BUY, got ${s.decision}`);
    assert.ok(s.score >= 68, `score must clear the gate, got ${s.score}`);
    assert.ok(s.stopLoss < s.entry && s.takeProfit1 > s.entry && s.takeProfit2 > s.takeProfit1 && s.takeProfit3 > s.takeProfit2, 'BUY ladder must be ordered');
    assert.ok(s.riskRewardRatio >= 2, `books forex rule: >=2R, got ${s.riskRewardRatio}`);
    assert.ok(s.meta && s.meta.levelKind, 'must report the level it traded at');
    assert.ok(['ENGULFING', 'PIN', 'BREAKOUT'].includes(s.meta.trigger), `trigger must be a books trigger, got ${s.meta.trigger}`);
  }
});

test('forex: symmetric — bearish tape fires only SELL with valid geometry', () => {
  const fires = walk('books-institutional-forex', BEAR_TAPE, { h4Trend: 'BEARISH', h1Trend: 'BEARISH' });
  assert.ok(fires.length >= 1, 'must fire at least once on a 400-bar bearish tape');
  for (const s of fires) {
    assert.strictEqual(s.decision, 'SELL', `bearish tape must only fire SELL, got ${s.decision}`);
    assert.ok(s.stopLoss > s.entry && s.takeProfit1 < s.entry && s.takeProfit3 < s.takeProfit2, 'SELL ladder must be ordered');
  }
});

// ── fixed-time twin ──────────────────────────────────────────────────────────
test('fixed-time: fires on a swinging trend tape, always with-trend, ATR-framed', () => {
  const fires = walk('books-institutional-fixed-time', BULL_TAPE, { h4Trend: 'BULLISH', h1Trend: 'BULLISH' });
  assert.ok(fires.length >= 1, 'must fire at least once on a 400-bar swinging tape');
  for (const s of fires) {
    assert.strictEqual(s.decision, 'BUY', `bullish tape must only call UP, got ${s.decision}`);
    assert.ok(s.score >= 70, `score must clear the gate, got ${s.score}`);
    assert.ok(s.meta.freePathAtr >= 0.6, `needs clearance ahead, got ${s.meta.freePathAtr}`);
    assert.ok(s.meta.run < 3, `never on the 3rd same-color candle, got run=${s.meta.run}`);
    assert.ok(s.stopLoss < s.entry && s.takeProfit1 > s.entry, 'UP framing must be valid');
  }
});

test('fixed-time: monotone climax tape stays silent (exhaustion/over-extension vetoes)', () => {
  const fires = walk('books-institutional-fixed-time', monotone(300, 3), { h4Trend: 'BULLISH', h1Trend: 'BULLISH' });
  assert.strictEqual(fires.length, 0, `monotone one-way tape must never produce a next-candle call, got ${fires.length}`);
});

test('fixed-time: doji last bar is vetoed (indecision)', () => {
  const tape = BULL_TAPE.slice(0, 200);
  const last = tape[tape.length - 1];
  const mid = (Number(last.open) + Number(last.close)) / 2;
  tape[tape.length - 1] = { ...last, open: mid - 0.2 * PIP, close: mid + 0.2 * PIP, high: mid + 5 * PIP, low: mid - 5 * PIP };
  const sig = evaluateStrategy('books-institutional-fixed-time', ctxFor(tape, { h4Trend: 'BULLISH', h1Trend: 'BULLISH' }));
  assert.strictEqual(sig, null, `doji must be vetoed, got ${sig?.decision}`);
});

// ── determinism (lab law: pure evaluate) ────────────────────────────────────
test('deterministic — same input yields same output (both engines)', () => {
  for (const id of ['books-institutional-forex', 'books-institutional-fixed-time']) {
    const a = JSON.stringify(evaluateStrategy(id, ctxFor(BULL_TAPE, { h4Trend: 'BULLISH', h1Trend: 'BULLISH' })));
    const b = JSON.stringify(evaluateStrategy(id, ctxFor(BULL_TAPE, { h4Trend: 'BULLISH', h1Trend: 'BULLISH' })));
    assert.strictEqual(a, b, `${id} must be pure`);
  }
});

console.log(`\n${passed} passed`);
