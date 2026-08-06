/**
 * Would-Trade ledger — every MT5 trade decision, taken or not, across all accounts.
 *
 * SCOPE
 * The source is `mt5_auto_trades`: the log of everything that reached the auto-trader. That is
 * 592 decisions across 10 accounts, of which 188 actually filled. It is deliberately NOT the
 * 56k strategy signal log — that log resolves each signal by holding it to its target, which
 * measured 1.21R per trade more optimistic than the account on identical trades. Here every
 * money figure on a taken trade is what the broker actually paid.
 *
 * TWO POPULATIONS, NEVER MIXED
 *   TAKEN      — filled, closed, real `profit`. Authoritative.
 *   NOT TAKEN  — expired, guard-skipped, errored, rejected, invalid, cancelled, shadow, capped.
 *                Real decisions with no outcome, because the trade never existed. They are
 *                counted and explained but carry no P&L, and are never summed into the money.
 *
 * Reporting a "missed profit" for the not-taken set would require assuming how each would have
 * finished — exactly the assumption that made the signal log optimistic. The honest statement
 * is how many were missed and why, so the reasons can be fixed.
 *
 * Money is real, so R is measured against the risk that was actually budgeted for that ticket
 * (`risk_amount`), which is what makes a $10 loss on one account comparable to a $90 loss on
 * another. Accounts are a first-class dimension: 10 of them ran in six weeks, and pooling their
 * results without being able to split them hides which account carried which behaviour.
 *
 * Pure: rows in, verdict out. No I/O, no clock, no database.
 */

import { symbolCapsFor } from './instruments.js';

const n = (v) => Number(v);
// Number(null) is 0 and 0 is finite — the coercion behind seven separate defects in this
// codebase. Every optional number goes through this rather than a bare isFinite.
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(n(v)) ? null : n(v));
const round = (v, p = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** p) / 10 ** p : v);

export const DECISION = { TAKEN: 'TAKEN', NOT_TAKEN: 'NOT_TAKEN' };

/** Statuses that mean money actually moved. Everything else never reached the market. */
export const TAKEN_STATUSES = new Set(['CLOSED', 'OPEN', 'FILLED']);

/** Why a decision never became a trade, in plain language, keyed by status. */
export const NOT_TAKEN_REASONS = {
  EXPIRED: 'setup went stale before it could fill',
  GUARD_SKIP: 'challenge risk guard refused it',
  ERROR: 'broker or bridge rejected the order',
  REJECTED: 'you declined it',
  INVALID: 'ticket geometry was unusable',
  SHADOW: 'shadow mode — never sent',
  CAP_ALERT: 'concurrent-position cap reached',
  CANCELLED: 'cancelled before fill',
};

/**
 * Price move that equals one pip.
 *
 * Index CFDs go through SYMBOL_CAPS: treating USTEC's 1.0-point pip as forex's 0.0001 reports a
 * mean stop of 771,478 pips, which is how index rows poisoned an earlier measurement.
 */
export function pipSizeFor(symbol) {
  const caps = symbolCapsFor(symbol);
  if (caps && num(caps.pipSize) !== null) return num(caps.pipSize);
  const s = String(symbol || '').toUpperCase();
  if (s.includes('XAU')) return 0.1;
  if (s.includes('XAG')) return 0.01;
  if (s.includes('JPY')) return 0.01;
  return 0.0001;
}

/** TAKEN vs NOT_TAKEN, with the reason a decision never became a trade. */
export function decisionOf(row) {
  const status = String(row?.status || '').toUpperCase();
  if (TAKEN_STATUSES.has(status) && num(row?.fill_price) !== null) {
    return { decision: DECISION.TAKEN, status, reason: null };
  }
  return {
    decision: DECISION.NOT_TAKEN,
    status,
    reason: NOT_TAKEN_REASONS[status] || String(row?.reason || 'unknown').slice(0, 120),
  };
}

/**
 * Realised R — profit over the risk that was budgeted for THAT ticket.
 *
 * Not profit over a fixed number: risk_amount varied from $10 to $85 across these accounts, so
 * raw dollars rank a big-risk scratch above a small-risk winner. Null when the trade never
 * filled or never had a stated risk, so it can be counted without diluting expectancy.
 */
