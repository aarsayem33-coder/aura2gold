// Sanity tests for strategyLab — run: node strategyLab.test.mjs
// Covers the candlestick pattern detector and the Swing Structure Candles strategy.
import { detectCandlePatterns, evaluateStrategy, listStrategies, STRATEGIES } from './strategyLab.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name}`); } };

const C = (o, h, l, c) => ({ open: o, high: h, low: l, close: c, time: new Date().toISOString() });
// detectCandlePatterns reads the last 3 candles; prefix neutral fillers.
const F = C(100, 100.4, 99.6, 100);

// --- Candlestick pattern unit tests ---
function patterns(seq) { return detectCandlePatterns([F, F, F, ...seq].slice(-3)); }

// Hammer: long lower wick, tiny body near top.
ok('hammer → bullish', patterns([C(100, 101.2, 97, 101)]).bull?.name === 'hammer / bullish pin');
// Shooting star: long upper wick, tiny body near bottom.
ok('shooting star → bearish', patterns([C(100, 102, 99.8, 99.8)]).bear?.name === 'shooting star / bearish pin');
// Bullish engulfing: prev bear, current bull engulfs body.
ok('bullish engulfing', detectCandlePatterns([F, C(101, 101.3, 99.8, 100), C(99.5, 101.7, 99.3, 101.5)]).bull?.name === 'bullish engulfing');
// Bearish engulfing: prev bull, current bear engulfs body.
ok('bearish engulfing', detectCandlePatterns([F, C(100, 101.2, 99.7, 101), C(101.5, 101.7, 99.3, 99.5)]).bear?.name === 'bearish engulfing');
// Dragonfly doji → weak bullish; gravestone → weak bearish.
ok('dragonfly doji → bullish (weak)', patterns([C(101, 101.05, 99, 100.98)]).bull?.name === 'dragonfly doji');
ok('gravestone doji → bearish (weak)', patterns([C(100, 102, 99.97, 100.02)]).bear?.name === 'gravestone doji');
// Neutral doji: long both wicks, tiny body → NOT directional on its own.
{ const p = patterns([C(100, 101, 99, 100.02)]); ok('neutral doji → no direction', p.doji && !p.bull && !p.bear); }

// --- Build a clean multi-swing uptrend (HH + HL) for the strategy ---
function buildUptrend() {
  const candles = [];
  let t = Date.UTC(2026, 0, 1);
  const step = 3600 * 1000;
  const push = (o, h, l, c) => { candles.push({ open: o, high: h, low: l, close: c, time: new Date(t).toISOString() }); t += step; };
  const pivots = [];
  for (let k = 0; k < 8; k++) { pivots.push({ type: 'L', v: 100 + k * 5 }); pivots.push({ type: 'H', v: 107 + k * 5 }); }
  const seq = [];
  for (let i = 0; i < pivots.length; i++) {
    seq.push(pivots[i].v);
    if (i < pivots.length - 1) { const a = pivots[i].v, b = pivots[i + 1].v; for (let j = 1; j <= 3; j++) seq.push(a + (b - a) * j / 4); }
  }
  for (let idx = 0; idx < seq.length; idx++) {
    const close = seq[idx];
    const open = idx > 0 ? seq[idx - 1] : close;
    if (idx % 4 === 0) {
      const p = pivots[idx / 4];
      if (p.type === 'H') push(open, close + 2, Math.min(open, close) - 0.3, close);
      else push(open, Math.max(open, close) + 0.3, close - 2, close);
    } else {
      push(open, Math.max(open, close) + 0.3, Math.min(open, close) - 0.3, close);
    }
  }
  return candles; // ends at the last HIGH pivot (=142); latest higher low = 135
}

const up = buildUptrend();
// Append a pullback toward the latest higher low (≈133) ending in a bullish engulfing.
const tail = (o, h, l, c) => up.push({ open: o, high: h, low: l, close: c, time: new Date(Date.UTC(2026, 1, 1) + up.length * 3600000).toISOString() });
tail(144, 144.3, 141, 141);
tail(141, 141.3, 138, 138);
tail(138, 138.3, 135, 135);
tail(135, 135.2, 133.2, 134);      // prev bear (body 1)
tail(133.5, 135.7, 133.3, 135.5);  // bullish engulfing near the higher low (≈133)

const buy = evaluateStrategy('swing-structure-candles', { symbol: 'TEST', timeframe: 'H1', candles: up, pip: 0.01, h4Trend: 'BULLISH', ltfTimeframe: 'M30', ltfCandles: buildUptrend() });
ok('uptrend + bullish engulfing at higher low + LTF confirm → BUY', buy && buy.decision === 'BUY');
ok('BUY signal is well-formed (entry/stop/TP3/RR)', buy && buy.stopLoss < buy.entry && buy.takeProfit3 > buy.entry && buy.riskRewardRatio >= 1.8);
ok('BUY meta reports swing strength + pattern', buy && buy.meta && buy.meta.strength >= 3 && /engulfing/.test(buy.meta.pattern || ''));
ok('BUY meta reports LTF confirm verdict', buy && buy.meta && buy.meta.ltf && buy.meta.ltf.verdict === 'CONFIRM');

