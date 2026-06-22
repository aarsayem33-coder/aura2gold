# AGENTS.md — Read This First

This file is the survival guide for any AI agent or developer working on **Aura Gold Alerts**.
It documents the non-obvious traps that have cost hours. Read the whole thing before touching
the MT5 Expert Advisor, the backend, or the database.

> Companion docs: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (how it fits together) and
> [`docs/RUNBOOK.md`](docs/RUNBOOK.md) (step-by-step operations).

---

## What this system is

A trading-signal dashboard for Forex + Gold (XAU). Data flows:

```
MT5 Terminal (Exness)                Node.js backend                 React frontend
┌──────────────────┐  HTTP POST   ┌──────────────────┐  SSE / REST  ┌──────────────┐
│ AuraGoldSignals  │ ───────────► │ server.js        │ ───────────► │ Vite app     │
│ .ex5 (MQL5 EA)   │  candles,    │ in-memory + SSE  │  live push   │ (port 5173)  │
│                  │  heartbeat,  │ + MySQL (async)  │              │              │
│                  │  snapshot    │ (port 5000)      │              │              │
└──────────────────┘              └──────────────────┘              └──────────────┘
                                          │
                                          ├─ signalEngine.js  (system signals, SMC scoring)
                                          ├─ fttEngine.js     (fixed-time-trade predictions; see FTT fixes note below)
                                          ├─ executionForecastEngine.js (WHEN a setup becomes executable)
                                          └─ geminiEngine.js  (Vertex AI / Gemini analysis)
```

The architecture is **memory-first**: incoming candles go into an in-memory store and are pushed
to the browser via SSE **instantly**; the MySQL write is fire-and-forget (`void persist().catch()`).
Analysis reads from memory, never blocks on the DB.

> **Outcome resolver — DO NOT expire wins (2026-06-21).** `processForexEmailReports` and
> `processSystemSignalLog` keep PENDING + young (<72h) TP1/TP2 wins "open" for possible TP upgrade.
> The age>72h branch must **only** expire rows whose outcome is still `PENDING` — never overwrite a
> recorded `TP1_WIN`/`TP2_WIN` to `EXPIRED` (that erased real wins and understated win rate by ~10pts;
> the emailed-only send calibration then suppressed good buckets). Wins ≥72h are excluded from the
> resolver query so they finalize as wins. A one-off `backend/backfill_expired_wins.mjs` already
> repaired historical corruption (relabel `EXPIRED AND profit_loss_pips>0` → win). Still-open audit
> items (inflated "settled", emailed-only calibration survivorship, forecast hitRate gating, bucket
> suppression, SL/TP outlier caps) are tracked in memory `calibration-outcome-bugs`.

> **FTT fixes (2026-06-21, from a read-only audit).** Two real bugs fixed in `fttEngine.js`:
> (1) **Directional confidence bias** — `qualityBonus` counted only bullish filters (`score>0/>=0.5`),
> handicapping valid DOWN setups by up to ~10 confidence pts. Now **direction-aligned** (`score*dirSign`),
> symmetric for UP/DOWN; UP is mathematically identical to before (longs undisturbed), only shorts change.
> (2) **Timeframe/timing mismatch** — the server feeds candles at `mapExpiryToTimeframe(expiry)` (5m→M5,
> 30m→M15, 1h→H1) but the engine computed candle-boundary timing against `tfConfig.entry` (e.g. M2),
> producing wrong `remainingSeconds`/immediate-vs-wait **and** mis-gating the noise filter (×0.80 damp +
> HOLD override). Fix: server now passes the actual `timeframe` into `generateFttPrediction`; the engine
> uses it for `entryTf` and reports it in `timeframeMapping.entry`. Candle data feeding `aggregateSignals`
> is **unchanged** (signal direction/confidence only shifts near candle boundaries where the old boundary
> math was wrong). Verified live across 5m/30m/1h. **Not done (design choice, needs validation):** whether
> to actually *feed* the engine's finer intended entry TFs (M2/M3) instead of the current coarser ones.

---

