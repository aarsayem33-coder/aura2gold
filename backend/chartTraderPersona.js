/**
 * Trader persona + instrument specialisation for the chart AI.
 *
 * The existing chart-vision prompt is generic: it reads a chart and reconciles with the engine.
 * This adds the two things a professional actually brings — a STYLE (a scalper and a day trader
 * look at the same chart and take different trades) and INSTRUMENT KNOWLEDGE (gold, Nasdaq and
 * S&P each move for their own reasons, on their own clocks, with their own trap patterns).
 *
 * All of it is prompt construction plus a bias declaration. Nothing here generates a signal,
 * gates a trade, or touches any strategy — the strategy match is reported as INFORMATION so the
 * user can see whether the AI's independent read happens to line up with the deterministic
 * engines, never as an instruction.
 *
 * Everything below is measured from this project's own data where a number is quoted, and the
 * quotes are labelled so nobody later mistakes a rule of thumb for a fitted parameter.
 */

const upper = (v) => String(v || '').toUpperCase();

export const TRADE_STYLES = ['SCALP', 'DAY'];
export const POSITION_BIASES = ['LONG', 'SHORT', 'BOTH'];

/**
 * Style briefs.
 *
 * The horizon numbers are deliberately style DEFINITIONS, not optimised parameters — a scalp
 * that is allowed to run for two days is not a scalp. They shape what the model proposes; they
 * do not filter anything.
 */
export const STYLE_BRIEF = {
  SCALP: {
    label: 'Scalper',
    horizon: 'minutes to ~2 hours',
    timeframes: 'M1–M15 for entry, M15/H1 for context',
    brief: [
      'You are scalping. Target the CLEANEST PART of a move, not the whole move.',
      'Entry precision matters more than target size: a late entry destroys the trade even when the direction is right.',
      'Target the NEAREST logical liquidity — the next swing high/low or the next zone edge. Do not reach for a distant target.',
      'Stop goes beyond the structure that would invalidate the idea (the swept extreme or the zone edge), never inside the noise.',
      'Prefer setups where you can define invalidation within roughly 1 ATR.',
      // A scalper's edge is frequency at a positive expectancy, not rarity. Held to a day
      // trader's patience they would take almost nothing, which is how this path ended up
      // calling HOLD on every single read.
      'A scalper trades MORE often than a day trader, not less. You are working the intraday swings, so a clean level with a defined invalidation is a trade even when the higher timeframe is undecided.',
      'You may take a counter-trend scalp INTO a fresh level — a sweep of an obvious high in an uptrend is a short back to the mean. What you may not do is fade a level that has already broken and been accepted through.',
      'Spread is a real cost at this size. If the stop is under ~4x the spread the setup is not tradeable however good it looks — say so explicitly rather than shrinking the stop to make it fit.',
      'If price is mid-range with no clean level within reach, the answer is NO TRADE. But "mid-range" means genuinely between levels, not merely "not yet perfect".',
    ],
  },
  DAY: {
    label: 'Day trader',
    horizon: 'hours to one session, flat by the close',
    timeframes: 'M15–H1 for entry, H4/D1 for bias',
    brief: [
      'You are day trading. Take the session\'s main move, not every wiggle.',
      'Bias comes from the higher timeframe (H4/D1) and the day\'s developing structure; entries come from M15/H1 pullbacks into that bias.',
      'Respect the day\'s range: if the average daily range is largely spent, a fresh continuation entry is late.',
      'Target prior-day levels, session highs/lows, or the opposing liquidity pool — targets that a full session can realistically reach.',
      'Do not fight a clearly trending higher timeframe. A counter-trend trade needs a completed reversal structure, not a hunch.',
      'Flat by the session close unless the structure explicitly justifies holding.',
    ],
  },
};

/**
 * Instrument playbooks.
 *
 * These describe HOW each market behaves — its drivers, its active window, its characteristic
 * trap. They are qualitative trading knowledge, not fitted parameters, except where a figure is
 * explicitly marked as measured from this project's own 10-year local history.
 */