// --- Lower-timeframe confirmation gate ---
// Mirror an uptrend around a constant → a clean downtrend (falling HH/HL becomes LH/LL).
const mirror = (cs) => cs.map((k) => ({ open: 300 - k.open, high: 300 - k.low, low: 300 - k.high, close: 300 - k.close, time: k.time }));
// Same main-TF BUY setup, but the lower TF is in a downtrend → CONTRADICT → no signal.
const buyContra = evaluateStrategy('swing-structure-candles', { symbol: 'TEST', timeframe: 'H1', candles: up, pip: 0.01, h4Trend: 'BULLISH', ltfTimeframe: 'M30', ltfCandles: mirror(buildUptrend()) });
ok('LTF contradicts (downtrend) → no BUY', !(buyContra && buyContra.decision === 'BUY'));
// Same setup, NO lower-TF data + strict (default ltfRequired) → MISSING → no signal.
const buyMissing = evaluateStrategy('swing-structure-candles', { symbol: 'TEST', timeframe: 'H1', candles: up, pip: 0.01, h4Trend: 'BULLISH' });
ok('LTF missing + strict → no BUY', !(buyMissing && buyMissing.decision === 'BUY'));

// Neutral doji at the same higher low should NOT fire a directional trade.
const up2 = buildUptrend();
const tail2 = (o, h, l, c) => up2.push({ open: o, high: h, low: l, close: c, time: new Date().toISOString() });
tail2(144, 144.3, 141, 141); tail2(141, 141.3, 138, 138); tail2(138, 138.3, 135, 135); tail2(135, 135.2, 133.2, 134);
tail2(134, 135.5, 132.5, 134.03); // neutral doji (long both wicks, tiny body) near the higher low
const dojiSig = evaluateStrategy('swing-structure-candles', { symbol: 'TEST', timeframe: 'H1', candles: up2, pip: 0.01, h4Trend: 'BULLISH' });
ok('neutral doji alone → no BUY', !(dojiSig && dojiSig.decision === 'BUY'));

// --- Volatility contraction (#1): tight base before the trigger → bonus + tighter stop ---
const upTight = buildUptrend();
const tailT = (o, h, l, c) => upTight.push({ open: o, high: h, low: l, close: c, time: new Date(Date.UTC(2026, 1, 2) + upTight.length * 3600000).toISOString() });
tailT(144, 144.2, 141, 141.2);      // pull back toward the latest higher-low pivot (≈133)
tailT(141.2, 141.4, 138, 138.2);
tailT(138.2, 138.4, 135, 135.2);
tailT(135.2, 135.4, 134.2, 134.3);
tailT(134.3, 134.4, 134.0, 134.2);  // ┐
tailT(134.2, 134.3, 133.9, 134.1);  // │ tight 5-bar base near the pivot (narrow ranges « ATR)
tailT(134.1, 134.2, 133.8, 134.0);  // │
tailT(134.0, 134.1, 133.7, 133.9);  // │
tailT(133.9, 134.0, 133.6, 133.7);  // ┘
tailT(133.7, 133.8, 133.3, 133.4);  // small bear into the base (c1)
tailT(133.2, 135.4, 133.1, 135.2);  // bullish engulfing breakout (c0)
const buyTight = evaluateStrategy('swing-structure-candles', { symbol: 'TEST', timeframe: 'H1', candles: upTight, pip: 0.01, h4Trend: 'BULLISH', ltfTimeframe: 'M30', ltfCandles: buildUptrend() });
ok('tight base + engulfing → BUY', buyTight && buyTight.decision === 'BUY');
ok('contraction flagged in meta', buyTight && buyTight.meta && buyTight.meta.contraction && buyTight.meta.contraction.contracted === true);
ok('contracted BUY keeps valid RR/levels', buyTight && buyTight.stopLoss < buyTight.entry && buyTight.takeProfit3 > buyTight.entry && buyTight.riskRewardRatio >= 1.8);
ok('non-contracted wide pullback NOT flagged', buy && buy.meta && buy.meta.contraction && buy.meta.contraction.contracted === false);

