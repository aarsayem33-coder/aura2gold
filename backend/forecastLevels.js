/**
 * Level pool for setup forecasting.
 *
 * The forecast engine asks "when price ARRIVES at X, which strategies fire?". That question is
 * only as good as the set of X it is asked about. Originally X came from detectKeyLiquidityLevels
 * alone — PDH/PDL, session highs/lows, equal highs/lows, round numbers, major swings. That is
 * where liquidity RESTS, but it is not where every strategy waits:
 *
 *   - order blocks       the last opposing candle before a displacement; price returns to the
 *                        PROXIMAL edge, not the middle, so that edge is the level
 *   - S/R zones          prices that have been touched repeatedly and held
 *   - retests            a broken level that flipped polarity and has not yet been retested
 *
 * This module turns those three into candidates in the SAME shape detectKeyLiquidityLevels emits,
 * so the runner needs no special cases, and merges them with de-duplication.
 *
 * Two rules that matter more than they look:
 *
 *   1. CONFLUENCE IS REAL, DOUBLE-COUNTING IS NOT. A PDH that is also the proximal edge of an
 *      unmitigated order block is one level, not two. Emitting both would forecast the same
 *      arrival twice and inflate every hit-rate that groups by level. They collapse into one
 *      candidate carrying every source, and the extra sources raise its strength.
 *
 *   2. SOURCES MUST NOT STARVE EACH OTHER. The runner keeps the nearest N levels. S/R zones are
 *      far denser than daily liquidity, so a plain nearest-N merge would fill the pool with zones
 *      and silently stop forecasting PDH/PDL — a regression that looks like "fewer forecasts"
 *      rather than "the level pool changed". `interleaveBySource` guarantees each source a share.
 */

const n = (v) => Number(v);
const r5 = (v) => Math.round(n(v) * 1e5) / 1e5;
const arr = (v) => (Array.isArray(v) ? v : []);

export const LEVEL_DEFAULTS = {
  dedupeAtr: 0.15,        // levels closer than this are the same level wearing two hats
  maxOrderBlocks: 6,
  maxZones: 6,
  maxRetests: 4,
  minZoneStrength: 2,     // a "zone" touched once is just a candle
  maxAgeBars: 240,        // older structure is stale at forecast horizons
};

/** Which pool a level competes in for quota purposes. */
export function sourceGroup(type) {
  const t = String(type || '').toUpperCase();
  if (t === 'ORDER_BLOCK') return 'ORDER_BLOCK';
  if (t === 'SUPPORT_ZONE' || t === 'RESISTANCE_ZONE') return 'ZONE';
  if (t === 'RETEST_SUPPORT' || t === 'RETEST_RESISTANCE') return 'RETEST';
  return 'LIQUIDITY';
}

const sideOf = (levelPrice, price) => (levelPrice < price ? 'below' : 'above');

/** Fill in the geometry fields the runner and the UI read, so every source looks alike. */
function decorate(level, { price, atr, pip }) {
  const lp = n(level.price);
  const d = Math.abs(lp - n(price));
  return {
    swept: false,
    fresh: true,
    ...level,
    price: r5(lp),
    side: sideOf(lp, n(price)),
    distance: r5(d),
    distancePips: n(pip) > 0 ? Math.round((d / n(pip)) * 10) / 10 : null,
    distanceAtr: n(atr) > 0 ? Math.round((d / n(atr)) * 100) / 100 : null,
  };
}

/**
 * Order blocks → one level each, at the PROXIMAL edge.
 *
 * A bullish (demand) block is approached from above, so the edge price meets first is its top; a
 * bearish (supply) block is approached from below, so it is the bottom. Using the midpoint would
 * systematically forecast arrival deeper into the zone than the strategies actually require, and
 * mark forecasts unreached when the setup had already triggered.
 *
 * Only unmitigated, live blocks qualify. A mitigated block has already been traded through — its
 * orders are filled, and forecasting a reaction there is forecasting a reaction to nothing.
 */
