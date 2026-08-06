import assert from 'node:assert/strict';
import test from 'node:test';
import { symbolKey, sameInstrument, concurrencyVerdict, pendingCommands } from './autoTradeConcurrency.js';

const CFG = { maxConcurrent: 2, onePerSymbol: true };
const pos = (symbol, over = {}) => ({ symbol, id: 1, ticket: 1, ...over });

// ── symbol matching (defect 3) ───────────────────────────────────────────────

test('symbolKey strips case and broker punctuation', () => {
  assert.equal(symbolKey('XAUUSDm'), 'XAUUSDM');
  assert.equal(symbolKey('EURUSD.pro'), 'EURUSDPRO');
  assert.equal(symbolKey('USTEC_X100'), 'USTECX100');
  assert.equal(symbolKey(null), '');
});

test('a broker suffix still matches the unsuffixed command symbol', () => {
  // The live defect: server holds XAUUSD, Exness reports XAUUSDm, === never matched, and
  // one-per-symbol silently stopped blocking.
  assert.ok(sameInstrument('XAUUSD', 'XAUUSDm'));
  assert.ok(sameInstrument('XAUUSDm', 'XAUUSD'));
  assert.ok(sameInstrument('USTEC', 'USTECm'));
  assert.ok(sameInstrument('EURUSD', 'EURUSD.pro'));
  assert.ok(sameInstrument('eurusd', 'EURUSD'));
});

test('genuinely different instruments do not match', () => {
  assert.equal(sameInstrument('EURUSD', 'GBPUSD'), false);
  assert.equal(sameInstrument('XAUUSD', 'XAGUSD'), false);
  assert.equal(sameInstrument('USDJPY', 'EURJPY'), false);
});

test('short or empty names never match everything', () => {
  assert.equal(sameInstrument('', 'EURUSD'), false);
  assert.equal(sameInstrument('EU', 'EURUSD'), false);
  assert.equal(sameInstrument(null, null), false);
});

// ── the cap (defect 1) ───────────────────────────────────────────────────────

test('room at the broker lets an order through', () => {
  assert.equal(concurrencyVerdict({ cfg: CFG, symbol: 'EURUSD', open: [pos('GBPUSD')] }), null);
});

test('the cap counts commands already in flight, not just broker positions', () => {
  // The exact live shape: maxConcurrent 2, ONE position open, and one command already
  // dispatched this poll. The old guard saw "1 < 2" and sent a third order.
  const v = concurrencyVerdict({
    cfg: CFG, symbol: 'EURUSD',
    open: [pos('GBPUSD')],
    inFlight: [{ symbol: 'AUDUSD' }],
  });
  assert.ok(v, 'must block: 1 at broker + 1 in flight already meets the cap of 2');
  assert.match(v, /max concurrent \(2\)/);
  assert.match(v, /1 at broker \+ 1 in flight/);
});

test('three queued commands cannot all pass a cap of two', () => {
  // Simulates the dispatch loop accumulating what it has already sent.
  const open = [pos('GBPUSD')];
  const dispatched = [];
  const results = ['EURUSD', 'AUDUSD', 'USDCHF'].map((sym) => {
    const v = concurrencyVerdict({ cfg: CFG, symbol: sym, open, inFlight: dispatched });
    if (!v) dispatched.push({ symbol: sym });
    return v;
  });
  assert.equal(results[0], null, 'first fills the last slot');
  assert.ok(results[1], 'second must be blocked');
  assert.ok(results[2], 'third must be blocked');
  assert.equal(dispatched.length, 1);
  assert.equal(open.length + dispatched.length, 2, 'never exceeds maxConcurrent');
});

test('a cap of zero blocks everything', () => {
  assert.ok(concurrencyVerdict({ cfg: { maxConcurrent: 0 }, symbol: 'EURUSD', open: [] }));
});