## ☠️ THE TOP TRAPS (each one cost real debugging time)

### 1. The EA that MT5 runs is NOT in the project folder
MT5 loads and runs the EA from its **own data folder**:
```
C:\Users\<USER>\AppData\Roaming\MetaQuotes\Terminal\<HASH>\MQL5\Experts\AuraGoldSignals.ex5
```
The copy in the repo (`./AuraGoldSignals.mq5`) is **ignored by MT5**. Compiling the repo copy
changes nothing about what runs. **Always edit and compile the EA inside MT5's `MQL5\Experts\`
folder.** After compiling, the user must **remove + re-drag** the EA on the chart to load the new
`.ex5` (MT5 caches the running instance).

Current terminal hash: `D0E8209F77C8CF37AD8BF550E51FF075`
(verify with: list `%APPDATA%\MetaQuotes\Terminal\*\MQL5\Experts\AuraGoldSignals.*`)

### 2. MT5 symbol names are CASE-SENSITIVE
The broker's real symbols use a lowercase suffix: **`XAUUSDm`**, `EURUSDm`, `GBPJPYm`.
The backend `normalizeCandle()` **uppercases** symbols (`XAUUSDM`) for storage, and the frontend
requests uppercase. If the EA calls `CopyRates("XAUUSDM", ...)` or `iMA("XAUUSDM", ...)` it fails
silently with **error 4302** ("symbol not selected") and **no candles/indicators are produced**.
The EA must resolve any incoming symbol name through `MatchBrokerSymbol()` (which compares
case-insensitively and returns the real broker name). Never feed an uppercased name to CopyRates.

### 3. MT5 remembers last-used inputs — changing code defaults does nothing
When you re-drag the EA, MT5 pre-fills the **last-used input values**, not the new code defaults.
If a previous run had `InpSymbols = "*"`, it stays `"*"` (= all 122 symbols) even after you change
the default in code. **You must change the inputs in the dialog or Load the preset**, and verify
the field actually changed before clicking OK. Preset file:
```
%APPDATA%\MetaQuotes\Terminal\<HASH>\MQL5\Presets\AuraGold_Curated_RealTime.set
```

### 4. AutoTrading must be GREEN
If the "Algo Trading" toolbar button is off, `OnTick()` never fires — you lose the tick-driven
live candle path. The log shows `automated trading is disabled`.

### 5. WebRequest whitelist (error 4014)
MT5 → Tools → Options → Expert Advisors → "Allow WebRequest for listed URL" must include
`http://127.0.0.1:5000`. Without it, every POST fails with error 4014 and nothing reaches the backend.

### 6. Hostinger MySQL goes READ-ONLY when over quota
Symptom: `INSERT, UPDATE command denied to user ...` while `SELECT` still works. This is **not** an
IP or password problem — the DB exceeded its storage quota and Hostinger revoked write privileges
(it keeps `SELECT, DELETE, DROP, ALTER`). Fix = shrink the DB (see RUNBOOK "DB cleanup"), then
Hostinger auto-restores writes on its next usage check. `DELETE` alone does NOT free disk on InnoDB;
you must `ALTER TABLE ... ENGINE=InnoDB` to reclaim space (`CREATE`/`OPTIMIZE` are blocked under the
lock, but `ALTER` is allowed). Statement timeout is **120s** — batch large deletes.

### 7. Never deep-sync everything
`InpSyncOnStartup=true` + `InpSymbols="*"` + `InpSyncCandlesLimit=100000` makes the EA upload
~10 million candle rows (122 symbols × 21 timeframes × 100k bars) on startup. This floods the
backend, blocks live streaming, and bloats the DB past quota. Keep **10 curated symbols**, a small
timeframe set, and either `InpSyncOnStartup=false` or a shallow `InpSyncCandlesLimit` (~4000).

### 8. mysql2 diagnostic scripts must set `timezone:'Z'`
The app's pool uses `timezone:'Z'`. If a throwaway diagnostic script omits it, mysql2 reads stored
UTC datetimes as **local time**, making timestamps look shifted by the local offset (this caused a
false "6-hour clock skew" diagnosis). Always match the app's pool config when comparing times.