export const INSTRUMENT_PLAYBOOK = {
  GOLD: {
    match: (s) => /^XAU|GOLD/.test(s),
    label: 'Gold (XAUUSD)',
    brief: [
      'Gold moves fast and reverses just as fast. A clean run can complete in minutes.',
      'It respects liquidity strongly: it sweeps highs and lows, traps the obvious side, then moves the other way. Treat a sweep-and-reclaim as a primary signal and a clean break as suspect until it holds.',
      'Drivers: real yields, DXY, risk sentiment, central-bank tone. USD data (CPI, NFP, FOMC) moves it violently — avoid fresh entries into those releases.',
      'MEASURED from this system\'s 10-year history: the London–NY window (≈13:00–17:00 broker time) carries roughly 3x the movement of the quiet 05:00–07:00 hours. Weekday makes almost no difference (Mon–Fri daily ranges within $18.6–$20.0), so do not weight by day of week.',
      'MEASURED: the daily range varies about 4x between quiet and volatile regimes (p10 $8.5 vs p90 $34.9). Size and target selection must respect which regime is active.',
      'Gold barely gaps: only 51 weekly opens in 10 years exceeded 0.25 ATR. Do not build a read around gap-fill logic.',
    ],
  },
  NASDAQ: {
    match: (s) => /USTEC|NAS|NDX|US100/.test(s),
    label: 'Nasdaq 100',
    brief: [
      'Index, not FX: it is priced in points and driven by earnings, rates expectations and mega-cap concentration. A handful of names can move the whole index.',
      'The US cash open (14:30 broker/UTC+2-ish, i.e. 09:30 New York) is the defining event. The first 30–60 minutes set the day\'s range and produce the day\'s worst false breaks.',
      'It trends harder and cleaner than gold once a move is established, but the opening drive frequently reverses. Prefer entries AFTER the opening range resolves rather than into it.',
      'Overnight/pre-market moves on futures often gap the cash session. Prior-day high/low and the overnight range are the levels that matter.',
      'Wider stops in point terms than FX. Never size it as if the point value matched a currency pair.',
    ],
  },
  SP500: {
    match: (s) => /SPX|US500|SP500|ES\b/.test(s),
    label: 'S&P 500',
    brief: [
      'Broader and less jumpy than Nasdaq — the same drivers but damped. Moves are smoother and mean-reversion inside the day\'s range is more reliable.',
      'The US cash open dominates. VWAP and prior-day levels are widely watched and tend to hold.',
      'Because it is calmer, targets should be more modest and stops tighter in relative terms than Nasdaq. Applying a Nasdaq-sized target to the S&P produces a trade that never fills.',
      'Highly sensitive to Fed policy and broad risk sentiment; it often leads the risk complex.',
    ],
  },
  FX: {
    match: () => true,                      // fallback
    label: 'FX pair',
    brief: [
      'Session-driven: the London open and the London–NY overlap carry the bulk of the movement.',
      'Respect the pair\'s own character — JPY crosses run further and hold trends longer than EUR crosses.',
      'Central-bank divergence sets the medium-term bias; intraday, structure and liquidity dominate.',
    ],
  },
};

/** The playbook for a symbol. Longest, most specific match wins; FX is the fallback. */
export function playbookFor(symbol) {
  const s = upper(symbol);
  for (const key of ['GOLD', 'NASDAQ', 'SP500']) {
    if (INSTRUMENT_PLAYBOOK[key].match(s)) return { key, ...INSTRUMENT_PLAYBOOK[key] };
  }
  return { key: 'FX', ...INSTRUMENT_PLAYBOOK.FX };
}

/** Normalise the requested style, defaulting to DAY rather than guessing. */
export function normaliseStyle(style) {
  const s = upper(style);
  return TRADE_STYLES.includes(s) ? s : 'DAY';
}

/**
 * Normalise the requested direction bias.
 *
 * IMPORTANT: a LONG/SHORT request is a request to EVALUATE that side, never a licence to
 * manufacture a setup for it. The prompt makes that explicit, because a model asked for "a long"
 * will otherwise find one whatever the chart says — which is exactly the failure mode that makes
 * an AI read worthless.
 */
