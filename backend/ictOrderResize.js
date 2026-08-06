/**
 * Resize a resting ICT limit order from MONEY rather than from prices.
 *
 * The user thinks in dollars — "risk $50, target $150" — while MT5 needs price levels and a lot
 * size. This converts between the two and then judges the result, because the conversion always
 * succeeds arithmetically even when the resulting ticket is a bad idea.
 *
 * WHY THE JUDGEMENT MATTERS MORE THAN THE ARITHMETIC
 * Money and stop distance trade off against each other: for a fixed dollar risk, doubling the
 * lot size halves the stop. That is exactly how this account ended up with 5-lot positions on
 * 1.7-pip stops — the dollar risk was correct ($85, precisely 0.85% of a $10,000 balance) while
 * the position was 65x the account in notional and the stop sat inside the spread.
 *
 * Measured on this account's own history:
 *   - stops under 5 pips returned -0.496R over 38 trades and cost -$846
 *   - the only profitable band was 20-50 pips, at 0.16 lots average
 *   - 1.4 pips of round-trip friction is 28% of a 5-pip stop and 3% of a 40-pip one
 * So a tight stop does not reduce risk; it converts the risk budget into slippage. Every warning
 * below is grounded in that measurement rather than in a rule of thumb.
 *
 * Pure: numbers in, ticket and verdict out. No I/O, no clock, no broker calls.
 */

const n = (v) => Number(v);
// Number(null) is 0 and 0 is finite — the coercion behind seven separate defects in this
// codebase. Every optional number goes through this rather than a bare isFinite.
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(n(v)) ? null : n(v));
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/** Thresholds, all derived from this account's measured history — see the header. */
export const RESIZE_LIMITS = {
  minStopPips: 5,          // below this the measured expectancy is -0.496R
  healthyStopPips: 20,     // the band that actually made money
  minRr: 1.5,
  maxNotionalMultiple: 20, // position size vs account equity
  frictionPips: 1.4,       // measured round-trip entry+exit slippage
};

/** Pips of distance that a given dollar amount buys at this lot size. */
export function moneyToPips({ usd, lots, pipValuePerLot }) {
  const u = num(usd), l = num(lots), pv = num(pipValuePerLot);
  if (u === null || l === null || pv === null || l <= 0 || pv <= 0 || u <= 0) return null;
  return u / (l * pv);
}

/** Dollars that a given pip distance is worth at this lot size. */
export function pipsToMoney({ pips, lots, pipValuePerLot }) {
  const p = num(pips), l = num(lots), pv = num(pipValuePerLot);
  if (p === null || l === null || pv === null) return null;
  return r2(p * l * pv);
}

/** Lot size that puts exactly `usd` at risk over `pips`, rounded DOWN to the broker's step. */
export function lotsForMoney({ usd, pips, pipValuePerLot, volStep = 0.01, volMin = 0.01, volMax = null }) {
  const u = num(usd), p = num(pips), pv = num(pipValuePerLot);
  if (u === null || p === null || pv === null || p <= 0 || pv <= 0) return null;
  const step = num(volStep) ?? 0.01;
  const raw = u / (p * pv);
  // Rounded DOWN: rounding up would quietly exceed the budget the user just typed.
  let lots = Math.floor(raw / step) * step;
  lots = Math.round(lots * 1000) / 1000;
  const min = num(volMin) ?? 0.01;
  const max = num(volMax);
  if (lots < min) lots = min;
  if (max !== null && lots > max) lots = max;
  return Math.round(lots * 100) / 100;
}

/**
 * The price that sits `pips` away from entry, on the correct side.
 *
 * `side` is 'stop' or 'target'; direction decides which way each of those lies. Getting this
 * backwards produces a ticket MT5 rejects as 10016, which is 29 of this account's rejections.
 */
export function priceAt({ entry, direction, pips, pipSize, side, digits = null }) {
  const e = num(entry), p = num(pips), ps = num(pipSize);
  if (e === null || p === null || ps === null || ps <= 0) return null;
  const buy = String(direction || '').toUpperCase() === 'BUY';
  const away = side === 'stop' ? -1 : 1;         // stops sit against the trade, targets with it
  const price = e + (buy ? away : -away) * p * ps;
  const d = num(digits);
  return d !== null && d > 0 ? Math.round(price * 10 ** d) / 10 ** d : price;
}

/**
 * Build the full ticket from a lot size and the dollar amounts the user wants.
 *
 * Targets are optional and independent: a user may want only a stop set, and forcing a target
 * they did not ask for is how TP1 ends up behind the market.
 */
