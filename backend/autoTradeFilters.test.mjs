import test from 'node:test';
import assert from 'node:assert/strict';
import { autoTradeCombosAllow, autoTradeSelectionMode, normalizeAutoTradeCombo, resolveStrategyMode, normalizeStrategyMode } from './autoTradeFilters.js';

const KNOWN_TFS = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];
const ids = new Set(['forex-confluence', 'ict-breaker']);

test('precision list allows only the exact strategy x symbol x timeframe', () => {
  const cfg = { combos: ['forex-confluence|GBPUSDM|M15', 'forex-confluence|XAUUSDM|M30'] };
  assert.equal(autoTradeCombosAllow(cfg, 'forex-confluence', 'GBPUSDM', 'M15'), true);
  assert.equal(autoTradeCombosAllow(cfg, 'forex-confluence', 'XAUUSDM', 'M30'), true);
  // same strategy, wrong timeframe / symbol / cross-pairing
  assert.equal(autoTradeCombosAllow(cfg, 'forex-confluence', 'GBPUSDM', 'M30'), false);
  assert.equal(autoTradeCombosAllow(cfg, 'forex-confluence', 'XAUUSDM', 'M15'), false);
  assert.equal(autoTradeCombosAllow(cfg, 'forex-confluence', 'EURUSDM', 'M15'), false);
  // a different strategy on an allowed pairing is still refused
  assert.equal(autoTradeCombosAllow(cfg, 'ict-breaker', 'GBPUSDM', 'M15'), false);
});

test('precision list ignores the broad lists entirely', () => {
  const cfg = {
    combos: ['forex-confluence|GBPUSDM|M15'],
    strategies: ['ict-breaker'], symbols: ['XAUUSDM'], timeframes: ['H1'],
  };
  // broad lists would have allowed ict-breaker/XAUUSDM/H1 — the precision list wins
  assert.equal(autoTradeCombosAllow(cfg, 'ict-breaker', 'XAUUSDM', 'H1'), false);
  assert.equal(autoTradeCombosAllow(cfg, 'forex-confluence', 'GBPUSDM', 'M15'), true);
});

test('wildcards widen one axis without opening the others', () => {
  const anyTf = { combos: ['forex-confluence|XAUUSDM|*'] };
  assert.equal(autoTradeCombosAllow(anyTf, 'forex-confluence', 'XAUUSDM', 'M1'), true);
  assert.equal(autoTradeCombosAllow(anyTf, 'forex-confluence', 'XAUUSDM', 'H4'), true);
  assert.equal(autoTradeCombosAllow(anyTf, 'forex-confluence', 'GBPUSDM', 'H4'), false);

  const anySym = { combos: ['ict-breaker|*|M5'] };
  assert.equal(autoTradeCombosAllow(anySym, 'ict-breaker', 'ANYTHING', 'M5'), true);
  assert.equal(autoTradeCombosAllow(anySym, 'ict-breaker', 'ANYTHING', 'M15'), false);
});

test('matching is case-insensitive on symbol and timeframe', () => {
  const cfg = { combos: ['forex-confluence|GBPUSDM|M15'] };
  assert.equal(autoTradeCombosAllow(cfg, 'forex-confluence', 'gbpusdm', 'm15'), true);
});

test('broad mode: strategies are explicit opt-in, empty symbol/tf lists mean any', () => {
  assert.equal(autoTradeCombosAllow({ combos: [], strategies: [] }, 'ict-breaker', 'XAUUSDM', 'M5'), false,
    'no strategies selected must never trade');
  const cfg = { combos: [], strategies: ['ict-breaker'], symbols: [], timeframes: [] };
  assert.equal(autoTradeCombosAllow(cfg, 'ict-breaker', 'XAUUSDM', 'M5'), true);
  assert.equal(autoTradeCombosAllow(cfg, 'forex-confluence', 'XAUUSDM', 'M5'), false);
});

