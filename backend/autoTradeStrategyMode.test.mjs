import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveStrategyMode } from './autoTradeFilters.js';

const MODES = { 'ict-break-pro': 'AUTO', 'smc-fvg': 'ASK' };

test('a per-strategy AUTO skips the approval queue while the desk stays on ASK', () => {
  assert.equal(resolveStrategyMode('ASK', MODES, 'ict-break-pro'), 'AUTO');
  assert.equal(resolveStrategyMode('ASK', MODES, 'liquidity-trap'), 'ASK', 'unlisted keeps the global');
});

test('a per-strategy ASK forces review while the desk is on AUTO', () => {
  assert.equal(resolveStrategyMode('AUTO', MODES, 'smc-fvg'), 'ASK');
  assert.equal(resolveStrategyMode('AUTO', MODES, 'ict-breaker'), 'AUTO');
});

test('OFF is absolute — no strategy can trade through it', () => {
  // The one moment you reach for the master switch is the moment it has to be absolute.
  assert.equal(resolveStrategyMode('OFF', MODES, 'ict-break-pro'), 'OFF');
  assert.equal(resolveStrategyMode('OFF', { 'x': 'AUTO' }, 'x'), 'OFF');
});

test('SHADOW is absolute — "log only" cannot be overridden into real orders', () => {
  assert.equal(resolveStrategyMode('SHADOW', MODES, 'ict-break-pro'), 'SHADOW');
  assert.equal(resolveStrategyMode('SHADOW', { 'x': 'AUTO' }, 'x'), 'SHADOW');
});

test('an unrecognised per-strategy value falls back instead of guessing', () => {
  // A typo must never silently start auto-trading something.
  for (const bad of ['auto ', 'YES', 'ON', '', null, undefined, 1, {}]) {
    assert.equal(resolveStrategyMode('ASK', { x: bad }, 'x'), 'ASK', `"${String(bad)}" must fall back`);
  }
});

test('lower case and whitespace-free values are accepted', () => {
  assert.equal(resolveStrategyMode('ASK', { x: 'auto' }, 'x'), 'AUTO');
  assert.equal(resolveStrategyMode('AUTO', { x: 'ask' }, 'x'), 'ASK');
});

test('a missing or malformed map is harmless', () => {
  assert.equal(resolveStrategyMode('ASK', null, 'x'), 'ASK');
  assert.equal(resolveStrategyMode('ASK', undefined, 'x'), 'ASK');
  assert.equal(resolveStrategyMode('ASK', 'nonsense', 'x'), 'ASK');
  assert.equal(resolveStrategyMode(null, MODES, 'ict-break-pro'), 'OFF', 'no global mode means OFF');
});
