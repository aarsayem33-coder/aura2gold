import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAtr, buildAiMarketContext, formatAiMarketContext, formatDisciplineAdvisory } from './aiMarketContext.js';

// A trending series with real swings, so the structure/liquidity detectors have something to
// find. Zig-zags up so fractal swings alternate rather than forming one straight line.
const series = (n = 160, base = 4000) => Array.from({ length: n }, (_, i) => {
  const wave = Math.sin(i / 7) * 12;
  const drift = i * 0.4;
  const close = base + drift + wave;
  return {
    time: new Date(Date.UTC(2026, 7, 1, 0, i * 15)).toISOString(),
    open: close - 1, high: close + 3, low: close - 3, close, volume: 100 + (i % 9), spread: 0.2,
  };
});
const dailies = Array.from({ length: 16 }, (_, i) => ({
  time: new Date(Date.UTC(2026, 6, 20 + i)).toISOString(),
  open: 3980 + i, high: 4020 + i, low: 3960 + i, close: 4000 + i, volume: 1000,
}));

const RISK = { available: true, settledR: -1.4, dailyStopR: 2, remainingR: 0.6, limitHit: false, wins: 2, losses: 3, openCount: 1 };

// ── resolveAtr: the sd.atr bug ───────────────────────────────────────────────

test('reads ATR off the feature vector, where it actually lives', () => {
  assert.equal(resolveAtr({ systemDecision: { features: { atr: 3.1 } } }), 3.1);
});

test('the REAL systemDecision shape has no top-level atr, so it falls through', () => {
  // This is the exact shape that caused the bug: a decision object with no `atr` key at all.
  const sd = { decision: 'BUY', entryPrice: 4000, stopLoss: 3990, grade: 'A', htfBias: 'BULLISH' };
  assert.equal(resolveAtr({ systemDecision: sd }), null);
  assert.equal(resolveAtr({ systemDecision: sd, breakout: { atr: 2.5 } }), 2.5);
});

test('falls back to breakout ATR, then to atr14 over the candles', () => {
  assert.equal(resolveAtr({ breakout: { atr: 2.5 } }), 2.5);
  const fromCandles = resolveAtr({ candles: series() });
  assert.ok(fromCandles !== null && fromCandles > 0);
});

test('prefers the feature vector over breakout when both are present', () => {
  assert.equal(resolveAtr({ systemDecision: { features: { atr: 3.1 } }, breakout: { atr: 9.9 } }), 3.1);
});

test('returns null — never 0 — when nothing is available', () => {
  // Number(null) === 0 would read as "zero volatility" and make every stop look infinitely wide.
  assert.equal(resolveAtr({}), null);
  assert.equal(resolveAtr({ candles: [] }), null);
});

test('ignores junk values rather than propagating NaN', () => {
  assert.equal(resolveAtr({ systemDecision: { features: { atr: 'abc' } }, breakout: { atr: 2.5 } }), 2.5);
  assert.equal(resolveAtr({ breakout: { atr: Infinity }, candles: null }), null);
});

// ── construction & failure modes ─────────────────────────────────────────────

test('too few candles yields ok:false and both serialisers stay silent', () => {
  // A half-rendered market read is worse than none — it would look authoritative.
  const ctx = buildAiMarketContext({ symbol: 'XAUUSD', timeframe: 'M15', candles: series(10) });
  assert.equal(ctx.ok, false);
  assert.equal(formatAiMarketContext(ctx), '');
});

test('builds a usable context from a normal series', () => {
  const ctx = buildAiMarketContext({ symbol: 'XAUUSD', timeframe: 'M15', candles: series(), dailyCandles: dailies });
  assert.equal(ctx.ok, true);
  assert.ok(['BULLISH', 'BEARISH', 'RANGING'].includes(ctx.structure.bias));
  assert.ok(Array.isArray(ctx.liquidity.levels));
  assert.ok(ctx.atr > 0);
});

test('the kill switch disables enrichment without a redeploy', () => {
  const prev = process.env.AI_CONTEXT_ENRICHMENT;
  process.env.AI_CONTEXT_ENRICHMENT = 'off';
  try {
    const ctx = buildAiMarketContext({ symbol: 'XAUUSD', timeframe: 'M15', candles: series(), dailyCandles: dailies });
    assert.equal(ctx.ok, false);
    assert.equal(ctx.reason, 'disabled');
    assert.equal(formatAiMarketContext(ctx), '');
  } finally {
    if (prev === undefined) delete process.env.AI_CONTEXT_ENRICHMENT; else process.env.AI_CONTEXT_ENRICHMENT = prev;
  }
});