### 9. Only ONE `npm run dev`
Duplicate dev-server process trees fight over port 5000; one crashes with `EADDRINUSE`, which looks
like "connection lost again and again." Check with `Get-NetTCPConnection -LocalPort 5000` and
`Get-CimInstance Win32_Process -Filter "Name='node.exe'"`. Kill extras, keep one.

### 10. Vertex AI / Gemini needs ADC
The "AI" signal mode calls Vertex AI via Application Default Credentials. If `gcloud auth
application-default login` hasn't been run, `/api/ai/health` returns **401** and the system silently
falls back to the rule-based (`system`) decision. This is expected behavior, not a bug.

---

## Reality check on expectations
There is **no 90% win-rate** trading system. Well-filtered confluence systems realistically target
**55–70%** with good risk/reward. The signal engine deliberately filters hard (net-conviction gate,
higher-timeframe alignment, ADX regime filter) to skip low-probability setups. Do not "tune" these
gates away to produce more signals — fewer, higher-quality signals is the design intent.

---

## Execution Forecast engine (Future Predictions page)

`backend/executionForecastEngine.js` predicts **WHEN** a favorable-but-not-yet-executable setup will
become executable (ETA + probability), distinct from the live BUY/SELL/HOLD call. It is **deterministic
and pure** — it reuses the same `systemDecision` from `aggregateSignals`, so there is **zero scoring
drift** from the live scanner. Five phases, all shipped:

- **Scan**: `runExecutionForecastScan()` runs **hourly** over curated symbols × `M5,M15,M30,H1,H4,D1`.
  A lighter `reforecastActiveForecasts()` runs on the 60s scanner for forecasts within ~20m of their ETA
  (the "2:50/2:55/2:59" re-check) → READY / DELAYED / CANCELLED / EXPIRED, streamed via SSE event
  `execution_forecast`.
- **ETA always has a named cause** (`forecast_basis`): IMMEDIATE / NEXT_CANDLE / PULLBACK / SCORE_SLOPE
  / SESSION. No black box.
- **Email**: pre-execution reminders only (**T-10m, T-5m** via `processForecastEmails` on the 30s
  scheduler) **plus a full-detail "now executable" email at the READY transition** (`sendForecastReadyEmail`,
  built from the live `systemDecision` → TP1/2/3, RR, risk plan, confluences — same depth as the forex
  alert). **No "created" email.** Gated by the `forecast` toggle (default on), `SIGNAL_ALERTS_ENABLED`,
  `SIGNAL_ALERT_EMAIL_TO`, and `setup_score >= FORECAST_EMAIL_MIN_SCORE` (**default 75**). Times in **BDT**.
- **Analyze button**: `POST /api/forecasts/:id/analyze` → TRADE / WAIT / SKIP **plus the full trade
  ticket** (`plan`: TP1/2/3, RR, lot/investment/max-loss, confluences) from the live systemDecision.
  **Deterministic** — no server-side LLM here (the existing "AI analysis" endpoint is itself rule-based;
  real Gemini runs client-side via the Vertex proxy). Source is honestly labeled `deterministic`.
- **Calibration is the honest payoff**: forecasts **resolve** (READY→EXECUTED, ETA-passed→EXPIRED,
  invalidated→CANCELLED) and store forecast/timing/score accuracy vs the **original** prediction.
  `applyForecastCalibration` then **flips** live `forecast_confidence` from heuristic estimate →
  measured timing accuracy once a basis has ≥ `FORECAST_CALIBRATION_MIN_SAMPLE` (20) resolved forecasts.
  **Until then the UI/email label it an "uncalibrated estimate" — never a guarantee** (see the
  Reality-check rule; same honesty stance as the projection track-record).