test('broad mode narrows on symbol and timeframe when those lists are set', () => {
  const cfg = { combos: [], strategies: ['ict-breaker'], symbols: ['XAUUSDM'], timeframes: ['M5', 'M15'] };
  assert.equal(autoTradeCombosAllow(cfg, 'ict-breaker', 'XAUUSDM', 'M5'), true);
  assert.equal(autoTradeCombosAllow(cfg, 'ict-breaker', 'XAUUSDM', 'H1'), false);
  assert.equal(autoTradeCombosAllow(cfg, 'ict-breaker', 'EURUSDM', 'M5'), false);
});

test('missing/garbage config never accidentally permits a trade', () => {
  assert.equal(autoTradeCombosAllow({}, 'ict-breaker', 'XAUUSDM', 'M5'), false);
  assert.equal(autoTradeCombosAllow({ combos: null, strategies: null }, 'x', 'Y', 'M5'), false);
});

test('normalizeAutoTradeCombo cleans valid input and rejects the rest', () => {
  const opts = { validStrategyIds: ids, knownTimeframes: KNOWN_TFS };
  assert.equal(normalizeAutoTradeCombo(' forex-confluence | gbpusdm | m15 ', opts), 'forex-confluence|GBPUSDM|M15');
  assert.equal(normalizeAutoTradeCombo('ict-breaker|*|*', opts), 'ict-breaker|*|*');
  assert.equal(normalizeAutoTradeCombo('unknown-strategy|GBPUSDM|M15', opts), null, 'unknown strategy id');
  assert.equal(normalizeAutoTradeCombo('ict-breaker|GBPUSDM|M7', opts), null, 'invalid timeframe');
  assert.equal(normalizeAutoTradeCombo('ict-breaker|G|M15', opts), null, 'symbol too short');
  assert.equal(normalizeAutoTradeCombo('ict-breaker|GBPUSDM', opts), null, 'missing timeframe part');
  assert.equal(normalizeAutoTradeCombo('', opts), null);
});

// ── explicit selection-mode switcher ──
// Before this, the only way back to broad selection was deleting every combination.
test('BROAD mode uses the broad lists even while combinations are saved', () => {
  const cfg = {
    selectionMode: 'BROAD',
    combos: ['forex-confluence|GBPUSDM|M15'],          // preserved, but not in charge
    strategies: ['ict-breaker'], symbols: [], timeframes: [],
  };
  assert.equal(autoTradeCombosAllow(cfg, 'ict-breaker', 'XAUUSDM', 'H1'), true,
    'broad opt-in decides while the combo list sits dormant');
  assert.equal(autoTradeCombosAllow(cfg, 'forex-confluence', 'GBPUSDM', 'M15'), false,
    'a saved combination must NOT trade while broad mode is active');
});

test('COMBOS mode ignores the broad lists', () => {
  const cfg = {
    selectionMode: 'COMBOS',
    combos: ['forex-confluence|GBPUSDM|M15'],
    strategies: ['ict-breaker'], symbols: [], timeframes: [],
  };
  assert.equal(autoTradeCombosAllow(cfg, 'forex-confluence', 'GBPUSDM', 'M15'), true);
  assert.equal(autoTradeCombosAllow(cfg, 'ict-breaker', 'XAUUSDM', 'H1'), false,
    'broad opt-in must not leak through in combos mode');
});

test('COMBOS mode with an empty list trades nothing', () => {
  const cfg = { selectionMode: 'COMBOS', combos: [], strategies: ['ict-breaker'] };
  assert.equal(autoTradeCombosAllow(cfg, 'ict-breaker', 'XAUUSDM', 'H1'), false,
    'must not silently fall back to broad and trade more than selected');
});

