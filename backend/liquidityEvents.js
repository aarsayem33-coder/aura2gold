/**
 * Liquidity event tracking — what happened AFTER a key level was alerted.
 *
 * The proximity alert fires when price arrives at an obvious level. That is the interesting
 * moment, but it is not the answer: the level either gets taken and price comes back
 * (RECLAIMED — fade it), or a body closes through and holds (BROKE_AND_HELD — follow it).
 * Until now nothing recorded either, because `buildLiquidityChart` recomputes from candles on
 * every request and keeps no memory. An alert fired at 13:15 left no trace of what it became.
 *
 * WHY THE CLASSIFIER IS BORROWED, NOT REWRITTEN
 * `classifyLevel` in liquidityChart.js already distinguishes SWEPT from BROKEN_ACCEPTED, and
 * the chart renders from it. Writing a second classifier here would give the table and the
 * chart different answers about the same level, and there would be no way to tell which was
 * right. This module adds memory and a confirmation rule on top of that one source of truth.
 *
 * PROVISIONAL VERSUS CONFIRMED
 * A level marked SWEPT can later break through and become BROKEN_ACCEPTED, so a status alone is
 * never final. Every event therefore carries BOTH: a provisional status available immediately,
 * and a `confirmed` flag that only turns true once the evidence the playbook actually trades has
 * appeared — displacement away from a reclaim, or a held retest after a break. Reporting only
 * the confirmed ones would leave the table empty most of the time; reporting only the
 * provisional ones would dress up a coin flip as a result.
 *
 * Pure: candles and an event in, verdict out. No I/O, no clock, no database.
 */

import { classifyLevel } from './liquidityChart.js';
import { detectDisplacement } from './liquidityEngine.js';

const n = (v) => Number(v);
// Number(null) is 0 and 0 is finite — the coercion behind seven separate defects in this
// codebase. Every optional number goes through this rather than a bare isFinite.
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(n(v)) ? null : n(v));
const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

/**
 * Accept either shape for a level: the database row (`level_price`) or the chart's own object
 * (`price`). Both are real callers — the resolver reads rows, the chart passes its levels — and
 * an exported helper that silently returns null for one of them is a trap.
 */
function levelOf(level) {
  return {
    price: num(level?.price ?? level?.level_price ?? level?.levelPrice),
    side: level?.side ?? level?.level_side ?? null,
    formedIdx: num(level?.formedIdx) ?? 0,
  };
}

export const EVENT_STATUS = {
  WAITING: 'WAITING',                     // alerted, price has not resolved it yet
  RECLAIMED: 'RECLAIMED',                 // taken then rejected back — fade
  BROKE_AND_HELD: 'BROKE_AND_HELD',       // body closed through and held — follow
  NO_FOLLOW_THROUGH: 'NO_FOLLOW_THROUGH', // touched but never traded beyond
  DEAD: 'DEAD',                           // broken and left far behind; liquidity consumed
};

/**
 * Which way the resolved event points.
 *
 * `side: 'above'` is buy-side liquidity — stops resting above the level. Taking it and failing
 * is the classic short trigger; breaking and holding through it is the continuation long. The
 * mapping is the whole actionable output, so it is a table rather than scattered conditionals.
 */
export function directionFor(side, status) {
  const above = String(side || '').toLowerCase() === 'above';
  if (status === EVENT_STATUS.RECLAIMED) return above ? 'SELL' : 'BUY';
  if (status === EVENT_STATUS.BROKE_AND_HELD) return above ? 'BUY' : 'SELL';
  return null;
}

/** Map the chart classifier's vocabulary onto this tracker's. One place, so they cannot drift. */
export function statusFromClassification(status) {
  switch (status) {
    case 'SWEPT': return EVENT_STATUS.RECLAIMED;
    case 'BROKEN_ACCEPTED': return EVENT_STATUS.BROKE_AND_HELD;
    case 'INVALIDATED': return EVENT_STATUS.DEAD;
    case 'FRESH': return EVENT_STATUS.WAITING;
    // TESTED and REJECTED both mean price came and went without taking the level.
    case 'TESTED':
    case 'REJECTED': return EVENT_STATUS.NO_FOLLOW_THROUGH;
    default: return EVENT_STATUS.WAITING;
  }
}

