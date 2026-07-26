import assert from 'node:assert';
import { assessEntryReadiness, buildEntryReadyEmail } from './entryReadyAlert.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (error) { process.exitCode = 1; console.error(`FAIL  ${name}\n      ${error.message}`); }
}

const bar = (timeMs, open, high, low, close) => ({ timeMs, time: new Date(timeMs).toISOString(), open, high, low, close });
const now = Date.UTC(2026, 6, 14, 12, 10);

test('fresh BUY limit fill is ready inside the entry zone', () => {
  const result = assessEntryReadiness([
    bar(now - 120000, 101, 101.4, 100.5, 101),
    bar(now - 60000, 101, 101.2, 99.9, 100.2),
    bar(now, 100.2, 100.7, 100.1, 100.4),
  ], { isBuy: true, entry: 100, stop: 98, tp1: 102, orderType: 'LIMIT', nowMs: now });
  assert.equal(result.ready, true);
  assert.equal(result.code, 'READY');
  assert.ok(result.currentPrice >= result.zoneLow && result.currentPrice <= result.zoneHigh);
});

test('MARKET signals are not fabricated as later entry fills', () => {
  const result = assessEntryReadiness([bar(now, 100, 101, 99, 100)], { isBuy: true, entry: 100, stop: 98, tp1: 102, orderType: 'MARKET', nowMs: now });
  assert.equal(result.code, 'UNSUPPORTED_ORDER');
  assert.equal(result.terminal, true);
});

test('nullable or directionally invalid plans are rejected', () => {
  const missingStop = assessEntryReadiness([bar(now, 100, 101, 99, 100)], { isBuy: true, entry: 100, stop: null, tp1: 102, orderType: 'LIMIT', nowMs: now });
  const wrongSideTp = assessEntryReadiness([bar(now, 100, 101, 99, 100)], { isBuy: true, entry: 100, stop: 98, tp1: 99, orderType: 'LIMIT', nowMs: now });
  assert.equal(missingStop.code, 'INVALID_PLAN');
  assert.equal(wrongSideTp.code, 'INVALID_PLAN');
});

test('stop before entry rejects the alert', () => {
  const result = assessEntryReadiness([
    bar(now - 120000, 99, 99.5, 97.5, 99),
    bar(now - 60000, 99, 100.2, 98.8, 100),
  ], { isBuy: true, entry: 100, stop: 98, tp1: 102, orderType: 'STOP', nowMs: now });
  assert.equal(result.code, 'STOP_BEFORE_ENTRY');
});

test('same-candle fill and stop is conservatively rejected', () => {
  const result = assessEntryReadiness([
    bar(now - 60000, 99, 100.3, 97.8, 100),
  ], { isBuy: true, entry: 100, stop: 98, tp1: 102, orderType: 'STOP', nowMs: now });
  assert.equal(result.code, 'AMBIGUOUS_FILL_STOP');
});

test('TP1 reached before email rejects a late entry', () => {
  const result = assessEntryReadiness([
    bar(now - 120000, 101, 101.1, 99.9, 100.2),
    bar(now - 60000, 100.2, 102.1, 100, 101.8),
  ], { isBuy: true, entry: 100, stop: 98, tp1: 102, orderType: 'LIMIT', nowMs: now });
  assert.equal(result.code, 'TP1_ALREADY_HIT');
});

test('TP1 reached before a later limit fill invalidates the setup', () => {
  const result = assessEntryReadiness([
    bar(now - 120000, 101.5, 102.2, 100.5, 101),
    bar(now - 60000, 101, 101.1, 99.9, 100.2),
  ], { isBuy: true, entry: 100, stop: 98, tp1: 102, orderType: 'LIMIT', nowMs: now });
  assert.equal(result.code, 'TP1_BEFORE_ENTRY');
});

test('BUY fills use ask-side prices when spread points are available', () => {
  const candle = { ...bar(now, 100.1, 100.2, 99.95, 100.1), spread: 20 };
  const result = assessEntryReadiness([candle], { isBuy: true, entry: 100, stop: 98, tp1: 102, orderType: 'LIMIT', spreadPointSize: 0.01, nowMs: now });
  assert.equal(result.code, 'NO_FILL', 'bid touched, but ask remained above the buy limit');
});

test('price that ran too far is rejected as chased', () => {
  const result = assessEntryReadiness([
    bar(now - 60000, 100, 100.2, 99.9, 100.1),
    bar(now, 100.1, 100.9, 100, 100.8),
  ], { isBuy: true, entry: 100, stop: 98, tp1: 102, orderType: 'LIMIT', nowMs: now });
  assert.equal(result.code, 'CHASED');
});

test('STOP trigger that closes back through entry is rejected', () => {
  const result = assessEntryReadiness([
    bar(now - 60000, 99.8, 100.2, 99.7, 100.1),
    bar(now, 100.1, 100.2, 99.7, 99.8),
  ], { isBuy: true, entry: 100, stop: 98, tp1: 102, orderType: 'STOP', nowMs: now });
  assert.equal(result.code, 'TRIGGER_FAILED');
});