// --- Flat-base / equal-highs breakout (#2): confirmed close beyond the level, anti-trap ---
function buildFlatBase() {
  const candles = [];
  let t = Date.UTC(2026, 2, 1); const step = 3600 * 1000;
  const push = (o, h, l, c) => { candles.push({ open: o, high: h, low: l, close: c, time: new Date(t).toISOString() }); t += step; };
  for (let k = 0; k < 16; k++) {        // 64 bars coiling in a tight 100–102 box → equal highs @102, equal lows @100
    push(100.5, 101.0, 100.2, 100.8);   // cycle-start low 100.2 (keeps the 100.0 trough a strict pivot)
    push(100.8, 102.0, 100.6, 101.6);   // peak ≈102 (equal-high shelf)
    push(101.6, 101.8, 101.0, 101.1);
    push(101.1, 101.3, 100.0, 100.4);   // trough ≈100 (equal-low shelf)
  }
  return candles;
}
const flat = buildFlatBase();
flat.push({ open: 101.8, high: 102.7, low: 101.7, close: 102.6, time: new Date(Date.UTC(2026, 3, 1)).toISOString() }); // confirmed close above 102
const bo = evaluateStrategy('swing-structure-candles', { symbol: 'TEST', timeframe: 'H1', candles: flat, pip: 0.01, h4Trend: null, ltfTimeframe: 'M30', ltfCandles: buildUptrend() });
ok('flat base + confirmed close above equal highs → BUY breakout', bo && bo.decision === 'BUY' && bo.meta.kind === 'breakout');
ok('breakout signal well-formed (entry/stop/TP3/RR)', bo && bo.stopLoss < bo.entry && bo.takeProfit3 > bo.entry && bo.riskRewardRatio >= 1.8);
ok('breakout reason names the equal-highs base', bo && /equal-highs|equal highs/.test(bo.reason || ''));

// Trap: wick pierces the shelf but the candle CLOSES back inside → no breakout (confirmed-close rule).
const trap = buildFlatBase();
trap.push({ open: 101.6, high: 102.8, low: 101.4, close: 101.5, time: new Date(Date.UTC(2026, 3, 1)).toISOString() }); // wick through 102, close inside
const trapSig = evaluateStrategy('swing-structure-candles', { symbol: 'TEST', timeframe: 'H1', candles: trap, pip: 0.01, h4Trend: null, ltfTimeframe: 'M30', ltfCandles: buildUptrend() });
ok('wick-through that closes inside → no breakout (trap rejected)', !(trapSig && trapSig.meta && trapSig.meta.kind === 'breakout'));

// --- Registry wiring ---
ok('registry contains swing-structure-candles', !!STRATEGIES['swing-structure-candles']);
ok('listStrategies exposes swing-structure-candles', listStrategies().some((s) => s.id === 'swing-structure-candles'));

// --- Failed Break Reversion strategy ---
ok('registry contains failed-break-reversion', !!STRATEGIES['failed-break-reversion']);
ok('listStrategies exposes failed-break-reversion', listStrategies().some((s) => s.id === 'failed-break-reversion'));

// Build a failed UP-break: a wide base (refHigh~100.3, refLow=95 from one deep bar),
// a candle that CLOSES above the base high (the break), then a candle that CLOSES back
// inside (the failure/trap) → expect a SELL fade to the opposite side of the range.
function failedUpBreak() {
  const c = []; let t = Date.UTC(2026, 2, 1); const step = 3600000;
  const push = (o, h, l, cl) => { c.push({ open: o, high: h, low: l, close: cl, time: new Date(t).toISOString() }); t += step; };
  for (let i = 0; i < 8; i++) push(100, 100.3, 99.7, 100);   // tight base
  push(100, 100.2, 95, 99.9);                                // one deep low → refLow≈95 (target room)
  for (let i = 0; i < 8; i++) push(100, 100.3, 99.7, 100);   // more base (deep low stays in ref window)
  push(100, 101.0, 99.9, 100.8);                             // BREAK: closes above 100.3
  push(100.8, 100.9, 99.6, 100.0);                           // RECLAIM: closes back inside → trap
  return c;
}
const fade = evaluateStrategy('failed-break-reversion', { symbol: 'TEST', timeframe: 'M15', candles: failedUpBreak(), pip: 0.01, h4Trend: 'BEARISH' });
ok('failed up-break → SELL fade', fade && fade.decision === 'SELL');
ok('SELL fade well-formed (stop above entry, target below, RR≥1.5)', fade && fade.stopLoss > fade.entry && fade.takeProfit3 < fade.entry && fade.riskRewardRatio >= 1.5);
ok('reason names the failed break', fade && /failed up-break|reverted back inside/i.test(fade.reason || ''));
// A clean one-directional series (no failed break) must NOT fire.
const noFail = evaluateStrategy('failed-break-reversion', { symbol: 'TEST', timeframe: 'M15', candles: buildUptrend(), pip: 0.01, h4Trend: 'BULLISH' });
ok('clean trend (no failed break) → no signal', !noFail);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