test('switching modes is lossless in both directions', () => {
  const combos = ['forex-confluence|GBPUSDM|M15'];
  const strategies = ['ict-breaker'];
  const asCombos = { selectionMode: 'COMBOS', combos, strategies };
  const asBroad = { selectionMode: 'BROAD', combos, strategies };
  // The same stored config answers differently purely on the switch.
  assert.equal(autoTradeCombosAllow(asCombos, 'forex-confluence', 'GBPUSDM', 'M15'), true);
  assert.equal(autoTradeCombosAllow(asBroad, 'forex-confluence', 'GBPUSDM', 'M15'), false);
  assert.equal(autoTradeCombosAllow(asCombos, 'ict-breaker', 'XAUUSDM', 'H1'), false);
  assert.equal(autoTradeCombosAllow(asBroad, 'ict-breaker', 'XAUUSDM', 'H1'), true);
});

test('older settings without selectionMode keep the previous behaviour', () => {
  assert.equal(autoTradeSelectionMode({ combos: ['a|B|M5'] }), 'COMBOS', 'combos present -> precision');
  assert.equal(autoTradeSelectionMode({ combos: [] }), 'BROAD', 'none -> broad');
  assert.equal(autoTradeSelectionMode({}), 'BROAD');
  assert.equal(autoTradeSelectionMode({ selectionMode: 'garbage', combos: [] }), 'BROAD');
});

// Regression: an unset mode must stay unset all the way through the settings merge.
// Defaulting it to a concrete 'BROAD' made the default win the merge for anyone who had
// saved combinations before the switch existed, flipping them from precision to broad and
// widening what auto-trades without them touching anything.
test('an unset selectionMode still infers COMBOS when combinations exist', () => {
  for (const unset of [null, undefined, '']) {
    const cfg = {
      selectionMode: unset,
      combos: ['forex-confluence|GBPUSDM|M15'],
      strategies: ['ict-breaker'],
    };
    assert.equal(autoTradeSelectionMode(cfg), 'COMBOS', `selectionMode ${String(unset)} must infer, not default`);
    assert.equal(autoTradeCombosAllow(cfg, 'ict-breaker', 'XAUUSDM', 'H1'), false,
      'a broad-only strategy must not start trading just because the mode was left unset');
  }
});

// ── per-strategy approval scoping ────────────────────────────────────────────

const CTX = { symbol: 'XAUUSD', timeframe: 'M5', session: 'LONDON' };

test('OFF and SHADOW are desk interlocks that no per-strategy rule can override', () => {
  // A per-strategy AUTO must never dispatch while the desk is off or the EA bridge is down.
  for (const desk of ['OFF', 'SHADOW']) {
    assert.equal(resolveStrategyMode(desk, { s: 'AUTO' }, 's', CTX), desk);
    assert.equal(resolveStrategyMode(desk, { s: { mode: 'AUTO' } }, 's', CTX), desk);
  }
});

test('the legacy string form still applies everywhere', () => {
  assert.equal(resolveStrategyMode('ASK', { s: 'AUTO' }, 's', CTX), 'AUTO');
  assert.equal(resolveStrategyMode('ASK', { s: 'AUTO' }, 's', { symbol: 'EURUSD', timeframe: 'H1', session: 'TOKYO' }), 'AUTO');
});

test('an unscoped object rule applies everywhere', () => {
  const modes = { s: { mode: 'AUTO', symbols: [], timeframes: [], sessions: [] } };
  assert.equal(resolveStrategyMode('ASK', modes, 's', CTX), 'AUTO');
  assert.equal(resolveStrategyMode('ASK', modes, 's', { symbol: 'EURUSD', timeframe: 'H4', session: 'NEWYORK' }), 'AUTO');
});

test('a scoped rule applies only inside its scope', () => {
  const modes = { s: { mode: 'AUTO', symbols: ['XAUUSD'], timeframes: ['M5'], sessions: ['LONDON'] } };
  assert.equal(resolveStrategyMode('ASK', modes, 's', CTX), 'AUTO', 'inside scope');
  assert.equal(resolveStrategyMode('ASK', modes, 's', { ...CTX, symbol: 'EURUSD' }), 'ASK', 'wrong symbol');
  assert.equal(resolveStrategyMode('ASK', modes, 's', { ...CTX, timeframe: 'H1' }), 'ASK', 'wrong timeframe');
  assert.equal(resolveStrategyMode('ASK', modes, 's', { ...CTX, session: 'TOKYO' }), 'ASK', 'wrong session');
});

