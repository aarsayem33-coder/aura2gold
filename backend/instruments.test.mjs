// Nasdaq (USTEC) instrument-capabilities tests — the gates that keep the index
// CFD out of incompatible systems while enabling forex-style signals on M5–H4.
// Run: node backend/instruments.test.mjs
import { symbolCapsFor, symbolAllowsSignalTf, symbolAllowsFixedTime, symbolAllowsForecast, indexNewsCurrencyFor } from './instruments.js';
import { affectedSymbols } from './newsEngine.js';
import { roundStepFor, detectKeyLiquidityLevels } from './liquidityEngine.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.error(`FAIL  ${name}: ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

test('USTECM resolves caps regardless of case/suffix; forex symbols have none', () => {
  for (const s of ['USTEC', 'USTECm', 'USTECM']) {
    const caps = symbolCapsFor(s);
    assert(caps && caps.assetClass === 'INDEX', `${s} should resolve INDEX caps`);
  }
  assert(symbolCapsFor('EURUSDM') === null, 'forex pair must have no caps entry');
  assert(symbolCapsFor('XAUUSDM') === null, 'gold must have no caps entry');
});

test('only the five approved timeframes produce Nasdaq signals', () => {
  for (const tf of ['M5', 'M15', 'M30', 'H1', 'H4']) assert(symbolAllowsSignalTf('USTECM', tf), `${tf} must be allowed`);
  for (const tf of ['M1', 'D1']) assert(!symbolAllowsSignalTf('USTECM', tf), `${tf} must be blocked`);
  // Forex untouched: every timeframe still allowed.
  for (const tf of ['M1', 'M5', 'D1']) assert(symbolAllowsSignalTf('EURUSDM', tf), `forex ${tf} must stay allowed`);
});

test('no Nasdaq fixed-time or execution forecasts; forex unaffected', () => {
  assert(!symbolAllowsFixedTime('USTECM'), 'FTT must be blocked for USTEC');
  assert(!symbolAllowsForecast('USTECm'), 'forecasts must be blocked for USTEC');
  assert(symbolAllowsFixedTime('XAUUSDM') && symbolAllowsForecast('GBPJPYM'), 'forex keeps both');
});

test('USD news maps to USTEC alongside USD pairs', () => {
  const tracked = ['XAUUSDM', 'EURUSDM', 'GBPJPYM', 'USTECM'];
  const usd = affectedSymbols('USD', tracked);
  assert(usd.includes('USTECM'), 'CPI/NFP/FOMC must affect Nasdaq');
  assert(usd.includes('EURUSDM'), 'USD pairs still affected');
  const eur = affectedSymbols('EUR', tracked);
  assert(!eur.includes('USTECM'), 'EUR events must NOT affect Nasdaq');
  assert(indexNewsCurrencyFor('USTECM') === 'USD' && indexNewsCurrencyFor('EURUSDM') === null, 'index currency map');
});

test('index point math: pip=1.0, digits=2, $1/point/lot, contract 1', () => {
  const caps = symbolCapsFor('USTECM');
  assert(caps.pipSize === 1.0, '1 pip = 1 index point');
  assert(caps.digits === 2, '2-digit quotes');
  assert(caps.pipValuePerLot === 1, '$1 per point per lot');
  assert(caps.contractSize === 1, 'contract size 1');
  // Lot sizing example: $100 risk, 20-point stop → 100 / (20 × 1) = 5 lots.
  const lots = 100 / (20 * caps.pipValuePerLot);
  assert(lots === 5, 'risk-based sizing uses point value, not forex pip value');
});

test('Nasdaq round-number spacing: 50/100-point levels, not forex 0.005', () => {
  const r = roundStepFor('USTECM');
  assert(r.step === 50 && r.major === 100, `expected 50/100, got ${r.step}/${r.major}`);
});

