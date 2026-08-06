// AI second opinion on a single setup forecast.
//
// The forecast itself is deterministic: real levels, real strategies, real replay. This adds a
// model's reading of the same situation — direction, conviction, and a full ticket — so the two
// can be compared. It is deliberately a SECOND opinion, never an override:
//
//   * The model never sees a blank page. It gets the level, the scenario, which strategies fired
//     and at what score, the live price/ATR/trend and upcoming news, and is asked to agree or
//     disagree with reasons.
//   * Whatever it returns is RECONCILED against arithmetic before display. A model that puts a
//     stop on the wrong side of entry, or claims an RR its own prices do not support, is
//     corrected and flagged rather than shown as-is.
//   * Nothing here can trade. The result is an analysis surface — it never reaches the
//     auto-trader, the approval queue or email.
//
// Everything in this module is pure so the reconciliation can be tested without an API key.

const n = (v) => Number(v);
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(n(v)) ? null : n(v));
const r5 = (v) => Math.round(n(v) * 1e5) / 1e5;
const r2 = (v) => Math.round(n(v) * 100) / 100;

/** Clamp a model's self-reported confidence into a sane band. */
export function capScore(v) {
  const x = num(v);
  if (x === null) return null;
  return Math.max(0, Math.min(100, Math.round(x)));
}

/**
 * The prompt. States the situation, hands over the deterministic evidence, and demands a
 * strict JSON shape.
 *
 * The model is told explicitly that the scenario is hypothetical and that it may disagree —
 * without that, a model handed a confident-looking forecast tends to rubber-stamp it, which
 * makes the whole feature worthless.
 */
export function buildForecastAiPrompt({ forecast, market = {}, news = [], marketRead = '', structureRead = '', disciplineRead = '', hasImage = false }) {
  const f = forecast || {};
  const fires = (f.fires || []).slice(0, 8).map((x) =>
    `${x.strategyId}: ${x.decision} score ${x.score ?? '?'}${x.grade ? ` grade ${x.grade}` : ''}${x.agrees ? '' : ' (DISAGREES with the scenario)'}`);
  const plan = f.plan || null;

  return `You are a professional price-action analyst reviewing a CONDITIONAL forecast.

THE CLAIM BEING TESTED
Instrument: ${f.symbol} on ${f.timeframe}
Level: ${f.level} (${f.levelLabel || f.levelType || 'key level'}, strength ${f.levelStrength ?? '?'})
Scenario: ${f.scenario} — IF price reaches that level and behaves this way
Scenario implies: ${f.expectedDirection}
Distance from current price: ${f.distance?.pips ?? '?'} pips (${f.distance?.atr ?? '?'} ATR)
Estimated time to reach: ${f.eta?.minMinutes ?? '?'}-${f.eta?.maxMinutes ?? '?'} minutes

THIS HAS NOT HAPPENED YET. Price is not at the level. You are judging whether the setup is
worth taking IF it arrives, not whether to trade right now.

WHAT THE SYSTEM'S STRATEGIES SAY (each evaluated by its own rules against the scenario)
${fires.length ? fires.join('\n') : 'no strategy fired'}
${plan ? `System ticket: ${plan.direction} entry ${plan.entry} SL ${plan.stopLoss} TP1 ${plan.takeProfit ?? '?'} RR ${plan.rr ?? '?'} (${plan.stopPips} pip stop)` : 'System produced no sized ticket.'}

LIVE MARKET
Price: ${market.price ?? '?'} | ATR(14): ${market.atr ?? '?'}
H1 trend: ${market.h1Trend || '?'} | H4 trend: ${market.h4Trend || '?'}
Session: ${market.session || '?'}
Key levels near this one: ${(market.nearbyLevels || []).slice(0, 8).map((l) => `${l.type || l.label} ${l.price}${l.swept ? ' (SWEPT)' : l.status ? ` (${l.status})` : ''}`).join(', ') || 'none'}

WHAT THE ENGINES MEASURED
These are computed by the same detectors the trading strategies use — treat them as facts, not
suggestions. Read the raw candles yourself for anything they do not cover, but do NOT contradict
a measured value with an impression.
${marketRead || 'no structural read available'}
${structureRead ? `\n${structureRead}\n` : ''}
${news.length ? `Upcoming news (next 12h): ${news.map((e) => `${e.currency} ${e.impact} "${e.title}" in ${e.in_minutes}m`).join('; ')}` : 'No high-impact news scheduled in the next 12h.'}

${hasImage ? `A CHART IMAGE IS ATTACHED
It is rendered from exactly the candles listed above — same data, drawn. Use it to read shape:
candle formations, wick length, momentum, where the level sits relative to structure. If what
you see in the image disagrees with a measured value above, trust the measurement and say so.

` : ''}${disciplineRead ? `${disciplineRead}\n\n` : ''}YOUR JOB
Judge this setup independently. You are EXPECTED to disagree when the evidence warrants it —
a review that always agrees is useless. If the level is weak, the scenario is unlikely, the
trend opposes it, or news makes it untradeable, say so and set a low score.

Give your OWN trade plan. Entry should be where you would actually get in relative to the
level. Stop must be on the losing side of entry, targets on the winning side, and the stop
must sit beyond the structure that would invalidate the idea — not at an arbitrary distance.

Use the liquidity map. Say whether you agree with the stated DRAW ON LIQUIDITY, and name the
level you think price reaches first. A target sitting beyond an untouched opposing pool is a
target that pool will most likely cap — if your take-profit is on the far side of fresh
liquidity, justify why price gets through it.

Reply with ONLY this JSON:
{
  "direction": "BUY" | "SELL" | "NO_TRADE",
  "agrees_with_system": true | false,
  "score": 0-100,
  "confidence": "LOW" | "MEDIUM" | "HIGH",
  "entry": number or null,
  "stop_loss": number or null,
  "take_profit_1": number or null,
  "take_profit_2": number or null,
  "expected_reaction": "short description of what you expect price to do at the level",
  "invalidation": "what would prove this idea wrong",
  "key_risks": ["risk 1", "risk 2"],
  "rationale": "2-4 sentences. Be specific about THIS level and THIS structure.",
  "discipline_note": "one sentence to the HUMAN about today's risk state, or null. It must NOT influence direction, score or verdict — it is the only place risk-budget talk belongs.",
  "verdict": "TAKE" | "WATCH" | "SKIP"
}`;
}

