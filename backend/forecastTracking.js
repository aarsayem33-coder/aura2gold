// Health of a forecast you asked to track.
//
// A forecast is a claim about the future, and the market keeps voting on it. This turns the
// stored drift history plus the live price into a plain answer: is it still worth waiting for,
// has it gone quiet, or has the market already answered it?
//
// The verdicts that matter most are the negative ones. A page that only says "still valid" is
// a page that lets you sit in a dead idea:
//
//   REVERSED    price went through the level the wrong way — the premise is gone
//   DONT_CHASE  the move already happened without you; entering now buys the worst price
//   WEAKENING   the strategies backing it are losing conviction
//   STALE       the window passed and price never arrived
//
// Pure: price, drift and clock come in as arguments so every rule is testable.

const n = (v) => Number(v);
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(n(v)) ? null : n(v));
const r1 = (v) => Math.round(n(v) * 10) / 10;

export const TRACK_DEFAULTS = {
  weakenScore: 8,        // score points lost before it counts as weakening
  strengthenScore: 5,    // points gained before it counts as strengthening
  chaseAtr: 1.0,         // how far past the entry price may run before chasing is a bad idea
  breakAtr: 0.6,         // how far through the level counts as the premise being broken
};

export const TRACK_VERDICT = {
  STRENGTHENING: 'STRENGTHENING',
  HOLDING: 'HOLDING',
  WEAKENING: 'WEAKENING',
  DONT_CHASE: 'DONT_CHASE',
  REVERSED: 'REVERSED',
  STALE: 'STALE',
  CLOSED: 'CLOSED',
};

/**
 * Assess one tracked forecast.
 *
 * Order matters: a broken premise beats a rising score. A forecast whose level has been blown
 * through is dead however good its strategies looked ten minutes ago, and reporting
 * "STRENGTHENING" in that state would be actively misleading.
 */
