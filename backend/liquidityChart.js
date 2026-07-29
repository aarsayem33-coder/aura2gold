// Liquidity chart analysis — the read-only layer behind /chart/liquidity.
//
// detectKeyLiquidityLevels() already finds WHERE the liquidity is (PDH/PDL, session
// extremes, equal highs/lows, swings, round numbers) and whether price has traded through
// it. It is reused unchanged — nothing here mutates it — and this module answers the
// question it does not: what HAPPENED at each level.
//
// The distinction that matters is sweep versus breakout. Both trade beyond a level; only
// one leaves the liquidity taken and price rejected. Calling every wick a sweep is the
// classic error, so the rules below are written in terms of candle CLOSES, not touches:
// a wick beyond that closes back inside is a sweep, a body close beyond that holds is a
// break. Everything is measured against the signal timeframe's own candles.
import { detectKeyLiquidityLevels, fractalSwings, atr14 } from './liquidityEngine.js';

const n = (v) => Number(v);
const r5 = (v) => Math.round(Number(v) * 1e5) / 1e5;

export const LIQUIDITY_STATUS = ['FRESH', 'TESTED', 'REJECTED', 'SWEPT', 'BROKEN_ACCEPTED', 'INVALIDATED'];

/**
 * Classify what price did at one level after it formed.
 *
 * `side` is the semantic side the liquidity rests on: 'above' means stops sit above the
 * level (buy-side liquidity), so "beyond" means higher.
 */
export function classifyLevel(candles, level, { atr = 0, tolAtr = 0.1, acceptCloses = 2, rejectAtr = 1.0, holdBars = 3, deadAtr = 3 } = {}) {
  const from = Math.max(0, Number(level.formedIdx ?? 0) + 1);
  const price = n(level.price);
  const above = level.side === 'above';
  const tol = (atr || 0) * tolAtr;
  if (!Number.isFinite(price) || candles.length <= from) {
    return { status: 'FRESH', touches: 0, closesBeyond: 0, pierced: false, evidence: 'no candles after it formed' };
  }

  let touches = 0;          // came within tolerance of the level
  let pierced = false;      // wick traded strictly beyond
  let closesBeyond = 0;     // body closed beyond
  let lastBeyondIdx = -1;
  let maxAwayAtr = 0;       // strongest move back AWAY from the level after a touch
  let firstTouchIdx = -1;

  for (let i = from; i < candles.length; i++) {
    const c = candles[i];
    const hi = n(c.high), lo = n(c.low), close = n(c.close);
    const reached = above ? hi >= price - tol : lo <= price + tol;
    if (reached) {
      touches += 1;
      if (firstTouchIdx < 0) firstTouchIdx = i;
      if (above ? hi > price : lo < price) pierced = true;
      if (above ? close > price : close < price) { closesBeyond += 1; lastBeyondIdx = i; }
      // How far price travelled back to the correct side within a few bars — that is what
      // separates a rejection from an idle touch.
      for (let j = i + 1; j < Math.min(candles.length, i + 1 + holdBars); j++) {
        const away = above ? price - n(candles[j].low) : n(candles[j].high) - price;
        if (atr > 0 && away / atr > maxAwayAtr) maxAwayAtr = away / atr;
      }
    }
  }

  if (!touches) return { status: 'FRESH', touches, closesBeyond, pierced, evidence: 'never revisited since it formed' };

  const lastClose = n(candles[candles.length - 1].close);
  const priceBeyondNow = above ? lastClose > price : lastClose < price;
  const barsSinceBeyond = lastBeyondIdx >= 0 ? candles.length - 1 - lastBeyondIdx : null;

  // Accepted beyond: repeated body closes through it AND price still living on that side.
  if (closesBeyond >= acceptCloses && priceBeyondNow) {
    // A level price broke long ago and has since left far behind is not "resistance turned
    // support" — it is simply gone. Distance decides: while price is still working around
    // the level it remains a live retest zone; once it is several ATR behind, the liquidity
    // there has already been consumed and showing it only crowds the chart.
    const awayAtr = atr > 0 ? Math.abs(lastClose - price) / atr : 0;
    const dead = awayAtr >= deadAtr;
    return {
      status: dead ? 'INVALIDATED' : 'BROKEN_ACCEPTED',
      touches, closesBeyond, pierced,
      evidence: dead
        ? `broken and left ${awayAtr.toFixed(1)}× ATR behind — no longer active liquidity`
        : `${closesBeyond} close${closesBeyond === 1 ? '' : 's'} beyond, price holding that side (live retest zone)`,
    };
  }
  // Traded through but failed to hold: the liquidity was taken and price came back.
  if (pierced && !priceBeyondNow) {
    return {
      status: 'SWEPT', touches, closesBeyond, pierced,
      evidence: closesBeyond
        ? `${closesBeyond} close(s) beyond, then reclaimed back inside`
        : 'wick traded beyond, closed back inside',
    };
  }
  // Reached it and was pushed away hard, without taking anything beyond.
  if (!pierced && maxAwayAtr >= rejectAtr) {
    return {
      status: 'REJECTED', touches, closesBeyond, pierced,
      evidence: `reacted ${maxAwayAtr.toFixed(1)}× ATR away from the level without piercing it`,
    };
  }
  return {
    status: 'TESTED', touches, closesBeyond, pierced,
    evidence: `touched ${touches}× with no decisive break`,
  };
}