/**
 * Normalise a model response into a predictable shape. Unknown or malformed fields become null
 * rather than plausible-looking defaults — a fabricated stop is worse than a missing one.
 */
export function normaliseForecastAi(parsed) {
  const p = parsed || {};
  const dir = String(p.direction || '').toUpperCase();
  const verdict = String(p.verdict || '').toUpperCase();
  const conf = String(p.confidence || '').toUpperCase();
  return {
    direction: ['BUY', 'SELL', 'NO_TRADE'].includes(dir) ? dir : 'NO_TRADE',
    agreesWithSystem: p.agrees_with_system === true,
    // Whether the model actually answered the agreement question. Without this, an omitted
    // field defaults to false, reconciliation derives the true value from the direction, and
    // the mismatch is reported as "the model contradicted itself" — a warning about nothing.
    agreementStated: p.agrees_with_system === true || p.agrees_with_system === false,
    score: capScore(p.score),
    confidence: ['LOW', 'MEDIUM', 'HIGH'].includes(conf) ? conf : 'LOW',
    entry: num(p.entry),
    stopLoss: num(p.stop_loss),
    takeProfit1: num(p.take_profit_1),
    takeProfit2: num(p.take_profit_2),
    expectedReaction: String(p.expected_reaction || '').slice(0, 400),
    invalidation: String(p.invalidation || '').slice(0, 400),
    keyRisks: Array.isArray(p.key_risks) ? p.key_risks.map((r) => String(r).slice(0, 200)).slice(0, 5) : [],
    rationale: String(p.rationale || '').slice(0, 1200),
    // Advisory only, and kept out of every scored field on purpose — reconcileForecastAi never
    // reads it, so nothing here can move the ticket or the score.
    disciplineNote: p.discipline_note ? String(p.discipline_note).slice(0, 300) : null,
    verdict: ['TAKE', 'WATCH', 'SKIP'].includes(verdict) ? verdict : 'WATCH',
  };
}

/**
 * Check the model's own numbers and correct what arithmetic can settle.
 *
 * A language model will occasionally return a stop on the profitable side of entry, or assert
 * an RR its prices do not support. Displaying that next to the deterministic engine would imply
 * the two are equally trustworthy. Every problem found is reported in `issues` and the ticket is
 * marked unusable rather than quietly repaired into something the model never said.
 */
