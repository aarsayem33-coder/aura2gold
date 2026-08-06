/**
 * Track what a chart AI analysis actually did.
 *
 * The AI panel emits a scored ticket — entry, stop, three targets, a setup score and a grade.
 * Until now none of it was recorded, so the score was an assertion nobody could check. This
 * module turns each analysis into a tracked position and reports, live, what it is worth.
 *
 * WHY R AND MONEY ARE BOTH REPORTED, AND WHY R LEADS
 * A chart AI call on gold and one on EURUSD move different numbers of dollars for the same
 * quality of read. R — profit over the distance to the stop — is the only unit in which two
 * analyses are comparable, and it is what makes "does a high score predict a better outcome?"
 * answerable. Money is reported alongside because that is what the account feels, but it is
 * derived from R and the suggested lot size, not measured independently.
 *
 * WHY MFE AND MAE ARE BOTH KEPT
 * A trade that ran 30 pips your way then stopped out is a different failure from one that went
 * straight to the stop, and only the adverse excursion distinguishes them. Reporting the
 * favourable side alone flatters every loser that was briefly green.
 *
 * Pure: prices in, verdict out. No I/O, no clock beyond what is passed, no database.
 */

const n = (v) => Number(v);
// Number(null) is 0 and 0 is finite — the coercion behind seven separate defects in this
// codebase. Every optional price goes through this rather than a bare isFinite.
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(n(v)) ? null : n(v));
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);

export const TRACK_STATUS = {
  WAITING: 'WAITING',           // price has not reached the entry yet
  RUNNING: 'RUNNING',           // entered, still open
  TP1: 'TP1', TP2: 'TP2', TP3: 'TP3',
  STOPPED: 'STOPPED',
  EXPIRED: 'EXPIRED',           // ran out of time without resolving
  NO_TRADE: 'NO_TRADE',         // the analysis never called a direction
};

/** A settled outcome is one where the position is closed and its result is final. */
export const SETTLED = new Set([TRACK_STATUS.TP1, TRACK_STATUS.TP2, TRACK_STATUS.TP3, TRACK_STATUS.STOPPED]);

/** Is this a tradeable call at all? HOLD and a missing direction are not. */
export function isTradeable(decision) {
  const d = String(decision || '').toUpperCase();
  return /BUY|SELL/.test(d);
}

/** BUY or SELL, normalised from STRONG_BUY / buy / etc. Null when there is no call. */
export function directionOf(decision) {
  const d = String(decision || '').toUpperCase();
  if (/BUY/.test(d)) return 'BUY';
  if (/SELL/.test(d)) return 'SELL';
  return null;
}

/**
 * Walk the candles after an analysis and work out where the trade stands.
 *
 * `candles` must be in ascending time order and start at or after the analysis. The walk is
 * chronological rather than a min/max scan because ORDER decides the outcome: a bar that
 * touches both the stop and a target is scored a LOSS, since which came first inside that bar
 * is unknowable and guessing "target" is how a losing system produces a winning record.
 */
/**
 * A complete NO_TRADE result.
 *
 * Every field the normal return produces must appear here, explicitly null. The early returns
 * originally listed only the fields they had opinions about, which left `exitPrice`, `barsHeld`
 * and `settled` as `undefined` — and mysql2 rejects undefined outright ("Bind parameters must
 * not contain undefined"), so the whole UPDATE threw. The rows that hit this path are exactly
 * the HOLD analyses, which are tracked ON PURPOSE for honest calibration, so every one of them
 * failed to resolve and retried forever.
 *
 * Building it in one place means a field added to the main return can only be forgotten here
 * once — the shape test below catches it.
 */
function noTrade(dir, note) {
  return {
    status: TRACK_STATUS.NO_TRADE,
    direction: dir,
    entered: false,
    settled: false,
    hitLevel: 0,
    r: null,
    profitUsd: null,
    mfeR: null,
    maeR: null,
    currentPrice: null,
    exitPrice: null,
    barsToEntry: null,
    barsHeld: 0,
    note,
  };
}

