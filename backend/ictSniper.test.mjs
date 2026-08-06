import assert from 'node:assert/strict';
import test from 'node:test';
import {
  shouldFire, sniperStop, normalizeSniperConfig, SNIPER_DEFAULTS, SNIPER_STRATEGIES,
} from './ictSniper.js';

const CFG = {
  enabled: true, symbols: ['EURUSD', 'XAUUSD'], timeframes: ['M5', 'M15'],
  minGrade: 'A', maxConcurrent: 3, maxPerDay: 10,
};
const sig = (o = {}) => ({
  id: 'sig-1', strategy: 'ict-breaker', symbol: 'EURUSD', timeframe: 'M5',
  grade: 'A+', lots: 0.5, ...o,
});

// ── who may fire ─────────────────────────────────────────────────────────────

test('an enabled ict-breaker signal on an enabled market fires', () => {
  const r = shouldFire(sig(), CFG);
  assert.equal(r.fire, true);
  assert.equal(r.lots, 0.5);
});

test('only the ict-breaker family can enter without a stop', () => {
  assert.deepEqual([...SNIPER_STRATEGIES].sort(), ['ict-break-pro', 'ict-breaker']);
  assert.equal(shouldFire(sig({ strategy: 'ict-break-pro' }), CFG).fire, true);
  for (const s of ['forex-confluence', 'liquidity-trap', 'smc-fvg', '']) {
    const r = shouldFire(sig({ strategy: s }), CFG);
    assert.equal(r.fire, false, `${s} must not fire`);
    assert.match(r.reason, /ict-breaker family/);
  }
});

test('sniper is OFF by default — it places live market orders', () => {
  assert.equal(SNIPER_DEFAULTS.enabled, false);
  assert.equal(shouldFire(sig(), { ...CFG, enabled: false }).fire, false);
  assert.equal(shouldFire(sig(), {}).fire, false, 'no config at all means off');
});

test('an EMPTY symbol or timeframe list means NONE, never all', () => {
  // "Empty = everything" on live market orders is the difference between a quiet config and an
  // account-wide surprise.
  assert.equal(shouldFire(sig(), { ...CFG, symbols: [] }).fire, false);
  assert.equal(shouldFire(sig(), { ...CFG, timeframes: [] }).fire, false);
});

test('symbols and timeframes gate independently, each with its own reason', () => {
  assert.match(shouldFire(sig({ symbol: 'GBPUSD' }), CFG).reason, /GBPUSD is not enabled/);
  assert.match(shouldFire(sig({ timeframe: 'H1' }), CFG).reason, /H1 is not enabled/);
});

test('symbol and timeframe matching is case-insensitive', () => {
  assert.equal(shouldFire(sig({ symbol: 'eurusd', timeframe: 'm5' }), CFG).fire, true);
});

test('grade floor is enforced', () => {
  assert.equal(shouldFire(sig({ grade: 'B' }), CFG).fire, false);
  assert.equal(shouldFire(sig({ grade: 'A' }), CFG).fire, true);
  assert.equal(shouldFire(sig({ grade: 'A+' }), CFG).fire, true);
});

test('a symbol already running is skipped — the user rule', () => {
  const r = shouldFire(sig(), CFG, { openSymbols: ['EURUSD'] });
  assert.equal(r.fire, false);
  assert.match(r.reason, /already has a position/);
});

test('concurrency and daily caps both bite', () => {
  assert.match(shouldFire(sig(), CFG, { openSymbols: ['A', 'B', 'C'] }).reason, /max concurrent/);
  assert.match(shouldFire(sig(), CFG, { todayCount: 10 }).reason, /daily cap/);
});

test('the same signal cannot fire twice', () => {
  // The alert sweep revisits pending signals; without this one setup becomes several positions.
  const r = shouldFire(sig(), CFG, { firedIds: ['sig-1'] });
  assert.equal(r.fire, false);
  assert.match(r.reason, /already fired/);
});