test('expired unfilled order becomes terminal', () => {
  const result = assessEntryReadiness([
    bar(now - 60000, 101, 101.2, 100.8, 101),
  ], { isBuy: true, entry: 100, stop: 98, tp1: 102, orderType: 'LIMIT', validUntilMs: now - 1, nowMs: now });
  assert.equal(result.code, 'EXPIRED_UNFILLED');
  assert.equal(result.terminal, true);
});

test('M1 candle crossing the expiry boundary cannot prove an in-window fill', () => {
  const result = assessEntryReadiness([
    bar(now - 60000, 101, 101.2, 99.8, 100),
  ], { isBuy: true, entry: 100, stop: 98, tp1: 102, orderType: 'LIMIT', validUntilMs: now - 30000, nowMs: now });
  assert.equal(result.code, 'EXPIRED_UNFILLED');
});

test('feed freshness prefers actual receipt time over candle-open time', () => {
  const candle = { ...bar(now - 10 * 60000, 101, 101.1, 99.9, 100.2), receivedAt: new Date(now).toISOString() };
  const result = assessEntryReadiness([candle], { isBuy: true, entry: 100, stop: 98, tp1: 102, orderType: 'LIMIT', maxFillAgeMs: 15 * 60000, nowMs: now });
  assert.equal(result.ready, true);
});

test('SELL lifecycle is symmetric and uses correct geometry', () => {
  const result = assessEntryReadiness([
    bar(now - 60000, 99, 100.1, 98.9, 99.8),
    bar(now, 99.8, 99.9, 99.6, 99.8),
  ], { isBuy: false, entry: 100, stop: 102, tp1: 98, orderType: 'LIMIT', nowMs: now });
  assert.equal(result.ready, true);
  assert.ok(result.zoneLow < result.currentPrice && result.currentPrice < result.zoneHigh);
});

test('email contains action, conditions, risk, reasons, and ignore rules', () => {
  const assessment = { currentPrice: 4002.1, zoneLow: 4001.8, zoneHigh: 4002.7, fillAgeMs: 60000, fillMs: now - 60000 };
  const email = buildEntryReadyEmail({
    row: {
      symbol: 'XAUUSDM', timeframe: 'M15', direction: 'BUY', grade: 'A', score: 84,
      entry_price: 4002, stop_loss: 3999, take_profit_1: 4005, take_profit_2: 4008, take_profit_3: 4011,
      risk_reward: 3, reason: 'Liquidity swept <script>alert(1)</script>', signal_time: new Date(now - 15 * 60000).toISOString(),
      valid_until: new Date(now + 15 * 60000).toISOString(),
    },
    strategyName: 'H4 Liquidity Pin Entry', orderType: 'STOP', assessment,
    sizing: { suggestedLots: 0.1, riskPercent: 1, riskAmount: 10, lossAtStop: 10, stopPips: 300, profitAtTp1: 10, profitAtTp2: 20, profitAtTp3: 30 },
    h4Trend: 'BULLISH', h1Trend: 'BULLISH', session: { label: 'London', bdRange: '13:00-19:00 BD' }, sentMs: now,
  });
  assert.match(email.subject, /ENTRY READY A/);
  assert.match(email.text, /CONDITIONS PASSED \(7\/7\)/);
  assert.match(email.text, /IGNORE THIS ALERT IF/);
  assert.match(email.text, /Max loss \$10\.00/);
  assert.match(email.html, /TRADE TICKET/);
  assert.match(email.html, /WHY THIS SETUP QUALIFIED/);
  assert.doesNotMatch(email.html, /<script>/);
  assert.match(email.html, /&lt;script&gt;/);
});

test('SELL email uses the sell action and preserves plain-text fallback', () => {
  const email = buildEntryReadyEmail({
    row: { symbol: 'EURUSDM', timeframe: 'M30', direction: 'SELL', grade: 'A+', score: 91, entry_price: 1.1, stop_loss: 1.102, take_profit_1: 1.098, take_profit_2: 1.096, take_profit_3: 1.094, risk_reward: 3 },
    strategyName: 'Test Strategy', orderType: 'LIMIT', assessment: { currentPrice: 1.0999, zoneLow: 1.0993, zoneHigh: 1.1004, fillAgeMs: 30000, fillMs: now }, sentMs: now,
  });
  assert.match(email.subject, /SELL NOW/);
  assert.match(email.text, /SELL EURUSDM M30/);
  assert.match(email.html, /#b91c1c/);
});

test('test preview is unmistakably labeled as non-tradable', () => {
  const email = buildEntryReadyEmail({
    row: { symbol: 'XAUUSDM', timeframe: 'M15', direction: 'BUY', grade: 'A', score: 85, entry_price: 4002, stop_loss: 3999, take_profit_1: 4005, take_profit_2: 4008, take_profit_3: 4011, risk_reward: 3 },
    strategyName: 'Sample Strategy', orderType: 'STOP', assessment: { currentPrice: 4002.1, zoneLow: 4001.8, zoneHigh: 4002.7, fillAgeMs: 30000, fillMs: now }, sentMs: now, isTest: true,
  });
  assert.match(email.subject, /^\[TEST PREVIEW\]/);
  assert.match(email.text, /SAMPLE VALUES ONLY - DO NOT TRADE/);
  assert.match(email.html, /TEST PREVIEW - SAMPLE VALUES ONLY - DO NOT TRADE/);
});

console.log(`\n${passed} passed`);
