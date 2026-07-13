import assert from 'node:assert';
import { findOrderFillIndex } from './orderFill.js';

const bars = [
  { timeMs: 1, low: 99, high: 101 },
  { timeMs: 2, low: 98, high: 102 },
  { timeMs: 3, low: 97, high: 106 },
];

assert.strictEqual(findOrderFillIndex(bars, { isBuy: true, entry: 105, orderType: 'STOP' }), 2, 'BUY stop fills only above entry');
assert.strictEqual(findOrderFillIndex(bars, { isBuy: false, entry: 96, orderType: 'STOP' }), -1, 'SELL stop stays unfilled above trigger');
assert.strictEqual(findOrderFillIndex(bars, { isBuy: true, entry: 99, orderType: 'LIMIT' }), 0, 'legacy BUY limit fills below entry');
assert.strictEqual(findOrderFillIndex(bars, { isBuy: false, entry: 102, orderType: 'LIMIT' }), 1, 'legacy SELL limit fills above entry');
assert.strictEqual(findOrderFillIndex(bars, { isBuy: true, entry: 105, orderType: 'STOP', validUntilMs: 2 }), -1, 'stop cannot fill after validity window');
assert.strictEqual(findOrderFillIndex(bars, { isBuy: true, entry: 102, orderType: 'STOP', validUntilMs: 2 }), -1, 'candle opening exactly at expiry cannot fill');
assert.strictEqual(findOrderFillIndex(bars, { isBuy: true, entry: 500, orderType: 'MARKET' }), 0, 'market entry fills immediately');

console.log('7 passed');