export function tradeR(row) {
  const profit = num(row?.profit);
  const risk = num(row?.risk_amount);
  if (profit === null || risk === null || risk <= 0) return null;
  return round(profit / risk, 3);
}

/**
 * Pips captured, measured fill to close and signed by direction.
 *
 * Deliberately from the actual fill rather than the planned entry: the plan is what was hoped
 * for, and on this account the fill has run up to a pip away from it.
 */
export function tradePips(row) {
  const fill = num(row?.fill_price);
  const close = num(row?.close_price);
  if (fill === null || close === null) return null;
  const sell = String(row?.direction || '').toUpperCase() === 'SELL';
  const move = sell ? fill - close : close - fill;
  return round(move / pipSizeFor(row?.symbol), 1);
}

/**
 * Aggregate real trade results.
 *
 * Expectancy leads and win rate follows, because they routinely disagree: nine 0.1R wins and one
 * -1R loss is a 90% win rate that loses money, and that exact shape appeared in this project's
 * lateness buckets. Not-taken decisions are counted separately and contribute nothing to money.
 */
export function summarise(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const taken = list.filter((x) => x.decision === DECISION.TAKEN);
  const notTaken = list.filter((x) => x.decision === DECISION.NOT_TAKEN);
  const settled = taken.filter((x) => num(x.profit) !== null);
  const withR = settled.filter((x) => num(x.r) !== null);
  const wins = settled.filter((x) => x.profit > 0);
  const losses = settled.filter((x) => x.profit < 0);

  const netProfit = settled.reduce((a, x) => a + x.profit, 0);
  const grossWin = wins.reduce((a, x) => a + x.profit, 0);
  const grossLoss = Math.abs(losses.reduce((a, x) => a + x.profit, 0));
  const netR = withR.reduce((a, x) => a + x.r, 0);
  const netPips = settled.reduce((a, x) => a + (num(x.pips) ?? 0), 0);
  const lots = settled.reduce((a, x) => a + (num(x.lots) ?? 0), 0);

  // Equity curve in real money, for the two facts a headline total always hides.
  let peak = 0, cum = 0, maxDd = 0, streak = 0, worstStreak = 0;
  for (const x of settled) {
    cum += x.profit;
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
    if (x.profit < 0) { streak += 1; worstStreak = Math.max(worstStreak, streak); } else streak = 0;
  }

  return {
    decisions: list.length,
    taken: taken.length,
    notTaken: notTaken.length,
    // Share of decisions that ever became a trade — the number that says whether the pipeline
    // is delivering or quietly dropping most of what it finds.
    fillRate: list.length ? round(taken.length / list.length, 4) : null,
    settled: settled.length,
    wins: wins.length,
    losses: losses.length,
    winRate: settled.length ? round(wins.length / settled.length, 4) : null,
    netProfit: round(netProfit),
    grossWin: round(grossWin),
    grossLoss: round(grossLoss),
    avgWin: wins.length ? round(grossWin / wins.length) : null,
    avgLoss: losses.length ? round(-grossLoss / losses.length) : null,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : (grossWin > 0 ? Infinity : null),
    // NaN, not 0: no settled trades means no expectancy, and a zero would rank it above losers.
    expectancy: settled.length ? round(netProfit / settled.length) : NaN,
    expectancyR: withR.length ? round(netR / withR.length, 3) : NaN,
    netR: round(netR, 2),
    netPips: round(netPips, 1),
    totalLots: round(lots, 2),
    maxDrawdown: round(maxDd),
    worstLossStreak: worstStreak,
  };
}

/**
 * Standard error of expectancy in R, and the t-statistic against "this has no edge".
 *
 * Reported so a ranking can be read with its uncertainty attached. A combo at +0.8R over six
 * trades and one at +0.15R over four hundred are not the same claim, and sorting by total
 * profit alone puts the six-trade fluke on top.
 */