export function reconcileForecastAi(ai, { forecast, pip, minStopDistance = null } = {}) {
  const issues = [];
  const out = { ...ai, rr: null, stopPips: null, ticketUsable: false };
  const f = forecast || {};
  const buy = out.direction === 'BUY';

  if (out.direction === 'NO_TRADE') {
    return { ...out, issues, agreesWithSystem: false };
  }

  // Does the model's direction actually match what it claims about the system?
  const systemDir = String(f.plan?.direction || f.expectedDirection || '').toUpperCase();
  const reallyAgrees = systemDir ? out.direction === systemDir : false;
  if (out.agreementStated && out.agreesWithSystem !== reallyAgrees) {
    issues.push(`model said it ${out.agreesWithSystem ? 'agrees' : 'disagrees'} with the system but its direction is ${out.direction} against the system's ${systemDir || 'none'}`);
  }
  out.agreesWithSystem = reallyAgrees;

  const entry = out.entry;
  const sl = out.stopLoss;
  const tp1 = out.takeProfit1;

  if (entry === null || sl === null) {
    issues.push('no usable entry/stop returned');
    return { ...out, issues };
  }
  if (entry === sl) {
    issues.push('entry and stop are the same price');
    return { ...out, issues };
  }
  // The stop must be on the LOSING side. This is the single most common model error and it
  // silently inverts the whole risk calculation if it goes unchecked.
  if (buy ? sl >= entry : sl <= entry) {
    issues.push(`stop ${sl} is on the wrong side of entry ${entry} for a ${out.direction}`);
    return { ...out, issues };
  }
  if (tp1 !== null && (buy ? tp1 <= entry : tp1 >= entry)) {
    issues.push(`take-profit ${tp1} is on the wrong side of entry for a ${out.direction}`);
    out.takeProfit1 = null;
  }
  if (out.takeProfit2 !== null && (buy ? out.takeProfit2 <= entry : out.takeProfit2 >= entry)) {
    out.takeProfit2 = null;
  }

  const risk = Math.abs(entry - sl);
  const pv = num(pip);
  out.stopPips = pv && pv > 0 ? Math.round((risk / pv) * 10) / 10 : null;
  // RR is computed here, never taken from the model — a stated RR is an assertion, this is
  // arithmetic on the prices it actually gave.
  const target = out.takeProfit2 ?? out.takeProfit1;
  out.rr = target !== null ? r2(Math.abs(target - entry) / risk) : null;

  if (minStopDistance !== null && risk < minStopDistance) {
    issues.push(`stop is ${out.stopPips} pips — inside the broker's minimum distance, the order would be rejected`);
  }
  // An entry nowhere near the level is not a plan for THIS forecast.
  const level = num(f.level);
  const atr = num(f.atr) ?? num(f.distance?.atrValue);
  if (level !== null && atr && Math.abs(entry - level) > atr * 2) {
    issues.push(`entry ${entry} is more than 2 ATR from the forecast level ${level} — this is a different setup`);
  }

  out.entry = r5(entry);
  out.stopLoss = r5(sl);
  if (out.takeProfit1 !== null) out.takeProfit1 = r5(out.takeProfit1);
  if (out.takeProfit2 !== null) out.takeProfit2 = r5(out.takeProfit2);
  out.ticketUsable = issues.length === 0 && out.takeProfit1 !== null;
  return { ...out, issues };
}

/**
 * What to show when the model is unavailable or unusable.
 *
 * Reports the deterministic evidence that already exists rather than inventing an opinion, and
 * says plainly that no AI ran — a fabricated "analysis" from a failed call is the worst
 * possible outcome for a page people trade from.
 */
export function deterministicForecastView(forecast, reason) {
  const f = forecast || {};
  const backing = (f.fires || []).filter((x) => x.agrees);
  const against = (f.fires || []).filter((x) => !x.agrees);
  return {
    available: false,
    reason,
    direction: f.expectedDirection || null,
    score: f.bestScore ?? null,
    summary: backing.length
      ? `No AI review. The deterministic engine has ${backing.length} strateg${backing.length === 1 ? 'y' : 'ies'} backing ${f.expectedDirection} at this level`
        + (against.length ? `, and ${against.length} arguing the other way.` : '.')
      : 'No AI review, and no strategy currently backs this scenario.',
  };
}
