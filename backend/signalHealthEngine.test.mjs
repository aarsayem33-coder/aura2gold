// Tests for signalHealthEngine — run: node signalHealthEngine.test.mjs
import { computeSnapshot, evaluateSignalHealth } from './signalHealthEngine.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FAIL  ${n}`); } };

const base = Date.UTC(2026, 0, 1, 0, 0, 0);
const min5 = 5 * 60 * 1000;
const mk = (arr, startMs = base) => arr.map((c, i) => ({ open: c[0], high: c[1], low: c[2], close: c[3], time: new Date(startMs + i * min5).toISOString() }));

// BUY XAU @ 2000, SL 1990 (risk 10.0 = 100 pips at pip 0.1), TP1 2010.
const sig = { direction: 'BUY', entryPrice: 2000, stopLoss: 1990, takeProfit1: 2010, takeProfit2: 2020, takeProfit3: 2030 };
const pip = 0.1;

// Case A: price ran up to 2008 then sits at 2006 (in profit, no TP hit, no danger).
{
  const candles = mk([[2000,2002,1999,2001],[2001,2008,2000,2006],[2006,2007,2005,2006]]);
  const snap = computeSnapshot({ ...sig, candles, pip, signalMs: base });
  ok('A snapshot valid', snap.valid);
  ok('A currentPips ~60', Math.abs(snap.currentPips - 60) < 1);     // (2006-2000)/0.1
  ok('A currentR ~0.6', Math.abs(snap.currentR - 0.6) < 0.05);
  ok('A mfeR ~0.8 (peak 2008)', Math.abs(snap.mfeR - 0.8) < 0.05);
  ok('A no TP/SL hit', snap.tpHit === 0 && !snap.slHit);
  const h = evaluateSignalHealth({ snapshot: snap, direction: 'BUY' });
  ok('A healthy', h.riskState === 'HEALTHY' && h.severity === 0);
}

// Case B: price near stop (1992.5 = -0.75R) → CLOSE_NOW sl_proximity.
{
  const candles = mk([[2000,2001,1999,2000],[2000,2000,1992,1992.5]]);
  const snap = computeSnapshot({ ...sig, candles, pip, signalMs: base });
  ok('B currentR ~ -0.75', Math.abs(snap.currentR + 0.75) < 0.05);
  const h = evaluateSignalHealth({ snapshot: snap, direction: 'BUY' });
  ok('B CLOSE_NOW', h.severity === 3 && h.status === 'CLOSE_NOW');
  ok('B reason is sl proximity', ['sl_proximity', 'max_loss'].includes(h.alertType));
}

// Case C: opposite committed signal → CLOSE_NOW.
{
  const candles = mk([[2000,2003,1999,2002]]);
  const snap = computeSnapshot({ ...sig, candles, pip, signalMs: base });
  const h = evaluateSignalHealth({ snapshot: snap, direction: 'BUY', freshDecision: { decision: 'SELL', htfBias: 'BEARISH' } });
  ok('C opposite signal CLOSE_NOW', h.severity === 3 && h.alertType === 'opposite_signal');
}

// Case D: profit give-back — peaked +1.2R, now +0.2R → DANGER giveback.
{
  const candles = mk([[2000,2012,2000,2011],[2011,2011,2001,2002]]);  // peak 2012 (+1.2R), now 2002 (+0.2R)
  const snap = computeSnapshot({ ...sig, candles, pip, signalMs: base });
  ok('D mfeR ~1.2', Math.abs(snap.mfeR - 1.2) < 0.05);
  ok('D currentR ~0.2', Math.abs(snap.currentR - 0.2) < 0.05);
  const h = evaluateSignalHealth({ snapshot: snap, direction: 'BUY' });
  ok('D giveback DANGER', h.severity === 2 && h.alertType === 'giveback');
}

// Case E: TP1 hit → status TP1_HIT, manage.
{
  const candles = mk([[2000,2011,2000,2010]]);
  const snap = computeSnapshot({ ...sig, candles, pip, signalMs: base });
  ok('E tpHit 1', snap.tpHit === 1);
  const h = evaluateSignalHealth({ snapshot: snap, direction: 'BUY' });
  ok('E status TP1_HIT', h.status === 'TP1_HIT' && h.alertType === 'tp_hit');
}

// Case F: counter breaker with displacement → CLOSE_NOW.
{
  const candles = mk([[2000,2003,1999,2001]]);
  const snap = computeSnapshot({ ...sig, candles, pip, signalMs: base });
  const h = evaluateSignalHealth({ snapshot: snap, direction: 'BUY', breaker: { type: 'BEARISH', displacement: { present: true, atrMultiple: 1.5 } } });
  ok('F counter breaker CLOSE_NOW', h.severity === 3 && h.alertType === 'counter_breaker');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
