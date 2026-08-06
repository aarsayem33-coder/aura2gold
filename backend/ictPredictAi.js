// AI second opinion on ONE ICT prediction.
//
// Deliberately not the generic forecast reviewer. That one asks "would you take this level?";
// this one asks an ICT question, in ICT terms, about a sequence that has not happened yet:
//
//     will price actually reach this pool, take it, and FAIL — or accept through and keep going?
//
// That distinction is the entire trade. A breaker prediction is wrong in exactly one interesting
// way: the sweep succeeds instead of failing, and the level becomes support/resistance flipped
// against you. So the model is asked for that specifically, and its answer is reconciled against
// arithmetic before display.
//
// Constraints, same as every other AI surface here:
//   * the model never sees a blank page — it gets the real structure, the measured gates, and
//     what the deterministic engines already concluded
//   * whatever it returns is checked: a stop on the wrong side of entry, an entry nowhere near
//     the level, or an RR its own prices do not support is flagged and the ticket marked unusable
//   * nothing here can trade, email, or reach the approval queue
//
// Pure, so the reconciliation is testable without an API key.

const n = (v) => Number(v);
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(n(v)) ? null : n(v));
const r5 = (v) => Math.round(n(v) * 1e5) / 1e5;
const r2 = (v) => Math.round(n(v) * 100) / 100;

const SETUP_WORDS = {
  BULLISH_BREAKER: 'sell-side liquidity is taken below the swing low, then price closes back above the prior swing high (a bullish breaker)',
  BEARISH_BREAKER: 'buy-side liquidity is taken above the swing high, then price closes back below the prior swing low (a bearish breaker)',
};

/**
 * The prompt.
 *
 * It states the ICT model explicitly rather than assuming the model shares this desk's
 * vocabulary, hands over every measured value, and says plainly which parts of the projection
 * are assumptions. A reviewer that is not told the displacement was ASSUMED will treat a 95 as
 * evidence and rubber-stamp it, which makes the whole panel worthless.
 */
