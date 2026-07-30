import assert from 'node:assert';
import { MANUAL_STRATEGY_ID, manualTradeId, normalizeManualTradeHistory } from './manualTradeHistory.js';

const base = { account: '415906966', broker: 'Exness Technologies Ltd', server: 'Exness-MT5Real', activatedAt: 1000 };
const deal = { positionId: 42, symbol: 'XAUUSDm', direction: 'BUY', lots: 0.1, openPrice: 3300, closePrice: 3305, profit: 50, openTime: 1001, closeTime: 1100, reason: 'mobile' };

assert.strictEqual(MANUAL_STRATEGY_ID, 'manual', 'manual imports stay distinct from legacy unrecorded Aura rows');

const parsed = normalizeManualTradeHistory({ ...base, deals: [deal, deal] });
assert.strictEqual(parsed.error, null);
assert.strictEqual(parsed.deals.length, 1, 'duplicate positions in one payload are collapsed');
assert.strictEqual(parsed.deals[0].reason, 'MOBILE');
assert.strictEqual(parsed.deals[0].symbol, 'XAUUSDM');

const beforeActivation = normalizeManualTradeHistory({ ...base, deals: [{ ...deal, closeTime: 999 }] });
assert.strictEqual(beforeActivation.deals.length, 0, 'pre-activation closes are never imported');
const openedBeforeActivation = normalizeManualTradeHistory({ ...base, deals: [{ ...deal, openTime: 999 }] });
assert.strictEqual(openedBeforeActivation.deals.length, 0, 'positions opened before activation are never imported');
assert.strictEqual(normalizeManualTradeHistory({ ...base, deals: [{ ...deal, direction: '?' }] }).deals.length, 0, 'unknown direction is rejected');

const firstAccount = manualTradeId('100', 'Broker', 'Server-A', 42);
const secondAccount = manualTradeId('200', 'Broker', 'Server-A', 42);
const secondServer = manualTradeId('100', 'Broker', 'Server-B', 42);
assert.notStrictEqual(firstAccount, secondAccount, 'same position ID is isolated by account');
assert.notStrictEqual(firstAccount, secondServer, 'same account/position ID is isolated by server');

assert.ok(normalizeManualTradeHistory({ ...base, server: '', deals: [deal] }).error, 'account scope is mandatory');

console.log('11 passed');