export function normaliseBias(bias) {
  const b = upper(bias);
  return POSITION_BIASES.includes(b) ? b : 'BOTH';
}

/** The persona block prepended to the chart-vision prompt. */
export function buildPersonaPrompt({ symbol, timeframe, style, bias }) {
  const st = normaliseStyle(style);
  const bi = normaliseBias(bias);
  const pb = playbookFor(symbol);
  const brief = STYLE_BRIEF[st];

  const biasLine = bi === 'BOTH'
    ? 'The user has NOT specified a direction. Read the chart and say which side (if either) is tradeable.'
    : `The user is CONSIDERING A ${bi} position and wants your professional assessment of that specific idea.\n`
      + `CRITICAL: this is a request to EVALUATE the ${bi} side, NOT to justify it. If the chart does not support a ${bi} trade, say so plainly and explain what would have to change. `
      + `A professional who talks a client out of a bad trade is doing their job. Never invent a setup to satisfy the request.`;

  return `=== YOUR ROLE ===
You are a professional ${brief.label} with deep specialisation in ${pb.label}. You trade this
instrument for a living and have done for years. You are being asked for an independent read of
a live chart — your own analysis, in your own judgement.

TRADING STYLE: ${brief.label} · horizon ${brief.horizon} · ${brief.timeframes}
${brief.brief.map((l) => `  - ${l}`).join('\n')}

INSTRUMENT: ${pb.label} — this market has its own behaviour, and treating it like a generic
chart is how traders lose money on it:
${pb.brief.map((l) => `  - ${l}`).join('\n')}

DIRECTION REQUESTED: ${bi}
${biasLine}

=== HOW TO ANSWER ===
Analyse the chart INDEPENDENTLY first. Form your own view from structure, liquidity, zones and
momentum before you look at any engine output. Then state your read plainly.

You are judged on HONESTY, not on finding a trade. "NO TRADE — price is mid-range and the next
clean level is too far for a ${brief.label.toLowerCase()}" is a complete, professional answer and
is frequently the correct one.`;
}

/**
 * Compare the AI's independent read with what the deterministic engines say.
 *
 * INFORMATION ONLY. This never changes the AI's verdict, never filters a strategy, and never
 * feeds the auto-trader. Its whole purpose is to let the user see whether two independent
 * processes happened to agree — agreement is mildly reassuring, disagreement is genuinely
 * useful, and hiding either would be the dishonest option.
 */
export function matchStrategies(aiDirection, strategies) {
  const dir = upper(aiDirection);
  const list = Array.isArray(strategies) ? strategies : [];
  if (dir !== 'BUY' && dir !== 'SELL') {
    return { aiDirection: dir || 'NONE', agreeing: [], opposing: [], verdict: 'NO_DIRECTION', note: 'The AI did not call a direction, so there is nothing to compare.' };
  }
  const agreeing = list.filter((s) => upper(s.decision) === dir);
  const opposing = list.filter((s) => ['BUY', 'SELL'].includes(upper(s.decision)) && upper(s.decision) !== dir);
  const verdict = !list.length ? 'NO_STRATEGIES'
    : agreeing.length && !opposing.length ? 'ALIGNED'
      : agreeing.length && opposing.length ? 'MIXED'
        : opposing.length ? 'CONTRARY' : 'SILENT';
  const note = {
    NO_STRATEGIES: 'No enabled strategy is firing on this symbol/timeframe right now.',
    ALIGNED: `${agreeing.length} strateg${agreeing.length === 1 ? 'y agrees' : 'ies agree'} with the AI read.`,
    MIXED: `${agreeing.length} agree, ${opposing.length} disagree — the engines are split.`,
    CONTRARY: `Every firing strategy (${opposing.length}) points the OTHER way. Worth understanding why before acting.`,
    SILENT: 'Strategies are firing but none took a directional side.',
  }[verdict];
  return { aiDirection: dir, agreeing, opposing, verdict, note };
}