export function resizeOrder({
  entry, direction, lots, slUsd, tpUsd, tp2Usd = null, tp3Usd = null,
  pipValuePerLot, pipSize, digits = null,
}) {
  const e = num(entry), l = num(lots);
  if (e === null || l === null || l <= 0) {
    return { ok: false, error: 'a positive entry price and lot size are required' };
  }
  const pv = num(pipValuePerLot), ps = num(pipSize);
  if (pv === null || ps === null || pv <= 0 || ps <= 0) {
    return { ok: false, error: 'this symbol has no usable pip value — cannot convert money to price' };
  }

  const stopPips = moneyToPips({ usd: slUsd, lots: l, pipValuePerLot: pv });
  if (stopPips === null) return { ok: false, error: 'a positive stop-loss amount in USD is required' };

  const tpPipsFor = (usd) => moneyToPips({ usd, lots: l, pipValuePerLot: pv });
  const t1 = tpPipsFor(tpUsd), t2 = tpPipsFor(tp2Usd), t3 = tpPipsFor(tp3Usd);

  return {
    ok: true,
    lots: l,
    stopLoss: priceAt({ entry: e, direction, pips: stopPips, pipSize: ps, side: 'stop', digits }),
    takeProfit1: t1 === null ? null : priceAt({ entry: e, direction, pips: t1, pipSize: ps, side: 'target', digits }),
    takeProfit2: t2 === null ? null : priceAt({ entry: e, direction, pips: t2, pipSize: ps, side: 'target', digits }),
    takeProfit3: t3 === null ? null : priceAt({ entry: e, direction, pips: t3, pipSize: ps, side: 'target', digits }),
    stopPips: r2(stopPips),
    tp1Pips: t1 === null ? null : r2(t1),
    tp3Pips: t3 === null ? null : r2(t3),
    riskUsd: r2(num(slUsd)),
    rewardUsd: r2(num(tp3Usd) ?? num(tpUsd)),
    // Measured against the FINAL target, not TP1: TP1 is ~1R by construction on most ladders,
    // so computing R:R from it stamps "1" on every ticket regardless of the real draw.
    rr: (() => {
      const risk = num(slUsd);
      const reward = num(tp3Usd) ?? num(tpUsd);
      return risk && reward && risk > 0 ? Math.round((reward / risk) * 100) / 100 : null;
    })(),
  };
}

/**
 * Judge a resized ticket and say plainly whether it is a good idea.
 *
 * Errors are things the broker or the risk rules will refuse. Warnings are things this account
 * has already lost money on. The verdict leads with the worst of the two, because a ticket that
 * is arithmetically valid and historically -0.496R is not "fine".
 */
