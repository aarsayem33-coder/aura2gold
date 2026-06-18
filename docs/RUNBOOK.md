# Runbook — Aura Gold Alerts

Step-by-step operations. Commands are PowerShell (Windows). Read [`../AGENTS.md`](../AGENTS.md) first.

Paths used below:
- Project: `C:\Users\ADMIN\OneDrive\Documents\PERSONAL\DEVELOPMENTS\aura-gold-alerts`
- MT5 data dir: `C:\Users\ADMIN\AppData\Roaming\MetaQuotes\Terminal\D0E8209F77C8CF37AD8BF550E51FF075`
- MetaEditor: `C:\Program Files\MetaTrader 5 EXNESS\MetaEditor64.exe`

---

## 1. Start / restart the dev server (one clean instance)

```powershell
# Find and stop existing project dev processes (do NOT kill unrelated node, e.g. xcodebuildmcp)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $_.CommandLine -and ($_.CommandLine -match 'aura-gold-alerts' -or $_.CommandLine -match 'env-file=\.env\.local server\.js' -or $_.CommandLine -match 'run dev') -and ($_.CommandLine -notmatch 'xcodebuild')
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# Confirm 5000/5173 are free, then start ONE instance (detached, logs to dev-server.log)
Start-Process -FilePath "cmd.exe" -ArgumentList "/c","npm run dev > dev-server.log 2>&1" -WorkingDirectory "<PROJECT>" -WindowStyle Hidden
```

Nodemon also auto-restarts the backend on any `backend/*.js` save. To force a restart, touch
`backend/server.js`'s mtime.

Verify: `Invoke-RestMethod http://127.0.0.1:5000/api/mt5/status` → `connected`, `candleCount`.

---

## 2. Edit + compile the EA (the RIGHT way)

The EA MT5 runs lives in the **MT5 Experts folder**, not the repo. Edit/compile THERE.

```powershell
$mt5dir = '<MT5_DATA>\MQL5\Experts'
# (Optional) sync the repo's edited copy into the MT5 folder
Copy-Item '<PROJECT>\AuraGoldSignals.mq5' "$mt5dir\AuraGoldSignals.mq5" -Force
# Compile in place; log is UTF-16
& 'C:\Program Files\MetaTrader 5 EXNESS\MetaEditor64.exe' /compile:"$mt5dir\AuraGoldSignals.mq5" /log:"$mt5dir\compile.log" | Out-Null
Start-Sleep 2
Get-Content "$mt5dir\compile.log" -Encoding Unicode | Where-Object { $_ -match 'error|warning|Result' }
```

Then tell the user: **remove the EA from the chart and re-drag it** (MT5 caches the running
instance). In the Inputs dialog, **Load** `AuraGold_Curated_RealTime` and confirm `InpSymbols` shows
the 10 `...m` names (not `*`). Ensure **AutoTrading is green**.

Verify in the MT5 Experts log: no `4302` errors, `snapshot sent ... candles:<non-zero>`.

---

## 3. Diagnose "connection lost" / "Market data outdated"

Check in order:
1. **Backend up?** `Get-NetTCPConnection -LocalPort 5000 -State Listen`. If a `node server.js`
   process exists but no listener → it crashed/looping; check `dev-server.log`.
2. **Duplicate dev servers?** Multiple `npm run dev` trees → port fight. Keep one.
3. **EA reaching backend?** MT5 Experts log:
   - `4014` → WebRequest URL not whitelisted.
   - `4302` (symbol) → case-sensitivity; EA using `XAUUSDM` instead of `XAUUSDm`.
   - `automated trading is disabled` → AutoTrading off.
   - `Aura Sync: Uploading ...` spam for many symbols → deep sync grind (`InpSymbols="*"`).
4. **DB writes?** See section 5. `INSERT ... denied` while SELECT works = quota lock.
5. **Freshness check** (does `received_at` advance? use `timezone:'Z'`):

```powershell
node -e "import('mysql2/promise').then(async m=>{const p=m.default.createPool({host:'srv502.hstgr.io',user:'<U>',password:'<P>',database:'<DB>',timezone:'Z'});const [r]=await p.query(\"SELECT MAX(received_at) rcv FROM mt5_candles WHERE symbol='XAUUSDm'\");console.log(r[0]);await p.end();})"
```
Sample twice a few seconds apart — `received_at` should advance for the active/curated symbols.

---

## 4. Reset EA to the curated real-time preset

Preset file (already present): `<MT5_DATA>\MQL5\Presets\AuraGold_Curated_RealTime.set`

Key values:
```
InpSymbols=XAUUSDm,EURUSDm,GBPUSDm,USDJPYm,AUDUSDm,USDCADm,USDCHFm,NZDUSDm,EURJPYm,GBPJPYm
InpTimeframes=M1,M5,M15,M30,H1,H4,D1
InpSyncOnStartup=false
InpSendPriorityRT=true
InpPrioritySymbols=<same 10 names>
InpPriorityTimeframes=M1,M5,M15
```
Load via EA Inputs → Load → select preset → confirm fields changed → OK. AutoTrading green.

---

## 5. DB cleanup (when over quota / writes denied)

Symptom: `INSERT, UPDATE command denied`, SELECT works. `SHOW GRANTS` shows SELECT/DELETE/DROP/ALTER
but NOT INSERT/UPDATE/CREATE. **`DELETE` and `ALTER` are allowed; `CREATE`/`OPTIMIZE`/`TRUNCATE` are not.**

Procedure (always confirm with the user first — destructive):
1. **Delete exotics** — keep only curated symbols, batched `DELETE ... LIMIT 50000` until done.
2. **Trim curated** — per `symbol|timeframe`, keep newest N (e.g. 3000) using
   `... candle_time < (SELECT candle_time ... ORDER BY candle_time DESC LIMIT 1 OFFSET N)`, batched.
3. **Trim logs** — `mt5_account_snapshots` to ~100, `mt5_ai_decisions` to ~500 (these store big JSON).
4. **Reclaim disk** — `ALTER TABLE <t> ENGINE=InnoDB` on the trimmed tables (DELETE alone does NOT
   shrink the InnoDB file; the quota lock stays until the file shrinks). Each statement must finish
   under the **120s** timeout — trim first so the rebuild is small.
5. **Verify** — total size via `information_schema.tables`; test an INSERT+DELETE.
6. Hostinger restores INSERT/UPDATE automatically on its next usage check once under quota (minutes–
   hours); the user can also ask Hostinger support to restore it immediately.

Prevention: candles don't store `raw_json`, and the retention job caps each series — keep both.

---

## 6. Vertex AI / Gemini health

```powershell
Invoke-RestMethod http://127.0.0.1:5000/api/ai/health
```
`401` → run `gcloud auth application-default login`, restart backend. Until then the "AI" mode falls
back to the rule-based `system` decision (expected, not a bug).

---

## 7. Post-change verification checklist
- [ ] `node --check backend/server.js` passes.
- [ ] `npm run build --prefix frontend` passes.
- [ ] EA compiled in `MQL5\Experts\` with 0 errors; user reattached.
- [ ] MT5 log: no `4302`/`4014`, AutoTrading green, snapshots show candles.
- [ ] `/api/mt5/status` → `connected:true`.
- [ ] Gold `received_at` advances second-to-second (sampled twice with `timezone:'Z'`).
- [ ] DB write test (INSERT+DELETE) succeeds.
