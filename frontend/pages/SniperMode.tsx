import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Crosshair, Loader2, RefreshCw, ShieldAlert, ShieldCheck, Save, Pencil,
  CheckCircle2, XCircle, AlertTriangle,
} from 'lucide-react';
import { fetchSniper, saveSniper } from '../mt5Api';
import type { SniperResponse, SniperConfig, SniperTrade } from '../mt5Api';
import OrderModifyPanel from '../components/OrderModifyPanel';

/**
 * ICT Sniper — immediate bare entry on an "enter now" ict-breaker signal.
 *
 * The page has one job beyond the controller: make the unprotected window visible. Entries go in
 * with NO stop so the fill cannot be refused for invalid stops (29 of 29 of this account's MT5
 * rejections were exactly that), and the stop follows seconds later. Between those two moments a
 * live position has no floor under it, and that is the thing a screen must not let you forget.
 */
const GRADES = ['A+', 'A', 'B', 'C'];
const money = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(2)}`;

export default function SniperMode() {
  const [data, setData] = useState<SniperResponse | null>(null);
  const [cfg, setCfg] = useState<SniperConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modifying, setModifying] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetchSniper();
      setData(r);
      setCfg((prev) => prev ?? r.config);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not load sniper state');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); const t = setInterval(() => void load(), 20000); return () => clearInterval(t); }, [load]);

  const save = async () => {
    if (!cfg) return;
    setSaving(true); setError(null); setNotice(null);
    try {
      const r = await saveSniper(cfg);
      setCfg(r.config);
      setNotice(`Saved — sniper is ${r.config.enabled ? 'ON' : 'OFF'}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not save');
    } finally { setSaving(false); }
  };

  const toggleIn = (key: 'symbols' | 'timeframes', v: string) => {
    if (!cfg) return;
    const has = cfg[key].includes(v);
    setCfg({ ...cfg, [key]: has ? cfg[key].filter((x) => x !== v) : [...cfg[key], v] });
  };

  const open = useMemo(() => (data?.trades || []).filter((t) => t.status === 'FILLED'), [data]);
  const recent = useMemo(() => (data?.trades || []).slice(0, 25), [data]);
  const il = data?.interlocks;

  /** Why nothing is firing, in the order the gates actually apply. */
  const blockedBecause = useMemo(() => {
    if (!cfg || !il) return null;
    if (!cfg.enabled) return 'Sniper is switched off.';
    if (!cfg.symbols.length) return 'No symbols enabled — an empty list means none, never all.';
    if (!cfg.timeframes.length) return 'No timeframes enabled.';
    if (!il.bridgeReady) return 'The EA is not polling, so nothing can be dispatched.';
    if (!il.armedMatch) return 'The armed account does not match the one logged into MT5.';
    if (!['ASK', 'AUTO'].includes(il.autoTradeMode)) return `Auto-trade mode is ${il.autoTradeMode} — sniper dispatches only in ASK or AUTO.`;
    return null;
  }, [cfg, il]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-rose-100 p-2"><Crosshair className="text-rose-600" size={22} /></div>
          <div>
            <h1 className="text-xl font-black text-slate-900">Sniper Mode</h1>
            <p className="text-xs font-medium text-slate-400">
              ict-breaker &ldquo;enter now&rdquo; → immediate market entry, no stop, protected {cfg?.stopDelaySeconds ?? 10}s later.
            </p>
          </div>
        </div>
        <button type="button" onClick={() => void load()} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-bold text-slate-600 hover:bg-slate-50">
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}Refresh
        </button>
      </div>

      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-bold text-rose-700">{error}</div>}
      {notice && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-bold text-emerald-700">{notice}</div>}

      {/* The window this mode opens. Loudest thing on the page when it is real. */}
      {data && data.summary.unprotectedCount > 0 && (
        <div className="rounded-2xl border-2 border-rose-400 bg-rose-50 p-4">
          <div className="flex items-start gap-3">
            <ShieldAlert size={22} className="mt-0.5 shrink-0 text-rose-600" />
            <div>
              <h3 className="text-sm font-black uppercase tracking-wide text-rose-800">
                {data.summary.unprotectedCount} position{data.summary.unprotectedCount === 1 ? '' : 's'} running with NO stop
              </h3>
              <p className="mt-0.5 text-sm text-rose-900">
                The stop attaches {cfg?.stopDelaySeconds ?? 10}s after the fill. If this persists, the EA
                did not apply it — set one in MT5 by hand now.
              </p>
            </div>
          </div>
        </div>
      )}

      {blockedBecause && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-[13px] font-semibold text-amber-800">
          Nothing will fire: {blockedBecause}
        </div>
      )}

      {/* Summary */}
      {data && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {[
            { k: 'Open', v: data.summary.openCount, tone: 'border-sky-200 bg-sky-50 text-sky-800' },
            { k: 'Unprotected', v: data.summary.unprotectedCount, tone: data.summary.unprotectedCount ? 'border-rose-300 bg-rose-50 text-rose-800' : 'border-slate-200 bg-white text-slate-700' },
            { k: 'Today', v: `${data.summary.todayCount}/${cfg?.maxPerDay ?? '—'}`, tone: 'border-slate-200 bg-white text-slate-800' },
            { k: 'Closed', v: data.summary.closedCount, tone: 'border-slate-200 bg-white text-slate-800' },
            { k: 'Net', v: money(data.summary.netProfit), tone: (data.summary.netProfit ?? 0) < 0 ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800' },
          ].map((c) => (
            <div key={c.k} className={`rounded-xl border p-2.5 ${c.tone}`}>
              <div className="text-[10px] font-black uppercase tracking-wider opacity-70">{c.k}</div>
              <div className="text-xl font-black tabular-nums">{c.v}</div>
            </div>
          ))}
        </div>
      )}

      {/* Controller */}
      {cfg && data && (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-black uppercase tracking-wider text-slate-500">Controller</h3>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setCfg({ ...cfg, enabled: !cfg.enabled })}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-black ${cfg.enabled ? 'bg-rose-600 text-white' : 'border border-slate-300 bg-white text-slate-600'}`}>
                {cfg.enabled ? <ShieldAlert size={14} /> : <ShieldCheck size={14} />}
                {cfg.enabled ? 'SNIPER ON' : 'Sniper off'}
              </button>
              <button type="button" onClick={save} disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-bold text-white disabled:opacity-50">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}Save
              </button>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-[11px] font-bold uppercase text-slate-400">
              Risk per trade ($)
              <input type="number" min={1} max={500} value={cfg.riskUsd}
                onChange={(e) => setCfg({ ...cfg, riskUsd: Number(e.target.value) || 0 })}
                className="mt-0.5 w-full rounded border border-slate-200 px-2 py-1 text-sm font-bold text-slate-800" />
              <span className="mt-0.5 block font-normal normal-case text-slate-400">
                fixed dollar stop, independent of Account &amp; Sizing
              </span>
            </label>
            <label className="text-[11px] font-bold uppercase text-slate-400">
              Stop delay (s)
              <input type="number" min={3} max={120} value={cfg.stopDelaySeconds}
                onChange={(e) => setCfg({ ...cfg, stopDelaySeconds: Number(e.target.value) || 0 })}
                className="mt-0.5 w-full rounded border border-slate-200 px-2 py-1 text-sm font-bold text-slate-800" />
              <span className="mt-0.5 block font-normal normal-case text-slate-400">unprotected for this long</span>
            </label>
            <label className="text-[11px] font-bold uppercase text-slate-400">
              Min grade
              <select value={cfg.minGrade} onChange={(e) => setCfg({ ...cfg, minGrade: e.target.value })}
                className="mt-0.5 w-full rounded border border-slate-200 px-2 py-1 text-sm font-bold text-slate-800">
                {GRADES.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-[11px] font-bold uppercase text-slate-400">
                Max open
                <input type="number" min={1} max={10} value={cfg.maxConcurrent}
                  onChange={(e) => setCfg({ ...cfg, maxConcurrent: Number(e.target.value) || 1 })}
                  className="mt-0.5 w-full rounded border border-slate-200 px-2 py-1 text-sm font-bold text-slate-800" />
              </label>
              <label className="text-[11px] font-bold uppercase text-slate-400">
                Max / day
                <input type="number" min={1} max={100} value={cfg.maxPerDay}
                  onChange={(e) => setCfg({ ...cfg, maxPerDay: Number(e.target.value) || 1 })}
                  className="mt-0.5 w-full rounded border border-slate-200 px-2 py-1 text-sm font-bold text-slate-800" />
              </label>
            </div>
          </div>

          {/* Symbols and timeframes. Empty means NONE, and the label says so rather than
              leaving an empty list looking like "no restriction". */}
          {(['symbols', 'timeframes'] as const).map((key) => (
            <div key={key} className="mt-3">
              <div className="mb-1 text-[11px] font-black uppercase tracking-wider text-slate-400">
                {key} {cfg[key].length === 0 && <span className="text-rose-600">— none enabled, nothing will fire</span>}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(key === 'symbols' ? data.available.symbols : data.available.timeframes).map((v) => (
                  <button key={v} type="button" onClick={() => toggleIn(key, v)}
                    className={`rounded-md px-2 py-1 text-[11px] font-bold ${cfg[key].includes(v) ? 'bg-rose-600 text-white' : 'border border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
                    {v}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Open positions, each with inline SL/TP modify */}
      {open.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-black uppercase tracking-wider text-slate-500">Open sniper positions</h3>
          {open.map((t: SniperTrade) => (
            <div key={t.id} className={`rounded-2xl border p-3 ${t.unprotected ? 'border-rose-300 bg-rose-50' : 'border-slate-200 bg-white'}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-black text-slate-800">{t.symbol} {t.timeframe}</span>
                <span className={`font-black ${t.direction === 'BUY' ? 'text-emerald-700' : 'text-rose-600'}`}>{t.direction}</span>
                <span className="text-[12px] font-semibold text-slate-600">{t.lots} lots</span>
                {t.ticket && <span className="text-[11px] text-slate-400">#{t.ticket}</span>}
                {t.unprotected
                  ? <span className="inline-flex items-center gap-1 rounded bg-rose-600 px-1.5 py-0.5 text-[10px] font-black text-white"><ShieldAlert size={10} />NO STOP</span>
                  : <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-black text-emerald-700"><ShieldCheck size={10} />SL {t.stopLoss}</span>}
                <button type="button" onClick={() => setModifying((m) => (m === t.id ? null : t.id))}
                  className={`ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-bold ${modifying === t.id ? 'bg-slate-900 text-white' : 'border border-slate-200 text-slate-600 hover:border-sky-300'}`}>
                  <Pencil size={12} />Modify SL/TP
                </button>
              </div>
              <p className="mt-1 text-[11px] font-semibold text-slate-500">
                filled {t.fillPrice} · risk {money(t.riskUsd)} · {t.reason}
              </p>
              {modifying === t.id && (
                <OrderModifyPanel orderId={t.id} onDone={() => { setModifying(null); void load(); }} />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Decisions — fires AND skips. A page showing only fires would make an over-tight
          filter look like a quiet market. */}
      {data && data.decisions.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-black uppercase tracking-wider text-slate-500">Recent decisions</h3>
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
            {data.decisions.map((d, i) => (
              <div key={i} className="flex items-start gap-2 border-b border-slate-100 px-3 py-1.5 last:border-0 text-[12px]">
                {d.fired ? <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-600" />
                  : <XCircle size={13} className="mt-0.5 shrink-0 text-slate-300" />}
                <span className="w-24 shrink-0 text-slate-400">{String(d.at).slice(11, 19)}</span>
                <span className="w-32 shrink-0 font-bold text-slate-700">{d.symbol} {d.timeframe}</span>
                <span className={d.fired ? 'font-semibold text-emerald-700' : 'text-slate-500'}>{d.reason}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent trades */}
      {recent.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
          <table className="w-full min-w-[720px] text-[12px]">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left font-black">When</th>
                <th className="px-3 py-2 text-left font-black">Market</th>
                <th className="px-3 py-2 text-right font-black">Lots</th>
                <th className="px-3 py-2 text-right font-black">Stop</th>
                <th className="px-3 py-2 text-right font-black">P&amp;L</th>
                <th className="px-3 py-2 text-left font-black">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {recent.map((t) => (
                <tr key={t.id}>
                  <td className="px-3 py-1.5 text-slate-500">{String(t.createdAt).slice(5, 16).replace('T', ' ')}</td>
                  <td className="px-3 py-1.5 font-bold text-slate-700">{t.symbol} {t.timeframe} <span className={t.direction === 'BUY' ? 'text-emerald-600' : 'text-rose-600'}>{t.direction}</span></td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{t.lots ?? '—'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{t.stopLoss ?? <span className="font-bold text-rose-600">none</span>}</td>
                  <td className={`px-3 py-1.5 text-right tabular-nums font-bold ${(t.profit ?? 0) > 0 ? 'text-emerald-700' : (t.profit ?? 0) < 0 ? 'text-rose-700' : 'text-slate-400'}`}>
                    {t.profit === null ? '—' : money(t.profit)}
                  </td>
                  <td className="px-3 py-1.5"><span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-600">{t.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && (
        <p className="flex gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[12px] font-semibold text-amber-900">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />{data.note}
        </p>
      )}
    </div>
  );
}