test('a signal with no lot size cannot trade', () => {
  // The user asked for the lot size from the signal log. No lots, no order — never a default.
  for (const bad of [null, 0, undefined, '']) {
    assert.equal(shouldFire(sig({ lots: bad }), CFG).fire, false);
  }
});

test('every skip carries a reason', () => {
  const r = shouldFire(sig({ symbol: 'NZDUSD' }), CFG);
  assert.ok(r.reason && r.reason.length > 5);
});

// ── the stop, derived backwards ──────────────────────────────────────────────

const FX = { pipSize: 0.0001, pipValuePerLot: 10, digits: 5 };

test('stop distance falls out of a FIXED dollar risk and the given lot size', () => {
  // $40 over 0.1 lots at $10/pip = 40 pips.
  const s = sniperStop({ fillPrice: 1.1, direction: 'BUY', lots: 0.1, riskUsd: 40, ...FX });
  assert.equal(s.ok, true);
  assert.equal(s.stopPips, 40);
  assert.equal(s.stopLoss, 1.096);
  assert.equal(s.riskUsd, 40);
});

test('a BIGGER lot size makes the stop TIGHTER, not the loss larger', () => {
  // This is the inversion that matters: risk is fixed, lots are given, so distance is the only
  // free variable left.
  const at = (lots) => sniperStop({ fillPrice: 1.1, direction: 'BUY', lots, riskUsd: 40, ...FX }).stopPips;
  assert.equal(at(0.1), 40);
  assert.equal(at(0.5), 8);
  assert.equal(at(1.5), 2.7, 'inside the noise band');
});

test('a stop inside the noise is FLAGGED, never silently widened', () => {
  // The user asked for a fixed dollar stop. Widening it behind their back would be a different
  // trade than the one they configured — so it is reported instead.
  const s = sniperStop({ fillPrice: 1.1, direction: 'BUY', lots: 1.5, riskUsd: 40, ...FX });
  assert.equal(s.tooTight, true);
  assert.match(s.warning, /-0\.496R/);
  assert.match(s.warning, /1\.5 lots is what makes it this tight/);
  assert.equal(s.stopLoss, 1.09973, 'and the price is still returned — it is a warning, not a refusal');
});

test('a healthy stop carries no warning', () => {
  const s = sniperStop({ fillPrice: 1.1, direction: 'BUY', lots: 0.1, riskUsd: 40, ...FX });
  assert.equal(s.tooTight, false);
  assert.equal(s.warning, null);
});

test('SELL places the stop ABOVE the fill', () => {
  const b = sniperStop({ fillPrice: 1.1, direction: 'BUY', lots: 0.1, riskUsd: 40, ...FX });
  const s = sniperStop({ fillPrice: 1.1, direction: 'SELL', lots: 0.1, riskUsd: 40, ...FX });
  assert.ok(b.stopLoss < 1.1 && s.stopLoss > 1.1);
  assert.equal(b.stopPips, s.stopPips);
});

test('the stop is measured from the FILL, not the planned entry', () => {
  // The whole point of this mode is an immediate market fill; the planned price is already stale
  // by the time it lands.
  const a = sniperStop({ fillPrice: 1.1000, direction: 'BUY', lots: 0.1, riskUsd: 40, ...FX });
  const b = sniperStop({ fillPrice: 1.1020, direction: 'BUY', lots: 0.1, riskUsd: 40, ...FX });
  assert.notEqual(a.stopLoss, b.stopLoss);
  assert.equal(Math.round((b.stopLoss - a.stopLoss) * 1e5), 200);
});

test('JPY and gold scale correctly', () => {
  const jpy = sniperStop({ fillPrice: 157.5, direction: 'SELL', lots: 0.1, riskUsd: 40, pipSize: 0.01, pipValuePerLot: 6.4, digits: 3 });
  assert.equal(jpy.stopPips, 62.5);
  const gold = sniperStop({ fillPrice: 4000, direction: 'BUY', lots: 0.1, riskUsd: 40, pipSize: 0.1, pipValuePerLot: 1, digits: 2 });
  assert.equal(gold.stopPips, 400);
});