export function assessTracked({
  forecast, price, now = Date.now(), options = {},
}) {
  const o = { ...TRACK_DEFAULTS, ...options };
  const f = forecast || {};
  const drift = Array.isArray(f.drift) ? f.drift : [];
  const first = drift[0] || null;
  const last = drift[drift.length - 1] || null;

  const scoreChange = first && last ? r1(n(last.bestScore) - n(first.bestScore)) : 0;
  const rankChange = first && last ? r1(n(last.rankScore) - n(first.rankScore)) : 0;
  const agreeChange = first && last ? Math.round(n(last.agree) - n(first.agree)) : 0;

  const level = num(f.level);
  const atr = num(f.atr);
  const p = num(price);
  const below = f.side === 'below';
  const buy = String(f.expectedDirection || '').toUpperCase() === 'BUY';
  const entry = num(f.plan?.entry);

  const madeMs = Date.parse(f.createdAt || '');
  const etaMax = num(f.eta?.maxMinutes);
  const elapsedMin = Number.isFinite(madeMs) ? Math.round((now - madeMs) / 60000) : null;
  const timeLeftMinutes = etaMax !== null && elapsedMin !== null ? Math.round(etaMax - elapsedMin) : null;

  const distanceNow = p !== null && level !== null ? Math.abs(p - level) : null;
  const distanceAtr = distanceNow !== null && atr ? r1(distanceNow / atr) : null;
  const reasons = [];

  // Already finished — nothing left to judge.
  if (f.status && f.status !== 'WAITING') {
    return {
      verdict: TRACK_VERDICT.CLOSED, scoreChange, rankChange, agreeChange,
      timeLeftMinutes, distanceNow: distanceNow === null ? null : r1(distanceNow), distanceAtr,
      reasons: [`forecast is ${String(f.status).toLowerCase()}`], alertWorthy: false,
    };
  }

  // 1. Premise broken — price went THROUGH the level the wrong way.
  if (p !== null && level !== null && atr) {
    const throughBy = below ? (level - p) / atr : (p - level) / atr;
    if (throughBy >= o.breakAtr) {
      reasons.push(`price is ${r1(throughBy)} ATR through the level on the wrong side — the setup no longer exists`);
      return {
        verdict: TRACK_VERDICT.REVERSED, scoreChange, rankChange, agreeChange, timeLeftMinutes,
        distanceNow: r1(distanceNow), distanceAtr, reasons,
        alertWorthy: true,
        suggestion: `Do not take this. ${buy ? 'Support' : 'Resistance'} at ${level} gave way; if anything the bias is now the other way.`,
      };
    }
  }

  // 2. The move already happened — entering now is chasing.
  if (p !== null && atr && entry !== null) {
    const ranBy = (buy ? p - entry : entry - p) / atr;
    if (ranBy >= o.chaseAtr) {
      reasons.push(`price has already run ${r1(ranBy)} ATR past the planned entry`);
      return {
        verdict: TRACK_VERDICT.DONT_CHASE, scoreChange, rankChange, agreeChange, timeLeftMinutes,
        distanceNow: r1(distanceNow), distanceAtr, reasons,
        alertWorthy: true,
        suggestion: `The move went without you. Entering here pays ${r1(ranBy)} ATR worse than planned for the same stop — wait for a pullback or skip it.`,
      };
    }
  }

  // 3. Window elapsed without arrival.
  if (timeLeftMinutes !== null && timeLeftMinutes < 0) {
    reasons.push(`${Math.abs(timeLeftMinutes)} min past the outer estimate and price has not arrived`);
    return {
      verdict: TRACK_VERDICT.STALE, scoreChange, rankChange, agreeChange, timeLeftMinutes,
      distanceNow: distanceNow === null ? null : r1(distanceNow), distanceAtr, reasons,
      alertWorthy: false,
      suggestion: 'The timing estimate has passed. The level is still there, but the reasoning that put a clock on it has expired.',
    };
  }

  // 4. Conviction drifting.
  if (scoreChange <= -o.weakenScore || agreeChange < 0) {
    if (scoreChange <= -o.weakenScore) reasons.push(`score has fallen ${Math.abs(scoreChange)} points since it was first seen`);
    if (agreeChange < 0) reasons.push(`${Math.abs(agreeChange)} strateg${Math.abs(agreeChange) === 1 ? 'y has' : 'ies have'} stopped backing it`);
    return {
      verdict: TRACK_VERDICT.WEAKENING, scoreChange, rankChange, agreeChange, timeLeftMinutes,
      distanceNow: distanceNow === null ? null : r1(distanceNow), distanceAtr, reasons,
      alertWorthy: true,
      suggestion: 'Conviction is draining out of this one. Treat it as a lower-quality setup than when you tracked it.',
    };
  }

  if (scoreChange >= o.strengthenScore || agreeChange > 0) {
    if (scoreChange >= o.strengthenScore) reasons.push(`score has gained ${scoreChange} points`);
    if (agreeChange > 0) reasons.push(`${agreeChange} more strateg${agreeChange === 1 ? 'y' : 'ies'} now back it`);
    return {
      verdict: TRACK_VERDICT.STRENGTHENING, scoreChange, rankChange, agreeChange, timeLeftMinutes,
      distanceNow: distanceNow === null ? null : r1(distanceNow), distanceAtr, reasons,
      alertWorthy: false,
      suggestion: distanceAtr !== null && distanceAtr < 0.5
        ? 'Building conviction and price is close. This is the one to have an order ready for.'
        : 'Building conviction. Still waiting on price to arrive.',
    };
  }

  reasons.push('no material change since it was tracked');
  return {
    verdict: TRACK_VERDICT.HOLDING, scoreChange, rankChange, agreeChange, timeLeftMinutes,
    distanceNow: distanceNow === null ? null : r1(distanceNow), distanceAtr, reasons,
    alertWorthy: false,
    suggestion: distanceAtr !== null && distanceAtr < 0.5
      ? 'Holding up, and price is close to the level.'
      : 'Holding up. Nothing to do until price gets there.',
  };
}

/**
 * Should the ONE alert fire now?
 *
 * Exactly one alert per tracked forecast, ever. A tracked setup that wobbles for an hour would
 * otherwise send a dozen mails and train you to ignore all of them — so the first genuinely
 * adverse verdict is the only one that gets through, and `alertedAt` records that it went.
 */
export function shouldAlert(assessment, { alertedAt = null } = {}) {
  if (alertedAt) return false;                    // already used its single alert
  return Boolean(assessment?.alertWorthy);
}