export function orderBlockLevels(orderBlocks, { price, atr, pip, options = {} } = {}) {
  const o = { ...LEVEL_DEFAULTS, ...options };
  const p = n(price), a = n(atr);
  if (!(p > 0) || !(a > 0)) return [];
  const out = [];
  for (const ob of arr(orderBlocks)) {
    const top = n(ob.top), bottom = n(ob.bottom);
    if (!Number.isFinite(top) || !Number.isFinite(bottom) || top <= bottom) continue;
    // `active`/`unmitigated` come from the block's lifecycle; a block that never reports either
    // is treated as spent rather than assumed live.
    if (ob.mitigated || ob.invalidated || ob.unmitigated === false || ob.active === false) continue;
    const bull = String(ob.type || '').toUpperCase().startsWith('BULL');
    const levelPrice = bull ? top : bottom;
    // A demand block must sit BELOW price to be a pullback target, supply ABOVE. One that does
    // not is either already being traded into or has been overrun; either way the premise that
    // price will arrive later is false.
    if (bull ? levelPrice >= p : levelPrice <= p) continue;

    const heightAtr = (top - bottom) / a;
    // A block wider than ~1.5 ATR is not a level, it is a region — the arrival price is too
    // uncertain for a forecast that has to name an entry.
    if (!(heightAtr > 0) || heightAtr > 1.5) continue;

    // Strength: live blocks start at 3, tight ones earn a point, sprawling ones lose one.
    let strength = 3;
    if (heightAtr <= 0.5) strength += 1;
    if (heightAtr > 1.0) strength -= 1;
    if (ob.actionable === false) strength -= 1;

    out.push(decorate({
      type: 'ORDER_BLOCK',
      label: `${bull ? 'Bullish' : 'Bearish'} order block`,
      price: levelPrice,
      strength: Math.max(1, Math.min(5, strength)),
      obTop: r5(top),
      obBottom: r5(bottom),
      obType: bull ? 'BULLISH' : 'BEARISH',
      formedIdx: Number.isFinite(n(ob.sourceIndex)) ? n(ob.sourceIndex) : null,
    }, { price: p, atr: a, pip }));
  }
  return out
    .sort((x, y) => (y.strength - x.strength) || (x.distance - y.distance))
    .slice(0, o.maxOrderBlocks);
}

/**
 * Support/resistance clusters → levels, strength = touch count straight from the detector.
 *
 * Only zones on the correct side survive: "support" above the current price is not support, it is
 * a level price has already broken, and the detector's own labelling lags that.
 */
export function zoneLevels(supportResistance, { price, atr, pip, options = {} } = {}) {
  const o = { ...LEVEL_DEFAULTS, ...options };
  const p = n(price), a = n(atr);
  if (!(p > 0) || !(a > 0)) return [];
  const src = supportResistance || {};
  const out = [];
  const take = (list, type, label, wantSide) => {
    for (const z of arr(list)) {
      const lp = n(z.level ?? z.price);
      const strength = n(z.strength);
      if (!Number.isFinite(lp) || lp <= 0) continue;
      if (!(strength >= o.minZoneStrength)) continue;
      if (wantSide === 'below' ? lp >= p : lp <= p) continue;
      out.push(decorate({
        type, label, price: lp,
        strength: Math.max(1, Math.min(5, Math.round(strength))),
        touches: Math.round(strength),
      }, { price: p, atr: a, pip }));
    }
  };
  take(src.support, 'SUPPORT_ZONE', 'Support zone', 'below');
  take(src.resistance, 'RESISTANCE_ZONE', 'Resistance zone', 'above');
  return out
    .sort((x, y) => (y.strength - x.strength) || (x.distance - y.distance))
    .slice(0, o.maxZones);
}

