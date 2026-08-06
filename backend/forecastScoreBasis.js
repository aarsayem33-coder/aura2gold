// Plain-English breakdown of what a setup forecast is actually claiming.
//
// A forecast shows a score, a grade and a sized ticket. All three look exactly like the ones on
// the live signal pages — and they are not the same thing at all. A live signal is a reading of
// something that happened; a forecast is a reading of something CONSTRUCTED. The score is the
// firing strategy's own number, but it was earned against a bar this system invented.
//
// So this module answers one question in words a beginner can act on:
//
//     which parts of that number came from the market, and which parts came from the assumption?
//
// It invents nothing. Everything below is read off the forecast, the scenario geometry the bars
// were actually built from (setupForecast.js), and the placebo measurement that already runs on
// every scan. Where a fact is not available it says so rather than filling the gap.
//
// Pure — no clock, no database, no live state — so the wording can be tested.

import { SCENARIO_GEOMETRY } from './setupForecast.js';

const n = (v) => Number(v);
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(n(v)) ? null : n(v));
const r2 = (v) => Math.round(n(v) * 100) / 100;

/**
 * What each scenario is, said the way you would say it out loud.
 *
 * `story` is deliberately not the technical name. "SWEEP_REJECT" means nothing to someone who has
 * not read an ICT thread; "price dips past the level, triggers the stop-losses resting there, then
 * snaps back" is the same fact and needs no glossary.
 */
export const SCENARIO_PLAIN = {
  SWEEP_REJECT: {
    name: 'Sweep and reject',
    story: 'Price dips just past the level, triggers the stop-losses resting there, then snaps back the other way. The failed break is the signal.',
    signal: 'the break FAILS',
    wrongIf: 'price keeps going past the level instead of snapping back',
  },
  BREAK_HOLD: {
    name: 'Break and hold',
    story: 'Price pushes through the level and stays on the other side instead of bouncing. The acceptance is the signal.',
    signal: 'the break HOLDS',
    wrongIf: 'price pokes through and immediately falls back inside the level',
  },
  TOUCH_REJECT: {
    name: 'Touch and reject',
    story: 'Price reaches the level exactly and turns away without trading through it at all.',
    signal: 'the level HOLDS on the first touch',
    wrongIf: 'price trades straight through the level rather than turning at it',
  },
};

/** How the level was found, in words rather than enum names. */
const SOURCE_PLAIN = {
  LIQUIDITY: 'resting liquidity (stop-losses parked at an obvious high or low)',
  ORDER_BLOCK: 'an order block (the last candle before a strong move away)',
  ZONE: 'a support or resistance zone price has respected before',
  RETEST: 'a broken level that flipped sides and has not been retested yet',
};

/** Plain reading of the placebo test — the one piece of hard evidence this page owns. */
export function evidencePlain(discrimination) {
  const d = discrimination || null;
  if (!d) {
    return {
      verdict: null,
      headline: 'Not measured yet',
      detail: 'Every scan also tests this strategy at random prices where no real level sits. Once enough of those have run, this line will say whether the strategy is genuinely reacting to the level or just to the shape of the bar.',
      good: null,
    };
  }
  const lift = num(d.lift);
  const liftWord = d.levelOnly
    ? 'It has never once fired at a random price — only at real levels.'
    : lift !== null
      ? `It fires about ${lift}× more often at real levels than at random prices.`
      : '';
  if (d.verdict === 'LEVEL_DRIVEN') {
    return {
      verdict: d.verdict,
      headline: 'Passed the placebo test',
      detail: `This strategy was also run against random prices with no real level, as a control. ${liftWord} That is evidence the level itself matters, not just the shape of the assumed bar.`,
      good: true,
    };
  }
  if (d.verdict === 'SHAPE_DRIVEN') {
    return {
      verdict: d.verdict,
      headline: 'Failed the placebo test — treat with caution',
      detail: `This strategy fires almost as often at random prices as it does at real levels${lift !== null ? ` (only ${lift}× more)` : ''}. That means it is largely reacting to the SHAPE of the assumed bar rather than to the level, so the forecast is weak evidence.`,
      good: false,
    };
  }
  if (d.verdict === 'SILENT') {
    return {
      verdict: d.verdict,
      headline: 'Has not fired at all recently',
      detail: 'This strategy has produced no forecasts in the current measurement window, so there is nothing to judge it on yet.',
      good: null,
    };
  }
  return {
    verdict: d.verdict || 'UNMEASURED',
    headline: 'Not enough data yet',
    detail: 'The placebo control has not accumulated enough scenarios to say whether this strategy reacts to the level or to the bar shape. Until it does, treat the score as unproven.',
    good: null,
  };
}

