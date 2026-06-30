// Sanity tests for breakoutEngine — run: node breakoutEngine.test.mjs
import {
  assessChartQuality,
  gradeFromScore,
  detectApproach,
  detectConfirmedBreakout,
  buildBreakoutCandidate,
} from './breakoutEngine.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name}`); } };

const base = Date.UTC(2026, 0, 1, 0, 0, 0);
const min15 = 15 * 60 * 1000;

// Build a candle series from a list of pivots ['L'|'H', price], inserting 2
// filler candles around the midpoint between consecutive pivots so each pivot is
// a clean fractal extremum. Optionally append explicit scenario candles.
function buildSeries(pivots, scenario = []) {
  const candles = [];
  let t = base;
  const push = (o, h, l, c) => { candles.push({ open: o, high: h, low: l, close: c, time: new Date(t).toISOString() }); t += min15; };

  // two leading fillers below the first pivot
  const first = pivots[0][1];
  push(first, first + 0.4, first - 0.4, first);
  push(first, first + 0.4, first - 0.4, first);

  let prev = first;
  for (let k = 0; k < pivots.length; k++) {
    const [type, price] = pivots[k];
    const mid = (prev + price) / 2;
    if (k > 0) {
      push(mid, mid + 0.4, mid - 0.4, mid);
      push(mid, mid + 0.4, mid - 0.4, mid);
    }
    if (type === 'H') push(price - 1, price, price - 1.5, price - 0.6);   // spike high
    else push(price + 1, price + 1.5, price, price + 0.6);                // spike low
    prev = price;
  }
  // two trailing fillers so the final pivot is a confirmable swing
  push(prev, prev + 0.4, prev - 0.4, prev);
  push(prev, prev + 0.4, prev - 0.4, prev);

  for (const c of scenario) { push(c.o, c.h, c.l, c.c); t = t; }
  return candles;
}

// Clean rising staircase: higher highs (98,102,106,110,114) + higher lows (92..110).
const UP_PIVOTS = [
  ['L', 92], ['H', 98], ['L', 94], ['H', 102], ['L', 98],
  ['H', 106], ['L', 102], ['H', 110], ['L', 106], ['H', 114], ['L', 110],
];

// ── 1) Chart quality ──────────────────────────────────────────────────────
const upCandles = buildSeries(UP_PIVOTS);
const q = assessChartQuality(upCandles);
console.log(`  [diag] uptrend quality: trend=${q.trend} score=${q.score} reasons=${JSON.stringify(q.reasons)} atr=${q.atr}`);
ok('uptrend → trend UP', q.trend === 'UP');
ok('uptrend → well-formed score (>=65)', q.score >= 65);

// Choppy / contracting range: ends with a LOWER high and a HIGHER low so there
// is no clean HH/HL or LH/LL → not a tradable directional chart.
const CHOP_PIVOTS = [
  ['L', 95], ['H', 104], ['L', 96], ['H', 105], ['L', 98],
  ['H', 104], ['L', 95], ['H', 106], ['L', 94], ['H', 103], ['L', 96],
];
const chopCandles = buildSeries(CHOP_PIVOTS);
const qc = assessChartQuality(chopCandles);
console.log(`  [diag] choppy quality: trend=${qc.trend} score=${qc.score} reasons=${JSON.stringify(qc.reasons)}`);
ok('choppy → not a clean uptrend (trend !== UP)', qc.trend !== 'UP');
ok('choppy → buildBreakoutCandidate is null', buildBreakoutCandidate({ symbol: 'X', timeframe: 'M15', candles: chopCandles }) === null);

// ── 2) PRE (approach) ─────────────────────────────────────────────────────
// After the last low (110), rise to just below resistance 114 (not broken).
const preCandles = buildSeries(UP_PIVOTS, [
  { o: 110.5, h: 111.5, l: 110, c: 111 },
  { o: 111, h: 112.5, l: 110.8, c: 112.2 },
  { o: 112.2, h: 113.4, l: 112, c: 113.2 },
  { o: 113.2, h: 113.95, l: 113, c: 113.85 },   // close 113.85, just under 114
]);
const preCand = buildBreakoutCandidate({ symbol: 'EURUSD', timeframe: 'M15', candles: preCandles });
console.log(`  [diag] PRE candidate: ${JSON.stringify(preCand && { phase: preCand.phase, dir: preCand.direction, grade: preCand.grade, score: preCand.score, level: preCand.level, distanceAtr: preCand.distanceAtr })}`);
ok('approach → PRE candidate', preCand && preCand.phase === 'PRE');
ok('approach → direction BUY', preCand && preCand.direction === 'BUY');

// ── 3) CONFIRMED (decisive close beyond level) ────────────────────────────
const confCandles = buildSeries(UP_PIVOTS, [
  { o: 110.5, h: 111.5, l: 110, c: 111 },
  { o: 111, h: 112.5, l: 110.8, c: 112.2 },
  { o: 112.2, h: 113.5, l: 112, c: 113 },        // prevClose 113 <= 114
  { o: 112, h: 117.5, l: 111.8, c: 117 },        // big body close 117 > 114
]);
const confCand = buildBreakoutCandidate({ symbol: 'XAUUSD', timeframe: 'H1', candles: confCandles });
console.log(`  [diag] CONFIRMED candidate: ${JSON.stringify(confCand && { phase: confCand.phase, dir: confCand.direction, grade: confCand.grade, score: confCand.score, level: confCand.level, bodyAtr: confCand.bodyAtr })}`);
ok('decisive close → CONFIRMED candidate', confCand && confCand.phase === 'CONFIRMED');
ok('decisive close → direction BUY', confCand && confCand.direction === 'BUY');
ok('decisive close → grade B or better', confCand && ['B', 'A', 'A+'].includes(confCand.grade));

// ── 4) Weak poke (tiny body just past level) → NOT confirmed ──────────────
const weakCandles = buildSeries(UP_PIVOTS, [
  { o: 110.5, h: 111.5, l: 110, c: 111 },
  { o: 111, h: 112.5, l: 110.8, c: 112.2 },
  { o: 112.2, h: 113.5, l: 112, c: 113 },
  { o: 114.0, h: 114.3, l: 113.9, c: 114.15 },   // tiny body, barely past 114
]);
const weakCand = buildBreakoutCandidate({ symbol: 'GBPUSD', timeframe: 'M15', candles: weakCandles });
console.log(`  [diag] WEAK candidate: ${JSON.stringify(weakCand)}`);
ok('weak poke → not a CONFIRMED breakout', !weakCand || weakCand.phase !== 'CONFIRMED');

// ── 5) Grade mapping ──────────────────────────────────────────────────────
ok('gradeFromScore 90 → A+', gradeFromScore(90) === 'A+');
ok('gradeFromScore 78 → A', gradeFromScore(78) === 'A');
ok('gradeFromScore 68 → B', gradeFromScore(68) === 'B');
ok('gradeFromScore 50 → C', gradeFromScore(50) === 'C');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