- **Trade track record (WIN/LOSS)**: separate from the timing calibration above — once a forecast
  becomes EXECUTED (READY), `initForecastTrade` captures the full TP ladder and
  `processForecastTradeOutcomes()` (60s/30s reminder scheduler) **settles WIN/LOSS by replaying the
  entry/SL/TP against real candles** via the same `evaluateForexReplay` used by the system signal log
  (`trade_outcome` = TP1/2/3_WIN / LOSS / AMBIGUOUS / EXPIRED, plus `trade_pips` / `trade_mfe_pips` /
  `trade_mae_pips`). Same-bar stop+target = **AMBIGUOUS** (not a win), 72h settle gate. Surfaced via
  `GET /api/reports/forecast-outcomes` and the **Trade track record** panel on Reports → Forecasts
  (win rate, W/L, net pips, by-basis + settled-trades table). Honest: a forecast that said "ready" is
  only a win if the trade actually reached target before stop; settled rows are pruned with the row at
  `FORECAST_RETENTION_DAYS`, so the track-record window is ~14d.
- **News-aware (timing only, never a pre-release direction guess)**: when a high-impact event for the
  symbol's currency is within the **pre-window (15m)**, the forecast ETA anchors to the event time
  (`NEWS` basis) and the row is flagged `newsImminent` (blackout: generic reminders suppressed). After
  the print, `scanNewsReactions()` (60s) emits **two-tier reaction signals** off the ACTUAL price:
  **Tier A** = first decisive candle (spike, aggressive), **Tier B** = 2+ confirming candles
  (follow-through), each with ATR-scaled SL/TP and its own email (`detectNewsReaction` /
  `buildNewsReactionLevels`, `NEWS_POST_WINDOW_MIN` 10m). The existing post-news engine
  (`refreshPostNewsSignals`, 30m blackout) is **left untouched** — these reaction tiers are additive.