/**
 * The full breakdown.
 *
 * The split that matters is ASSUMED vs MEASURED. Two of the things a strategy scores on — how
 * decisively the reaction bar closes, and how far it travels — are read off a bar this system
 * drew. That does not make the forecast worthless; it makes it CONDITIONAL, and the difference
 * has to be on the page rather than in a doc nobody opens.
 */
export function forecastScoreBasis({ forecast, discrimination = null, geo = SCENARIO_GEOMETRY } = {}) {
  const f = forecast || {};
  const scenario = String(f.scenario || '').toUpperCase();
  const plain = SCENARIO_PLAIN[scenario] || {
    name: scenario || 'Unknown scenario',
    story: 'Price reaches the level and reacts.',
    signal: 'the reaction happens',
    wrongIf: 'price behaves differently when it gets there',
  };
  const pips = num(f.distance?.pips);
  const atrAway = num(f.distance?.atr);
  const agree = num(f.agreeCount) ?? 0;
  const dissent = num(f.dissentCount) ?? 0;
  const bars = Array.isArray(f.scenarioBars) ? f.scenarioBars.length : 0;

  // How far past the level the assumed wick pokes, taken from the geometry the bars were REALLY
  // built with. Quoting a number the builder does not use would be worse than quoting none.
  const pierceAtr = scenario === 'SWEEP_REJECT' ? num(geo?.sweep?.pierce)
    : scenario === 'BREAK_HOLD' ? num(geo?.breakBar?.close)
      : 0;

  const sources = Array.isArray(f.levelSources) ? f.levelSources : [];
  const confluence = num(f.levelConfluence) ?? 1;

  const assumed = [
    {
      label: 'That price gets there at all',
      detail: pips === null
        ? 'Price has not reached this level yet. Nothing on this card happens unless it does.'
        : `Price is ${pips} pips away${atrAway !== null ? ` (${atrAway}× its normal candle range)` : ''} and has to travel that far first. If it never arrives, none of this happens.`,
    },
    {
      label: 'How price behaves when it arrives',
      detail: `We assume a textbook ${plain.name.toLowerCase()}: ${plain.story} That behaviour is drawn by this system, not observed — it is the "IF" in the forecast.`,
    },
    {
      label: 'How big the reaction is',
      detail: pierceAtr
        ? `The assumed candle is sized from the level and current volatility — the wick pokes about ${r2(pierceAtr)}× the average candle range past the level. A smaller or larger real reaction would score differently.`
        : 'The assumed candle is sized from the level and current volatility. A smaller or larger real reaction would score differently.',
    },
  ];
  // Only claim this when a strategy actually returned prices; otherwise it describes nothing.
  if (f.plan?.entry) {
    assumed.push({
      label: 'The entry and stop prices',
      detail: 'The ticket comes from the strategy\'s own rules, but those rules read the assumed candle — so entry and stop move if the real reaction has a different shape. Re-check the price before you trade it.',
    });
  }

  const measured = [
    {
      label: 'The level itself',
      detail: `${f.levelLabel || f.levelType || 'This price'} is a real level read off the chart, at ${f.level ?? '—'}.`
        + (sources.length
          ? ` ${confluence > 1 ? `${confluence} independent things` : 'It'} point${confluence > 1 ? '' : 's'} at this same price: ${sources.map((s) => SOURCE_PLAIN[s] || s.toLowerCase()).join(', ')}.`
          : ''),
    },
    {
      label: 'Everything before the reaction',
      detail: `The strategies were handed the real candle history and only the last ${bars || 2} candle${bars === 1 ? '' : 's'} were invented. Trend, structure and prior swings are all genuine.`,
    },
    {
      label: 'The bigger-picture trend',
      detail: 'The higher-timeframe trend is passed through untouched, so any "don\'t trade against the trend" filter a strategy applies was judged against the real market, not the assumption.',
    },
    {
      label: 'Which strategies backed it',
      detail: agree === 0
        ? 'No strategy currently backs this scenario.'
        : `${agree} strateg${agree === 1 ? 'y' : 'ies'} said they would take this trade, judged by their own unchanged rules`
          + (dissent ? `, and ${dissent} argued the other way — shown on the card rather than hidden.` : '. No strategy argued against it.'),
    },
  ];

  const evidence = evidencePlain(discrimination);

  return {
    scenario: {
      key: scenario,
      name: plain.name,
      story: plain.story,
      signalIs: plain.signal,
      wrongIf: plain.wrongIf,
    },
    headline: pips === null
      ? `This is a prediction, not a signal — it needs price to reach ${f.level ?? 'the level'} first.`
      : `This is a prediction, not a signal. Price must first travel ${pips} pips to ${f.level}, and then ${plain.signal}.`,
    assumed,
    measured,
    evidence,
    caution: 'The score is the strategy\'s own number, earned against the assumed candle. Read it as "how good this would be IF it plays out", never as a chance of it playing out.',
  };
}
