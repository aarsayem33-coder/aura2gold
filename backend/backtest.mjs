/**
 * Backtest harness — the guarantees that four failed studies taught me to bake in.
 *
 * Every study this week was bespoke, and each one re-made a mistake the previous one had
 * already exposed. This module exists so those mistakes are structurally impossible rather
 * than something to remember:
 *
 *  1. NO LOOKAHEAD. The evaluator only ever receives candles[0..i]. Outcomes are resolved
 *     strictly from bars after i.
 *
 *  2. SEQUENCE RESOLVED ON FINE BARS. A daily or M15 bar that touches both the stop and the
 *     target cannot say which came first. Guessing "target" turns losing systems into winning
 *     backtests. The harness walks M5 (or finer) and, when a single fine bar still straddles
 *     both, records a LOSS — the conservative reading, never the flattering one.
 *
 *  3. EXPECTANCY LEADS, WIN RATE FOLLOWS. ict-breaker showed a 97% win rate at -0.74R
 *     expectancy because its "wins" were entries already past their own target. Any report
 *     that leads with win rate invites that error, so expectancy is the headline here.
 *
 *  4. EXECUTION IS MODELLED. Measured live behaviour: alerts arrive late and fills cost
 *     spread. A strategy that is +0.3R on ideal fills and -0.1R on real ones is a losing
 *     strategy, and that gap is where the live money actually went.
 *
 *  5. EVERY VARIANT IS COUNTED. Testing 24 configurations produces ~1 false winner at p<0.05
 *     by construction. The ledger records how many were tried so the result can be read with
 *     that in mind rather than presented as a single lucky discovery.
 *
 * Pure: no I/O, no database, no clock. Candles in, verdict out.
 */

const n = (v) => Number(v);
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(n(v)) ? null : n(v));

export const EXECUTION_IDEAL = { spread: 0, slippageAtr: 0, latenessBars: 0 };

/**
 * Apply measured execution reality to a signal before it is resolved.
 *
 * `latenessBars` shifts the fill to a later bar's open — the alert did not reach the broker
 * instantly. `spread` and `slippageAtr` move the fill against the trade. The STOP and TARGET
 * stay where the strategy put them, because that is what actually happens: the levels are
 * structural and only the entry drifts. That asymmetry is the whole point — it silently
 * shrinks reward and grows risk, exactly as observed live.
 */
export function applyExecution(signal, fineBars, startIdx, { spread = 0, slippageAtr = 0, latenessBars = 0, atr = 0 } = {}) {
  const buy = String(signal.decision).toUpperCase() === 'BUY';
  let fillIdx = startIdx;
  let entry = num(signal.entry);
  if (entry === null) return null;
  if (latenessBars > 0) {
    const target = Math.min(startIdx + latenessBars, fineBars.length - 1);
    if (target > startIdx) { fillIdx = target; entry = n(fineBars[target].open); }
  }
  const cost = n(spread) + n(slippageAtr) * n(atr);
  entry = buy ? entry + cost : entry - cost;      // always against the trade
  return { ...signal, entry, fillIdx };
}

/**
 * Walk fine bars forward and decide the trade. Returns { outcome, r, bars, exit }.
 *
 * `outcome` is WIN / LOSS / OPEN. OPEN means neither level was reached inside the window,
 * which is reported rather than silently counted as a scratch.
 */
export function resolveTrade(signal, fineBars, fromIdx, { maxBars = 2000 } = {}) {
  const buy = String(signal.decision).toUpperCase() === 'BUY';
  const entry = num(signal.entry), stop = num(signal.stopLoss), target = num(signal.takeProfit);
  if (entry === null || stop === null || target === null) return { outcome: 'INVALID', r: 0, bars: 0, exit: null };
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return { outcome: 'INVALID', r: 0, bars: 0, exit: null };
  // A target on the losing side is not a trade — it is a mis-specified ticket, and counting it
  // as an instant win is precisely how a broken strategy looks profitable.
  if (buy ? target <= entry : target >= entry) return { outcome: 'INVALID', r: 0, bars: 0, exit: null };
  if (buy ? stop >= entry : stop <= entry) return { outcome: 'INVALID', r: 0, bars: 0, exit: null };

  const end = Math.min(fineBars.length, fromIdx + maxBars);
  for (let j = fromIdx; j < end; j++) {
    const hi = n(fineBars[j].high), lo = n(fineBars[j].low);
    const hitStop = buy ? lo <= stop : hi >= stop;
    const hitTgt = buy ? hi >= target : lo <= target;
    // Both inside ONE fine bar: order still unknowable, so take the stop. Conservative by
    // design — the alternative flatters every result.
    if (hitStop) return { outcome: 'LOSS', r: -1, bars: j - fromIdx + 1, exit: stop };
    if (hitTgt) return { outcome: 'WIN', r: Math.abs(target - entry) / risk, bars: j - fromIdx + 1, exit: target };
  }
  return { outcome: 'OPEN', r: 0, bars: end - fromIdx, exit: null };
}

/**
 * Summary of a set of resolved trades. Expectancy first, deliberately.
 *
 * `expectancy` is the mean R across SETTLED trades — the number that decides whether a system
 * makes money. A 90% win rate at 0.2R loses; a 40% win rate at 2R wins.
 */