test('no daily candles means no fabricated PDH/PDL, and it says so', () => {
  const ctx = buildAiMarketContext({ symbol: 'XAUUSD', timeframe: 'M15', candles: series(), dailyCandles: null });
  assert.equal(ctx.adr.available, false);
  assert.ok(ctx.caveats.join(' ').includes('PDH/PDL'), 'must disclose that PDH/PDL are unavailable');
  const txt = formatAiMarketContext(ctx);
  assert.ok(!/ADR: \d/.test(txt), 'must not print an ADR figure it does not have');
});

// ── ADR, computed here rather than trusted from systemDecision ───────────────

test('ADR usage is computed locally, not read from a field that is always zero', () => {
  // sd.adrUsagePercent is only populated when aggregateSignals gets adr + dailyHighLow, which
  // the chart path never passes — forwarding it would print a fabricated "0% used".
  const ctx = buildAiMarketContext({
    symbol: 'XAUUSD', timeframe: 'M15', candles: series(), dailyCandles: dailies,
    systemDecision: { adrUsagePercent: 0, adrExhausted: false },
  });
  assert.equal(ctx.adr.available, true);
  assert.ok(ctx.adr.usagePercent > 0, 'a real range must produce a non-zero usage');
});

test('ADR reports the window it actually averaged, not the one requested', () => {
  // The forecast paths supply only 8 daily bars, so the mean is over 7 completed days.
  // Calling that a "14-day average range" in front of the model is fabricated precision.
  const short = dailies.slice(-8);
  const ctx = buildAiMarketContext({ symbol: 'XAUUSD', timeframe: 'M15', candles: series(), dailyCandles: short });
  assert.equal(ctx.adr.available, true);
  assert.equal(ctx.adr.days, 7, 'seven completed bars out of eight supplied');
  assert.ok(ctx.adr.note.startsWith('7-day'), `note claimed: ${ctx.adr.note}`);
  assert.ok(!formatAiMarketContext(ctx).includes('14-day'));
});

// ── level budget ─────────────────────────────────────────────────────────────

test('honours the level cap and always keeps the nearest level each way', () => {
  const ctx = buildAiMarketContext({ symbol: 'XAUUSD', timeframe: 'M15', candles: series(300), dailyCandles: dailies, maxLevels: 6 });
  assert.ok(ctx.liquidity.levels.length <= 6);
  const txt = formatAiMarketContext(ctx, { maxLevels: 6 });
  if (ctx.liquidity.nearestAbove) assert.ok(txt.includes(String(ctx.liquidity.nearestAbove.price)));
  if (ctx.liquidity.nearestBelow) assert.ok(txt.includes(String(ctx.liquidity.nearestBelow.price)));
});

test('invalidated levels are never rendered', () => {
  const ctx = buildAiMarketContext({ symbol: 'XAUUSD', timeframe: 'M15', candles: series(300), dailyCandles: dailies });
  assert.ok(ctx.liquidity.levels.every((l) => l.status !== 'INVALIDATED'));
});

test('the serialised read stays inside its token budget', () => {
  // The guard that stops the liquidity map creeping back into a full dump. ~2600 chars ≈ 650
  // tokens; the prompt has to carry the plan, the doctrine and an image alongside this.
  const ctx = buildAiMarketContext({ symbol: 'XAUUSD', timeframe: 'M15', candles: series(300), dailyCandles: dailies, maxLevels: 12 });
  const txt = formatAiMarketContext(ctx);
  assert.ok(txt.length < 2600, `market read too long: ${txt.length} chars`);
});

test('empty sections still say something rather than vanishing', () => {
  const ctx = buildAiMarketContext({ symbol: 'XAUUSD', timeframe: 'M15', candles: series(), dailyCandles: dailies, includeSweepGrade: false });
  const txt = formatAiMarketContext(ctx);
  assert.ok(txt.includes('GRADED SWEEP SIGNAL:'), 'a missing sweep must read as "none", not disappear');
});

// ── discipline: advisory, and provably so ────────────────────────────────────