test('key liquidity levels detect round numbers at index scale', () => {
  // Synthetic tape around 22,150 — majors at 22,100/22,200 must surface as levels.
  const t0 = Date.UTC(2026, 6, 8, 9, 0, 0);
  const candles = [];
  for (let i = 0; i < 120; i++) {
    const base = 22100 + Math.sin(i / 6) * 60 + i * 0.3;
    candles.push({ time: new Date(t0 + i * 900000).toISOString(), open: base, high: base + 12, low: base - 12, close: base + 4, tick_volume: 100 });
  }
  const { levels } = detectKeyLiquidityLevels(candles, { symbol: 'USTECM' });
  const rounds = levels.filter((l) => l.type === 'ROUND_NUMBER');
  assert(rounds.length > 0, 'expected round-number levels on the index');
  // Dedup may merge a nearby structural level into a round label (same as gold), so
  // require the GRID to be present, not every merged price to sit exactly on it.
  const onGrid = rounds.filter((l) => l.price % 50 === 0);
  assert(onGrid.length >= 3, `expected ≥3 on-grid (50-point) rounds, got ${onGrid.length}`);
  assert(onGrid.some((l) => l.price % 100 === 0), 'expected at least one major (100-point) round');
});


// ── x100 contract variant must never be shadowed by the generic USTEC prefix ──
// Regression: a 2026-07-26 auto-trade sized 0.44 lots for a $10 risk budget on
// USTEC_x100m and lost $944 (~100x) because USTEC_X100M matched the $1/point entry.
test('USTEC_x100 resolves to the 100x contract, not the standard one', () => {
  const std = symbolCapsFor('USTECm');
  const x100 = symbolCapsFor('USTEC_x100m');
  assert(std.pipValuePerLot === 1, 'standard USTECm stays $1 per point per lot');
  assert(x100.pipValuePerLot === 100, 'x100 contract must be $100 per point per lot');
  assert(x100.contractSize === 100, 'x100 contract size');
  assert(x100.label === 'Nasdaq 100 (x100 contract)', 'x100 has its own label');
});

// Same sizing formula the engine uses (risk / (stopPoints * pointValue), min 0.01 lot).
test('x100 sizing collapses to the minimum lot, and that minimum still over-risks', () => {
  const stopPoints = 22.6, budget = 10;
  const sized = (caps) => Math.max(0.01, Math.round((budget / (stopPoints * caps.pipValuePerLot)) * 100) / 100);
  const stdLots = sized(symbolCapsFor('USTECm'));
  const x100Lots = sized(symbolCapsFor('USTEC_x100m'));
  assert(stdLots === 0.44, 'standard contract reproduces the 0.44 lots that were actually sent');
  assert(x100Lots === 0.01, 'x100 contract collapses to the broker minimum');
  // The honest consequence: even 0.01 lots on the x100 contract risks ~$22.60, i.e.
  // MORE than the $10 budget. Small accounts should trade USTECm, not USTEC_x100m.
  const x100Risk = x100Lots * stopPoints * symbolCapsFor('USTEC_x100m').pipValuePerLot;
  assert(x100Risk > budget, 'minimum lot on the x100 contract exceeds a $10 budget');
  assert(Math.round(x100Risk * 100) / 100 === 22.6, 'that minimum risks $22.60');
});

test('both USTEC variants keep the shared index gates (order-independent match)', () => {
  for (const sym of ['USTECm', 'USTEC_x100m']) {
    assert(symbolAllowsFixedTime(sym) === false, `${sym} no fixed-time`);
    assert(symbolAllowsForecast(sym) === false, `${sym} no forecasts`);
    assert(symbolAllowsSignalTf(sym, 'M1') === false, `${sym} no M1 signals`);
    assert(symbolAllowsSignalTf(sym, 'M15') === true, `${sym} M15 allowed`);
    assert(indexNewsCurrencyFor(sym) === 'USD', `${sym} USD news`);
  }
});

console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