test('an unreadable cap blocks rather than meaning unlimited', () => {
  // The dangerous reading would be "no cap configured, so open as many as you like".
  for (const bad of [null, undefined, '', 'abc', NaN]) {
    assert.ok(
      concurrencyVerdict({ cfg: { maxConcurrent: bad }, symbol: 'EURUSD', open: [] }),
      `maxConcurrent ${String(bad)} must block, not permit unlimited positions`,
    );
  }
  assert.ok(concurrencyVerdict({ cfg: {}, symbol: 'EURUSD', open: [] }), 'no cfg at all must block');
});

// ── one per symbol (defects 1 + 3 together) ──────────────────────────────────

test('one-per-symbol blocks a second order on the same instrument', () => {
  const v = concurrencyVerdict({ cfg: CFG, symbol: 'EURUSD', open: [pos('EURUSD')] });
  assert.match(v, /one-per-symbol/);
});

test('one-per-symbol blocks against an in-flight command, not just a broker position', () => {
  // Two QUEUED rows on the same symbol both used to pass, because neither was a position yet.
  const v = concurrencyVerdict({
    cfg: CFG, symbol: 'EURUSD', open: [], inFlight: [{ symbol: 'EURUSD' }],
  });
  assert.ok(v);
  assert.match(v, /already queued\/sent for/);
});

test('one-per-symbol survives the broker suffix', () => {
  const v = concurrencyVerdict({ cfg: CFG, symbol: 'XAUUSD', open: [pos('XAUUSDm')] });
  assert.ok(v, 'an Exness XAUUSDm position must block an XAUUSD command');
  assert.match(v, /one-per-symbol/);
});

test('one-per-symbol off allows the same symbol while the cap still applies', () => {
  const cfg = { maxConcurrent: 3, onePerSymbol: false };
  assert.equal(concurrencyVerdict({ cfg, symbol: 'EURUSD', open: [pos('EURUSD')] }), null);
  assert.ok(concurrencyVerdict({ cfg, symbol: 'EURUSD', open: [pos('EURUSD'), pos('EURUSD'), pos('EURUSD')] }));
});

// ── in-flight derivation ─────────────────────────────────────────────────────

test('rows the broker already reports are not counted twice', () => {
  const open = [pos('EURUSD', { id: 555, ticket: 555 })];
  const rows = [
    { id: 'a', symbol: 'EURUSD', ticket: 555, status: 'PLACED' },   // same order the broker shows
    { id: 'b', symbol: 'GBPUSD', ticket: null, status: 'SENT' },    // genuinely unseen
  ];
  const out = pendingCommands(rows, open);
  assert.deepEqual(out.map((r) => r.id), ['b']);
});

test('position_id matches the broker report too', () => {
  const open = [{ symbol: 'EURUSD', id: 777 }];
  const rows = [{ id: 'a', symbol: 'EURUSD', position_id: 777, status: 'FILLED' }];
  assert.deepEqual(pendingCommands(rows, open), []);
});

test('the row being acted on can be excluded', () => {
  const rows = [{ id: 'me', symbol: 'EURUSD', status: 'QUEUED' }, { id: 'other', symbol: 'GBPUSD', status: 'SENT' }];
  assert.deepEqual(pendingCommands(rows, [], { excludeId: 'me' }).map((r) => r.id), ['other']);
});

test('pendingCommands degrades safely', () => {
  assert.deepEqual(pendingCommands(null, null), []);
  assert.deepEqual(pendingCommands([], []), []);
  // Null ids must not collide into a bogus match.
  const out = pendingCommands([{ id: 'a', symbol: 'EURUSD', ticket: null }], [{ symbol: 'X', id: null, ticket: null }]);
  assert.deepEqual(out.map((r) => r.id), ['a']);
});

// ── end to end shape ─────────────────────────────────────────────────────────

test('the approve path counts already-queued commands', () => {
  // Approving a third proposal while two are queued must be refused at a cap of 2.
  const rows = [
    { id: 'q1', symbol: 'EURUSD', status: 'QUEUED' },
    { id: 'q2', symbol: 'GBPUSD', status: 'QUEUED' },
  ];
  const inFlight = pendingCommands(rows, []);
  const v = concurrencyVerdict({ cfg: CFG, symbol: 'AUDUSD', open: [], inFlight });
  assert.ok(v, 'two queued commands already fill a cap of 2');
});