test('missing inputs are refused rather than guessed', () => {
  for (const patch of [{ fillPrice: null }, { lots: 0 }, { riskUsd: null }, { pipValuePerLot: 0 }]) {
    const s = sniperStop({ fillPrice: 1.1, direction: 'BUY', lots: 0.1, riskUsd: 40, ...FX, ...patch });
    assert.equal(s.ok, false);
  }
});

// ── config hygiene ───────────────────────────────────────────────────────────

test('a saved config cannot widen what trades through a bad edit', () => {
  const c = normalizeSniperConfig({ enabled: 'yes', symbols: 'EURUSD', timeframes: null, minGrade: 'Z', maxConcurrent: 999, maxPerDay: -4 });
  assert.equal(c.enabled, false, 'only a real boolean true enables it');
  assert.deepEqual(c.symbols, [], 'a non-array becomes empty, which means NONE');
  assert.deepEqual(c.timeframes, []);
  assert.equal(c.minGrade, 'A');
  assert.ok(c.maxConcurrent <= 10);
  assert.ok(c.maxPerDay >= 1);
});

test('the stop delay is clamped at both ends', () => {
  // Zero would attach the stop before the fill is even reported; a long delay leaves the
  // position unprotected for exactly that long.
  assert.equal(normalizeSniperConfig({ stopDelaySeconds: 0 }).stopDelaySeconds, 3);
  assert.equal(normalizeSniperConfig({ stopDelaySeconds: 9999 }).stopDelaySeconds, 120);
  assert.equal(normalizeSniperConfig({}).stopDelaySeconds, 10, 'the requested default');
});

test('symbols and timeframes are upper-cased on save', () => {
  const c = normalizeSniperConfig({ symbols: ['eurusd'], timeframes: ['m5'] });
  assert.deepEqual(c.symbols, ['EURUSD']);
  assert.deepEqual(c.timeframes, ['M5']);
});

// ── this mode's own risk budget ──────────────────────────────────────────────

test('the sniper carries its OWN risk budget, defaulting to $80', () => {
  // Deliberately separate from Account & Sizing: this is not sizing a trade (the lot size came
  // from the signal), it is the dollar floor under a position that is already open.
  assert.equal(SNIPER_DEFAULTS.riskUsd, 80);
  assert.equal(normalizeSniperConfig({}).riskUsd, 80);
  assert.equal(normalizeSniperConfig({ riskUsd: 40 }).riskUsd, 40);
});

test('a BIGGER budget buys a WIDER stop — the counter-intuitive part', () => {
  // With lots fixed, raising the budget moves the stop OUT of the noise band rather than deeper
  // into it. It also doubles the loss when hit, which is the trade being made.
  const at = (riskUsd) => sniperStop({ fillPrice: 1.1, direction: 'BUY', lots: 1.5, riskUsd, ...FX });
  assert.equal(at(40).stopPips, 2.7);
  assert.equal(at(80).stopPips, 5.3);
  assert.equal(at(40).tooTight, true, '$40 lands inside the noise at this size');
  assert.equal(at(80).tooTight, false, '$80 clears the 5-pip floor');
});

test('the risk budget is clamped at both ends', () => {
  // Below $1 the stop lands on top of the fill and the broker refuses it; unbounded would let a
  // typo put the whole account on one position.
  assert.equal(normalizeSniperConfig({ riskUsd: 0 }).riskUsd, 1);
  assert.equal(normalizeSniperConfig({ riskUsd: -50 }).riskUsd, 1);
  assert.equal(normalizeSniperConfig({ riskUsd: 99999 }).riskUsd, 500);
  assert.equal(normalizeSniperConfig({ riskUsd: 'abc' }).riskUsd, 80, 'nonsense falls back to the default');
});
