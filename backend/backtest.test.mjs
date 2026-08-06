import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveTrade, summarise, walkForward, applyExecution, VariantLedger, EXECUTION_IDEAL,
} from './backtest.mjs';

const bar = (o, h, l, c, i) => ({
  ts: Date.parse('2026-01-01T00:00:00Z') + i * 3e5, time: new Date(Date.parse('2026-01-01T00:00:00Z') + i * 3e5).toISOString(),
  open: o, high: h, low: l, close: c,
});
const flat = (count, price = 100) => Array.from({ length: count }, (_, i) => bar(price, price + 0.1, price - 0.1, price, i));

// ── resolveTrade: the sequence rules ─────────────────────────────────────────

test('a target reached before the stop is a win, valued in R', () => {
  const bars = [bar(100, 100.5, 99.8, 100, 0), bar(100, 102, 99.9, 101.8, 1)];
  const r = resolveTrade({ decision: 'BUY', entry: 100, stopLoss: 99, takeProfit: 102 }, bars, 0);
  assert.equal(r.outcome, 'WIN');
  assert.equal(r.r, 2, 'reward 2, risk 1 → 2R');
});

test('a stop reached first is a loss of exactly 1R', () => {
  const bars = [bar(100, 100.2, 98.5, 99, 0)];
  const r = resolveTrade({ decision: 'BUY', entry: 100, stopLoss: 99, takeProfit: 102 }, bars, 0);
  assert.equal(r.outcome, 'LOSS');
  assert.equal(r.r, -1);
});

test('one bar straddling BOTH levels is recorded as a LOSS, never a win', () => {
  // This is the single most important rule here: guessing "target" on an ambiguous bar turns
  // losing systems into winning backtests, which is how ict-breaker looked like 97%.
  const bars = [bar(100, 103, 98, 101, 0)];
  const buy = resolveTrade({ decision: 'BUY', entry: 100, stopLoss: 99, takeProfit: 102 }, bars, 0);
  assert.equal(buy.outcome, 'LOSS');
  const sell = resolveTrade({ decision: 'SELL', entry: 100, stopLoss: 101, takeProfit: 98 }, bars, 0);
  assert.equal(sell.outcome, 'LOSS');
});

test('neither level reached is OPEN, not a silent scratch', () => {
  const r = resolveTrade({ decision: 'BUY', entry: 100, stopLoss: 99, takeProfit: 102 }, flat(50), 0);
  assert.equal(r.outcome, 'OPEN');
  assert.equal(r.r, 0);
});

test('a target on the losing side is INVALID, never an instant win', () => {
  // A mis-specified ticket must not be able to score. This is the 10016 case: TP already
  // behind the market.
  const bars = [bar(100, 101, 99, 100, 0)];
  assert.equal(resolveTrade({ decision: 'BUY', entry: 100, stopLoss: 99, takeProfit: 99.5 }, bars, 0).outcome, 'INVALID');
  assert.equal(resolveTrade({ decision: 'SELL', entry: 100, stopLoss: 101, takeProfit: 100.5 }, bars, 0).outcome, 'INVALID');
});

test('a stop on the winning side is INVALID', () => {
  const bars = [bar(100, 101, 99, 100, 0)];
  assert.equal(resolveTrade({ decision: 'BUY', entry: 100, stopLoss: 101, takeProfit: 102 }, bars, 0).outcome, 'INVALID');
});

test('missing or zero-risk geometry is INVALID rather than a divide by zero', () => {
  const bars = [bar(100, 101, 99, 100, 0)];
  for (const sig of [
    { decision: 'BUY', entry: 100, stopLoss: 100, takeProfit: 102 },
    { decision: 'BUY', entry: null, stopLoss: 99, takeProfit: 102 },
    { decision: 'BUY', entry: 100, stopLoss: 99, takeProfit: null },
  ]) assert.equal(resolveTrade(sig, bars, 0).outcome, 'INVALID');
});

test('SELL mirrors BUY exactly', () => {
  const up = [bar(100, 100.2, 99.9, 100, 0), bar(100, 102.5, 99.9, 102, 1)];
  const dn = [bar(100, 100.1, 99.8, 100, 0), bar(100, 100.1, 97.5, 98, 1)];
  const b = resolveTrade({ decision: 'BUY', entry: 100, stopLoss: 99, takeProfit: 102 }, up, 0);
  const s = resolveTrade({ decision: 'SELL', entry: 100, stopLoss: 101, takeProfit: 98 }, dn, 0);
  assert.equal(b.outcome, s.outcome);
  assert.equal(b.r, s.r);
});

// ── summarise: expectancy leads ──────────────────────────────────────────────