/** Pivot highs/lows with a symmetric lookback — the structure a break is measured against. */
function pivots(candles, span = 3) {
  const highs = [], lows = [];
  for (let i = span; i < candles.length - span; i++) {
    const h = n(candles[i].high), l = n(candles[i].low);
    let isHigh = true, isLow = true;
    for (let k = i - span; k <= i + span; k++) {
      if (k === i) continue;
      if (n(candles[k].high) >= h) isHigh = false;
      if (n(candles[k].low) <= l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ idx: i, price: h });
    if (isLow) lows.push({ idx: i, price: l });
  }
  return { highs, lows };
}

/**
 * Broken levels that have flipped polarity and NOT yet been retested.
 *
 * A swing high closed through becomes support; a swing low closed through becomes resistance.
 * The forecastable moment is the return to it, which by definition has not happened yet — so a
 * level price has already come back and touched is dropped, not down-weighted. Its retest is
 * history, and the strategies that trade retests have already had their chance.
 *
 * A close back through the level in the original direction invalidates the flip entirely.
 */
export function retestLevels(candles, { price, atr, pip, options = {} } = {}) {
  const o = { ...LEVEL_DEFAULTS, ...options };
  const cs = arr(candles);
  const p = n(price), a = n(atr);
  if (cs.length < 30 || !(p > 0) || !(a > 0)) return [];
  const { highs, lows } = pivots(cs, 3);
  const last = cs.length - 1;
  const out = [];

  const scan = (pivotList, dir) => {
    // dir 'up': a high broken upward flips to support (level below price).
    const up = dir === 'up';
    for (const pv of pivotList) {
      const lvl = n(pv.price);
      if (!Number.isFinite(lvl) || lvl <= 0) continue;
      if (last - pv.idx > o.maxAgeBars) continue;
      // First close beyond the pivot after it formed.
      let breakIdx = -1;
      for (let i = pv.idx + 1; i <= last; i++) {
        const c = n(cs[i].close);
        if (up ? c > lvl : c < lvl) { breakIdx = i; break; }
      }
      if (breakIdx < 0) continue;
      // The break must have carried far enough to be a break rather than a wick through.
      const extreme = up
        ? Math.max(...cs.slice(breakIdx, last + 1).map((c) => n(c.high)))
        : Math.min(...cs.slice(breakIdx, last + 1).map((c) => n(c.low)));
      if (Math.abs(extreme - lvl) < 0.5 * a) continue;

      let touched = false, invalidated = false;
      for (let i = breakIdx + 1; i <= last; i++) {
        // Retested: price traded back to the level.
        if (up ? n(cs[i].low) <= lvl : n(cs[i].high) >= lvl) touched = true;
        // Invalidated: it closed back through, so the flip never held.
        if (up ? n(cs[i].close) < lvl : n(cs[i].close) > lvl) { invalidated = true; break; }
      }
      if (touched || invalidated) continue;
      if (up ? lvl >= p : lvl <= p) continue;   // must still be untouched on the right side

      // Strength from how decisively it broke: a level shoved through by 2 ATR and left behind
      // is a stronger flip than one cleared by a nose.
      const reachAtr = Math.abs(extreme - lvl) / a;
      const strength = reachAtr >= 2 ? 4 : reachAtr >= 1 ? 3 : 2;
      out.push(decorate({
        type: up ? 'RETEST_SUPPORT' : 'RETEST_RESISTANCE',
        label: up ? 'Broken high (now support)' : 'Broken low (now resistance)',
        price: lvl,
        strength,
        brokeAtIdx: breakIdx,
        breakReachAtr: Math.round(reachAtr * 100) / 100,
        formedIdx: pv.idx,
      }, { price: p, atr: a, pip }));
    }
  };
  scan(highs, 'up');
  scan(lows, 'down');
  return out
    .sort((x, y) => (y.strength - x.strength) || (x.distance - y.distance))
    .slice(0, o.maxRetests);
}

