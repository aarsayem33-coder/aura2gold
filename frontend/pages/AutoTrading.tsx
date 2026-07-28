import React, { useCallback, useEffect, useState } from 'react';
import { Bot, RefreshCw, Loader2, ShieldAlert, Eye, Power, Zap, HelpCircle, Save, CheckCircle2, Landmark, ShieldCheck, XCircle, Plus } from 'lucide-react';
import { fetchAutoTradeStatus, fetchEmailAlertSettings, saveEmailAlertSettings, fetchStrategies, approveAutoTrade, rejectAutoTrade, armAutoTradeAccount, validateAutoTrade, fetchAutoTradeComboSets, saveAutoTradeComboSet, deleteAutoTradeComboSet } from '../mt5Api';
import type { AutoTradeStatus, AutoTradeConfig, AutoTradeExecution, AutoTradeComboSet, AutoTradeValidation, EmailAlertSettings, StrategyMeta } from '../types';

const usd = (v: number | null | undefined) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const px = (v: number | null | undefined, symbol: string) => {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  const s = symbol.toUpperCase();
  const d = /USTEC|NAS|US30/.test(s) ? 2 : /XAU|XAG/.test(s) ? 2 : /JPY/.test(s) ? 3 : 5;
  return Number(v).toFixed(d);
};

const SESSIONS: [string, string][] = [['SYDNEY', 'Sydney'], ['TOKYO', 'Tokyo (Asian)'], ['LONDON', 'London'], ['OVERLAP', 'LDN–NY Overlap'], ['NEWYORK', 'New York']];
const TFS = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];

const STATUS_STYLE: Record<string, { chip: string; label: string }> = {
  SHADOW: { chip: 'bg-indigo-100 text-indigo-700', label: 'WOULD TRADE' },
  CAP_ALERT: { chip: 'bg-amber-100 text-amber-700', label: 'CAP REACHED' },
  GUARD_SKIP: { chip: 'bg-rose-100 text-rose-700', label: 'GUARD SKIP' },
  PROPOSED: { chip: 'bg-sky-100 text-sky-700', label: 'AWAITING APPROVAL' },
  QUEUED: { chip: 'bg-sky-100 text-sky-700', label: 'QUEUED' },
  SENT: { chip: 'bg-emerald-100 text-emerald-700', label: 'SENT TO MT5' },
  PLACED: { chip: 'bg-emerald-100 text-emerald-700', label: 'ORDER PLACED' },
  FILLED: { chip: 'bg-emerald-100 text-emerald-700', label: 'FILLED' },
  CLOSED: { chip: 'bg-slate-200 text-slate-600', label: 'CLOSED' },
  EXPIRED: { chip: 'bg-slate-100 text-slate-500', label: 'EXPIRED' },
  REJECTED: { chip: 'bg-slate-100 text-slate-500', label: 'REJECTED' },
  ERROR: { chip: 'bg-rose-100 text-rose-700', label: 'ERROR' },
};