export function evaluateTrack(track, candles, { nowMs = Date.now() } = {}) {
  const dir = directionOf(track?.decision);
  const entry = num(track?.entry);
  const stop = num(track?.stopLoss);

  if (!dir || entry === null || stop === null) {
    return noTrade(dir, !dir ? 'the analysis did not call a direction' : 'no entry or stop to track');
  }

  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) {
    return noTrade(dir, 'entry equals stop — no risk to measure');
  }

  const buy = dir === 'BUY';
  const targets = [num(track?.takeProfit1), num(track?.takeProfit2), num(track?.takeProfit3)];
  const bars = Array.isArray(candles) ? candles : [];

  let entered = false;
  let status = TRACK_STATUS.WAITING;
  let hitLevel = 0;
  let mfe = 0, mae = 0;                       // in price, converted to R at the end
  let exitPrice = null;
  let barsToEntry = null, barsHeld = 0;

  for (let i = 0; i < bars.length; i++) {
    const hi = num(bars[i].high), lo = num(bars[i].low);
    if (hi === null || lo === null) continue;

    if (!entered) {
      // A market call is live from the first bar; the entry price is what it was analysed at.
      const reached = buy ? lo <= entry : hi >= entry;
      if (!reached) continue;
      entered = true;
      barsToEntry = i;
      status = TRACK_STATUS.RUNNING;
    }

    barsHeld += 1;
    // Favourable is the way the trade wants to go; adverse is the other. For a SELL those swap,
    // which is why both are written out rather than sharing one expression.
    const fav = buy ? hi - entry : entry - lo;
    const adv = buy ? entry - lo : hi - entry;
    if (fav > mfe) mfe = fav;
    if (adv > mae) mae = adv;

    const hitStop = buy ? lo <= stop : hi >= stop;
    // Stop first, always. Inside one bar the sequence is unknowable, and assuming the target
    // is what turns a losing system into a winning backtest.
    if (hitStop) {
      status = TRACK_STATUS.STOPPED;
      exitPrice = stop;
      break;
    }
    for (let t = targets.length - 1; t >= 0; t--) {
      const tp = targets[t];
      if (tp === null) continue;
      const hitTp = buy ? hi >= tp : lo <= tp;
      if (hitTp && t + 1 > hitLevel) {
        hitLevel = t + 1;
        exitPrice = tp;
      }
    }
    if (hitLevel === 3) { status = TRACK_STATUS.TP3; break; }
  }

  if (status === TRACK_STATUS.RUNNING && hitLevel > 0) {
    // Reached a target but not the final one and still open — report the best rung touched.
    status = hitLevel === 1 ? TRACK_STATUS.TP1 : TRACK_STATUS.TP2;
  }

  const lastClose = bars.length ? num(bars[bars.length - 1].close) : null;
  const markPrice = exitPrice ?? lastClose;
  const settled = SETTLED.has(status);

  // Open positions are marked to the last close; closed ones to the level that ended them.
  const move = markPrice === null ? null : (buy ? markPrice - entry : entry - markPrice);
  const r = move === null || !entered ? null : r3(move / risk);

  const lots = num(track?.lots);
  const pipSize = num(track?.pipSize);
  const pipValue = num(track?.pipValuePerLot);
  const profitUsd = (move !== null && entered && lots !== null && pipSize !== null && pipValue !== null && pipSize > 0)
    ? r2((move / pipSize) * pipValue * lots)
    : null;

  const expiresAt = track?.expiresAt ? Date.parse(track.expiresAt) : null;
  const expired = !settled && expiresAt !== null && nowMs > expiresAt;

  return {
    status: expired ? TRACK_STATUS.EXPIRED : status,
    direction: dir,
    entered,
    settled,
    hitLevel,
    r,
    profitUsd,
    // Excursions in R so they compare across instruments.
    mfeR: entered ? r3(mfe / risk) : null,
    maeR: entered ? r3(mae / risk) : null,
    currentPrice: lastClose,
    exitPrice,
    barsToEntry,
    barsHeld,
    note: !entered
      ? 'price has not reached the entry yet'
      : settled ? `closed at ${exitPrice}` : `open, marked at ${lastClose}`,
  };
}

/**
 * Does the setup score actually predict the outcome?
 *
 * This is the question tracking exists to answer. Grouped by score band rather than fitted,
 * because a fitted curve over a few dozen analyses would describe noise — and a score that
 * looks predictive only after curve-fitting is not a score, it is a story.
 */
export function scoreCalibration(tracks, { bands = [[85, 101], [75, 85], [65, 75], [0, 65]] } = {}) {
  const list = (Array.isArray(tracks) ? tracks : []).filter((t) => num(t.score) !== null && num(t.r) !== null);
  const out = [];
  for (const [lo, hi] of bands) {
    const inBand = list.filter((t) => t.score >= lo && t.score < hi);
    const wins = inBand.filter((t) => t.r > 0).length;
    out.push({
      band: hi > 100 ? `${lo}+` : `${lo}-${hi - 1}`,
      n: inBand.length,
      winRate: inBand.length ? r3(wins / inBand.length) : null,
      // Expectancy leads: a 90% win rate at 0.1R loses money, and this project has already
      // measured a 97% "win rate" that was really -0.74R.
      expectancyR: inBand.length ? r3(inBand.reduce((a, t) => a + t.r, 0) / inBand.length) : null,
      netR: inBand.length ? r2(inBand.reduce((a, t) => a + t.r, 0)) : null,
    });
  }
  return out;
}

/** Headline numbers over a set of tracked analyses. */
export function summariseTracks(tracks) {
  const list = Array.isArray(tracks) ? tracks : [];
  const settled = list.filter((t) => SETTLED.has(t.status) && num(t.r) !== null);
  const open = list.filter((t) => t.status === TRACK_STATUS.RUNNING || t.status === TRACK_STATUS.TP1 || t.status === TRACK_STATUS.TP2);
  const wins = settled.filter((t) => t.r > 0);
  const netR = settled.reduce((a, t) => a + t.r, 0);
  const openUsd = open.reduce((a, t) => a + (num(t.profitUsd) ?? 0), 0);
  const closedUsd = settled.reduce((a, t) => a + (num(t.profitUsd) ?? 0), 0);

  return {
    tracked: list.length,
    waiting: list.filter((t) => t.status === TRACK_STATUS.WAITING).length,
    open: open.length,
    settled: settled.length,
    wins: wins.length,
    losses: settled.length - wins.length,
    winRate: settled.length ? r3(wins.length / settled.length) : null,
    // NaN, not 0: nothing settled means no expectancy, and a zero would rank it above a loser.
    expectancyR: settled.length ? r3(netR / settled.length) : NaN,
    netR: r2(netR),
    openProfitUsd: r2(openUsd),
    closedProfitUsd: r2(closedUsd),
    avgMfeR: settled.length ? r3(settled.reduce((a, t) => a + (num(t.mfeR) ?? 0), 0) / settled.length) : null,
    avgMaeR: settled.length ? r3(settled.reduce((a, t) => a + (num(t.maeR) ?? 0), 0) / settled.length) : null,
  };
}
