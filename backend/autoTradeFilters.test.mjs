import test from 'node:test';
import assert from 'node:assert/strict';
import { autoTradeCombosAllow, normalizeAutoTradeCombo } from './autoTradeFilters.js';

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
