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

console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