export default function AutoTrading() {
  const [status, setStatus] = useState<AutoTradeStatus | null>(null);
  const [settings, setSettings] = useState<EmailAlertSettings | null>(null);
  const [strategies, setStrategies] = useState<StrategyMeta[]>([]);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, setTick] = useState(0);   // 1s re-render tick for approval countdowns
  const [valid, setValid] = useState<AutoTradeValidation | null>(null);
  const [cbStrategy, setCbStrategy] = useState('');
  const [cbSymbol, setCbSymbol] = useState('*');
  const [cbTimeframe, setCbTimeframe] = useState('*');
  const [presetName, setPresetName] = useState('');
  const [sets, setSets] = useState<AutoTradeComboSet[]>([]);
  const [setBusy, setSetBusy] = useState<string | null>(null);

  const DEFAULT_EXEC: AutoTradeExecution = {
    mode: 'AUTO', lots: 0.01, slPips: null, tp1Pips: null, tp2Pips: null, tp3Pips: null,
    riskPct: 0.5, slOverridePips: null, tpR: [1, 2, 3], allowWarnedTrades: false,
  };
  const cfg: AutoTradeConfig = settings?.autoTrade || status?.config || {
    mode: 'OFF', strategies: [], symbols: [], timeframes: [], sessions: [],
    maxTradesPerDay: 3, maxConcurrent: 2, onePerSymbol: true, minGrade: 'A', minRR: 2,
    combos: [], selectionMode: null, execution: DEFAULT_EXEC,
  };
  const combos = cfg.combos || [];
  // Explicit switch, so a saved combination list survives a trip through broad mode.
  // The null fallback below must stay identical to autoTradeSelectionMode() on the server,
  // or the badge would claim one model while the engine traded the other.
  const selectionMode: 'COMBOS' | 'BROAD' = cfg.selectionMode === 'COMBOS' ? 'COMBOS'
    : cfg.selectionMode === 'BROAD' ? 'BROAD' : (combos.length ? 'COMBOS' : 'BROAD');
  const precision = selectionMode === 'COMBOS';
  const exec: AutoTradeExecution = { ...DEFAULT_EXEC, ...(cfg.execution || {}) };

  const load = useCallback(async () => {
    try { setStatus(await fetchAutoTradeStatus()); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed to load'); }
  }, []);

  useEffect(() => {
    load();
    fetchEmailAlertSettings().then((r) => setSettings(r.settings)).catch(() => {});
    fetchStrategies().then((r) => { setStrategies(r.strategies.filter((s) => s.control?.enabled !== false)); setSymbols(r.symbols || []); }).catch(() => {});
    void loadSets();
    const id = setInterval(load, 5000);
    const tickId = setInterval(() => setTick((t) => t + 1), 1000);
    return () => { clearInterval(id); clearInterval(tickId); };
  }, [load]);

  // Live dry-run: validate the execution settings against the most recent real signal so
  // the warnings appear as you type, not after a bad trade.
  const execKey = JSON.stringify(exec) + (cfg.strategies || []).join(',') + combos.join(',') + cfg.minRR;
  useEffect(() => {
    if (!settings) return;
    const t = setTimeout(() => {
      validateAutoTrade({ ...cfg, execution: exec }).then(setValid).catch(() => setValid(null));
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [execKey, settings !== null]);

  const doApprove = async (id: string) => {
    setBusyId(id);
    try { await approveAutoTrade(id); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Approve failed'); }
    finally { setBusyId(null); }
  };
  const doReject = async (id: string) => {
    setBusyId(id);
    try { await rejectAutoTrade(id); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Reject failed'); }
    finally { setBusyId(null); }
  };
  const doArm = async (login: string | null, demo: boolean | null) => {
    if (login && demo === false && !window.confirm(`⚠ ${login} is a REAL-MONEY account. Arm it for auto-trading?`)) return;
    setBusyId(login || 'disarm');
    try { await armAutoTradeAccount(login); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Arm failed'); }
    finally { setBusyId(null); }
  };

  const patch = (p: Partial<AutoTradeConfig>) => {
    setSettings((cur) => (cur ? { ...cur, autoTrade: { ...cfg, ...p } } : cur));
    setDirty(true); setSaved(false);
  };
  const patchExec = (p: Partial<AutoTradeExecution>) => patch({ execution: { ...exec, ...p } });
  const addCombo = () => {
    if (!cbStrategy) return;
    const key = `${cbStrategy}|${cbSymbol}|${cbTimeframe}`;
    if (combos.includes(key)) return;
    patch({ combos: [...combos, key] });
  };
  const removeCombo = (key: string) => patch({ combos: combos.filter((c) => c !== key) });
  // Sets live in their own DB table, so saving/deleting one is immediate and does not
  // depend on (or disturb) the controller's own save.
  const loadSets = useCallback(async () => {
    try { setSets((await fetchAutoTradeComboSets()).sets); } catch { /* library is best-effort */ }
  }, []);
  const savePreset = async () => {
    const name = presetName.trim();
    if (!name || !combos.length) return;
    setSetBusy(name);
    try { await saveAutoTradeComboSet(name, combos); setPresetName(''); await loadSets(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not save the set'); }
    finally { setSetBusy(null); }
  };
  const loadPreset = (name: string) => {
    const found = sets.find((s) => s.name === name);
    if (found) patch({ combos: [...found.combos] });
  };
  const deletePreset = async (name: string) => {
    if (!window.confirm(`Delete the saved set "${name}"? Your current combinations are not affected.`)) return;
    setSetBusy(name);
    try { await deleteAutoTradeComboSet(name); await loadSets(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not delete the set'); }
    finally { setSetBusy(null); }
  };
  const toggleList = (key: 'strategies' | 'symbols' | 'timeframes' | 'sessions', val: string) => {
    const list = cfg[key] || [];
    patch({ [key]: list.includes(val) ? list.filter((x) => x !== val) : [...list, val] } as Partial<AutoTradeConfig>);
  };
  const save = async () => {
    if (!settings) return;
    setSaving(true);
    try { const r = await saveEmailAlertSettings(settings); setSettings(r.settings); setDirty(false); setSaved(true); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Save failed'); }
    finally { setSaving(false); }
  };

  const MODES: { key: AutoTradeConfig['mode']; label: string; note: string; Icon: React.ComponentType<{ size?: number }>; on: string; disabled?: boolean }[] = [
    { key: 'OFF', label: 'OFF', note: 'Auto-trader disabled', Icon: Power, on: 'border-slate-500 bg-slate-600 text-white' },
    { key: 'SHADOW', label: 'SHADOW', note: 'Logs + emails what it WOULD trade — no orders', Icon: Eye, on: 'border-indigo-500 bg-indigo-600 text-white' },
    { key: 'ASK', label: 'ASK', note: 'Prepares each trade, you tap Approve (10-min window)', Icon: HelpCircle, on: 'border-sky-500 bg-sky-600 text-white', disabled: !status?.bridgeReady },
    { key: 'AUTO', label: 'AUTO', note: 'Executes immediately, then notifies you', Icon: Zap, on: 'border-emerald-500 bg-emerald-600 text-white', disabled: !status?.bridgeReady },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-4 pb-24">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-black text-slate-900"><Bot size={22} className="text-indigo-600" />Auto Trading</h1>
          <p className="text-sm font-semibold text-slate-500">The system trades on your MT5 through the EA bridge — inside the limits you set here. Currently rolling out in SHADOW (decide + log + email, no orders).</p>
        </div>
        <button onClick={load} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-bold text-slate-600 hover:bg-slate-50"><RefreshCw size={15} />Refresh</button>
      </div>

      {err && <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm font-semibold text-rose-700">{err}</div>}

      {/* Mode switch */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-card">
        <div className="grid gap-2 sm:grid-cols-4">
          {MODES.map((m) => (
            <button key={m.key} type="button" disabled={m.disabled} onClick={() => patch({ mode: m.key })}
              title={m.note}
              className={`rounded-xl border-2 px-4 py-3 text-left transition-colors ${cfg.mode === m.key ? m.on : m.disabled ? 'border-slate-100 bg-slate-50 text-slate-300 cursor-not-allowed' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'}`}>
              <span className="flex items-center gap-2 text-sm font-black"><m.Icon size={16} />{m.label}</span>
              <span className={`mt-0.5 block text-[10px] font-semibold ${cfg.mode === m.key ? 'opacity-80' : 'text-slate-400'}`}>{m.note}</span>
            </button>
          ))}
        </div>
        {(cfg.mode === 'ASK' || cfg.mode === 'AUTO') && status && (!status.bridge.ready || !status.bridge.armedMatch) && (
          <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-800"><ShieldAlert size={12} className="mr-1 inline" />{!status.bridge.ready ? 'EA bridge offline (re-drag the updated EA + enable AutoTrading) — behaving as SHADOW.' : 'No armed account matches the live MT5 login — behaving as SHADOW. Arm the account below.'}</p>
        )}
        {status && (
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs font-bold text-slate-600">
            <span>Effective mode: <span className="text-indigo-700">{status.effectiveMode}</span></span>
            <span>Today: <span className={status.remainingToday === 0 ? 'text-rose-600' : 'text-slate-800'}>{status.todayCount}/{cfg.maxTradesPerDay}</span> trades</span>
            <span>Session now: <span className="text-slate-800">{status.session?.key}</span>{status.session?.bdTime ? ` · ${status.session.bdTime}` : ''}</span>
            <span>EA bridge: <span className={status.bridgeReady ? 'text-emerald-600' : 'text-slate-400'}>{status.bridgeReady ? 'CONNECTED' : 'NOT INSTALLED (Step 2)'}</span></span>
          </div>
        )}
      </div>

      {/* Broker / account panel — auto-detected from the EA, with the armed-account switcher */}
      {status && (
        <div className="rounded-2xl border border-slate-200 bg-white shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3">
            <div className="flex items-center gap-2">
              <Landmark size={16} className="text-slate-500" />
              <h3 className="text-sm font-bold text-slate-900">Broker account</h3>
            </div>
            {status.bridge.ready && status.bridge.account ? (
              <span className="flex flex-wrap items-center gap-2 text-xs font-bold">
                <span className="text-slate-700">{status.bridge.broker || 'Unknown broker'} · #{status.bridge.account}</span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-black ${status.bridge.demo ? 'bg-sky-100 text-sky-700' : 'bg-rose-100 text-rose-700'}`}>{status.bridge.demo ? 'DEMO' : 'REAL'}</span>
                <span className="text-slate-400">{status.bridge.server}</span>
                <span className="text-slate-500">Bal {usd(status.bridge.balance)} · Eq {usd(status.bridge.equity)}</span>
                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-black ${status.bridge.armedMatch ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-800'}`}>
                  {status.bridge.armedMatch ? <><ShieldCheck size={11} />ARMED</> : <><ShieldAlert size={11} />NOT ARMED</>}
                </span>
              </span>
            ) : (
              <span className="text-xs font-bold text-slate-400">No live account detected — EA bridge {status.bridge.lastSeenSec != null ? `last seen ${status.bridge.lastSeenSec}s ago` : 'never seen'} (re-drag the updated EA)</span>
            )}
          </div>
          <div className="px-5 py-3">
            <p className="mb-2 text-[11px] font-semibold text-slate-500">Known accounts — arm exactly the one the system may trade. Logging into a different account in MT5 pauses trading automatically.</p>
            <div className="flex flex-wrap gap-2">
              {status.accounts.map((a) => {
                const isArmed = status.armed === a.login;
                const isLive = status.bridge.account === a.login && status.bridge.ready;
                return (
                  <div key={a.login} className={`flex items-center gap-2 rounded-xl border px-3 py-2 ${isArmed ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200 bg-white'}`}>
                    <div>
                      <p className="text-xs font-black text-slate-800">#{a.login} <span className={`ml-1 rounded px-1 py-0.5 text-[9px] font-black ${a.demo ? 'bg-sky-100 text-sky-700' : 'bg-rose-100 text-rose-700'}`}>{a.demo ? 'DEMO' : 'REAL'}</span>{isLive && <span className="ml-1 rounded bg-emerald-100 px-1 py-0.5 text-[9px] font-black text-emerald-700">LIVE NOW</span>}</p>
                      <p className="text-[10px] font-medium text-slate-400">{a.broker} · {a.server}</p>
                    </div>
                    {isArmed
                      ? <button disabled={busyId !== null} onClick={() => doArm(null, null)} className="rounded-lg border border-rose-200 bg-white px-2 py-1 text-[10px] font-black text-rose-600 hover:bg-rose-50">DISARM</button>
                      : <button disabled={busyId !== null} onClick={() => doArm(a.login, a.demo)} className="rounded-lg border border-emerald-300 bg-white px-2 py-1 text-[10px] font-black text-emerald-700 hover:bg-emerald-50">ARM</button>}
                  </div>
                );
              })}
              {!status.accounts.length && <p className="text-xs font-medium text-slate-400">No accounts detected yet — they appear automatically once the updated EA polls in.</p>}
            </div>
          </div>
        </div>
      )}

      {/* Pending approvals (ASK mode) */}
      {status && status.decisions.some((d) => d.status === 'PROPOSED') && (
        <div className="rounded-2xl border border-sky-300 bg-sky-50/60 shadow-card">
          <div className="border-b border-sky-200 px-5 py-3"><h3 className="text-sm font-black text-sky-900">⏳ Awaiting your approval</h3></div>
          <div className="space-y-2 px-5 py-3">
            {status.decisions.filter((d) => d.status === 'PROPOSED').map((d) => {
              const expMs = d.createdAt ? new Date(d.createdAt).getTime() + 10 * 60 * 1000 : 0;
              const secsLeft = Math.max(0, Math.round((expMs - Date.now()) / 1000));
              return (
                <div key={d.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-200 bg-white px-4 py-3">
                  <div>
                    <p className="text-sm font-black text-slate-800">{d.direction} {d.symbol} {d.timeframe} · {d.orderType} @ {px(d.entry, d.symbol)}</p>
                    <p className="text-[11px] font-semibold text-slate-500">SL {px(d.stopLoss, d.symbol)} · TP {px(d.takeProfit1, d.symbol)} · {d.lots} lots ({usd(d.riskAmount)} risk) · {d.strategyName} · {d.score} {d.grade}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`font-mono text-xs font-black ${secsLeft < 120 ? 'text-rose-600' : 'text-slate-500'}`}>{Math.floor(secsLeft / 60)}:{String(secsLeft % 60).padStart(2, '0')}</span>
                    <button disabled={busyId !== null} onClick={() => doApprove(d.id)} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-black text-white hover:bg-emerald-700 disabled:opacity-50">{busyId === d.id ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}APPROVE</button>
                    <button disabled={busyId !== null} onClick={() => doReject(d.id)} className="inline-flex items-center gap-1 rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs font-black text-rose-600 hover:bg-rose-50 disabled:opacity-50"><XCircle size={13} />REJECT</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Execution / ticket builder */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-card">
        <div className="border-b border-slate-100 px-5 py-3">
          <h3 className="text-sm font-bold text-slate-900">Lot size, stop-loss &amp; take-profit</h3>
          <p className="text-xs font-medium text-slate-500">How each ticket is built. Overrides use <b>distances in pips</b>, never fixed prices — every signal has a different entry. Anything that fights the strategy's own analysis is flagged below before it can trade.</p>
        </div>
        <div className="space-y-4 px-5 py-4">
          <div className="grid gap-2 sm:grid-cols-3">
            {([
              ['AUTO', '1 · Automatic', "Strategy's own SL/TP · lot size from Account & Sizing"],
              ['MANUAL', '2 · Full manual', 'Your lots + your SL/TP distances (validated)'],
              ['RISK', '3 · Risk % only', 'You set risk % — system derives lots + TP1/2/3 from the structural SL'],
            ] as const).map(([val, label, note]) => (
              <button key={val} type="button" onClick={() => patchExec({ mode: val })}
                className={`rounded-xl border-2 px-3 py-2.5 text-left transition-colors ${exec.mode === val ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 bg-white hover:border-indigo-200'}`}>
                <span className={`block text-xs font-black ${exec.mode === val ? 'text-indigo-700' : 'text-slate-700'}`}>{label}</span>
                <span className="mt-0.5 block text-[10px] font-semibold leading-snug text-slate-400">{note}</span>
              </button>
            ))}
          </div>

          {exec.mode === 'AUTO' && (
            <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-[11px] font-semibold text-emerald-900">
              Using each strategy's structural stop and its own targets, with the lot size computed from your Account &amp; Sizing risk % — the measured, tested setup. Nothing to configure.
            </p>
          )}

          {exec.mode === 'MANUAL' && (
            <div className="space-y-2">
              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
                <div><label className="block text-[11px] font-semibold text-slate-500">Lot size</label>
                  <input type="number" step={0.01} min={0.01} value={exec.lots} onChange={(e) => patchExec({ lots: Number(e.target.value) })} className="mt-0.5 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm font-bold text-slate-800" /></div>
                {([['slPips', 'SL distance (pips)'], ['tp1Pips', 'TP1 (pips)'], ['tp2Pips', 'TP2 (pips)'], ['tp3Pips', 'TP3 (pips)']] as const).map(([k, label]) => (
                  <div key={k}><label className="block text-[11px] font-semibold text-slate-500">{label}</label>
                    <input type="number" step={0.1} min={0} placeholder="strategy" value={exec[k] ?? ''} onChange={(e) => patchExec({ [k]: e.target.value === '' ? null : Number(e.target.value) } as Partial<AutoTradeExecution>)} className="mt-0.5 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm font-bold text-slate-800" /></div>
                ))}
              </div>
              <p className="text-[10px] font-medium text-slate-400">Leave a field blank to keep the strategy's own value for it. Distances are measured from the signal's entry price.</p>
            </div>
          )}

          {exec.mode === 'RISK' && (
            <div className="space-y-2">
              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
                <div><label className="block text-[11px] font-semibold text-slate-500">Risk per trade (%)</label>
                  <input type="number" step={0.05} min={0.05} max={10} value={exec.riskPct} onChange={(e) => patchExec({ riskPct: Number(e.target.value) })} className="mt-0.5 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm font-bold text-slate-800" /></div>
                <div><label className="block text-[11px] font-semibold text-slate-500">SL override (pips)</label>
                  <input type="number" step={0.1} min={0} placeholder="structural" value={exec.slOverridePips ?? ''} onChange={(e) => patchExec({ slOverridePips: e.target.value === '' ? null : Number(e.target.value) })} className="mt-0.5 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm font-bold text-slate-800" /></div>
                {[0, 1, 2].map((i) => (
                  <div key={i}><label className="block text-[11px] font-semibold text-slate-500">TP{i + 1} (R multiple)</label>
                    <input type="number" step={0.1} min={0.2} value={exec.tpR?.[i] ?? [1, 2, 3][i]} onChange={(e) => { const next = [...(exec.tpR || [1, 2, 3])]; next[i] = Number(e.target.value); patchExec({ tpR: next }); }} className="mt-0.5 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm font-bold text-slate-800" /></div>
                ))}
              </div>
              <p className="text-[10px] font-medium text-slate-400">Leave the SL override blank (recommended) to keep the strategy's structural stop — the level it placed beyond the invalidation point. Lot size is then solved so a full stop loses exactly your risk %, and targets are laid at those R multiples.</p>
            </div>
          )}

          {exec.mode !== 'AUTO' && (
            <label className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
              <input type="checkbox" checked={exec.allowWarnedTrades} onChange={(e) => patchExec({ allowWarnedTrades: e.target.checked })} className="mt-0.5" />
              <span className="text-[11px] font-semibold text-amber-900">Trade anyway when there are warnings. <span className="font-normal">Off (recommended) = a warned setup is logged as GUARD SKIP instead of traded. Broken geometry (stop on the wrong side, targets out of order) is <b>always</b> blocked either way.</span></span>
            </label>
          )}

          {/* Live validation against the most recent real signal */}
          {valid && exec.mode !== 'AUTO' && (
            <div className={`rounded-xl border px-4 py-3 ${(valid.errors?.length) ? 'border-rose-300 bg-rose-50' : (valid.warnings?.length) ? 'border-amber-300 bg-amber-50' : 'border-emerald-300 bg-emerald-50'}`}>
              {!valid.hasSample && <p className="text-[11px] font-semibold text-slate-500">{valid.note}</p>}
              {valid.hasSample && (
                <>
                  <p className="text-[11px] font-black uppercase tracking-wider text-slate-600">
                    Dry run vs your latest signal — {valid.sample?.strategyName} {valid.sample?.symbol} {valid.sample?.timeframe}
                  </p>
                  <div className="mt-1.5 grid gap-2 text-[11px] font-semibold text-slate-700 sm:grid-cols-2">
                    <div className="rounded-lg bg-white/70 px-2.5 py-1.5">
                      <span className="text-[9px] font-black uppercase text-slate-400">Strategy would use</span>
                      <p>SL {valid.strategyTicket?.stopLoss} · TP {valid.strategyTicket?.takeProfit1} · {valid.strategyTicket?.lots} lots · {usd(valid.strategyTicket?.riskAmount)}</p>
                    </div>
                    <div className="rounded-lg bg-white/70 px-2.5 py-1.5">
                      <span className="text-[9px] font-black uppercase text-slate-400">Your settings produce</span>
                      <p>SL {valid.resultTicket?.stopLoss} ({valid.resultTicket?.stopPips}p) · TP {valid.resultTicket?.takeProfit1} · {valid.resultTicket?.lots} lots · {usd(valid.resultTicket?.riskAmount)} · RR 1:{valid.resultTicket?.rr ?? '—'}</p>
                    </div>
                  </div>
                  {Boolean(valid.errors?.length) && (
                    <ul className="mt-2 space-y-0.5">
                      {valid.errors!.map((e, i) => <li key={i} className="text-[11px] font-bold text-rose-700">⛔ {e}</li>)}
                    </ul>
                  )}
                  {Boolean(valid.warnings?.length) && (
                    <ul className="mt-2 space-y-0.5">
                      {valid.warnings!.map((w, i) => <li key={i} className="text-[11px] font-bold text-amber-800">⚠ {w}</li>)}
                    </ul>
                  )}
                  <p className={`mt-2 text-[11px] font-black ${valid.wouldTrade ? 'text-emerald-700' : 'text-rose-700'}`}>
                    {valid.wouldTrade ? '✅ This ticket would be traded.' : '⛔ This ticket would NOT be traded with the current settings.'}
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* SELECTION MODE SWITCHER — the two models are mutually exclusive, and picking
          one never discards the other's configuration. */}
      <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-card">
        <p className="mb-2 text-[11px] font-black uppercase tracking-wider text-slate-500">What decides which signals trade</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {([
            ['COMBOS', 'Exact combinations', `${combos.length} pairing${combos.length === 1 ? '' : 's'} · strategy × symbol × timeframe`],
            ['BROAD', 'Broad selection', `${(cfg.strategies || []).length} strateg${(cfg.strategies || []).length === 1 ? 'y' : 'ies'} × symbols × timeframes`],
          ] as const).map(([val, label, note]) => (
            <button key={val} type="button" onClick={() => patch({ selectionMode: val })}
              className={`rounded-xl border-2 px-4 py-2.5 text-left transition-colors ${selectionMode === val ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 bg-white hover:border-indigo-200'}`}>
              <span className={`flex items-center gap-2 text-sm font-black ${selectionMode === val ? 'text-indigo-700' : 'text-slate-700'}`}>
                {selectionMode === val && <CheckCircle2 size={14} />}{label}
              </span>
              <span className="mt-0.5 block text-[10px] font-semibold text-slate-400">{note}</span>
            </button>
          ))}
        </div>
        <p className="mt-2 text-[10px] font-medium text-slate-400">
          Only the selected model decides what trades. The other keeps its settings untouched, so you can switch back at any time without rebuilding it.
        </p>
      </div>

      {/* Precision combos — exact strategy × symbol × timeframe */}
      <div className={`rounded-2xl border bg-white shadow-card ${precision ? 'border-indigo-300' : 'border-slate-200 opacity-60'}`}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3">
          <div>
            <h3 className="text-sm font-bold text-slate-900">Exact combinations <span className="font-semibold text-slate-400">(strategy × symbol × timeframe)</span></h3>
            <p className="text-xs font-medium text-slate-500">Pick the precise pairings you trust — e.g. <b>Forex Confluence × GBPUSDm × M15</b> without allowing that strategy anywhere else. Add one or more and this list becomes the only thing that trades.</p>
          </div>
          <span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-black ${precision ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500'}`}>
            {precision ? `ACTIVE · ${combos.length}` : 'NOT IN USE'}
          </span>
        </div>
        <div className="space-y-3 px-5 py-4">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[190px] flex-1">
              <label className="block text-[11px] font-semibold text-slate-500">Strategy</label>
              <select value={cbStrategy} onChange={(e) => { setCbStrategy(e.target.value); setCbTimeframe('*'); }} className="mt-0.5 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm font-bold text-slate-800">
                <option value="">Choose a strategy…</option>
                {strategies.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div className="min-w-[130px]">
              <label className="block text-[11px] font-semibold text-slate-500">Symbol</label>
              <select value={cbSymbol} onChange={(e) => setCbSymbol(e.target.value)} className="mt-0.5 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm font-bold text-slate-800">
                <option value="*">Any symbol</option>
                {symbols.map((s) => <option key={s} value={s.toUpperCase()}>{s}</option>)}
              </select>
            </div>
            <div className="min-w-[120px]">
              <label className="block text-[11px] font-semibold text-slate-500">Timeframe</label>
              <select value={cbTimeframe} onChange={(e) => setCbTimeframe(e.target.value)} className="mt-0.5 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm font-bold text-slate-800">
                <option value="*">Any timeframe</option>
                {(strategies.find((s) => s.id === cbStrategy)?.timeframes || TFS).map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <button type="button" onClick={addCombo} disabled={!cbStrategy}
              className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-40">
              <Plus size={15} />Add
            </button>
          </div>
          {cbStrategy && <p className="text-[10px] font-medium text-slate-400">Timeframes listed are the ones {strategies.find((s) => s.id === cbStrategy)?.name} actually scans — anything else would never fire.</p>}

          {/* Saved sets — build a list once, recall it any time */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2.5">
            <p className="mb-1.5 text-[10px] font-black uppercase tracking-wider text-slate-500">Saved sets</p>
            <div className="flex flex-wrap items-center gap-2">
              <input value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder="Name this set…" maxLength={40}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); savePreset(); } }}
                className="min-w-[150px] flex-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm font-semibold text-slate-800" />
              <button type="button" onClick={savePreset} disabled={!presetName.trim() || !combos.length || setBusy !== null}
                title={!combos.length ? 'Add at least one combination first' : 'Save the current list under this name'}
                className="inline-flex items-center gap-1 rounded-lg border border-indigo-300 bg-white px-2.5 py-1.5 text-xs font-bold text-indigo-700 hover:bg-indigo-50 disabled:opacity-40">
                {setBusy && setBusy === presetName.trim() ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}Save set
              </button>
            </div>
            {sets.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {sets.map((s) => {
                  const active = s.combos.length === combos.length && s.combos.every((c) => combos.includes(c));
                  return (
                    <span key={s.name} className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-bold ${active ? 'border-emerald-400 bg-emerald-50 text-emerald-800' : 'border-slate-200 bg-white text-slate-700'}`}>
                      <button type="button" onClick={() => loadPreset(s.name)} title={`Load ${s.combos.length} combination${s.combos.length === 1 ? '' : 's'}${s.updatedAt ? ` · saved ${new Date(s.updatedAt).toLocaleString()}` : ''}`} className="hover:underline">
                        {s.name} <span className="font-semibold text-slate-400">({s.combos.length})</span>
                      </button>
                      <button type="button" disabled={setBusy !== null} onClick={() => deletePreset(s.name)} title="Delete this saved set" className="text-slate-300 hover:text-rose-600 disabled:opacity-40">
                        {setBusy === s.name ? <Loader2 size={13} className="animate-spin" /> : <XCircle size={13} />}
                      </button>
                    </span>
                  );
                })}
              </div>
            ) : (
              <p className="mt-1.5 text-[10px] font-medium text-slate-400">None saved yet — build a list above, name it, and hit Save set to reuse it any time.</p>
            )}
            <p className="mt-1.5 text-[10px] font-medium text-slate-400">Sets are stored on the server, so they survive restarts and are here whenever you come back. Saving or deleting a set takes effect immediately. <b>Loading</b> one only fills the combinations above — press Save controller to put it live.</p>
          </div>

          {precision ? (
            <div className="space-y-1.5">
              {Object.entries(combos.reduce<Record<string, string[]>>((acc, c) => {
                const [sid] = c.split('|');
                (acc[sid] ||= []).push(c);
                return acc;
              }, {})).map(([sid, list]) => (
                <div key={sid} className="rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2">
                  <p className="text-[11px] font-black text-slate-700">{strategies.find((s) => s.id === sid)?.name || sid}</p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {list.map((c) => {
                      const [, sym, tf] = c.split('|');
                      return (
                        <span key={c} className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-white px-2 py-1 text-[11px] font-bold text-slate-700">
                          {sym === '*' ? 'any symbol' : sym} <span className="text-slate-300">×</span> {tf === '*' ? 'any TF' : tf}
                          <button type="button" onClick={() => removeCombo(c)} className="text-slate-300 hover:text-rose-600"><XCircle size={13} /></button>
                        </span>
                      );
                    })}
                  </div>
                </div>
              ))}
              <p className="rounded-lg bg-indigo-50 px-3 py-2 text-[11px] font-semibold text-indigo-900">
                Precision mode is active — <b>only</b> these {combos.length} combination{combos.length === 1 ? '' : 's'} can trade. The broad lists below are ignored while this list has entries. Remove them all to go back to the broad rules.
              </p>
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-slate-200 px-3 py-3 text-center text-[11px] font-medium text-slate-400">
              No exact combinations yet — the broad lists below are in charge. Add one above to switch to precision mode.
            </p>
          )}
        </div>
      </div>

      {/* Broad selection — the ONLY part the precision list replaces */}
      <div className={`rounded-2xl border bg-white shadow-card ${precision ? 'border-slate-200 opacity-60' : 'border-slate-200'}`}>
        <div className="border-b border-slate-100 px-5 py-3">
          <h3 className="text-sm font-bold text-slate-900">Broad selection <span className={`ml-1 rounded-full px-2.5 py-1 text-[10px] font-black ${precision ? 'bg-slate-100 text-slate-500' : 'bg-indigo-600 text-white'}`}>{precision ? 'NOT IN USE' : `ACTIVE · ${(cfg.strategies || []).length}`}</span></h3>
          <p className="text-xs font-medium text-slate-500">Strategies are explicit opt-in — none selected = nothing trades. Symbols / timeframes empty = all. {precision ? 'Your exact combinations above decide what trades instead of these three lists — the limits below still apply.' : 'Lot size comes from Account & Sizing.'}</p>
        </div>
        <div className="space-y-4 px-5 py-4">
          <div>
            <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Strategies {cfg.strategies.length ? <span className="text-emerald-600">— {cfg.strategies.length} allowed</span> : <span className="text-rose-500">— NONE selected, nothing will trade</span>}</p>
            <div className="flex flex-wrap gap-1.5">
              {strategies.map((s) => {
                const on = cfg.strategies.includes(s.id);
                return <button key={s.id} type="button" onClick={() => toggleList('strategies', s.id)} className={`rounded-lg border px-2 py-1 text-[11px] font-bold transition-colors ${on ? 'border-indigo-500 bg-indigo-500 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-indigo-300'}`}>{s.name}</button>;
              })}
              {!strategies.length && <p className="text-xs text-slate-400">Loading strategies…</p>}
            </div>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Symbols {cfg.symbols.length ? <span className="text-emerald-600">— {cfg.symbols.length}</span> : <span className="text-slate-400">— all</span>}</p>
              <div className="flex flex-wrap gap-1.5">
                {symbols.map((sym) => {
                  const on = cfg.symbols.includes(sym.toUpperCase());
                  return <button key={sym} type="button" onClick={() => toggleList('symbols', sym.toUpperCase())} className={`rounded-lg border px-2 py-1 text-[11px] font-bold transition-colors ${on ? 'border-indigo-500 bg-indigo-500 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-indigo-300'}`}>{sym}</button>;
                })}
              </div>
            </div>
            <div>
              <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Timeframes {cfg.timeframes.length ? <span className="text-emerald-600">— {cfg.timeframes.join(', ')}</span> : <span className="text-slate-400">— all</span>}</p>
              <div className="flex flex-wrap gap-1.5">
                {TFS.map((tf) => {
                  const on = cfg.timeframes.includes(tf);
                  return <button key={tf} type="button" onClick={() => toggleList('timeframes', tf)} className={`rounded-lg border px-2.5 py-1 text-[11px] font-bold transition-colors ${on ? 'border-indigo-500 bg-indigo-500 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-indigo-300'}`}>{tf}</button>;
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Limits & guards — these apply in BOTH modes, so they are never dimmed */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-card">
        <div className="border-b border-slate-100 px-5 py-3">
          <h3 className="text-sm font-bold text-slate-900">Limits &amp; guards <span className="ml-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-black text-emerald-700">ALWAYS APPLY</span></h3>
          <p className="text-xs font-medium text-slate-500">These run on top of whichever selection is active — exact combinations or the broad lists. Sessions empty = all.</p>
        </div>
        <div className="space-y-4 px-5 py-4">
          <div>
            <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Trading sessions {cfg.sessions.length ? <span className="text-emerald-600">— {cfg.sessions.length}</span> : <span className="text-slate-400">— all</span>}</p>
            <div className="flex flex-wrap gap-1.5">
              {SESSIONS.map(([key, label]) => {
                const on = cfg.sessions.includes(key);
                return <button key={key} type="button" onClick={() => toggleList('sessions', key)} className={`rounded-lg border px-2.5 py-1 text-[11px] font-bold transition-colors ${on ? 'border-indigo-500 bg-indigo-500 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-indigo-300'}`}>{label}</button>;
              })}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div><label className="block text-[11px] font-semibold text-slate-500">Max trades / day</label>
              <input type="number" min={1} max={500} value={cfg.maxTradesPerDay} onChange={(e) => patch({ maxTradesPerDay: Number(e.target.value) })} className="mt-0.5 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm font-bold text-slate-800" /></div>
            <div><label className="block text-[11px] font-semibold text-slate-500">Max concurrent</label>
              <input type="number" min={1} max={100} value={cfg.maxConcurrent} onChange={(e) => patch({ maxConcurrent: Number(e.target.value) })} className="mt-0.5 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm font-bold text-slate-800" /></div>
            <div><label className="block text-[11px] font-semibold text-slate-500">One per symbol</label>
              <button type="button" onClick={() => patch({ onePerSymbol: !cfg.onePerSymbol })} className={`mt-0.5 w-full rounded-lg border px-2.5 py-1.5 text-sm font-bold ${cfg.onePerSymbol ? 'border-indigo-500 bg-indigo-500 text-white' : 'border-slate-300 bg-white text-slate-600'}`}>{cfg.onePerSymbol ? 'YES' : 'NO'}</button></div>
            <div><label className="block text-[11px] font-semibold text-slate-500">Min grade</label>
              <div className="mt-0.5 flex gap-1">{(['A', 'A+'] as const).map((g) => (
                <button key={g} type="button" onClick={() => patch({ minGrade: g })} className={`flex-1 rounded-lg border px-2 py-1.5 text-sm font-bold ${cfg.minGrade === g ? 'border-indigo-500 bg-indigo-500 text-white' : 'border-slate-300 bg-white text-slate-600'}`}>{g}</button>
              ))}</div></div>
            <div><label className="block text-[11px] font-semibold text-slate-500">Min R:R</label>
              <input type="number" min={0} max={10} step={0.1} value={cfg.minRR} onChange={(e) => patch({ minRR: Number(e.target.value) })} className="mt-0.5 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm font-bold text-slate-800" /></div>
          </div>
          {/* Concurrency multiplies risk: N open trades can all stop out together. Show
              the real number rather than capping what the user is allowed to choose. */}
          {(() => {
            const riskPct = exec.mode === 'RISK' ? exec.riskPct
              : (settings?.accountRisk?.mode === 'CHALLENGE' || settings?.accountRisk?.mode === 'BOTH')
                ? settings?.accountRisk?.challenge?.riskPerTradePct ?? 0.5
                : settings?.accountRisk?.normalRiskPct ?? 1;
            const worst = Math.round(riskPct * cfg.maxConcurrent * 100) / 100;
            const hot = worst >= 6;
            return (
              <p className={`rounded-lg px-3 py-2 text-[11px] font-semibold ${hot ? 'bg-amber-50 text-amber-900' : 'bg-slate-50 text-slate-500'}`}>
                {hot && <ShieldAlert size={12} className="mr-1 inline" />}
                {cfg.maxConcurrent} concurrent × {riskPct}% risk = <b>{worst}% of the account at risk at once</b> if every open trade stops out together.
                {hot ? ' That is past a typical prop daily-loss limit — size down or lower concurrency.' : ' Trades on correlated pairs tend to lose together, so treat this as one position.'}
              </p>
            );
          })()}
          <div className="flex items-center gap-3">
            <button disabled={!dirty || saving} onClick={save} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-40">
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}Save controller
            </button>
            {saved && !dirty && <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-600"><CheckCircle2 size={14} />Saved</span>}
            {dirty && <span className="text-xs font-semibold text-amber-600">Unsaved changes</span>}
          </div>
        </div>
      </div>

      {/* Decisions log */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-card">
        <div className="border-b border-slate-100 px-5 py-3">
          <h3 className="text-sm font-bold text-slate-900">Decision log</h3>
          <p className="text-xs font-medium text-slate-500">Every signal the auto-trader acted on (or would have). Watch SHADOW for a few days — it should pick exactly the trades you'd want.</p>
        </div>
        {!status?.decisions.length && <p className="px-5 py-8 text-center text-xs font-medium text-slate-400">No decisions yet. With SHADOW on and strategies selected, qualifying signals will appear here.</p>}
        {Boolean(status?.decisions.length) && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead><tr className="border-b border-slate-100 text-[10px] font-black uppercase tracking-wider text-slate-400">
                <th className="px-4 py-2">Time</th><th className="px-2 py-2">Status</th><th className="px-2 py-2">Signal</th><th className="px-2 py-2">Ticket</th><th className="px-2 py-2">Lots</th><th className="px-2 py-2">Risk</th><th className="px-2 py-2">Session</th><th className="px-2 py-2">Note</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-50">
                {status!.decisions.map((d) => {
                  const st = STATUS_STYLE[d.status] || { chip: 'bg-slate-100 text-slate-500', label: d.status };
                  return (
                    <tr key={d.id}>
                      <td className="whitespace-nowrap px-4 py-2 text-slate-500">{d.createdAt ? new Date(d.createdAt).toLocaleString() : '—'}</td>
                      <td className="px-2 py-2"><span className={`rounded-full px-2 py-0.5 text-[10px] font-black ${st.chip}`}>{st.label}</span></td>
                      <td className="px-2 py-2 font-semibold text-slate-700">{d.direction} {d.symbol} {d.timeframe} · {d.orderType} @ {px(d.entry, d.symbol)} · SL {px(d.stopLoss, d.symbol)} · TP {px(d.takeProfit1, d.symbol)}<span className="block text-[10px] font-medium text-slate-400">{d.strategyName} · {d.score} {d.grade} · RR {d.rr ?? '—'}</span></td>
                      <td className="px-2 py-2 text-slate-500">{d.ticket ?? '—'}</td>
                      <td className="px-2 py-2 font-bold text-slate-700">{d.lots ?? '—'}</td>
                      <td className="px-2 py-2 text-slate-500">{usd(d.riskAmount)}<span className="block text-[10px]">{d.riskMode}</span></td>
                      <td className="px-2 py-2 text-slate-500">{d.session}</td>
                      <td className="max-w-[220px] px-2 py-2 text-[10px] text-slate-400">{d.reason}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-[11px] font-medium text-slate-400">Rollout: SHADOW first (verify decisions) → EA bridge + ASK approvals (Step 2) → AUTO + results (Step 3), on a demo account before real. Signals and emails keep flowing exactly as before — this layer never changes them. Not financial advice.</p>
    </div>
  );
}
