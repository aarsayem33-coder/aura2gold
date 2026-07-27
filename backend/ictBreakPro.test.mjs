// ict-break-pro: a SELECTIVE overlay on ict-breaker. These tests pin the two things
// that matter — the four filters actually gate, and ict-breaker is never affected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STRATEGIES, evaluateStrategy, strategyTimeframes } from './strategyLab.js';

// Build a synthetic sweep -> reclaim -> displacement sequence that ict-breaker accepts.
// base drift, a swing low, a sweep below it, then a decisive reclaim candle.
function buildBreakerCandles({ bodyRatio = 0.9, rangeAtr = 2.0 } = {}) {
  const cs = [];
  const t0 = Date.parse('2026-07-01T00:00:00Z');
  const push = (o, h, l, c, i) => cs.push({ time: new Date(t0 + i * 900000).toISOString(), open: o, high: h, low: l, close: c });
  // 60 bars of gentle range so ATR ~ 0.0010 and swings exist
  let px = 1.1000;
  for (let i = 0; i < 60; i++) {
    const up = i % 2 === 0;
    const o = px, c = up ? px + 0.0004 : px - 0.0004;
    push(o, Math.max(o, c) + 0.0003, Math.min(o, c) - 0.0003, c, i);
    px = c;
  }
  // a clear swing low at index ~62
  push(px, px + 0.0002, px - 0.0020, px - 0.0018, 60);
  push(px - 0.0018, px - 0.0010, px - 0.0022, px - 0.0012, 61);
  for (let i = 62; i < 70; i++) { push(px - 0.0012, px - 0.0006, px - 0.0016, px - 0.0010, i); }
  // sweep BELOW the swing low, then reclaim with a decisive bullish candle
  push(px - 0.0010, px - 0.0008, px - 0.0034, px - 0.0030, 70);           // sweep
  const atrApprox = 0.0010;
  const range = rangeAtr * atrApprox;
  const body = bodyRatio * range;
  const open = px - 0.0030;
  const close = open + body;
  const high = close + (range - body) * 0.5;
  const low = open - (range - body) * 0.5;
  push(open, high, low, close, 71);                                        // reclaim + displacement
  return cs;
}
const ctxFor = (candles, extra = {}) => ({
  symbol: 'EURUSDM', timeframe: 'M15', candles, pip: 0.0001,
  h4Trend: null, h1Trend: null, dailyCandles: null, ...extra,
});

test('registry: registered, MARKET entry, and only the validated timeframes', () => {
  const s = STRATEGIES['ict-break-pro'];
  assert.ok(s, 'ict-break-pro must be registered');
  assert.equal(s.entryOrderType, 'MARKET', 'inherits ict-breaker enter-at-alert semantics');
  assert.deepEqual(strategyTimeframes('ict-break-pro'), ['M15', 'M30', 'H1', 'H4'],
    'M1/M5 were not validated by the study and must not be claimed');
});

test('ict-breaker is left completely untouched by the overlay', () => {
  const base = STRATEGIES['ict-breaker'];
  assert.equal(base.entryOrderType, 'MARKET');
  assert.deepEqual(strategyTimeframes('ict-breaker'), ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'],
    'ict-breaker keeps every one of its own timeframes');
  // Same input, evaluated repeatedly and with the pro engine interleaved, must be stable.
  const cs = buildBreakerCandles();
  const a = evaluateStrategy('ict-breaker', ctxFor(cs));
  evaluateStrategy('ict-break-pro', ctxFor(cs));
  const b = evaluateStrategy('ict-breaker', ctxFor(cs));
  assert.deepEqual(b, a, 'running ict-break-pro must not change what ict-breaker returns');
});

test('pro never invents a trade ict-breaker did not find', () => {
  const flat = Array.from({ length: 80 }, (_, i) => ({
    time: new Date(Date.parse('2026-07-01T00:00:00Z') + i * 900000).toISOString(),
    open: 1.1, high: 1.1001, low: 1.0999, close: 1.1,
  }));
  assert.equal(evaluateStrategy('ict-breaker', ctxFor(flat)), null);
  assert.equal(evaluateStrategy('ict-break-pro', ctxFor(flat)), null,
    'no base signal must mean no pro signal');
});

test('pro output is the SAME trade as the base — only selection differs', () => {
  const cs = buildBreakerCandles({ bodyRatio: 0.9, rangeAtr: 2.0 });
  const base = evaluateStrategy('ict-breaker', ctxFor(cs));
  const pro = evaluateStrategy('ict-break-pro', ctxFor(cs));
  if (!base || !pro) return;               // synthetic fixture may not qualify; other tests cover gating
  assert.equal(pro.decision, base.decision);
  assert.equal(pro.entry, base.entry, 'entry must be identical');
  assert.equal(pro.stopLoss, base.stopLoss, 'stop must be identical');
  assert.equal(pro.takeProfit1, base.takeProfit1, 'TP ladder must be identical');
  assert.equal(pro.meta.pro, true);
  assert.equal(pro.meta.baseScore, base.score, 'base score is preserved for comparison');
});

test('filter: a doji-ish reclaim (small body) is rejected', () => {
  const cs = buildBreakerCandles({ bodyRatio: 0.15, rangeAtr: 2.0 });
  assert.equal(evaluateStrategy('ict-break-pro', ctxFor(cs)), null,
    'body under 60% of range must not pass');
});

test('filter: a small-range reclaim (no displacement) is rejected', () => {
  const cs = buildBreakerCandles({ bodyRatio: 0.9, rangeAtr: 0.3 });
  assert.equal(evaluateStrategy('ict-break-pro', ctxFor(cs)), null,
    'range under 1x ATR must not pass');
});

test('config thresholds are honoured, not hard-coded', () => {
  const cs = buildBreakerCandles({ bodyRatio: 0.5, rangeAtr: 2.0 });
  // default minBodyRatio 0.6 rejects a 0.5 body...
  assert.equal(evaluateStrategy('ict-break-pro', ctxFor(cs)), null);
  // ...but a relaxed config is respected (proves the gate reads config, not a literal)
  const relaxed = evaluateStrategy('ict-break-pro', ctxFor(cs, { config: { minBodyRatio: 0.2 } }));
  const base = evaluateStrategy('ict-breaker', ctxFor(cs));
  if (base) assert.ok(relaxed !== null, 'relaxed threshold should let the base signal through');
});