export function buildIctAiPrompt({ prediction, market = {}, news = [], marketRead = '', hasImage = false }) {
  const p = prediction || {};
  const m = p.measurements || {};
  const gates = (m.gates || []).map((g) => `  ${g.label}: ${g.value ?? 'unknown'} — ${g.pass === null ? 'not measured' : g.pass ? 'PASS' : 'FAIL'} (${g.detail})`);
  const bonuses = (m.bonuses || []).map((b) => `  ${b.label}: ${b.value ?? 'unknown'}${b.pass ? ' (bonus earned)' : ''}`);
  const fires = (p.fires || []).map((f) => `  ${f.strategyId}: ${f.decision} score ${f.score ?? '?'}${f.grade ? ` grade ${f.grade}` : ''} — ${f.reason || ''}`);
  const refused = (p.refused || []).map((r) => `  ${r.strategyId}: did not fire — ${r.reason}`);
  const lo = p.limitOrder || null;
  const sp = p.strategyPlan || null;

  return `You are an ICT / smart-money price-action analyst reviewing a CONDITIONAL prediction.

THE ICT MODEL BEING PREDICTED
${SETUP_WORDS[p.setup] || 'a liquidity sweep followed by a close back through the opposing structure'}.
The breaker is then entered with the stop beyond the sweep, targeting the opposing resting
liquidity (the draw). This is the ict-breaker model, and its selective overlay ict-break-pro.

THE SPECIFIC CLAIM
Instrument: ${p.symbol} on ${p.timeframe}
Liquidity pool to be swept: ${p.level}${p.levelLabel ? ` (${p.levelLabel})` : ''} — an unswept swing ${p.direction === 'BUY' ? 'low' : 'high'}
Structure the reclaim must close through: ${p.structureLevel}
Implied direction after the sweep fails: ${p.direction}
Distance from current price to the pool: ${p.distance?.pips ?? '?'} pips (${p.distance?.atr ?? '?'} ATR)
Estimated time for the whole sequence: ${p.eta?.minMinutes ?? '?'}-${p.eta?.maxMinutes ?? '?'} minutes
Projected as ${p.projection?.bars ?? '?'} bars: one sweep bar, ${p.projection?.walks ?? 0} continuation bar(s), one displacement bar, one reclaim bar.

NONE OF THIS HAS HAPPENED. Price has not reached the pool. You are judging whether the sequence
is likely AND worth trading if it arrives — not whether to trade right now.

WHAT THE DETERMINISTIC ENGINES SAY (each by its own rules, run against the projected bars)
${fires.length ? fires.join('\n') : '  no ICT strategy fired'}
${refused.length ? refused.join('\n') : ''}

THE PRO OVERLAY'S MEASURED GATES
${gates.length ? gates.join('\n') : '  not available'}
${bonuses.length ? `Bonuses (score only, never gates):\n${bonuses.join('\n')}` : ''}
${p.proQualified ? 'This setup CLEARS the PRO overlay — historically about one signal in three does.' : 'This setup does NOT clear the PRO overlay.'}

HONESTY ABOUT THE SCORE
The headline score is ${p.bestScore ?? '?'} (${p.grade || '?'}), but two of its components are
ASSUMED by the projection rather than measured:
${(p.scoreBasis?.assumed || []).map((x) => `  - ${x}`).join('\n') || '  - none stated'}
Measured components:
${(p.scoreBasis?.measured || []).map((x) => `  - ${x}`).join('\n') || '  - none stated'}
Treat the score as a conditional upper bound, not a probability.

THE TWO TICKETS ON THE TABLE
${lo ? `Resting order: ${lo.type} at ${lo.entry} (the real level), stop ${lo.stopLoss} (${lo.stopPips ?? '?'} pips, beyond the projected sweep), targets ${lo.takeProfit1 ?? '-'} / ${lo.takeProfit2 ?? '-'} / ${lo.takeProfit3 ?? '-'}, RR ${lo.rr ?? '?'}` : 'No resting order could be sized.'}
${sp ? `Strategy's own entry (market, once the reclaim closes): ${sp.direction} at ${sp.entry}, stop ${sp.stopLoss}, TP ${sp.takeProfit1 ?? '-'} / ${sp.takeProfit2 ?? '-'} / ${sp.takeProfit3 ?? '-'}, RR ${sp.rr ?? '?'}` : ''}

LIVE MARKET
Price: ${market.price ?? '?'} | ATR(14): ${market.atr ?? '?'}
H1 trend: ${market.h1Trend || '?'} | H4 trend: ${market.h4Trend || '?'} | Session: ${market.session || '?'}
Nearby levels: ${(market.nearbyLevels || []).slice(0, 10).map((l) => `${l.type || l.label} ${l.price}${l.swept ? ' (SWEPT)' : ''}`).join(', ') || 'none'}

WHAT THE ENGINES MEASURED
These come from the same detectors the strategies use — treat them as facts. Read the candles
yourself for anything they do not cover, but do not contradict a measured value with an
impression.
${marketRead || 'no structural read available'}
${news.length ? `Upcoming news (next 12h): ${news.map((e) => `${e.currency} ${e.impact} "${e.title}" in ${e.in_minutes}m`).join('; ')}` : 'No high-impact news scheduled in the next 12h.'}

${hasImage ? `A CHART IMAGE IS ATTACHED
Rendered from exactly the candles described above — same data, drawn. Use it to read shape:
where the pool sits relative to structure, how price has behaved around it before, whether the
approach looks impulsive or exhausted. If the image disagrees with a measured value, trust the
measurement and say so.

` : ''}YOUR JOB
Answer the ICT question, not a generic one:

1. REACH — is price likely to trade to ${p.level} at all inside the estimated window?
2. SWEEP OR ACCEPT — this is the trade. If price gets there, does the liquidity grab FAIL
   (sweep and reject, the prediction) or does price ACCEPT through and continue? Say which and
   why, in structural terms.
3. DRAW — is the target actually the draw on liquidity, or is there closer opposing liquidity
   that would cap the move first?
4. CONTEXT — does the higher timeframe, the session, or upcoming news make this untradeable?

You are EXPECTED to disagree when the evidence warrants it. A review that always agrees is
worthless. If the pool is weak, the sweep is more likely to succeed than fail, or the structure
is too far away to reclaim, say so and score it low.

Give your OWN plan. Entry should be where you would actually get filled relative to the pool.
The stop must sit beyond the structure that would invalidate the idea — beyond the sweep, not at
an arbitrary distance — and on the losing side of entry. Targets on the winning side.

Reply with ONLY this JSON:
{
  "direction": "BUY" | "SELL" | "NO_TRADE",
  "agrees_with_system": true | false,
  "score": 0-100,
  "confidence": "LOW" | "MEDIUM" | "HIGH",
  "reach_likelihood": "LOW" | "MEDIUM" | "HIGH",
  "sweep_outcome": "REJECT" | "ACCEPT" | "UNCLEAR",
  "entry": number or null,
  "stop_loss": number or null,
  "take_profit_1": number or null,
  "take_profit_2": number or null,
  "order_type": "LIMIT" | "MARKET",
  "draw_on_liquidity": "where you think price is actually drawn to, and why",
  "invalidation": "what would prove this idea wrong",
  "key_risks": ["risk 1", "risk 2"],
  "rationale": "2-4 sentences. Be specific about THIS pool and THIS structure.",
  "verdict": "TAKE" | "WATCH" | "SKIP"
}`;
}

/**
 * Normalise a model response. Unknown or malformed fields become null rather than plausible
 * defaults — a fabricated stop is worse than a missing one.
 */
export function normaliseIctAi(parsed) {
  const p = parsed || {};
  const pick = (v, allowed, fallback) => {
    const s = String(v || '').toUpperCase();
    return allowed.includes(s) ? s : fallback;
  };
  return {
    direction: pick(p.direction, ['BUY', 'SELL', 'NO_TRADE'], 'NO_TRADE'),
    agreesWithSystem: p.agrees_with_system === true,
    // Whether the model actually ANSWERED the agreement question. Without this an omitted field
    // defaults to false, reconciliation derives the true value, and the mismatch gets reported
    // as "the model contradicted itself" — a warning about nothing.
    agreementStated: p.agrees_with_system === true || p.agrees_with_system === false,
    score: (() => { const x = num(p.score); return x === null ? null : Math.max(0, Math.min(100, Math.round(x))); })(),
    confidence: pick(p.confidence, ['LOW', 'MEDIUM', 'HIGH'], 'LOW'),
    reachLikelihood: pick(p.reach_likelihood, ['LOW', 'MEDIUM', 'HIGH'], 'MEDIUM'),
    sweepOutcome: pick(p.sweep_outcome, ['REJECT', 'ACCEPT', 'UNCLEAR'], 'UNCLEAR'),
    orderType: pick(p.order_type, ['LIMIT', 'MARKET'], 'LIMIT'),
    entry: num(p.entry),
    stopLoss: num(p.stop_loss),
    takeProfit1: num(p.take_profit_1),
    takeProfit2: num(p.take_profit_2),
    drawOnLiquidity: String(p.draw_on_liquidity || '').slice(0, 400),
    invalidation: String(p.invalidation || '').slice(0, 400),
    keyRisks: Array.isArray(p.key_risks) ? p.key_risks.map((r) => String(r).slice(0, 200)).slice(0, 5) : [],
    rationale: String(p.rationale || '').slice(0, 1200),
    verdict: pick(p.verdict, ['TAKE', 'WATCH', 'SKIP'], 'WATCH'),
  };
}

/**
 * Check the model's numbers and correct only what arithmetic can settle.
 *
 * Problems are reported in `issues` and the ticket marked unusable — never quietly repaired into
 * something the model did not say. The ICT-specific check is the last one: a stop that sits on
 * the wrong side of the POOL is not an ICT stop at all, however valid it looks against the entry.
 */
export function reconcileIctAi(ai, { prediction, pip, minStopDistance = null } = {}) {
  const issues = [];
  const out = { ...ai, rr: null, stopPips: null, ticketUsable: false };
  const p = prediction || {};
  const buy = out.direction === 'BUY';

  // A model that says ACCEPT has predicted the sweep succeeds — that is a rejection of the
  // premise, and it must not read as agreement however its direction field came out.
  if (out.sweepOutcome === 'ACCEPT' && out.direction === p.direction) {
    issues.push(`the model expects the sweep to be ACCEPTED, which is the opposite of the ${p.direction} breaker premise, yet returned ${out.direction}`);
  }

  if (out.direction === 'NO_TRADE') return { ...out, issues, agreesWithSystem: false };

  const systemDir = String(p.direction || '').toUpperCase();
  const reallyAgrees = systemDir ? out.direction === systemDir : false;
  if (out.agreementStated && out.agreesWithSystem !== reallyAgrees) {
    issues.push(`model said it ${out.agreesWithSystem ? 'agrees' : 'disagrees'} but its direction is ${out.direction} against the system's ${systemDir || 'none'}`);
  }
  out.agreesWithSystem = reallyAgrees;

  const entry = out.entry, sl = out.stopLoss, tp1 = out.takeProfit1;
  if (entry === null || sl === null) { issues.push('no usable entry/stop returned'); return { ...out, issues }; }
  if (entry === sl) { issues.push('entry and stop are the same price'); return { ...out, issues }; }
  // The single most common model error, and it silently inverts the whole risk calculation.
  if (buy ? sl >= entry : sl <= entry) {
    issues.push(`stop ${sl} is on the wrong side of entry ${entry} for a ${out.direction}`);
    return { ...out, issues };
  }
  if (tp1 !== null && (buy ? tp1 <= entry : tp1 >= entry)) {
    issues.push(`take-profit ${tp1} is on the wrong side of entry for a ${out.direction}`);
    out.takeProfit1 = null;
  }
  if (out.takeProfit2 !== null && (buy ? out.takeProfit2 <= entry : out.takeProfit2 >= entry)) out.takeProfit2 = null;

  const risk = Math.abs(entry - sl);
  const pv = num(pip);
  out.stopPips = pv !== null && pv > 0 ? Math.round((risk / pv) * 10) / 10 : null;
  // RR is arithmetic on the prices the model gave, never the RR it asserted.
  const target = out.takeProfit2 ?? out.takeProfit1;
  out.rr = target === null ? null : r2(Math.abs(target - entry) / risk);

  if (minStopDistance !== null && risk < minStopDistance) {
    issues.push(`stop is ${out.stopPips} pips — inside the broker's minimum distance, the order would be rejected`);
  }

  const level = num(p.level);
  const atr = num(p.atr);
  if (level !== null && atr !== null && atr > 0) {
    if (Math.abs(entry - level) > atr * 2) {
      issues.push(`entry ${entry} is more than 2 ATR from the pool at ${level} — that is a different setup`);
    }
    // The ICT check: the stop protects the sweep. A stop that does not clear the pool is inside
    // the very liquidity grab the trade is built on, so it gets taken by the setup working.
    if (buy ? sl > level : sl < level) {
      issues.push(`stop ${sl} sits inside the pool at ${level} — the sweep itself would take it out`);
    }
  }

  out.entry = r5(entry);
  out.stopLoss = r5(sl);
  if (out.takeProfit1 !== null) out.takeProfit1 = r5(out.takeProfit1);
  if (out.takeProfit2 !== null) out.takeProfit2 = r5(out.takeProfit2);
  out.ticketUsable = issues.length === 0 && out.takeProfit1 !== null;
  return { ...out, issues };
}

/**
 * What to show when the model is unavailable.
 *
 * Reports the deterministic evidence that already exists rather than inventing an opinion, and
 * says plainly that no AI ran. A fabricated "analysis" from a failed call is the worst possible
 * outcome for a page people place orders from.
 */
export function deterministicIctView(prediction, reason) {
  const p = prediction || {};
  const failed = (p.measurements?.gates || []).filter((g) => g.pass === false).map((g) => g.label);
  return {
    available: false,
    reason,
    direction: p.direction || null,
    score: p.bestScore ?? null,
    summary: `No AI review. The deterministic engines have ${(p.fires || []).length} ICT strateg${(p.fires || []).length === 1 ? 'y' : 'ies'} backing ${p.direction} at ${p.level}`
      + (p.proQualified ? ', and the setup clears the PRO overlay.' : failed.length ? `, but ${failed.join(' and ')} fails the PRO overlay.` : ', without clearing the PRO overlay.'),
  };
}
