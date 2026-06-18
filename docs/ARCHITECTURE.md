# Architecture — Aura Gold Alerts

How the pieces fit together. Read [`../AGENTS.md`](../AGENTS.md) first for the critical traps.

---

## Components

| Layer | Path | Tech | Port |
|---|---|---|---|
| Expert Advisor | `MQL5\Experts\AuraGoldSignals.ex5` (MT5 data dir) | MQL5 | — |
| Backend | `backend/server.js` | Node + Express + ws + mysql2 | 5000 |
| Signal engine | `backend/signalEngine.js` | pure JS (SMC scoring) | — |
| FTT engine | `backend/fttEngine.js` | pure JS (fixed-time prediction) | — |
| Gemini engine | `backend/geminiEngine.js` | Vertex AI REST | — |
| Frontend | `frontend/` | React + Vite + lightweight-charts | 5173 |

`npm run dev` (root) runs frontend + backend together via `concurrently`. Vite proxies `/api`,
`/api-proxy`, `/ws-proxy` to `localhost:5000`.

---

## Data flow (the live path)

1. **EA → backend** (HTTP POST, synchronous WebRequest, single-threaded in MT5):
   - `OnTimer()` every 1s: heartbeat (interval-gated), `SendLiveCandle()` (active symbol),
     `SendPriorityCandles()` (curated symbols, M1/M5/M15), then snapshot (interval-gated).
     Live/priority candles are sent **before** the history-sync guard so freshness never waits on sync.
   - `OnTick()` (needs AutoTrading ON): throttled `SendLiveCandle()` ~1/sec for tick-level freshness.
   - Endpoints: `/api/mt5/heartbeat`, `/api/mt5/candles`, `/api/mt5/snapshot`, `/api/mt5/trades`,
     `/api/mt5/account`, `/api/mt5/indicators`, `/api/mt5/signals`.

2. **Backend ingest** (`addCandle`/`addCandlesBatch`):
   - Push into in-memory `candles[]` (capped at `MT5_CANDLE_HISTORY_LIMIT`).
   - Push into the **per-series store** `candleSeries` (Map keyed `SYMBOL|TF`, capped
     `MT5_CANDLES_PER_SERIES`=600 each). This guarantees each symbol/timeframe keeps its own recent
     history so a flood for one series can't evict another.
   - Emit SSE event to browsers (`sendStreamEvent('candle', ...)`).
   - Fire-and-forget MySQL persist (`void persistCandlesBatch().catch()`).

3. **Analysis reads from memory** — `getRecentCandles(symbol, tf, limit)` reads the per-series store
   first (falls back to the flat array). `isCandleCurrent()` uses the in-memory `receivedAt` stamped
   by the backend clock, so freshness is independent of the DB clock.

4. **Frontend** — `Mt5StreamProvider` (`frontend/mt5Api.ts`) opens an `EventSource` to
   `/api/mt5/signals/stream` and updates React state on each SSE event; it also polls every 15s as a
   fallback. The candlestick chart de-duplicates by timestamp before `setData` (lightweight-charts
   requires strictly ascending unique times).

---

## Signal engine (`signalEngine.js`)

`aggregateSignals()` builds an institutional confluence score (max ~110):
H4 trend (20), H1 trend (15), BOS (15), liquidity sweep (15), FVG (10), order block (10),
session (5), volume surge (5), news-clear stub (5), EMA alignment (5), RSI divergence (5).

**Precision gates** before emitting a non-HOLD decision:
- **Net conviction**: `|buyScore - sellScore| >= 20` (skip conflicted/choppy markets).
- **HTF alignment**: never BUY against a bearish H4 (defers to H1 if H4 neutral); vice-versa.
- **Regime filter**: if `ADX < 20` (ranging), require +15 higher score.

`compositeScore` is **signed** (`(buyScore-sellScore)/100`, clamped ±1) so the FTT engine and the
Gemini fallback get a correctly-directional bias. `systemDecision.compositeScore` stays positive
(magnitude) for the UI gauge.

---

## FTT engine (`fttEngine.js`)

`generateFttPrediction()` blends the institutional `compositeScore` (trend) with short-term momentum
filters (RSI slope, MACD histogram, price-vs-EMA9, candle body, volume), weighted by expiry category
(momentum ≤3m, balanced 4–10m, trend 15m+). Includes a noise filter that overrides to HOLD mid-candle.

---

## Gemini engine (`geminiEngine.js`)

Calls Vertex AI (`gemini-2.5-flash`) with a multi-timeframe-analysis prompt. Requires ADC
(`gcloud auth application-default login`). On any failure (401, quota, parse error) it falls back to
a rule-based decision derived from `signalSummary.compositeScore`. The "AI" vs "system" toggle in the
UI selects which path is authoritative.

---

## Persistence (MySQL, Hostinger)

Tables: `mt5_candles`, `mt5_indicators`, `mt5_signals`, `mt5_trades`, `mt5_account_snapshots`,
`mt5_ai_decisions`, `mt5_ftt_predictions`, `mt5_signal_rules`, `mt5_market_levels`,
`mt5_trade_journal`, `mt5_delivery_logs`.

- **Candles do NOT store `raw_json`** (we write `'{}'`) — it roughly halved table growth.
- **Auto-retention**: a background job (`runCandleRetention`, every 6h + 90s after boot) caps each
  `symbol|timeframe` series to `MT5_DB_CANDLES_PER_SERIES` (default 5000), batched at 20k/statement.
  It is per-series (not date-based) so long timeframes (D1/W1/MN1) keep enough bars.
- Pool uses `timezone:'Z'`, `connectionLimit:5`. Statement timeout on this host is **120s**.
- On boot, `loadSignalCacheFromDatabase()` warms memory from the most recent rows and indexes the
  per-series store.

---

## Key environment variables (`backend/.env.local`)

| Var | Purpose |
|---|---|
| `API_BACKEND_PORT` | backend port (5000) |
| `API_PAYLOAD_MAX_SIZE` | max POST body (e.g. `7mb`) — snapshots must stay under this |
| `APP_TIME_ZONE` | display tz (`Asia/Dhaka`) |
| `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` | Vertex AI |
| `DB_HOST/PORT/USER/PASSWORD/NAME` | MySQL |
| `MT5_CANDLE_HISTORY_LIMIT` | in-memory flat candle cap (e.g. 60000) |
| `MT5_CANDLES_PER_SERIES` | in-memory per-series cap (default 600) |
| `MT5_DB_CANDLES_PER_SERIES` | DB retention cap per series (default 5000) |
| `MT5_RETENTION_INTERVAL_MS` | retention cadence (default 6h) |
| `GEMINI_MODEL` | `gemini-2.5-flash` |

> Note: `.env.local` uses `//` comment lines; they are loaded fine because Node's `--env-file`
> ignores lines without `=`.
