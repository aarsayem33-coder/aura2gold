import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Mail, CheckCircle2, Clock } from 'lucide-react';
import { fetchLiquidityEvents } from '../mt5Api';
import type { LiquidityEventsResponse, LiquidityEvent } from '../mt5Api';

/**
 * Key liquidity levels that were alerted, and what price actually did with them.
 *
 * The alert only says price ARRIVED at a level. The tradeable question is what followed:
 * RECLAIMED (taken, rejected back — fade it) or BROKE_AND_HELD (closed through and held —
 * follow it). Nothing recorded either until now, because the chart recomputes from candles on
 * every load and keeps no memory.
 *
 * `confirmed` is deliberately a separate column from `status`, not a filter baked into it. A
 * status is available immediately; confirmation only arrives once the evidence the playbook
 * trades has appeared. Collapsing the two would either leave the table empty most of the time
 * or dress up a coin flip as a result.
 */
const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  RECLAIMED: { label: 'Reclaimed', cls: 'bg-amber-100 text-amber-800' },
  BROKE_AND_HELD: { label: 'Broke & held', cls: 'bg-sky-100 text-sky-800' },
  NO_FOLLOW_THROUGH: { label: 'No follow-through', cls: 'bg-slate-100 text-slate-500' },
  WAITING: { label: 'Waiting', cls: 'bg-slate-100 text-slate-500' },
  DEAD: { label: 'Spent', cls: 'bg-slate-100 text-slate-400' },
};

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
const dots = (n: number | null) => '●'.repeat(Math.max(0, Math.min(5, n ?? 0))) || '—';

export default function LiquidityEventTable({ symbol }: { symbol?: string }) {
  const [data, setData] = useState<LiquidityEventsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(14);
  const [sym, setSym] = useState(symbol || 'ALL');
  const [confirmedOnly, setConfirmedOnly] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchLiquidityEvents({ days, symbol: sym, confirmedOnly }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not load liquidity events');
    } finally { setLoading(false); }
  }, [days, sym, confirmedOnly]);

  useEffect(() => { void load(); }, [load]);

  const s = data?.summary;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-black uppercase tracking-wider text-slate-600">Key level tracker</h2>
        <span className="text-[11px] font-semibold text-slate-400">alerted levels · what price did next</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select value={sym} onChange={(e) => setSym(e.target.value)}
            className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-bold text-slate-600">
            <option value="ALL">All symbols</option>
            {(data?.symbols || []).map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}
            className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-bold text-slate-600">
            {[7, 14, 30, 90].map((d) => <option key={d} value={d}>{d}d</option>)}
          </select>
          <button type="button" onClick={() => setConfirmedOnly((v) => !v)}
            className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-bold ${confirmedOnly ? 'bg-emerald-600 text-white' : 'border border-slate-200 text-slate-600'}`}>
            <CheckCircle2 size={12} />Confirmed only
          </button>
          <button type="button" onClick={load}
            className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-400 hover:text-slate-600">
            {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}Refresh
          </button>
        </div>
      </div>

      {error && <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] font-bold text-rose-600">{error}</p>}

      {s && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            { k: 'Alerts', v: s.alerts, sub: `${s.waiting} waiting` },
            { k: 'Reclaimed', v: s.reclaimed, sub: `fade · ${pct(s.reclaimRate)} of resolved` },
            { k: 'Broke & held', v: s.brokeAndHeld, sub: 'follow' },
            // The gap between resolved and confirmed is the honest headline: a low rate means
            // the alerts are firing on levels that mostly do nothing either way.
            { k: 'Confirmed', v: s.confirmed.resolved, sub: `${pct(s.confirmed.confirmationRate)} of resolved` },
          ].map((c) => (
            <div key={c.k} className="rounded-xl border border-slate-200 bg-white p-2.5">
              <div className="text-[10px] font-black uppercase tracking-wider text-slate-400">{c.k}</div>
              <div className="text-xl font-black tabular-nums text-slate-800">{c.v}</div>
              <div className="text-[11px] font-semibold text-slate-400">{c.sub}</div>
            </div>
          ))}
        </div>
      )}

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[900px] text-[12px]">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-2.5 py-2 text-left font-black">Alerted</th>
              <th className="px-2.5 py-2 text-left font-black">Market</th>
              <th className="px-2.5 py-2 text-left font-black">Level</th>
              <th className="px-2.5 py-2 text-center font-black">Mail</th>
              <th className="px-2.5 py-2 text-left font-black">Outcome</th>
              <th className="px-2.5 py-2 text-center font-black">Confirmed</th>
              <th className="px-2.5 py-2 text-center font-black">Trade</th>
              <th className="px-2.5 py-2 text-right font-black">For / against</th>
              <th className="px-2.5 py-2 text-right font-black">Bars</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(data?.events || []).map((e: LiquidityEvent) => {
              const st = STATUS_STYLE[e.status] || STATUS_STYLE.WAITING;
              const worked = e.followThroughPips !== null && e.adversePips !== null
                && e.followThroughPips > e.adversePips;
              return (
                <tr key={e.id} className={e.confirmed ? '' : 'opacity-80'}>
                  <td className="px-2.5 py-2 whitespace-nowrap text-slate-500">{String(e.alertedAt).slice(5, 16).replace('T', ' ')}</td>
                  <td className="px-2.5 py-2 font-bold text-slate-700">{e.symbol} <span className="text-slate-400">{e.timeframe}</span></td>
                  <td className="px-2.5 py-2">
                    <div className="font-bold text-slate-800">{e.level}</div>
                    <div className="text-[10px] font-semibold text-slate-400">
                      {e.levelLabel || e.levelType || 'level'} {dots(e.strength)} · {e.side === 'above' ? 'buy-side' : 'sell-side'}
                    </div>
                  </td>
                  <td className="px-2.5 py-2 text-center">{e.emailed ? <Mail size={12} className="mx-auto text-emerald-600" /> : <span className="text-slate-300">—</span>}</td>
                  <td className="px-2.5 py-2">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${st.cls}`}>{st.label}</span>
                    {e.evidence && <div className="mt-0.5 max-w-[280px] truncate text-[10px] text-slate-400" title={e.evidence}>{e.evidence}</div>}
                  </td>
                  <td className="px-2.5 py-2 text-center">
                    {e.confirmed
                      ? <CheckCircle2 size={13} className="mx-auto text-emerald-600" />
                      : <Clock size={13} className="mx-auto text-slate-300" />}
                  </td>
                  <td className="px-2.5 py-2 text-center">
                    {e.direction
                      ? <span className={`font-black ${e.direction === 'BUY' ? 'text-emerald-700' : 'text-rose-600'}`}>{e.direction}</span>
                      : <span className="text-slate-300">—</span>}
                  </td>
                  <td className={`px-2.5 py-2 text-right tabular-nums ${worked ? 'text-emerald-700 font-bold' : 'text-slate-500'}`}>
                    {e.followThroughPips === null ? '—' : `${e.followThroughPips} / ${e.adversePips ?? '—'}`}
                  </td>
                  <td className="px-2.5 py-2 text-right tabular-nums text-slate-400">{e.barsToResolve ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {!loading && !data?.events.length && (
        <p className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-[12px] text-slate-500">
          No alerted levels in this window yet. Rows appear as key-level alerts fire; the outcome
          fills in as price resolves each one.
        </p>
      )}

      {data && (
        <p className="text-[11px] text-slate-400">{data.note}</p>
      )}
    </div>
  );
}
