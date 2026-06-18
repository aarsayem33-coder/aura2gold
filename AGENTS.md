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
                                          ├─ fttEngine.js     (fixed-time-trade predictions)
                                          └─ geminiEngine.js  (Vertex AI / Gemini analysis)
```

The architecture is **memory-first**: incoming candles go into an in-memory store and are pushed
to the browser via SSE **instantly**; the MySQL write is fire-and-forget (`void persist().catch()`).
Analysis reads from memory, never blocks on the DB.

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

## Golden rules for changes
1. **EA changes** → edit + compile in `MQL5\Experts\`, tell the user to remove/re-drag, verify via the
   MT5 Experts log (no 4302 errors, snapshots show non-zero candle counts).
2. **Backend changes** → `node --check backend/server.js`; nodemon auto-restarts. Verify endpoints.
3. **Frontend changes** → `npm run build --prefix frontend` to catch errors; Vite hot-reloads dev.
4. **DB destructive ops** → confirm with the user, batch under 120s, `ALTER` to reclaim, verify size.
5. **Verify, don't assume** → after any fix, sample the live data (e.g., does `received_at` advance
   second-to-second?) before declaring success.
