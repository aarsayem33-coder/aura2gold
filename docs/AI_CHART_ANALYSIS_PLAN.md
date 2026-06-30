# Plan — AI Chart Image Analysis ("Upload a chart → get a trade")

Status: PROPOSED (for Claude to execute). Owner-approved scope; iterate as noted.
Read `AGENTS.md` + `docs/ARCHITECTURE.md` first. This feature is **additive and isolated** —
it must never change live `aggregateSignals` / `fttEngine` scoring (quality-not-quantity rule).

---

## 1. Goal (what the user asked for)

Inside **AI Analysis**, a user uploads a **chart screenshot**. The system:
1. Detects **candles, swing structure, support/resistance, and breakouts** from the image.
2. Gives the **best trade direction**, and can use the existing **strategies** for the decision.
3. **Forex output:** entry, SL, TP1/2/3, **volume (lots)**, R:R.
4. **Fixed-Time (FTT) output:** direction + **suitable timeframe/expiry**, an estimate of **how
   many candles price stays in the up/down direction**, and an **exact conditional time trigger**
   — e.g. *"At 6:30 PM you may trade if price is below/above X; otherwise ignore."*
5. **Breakout detection** surfaced explicitly.
6. **If Gemini is unable → fall back to deterministic system analysis** (clearly labelled).

---

## 2. Key facts that shape the design (verified in code)

- `geminiEngine.js → geminiGenerateContent({ contents, generationConfig })` already accepts the
  multimodal `parts` shape for BOTH auth modes (API-key + Vertex ADC). `gemini-2.5-flash` is
  multimodal → we add an image part `{ inlineData: { mimeType, data: <base64> } }`. **No new SDK.**
- `server.js` body limit is **50 MB** (`express.json`), so the image rides in as base64 JSON —
  **no multer / multipart needed.** (Client compresses to keep payloads small.)
- Reusable deterministic detectors already exist and are exported:
  - `signalEngine.js`: `aggregateSignals`, `detectMarketStructure`, `detectSupportResistance`,
    `detectLiquiditySweeps`.
  - `liquidityEngine.js`: `fractalSwings`, `atr14`, `detectDisplacement`, `detectBreaker`,
    `buildLiquidityPlan`, `detectLiquidityPools`.
  - `breakoutEngine.js`: `assessChartQuality`, `detectApproach`, `detectConfirmedBreakout`,
    `buildBreakoutCandidate`, `breakoutFollowThrough`.
  - `fttEngine.js`: `generateFttPrediction` + `getFttTimeframeMapping` (expiry/timeframe ladder).
  - `strategyLab.js`: `evaluateStrategy` + registry; `strategyLabSizing` (risk-based lots).
  - `executionForecastEngine.js`: ETA/"when executable" logic → seeds the conditional time trigger.
- Honesty guards to reuse from `geminiEngine.js`: `TRADER_DOCTRINE`, `enforceHonesty`,
  `capConfidence`, `calculateSuggestedLotSize`. (No "guaranteed win" language — hard rule.)
- The frontend page **`AIAnalysis.tsx`** already exists (currently only shows decision history) —
  this is where the upload panel goes.

