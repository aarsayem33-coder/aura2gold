# Plan — "3-Candle Safety Check" Strategy (new Strategy Lab engine)

Status: PROPOSED (for Claude to execute). Read `AGENTS.md` + memory `strategy-lab` first.
**Additive + isolated:** one new engine module + one `STRATEGIES` registry entry. It never blends
into live `aggregateSignals`/`fttEngine`, never touches `ict-breaker` (the live winner), and does not
reduce existing signal count (quality-not-quantity) — it simply adds another ranked strategy to the lab.

---

## 1. The strategy, distilled (from the transcript)

Don't trade single candles ("context blindness"). Trade a **3-candle SEQUENCE** that tells a story,
then pass it through **5 context filters**.

**The 3-candle safety check (ordered, on the last 3 CLOSED candles):**
- **Step 1 — Exhaustion** (candle `c2`): trend running out of steam.
  - Uptrend top → **shooting star** (tiny body near low, long upper wick = rejection).
  - Downtrend bottom → **hammer** (tiny body near top, long lower wick).
  - **Spinning top** (small body, long wicks both sides) = weaker exhaustion, either side.
  - Longer rejection wick = stronger.
- **Step 2 — Indecision** (candle `c1`): stalemate after exhaustion.
  - **Doji** (open≈close), or **inside bar** (fully inside `c2`'s range), or a **small-bodied** candle.
- **Step 3 — Confirmation / breakthrough** (candle `c0`): one side takes control.
  - **Large-bodied** candle in the new direction (opens near one extreme, closes near the other,
    small opposing wick), or **engulfing** (`c0` body covers `c1` body), or a **gap** in the new
    direction. Per the transcript it **"takes out the previous two candles"** — so `c0` must close
    **beyond the extreme of BOTH `c1` AND `c2`** (past both lows for SELL / both highs for BUY), not
    just the indecision candle. That stronger breakthrough is the real execution trigger.

**Two scenarios:**
- **Reversal** — exhaustion at a swing extreme/level → indecision → opposite confirmation. (Shooting
  star at a high → indecision → bearish engulfing → **SELL**; mirror for BUY at lows.)
- **Continuation** — established trend pulls back **on decreasing volume**, the pullback exhausts at
  support/resistance (hammer in an uptrend) → indecision → big candle resumes the trend on **expanding
  volume** → trade **WITH** the trend (join smart money).

**5 context filters (eliminate ~80% of false signals):**
1. **Market structure** — reversal in a strong trend is often just a pause; reversals belong in/near
   ranges or HTF turning points. Trend needed for continuations.
2. **Level significance** — combo must sit at a meaningful S/R / liquidity level, not a random level.
3. **Momentum / HTF alignment** — trade with the higher-timeframe momentum, never against it.
4. **Session timing** — London / NY combos = real participation; Asian-session combos = noise.
5. **Volume confirmation** — reversals on **increasing** volume into confirmation; continuations show
   **decreasing** pullback volume then **explosive** confirmation volume.

---

## 2. Why this is a NEW engine (not a duplicate)

- `swing-structure-candles` fires on a **single** candlestick trigger at swing structure; it does NOT
  require the ordered **exhaustion→indecision→confirmation** triplet. This engine's edge is the
  *sequence* + the *5 filters* (esp. volume + session, which swing-structure does not use).
- `market-mechanics-3step` is Direction/Location/Execution — a different "3-step", not a 3-candle combo.
- So `three-candle-combo` is genuinely distinct and worth ranking on its own.

---

## 3. What already exists (reuse — don't rebuild)

| Need | Reuse (in `backend/`) |
|---|---|
| Shooting star / hammer / doji / engulfing / star detection | `detectCandlePatterns(candles)` — `strategyLab.js:753` (reads the LAST candle) |
| Candle geometry (body/wick/range) | `candleParts(c)` — `strategyLab.js:748` (export it) |
| Inside bar | already computed in the contraction helper (`strategyLab.js:836`) — extract a tiny `isInsideBar(a,b)` |
| Swings / trend skeleton | `fractalSwings(candles)`, `atr14` — `liquidityEngine.js` |
| Level significance | `detectLiquidityPools(candles)` (already imported) + nearest swing S/R |
| HTF momentum | `ctx.h4Trend`, `ctx.h1Trend` (already passed into every engine) + `stageHtfAgreement` pattern |
| Grade from score | the lab's `gradeFromScore` mapping (shared) |
| Forex sizing / FTT scoring / per-TF ranking | the lab harness already scores every engine two ways across all TFs — **free** once registered |

**Reading a pattern at a specific offset** (the elegant trick): call `detectCandlePatterns` on a
**slice** so the target candle is last —
`detectCandlePatterns(closed.slice(0, -2))` ⇒ exhaustion `c2`; `detectCandlePatterns(closed)` ⇒
confirmation `c0`. (`closed` = candles with any still-forming last bar dropped.)

---

## 4. New engine — `threeCandleCombo(ctx)` in `strategyLab.js`

`ctx = { symbol, timeframe, candles, pip, h4Trend, h1Trend, htfCandles, config }` (standard).

**Pipeline (returns a signal or `null`):**
1. `closed` = drop a forming last bar. Need ≥ ~30 bars. Let `c2,c1,c0` = last three closed.
2. **Step 1 (exhaustion)** on `c2`: shooting-star/hammer/spinning-top via `detectCandlePatterns(closed.slice(0,-2))` + wick-strength (wick/ATR). Determine candidate direction (star→SELL, hammer→BUY; spinning top → infer from context).
3. **Step 2 (indecision)** on `c1`: `doji || isInsideBar(c1,c2) || smallBody(c1)`. Else → `null`.
4. **Step 3 (confirmation)** on `c0`: strong-body/engulfing/gap in the candidate direction AND `c0` closes beyond the extreme of **both `c1` and `c2`** ("takes out the previous two candles"). Else → `null`.
5. **Classify** `kind`: REVERSAL (exhaustion against local trend at extreme) vs CONTINUATION (pullback-exhaustion within an HTF-aligned trend).
6. **Apply the 5 filters** (gates + scoring):
   - F3 HTF alignment — **hard gate**: REVERSAL must not fight HTF (`SELL` needs `h4Trend!=='BULLISH'`); CONTINUATION must be HTF-aligned. (mirrors every other engine's discipline.)
   - F1 structure — REVERSAL favoured near range/turning point; CONTINUATION needs a real trend (`fractalSwings`). Reject obvious chop.
   - F2 level — bonus when `c2`'s extreme sits at a liquidity pool / swing level; skip "random level" reversals when `config.requireLevel`.
   - F4 session — bonus for London/NY, penalty (or skip if `config.sessionFilter`) for Asian — small pure `sessionQuality(c0.time)` helper (UTC-hour → session).
   - F5 volume — pure `volumePattern(closed, kind)`: reversal ⇒ confirmation vol > avg; continuation ⇒ pullback vol decreasing + confirmation vol expanding. Bonus/penalty; skip if `config.volumeFilter` and clearly wrong.
7. **Score** = base (valid triplet) + wick-strength + confirmation-body + engulfing/gap + each filter bonus; **grade** via `gradeFromScore`. Over-extension / climax guard (reject parabolic confirmation).
8. **Levels:** entry = `c0.close` (or the `c1` breakout level); SL = beyond `c2`'s extreme (+ ATR buffer); TP1/TP2 = 1R/2R; TP3 = opposing liquidity pool / swing / measured move. `minRR` gate (default 1.8).
9. **Return** `{ decision, score, grade, entry, stopLoss, takeProfit1..3, riskRewardRatio, reason, meta:{ kind, exhaustion, indecision, confirmation, filters:{structure,level,session,volume,htf} } }`.
   - Reason example: *"Reversal SELL: shooting-star exhaustion at BSL pool → inside-bar indecision → bearish engulfing breakdown · NY session · vol+ · H4 aligned (2.1R)."*

**Registry entry** (one object in `STRATEGIES`):
```js
'three-candle-combo': {
  id: 'three-candle-combo',
  name: '3-Candle Safety Check',
  source: 'Exhaustion → Indecision → Confirmation sequence + 5 context filters',
  description: '<the summary above>',
  timeframes: ['M5','M15','M30','H1','H4'],
  config: { minRR: 1.8, requireLevel: true, sessionFilter: false, volumeFilter: true, maxAgeBars: 2 },
  evaluate: threeCandleCombo,
}
```
(`sessionFilter` default off so 24/5 gold isn't over-pruned; it stays a scoring bonus. Tunable later.)

---

## 5. Forex + Fixed-Time outputs (free from the harness)
- **Forex:** the engine returns entry/SL/TP1‑3/RR; the lab adds risk-based **lots** and logs the forex
  outcome (TP/SL replay) — same as every engine.
- **Fixed-Time:** the lab also scores the **next-candle** direction = the combo direction; the
  confirmation candle is an IMMEDIATE-execution call. Both win-rates accumulate per TF for ranking.

---

## 6. Tests — `backend/strategyLab.test.mjs` (extend) or `threeCandle.test.mjs`
Hand-crafted candle sequences:
- ✅ Reversal SELL (shooting star at high → inside bar → bearish engulfing, HTF not bullish, NY vol+).
- ✅ Reversal BUY (mirror).
- ✅ Continuation BUY (uptrend pullback on falling vol → hammer at support → small body → big green breakout on rising vol).
- ❌ No indecision (c1 is a big trend candle) → null.
- ❌ HTF opposes the reversal → null.
- ❌ Confirmation fails to break c1 range → null.
- ❌ Asian + thin volume continuation with `volumeFilter` → downgraded/null.
Pure, deterministic; run `node backend/strategyLab.test.mjs`.

---

## 7. Guardrails (your "don't hamper current signals" rule)
- **Isolated**: lives only in `strategyLab.js` + registry; the lab is deliberately separate from live
  signals (AGENTS.md). No change to `aggregateSignals`, `fttEngine`, `signalEngine`, or `ict-breaker`.
- **Additive**: adds a strategy to the lab's ranking; does not gate, suppress, or alter any existing
  signal → respects quality-not-quantity (memory `quality-not-quantity`).
- **Controllable**: appears in the Strategy Controller; can be muted like any other (memory
  `strategy-disable-semantics`) while still accumulating win-rate for comparison.

---

## 8. Phasing
- **P1 — Engine + registry:** ✅ DONE (2026-06-26). `threeCandleCombo` + `isInsideBar` /
  `sessionQuality` / `volumePattern` helpers + the `STRATEGIES['three-candle-combo']` entry in
  `strategyLab.js`. Registered as strategy #13, enabled, scanning M5–H4 across all symbols with no
  errors; the existing 12 engines are untouched.
- **P2 — Tests:** ✅ DONE. `backend/threeCandle.test.mjs` — 7/7 pass (reversal SELL, continuation BUY,
  + negatives: no-indecision, HTF-opposes gate, weak confirmation, volume filter, level filter).
- **P3 — Observe + tune:** let it scan, watch per-TF win-rate in Strategy Lab Reports; tune the filter
  weights / `sessionFilter` from real ranking (never crown a thin sample — the lab already gates on
  sample confidence).

## 9. Open questions (defaults chosen)
1. **Timeframes** = M5–H4 (transcript says "any timeframe"; the lab scores all TFs regardless). ← default.
2. **sessionFilter** = bonus-only (off) to avoid over-pruning 24/5 gold; **volumeFilter** = on. ← default.
3. **Default state** = enabled (rank it from day one); mute later if it underperforms. ← default.
```