test('a non-matching scope falls back to the DESK mode, never to the other live mode', () => {
  // The dangerous direction: narrowing an ASK rule must not promote anything to AUTO.
  const askRule = { s: { mode: 'ASK', symbols: ['XAUUSD'] } };
  assert.equal(resolveStrategyMode('AUTO', askRule, 's', { ...CTX, symbol: 'EURUSD' }), 'AUTO', 'desk AUTO stands outside the rule');
  const autoRule = { s: { mode: 'AUTO', symbols: ['XAUUSD'] } };
  assert.equal(resolveStrategyMode('ASK', autoRule, 's', { ...CTX, symbol: 'EURUSD' }), 'ASK', 'desk ASK stands outside the rule');
});

test('broker suffixes do not defeat the symbol scope', () => {
  const modes = { s: { mode: 'AUTO', symbols: ['XAUUSD'] } };
  assert.equal(resolveStrategyMode('ASK', modes, 's', { ...CTX, symbol: 'XAUUSDm' }), 'AUTO');
  const idx = { s: { mode: 'AUTO', symbols: ['USTEC'] } };
  assert.equal(resolveStrategyMode('ASK', idx, 's', { ...CTX, symbol: 'USTEC_X100M' }), 'AUTO');
  assert.equal(resolveStrategyMode('ASK', modes, 's', { ...CTX, symbol: 'EURUSD' }), 'ASK');
});

test('a scoped rule with missing context does not match', () => {
  // No symbol on the candidate cannot satisfy a symbol-scoped rule; falling back is safer
  // than treating "unknown" as "matches".
  const modes = { s: { mode: 'AUTO', symbols: ['XAUUSD'] } };
  assert.equal(resolveStrategyMode('ASK', modes, 's', {}), 'ASK');
  assert.equal(resolveStrategyMode('ASK', modes, 's'), 'ASK');
});

test('an unrecognised mode falls back rather than guessing', () => {
  assert.equal(resolveStrategyMode('ASK', { s: { mode: 'YOLO', symbols: [] } }, 's', CTX), 'ASK');
  assert.equal(resolveStrategyMode('ASK', { s: 'MAYBE' }, 's', CTX), 'ASK');
  assert.equal(resolveStrategyMode('ASK', { s: null }, 's', CTX), 'ASK');
  assert.equal(resolveStrategyMode('ASK', {}, 'missing', CTX), 'ASK');
});

test('normalizeStrategyMode upgrades the legacy form and drops junk', () => {
  assert.deepEqual(normalizeStrategyMode('AUTO'), { mode: 'AUTO', symbols: [], timeframes: [], sessions: [] });
  assert.equal(normalizeStrategyMode('NONSENSE'), null);
  assert.equal(normalizeStrategyMode({ mode: 'OFF' }), null, 'OFF is not a per-strategy mode');
  assert.equal(normalizeStrategyMode(null), null);
});

test('normalizeStrategyMode filters unknown timeframes and sessions', () => {
  // A value the resolver would never match must not be storable, or the UI shows a rule
  // that silently does nothing.
  const out = normalizeStrategyMode(
    { mode: 'ask', symbols: ['xauusd', 'xauusd', ' eurusd '], timeframes: ['M5', 'M7'], sessions: ['LONDON', 'MARS'] },
    { knownTimeframes: ['M1', 'M5', 'M15'], knownSessions: ['LONDON', 'NEWYORK'] },
  );
  assert.equal(out.mode, 'ASK', 'mode is upper-cased');
  assert.deepEqual(out.symbols, ['XAUUSD', 'EURUSD'], 'deduped, trimmed, upper-cased');
  assert.deepEqual(out.timeframes, ['M5'], 'M7 dropped');
  assert.deepEqual(out.sessions, ['LONDON'], 'MARS dropped');
});