test('the advisory block always carries the anti-downgrade rule', () => {
  const txt = formatDisciplineAdvisory({ available: true, ...RISK });
  assert.ok(txt.includes('MUST NOT change your verdict'));
  assert.ok(txt.includes('discipline_note'));
});

test('an overshot stop reads as an overshoot, not as negative room', () => {
  // remainingR goes negative once the stop is blown; "Room remaining: -11R" is nonsense, and
  // leaving a model to interpret a negative quantity of room invites a strange reading.
  const over = formatDisciplineAdvisory({ available: true, ...RISK, settledR: -13, remainingR: -11, limitHit: true });
  assert.ok(over.includes('EXCEEDED by 11R'));
  assert.ok(!over.includes('Room remaining: -'));
  const under = formatDisciplineAdvisory({ available: true, ...RISK });
  assert.ok(under.includes('Room remaining: 0.6R'));
});

test('no risk data means no advisory block at all', () => {
  assert.equal(formatDisciplineAdvisory(null), '');
  assert.equal(formatDisciplineAdvisory({ available: false }), '');
});

test('DISCIPLINE STATE CANNOT LEAK INTO THE MARKET READ', () => {
  // The load-bearing invariant. If the R budget can change one character of the market read,
  // it can change the model's read of the setup — which is exactly the failure this design
  // exists to prevent.
  const args = { symbol: 'XAUUSD', timeframe: 'M15', candles: series(300), dailyCandles: dailies };
  const calm = buildAiMarketContext({ ...args, dailyRisk: { ...RISK, limitHit: false, settledR: 0 } });
  const blown = buildAiMarketContext({ ...args, dailyRisk: { ...RISK, limitHit: true, settledR: -6.2, losses: 9 } });
  assert.equal(formatAiMarketContext(calm), formatAiMarketContext(blown));
});

test('no discipline field appears anywhere under the market branches', () => {
  const ctx = buildAiMarketContext({
    symbol: 'XAUUSD', timeframe: 'M15', candles: series(300), dailyCandles: dailies,
    dailyRisk: { ...RISK, limitHit: true },
  });
  const market = JSON.stringify({
    structure: ctx.structure, liquidity: ctx.liquidity, location: ctx.location,
    sweepSignal: ctx.sweepSignal, drive: ctx.drive, adr: ctx.adr, extension: ctx.extension,
  });
  for (const leak of ['settledR', 'remainingR', 'limitHit', 'dailyStopR']) {
    assert.ok(!market.includes(leak), `${leak} leaked into the market read`);
  }
});

test('discipline survives even when the market read fails', () => {
  // A short series must not cost the human their risk-state warning.
  const ctx = buildAiMarketContext({ symbol: 'XAUUSD', timeframe: 'M15', candles: series(5), dailyRisk: RISK });
  assert.equal(ctx.ok, false);
  assert.equal(ctx.discipline.available, true);
  assert.ok(formatDisciplineAdvisory(ctx.discipline).includes('MUST NOT'));
});

test('over-extension and ADR live in the MARKET read, not the advisory', () => {
  // They are properties of price, not of the account — suppressing them would be lying about
  // the market, and the doctrine already tells the model to weigh location.
  const ctx = buildAiMarketContext({
    symbol: 'XAUUSD', timeframe: 'M15', candles: series(300), dailyCandles: dailies,
    systemDecision: { features: { emaDistanceAtr: 2.7 } }, dailyRisk: RISK,
  });
  const txt = formatAiMarketContext(ctx);
  assert.ok(txt.includes('Over-extension'));
  assert.ok(txt.includes('ADR:'));
  assert.ok(!txt.includes('Daily stop'), 'account state must not appear in the market read');
});

// ── premium/discount honesty ─────────────────────────────────────────────────

test('a HOLD row reports no premium/discount fit rather than a misleading NEUTRAL', () => {
  const ctx = buildAiMarketContext({
    symbol: 'XAUUSD', timeframe: 'M15', candles: series(), dailyCandles: dailies,
    systemDecision: { decision: 'HOLD', premiumDiscount: { pct: 45, zone: 'DISCOUNT', fit: 'NEUTRAL', rangeHigh: 4100, rangeLow: 4000, equilibrium: 4050 } },
  });
  assert.equal(ctx.location.fit, null, 'NEUTRAL on a HOLD means "no side to fit", not "neutral location"');
  assert.ok(!formatAiMarketContext(ctx).includes('fit for the committed side'));
});