/**
 * Collapse levels that are the same price into one candidate carrying every source.
 *
 * The survivor keeps the strongest entry's identity, and gains a point per extra confluent source
 * (capped at 5) — a PDH that is also an order block edge genuinely is a better level than either
 * alone. `sources` is preserved so the report can attribute a hit to every source that named it.
 */
export function dedupeLevels(levels, { atr, options = {} } = {}) {
  const o = { ...LEVEL_DEFAULTS, ...options };
  const a = n(atr);
  const list = arr(levels).filter((l) => Number.isFinite(n(l.price)) && n(l.price) > 0);
  if (!(a > 0)) return list;
  const tol = o.dedupeAtr * a;
  // Strongest first so the survivor of each cluster is the best-evidenced one, not the first
  // source that happened to be merged in.
  const sorted = [...list].sort((x, y) => n(y.strength) - n(x.strength));
  const kept = [];
  for (const l of sorted) {
    const hit = kept.find((k) => k.side === l.side && Math.abs(n(k.price) - n(l.price)) <= tol);
    if (!hit) {
      kept.push({ ...l, sources: [l.type], confluence: 1 });
      continue;
    }
    if (!hit.sources.includes(l.type)) {
      hit.sources.push(l.type);
      hit.confluence += 1;
      hit.strength = Math.min(5, n(hit.strength) + 1);
    }
  }
  return kept.sort((x, y) => n(x.distance) - n(y.distance));
}

/**
 * Round-robin across source groups so no single source can monopolise the pool.
 *
 * Within a group the order given is preserved (the callers sort by distance), so this only ever
 * changes WHICH levels survive a later cap, never their relative ranking inside a source.
 */
export function interleaveBySource(levels, { limit = 24 } = {}) {
  const groups = new Map();
  for (const l of arr(levels)) {
    const g = sourceGroup(l.type);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(l);
  }
  // Liquidity first on each pass: it is the source with the longest measured track record, so
  // when the cap bites it should be the last thing dropped.
  const order = ['LIQUIDITY', 'ORDER_BLOCK', 'RETEST', 'ZONE'].filter((g) => groups.has(g));
  for (const g of groups.keys()) if (!order.includes(g)) order.push(g);
  const out = [];
  for (let round = 0; out.length < limit; round++) {
    let added = false;
    for (const g of order) {
      const list = groups.get(g);
      if (round < list.length) { out.push(list[round]); added = true; }
      if (out.length >= limit) break;
    }
    if (!added) break;
  }
  return out;
}

/**
 * The full candidate pool: liquidity + order blocks + zones + retests, deduped and balanced.
 *
 * Returns `{ levels, counts }` — `counts` reports what each source contributed before and after
 * the merge, which is the only way to notice a source silently going quiet.
 */
export function mergeForecastLevels({
  keyLevels, orderBlocks, supportResistance, candles,
  price, atr, pip, limit = 24, options = {},
} = {}) {
  const o = { ...LEVEL_DEFAULTS, ...options };
  const p = n(price), a = n(atr);
  const liquidity = arr(keyLevels);
  const obs = orderBlockLevels(orderBlocks, { price: p, atr: a, pip, options: o });
  const zones = zoneLevels(supportResistance, { price: p, atr: a, pip, options: o });
  const retests = retestLevels(candles, { price: p, atr: a, pip, options: o });

  const merged = dedupeLevels([...liquidity, ...obs, ...zones, ...retests], { atr: a, options: o });
  const levels = interleaveBySource(merged, { limit });
  const tally = (list) => list.reduce((acc, l) => {
    const g = sourceGroup(l.type);
    acc[g] = (acc[g] || 0) + 1;
    return acc;
  }, {});
  return {
    levels,
    counts: {
      raw: { LIQUIDITY: liquidity.length, ORDER_BLOCK: obs.length, ZONE: zones.length, RETEST: retests.length },
      merged: tally(merged),
      kept: tally(levels),
      collapsed: merged.filter((l) => l.confluence > 1).length,
    },
  };
}
