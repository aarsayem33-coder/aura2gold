import assert from 'node:assert/strict';
import test from 'node:test';
import { matchTradeToForecast, strategyMatchRates, resolveWindow, RATE_WINDOWS } from './forecastMatch.js';

const PIP = 0.1;   // gold
const fc = (over = {}) => ({
  id: 'XAUUSD|M15|4064.96000|SWEEP_REJECT|1', symbol: 'XAUUSD', timeframe: 'M15',
  scenario: 'SWEEP_REJECT', level: 4064.96, atr: 9, levelType: 'NY_LOW', levelLabel: 'New York low',
  expectedDirection: 'BUY', bestScore: 95, bestStrategy: 'h4-liquidity-pin-entry',
  fires: [{ strategyId: 'h4-liquidity-pin-entry', agrees: true }, { strategyId: 'liquidity-trap', agrees: true }],
  plan: { direction: 'BUY', entry: 4066.95, stopLoss: 4062.6 },
  ...over,
});
const trade = (over = {}) => ({ symbol: 'XAUUSD', timeframe: 'M15', direction: 'BUY', entry: 4066.95, strategy: 'h4-liquidity-pin-entry', ...over });
const match = (t, fs = [fc()], opts = {}) => matchTradeToForecast(t, fs, { pip: PIP, ...opts });

// ── trade ↔ forecast ─────────────────────────────────────────────────────────

test('an exact entry on the same timeframe is a STRONG match', () => {
  const m = match(trade());
  assert.ok(m);
  assert.equal(m.strength, 'STRONG');
  assert.equal(m.forecastId, fc().id);
  assert.equal(m.level, 4064.96);
  assert.ok(m.confidence >= 75);
  assert.ok(m.reasons.some((r) => /same timeframe/.test(r)));
  assert.ok(m.reasons.some((r) => /backing it/.test(r)));
});

test('a trade near the level but off the entry is CLOSE, not STRONG', () => {
  // 20 pips from the forecast entry: recognisable, but not the same fill.
  const m = match(trade({ entry: 4064.95, strategy: null, timeframe: null }));
  assert.ok(m);
  assert.equal(m.strength, 'CLOSE');
  assert.ok(m.confidence < 75);
});

test('the opposite direction is never a match', () => {
  assert.equal(match(trade({ direction: 'SELL' })), null);
});

test('a different instrument is never a match', () => {
  assert.equal(match(trade({ symbol: 'EURUSD' })), null);
});

test('a broker suffix still matches the unsuffixed forecast', () => {
  // The same defect that silently broke one-per-symbol would silently break this label.
  const m = match(trade({ symbol: 'XAUUSDm' }));
  assert.ok(m, 'XAUUSDm must match an XAUUSD forecast');
  assert.equal(m.strength, 'STRONG');
});

test('a trade far from every forecast returns nothing rather than a weak guess', () => {
  assert.equal(match(trade({ entry: 4200 })), null, 'an absent label beats a wrong one');
});

test('the closest of several forecasts wins and the rest are counted', () => {
  const near = fc({ id: 'near', level: 4064.96, plan: { direction: 'BUY', entry: 4066.9 } });
  const far = fc({ id: 'far', level: 4040, plan: { direction: 'BUY', entry: 4041 } });
  const m = match(trade({ entry: 4066.95 }), [far, near]);
  assert.equal(m.forecastId, 'near');
  // `far` is 260 pips away and scores nothing, so it is not counted as an alternative.
  assert.equal(m.alternatives, 0);
});

test('a forecast with no ticket can still match on its level alone', () => {
  const m = match(trade({ entry: 4064.9, strategy: null }), [fc({ plan: null })]);
  assert.ok(m, 'the level is a valid anchor when no plan exists');
  assert.equal(m.strength, 'CLOSE');
});

test('matching degrades safely', () => {
  assert.equal(match(null), null);
  assert.equal(matchTradeToForecast(trade(), [], { pip: PIP }), null);
  assert.equal(matchTradeToForecast(trade(), [fc()], { pip: null }), null);
  assert.equal(match(trade({ entry: null })), null);
  assert.equal(match(trade({ direction: '' })), null);
});