/**
 * The bar at which price first traded beyond the level — the moment liquidity was taken.
 *
 * Everything downstream is measured from here rather than from the alert, because the alert
 * fires on approach and the sweep can be several bars later. Measuring displacement from the
 * alert bar would credit moves that happened before the level was ever touched.
 */
export function sweepIndex(candles, level, fromIdx = 0) {
  const { price, side } = levelOf(level);
  if (price === null || !Array.isArray(candles)) return null;
  const above = String(side || '').toLowerCase() === 'above';
  for (let i = Math.max(0, fromIdx); i < candles.length; i++) {
    const hi = num(candles[i].high), lo = num(candles[i].low);
    if (hi === null || lo === null) continue;
    if (above ? hi > price : lo < price) return i;
  }
  return null;
}

/**
 * How far the move ran in the implied direction, and how far it went against — BOTH.
 *
 * Reporting only the favourable excursion flatters every event: a reclaim that ran 10 pips your
 * way and then 100 against shows "+10" and looks like it worked. The adverse figure is what
 * says whether the level actually held, so the two ship together and neither is optional.
 *
 * Measured from the level price, since that is the reference the alert was about.
 */
export function excursionPips(candles, level, status, fromIdx, pipSize) {
  const { price, side } = levelOf(level);
  const ps = num(pipSize);
  if (price === null || ps === null || ps <= 0 || !Array.isArray(candles)) return { favourable: null, adverse: null };
  const dir = directionFor(side, status);
  if (!dir) return { favourable: null, adverse: null };
  const after = candles.slice(Math.max(0, num(fromIdx) ?? 0));
  if (!after.length) return { favourable: null, adverse: null };

  const lows = after.map((c) => num(c.low)).filter((v) => v !== null);
  const highs = after.map((c) => num(c.high)).filter((v) => v !== null);
  if (!lows.length || !highs.length) return { favourable: null, adverse: null };

  const best = dir === 'SELL' ? Math.min(...lows) : Math.max(...highs);
  const worst = dir === 'SELL' ? Math.max(...highs) : Math.min(...lows);
  return {
    favourable: r1((dir === 'SELL' ? price - best : best - price) / ps),
    adverse: r1((dir === 'SELL' ? worst - price : price - worst) / ps),
  };
}

/** Favourable excursion only — kept for callers that want the single headline number. */
export function followThroughPips(candles, level, status, fromIdx, pipSize) {
  return excursionPips(candles, level, status, fromIdx, pipSize).favourable;
}

/**
 * Resolve one alerted level against the candles that followed.
 *
 * Returns a provisional status immediately and a `confirmed` flag that only turns true on the
 * evidence the playbook actually trades:
 *   RECLAIMED      — a displacement candle away from the level after the reclaim. Without it
 *                    the "rejection" is a limp wick, which is the setup that loses.
 *   BROKE_AND_HELD — price came back to the level after breaking and failed to close back
 *                    through, i.e. the retest held. A break with no retest is untested.
 */