export function summarise(trades) {
  const settled = trades.filter((t) => t.outcome === 'WIN' || t.outcome === 'LOSS');
  const wins = settled.filter((t) => t.outcome === 'WIN');
  const losses = settled.filter((t) => t.outcome === 'LOSS');
  const expectancy = settled.length ? settled.reduce((a, t) => a + t.r, 0) / settled.length : NaN;
  const avgWin = wins.length ? wins.reduce((a, t) => a + t.r, 0) / wins.length : 0;

  // Equity curve in R, for the drawdown a win rate never shows.
  let eq = 0, peak = 0, maxDD = 0;
  for (const t of settled) { eq += t.r; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq); }

  // Longest losing streak — what actually breaks a challenge account.
  let streak = 0, worstStreak = 0;
  for (const t of settled) { streak = t.outcome === 'LOSS' ? streak + 1 : 0; worstStreak = Math.max(worstStreak, streak); }

  return {
    signals: trades.length,
    settled: settled.length,
    open: trades.filter((t) => t.outcome === 'OPEN').length,
    invalid: trades.filter((t) => t.outcome === 'INVALID').length,
    wins: wins.length,
    losses: losses.length,
    winRate: settled.length ? wins.length / settled.length : NaN,
    avgWinR: avgWin,
    expectancy,
    totalR: settled.reduce((a, t) => a + t.r, 0),
    maxDrawdownR: maxDD,
    worstLossStreak: worstStreak,
    avgBars: settled.length ? settled.reduce((a, t) => a + t.bars, 0) / settled.length : NaN,
  };
}

/** Map a signal-timeframe index onto the first fine bar at or after it. */
function fineIndexAt(fineBars, ts, hint = 0) {
  let i = Math.max(0, hint);
  while (i > 0 && n(fineBars[i].ts ?? Date.parse(fineBars[i].time)) > ts) i -= 1;
  while (i < fineBars.length && n(fineBars[i].ts ?? Date.parse(fineBars[i].time)) < ts) i += 1;
  return i;
}

/**
 * The main loop. `evaluate(window, i)` is called once per bar with candles[0..i] and must
 * return a signal or null. Signals are de-duplicated on `barIso` so one setup that persists
 * for several bars counts once — without that a six-bar setup becomes six trades and every
 * statistic inflates.
 */
export function walkForward({
  candles, fineBars, evaluate,
  warmup = 100, from = null, to = null,
  execution = EXECUTION_IDEAL, atrOf = null, maxBars = 2000,
  // The live lab hands every engine getRecentCandles(symbol, tf, 400) — never the full
  // history. Mirroring that is both FAITHFUL and fast: passing the whole array would make the
  // per-bar slice O(n), so a 237k-bar run becomes ~28 billion element copies and never
  // finishes. It also guarantees the backtest cannot see further back than production does.
  windowBars = 400,
}) {
  const cs = Array.isArray(candles) ? candles : [];
  const fine = Array.isArray(fineBars) && fineBars.length ? fineBars : cs;
  const tsOf = (b) => n(b.ts ?? Date.parse(b.time));
  const lo = from === null ? -Infinity : (typeof from === 'number' ? from : Date.parse(from));
  const hi = to === null ? Infinity : (typeof to === 'number' ? to : Date.parse(to));

  const trades = [];
  const seen = new Set();
  let hint = 0;
  for (let i = warmup; i < cs.length - 1; i++) {
    const ts = tsOf(cs[i]);
    if (ts < lo || ts >= hi) continue;
    // Bounded window ending exactly at i — never a bar beyond it, never the whole history.
    const wStart = windowBars > 0 ? Math.max(0, i + 1 - windowBars) : 0;
    const window = cs.slice(wStart, i + 1);
    let sig = null;
    try { sig = evaluate(window, i - wStart, { absoluteIndex: i }); } catch { sig = null; }
    if (!sig || !sig.decision) continue;
    const key = sig.barIso || `${ts}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Entry happens on the NEXT bar at the earliest — never the one the decision was made on.
    hint = fineIndexAt(fine, tsOf(cs[i + 1]), hint);
    if (hint >= fine.length) break;
    const atr = typeof atrOf === 'function' ? n(atrOf(window, window.length - 1)) : 0;
    const filled = applyExecution(sig, fine, hint, { ...execution, atr });
    if (!filled) continue;
    const res = resolveTrade(filled, fine, filled.fillIdx, { maxBars });
    trades.push({ ...res, ts, decision: sig.decision, entry: filled.entry, stopLoss: sig.stopLoss, takeProfit: sig.takeProfit });
  }
  return trades;
}

/**
 * Records every configuration tried, so a result can be read against how many shots were
 * taken. Twenty-four variants yield roughly one spurious winner at p<0.05; presenting the
 * best cell without that context is how noise gets promoted to a strategy.
 */
export class VariantLedger {
  constructor(label = '') { this.label = label; this.entries = []; }
  record(name, params, stats) {
    this.entries.push({ name, params: { ...params }, stats: { ...stats }, at: this.entries.length });
    return stats;
  }
  get count() { return this.entries.length; }
  /** Expected number of variants that clear a bar by chance alone. */
  expectedFalsePositives(alpha = 0.05) { return this.entries.length * alpha; }
  best(metric = 'expectancy') {
    const usable = this.entries.filter((e) => Number.isFinite(e.stats?.[metric]));
    if (!usable.length) return null;
    return usable.reduce((a, b) => (b.stats[metric] > a.stats[metric] ? b : a));
  }
  report(metric = 'expectancy') {
    return {
      label: this.label,
      variantsTested: this.entries.length,
      expectedFalsePositives: this.expectedFalsePositives(),
      best: this.best(metric),
      all: this.entries,
    };
  }
}
