import assert from 'node:assert/strict';
import test from 'node:test';
import {
  capScore, buildForecastAiPrompt, normaliseForecastAi, reconcileForecastAi, deterministicForecastView,
} from './forecastAi.js';

const FORECAST = {
  symbol: 'XAUUSD', timeframe: 'M15', level: 4000, atr: 8.98,
  levelType: 'PDL', levelLabel: 'Prev day low', levelStrength: 5,
  scenario: 'SWEEP_REJECT', expectedDirection: 'BUY',
  distance: { pips: 120, atr: 1.3 },
  eta: { minMinutes: 30, maxMinutes: 120 },
  fires: [
    { strategyId: 'liq-trap-pro', decision: 'BUY', score: 88, grade: 'A', agrees: true },
    { strategyId: 'smc-cct', decision: 'SELL', score: 70, agrees: false },
  ],
  plan: { direction: 'BUY', entry: 4002, stopLoss: 3995, takeProfit: 4016, rr: 2, stopPips: 70 },
};
const PIP = 0.1;
// A well-formed BUY: entry 4002, stop 3995 (70 pips), targets above.
const GOOD = { direction: 'BUY', agrees_with_system: true, score: 82, confidence: 'HIGH', entry: 4002, stop_loss: 3995, take_profit_1: 4009, take_profit_2: 4016, verdict: 'TAKE' };
const rec = (raw, over = {}) => reconcileForecastAi(normaliseForecastAi(raw), { forecast: FORECAST, pip: PIP, ...over });

// ── prompt ───────────────────────────────────────────────────────────────────

