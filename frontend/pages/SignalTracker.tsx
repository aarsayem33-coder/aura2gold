import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Radar, TrendingUp, TrendingDown, AlertTriangle, ShieldCheck, Mail, Cpu, Check } from 'lucide-react';
import { fetchSignalTracker, markSignalTrackerDone } from '../mt5Api';
import type { SignalTrackerResponse, SignalTrackerItem } from '../types';

const REFRESH_MS = 20000;

function fmt(v: number | null | undefined, d = 2) {
  return v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(d);
}
function fmtTime(iso: string) {
  try { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
}

function DirTag({ d }: { d: string }) {
  const up = /BUY/.test(d);
  return <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-black ${up ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>{up ? <TrendingUp size={11} /> : <TrendingDown size={11} />}{d.replace('_', ' ')}</span>;
}

function RiskBadge({ item }: { item: SignalTrackerItem }) {
  const map: Record<string, string> = {
    CLOSE_NOW: 'bg-rose-600 text-white',
    DANGER: 'bg-amber-500 text-white',
    CAUTION: 'bg-amber-100 text-amber-700 border border-amber-200',
    HEALTHY: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
    UNKNOWN: 'bg-slate-100 text-slate-400',
  };
  const label = item.status === 'STOPPED' ? 'STOPPED'
    : item.status.endsWith('_HIT') ? item.status.replace('_', ' ')
    : item.riskState;
  return <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-black ${map[item.riskState] || map.UNKNOWN}`}>
    {item.riskState === 'CLOSE_NOW' && <AlertTriangle size={11} />}
    {item.riskState === 'HEALTHY' && <ShieldCheck size={11} />}
    {label}
  </span>;
}

function PnL({ item }: { item: SignalTrackerItem }) {
  const r = item.currentR;
  const cls = r === null ? 'text-slate-400' : r > 0 ? 'text-emerald-600' : r < 0 ? 'text-rose-600' : 'text-slate-500';
  return (
    <div className="text-right">
      <div className={`font-mono font-bold ${cls}`}>{item.currentPips != null ? `${item.currentPips > 0 ? '+' : ''}${item.currentPips}p` : '—'}</div>
      <div className={`font-mono text-[11px] ${cls}`}>{r != null ? `${r > 0 ? '+' : ''}${r}R` : ''}</div>
    </div>
  );
}

// Progress along entry → TP1, with current price position (capped 0–100).
function ProgressBar({ item }: { item: SignalTrackerItem }) {
  const { entryPrice: e, stopLoss: sl, takeProfit1: tp, currentPrice: cur, direction } = item;
  if (e === null || sl === null || tp === null || cur === null) return <span className="text-slate-300 text-xs">—</span>;
  const up = /BUY/.test(direction);
  const lo = Math.min(sl, tp), hi = Math.max(sl, tp);
  const pct = Math.max(0, Math.min(100, ((cur - lo) / (hi - lo)) * 100));
  const entryPct = Math.max(0, Math.min(100, ((e - lo) / (hi - lo)) * 100));
  return (
    <div className="relative h-2.5 w-28 rounded-full bg-gradient-to-r from-rose-200 via-slate-100 to-emerald-200" title={`SL ${fmt(sl)} · Entry ${fmt(e)} · TP1 ${fmt(tp)} · Now ${fmt(cur)}`}>
      <div className="absolute top-1/2 h-3 w-0.5 -translate-y-1/2 bg-slate-400" style={{ left: `${entryPct}%` }} />
      <div className={`absolute top-1/2 h-3.5 w-1.5 -translate-y-1/2 rounded-full ${up ? 'bg-emerald-600' : 'bg-rose-600'}`} style={{ left: `calc(${pct}% - 3px)` }} />
    </div>
  );
}

export default function SignalTracker() {
  const [data, setData] = useState<SignalTrackerResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchSignalTracker());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load signal tracker');
    } finally {
      setLoading(false);
    }
  }, []);

  const markDone = useCallback(async (id: string) => {
    setDoneIds((prev) => new Set(prev).add(id));  // optimistic remove
    try {
      await markSignalTrackerDone(id);
    } catch {
      setDoneIds((prev) => { const n = new Set(prev); n.delete(id); return n; });  // revert on failure
      setError('Failed to mark trade as done — try again.');
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const items = (data?.items || []).filter((i) => !doneIds.has(i.id));
  const closeNow = items.filter((i) => i.riskState === 'CLOSE_NOW');
  const danger = items.filter((i) => i.riskState === 'DANGER');

  return (
    <div className="space-y-5 p-1">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-indigo-100 p-2"><Radar className="text-indigo-600" size={22} /></div>
          <div>
            <h1 className="text-xl font-black text-slate-900">Signal Tracker</h1>
            <p className="text-xs font-medium text-slate-400">Live health of given signals — P&amp;L, danger detection, close/manage alerts.</p>
          </div>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-bold text-white hover:bg-slate-700 disabled:opacity-50">
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Refresh
        </button>
      </div>

      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">{error}</div>}

      {/* Urgent banner */}
      {closeNow.length > 0 && (
        <div className="rounded-2xl border border-rose-300 bg-rose-50 p-4">
          <div className="flex items-center gap-2 text-rose-700 font-black"><AlertTriangle size={18} /> {closeNow.length} trade{closeNow.length > 1 ? 's' : ''} flagged CLOSE NOW</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {closeNow.map((i) => (
              <span key={i.id} className="rounded-lg border border-rose-200 bg-white px-2.5 py-1 text-[12px] font-bold text-rose-700">{i.symbol} {i.timeframe} {i.direction.replace('_', ' ')} · {i.currentR != null ? `${i.currentR}R` : ''} · {i.warningReason}</span>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-card"><div className="text-[11px] font-bold uppercase text-slate-400">Tracking</div><div className="text-2xl font-black text-slate-900">{items.length}</div></div>
        <div className="rounded-2xl border border-rose-200 bg-rose-50/50 p-3 shadow-card"><div className="text-[11px] font-bold uppercase text-rose-500">Close now</div><div className="text-2xl font-black text-rose-700">{closeNow.length}</div></div>
        <div className="rounded-2xl border border-amber-200 bg-amber-50/50 p-3 shadow-card"><div className="text-[11px] font-bold uppercase text-amber-500">Danger</div><div className="text-2xl font-black text-amber-700">{danger.length}</div></div>
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-3 shadow-card"><div className="text-[11px] font-bold uppercase text-emerald-600">Healthy</div><div className="text-2xl font-black text-emerald-700">{items.filter((i) => i.riskState === 'HEALTHY').length}</div></div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white shadow-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="border-b border-slate-100 text-[10px] uppercase tracking-[0.15em] text-slate-500">
              <tr>
                <th className="px-3 py-2">Signal</th>
                <th className="px-3 py-2">Dir</th>
                <th className="px-3 py-2 text-right">Entry / SL / TP1</th>
                <th className="px-3 py-2 text-right">Now</th>
                <th className="px-3 py-2">Progress</th>
                <th className="px-3 py-2 text-right">P&amp;L</th>
                <th className="px-3 py-2 text-right">Live $</th>
                <th className="px-3 py-2">State</th>
                <th className="px-3 py-2">What to do</th>
                <th className="px-3 py-2 text-center">Done</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {items.length ? items.map((i) => (
                <tr key={i.id} className={`hover:bg-slate-50/70 ${i.riskState === 'CLOSE_NOW' ? 'bg-rose-50/40' : ''}`}>
                  <td className="px-3 py-2">
                    <div className="font-black text-slate-900">{i.symbol} <span className="text-[10px] font-bold text-slate-400">{i.timeframe}</span></div>
                    <div className="flex items-center gap-1 text-[10px] font-semibold text-slate-400">
                      {i.source === 'email' ? <><Mail size={10} /> emailed</> : <><Cpu size={10} /> system</>} · {fmtTime(i.signalTime)}
                    </div>
                  </td>
                  <td className="px-3 py-2"><DirTag d={i.direction} /></td>
                  <td className="px-3 py-2 text-right font-mono text-[11px] text-slate-500">{fmt(i.entryPrice)} / {fmt(i.stopLoss)} / {fmt(i.takeProfit1)}</td>
                  <td className="px-3 py-2 text-right font-mono">{fmt(i.currentPrice)}</td>
                  <td className="px-3 py-2"><ProgressBar item={i} /></td>
                  <td className="px-3 py-2"><PnL item={i} /></td>
                  <td className="px-3 py-2 text-right font-mono">{i.unrealizedProfit != null ? <span className={i.unrealizedProfit >= 0 ? 'text-emerald-600 font-bold' : 'text-rose-600 font-bold'}>{i.unrealizedProfit}</span> : <span className="text-slate-300">—</span>}</td>
                  <td className="px-3 py-2"><RiskBadge item={i} /></td>
                  <td className="px-3 py-2 text-[12px]">
                    <div className="font-semibold text-slate-700">{i.warningReason}</div>
                    {i.riskState !== 'HEALTHY' && <div className="text-[11px] text-slate-500">→ {i.suggestedAction}</div>}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <button
                      type="button"
                      onClick={() => void markDone(i.id)}
                      title="I closed this trade — stop tracking & alerting"
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-bold text-slate-600 hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700"
                    >
                      <Check size={12} /> Done
                    </button>
                  </td>
                </tr>
              )) : (
                <tr><td colSpan={10} className="px-3 py-10 text-center text-sm font-medium text-slate-400">{loading ? 'Loading…' : 'No active signals being tracked right now.'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {data?.note && <p className="text-[11px] font-medium text-slate-400 px-1">{data.note}</p>}
    </div>
  );
}