test('expectancy exposes a high win rate that loses money', () => {
  // Nine wins at 0.1R and one loss at -1R: 90% "win rate", negative expectancy. This exact
  // shape is what the ict-breaker lateness buckets looked like.
  const trades = [...Array(9).fill({ outcome: 'WIN', r: 0.1, bars: 1 }), { outcome: 'LOSS', r: -1, bars: 1 }];
  const s = summarise(trades);
  assert.equal(s.winRate, 0.9);
  assert.ok(s.expectancy < 0, `expectancy ${s.expectancy} must be negative`);
});

test('expectancy rewards a low win rate with real reward', () => {
  const trades = [...Array(4).fill({ outcome: 'WIN', r: 3, bars: 1 }), ...Array(6).fill({ outcome: 'LOSS', r: -1, bars: 1 })];
  const s = summarise(trades);
  assert.equal(s.winRate, 0.4);
  assert.ok(Math.abs(s.expectancy - 0.6) < 1e-9);
});

test('OPEN and INVALID are counted but never dilute expectancy', () => {
  const s = summarise([
    { outcome: 'WIN', r: 2, bars: 1 }, { outcome: 'LOSS', r: -1, bars: 1 },
    { outcome: 'OPEN', r: 0, bars: 9 }, { outcome: 'INVALID', r: 0, bars: 0 },
  ]);
  assert.equal(s.signals, 4);
  assert.equal(s.settled, 2);
  assert.equal(s.open, 1);
  assert.equal(s.invalid, 1);
  assert.equal(s.expectancy, 0.5, 'only settled trades count');
});

test('drawdown and losing streak are reported — a win rate hides both', () => {
  const s = summarise([
    { outcome: 'WIN', r: 1, bars: 1 },
    { outcome: 'LOSS', r: -1, bars: 1 }, { outcome: 'LOSS', r: -1, bars: 1 }, { outcome: 'LOSS', r: -1, bars: 1 },
    { outcome: 'WIN', r: 1, bars: 1 },
  ]);
  assert.equal(s.worstLossStreak, 3);
  assert.equal(s.maxDrawdownR, 3);
});

test('an empty set yields NaN expectancy, not a misleading zero', () => {
  const s = summarise([]);
  assert.ok(Number.isNaN(s.expectancy));
  assert.equal(s.settled, 0);
});

// ── execution ────────────────────────────────────────────────────────────────

test('cost always moves the fill AGAINST the trade', () => {
  const bars = flat(10, 100);
  const b = applyExecution({ decision: 'BUY', entry: 100 }, bars, 0, { spread: 0.5 });
  const s = applyExecution({ decision: 'SELL', entry: 100 }, bars, 0, { spread: 0.5 });
  assert.equal(b.entry, 100.5, 'a buy pays up');
  assert.equal(s.entry, 99.5, 'a sell receives less');
});

test('lateness moves the fill to a later bar open', () => {
  const bars = [bar(100, 101, 99, 100, 0), bar(105, 106, 104, 105, 1), bar(110, 111, 109, 110, 2)];
  const f = applyExecution({ decision: 'BUY', entry: 100 }, bars, 0, { latenessBars: 2 });
  assert.equal(f.entry, 110, 'filled at the bar-2 open, not the named price');
  assert.equal(f.fillIdx, 2);
});

test('execution shrinks reward and grows risk at once', () => {
  // The asymmetry that made live results diverge: the stop and target stay put while only the
  // entry drifts, so a late fill is punished twice.
  const bars = [bar(100, 100.1, 99.9, 100, 0), bar(101, 103, 100.9, 102.5, 1), bar(102.5, 103, 98, 99, 2)];
  const ideal = resolveTrade({ decision: 'BUY', entry: 100, stopLoss: 99, takeProfit: 103 }, bars, 0);
  const late = applyExecution({ decision: 'BUY', entry: 100, stopLoss: 99, takeProfit: 103 }, bars, 0, { latenessBars: 1 });
  const real = resolveTrade({ ...late }, bars, late.fillIdx);
  assert.equal(ideal.outcome, 'WIN');
  assert.ok(real.r < ideal.r, `late fill must earn less R (${real.r} vs ${ideal.r})`);
});

// ── walkForward: no lookahead, dedup ─────────────────────────────────────────

test('the evaluator never sees a bar beyond the current index', () => {
  const cs = flat(60, 100);
  let maxSeen = -1;
  walkForward({
    candles: cs, fineBars: cs, warmup: 10,
    evaluate: (window, i) => { maxSeen = Math.max(maxSeen, window.length - 1 - i); return null; },
  });
  assert.equal(maxSeen, 0, 'window must end exactly at i — any surplus is lookahead');
});

