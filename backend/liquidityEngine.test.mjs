// Quick sanity tests for liquidityEngine — run: node liquidityEngine.test.mjs
import { detectLiquidityPools, detectBreaker, buildLiquidityPlan, fractalSwings, classifyDrive, detectSecondDrive } from './liquidityEngine.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name}`); } };

function C(o, h, l, c, t) { return { open: o, high: h, low: l, close: c, time: new Date(t).toISOString() }; }

// Build a synthetic bullish-breaker sequence:
// downtrend → swing low → sweep (lower low) → reclaim close above prior swing high.
const base = Date.UTC(2026, 0, 1, 0, 0, 0);
const min5 = 5 * 60 * 1000;
let t = base;
const candles = [];
const push = (o, h, l, c) => { candles.push(C(o, h, l, c, t)); t += min5; };

// leading candles (kept within 104-108 so they add no new extremes) → length >= 20.
push(105, 107, 104, 106);
push(106, 108, 105, 107);
push(107, 108, 105, 106);
push(106, 107, 104, 105);
// local swing high ~109, swing low ~100, bounce, sweep to ~98, reclaim close > 109.
push(104, 106, 103, 105);
push(106, 108, 105, 107);
push(107, 109, 106, 108);   // H1 prior swing high (h=109)
push(108, 108, 104, 105);
push(105, 106, 101, 102);
push(102, 103, 100, 101);   // L1 swing low (low=100)
push(101, 104, 101, 103);
push(103, 106, 102, 105);
push(105, 107, 103, 106);   // bounce
push(106, 107, 98, 99);     // sweep below L1 (low 98), bearish candle = breaker OB
push(99, 102, 98, 101);
push(101, 111, 100, 110);   // reclaim: close 110 > prior high 109
push(110, 114, 109, 113);
push(113, 116, 112, 115);
push(115, 117, 113, 114);   // leaves new swing high ~117 (unswept BSL above)
push(114, 115, 112, 113);
push(113, 114, 111, 112);

const swings = fractalSwings(candles);
ok('fractalSwings finds highs and lows', swings.highs.length > 0 && swings.lows.length > 0);

const pools = detectLiquidityPools(candles);
ok('pools: has buy-side (BSL) above', pools.buySide.length > 0);
ok('pools: has sell-side (SSL) below', pools.sellSide.length > 0);
ok('pools: sell-side low ~98-100 marked swept', pools.sellSide.some((p) => p.swept && p.price <= 101));
ok('pools: recentSweep is populated', pools.recentSweep !== null);

const br = detectBreaker(candles);
ok('breaker: detected', br !== null);
ok('breaker: is BULLISH', br && br.type === 'BULLISH');
ok('breaker: stop below entry', br && br.stop < br.entry);
ok('breaker: sweep level near 98-99', br && br.sweepLevel <= 99.5);

ok('breaker: has displacement field', br && typeof br.displacement === 'object');
ok('breaker: displacement present (strong reclaim FVG)', br && br.displacement.present === true);
ok('breaker: displacement atrMultiple > 0', br && br.displacement.atrMultiple > 0);

const plan = buildLiquidityPlan(br, pools);
ok('plan: built', plan !== null);
ok('plan: BUY direction', plan && plan.direction === 'BUY');
ok('plan: target above entry', plan && plan.target > plan.entry);
ok('plan: positive RR', plan && plan.rr > 0);
ok('plan: carries displacement', plan && plan.displacement && typeof plan.displacement.present === 'boolean');

// Empty / tiny input must not throw.
ok('empty candles safe', JSON.stringify(detectLiquidityPools([])) && detectBreaker([]) === null);

// --- classifyDrive (advisory drive label) ---------------------------------
// Helper: build a flat base range [lowEdge, highEdge] for `baseBars`, then append
// `tail` candles to simulate the drive activity.
function driveSeq(baseBars, lowEdge, highEdge, tail) {
  const out = [];
  let tt = Date.UTC(2026, 0, 2, 0, 0, 0);
  const step = 5 * 60 * 1000;
  const mid = (lowEdge + highEdge) / 2;
  for (let i = 0; i < baseBars; i++) { out.push(C(mid, highEdge, lowEdge, mid, tt)); tt += step; }
  for (const c of tail) { out.push(C(c[0], c[1], c[2], c[3], tt)); tt += step; }
  return out;
}

// lookback=40 → need 40 bars: 20 base + 20 tail. Edge (bull) = 110.
// FIRST drive only: one close above 110 at the very end, no prior excursion.
const firstOnly = driveSeq(20, 90, 110, [
  [105,108,104,106],[106,109,105,107],[107,109,105,106],[106,108,104,105],
  [105,108,104,106],[106,109,105,107],[107,109,105,106],[106,108,104,105],
  [105,108,104,106],[106,109,105,107],[107,109,105,106],[106,108,104,105],
  [105,108,104,106],[106,109,105,107],[107,109,105,106],[106,108,104,105],
  [106,109,105,107],[107,109,105,106],[106,109,105,107],[108,113,107,112], // single break, closes 112 > 110
]);
const d1 = classifyDrive(firstOnly, 'BULLISH');
ok('drive: FIRST_DRIVE on single fresh break', d1.label === 'FIRST_DRIVE');
ok('drive: edge detected ~110', d1.edge === 110);

// SECOND drive after FAILED first (shakeout): wick above 110 closes back inside,
// pulls in, then a real close above at the end.
const failedThenDrive = driveSeq(20, 90, 110, [
  [105,108,104,106],[106,109,105,107],[107,109,105,106],[106,108,104,105],
  [105,108,104,106],[106,109,105,107],[107,109,105,106],[106,108,104,105],
  [108,113,107,108], // FAILED first: wick 113 > 110 but close 108 back inside
  [107,109,105,106],[106,108,104,105],[105,108,104,106], // pull back inside
  [106,109,105,107],[107,109,105,106],[106,108,104,105],[105,108,104,106],
  [106,109,105,107],[107,109,105,106],[106,109,105,107],[109,114,108,113], // second drive closes 113 > 110
]);
const d2 = classifyDrive(failedThenDrive, 'BULLISH');
ok('drive: SECOND_DRIVE after failed first', d2.label === 'SECOND_DRIVE');
ok('drive: basis FAILED_FIRST', d2.basis === 'FAILED_FIRST');
ok('drive: counts >= 2 drives', d2.drives >= 2);

// No directional bias / bad dir → NONE, never throws.
ok('drive: NONE on null dir', classifyDrive(firstOnly, null).label === 'NONE');
ok('drive: NONE on empty candles', classifyDrive([], 'BULLISH').label === 'NONE');

// --- detectSecondDrive (the gate shape) -----------------------------------
const g1 = detectSecondDrive(firstOnly, 'BULLISH');
ok('gate: first drive → isSecondDrive false', g1.isSecondDrive === false);
ok('gate: carries label for badge', g1.label === 'FIRST_DRIVE');
const g2 = detectSecondDrive(failedThenDrive, 'BULLISH');
ok('gate: second drive → isSecondDrive true', g2.isSecondDrive === true);
ok('gate: exposes firstDriveIdx', Number.isInteger(g2.firstDriveIdx));
ok('gate: basis FAILED_FIRST', g2.basis === 'FAILED_FIRST');
ok('gate: NONE dir safe', detectSecondDrive(firstOnly, null).isSecondDrive === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