Tables/endpoints: table `mt5_execution_forecasts` (compact, retention-pruned — heeds Trap #6 bloat).
`GET /api/forecasts`, `POST /api/forecasts/:id/analyze`, `GET /api/reports/forecast-calibration`,
`GET /api/reports/forecast-replay?symbol&timeframe&bars`, `GET /api/reports/forecast-outcomes?days&symbol&outcome`.
UI: "Upcoming Executions" table on the
Future Predictions page + the **Reports → Forecasts** sub-route. Forecasts are **forex-only** (no FTT
variant). Env: `FORECAST_ENABLED`, `FORECAST_SCAN_INTERVAL_MS` (1h), `FORECAST_RETENTION_DAYS` (14),
`FORECAST_REFORECAST_WINDOW_MS` (20m), `FORECAST_EMAIL_MIN_SCORE` (75), `FORECAST_CALIBRATION_MIN_SAMPLE` (20),
`NEWS_PRE_WINDOW_MIN` (15), `NEWS_POST_WINDOW_MIN` (10), `NEWS_REACTION_MIN_BODY` (0.5), `NEWS_REACTION_TF` (M5).

**Day-trading discipline layer (advisory, additive — does NOT change live signal logic):** encodes four
playbook rules on top of existing signals. (1) **R-multiples** — `rMultiple()`/`riskPipsFor()` (risk =
\|entry−SL\|); surfaced as expectancy/net R in the forecast track record. (2) **Daily risk budget** —
`computeDailyRiskBudget()` sums today's settled R from `mt5_system_signal_log` (UTC day) vs
`DAY_TRADING_DAILY_STOP_R` (default 2) → "stop for today" when hit. (3) **Over-extension guard** — reuses
`systemDecision.features.emaDistanceAtr` (signed ATR distance from EMA); flagged when \|value\| ≥
`DAY_TRADING_EXTENSION_ATR` (default 2) → "don't chase". (4) **Pre-session brief** — `GET /api/day-trading/brief`
runs `aggregateSignals` per curated symbol on one TF (`DAY_TRADING_BRIEF_TF`, default M15): bias/regime/grade/
score, extension flag, nearest S/R, ADR%, R:R, active forecast, plus today's high-impact news + daily R budget.
UI: **Pre-Session Brief** page (`/day-trading`, `frontend/pages/DayTradingBrief.tsx`). Read-only; respects
quality-not-quantity (never blocks/suppresses a signal — purely informational).

**Day Trading Desk (market-structure read, `/day-trading-desk`):** `GET /api/day-trading/desk?symbol=&timeframe=`
(`buildStructureDesk`) surfaces what the engine already computes, framed per the *Master Market Structure*
course: trend phase, **close-confirmed BOS** (`detectMarketStructure`), **liquidity sweep** (wick-through +
close back inside, `detectLiquiditySweeps`), **demand/supply zone** (order block) + **imbalance** (FVG),
HTF bias, armed **setup** (pullback/breakout/shakeout), **extension** (`emaDistanceAtr`), and entry/SL/TP plan;
plus a curated watchlist. Reuses the live detectors (now also exported from `signalEngine.js`) — **no change to
signal logic**. UI: `frontend/pages/DayTradingDesk.tsx`.

**Liquidity layer (`backend/liquidityEngine.js`, pure + unit-tested):** the edge both podcast traders (Marco
"liquidity trap", Maine "ICT blueprint") converge on. `detectLiquidityPools` finds resting liquidity at swing
highs (BSL) / lows (SSL), clusters equal highs/lows (×N stacked = stronger), flags **swept**, and exposes the
nearest unswept **draw-on-liquidity target** above/below + the most recent sweep. `detectBreaker` finds the
freshest bullish/bearish **breaker** (swing low swept → close back above prior swing high; mirror for bearish)
→ entry zone + stop below the sweep. `buildLiquidityPlan` combines them: breaker entry/stop → opposing
liquidity pool as target (+ honest RR). Each breaker carries a **displacement** confirmation
(`detectDisplacement`): a strong-bodied in-direction FVG at the reclaim (≥0.8×ATR present, ≥1.3× strong) =
"institutionally sponsored"; absent = weak break (flagged amber in UI). The Desk also shows **premium/discount**
(price's position in the last ~60-bar dealing range, clamped 0–100; buy discount / sell premium). Surfaced on
the Desk (`liquidity`, `breaker.displacement`, `liquidityPlan.displacement`, `premiumDiscount`). Tests:
`backend/liquidityEngine.test.mjs` (18/18). Verified live on real candles. The system already implements this SMC course's method
(BOS/sweep/supply-demand/imbalance); the literal 9EMA/20SMA/200SMA "Tutorial Mode" from `day_trading_plan.md`
was deliberately NOT built (duplicate trend logic, no edge; gap-bias is a stock concept, irrelevant for 24/5 gold).

> **Migration note:** Phase-5 columns (`original_execution_time`, `original_score`, `calibrated`) and the
> trade-outcome columns (`take_profit_2/3`, `trade_outcome`, `trade_exit_price`, `trade_pips`,
> `trade_tp_hit_level`, `trade_mfe_pips`, `trade_mae_pips`, `trade_resolved_at`) are added on boot via
> `addColumnIfMissing`. If the DB is in the read-only/over-quota state (Trap #6), the `ALTER`s are
> skipped — clear the quota, then restart so the columns get added.

---

## Golden rules for changes
1. **EA changes** → edit + compile in `MQL5\Experts\`, tell the user to remove/re-drag, verify via the
   MT5 Experts log (no 4302 errors, snapshots show non-zero candle counts).
2. **Backend changes** → `node --check backend/server.js`; nodemon auto-restarts. Verify endpoints.
3. **Frontend changes** → `npm run build --prefix frontend` to catch errors; Vite hot-reloads dev.
   (There is **no `tsconfig.json`** — type-checking happens via the Vite/esbuild build, not a `tsc` step.)
4. **DB destructive ops** → confirm with the user, batch under 120s, `ALTER` to reclaim, verify size.
5. **Verify, don't assume** → after any fix, sample the live data (e.g., does `received_at` advance
   second-to-second?) before declaring success.
6. **New persisted tables** → keep them compact (no big JSON blobs) and add retention pruning. The
   `mt5_account_snapshots` blob bloat blew the DB past quota; `mt5_execution_forecasts` is the model
   to copy (compact rows + pruner).