test('the window is BOUNDED, matching what the live lab actually hands an engine', () => {
  // Production calls getRecentCandles(symbol, tf, 400). An unbounded window would both be
  // unfaithful and make the per-bar slice O(n) — a 237k-bar run then never finishes.
  const cs = flat(1200, 100);
  let widest = 0;
  walkForward({
    candles: cs, fineBars: cs, warmup: 10, windowBars: 400,
    evaluate: (window) => { widest = Math.max(widest, window.length); return null; },
  });
  assert.ok(widest <= 400, );
  assert.ok(widest >= 399, 'and should actually reach the cap');
});

test('the last bar of the window is always the decision bar', () => {
  const cs = flat(900, 100).map((b, i) => ({ ...b, close: 100 + i }));
  let ok = true;
  walkForward({
    candles: cs, fineBars: cs, warmup: 10, windowBars: 300,
    evaluate: (window, i, meta) => {
      if (window[i].close !== cs[meta.absoluteIndex].close) ok = false;
      return null;
    },
  });
  assert.ok(ok, 'window[i] must be the same bar as the absolute index');
});

test('one setup spanning many bars produces ONE trade', () => {
  // Without dedup a six-bar setup becomes six trades and every statistic inflates.
  const cs = flat(60, 100);
  const trades = walkForward({
    candles: cs, fineBars: cs, warmup: 10,
    evaluate: () => ({ decision: 'BUY', entry: 100, stopLoss: 99, takeProfit: 102, barIso: 'same-setup' }),
  });
  assert.equal(trades.length, 1);
});

test('entry is never taken on the bar the decision was made on', () => {
  const cs = [...flat(12, 100), bar(100, 100, 100, 100, 12), bar(100, 103, 100, 103, 13), ...flat(6, 103).map((b, k) => bar(103, 103.1, 102.9, 103, 14 + k))];
  const trades = walkForward({
    candles: cs, fineBars: cs, warmup: 10,
    evaluate: (w, i) => (i === 12 ? { decision: 'BUY', entry: 100, stopLoss: 99, takeProfit: 102, barIso: 'x' } : null),
  });
  assert.equal(trades.length, 1);
  assert.ok(trades[0].outcome !== 'INVALID');
});

test('the date window is respected', () => {
  const cs = flat(80, 100);
  const mid = cs[40].ts;
  const before = walkForward({ candles: cs, fineBars: cs, warmup: 5, to: mid, evaluate: (w, i) => ({ decision: 'BUY', entry: 100, stopLoss: 99, takeProfit: 102, barIso: `b${i}` }) });
  const after = walkForward({ candles: cs, fineBars: cs, warmup: 5, from: mid, evaluate: (w, i) => ({ decision: 'BUY', entry: 100, stopLoss: 99, takeProfit: 102, barIso: `b${i}` }) });
  assert.ok(before.length > 0 && after.length > 0);
  assert.ok(before.every((t) => t.ts < mid));
  assert.ok(after.every((t) => t.ts >= mid));
});

test('an evaluator that throws does not take the run down', () => {
  const cs = flat(40, 100);
  const trades = walkForward({
    candles: cs, fineBars: cs, warmup: 5,
    evaluate: (w, i) => { if (i % 2) throw new Error('boom'); return null; },
  });
  assert.deepEqual(trades, []);
});

// ── ledger ───────────────────────────────────────────────────────────────────

test('the ledger counts every variant and the false positives they imply', () => {
  const L = new VariantLedger('orb');
  for (let i = 0; i < 24; i++) L.record(`v${i}`, { p: i }, { expectancy: i / 100 });
  assert.equal(L.count, 24);
  assert.ok(Math.abs(L.expectedFalsePositives(0.05) - 1.2) < 1e-9, '24 variants ≈ 1.2 false winners at p<0.05');
  assert.equal(L.best().name, 'v23');
});

test('the ledger ignores unusable metrics when picking a best', () => {
  const L = new VariantLedger();
  L.record('a', {}, { expectancy: NaN });
  L.record('b', {}, { expectancy: 0.2 });
  assert.equal(L.best().name, 'b');
  const empty = new VariantLedger();
  empty.record('x', {}, { expectancy: NaN });
  assert.equal(empty.best(), null);
});

test('the report carries the variant count alongside the winner', () => {
  const L = new VariantLedger('test');
  L.record('a', {}, { expectancy: 0.1 });
  L.record('b', {}, { expectancy: 0.3 });
  const r = L.report();
  assert.equal(r.variantsTested, 2);
  assert.equal(r.best.name, 'b');
  assert.equal(r.all.length, 2);
});

test('the ideal execution profile really is free', () => {
  assert.deepEqual(EXECUTION_IDEAL, { spread: 0, slippageAtr: 0, latenessBars: 0 });
});