export function validateResize({
  ticket, symbol, riskBudget = null, accountEquity = null,
  minStopDistance = null, pipSize = null, spreadPips = null, atrPips = null,
  volMin = 0.01, volMax = null, volStep = 0.01, contractSize = 100000, entryPrice = null,
}) {
  const errors = [];
  const warnings = [];
  const notes = [];
  if (!ticket || !ticket.ok) return { verdict: 'INVALID', errors: ['the ticket could not be built'], warnings, notes };

  const { lots, stopPips, rr, riskUsd, stopLoss } = ticket;

  // ── things that will be refused ──────────────────────────────────────────
  const min = num(volMin) ?? 0.01, max = num(volMax), step = num(volStep) ?? 0.01;
  if (lots < min) errors.push(`lot size ${lots} is below the broker minimum of ${min}`);
  if (max !== null && lots > max) errors.push(`lot size ${lots} is above the broker maximum of ${max}`);
  const stepsOff = Math.abs(lots / step - Math.round(lots / step));
  if (stepsOff > 1e-6) errors.push(`lot size ${lots} is not a multiple of the broker step ${step}`);

  const ps = num(pipSize), msd = num(minStopDistance);
  if (msd !== null && ps !== null && stopPips !== null && stopPips * ps < msd) {
    errors.push(`the stop is ${(stopPips * ps).toFixed(5)} from entry, inside the broker minimum of ${msd} — MT5 would reject this order`);
  }

  // Budget overage is ADVISORY on a manual ticket, not a refusal.
  //
  // Everything in `errors` above is something the broker itself will reject, so blocking there
  // saves a round trip to a guaranteed failure. Exceeding your own risk budget is a different
  // kind of statement: it is a judgement about the trade, and the user has said explicitly that
  // they will read the market themselves and want their numbers passed through. So it is
  // reported prominently and left as their decision.
  const budget = num(riskBudget);
  let overBudget = false;
  if (budget !== null && riskUsd !== null && riskUsd > budget + 0.005) {
    overBudget = true;
    warnings.push(`risking $${riskUsd} is above your $${budget} per-trade budget (${(riskUsd / budget).toFixed(1)}x)`);
  }

  // ── things this account has already lost money on ────────────────────────
  if (stopPips !== null && stopPips < RESIZE_LIMITS.minStopPips) {
    warnings.push(
      `a ${stopPips}-pip stop is inside market noise — stops under ${RESIZE_LIMITS.minStopPips} pips `
      + 'returned -0.496R over 38 trades on this account and cost -$846. Lower the lot size to widen it.',
    );
  } else if (stopPips !== null && stopPips < RESIZE_LIMITS.healthyStopPips) {
    notes.push(`a ${stopPips}-pip stop is workable, but the band that actually made money on this account was ${RESIZE_LIMITS.healthyStopPips}-50 pips`);
  }

  // Friction is a fixed pip cost, so it eats a share of risk inversely proportional to the stop.
  if (stopPips !== null && stopPips > 0) {
    const bite = RESIZE_LIMITS.frictionPips / stopPips;
    if (bite > 0.15) {
      warnings.push(`slippage and spread (~${RESIZE_LIMITS.frictionPips} pips measured) would eat ${(bite * 100).toFixed(0)}% of this risk before the market moves`);
    }
  }

  const sp = num(spreadPips);
  if (sp !== null && sp > 0 && stopPips !== null && stopPips < sp * 3) {
    warnings.push(`the stop is only ${(stopPips / sp).toFixed(1)}x the current spread — the spread alone can take it out`);
  }
  const atr = num(atrPips);
  if (atr !== null && atr > 0 && stopPips !== null && stopPips < atr * 0.5) {
    warnings.push(`the stop is ${(stopPips / atr).toFixed(2)}x ATR — normal movement on this pair is wider than your stop`);
  }

  if (rr !== null && rr < RESIZE_LIMITS.minRr) {
    warnings.push(`reward-to-risk is ${rr}:1 — below ${RESIZE_LIMITS.minRr}, the win rate needed to profit becomes unrealistic`);
  }

  // Notional exposure. The dollar risk can be perfectly within budget while the POSITION is many
  // multiples of the account — which is what margin, not risk, is measured against.
  const eq = num(accountEquity), px = num(entryPrice), cs = num(contractSize) ?? 100000;
  if (eq !== null && px !== null && eq > 0 && lots > 0) {
    const notional = lots * cs * (/JPY$/i.test(String(symbol || '')) ? 1 : px);
    const multiple = notional / eq;
    if (multiple > RESIZE_LIMITS.maxNotionalMultiple) {
      warnings.push(`this is ~$${Math.round(notional).toLocaleString()} of ${symbol} — ${multiple.toFixed(0)}x your $${Math.round(eq).toLocaleString()} account. Your risk is capped, but the margin required is not.`);
    }
    notes.push(`position size ~$${Math.round(notional).toLocaleString()} notional (${multiple.toFixed(1)}x account)`);
  }

  // REJECT means the BROKER will refuse it — nothing else blocks a manual ticket.
  const verdict = errors.length ? 'REJECT' : warnings.length ? 'RISKY' : 'OK';
  return { verdict, errors, warnings, notes, overBudget };
}

/**
 * The suggestion engine: what lot size WOULD make this ticket sound?
 *
 * Offered whenever the user's own numbers trip a warning, so the answer to "is my lot size
 * perfect?" is a number rather than a lecture.
 */
export function suggestSizing({
  riskUsd, pipValuePerLot, atrPips = null, spreadPips = null,
  currentStopPips = null,
  volStep = 0.01, volMin = 0.01, volMax = null,
}) {
  const pv = num(pipValuePerLot), risk = num(riskUsd);
  if (pv === null || risk === null || pv <= 0 || risk <= 0) return null;

  // Target the widest of: the measured healthy floor, half ATR, and three spreads.
  const atr = num(atrPips), sp = num(spreadPips);
  const candidates = [RESIZE_LIMITS.minStopPips];
  if (atr !== null && atr > 0) candidates.push(atr * 0.5);
  if (sp !== null && sp > 0) candidates.push(sp * 3);
  const targetStop = Math.max(...candidates);

  // Never advise TIGHTENING a stop. The suggestion exists to rescue a ticket whose stop sits in
  // the noise; telling a user with a healthy 60-pip stop to cut it to 6 would be the opposite of
  // the finding it is built on, and would push them toward the -0.496R band on purpose.
  const cur = num(currentStopPips);
  if (cur !== null && cur >= targetStop) return null;

  return {
    suggestedStopPips: r2(targetStop),
    suggestedLots: lotsForMoney({ usd: risk, pips: targetStop, pipValuePerLot: pv, volStep, volMin, volMax }),
    why: atr !== null && atr > 0
      ? `half of this pair's ATR (${r2(atr)} pips), the width normal movement respects`
      : `the ${RESIZE_LIMITS.minStopPips}-pip floor below which this account measured -0.496R`,
  };
}