export function resolveEvent(event, candles, {
  atr = 0, pipSize = null, minHoldBars = 2, displacementMinAtr = 0.8,
} = {}) {
  const level = levelOf(event);
  if (level.price === null || !Array.isArray(candles) || candles.length < 2) {
    return {
      status: EVENT_STATUS.WAITING, confirmed: false, direction: null,
      barsToResolve: null, followThroughPips: null, evidence: 'not enough candles yet',
    };
  }

  const cls = classifyLevel(candles, level, { atr });
  const status = statusFromClassification(cls.status);
  const direction = directionFor(level.side, status);
  const swept = sweepIndex(candles, level);
  const barsToResolve = swept === null ? null : candles.length - 1 - swept;

  let confirmed = false;
  let evidence = cls.evidence || '';

  if (status === EVENT_STATUS.RECLAIMED && swept !== null) {
    // Displacement AWAY from the level is what separates a real rejection from a limp wick.
    const dispDir = String(level.side).toLowerCase() === 'above' ? 'BEARISH' : 'BULLISH';
    const disp = detectDisplacement(candles, swept, dispDir, atr, { minAtr: displacementMinAtr });
    confirmed = Boolean(disp?.present);
    evidence = confirmed
      ? `${evidence}; displacement ${disp.atrMultiple ? `${r1(disp.atrMultiple)}x ATR ` : ''}away confirms the rejection`
      : `${evidence}; no displacement yet — the rejection is unconfirmed`;
  } else if (status === EVENT_STATUS.BROKE_AND_HELD && swept !== null) {
    // A break is only proven by a retest that holds: price returns to the level and fails to
    // close back through it.
    const above = String(level.side).toLowerCase() === 'above';
    const tol = (atr || 0) * 0.1;
    let retested = false, heldFor = 0;
    for (let i = swept + 1; i < candles.length; i++) {
      const hi = num(candles[i].high), lo = num(candles[i].low), close = num(candles[i].close);
      if (hi === null || lo === null || close === null) continue;
      const back = above ? lo <= level.price + tol : hi >= level.price - tol;
      if (back) retested = true;
      if (retested) {
        const stillBeyond = above ? close > level.price : close < level.price;
        if (stillBeyond) heldFor += 1; else { retested = false; heldFor = 0; }
      }
    }
    confirmed = retested && heldFor >= minHoldBars;
    evidence = confirmed
      ? `${evidence}; retest held for ${heldFor} bar${heldFor === 1 ? '' : 's'}`
      : `${evidence}; ${retested ? 'retest not held long enough' : 'no retest yet'} — unconfirmed`;
  }

  return {
    status,
    confirmed,
    direction,
    barsToResolve,
    ...(() => {
      const ex = excursionPips(candles, level, status, swept ?? 0, pipSize);
      return { followThroughPips: ex.favourable, adversePips: ex.adverse };
    })(),
    touches: cls.touches ?? 0,
    closesBeyond: cls.closesBeyond ?? 0,
    pierced: Boolean(cls.pierced),
    evidence,
  };
}

/**
 * Hit rates over resolved events.
 *
 * Confirmed and provisional are counted SEPARATELY rather than pooled. Pooling them would let
 * unconfirmed coin flips inflate a rate that is supposed to describe tradeable setups, which is
 * the same mistake as counting a signal that never filled.
 */
export function summariseEvents(events) {
  const list = Array.isArray(events) ? events : [];
  const resolved = list.filter((e) => e.status === EVENT_STATUS.RECLAIMED || e.status === EVENT_STATUS.BROKE_AND_HELD);
  const confirmed = resolved.filter((e) => e.confirmed);
  const count = (arr, s) => arr.filter((e) => e.status === s).length;
  const rate = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);
  const pipsOf = (arr) => {
    const v = arr.map((e) => num(e.followThroughPips)).filter((x) => x !== null);
    return v.length ? r1(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };

  return {
    alerts: list.length,
    waiting: count(list, EVENT_STATUS.WAITING),
    noFollowThrough: count(list, EVENT_STATUS.NO_FOLLOW_THROUGH),
    dead: count(list, EVENT_STATUS.DEAD),
    resolved: resolved.length,
    reclaimed: count(resolved, EVENT_STATUS.RECLAIMED),
    brokeAndHeld: count(resolved, EVENT_STATUS.BROKE_AND_HELD),
    reclaimRate: rate(count(resolved, EVENT_STATUS.RECLAIMED), resolved.length),
    avgFollowThroughPips: pipsOf(resolved),
    confirmed: {
      resolved: confirmed.length,
      reclaimed: count(confirmed, EVENT_STATUS.RECLAIMED),
      brokeAndHeld: count(confirmed, EVENT_STATUS.BROKE_AND_HELD),
      reclaimRate: rate(count(confirmed, EVENT_STATUS.RECLAIMED), confirmed.length),
      avgFollowThroughPips: pipsOf(confirmed),
      // The share of resolved events that ever produced tradeable evidence. A low number here
      // means the alerts are firing on levels that mostly do nothing either way.
      confirmationRate: rate(confirmed.length, resolved.length),
    },
  };
}
