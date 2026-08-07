import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isOpportunity, rankOpportunities, suggestedEntryTime, buildScannerEmail,
  AI_SCANNER_SYMBOLS, AI_SCANNER_TIMEFRAME,
} from './aiScanner.js';

const op = (over = {}) => ({
  symbol: 'XAUUSD', timeframe: 'H1', source: 'CHART_AI', direction: 'BUY',
  entry: 4240, stopLoss: 4225, takeProfit1: 4255, takeProfit2: 4270, takeProfit3: 4285,
  lots: 0.05, riskUsd: 75, rr: 3, score: 72, grade: 'B', confidence: 78, ...over,
});

// ── what counts as an opportunity ────────────────────────────────────────────

test('a tradeable call needs a direction AND prices', () => {
  assert.equal(isOpportunity(op()), true);
  assert.equal(isOpportunity(op({ direction: 'HOLD' })), false);
  assert.equal(isOpportunity(op({ entry: null })), false);
  assert.equal(isOpportunity(op({ stopLoss: null })), false);
  assert.equal(isOpportunity(null), false);
});

test('SELL is just as tradeable as BUY', () => {
  assert.equal(isOpportunity(op({ direction: 'SELL' })), true);
  assert.equal(isOpportunity(op({ direction: 'sell' })), true);
});

// ── ranking ──────────────────────────────────────────────────────────────────

test('the best setup leads', () => {
  const out = rankOpportunities([op({ score: 40 }), op({ score: 88 }), op({ score: 65 })]);
  assert.deepEqual(out.map((x) => x.score), [88, 65, 40]);
});

test('an unscored read sorts last, not as a zero', () => {
  // "not scored" and "scored zero" are different claims. Treating null as 0 would rank an
  // unscored chart read above a genuinely weak setup.
  const out = rankOpportunities([op({ score: null }), op({ score: 5 })]);
  assert.deepEqual(out.map((x) => x.score), [5, null]);
});

test('confidence then R:R break a score tie', () => {
  const out = rankOpportunities([
    op({ score: 70, confidence: 60, rr: 4 }),
    op({ score: 70, confidence: 90, rr: 1 }),
  ]);
  assert.equal(out[0].confidence, 90);
  const rrTie = rankOpportunities([
    op({ score: 70, confidence: 80, rr: 1.5 }),
    op({ score: 70, confidence: 80, rr: 3.2 }),
  ]);
  assert.equal(rrTie[0].rr, 3.2);
});

// ── suggested entry time ─────────────────────────────────────────────────────

test('an engine ETA becomes a window', () => {
  const t = suggestedEntryTime(op({ etaMinMinutes: 30, etaMaxMinutes: 90 }), Date.UTC(2026, 7, 7, 10, 0));
  assert.match(t.label, /30m-1h30m/);
  assert.equal(t.basis, 'engine ETA to the level');
  assert.equal(t.earliestMs, Date.UTC(2026, 7, 7, 10, 30));
});

test('price already at the entry reads as now', () => {
  const t = suggestedEntryTime(op({ price: 4240.1, entry: 4240, atr: 8 }));
  assert.match(t.label, /now/);
});

test('a distant entry says on touch, with how far away it is', () => {
  // A limit resting at a level is not "enter now" — saying so invites chasing.
  const t = suggestedEntryTime(op({ price: 4280, entry: 4240, atr: 8 }));
  assert.match(t.label, /on touch of 4240/);
  assert.match(t.label, /5\.0x ATR/);
  assert.equal(t.earliestMs, null);
});

test('no ETA and no price still produces an honest answer', () => {
  const t = suggestedEntryTime(op({ price: null, atr: null }));
  assert.match(t.label, /on touch/);
  assert.equal(t.basis, 'no ETA available');
});

// ── the email ────────────────────────────────────────────────────────────────

test('the watchlist is the six symbols requested, on H1', () => {
  assert.deepEqual(AI_SCANNER_SYMBOLS, ['XAUUSD', 'EURJPY', 'USDCAD', 'EURUSD', 'GBPUSD', 'USDCHF']);
  assert.equal(AI_SCANNER_TIMEFRAME, 'H1');
});

test('every number the brief asked for is in the table', () => {
  const { html, subject, opportunities } = buildScannerEmail({
    items: [op()], symbols: AI_SCANNER_SYMBOLS, ranAt: new Date('2026-08-07T10:00:00Z'), scannedCount: 18,
  });
  assert.equal(opportunities, 1);
  assert.match(subject, /1 setup/);
  for (const needle of ['XAUUSD', 'BUY', '4240.00000', '4225.00000', '4255.00000', '4270.00000', '4285.00000', '0.05', '$75 risk']) {
    assert.ok(html.includes(needle), `email is missing ${needle}`);
  }
});

test('a quiet hour still sends a body, not silence', () => {
  // Silence is indistinguishable from a broken scanner, and this runs unattended.
  const { html, text, subject, opportunities } = buildScannerEmail({
    items: [op({ direction: 'HOLD' })], symbols: AI_SCANNER_SYMBOLS, scannedCount: 18,
  });
  assert.equal(opportunities, 0);
  assert.match(subject, /nothing tradeable/);
  assert.match(html, /No tradeable setup this hour/);
  assert.match(text, /normal result/);
});

test('HOLD reads never reach the table', () => {
  const { html, opportunities } = buildScannerEmail({
    items: [op({ direction: 'HOLD' }), op({ symbol: 'EURUSD' })], symbols: AI_SCANNER_SYMBOLS,
  });
  assert.equal(opportunities, 1);
  assert.ok(html.includes('EURUSD'));
});

test('the subject names the symbols so the inbox is scannable', () => {
  const { subject } = buildScannerEmail({
    items: [op({ symbol: 'EURUSD' }), op({ symbol: 'GBPUSD' })], symbols: AI_SCANNER_SYMBOLS,
  });
  assert.match(subject, /2 setups/);
  assert.match(subject, /EURUSD, GBPUSD/);
});

test('symbol text is escaped so a stray name cannot break the markup', () => {
  const { html } = buildScannerEmail({ items: [op({ symbol: '<script>x</script>' })], symbols: [] });
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('the email states plainly that nothing was sent to MT5', () => {
  // The table looks like a ticket; it must not read as one already placed.
  const { html } = buildScannerEmail({ items: [op()], symbols: AI_SCANNER_SYMBOLS });
  assert.match(html, /Nothing here has been sent to MT5/);
});

// ── readable durations ───────────────────────────────────────────────────────

test('minutes render as something a human reads at a glance', async () => {
  const { dur } = await import('./aiScanner.js');
  assert.equal(dur(45), '45m');
  assert.equal(dur(60), '1h');
  assert.equal(dur(150), '2h30m');
  assert.equal(dur(1440), '1.0d');
  // The forecast engines really do return figures like this; "7766m" is a number you have to
  // stop and divide.
  assert.equal(dur(7766), '5.4d');
  assert.equal(dur(20000), '14d');
});

test('a multi-day ETA is reported in days, not four-digit minutes', () => {
  const t = suggestedEntryTime(op({ etaMinMinutes: 1942, etaMaxMinutes: 7766 }), Date.UTC(2026, 7, 7, 3, 0));
  assert.match(t.label, /1\.3d-5\.4d/);
  assert.ok(!/1942m/.test(t.label));
});
