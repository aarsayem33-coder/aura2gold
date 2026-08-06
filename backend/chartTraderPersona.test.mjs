import assert from 'node:assert/strict';
import test from 'node:test';
import {
  playbookFor, normaliseStyle, normaliseBias, buildPersonaPrompt, matchStrategies,
  STYLE_BRIEF, TRADE_STYLES, POSITION_BIASES,
} from './chartTraderPersona.js';

// ── instrument routing ───────────────────────────────────────────────────────

test('each special instrument gets its own playbook', () => {
  assert.equal(playbookFor('XAUUSD').key, 'GOLD');
  assert.equal(playbookFor('XAUUSDm').key, 'GOLD');
  assert.equal(playbookFor('GOLD').key, 'GOLD');
  assert.equal(playbookFor('USTEC').key, 'NASDAQ');
  assert.equal(playbookFor('USTEC_X100M').key, 'NASDAQ');
  assert.equal(playbookFor('NAS100').key, 'NASDAQ');
  assert.equal(playbookFor('SPX500').key, 'SP500');
  assert.equal(playbookFor('US500').key, 'SP500');
});

test('an unknown symbol falls back to FX rather than to gold', () => {
  // Silently applying the gold playbook to EURUSD would inject wrong session and driver advice.
  assert.equal(playbookFor('EURUSD').key, 'FX');
  assert.equal(playbookFor('GBPJPY').key, 'FX');
  assert.equal(playbookFor('').key, 'FX');
  assert.equal(playbookFor(null).key, 'FX');
});

test('gold and Nasdaq briefs are genuinely different advice', () => {
  const gold = playbookFor('XAUUSD').brief.join(' ');
  const nas = playbookFor('USTEC').brief.join(' ');
  assert.notEqual(gold, nas);
  assert.match(gold, /liquidity|sweep/i, 'gold brief must cover its liquidity behaviour');
  assert.match(nas, /open/i, 'nasdaq brief must cover the cash open');
});

// ── style and bias normalisation ─────────────────────────────────────────────

test('style normalises and defaults to DAY rather than guessing', () => {
  assert.equal(normaliseStyle('SCALP'), 'SCALP');
  assert.equal(normaliseStyle('scalp'), 'SCALP');
  assert.equal(normaliseStyle('DAY'), 'DAY');
  assert.equal(normaliseStyle('nonsense'), 'DAY');
  assert.equal(normaliseStyle(null), 'DAY');
});

test('bias normalises and defaults to BOTH', () => {
  assert.equal(normaliseBias('LONG'), 'LONG');
  assert.equal(normaliseBias('short'), 'SHORT');
  assert.equal(normaliseBias('BOTH'), 'BOTH');
  assert.equal(normaliseBias('sideways'), 'BOTH');
  assert.equal(normaliseBias(undefined), 'BOTH');
});

test('the two styles describe different horizons', () => {
  assert.notEqual(STYLE_BRIEF.SCALP.horizon, STYLE_BRIEF.DAY.horizon);
  assert.match(STYLE_BRIEF.SCALP.brief.join(' '), /nearest/i, 'a scalp targets the nearest level');
  assert.match(STYLE_BRIEF.DAY.brief.join(' '), /session/i, 'a day trade is framed by the session');
});

// ── the prompt ───────────────────────────────────────────────────────────────

test('asking for a LONG explicitly forbids manufacturing one', () => {
  // The failure mode that makes an AI read worthless: asked for a long, it finds a long
  // whatever the chart says.
  const p = buildPersonaPrompt({ symbol: 'XAUUSD', timeframe: 'M15', style: 'SCALP', bias: 'LONG' });
  assert.match(p, /EVALUATE the LONG side, NOT to justify it/);
  assert.match(p, /Never invent a setup/);
  assert.match(p, /talks a client out of a bad trade/);
});

test('with no direction requested the prompt asks for an open read', () => {
  const p = buildPersonaPrompt({ symbol: 'XAUUSD', timeframe: 'M15', style: 'DAY', bias: 'BOTH' });
  assert.match(p, /has NOT specified a direction/);
  assert.doesNotMatch(p, /justify/);
});

