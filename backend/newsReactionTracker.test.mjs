// Sanity tests for newsReactionTracker — run: node newsReactionTracker.test.mjs
import { computeNewsReactionTrend } from './newsReactionTracker.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name}`); } };

const eventMs = Date.UTC(2026, 0, 1, 12, 0, 0);
const min1 = 60 * 1000;
const pip = 0.0001;

// Build M1 candles starting at the release. `steps` = array of close deltas in pips;
// each candle's open = prev close, high/low padded.
function series(deltasPips, { padPips = 1 } = {}) {
  const candles = [];
  let close = 1.10000;
  let t = eventMs;
  // first candle opens AT the release price (release reference = open of bar 0)
  for (let i = 0; i < deltasPips.length; i++) {
    const open = close;
    close = open + deltasPips[i] * pip;
    const high = Math.max(open, close) + padPips * pip;
    const low = Math.min(open, close) - padPips * pip;
    candles.push({ time: new Date(t).toISOString(), open, high, low, close });
    t += min1;
  }
  return candles;
}

const nowMs = eventMs + 10 * min1;

// ── 1) Clean sustained up-move ────────────────────────────────────────────
const up = computeNewsReactionTrend({ candles: series([5, 6, 5, 7, 6, 5]), eventMs, pip, nowMs });
console.log(`  [diag] UP: dir=${up.direction} strength=${up.strength} conf=${up.confidence} netPips=${up.netMovePips} moveAtr=${up.moveAtr} slopeDir=${up.slopeDir} r2=${up.slopeR2} up/down=${up.upCandles}/${up.downCandles} fade=${up.retraceFromExtremePct}`);
ok('clean up-move → direction UP', up.direction === 'UP');
ok('clean up-move → positive net pips', up.netMovePips > 0);
ok('clean up-move → slope UP', up.slopeDir === 'UP');
ok('clean up-move → decent confidence', up.confidence >= 60);

// ── 2) Clean sustained down-move ──────────────────────────────────────────
const dn = computeNewsReactionTrend({ candles: series([-5, -6, -5, -7, -6, -5]), eventMs, pip, nowMs });
console.log(`  [diag] DOWN: dir=${dn.direction} netPips=${dn.netMovePips} slopeDir=${dn.slopeDir} conf=${dn.confidence}`);
ok('clean down-move → direction DOWN', dn.direction === 'DOWN');
ok('clean down-move → negative net pips', dn.netMovePips < 0);

// ── 3) Choppy / no net move → NEUTRAL ─────────────────────────────────────
const chop = computeNewsReactionTrend({ candles: series([6, -6, 5, -5, 6, -6]), eventMs, pip, nowMs });
console.log(`  [diag] CHOP: dir=${chop.direction} netPips=${chop.netMovePips} moveAtr=${chop.moveAtr} conf=${chop.confidence}`);
ok('choppy → direction NEUTRAL', chop.direction === 'NEUTRAL');
ok('choppy → low confidence', chop.confidence < 40);

// ── 4) Spike up then fade back (reversal risk) ────────────────────────────
// Big spike up (+30 pips over 3 bars) then gives most of it back (-24 pips).
const fade = computeNewsReactionTrend({ candles: series([12, 10, 8, -10, -8, -6]), eventMs, pip, nowMs });
console.log(`  [diag] FADE: dir=${fade.direction} netPips=${fade.netMovePips} fade=${fade.retraceFromExtremePct} conf=${fade.confidence}`);
ok('spike-then-fade → high retrace-from-extreme', fade.retraceFromExtremePct >= 60);

// ── 5) Elapsed + structural fields ────────────────────────────────────────
ok('elapsedSec reflects now - release', up.elapsedSec === 600);
ok('totalCandles counted', up.totalCandles === 6);
ok('releaseClose = open of first post-release bar', Math.abs(up.releaseClose - 1.10000) < 1e-9);

// ── 6) Empty / pre-release safety ─────────────────────────────────────────
ok('no post-release candles → null', computeNewsReactionTrend({ candles: [], eventMs, pip, nowMs }) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