/**
 * Market structure from confirmed swing points: HH/HL/LH/LL, plus BOS (continuation) and
 * CHoCH (the first break against the prevailing leg). Only a CLOSE beyond a prior swing
 * counts — a wick through it is exactly the inducement this is meant to distinguish.
 */
export function analyseStructure(candles) {
  const { highs, lows } = fractalSwings(candles);
  const pts = [...highs.map((p) => ({ ...p, kind: 'H' })), ...lows.map((p) => ({ ...p, kind: 'L' }))]
    .sort((a, b) => a.i - b.i);
  const labelled = [];
  let lastH = null, lastL = null;
  for (const p of pts) {
    if (p.kind === 'H') { labelled.push({ ...p, label: lastH === null ? 'H' : (p.price > lastH ? 'HH' : 'LH') }); lastH = p.price; }
    else { labelled.push({ ...p, label: lastL === null ? 'L' : (p.price > lastL ? 'HL' : 'LL') }); lastL = p.price; }
  }
  const recent = labelled.slice(-6);
  const ups = recent.filter((p) => p.label === 'HH' || p.label === 'HL').length;
  const downs = recent.filter((p) => p.label === 'LL' || p.label === 'LH').length;
  const bias = ups > downs + 1 ? 'BULLISH' : downs > ups + 1 ? 'BEARISH' : 'RANGING';

  // BOS / CHoCH: the latest close that broke the previous swing in each direction.
  const events = [];
  const lastClose = n(candles[candles.length - 1].close);
  const priorHigh = [...labelled].reverse().find((p) => p.kind === 'H');
  const priorLow = [...labelled].reverse().find((p) => p.kind === 'L');
  if (priorHigh && lastClose > priorHigh.price) {
    events.push({ type: bias === 'BEARISH' ? 'CHoCH' : 'BOS', direction: 'UP', level: r5(priorHigh.price),
      note: bias === 'BEARISH' ? 'first close above a swing high while structure was bearish' : 'close above the prior swing high' });
  }
  if (priorLow && lastClose < priorLow.price) {
    events.push({ type: bias === 'BULLISH' ? 'CHoCH' : 'BOS', direction: 'DOWN', level: r5(priorLow.price),
      note: bias === 'BULLISH' ? 'first close below a swing low while structure was bullish' : 'close below the prior swing low' });
  }
  return { bias, swings: labelled.slice(-12), events };
}

/**
 * Full analysis for one symbol/timeframe. Pure: candles in, analysis out.
 *
 * External vs internal is decided by the current dealing range — the most recent confirmed
 * swing high and low. Liquidity outside that range is what price is drawn to; liquidity
 * inside it is what gets used to induce traders on the way there.
 */