test('the prompt carries the right style AND the right instrument', () => {
  const scalpGold = buildPersonaPrompt({ symbol: 'XAUUSD', timeframe: 'M5', style: 'SCALP', bias: 'BOTH' });
  assert.match(scalpGold, /Scalper/);
  assert.match(scalpGold, /Gold \(XAUUSD\)/);
  const dayNas = buildPersonaPrompt({ symbol: 'USTEC', timeframe: 'M15', style: 'DAY', bias: 'SHORT' });
  assert.match(dayNas, /Day trader/);
  assert.match(dayNas, /Nasdaq 100/);
  assert.doesNotMatch(dayNas, /Gold \(XAUUSD\)/, 'instrument briefs must not leak across symbols');
});

test('NO TRADE is presented as a complete professional answer', () => {
  // Without this the model treats "find a trade" as the task and always finds one.
  const p = buildPersonaPrompt({ symbol: 'XAUUSD', timeframe: 'M15', style: 'SCALP', bias: 'LONG' });
  assert.match(p, /NO TRADE/);
  assert.match(p, /judged on HONESTY, not on finding a trade/);
});

test('the prompt tells the model to form its own view FIRST', () => {
  // Independence is the whole point — otherwise it just parrots the engine.
  const p = buildPersonaPrompt({ symbol: 'XAUUSD', timeframe: 'M15', style: 'DAY', bias: 'BOTH' });
  assert.match(p, /INDEPENDENTLY/);
  assert.match(p, /before you look at any engine output/);
});

// ── strategy matching: information only ──────────────────────────────────────

test('agreement and disagreement are both reported plainly', () => {
  const strategies = [
    { id: 'ict-breaker', decision: 'BUY' }, { id: 'smc-fvg', decision: 'BUY' },
    { id: 'liquidity-trap', decision: 'SELL' },
  ];
  const m = matchStrategies('BUY', strategies);
  assert.equal(m.verdict, 'MIXED');
  assert.equal(m.agreeing.length, 2);
  assert.equal(m.opposing.length, 1);
});

test('every strategy pointing the other way is flagged, not buried', () => {
  const m = matchStrategies('BUY', [{ id: 'a', decision: 'SELL' }, { id: 'b', decision: 'SELL' }]);
  assert.equal(m.verdict, 'CONTRARY');
  assert.match(m.note, /OTHER way/);
  assert.equal(m.agreeing.length, 0);
});

test('full agreement reads as aligned', () => {
  const m = matchStrategies('SELL', [{ id: 'a', decision: 'SELL' }, { id: 'b', decision: 'SELL' }]);
  assert.equal(m.verdict, 'ALIGNED');
  assert.equal(m.agreeing.length, 2);
});

test('no strategies firing is stated, not silently shown as agreement', () => {
  const m = matchStrategies('BUY', []);
  assert.equal(m.verdict, 'NO_STRATEGIES');
  assert.equal(m.agreeing.length, 0);
});

test('an AI with no direction produces no match claim', () => {
  for (const d of ['NO_TRADE', 'WAIT', null, '']) {
    const m = matchStrategies(d, [{ id: 'a', decision: 'BUY' }]);
    assert.equal(m.verdict, 'NO_DIRECTION');
    assert.equal(m.agreeing.length, 0);
  }
});

test('HOLD strategies count as neither side', () => {
  const m = matchStrategies('BUY', [{ id: 'a', decision: 'HOLD' }, { id: 'b', decision: 'BUY' }]);
  assert.equal(m.agreeing.length, 1);
  assert.equal(m.opposing.length, 0);
});

test('matching never mutates the strategies it was given', () => {
  const strategies = [{ id: 'a', decision: 'BUY' }];
  const before = JSON.stringify(strategies);
  matchStrategies('BUY', strategies);
  assert.equal(JSON.stringify(strategies), before, 'this is a read-only comparison');
});

test('the exported option lists are the ones the UI offers', () => {
  assert.deepEqual(TRADE_STYLES, ['SCALP', 'DAY']);
  assert.deepEqual(POSITION_BIASES, ['LONG', 'SHORT', 'BOTH']);
});