test('snake_case entry from the DB is accepted', () => {
  const m = matchTradeToForecast(
    { symbol: 'XAUUSD', direction: 'BUY', entry_price: 4066.95, timeframe: 'M15' },
    [fc()], { pip: PIP },
  );
  assert.ok(m);
});

// ── windows ──────────────────────────────────────────────────────────────────

const NOW = Date.parse('2026-07-31T09:00:00.000Z');
const BD = 360;   // UTC+6

test('today and yesterday follow the local day, not UTC', () => {
  // At 09:00 UTC in UTC+6 it is 15:00 local, so "today" started at 18:00 UTC the day before.
  const t = resolveWindow('today', { now: NOW, offsetMinutes: BD });
  assert.equal(new Date(t.from).toISOString(), '2026-07-30T18:00:00.000Z');
  assert.equal(t.to, NOW);
  const y = resolveWindow('yesterday', { now: NOW, offsetMinutes: BD });
  assert.equal(new Date(y.from).toISOString(), '2026-07-29T18:00:00.000Z');
  assert.equal(y.to, t.from, 'yesterday must end exactly where today begins');
});

test('rolling windows span the expected duration', () => {
  const d7 = resolveWindow('7d', { now: NOW });
  assert.equal(Math.round((d7.to - d7.from) / 86400000), 7);
  assert.equal(Math.round((resolveWindow('30d', { now: NOW }).to - resolveWindow('30d', { now: NOW }).from) / 86400000), 30);
});

test('a custom range is honoured and validated', () => {
  const c = resolveWindow('custom', { from: '2026-07-01', to: '2026-07-15' });
  assert.equal(new Date(c.from).toISOString(), '2026-07-01T00:00:00.000Z');
  assert.equal(resolveWindow('custom', { from: 'x', to: 'y' }), null);
  assert.equal(resolveWindow('custom', { from: '2026-07-15', to: '2026-07-01' }), null, 'reversed range is invalid');
});

test('an unknown window falls back to 30 days rather than failing', () => {
  assert.equal(resolveWindow('nonsense', { now: NOW }).label, 'last 30 days');
  assert.ok(RATE_WINDOWS.includes('custom'));
});

// ── strategy rates ───────────────────────────────────────────────────────────

const row = (strategy, matched) => ({ strategy, matched: matched ? 1 : 0 });

test('a perfect record with enough samples earns the star', () => {
  const [r] = strategyMatchRates([row('a', 1), row('a', 1), row('a', 1)]);
  assert.equal(r.matchRate, 100);
  assert.equal(r.perfect, true);
  assert.equal(r.provisional, false);
});

test('100% off too few forecasts is NOT starred', () => {
  // The whole point: one lucky forecast reads as 100% and would star a strategy with no
  // track record, which misleads worse than showing nothing.
  const [r] = strategyMatchRates([row('a', 1)]);
  assert.equal(r.matchRate, 100);
  assert.equal(r.perfect, false, 'a single sample must not earn a star');
  assert.equal(r.provisional, true, 'but it is flagged as promising');
});

test('one miss breaks the perfect record', () => {
  const [r] = strategyMatchRates([row('a', 1), row('a', 1), row('a', 1), row('a', 0)]);
  assert.equal(r.matchRate, 75);
  assert.equal(r.perfect, false);
});

test('the minimum sample is configurable and reported', () => {
  const [r] = strategyMatchRates([row('a', 1), row('a', 1)], { minSample: 2 });
  assert.equal(r.perfect, true);
  assert.equal(r.minSample, 2);
});

test('strategies are ranked by rate then volume', () => {
  const out = strategyMatchRates([
    row('low', 0), row('low', 1),
    row('high', 1), row('high', 1), row('high', 1),
  ]);
  assert.equal(out[0].strategy, 'high');
  assert.equal(out[0].matchRate, 100);
  assert.equal(out[1].matchRate, 50);
});

test('best_strategy from the DB is accepted, and unkeyed rows are skipped', () => {
  const out = strategyMatchRates([{ best_strategy: 'a', matched: 1 }, { matched: 1 }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].strategy, 'a');
  assert.deepEqual(strategyMatchRates(null), []);
});