### The hard constraint that drives everything
The deterministic engines analyse **candle arrays**, not images. So the **fallback cannot read the
uploaded picture.** Therefore the request **must carry a `symbol` + `timeframe`** (user-selected,
optionally pre-filled by a Gemini auto-detect of the chart's title). On fallback we analyse the
**live `symbol|timeframe` data** and say so plainly. This also makes the *primary* path far stronger:
we feed the live math into the vision prompt so Gemini **reconciles the image against real numbers**
instead of hallucinating prices (same "math first, then judgement" doctrine the other prompts use).

---

## 3. Architecture (one new endpoint, one new engine fn, one new pure helper, UI panel)

```
AIAnalysis.tsx (upload + preview + symbol/TF + mode)
      │  POST /api/ai/analyze-chart  { imageBase64, mimeType, symbol, timeframe, tradeMode, note }
      ▼
server.js  /api/ai/analyze-chart
      ├── build deterministic GROUND TRUTH for symbol|tf (live candles):
      │     aggregateSignals → systemDecision (entry/SL/TP), detectSupportResistance,
      │     fractalSwings, buildBreakoutCandidate, buildLiquidityPlan,
      │     generateFttPrediction, estimateDirectionalPersistence (NEW), evaluateStrategy(enabled)
      ├── PRIMARY: analyzeChartImageWithGemini(image + groundTruth)   ← geminiEngine.js (NEW)
      │     returns vision detection + forex/ftt plans, reconciled with the math
      └── FALLBACK (Gemini unconfigured / error / parse fail):
            buildSystemChartAnalysis(groundTruth)   ← pure assembly from the engines above
      ▼
unified JSON { source, detection, forexPlan, fttPlan, breakout, strategies, timeTrigger, honesty }
```

---

## 4. Backend work

### 4.1 New pure helper — directional persistence + conditional time trigger
File: `backend/chartAnalysis.js` (NEW, pure, unit-tested — mirrors breakoutEngine isolation).
- `estimateDirectionalPersistence(candles, direction)` → from history, the **median/avg run-length
  of consecutive same-direction closes** + ATR, returns `{ expectedCandles, p25, p75, basis }`.
  This answers *"how many candles it stays up/down"* deterministically and honestly (a range, not a
  promise).
- `buildConditionalTimeTrigger({ candles, timeframe, level, direction })` → reuses the
  execution-forecast idea: next candle-close time (or next session open) as the **"at HH:MM"** moment,
  and the **breakout/level price** (from `detectSupportResistance` / breakout candidate) as the
  **"if price above/below X"** condition. Output: `{ atIso, atLabelBdt, condition: 'ABOVE'|'BELOW',
  level, elseAction: 'IGNORE' }`. Times in BDT (`APP_TIME_ZONE`).
- `assembleForexPlan(...)` / `assembleFttPlan(...)` thin assemblers that normalise engine output into
  the response shape (entry/SL/TP/lots/RR ; direction/expiry/persistence/trigger).
- Tests: `backend/chartAnalysis.test.mjs` (run-length math, trigger formatting, empty-data guards).

### 4.2 New Gemini fn — `analyzeChartImageWithGemini(...)` in `geminiEngine.js`
- Signature: `{ projectId, location, model, imageBase64, mimeType, symbol, timeframe, tradeMode,
  groundTruth }`.
- `contents: [{ role:'user', parts: [ { text: prompt }, { inlineData: { mimeType, data: imageBase64 } } ] }]`.
- Prompt = `TRADER_DOCTRINE` + a **chart-reading task**: "Detect candles, swing points (HH/HL/LH/LL),
  support/resistance zones, chart patterns, and any breakout (PRE vs CONFIRMED). Then reconcile with
  the DETERMINISTIC GROUND TRUTH below (live `symbol|tf`) — prefer the live numeric levels for any
  price you output; mark image-only readings as approximate." Inject `groundTruth` JSON
  (systemDecision summary, S/R, swings, breakout candidate, FTT prediction, persistence estimate).
- Returns STRICT JSON: `detection{trend, structure[], srZones[], patterns[], breakout{phase,grade,
  level}}`, `forexPlan{decision, entry, stopLoss, tp1..3, riskReward, lots, riskLevel}`,
  `fttPlan{direction, expiry, timeframe, expectedCandlesInDirection, timeTrigger{...}, confidence}`,
  `verdict, confidence, reasoning, keyFactors`.
- Reuse `enforceHonesty` + `capConfidence` on all text/confidence. Recompute `lots` server-side with
  `calculateSuggestedLotSize`/`strategyLabSizing` from live equity (never trust the model's lot).
- **Fallback inside the fn**: on `!isGeminiConfigured` / fetch error / non-OK / parse fail → return
  `{ available:false }` so the route falls through to the deterministic assembler (same pattern as
  `analyzeProjectionWithGemini`). Also keep the existing **pro→flash** auto-retry.

### 4.3 New route — `POST /api/ai/analyze-chart` in `server.js`
- Parse `{ imageBase64, mimeType, symbol, timeframe, tradeMode='BOTH', note }` via `parseMt5Body`.
- Resolve broker symbol case-insensitively (Trap #2). Pull live candles for `timeframe` (+ HTF/LTF
  for the MTF ladder, like `/api/ai-signals/analyze`). If no/stale candles → 400 with a clear message
  (and still allow vision-only? No — we need the symbol live for grounding; tell the user to pick a
  streamed symbol).
- Build `groundTruth` once (shared by primary + fallback).
- Try `analyzeChartImageWithGemini`; if `available:false` → `buildSystemChartAnalysis(groundTruth)`.
- Tag `source: 'gemini-vision' | 'system-fallback'` and an honest `note` on the fallback
  (*"AI vision unavailable — analysed live SYMBOL TF data, not your uploaded image."*).
- **Do NOT persist the image** (Trap #6 bloat). Optionally log the compact structured decision to
  `mt5_ai_decisions` for the existing history list (display-only) — gated, no blobs.
- Honour `tradeMode`: `FOREX` → forexPlan only; `FTT` → fttPlan only; `BOTH` → both.

### 4.4 Breakout detection
Already covered: `buildBreakoutCandidate` + `breakoutFollowThrough` feed `groundTruth.breakout` and the
vision prompt; Gemini also reports a visual breakout read, reconciled against the deterministic one.

---

## 5. Frontend work — extend `AIAnalysis.tsx`

- New **"Analyze a Chart Image"** card at the top:
  - File input + drag/drop + paste; client-side **downscale/compress** (canvas → JPEG ~0.8, max
    ~1600px) to keep base64 < ~3 MB; show preview thumbnail.
  - **Symbol** dropdown (streamed symbols from status) + **Timeframe** dropdown — **required**.
    Helper text: "Used to ground the AI and to power the system fallback."
  - **Mode** toggle: Forex / Fixed-Time / Both (default Both).
  - "Analyze" → `POST /api/ai/analyze-chart`; loading state; error banner.
- **Result panel** (reuse card styling / `DecisionCard` where possible):
  - **Source badge**: "AI Vision (Gemini)" green vs "System Fallback (deterministic)" amber + the note.
  - **Detection summary**: trend, swing structure, S/R zones, patterns, breakout phase+grade.
  - **Forex ticket**: direction, entry / SL / TP1–3, **lots**, R:R, risk level, invalidation.
  - **FTT ticket**: direction, expiry + suitable timeframe, **expected candles in direction (range)**,
    and the **conditional time trigger** rendered prominently:
    *"⏰ At 6:30 PM BDT — trade DOWN only if price < 1.0820, else ignore."*
  - Honesty footer: "Estimates, not guarantees" + confidence band.
- Add `fetchChartAnalysis(...)` to `frontend/mt5Api.ts` and types to `frontend/types.ts`.
- Build check: `npm run build --prefix frontend` (no `tsc` step — esbuild only).

---

## 6. Honesty, safety, and isolation guardrails
- Reuse `TRADER_DOCTRINE`/`enforceHonesty`/`capConfidence`; confidence ≤ 95; "NO TRADE/WAIT" is valid.
- Vision-read prices are **approximate** → always prefer live numeric levels and label image-only
  values. Recompute lots server-side from live equity.
- **Never** blend into live signals/scoring. New code is isolated (own engine fn + route + page panel).
- "How many candles" + "exact time" are **honest estimates** (ranges + named basis), never promises.
- One on-demand Gemini call per upload (cost-bounded, user-initiated — same as existing AI buttons).

---

## 7. Build & verify (per AGENTS golden rules)
1. `node --check backend/server.js`; nodemon restarts. Hit `/api/ai/analyze-chart` with a sample image
   (a) with Gemini configured (vision) and (b) with Gemini forced off (fallback) — confirm `source`.
2. `node backend/chartAnalysis.test.mjs` (pure unit tests pass).
3. `npm run build --prefix frontend`; dogfood the upload on a real chart screenshot.
4. Verify fallback path returns a complete forex+FTT ticket from live data when ADC/key is absent
   (AGENTS Trap #10 — silent fallback is expected behaviour).

---

## 8. Phasing (executable order)
- **P1 — Backend core:** ✅ DONE (2026-06-26). `backend/chartAnalysis.js` (pure, 13/13 tests in
  `chartAnalysis.test.mjs`), `analyzeChartImageWithGemini` in `geminiEngine.js` (vision + graceful
  `{available:false}`), `POST /api/ai/analyze-chart` (builds live ground truth, tries vision, falls
  back to `buildSystemChartAnalysis`). Verified live: both `gemini-vision` and `system-fallback`
  paths return complete shapes; time-trigger uses live levels; lots recomputed server-side. **Isolated
  + read-only** — no signal writes, no scoring/scanner changes.
- **P2 — Frontend:** ✅ DONE (2026-06-26). Upload panel (drop/paste/click + client-side
  downscale/JPEG compress), required symbol+TF selectors, Forex/FTT/Both toggle, and result tickets
  (source badge, detection, forex entry/SL/TP/lots, FTT direction + expected-candles + prominent
  conditional time-trigger, breakout, strategies, reasoning, honesty) in `AIAnalysis.tsx`.
  `fetchChartAnalysis` + `ChartAnalysisResponse` added. `npm run build --prefix frontend` passes.
- **P3 — Polish:** conditional-time-trigger copy, breakout badges, optional compact history logging,
  README/ARCHITECTURE note.

## 9. Open decisions (defaults chosen; confirm if you disagree)
1. **Symbol/TF = required user input** (Gemini may pre-fill via auto-detect, user confirms). Needed for
   the deterministic fallback. ← default.
2. **Default mode = Both** (forex + FTT tickets). ← default.
3. **Do not store uploaded images** (privacy + Trap #6 bloat); store only the compact structured result
   if history is wanted. ← default.
4. **Fallback analyses live `symbol|tf`, not the image** — surfaced honestly. ← **CONFIRMED by owner
   (2026-06-26).** The deterministic engines read candle numbers, not pixels; only a vision model can
   "see" the image. No second vision provider and no CV/OCR digitizer — when Gemini is down we analyse
   the live symbol+timeframe and label it plainly. This is *why* `symbol`+`timeframe` are required.

## 10. Risks / mitigations
- *Vision misreads price* → grounded by live math + labelled approximate + server-recomputed lots.
- *User uploads a symbol we don't stream* → 400 with guidance (grounding/fallback need live data).
- *Large image payloads* → client compress; 50 MB server limit is ample.
- *Gemini quota/down* → deterministic fallback returns a full ticket (the whole point of P1).
- *Scope creep into live signals* → strictly isolated; no change to `aggregateSignals`/`fttEngine`.
```