export function tStatistic(rows) {
  const settled = (rows || []).filter((x) => num(x.r) !== null);
  const nn = settled.length;
  if (nn < 2) return { n: nn, mean: null, sd: null, t: null };
  const mean = settled.reduce((a, x) => a + x.r, 0) / nn;
  const variance = settled.reduce((a, x) => a + (x.r - mean) ** 2, 0) / (nn - 1);
  const sd = Math.sqrt(variance);
  const se = sd / Math.sqrt(nn);
  return { n: nn, mean: round(mean, 3), sd: round(sd, 3), t: se > 0 ? round(mean / se, 2) : null };
}

/**
 * The multiple-comparison bar.
 *
 * Searching k combos for the best one inflates the false-positive rate to roughly 1-(1-a)^k.
 * The Šidák-corrected threshold is the honest bar, and it is deliberately strict — the
 * alternative is shipping a "winning combo" that is noise, which this project has already paid
 * for twice. Normal critical value via a rational approximation of the inverse CDF: exact
 * enough at these sample sizes, and no conclusion turns on the third decimal.
 */
export function multipleComparisonBar(comboCount, alpha = 0.05) {
  const k = Math.max(1, num(comboCount) ?? 1);
  const perTest = 1 - (1 - alpha) ** (1 / k);
  const p = 1 - perTest / 2;
  const t = Math.sqrt(-2 * Math.log(1 - p));
  const z = t - ((2.515517 + 0.802853 * t + 0.010328 * t * t)
    / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t));
  return { combosTested: k, alpha, perTestAlpha: perTest, criticalT: round(z, 2) };
}

/**
 * Group decisions and rank them, with significance attached.
 *
 * `minTrades` exists because a combo with four fills cannot be evidence of anything; ranking
 * without it surfaces exactly the flukes the correction then has to reject. Sorted by real net
 * profit, since that is the question being asked.
 */
export function groupBy(rows, dimensions, { minTrades = 10, alpha = 0.05 } = {}) {
  const dims = Array.isArray(dimensions) ? dimensions : [dimensions];
  const buckets = new Map();
  for (const x of rows || []) {
    const key = dims.map((d) => x[d] ?? '—').join(' · ');
    if (!buckets.has(key)) buckets.set(key, { key, dims: Object.fromEntries(dims.map((d) => [d, x[d] ?? null])), rows: [] });
    buckets.get(key).rows.push(x);
  }
  const bar = multipleComparisonBar(buckets.size, alpha);
  const out = [];
  for (const b of buckets.values()) {
    const stats = summarise(b.rows);
    const sig = tStatistic(b.rows);
    out.push({
      key: b.key,
      ...b.dims,
      ...stats,
      tStat: sig.t,
      significant: sig.t !== null && stats.settled >= minTrades && Math.abs(sig.t) >= bar.criticalT,
      // What an uncorrected reading would have claimed, kept visible so the gap is obvious.
      nominallySignificant: sig.t !== null && Math.abs(sig.t) >= 1.96,
      belowSampleFloor: stats.settled < minTrades,
    });
  }
  out.sort((a, b) => {
    if (a.belowSampleFloor !== b.belowSampleFloor) return a.belowSampleFloor ? 1 : -1;
    return (b.netProfit ?? -Infinity) - (a.netProfit ?? -Infinity);
  });
  return { rows: out, bar };
}

/**
 * Why decisions never became trades, biggest cause first — the fix list.
 *
 * 404 of 592 decisions never reached the market. Which reason dominates decides what to fix,
 * and no amount of strategy ranking answers it.
 */
export function notTakenBreakdown(rows) {
  const byStatus = new Map();
  for (const x of rows || []) {
    if (x.decision !== DECISION.NOT_TAKEN) continue;
    const s = x.status || 'UNKNOWN';
    if (!byStatus.has(s)) byStatus.set(s, { status: s, reason: NOT_TAKEN_REASONS[s] || 'unclassified', count: 0, examples: [] });
    const b = byStatus.get(s);
    b.count += 1;
    if (b.examples.length < 3 && x.reason) b.examples.push(String(x.reason).slice(0, 120));
  }
  const total = [...byStatus.values()].reduce((a, b) => a + b.count, 0);
  return [...byStatus.values()]
    .map((b) => ({ ...b, share: total ? round(b.count / total, 4) : 0 }))
    .sort((a, b) => b.count - a.count);
}