test('the prompt carries the level, scenario and every strategy verdict', () => {
  const p = buildForecastAiPrompt({ forecast: FORECAST, market: { price: 4012, atr: 8.98, h1Trend: 'BULLISH' } });
  assert.match(p, /XAUUSD/);
  assert.match(p, /4000/);
  assert.match(p, /SWEEP_REJECT/);
  assert.match(p, /liq-trap-pro: BUY score 88/);
  assert.match(p, /smc-cct: SELL score 70 \(DISAGREES/, 'dissent must reach the model, not just agreement');
  assert.match(p, /BULLISH/);
});

test('the prompt states the scenario has not happened and invites disagreement', () => {
  // A model handed a confident forecast rubber-stamps it unless told otherwise, which would
  // make the whole feature a yes-man.
  const p = buildForecastAiPrompt({ forecast: FORECAST });
  assert.match(p, /HAS NOT HAPPENED YET/);
  assert.match(p, /EXPECTED to disagree/);
});

test('the prompt survives a forecast with no ticket and no strategies', () => {
  const p = buildForecastAiPrompt({ forecast: { symbol: 'EURUSD', timeframe: 'H1', fires: [], plan: null } });
  assert.match(p, /no strategy fired/);
  assert.match(p, /no sized ticket/);
});

test('news is included when present and its absence is stated', () => {
  const withNews = buildForecastAiPrompt({ forecast: FORECAST, news: [{ currency: 'USD', impact: 'HIGH', title: 'NFP', in_minutes: 45 }] });
  assert.match(withNews, /NFP/);
  assert.match(buildForecastAiPrompt({ forecast: FORECAST }), /No high-impact news/);
});

// ── normalisation ────────────────────────────────────────────────────────────

test('a clean response normalises field by field', () => {
  const a = normaliseForecastAi(GOOD);
  assert.equal(a.direction, 'BUY');
  assert.equal(a.score, 82);
  assert.equal(a.confidence, 'HIGH');
  assert.equal(a.entry, 4002);
  assert.equal(a.verdict, 'TAKE');
});

test('unknown enum values fall back to the safest reading, not the boldest', () => {
  const a = normaliseForecastAi({ direction: 'MAYBE', verdict: 'DEFINITELY', confidence: 'ABSOLUTE', score: 90 });
  assert.equal(a.direction, 'NO_TRADE');
  assert.equal(a.verdict, 'WATCH');
  assert.equal(a.confidence, 'LOW');
});

test('missing numbers stay null rather than becoming plausible defaults', () => {
  const a = normaliseForecastAi({ direction: 'BUY', entry: 'about 4002', stop_loss: null });
  assert.equal(a.entry, null, 'a fabricated price is worse than a missing one');
  assert.equal(a.stopLoss, null);
  assert.equal(a.score, null);
});

test('score is clamped and agreement defaults to false', () => {
  assert.equal(capScore(140), 100);
  assert.equal(capScore(-5), 0);
  assert.equal(capScore('abc'), null);
  assert.equal(normaliseForecastAi({}).agreesWithSystem, false);
  // Only an explicit true counts — a truthy string must not be read as agreement.
  assert.equal(normaliseForecastAi({ agrees_with_system: 'yes' }).agreesWithSystem, false);
});

test('free text is bounded so a runaway response cannot bloat the row', () => {
  const a = normaliseForecastAi({ rationale: 'x'.repeat(5000), key_risks: Array(20).fill('r'.repeat(500)) });
  assert.ok(a.rationale.length <= 1200);
  assert.ok(a.keyRisks.length <= 5);
  assert.ok(a.keyRisks[0].length <= 200);
});

// ── reconciliation: the part that keeps the model honest ─────────────────────

test('a sound ticket reconciles and computes its own RR', () => {
  const r = rec(GOOD);
  assert.deepEqual(r.issues, []);
  assert.equal(r.ticketUsable, true);
  assert.equal(r.stopPips, 70);
  assert.equal(r.rr, 2, 'computed from the prices given, to the furthest target');
  assert.equal(r.agreesWithSystem, true);
});

test('a stop on the profitable side is rejected, not silently used', () => {
  // The most common model error, and it inverts the entire risk calculation.
  const r = rec({ ...GOOD, stop_loss: 4008 });
  assert.equal(r.ticketUsable, false);
  assert.match(r.issues[0], /wrong side of entry/);
  assert.equal(r.rr, null);
  // Mirrored for a SELL.
  const s = reconcileForecastAi(
    normaliseForecastAi({ ...GOOD, direction: 'SELL', entry: 4002, stop_loss: 3995, take_profit_1: 3980 }),
    { forecast: FORECAST, pip: PIP },
  );
  assert.match(s.issues.find((i) => /wrong side/.test(i)) || '', /wrong side/);
});

test('a target on the wrong side is dropped rather than counted', () => {
  const r = rec({ ...GOOD, take_profit_1: 3990, take_profit_2: null });
  assert.equal(r.takeProfit1, null);
  assert.ok(r.issues.some((i) => /take-profit/.test(i)));
  assert.equal(r.ticketUsable, false, 'no valid target means no usable ticket');
});

test('RR is arithmetic on the given prices, never the model\'s claim', () => {
  // Model asserts a 9R trade; its own prices say 2R.
  const r = rec({ ...GOOD, rr: 9, risk_reward: 9 });
  assert.equal(r.rr, 2);
});

test('a false agreement claim is corrected and flagged', () => {
  // Says it agrees, but points the opposite way to the system's BUY.
  const r = rec({ ...GOOD, direction: 'SELL', agrees_with_system: true, stop_loss: 4009, take_profit_1: 3990, take_profit_2: 3980 });
  assert.equal(r.agreesWithSystem, false, 'agreement is derived from direction, not trusted');
  assert.ok(r.issues.some((i) => /said it agrees/.test(i)));
});

test('a genuine disagreement is allowed through as a valid opinion', () => {
  const r = rec({ direction: 'SELL', agrees_with_system: false, score: 71, entry: 4002, stop_loss: 4009, take_profit_1: 3988, verdict: 'SKIP' });
  assert.equal(r.agreesWithSystem, false);
  assert.equal(r.ticketUsable, true, 'disagreeing does not make the ticket invalid');
  assert.deepEqual(r.issues, []);
});

test('NO_TRADE short-circuits without demanding prices', () => {
  const r = rec({ direction: 'NO_TRADE', verdict: 'SKIP', score: 20 });
  assert.equal(r.direction, 'NO_TRADE');
  assert.deepEqual(r.issues, []);
  assert.equal(r.ticketUsable, false);
});

test('missing prices are reported, not invented', () => {
  const r = rec({ direction: 'BUY', agrees_with_system: true, entry: null, stop_loss: null });
  assert.match(r.issues[0], /no usable entry\/stop/);
  assert.equal(r.ticketUsable, false);
});

test('an omitted agreement field is not reported as a self-contradiction', () => {
  // Defaulting the field to false and then deriving the real value from the direction used to
  // emit "the model said it disagrees…" on every response that simply left the field out.
  const r = rec({ direction: 'BUY', entry: 4002, stop_loss: 3995, take_profit_1: 4009 });
  assert.deepEqual(r.issues, [], 'no warning when the model never answered the question');
  assert.equal(r.agreesWithSystem, true, 'still derived from the direction');
});

test('a stop inside the broker minimum is flagged', () => {
  const r = rec({ ...GOOD, stop_loss: 4001.9 }, { minStopDistance: 1 });
  assert.ok(r.issues.some((i) => /minimum distance/.test(i)));
  assert.equal(r.ticketUsable, false);
});

test('an entry far from the forecast level is called out as a different setup', () => {
  // 2 ATR is ~18 on this gold forecast; 4100 is nowhere near the 4000 level.
  const r = rec({ ...GOOD, entry: 4100, stop_loss: 4090, take_profit_1: 4120 });
  assert.ok(r.issues.some((i) => /different setup/.test(i)));
});

test('identical entry and stop cannot produce an infinite RR', () => {
  const r = rec({ ...GOOD, entry: 4002, stop_loss: 4002 });
  assert.match(r.issues[0], /same price/);
  assert.equal(r.rr, null);
});

// ── fallback ─────────────────────────────────────────────────────────────────

test('the fallback reports real evidence and never fabricates an opinion', () => {
  const v = deterministicForecastView(FORECAST, 'no API key configured');
  assert.equal(v.available, false);
  assert.equal(v.reason, 'no API key configured');
  assert.equal(v.direction, 'BUY');
  assert.match(v.summary, /No AI review/);
  assert.match(v.summary, /1 strategy backing BUY/);
  assert.match(v.summary, /1 arguing the other way/);
});

test('the fallback is honest when nothing backs the scenario', () => {
  const v = deterministicForecastView({ ...FORECAST, fires: [] }, 'quota exceeded');
  assert.match(v.summary, /no strategy currently backs/);
});

// ── discipline is advisory, and provably cannot move the verdict ─────────────
// The prompt wording asks the model not to downgrade on a spent risk budget. Wording alone is
// not a guarantee, so these assert the STRUCTURAL half: everything the model is asked to judge
// on is byte-identical whether the desk is flat or down its daily stop.

const advisory = (limitHit) => [
  '=== TRADING DISCIPLINE STATE (ADVISORY — READ IT, DO NOT SCORE IT) ===',
  limitHit ? 'DAILY STOP REACHED — the playbook says the desk stops trading today.' : 'Room remaining: 0.6R.',
  'It MUST NOT change your verdict.',
].join('\n');

test('the discipline block is optional and absent by default', () => {
  const p = buildForecastAiPrompt({ forecast: FORECAST });
  assert.ok(!p.includes('TRADING DISCIPLINE STATE'));
});

test('everything outside the discipline block is invariant to the R budget', () => {
  const calm = buildForecastAiPrompt({ forecast: FORECAST, disciplineRead: advisory(false) });
  const blown = buildForecastAiPrompt({ forecast: FORECAST, disciplineRead: advisory(true) });
  const HEAD = '=== TRADING DISCIPLINE STATE';
  assert.equal(calm.slice(0, calm.indexOf(HEAD)), blown.slice(0, blown.indexOf(HEAD)),
    'the setup description changed with the risk budget');
  assert.equal(calm.slice(calm.indexOf('YOUR JOB')), blown.slice(blown.indexOf('YOUR JOB')),
    'the scoring instructions changed with the risk budget');
});

test('the advisory sits before YOUR JOB so the constraint is read last', () => {
  const p = buildForecastAiPrompt({ forecast: FORECAST, disciplineRead: advisory(false) });
  assert.ok(p.indexOf('TRADING DISCIPLINE STATE') < p.indexOf('YOUR JOB'));
});

test('discipline_note is captured, bounded, and null when unset', () => {
  assert.equal(normaliseForecastAi({}).disciplineNote, null);
  assert.equal(normaliseForecastAi({ discipline_note: 'down 2R today' }).disciplineNote, 'down 2R today');
  assert.equal(normaliseForecastAi({ discipline_note: 'x'.repeat(500) }).disciplineNote.length, 300);
});

test('the discipline note rides through reconciliation without touching the ticket', () => {
  // The real guarantee: the note reaches the UI (the human needs it), but every SCORED field —
  // direction, score, verdict, entry, stop, targets, issues — is bit-identical with and
  // without it. Nothing risk-budget shaped can move the trade.
  const base = normaliseForecastAi({
    direction: 'BUY', score: 70, entry: 4000, stop_loss: 3990, take_profit_1: 4020, verdict: 'TAKE',
  });
  const withNote = { ...base, disciplineNote: 'DAILY STOP HIT — do not trade again today' };
  const a = reconcileForecastAi(base, FORECAST);
  const b = reconcileForecastAi(withNote, FORECAST);
  assert.equal(b.disciplineNote, 'DAILY STOP HIT — do not trade again today', 'the human must still see it');
  const strip = ({ disciplineNote, ...rest }) => rest;
  assert.deepEqual(strip(b), strip(a), 'a discipline note changed a scored field');
});
