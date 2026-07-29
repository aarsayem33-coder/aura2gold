import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Target, Clock, Brain, AlertTriangle } from 'lucide-react';
import { fetchPredictionReport } from '../mt5Api';
import type { PredictionReportResponse, PredictionGroupRow } from '../types';

const OUTCOME: Record<string, string> = {
  MATCHED: 'bg-emerald-100 text-emerald-800',
  MISSED: 'bg-rose-100 text-rose-800',
  EXPIRED: 'bg-amber-100 text-amber-800',
  PENDING: 'bg-slate-100 text-slate-500',
  AMBIGUOUS: 'bg-violet-100 text-violet-800',
  INVALID: 'bg-slate-200 text-slate-500',
};

function Stat({ label, value, sub, tone = 'slate' }: { label: string; value: string; sub?: string; tone?: string }) {
  const tones: Record<string, string> = {
    slate: 'text-slate-800', emerald: 'text-emerald-600', rose: 'text-rose-600', amber: 'text-amber-600',
  };
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">{label}</p>
      <p className={`text-lg font-black ${tones[tone] || tones.slate}`}>{value}</p>
      {sub && <p className="text-[10px] font-medium text-slate-400">{sub}</p>}
    </div>
  );
}

function GroupTable({ title, rows }: { title: string; rows: PredictionGroupRow[] }) {
  if (!rows?.length) return null;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-card">
      <div className="border-b border-slate-100 px-5 py-2.5"><h3 className="text-sm font-bold text-slate-900">{title}</h3></div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-3 py-2">Key</th><th className="px-3 py-2">Predicted</th>
              <th className="px-3 py-2">Settled</th><th className="px-3 py-2">Matched</th>
              <th className="px-3 py-2">Missed</th><th className="px-3 py-2">Expired</th>
              <th className="px-3 py-2">Accuracy</th><th className="px-3 py-2">Said / took</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="px-3 py-1.5 font-bold text-slate-700">{r.key}</td>
                <td className="px-3 py-1.5 text-slate-500">{r.predicted}</td>
                <td className="px-3 py-1.5 text-slate-500">{r.settled}</td>
                <td className="px-3 py-1.5 font-bold text-emerald-600">{r.matched}</td>
                <td className="px-3 py-1.5 font-bold text-rose-600">{r.missed}</td>
                <td className="px-3 py-1.5 text-amber-600">{r.expired}</td>
                <td className="px-3 py-1.5">
                  {r.accuracy === null ? <span className="text-slate-400">—</span> : (
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${r.accuracy >= 55 ? 'bg-emerald-50 text-emerald-700' : r.accuracy >= 45 ? 'bg-slate-100 text-slate-600' : 'bg-rose-50 text-rose-600'}`}>
                      {r.accuracy}%
                    </span>
                  )}
                </td>
                <td className="px-3 py-1.5 font-mono text-[10px] text-slate-400">
                  {r.predictedMinutes ?? '—'}m / {r.actualMinutes ?? '—'}m
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function PredictionReport({ days = 30 }: { days?: number }) {
  const [data, setData] = useState<PredictionReportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (spin = false) => {
    if (spin) setLoading(true);
    try { setData(await fetchPredictionReport(days)); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed to load'); }
    finally { setLoading(false); }
  }, [days]);

  useEffect(() => {
    load(true);
    const t = setInterval(() => load(false), 60000);
    return () => clearInterval(t);
  }, [load]);

  if (err) return <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm font-semibold text-rose-700">{err}</div>;
  if (!data) return <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-slate-400"><Loader2 className="mx-auto animate-spin" /> Loading prediction report…</div>;

  const s = data.summary;
  const noneSettled = s.settled === 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-black text-slate-900">
          <Brain size={16} className="text-violet-500" />Prediction accuracy
          <span className="text-[11px] font-semibold text-slate-400">last {data.window.days} days</span>
        </h2>
        <button onClick={() => load(true)} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-bold text-slate-600 hover:bg-slate-50">
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}Refresh
        </button>
      </div>

      {/* A prediction only counts once it has actually resolved — say so rather than
          showing a confident 0% built on nothing. */}
      {noneSettled && (
        <div className="flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-900">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span>
            {s.predicted} prediction{s.predicted === 1 ? '' : 's'} recorded, none resolved yet. Accuracy appears once a
            setup reaches TP1 or its stop — the resolver checks every 5 minutes against real candles.
          </span>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
        <Stat label="Accuracy" value={s.accuracy === null ? '—' : `${s.accuracy}%`}
          tone={(s.accuracy ?? 0) >= 55 ? 'emerald' : (s.accuracy ?? 100) < 45 ? 'rose' : 'slate'}
          sub={`${s.matched} matched / ${s.missed} missed`} />
        <Stat label="Predicted" value={String(s.predicted)} sub={`${s.settled} settled · ${s.pending} pending`} />
        <Stat label="Timing hit rate" value={s.timingHitRate === null ? '—' : `${s.timingHitRate}%`}
          tone={(s.timingHitRate ?? 0) >= 60 ? 'emerald' : 'amber'}
          sub="resolved inside the window it promised" />
        <Stat label="Expired" value={String(s.expired)} tone="amber" sub="right or wrong — just too slow" />
        <Stat label="Said / took" value={`${s.predictedMinutes ?? '—'}m / ${s.actualMinutes ?? '—'}m`}
          sub="predicted vs actual minutes" />
        <Stat label="Run-up / drawdown" value={`${s.avgMfePips ?? '—'} / ${s.avgMaePips ?? '—'}p`}
          sub="avg best & worst excursion" />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <GroupTable title="By strategy" rows={data.byStrategy} />
        <GroupTable title="By symbol" rows={data.bySymbol} />
        <GroupTable title="By timeframe" rows={data.byTimeframe} />
        <GroupTable title="By grade" rows={data.byGrade} />
      </div>

      {/* The actual predictions, so any number above can be traced to rows. */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-card">
        <div className="border-b border-slate-100 px-5 py-2.5">
          <h3 className="text-sm font-bold text-slate-900">Recent predictions</h3>
          <p className="text-[11px] font-medium text-slate-400">{data.note}</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2">When</th><th className="px-3 py-2">Strategy</th>
                <th className="px-3 py-2">Symbol</th><th className="px-3 py-2">TF</th>
                <th className="px-3 py-2">Dir</th><th className="px-3 py-2">Score</th>
                <th className="px-3 py-2">R:R</th><th className="px-3 py-2">Outcome</th>
                <th className="px-3 py-2">Said / took</th><th className="px-3 py-2">Run-up / DD</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.recent.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-1.5 font-mono text-[10px] text-slate-400">{r.predictedAt ? new Date(r.predictedAt).toLocaleString() : '—'}</td>
                  <td className="px-3 py-1.5 font-bold text-slate-700">{r.strategy}</td>
                  <td className="px-3 py-1.5 font-bold text-slate-800">{r.symbol}</td>
                  <td className="px-3 py-1.5 text-slate-500">{r.timeframe}</td>
                  <td className={`px-3 py-1.5 font-black ${r.direction === 'BUY' ? 'text-emerald-600' : 'text-rose-600'}`}>{r.direction}</td>
                  <td className="px-3 py-1.5 text-slate-600">{r.score ?? '—'}{r.grade ? ` ${r.grade}` : ''}</td>
                  <td className="px-3 py-1.5 text-slate-500">{r.rr ?? '—'}</td>
                  <td className="px-3 py-1.5">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${OUTCOME[r.outcome] || 'bg-slate-100 text-slate-500'}`}>{r.outcome}</span>
                  </td>
                  <td className="px-3 py-1.5 font-mono text-[10px] text-slate-400">{r.predictedMinutes ?? '—'}m / {r.actualMinutes ?? '—'}m</td>
                  <td className="px-3 py-1.5 font-mono text-[10px] text-slate-400">{r.mfePips ?? '—'} / {r.maePips ?? '—'}</td>
                </tr>
              ))}
              {!data.recent.length && <tr><td colSpan={10} className="px-3 py-6 text-center text-slate-400">No predictions recorded yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