export function buildLiquidityChart(candles, { symbol = '', dailyCandles = null, weeklyCandles = null, maxDistanceAtr = 8, maxLevels = 22 } = {}) {
  if (!Array.isArray(candles) || candles.length < 30) {
    return { ok: false, error: 'not enough candles for a liquidity read (need 30+)', levels: [], structure: null };
  }
  const atr = atr14(candles) || 0;
  const price = n(candles[candles.length - 1].close);
  const base = detectKeyLiquidityLevels(candles, { symbol, dailyCandles });
  const structure = analyseStructure(candles);

  // Dealing range = latest confirmed swing high / low.
  const swingHighs = structure.swings.filter((s) => s.kind === 'H').map((s) => s.price);
  const swingLows = structure.swings.filter((s) => s.kind === 'L').map((s) => s.price);
  const rangeHigh = swingHighs.length ? Math.max(...swingHighs) : null;
  const rangeLow = swingLows.length ? Math.min(...swingLows) : null;

  // Relevance filter. The engine returns every level it can find across 500 bars; most sit
  // far outside anything price can reach and would bury the handful that matter. Keep what
  // is within reach, then cap by importance — the brief is explicit that accuracy beats
  // quantity and that overcrowding the chart is itself a failure.
  const inReach = (base.levels || []).filter((lv) => {
    if (!atr) return true;
    return Math.abs(n(lv.price) - price) / atr <= maxDistanceAtr;
  });
  const levels = inReach.map((lv) => {
    const cls = classifyLevel(candles, lv, { atr });
    const external = rangeHigh !== null && rangeLow !== null
      ? (lv.side === 'above' ? lv.price >= rangeHigh : lv.price <= rangeLow)
      : lv.strength >= 4;
    return {
      ...lv,
      status: cls.status,
      evidence: cls.evidence,
      touches: cls.touches,
      closesBeyond: cls.closesBeyond,
      // Stops rest above highs (buy-side) and below lows (sell-side).
      pool: lv.side === 'above' ? 'BSL' : 'SSL',
      scope: external ? 'EXTERNAL' : 'INTERNAL',
      // Inducement: internal, still fresh, and sitting between price and a bigger external
      // pool on the same side — the level likely to be taken first to fuel the real move.
      inducement: false,
      importance: lv.strength >= 5 ? 'HIGH' : lv.strength >= 3 ? 'MEDIUM' : 'LOW',
      confidence: lv.strength >= 5 ? 'High' : lv.strength >= 3 ? 'Medium' : 'Low',
    };
  });

  for (const side of ['above', 'below']) {
    const sameSide = levels.filter((l) => l.side === side && l.status === 'FRESH');
    const externals = sameSide.filter((l) => l.scope === 'EXTERNAL');
    if (!externals.length) continue;
    const target = side === 'above'
      ? Math.min(...externals.map((l) => l.price))
      : Math.max(...externals.map((l) => l.price));
    for (const l of sameSide) {
      if (l.scope !== 'INTERNAL') continue;
      const between = side === 'above' ? (l.price > price && l.price < target) : (l.price < price && l.price > target);
      if (between) l.inducement = true;
    }
  }

  // Draw on liquidity: nearest FRESH external pool each way.
  const freshAbove = levels.filter((l) => l.side === 'above' && l.status === 'FRESH' && l.price > price).sort((a, b) => a.price - b.price);
  const freshBelow = levels.filter((l) => l.side === 'below' && l.status === 'FRESH' && l.price < price).sort((a, b) => b.price - a.price);
  const pick = (arr) => arr.find((l) => l.scope === 'EXTERNAL') || arr[0] || null;
  const up = pick(freshAbove);
  const down = pick(freshBelow);
  const primary = structure.bias === 'BULLISH' ? up : structure.bias === 'BEARISH' ? down : (up && down ? (up.distance <= down.distance ? up : down) : (up || down));
  const alternative = primary && primary === up ? down : up;

  const swept = levels.filter((l) => l.status === 'SWEPT').sort((a, b) => (b.sweptAtMs || 0) - (a.sweptAtMs || 0));

  return {
    ok: true,
    price: r5(price),
    atr: r5(atr),
    dealingRange: rangeHigh !== null && rangeLow !== null ? { high: r5(rangeHigh), low: r5(rangeLow) } : null,
    structure,
    levels: levels
      // Dead levels are reported in the count but not drawn — they are history, not liquidity.
      .filter((l) => l.status !== 'INVALIDATED')
      .sort((a, b) => (b.strength - a.strength) || (a.distance - b.distance))
      .slice(0, maxLevels)
      .sort((a, b) => b.price - a.price),
    invalidatedCount: levels.filter((l) => l.status === 'INVALIDATED').length,
    consideredCount: (base.levels || []).length,
    recentlySwept: swept.slice(0, 5),
    draw: {
      primary: primary ? { price: primary.price, label: primary.label, pool: primary.pool, scope: primary.scope } : null,
      alternative: alternative ? { price: alternative.price, label: alternative.label, pool: alternative.pool, scope: alternative.scope } : null,
      basis: structure.bias === 'RANGING'
        ? 'structure is ranging — the nearer fresh pool is taken as the more likely draw'
        : `structure reads ${structure.bias}, so the fresh pool in that direction is the more likely draw`,
      invalidation: primary
        ? `a decisive close beyond the opposing pool${alternative ? ` (${alternative.price})` : ''} would flip this read`
        : 'no fresh pool on either side — wait for one to form',
    },
    // Stated plainly so the UI never implies more certainty than the data supports.
    caveats: [
      'Computed from this timeframe\'s candles only — no higher-timeframe structure is inferred.',
      dailyCandles ? null : 'No daily candles supplied, so PDH/PDL are unavailable.',
      weeklyCandles ? null : 'No weekly candles supplied, so PWH/PWL are unavailable.',
    ].filter(Boolean),
  };
}
