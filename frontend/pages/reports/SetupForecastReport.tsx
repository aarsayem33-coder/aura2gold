import React, { useCallback, useEffect, useState } from 'react';
import { Crosshair, Loader2, RefreshCcw, Info } from 'lucide-react';
import { ReportsTabs, ErrorBanner } from './_shared';
import { fetchSetupForecastReport } from '../../mt5Api';
import type { SetupForecastReportResponse } from '../../types';

// How the conditional forecasts actually turned out. Two rates, kept deliberately separate:
//   arrival rate — did price ever reach the level inside the window?
//   match rate   — of those that arrived, did it behave the way the scenario predicted?
// Collapsing them into one number would let a wrong-but-never-tested forecast look the same
// as a correct one, which is exactly what makes accuracy claims meaningless.

const DAY_OPTIONS = [1, 7, 14, 30, 90];
const pctText = (v: number | null) => (v === null || v === undefined ? 'n/a' : `${v}%`);
const numText = (v: number | null) => (v === null || v === undefined ? 'n/a' : String(v));

function Stat({ label, value, sub, tone = 'slate' }: { label: string; value: string; sub?: string; tone?: string }) {
  const tones: Record<string, string> = {
    slate: 'border-slate-200 bg-white text-slate-800',
    emerald: 'border-emerald-200 bg-emerald-50/60 text-emerald-800',
    amber: 'border-amber-200 bg-amber-50/60 text-amber-800',
    violet: 'border-violet-200 bg-violet-50/60 text-violet-800',
  };
  return (
    <div className={`rounded-2xl border px-4 py-3 shadow-sm ${tones[tone] || tones.slate}`}>
      <p className="text-[11px] font-bold uppercase tracking-wider opacity-70">{label}</p>
      <p className="text-xl font-black">{value}</p>
      {sub ? <p className="mt-0.5 text-[10px] font-semibold opacity-60">{sub}</p> : null}
    </div>
  );
}

function GroupTable({ title, rows, keyLabel }: {
  title: string;
  keyLabel: string;
  rows: Array<{ key: string; resolved: number; matched: number; matchRate: number | null }>;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="mb-2 text-sm font-black text-slate-700">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-[12px] font-semibold text-slate-400">Nothing has resolved yet in this window.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[320px] text-left text-[12px]">
            <thead>
              <tr className="border-b border-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                <th className="py-1 pr-3">{keyLabel}</th>
                <th className="py-1 pr-3">Arrived</th>
                <th className="py-1 pr-3">Matched</th>
                <th className="py-1">Match rate</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-b border-slate-50 font-semibold text-slate-600">
                  <td className="py-1 pr-3">{r.key}</td>
                  <td className="py-1 pr-3">{r.resolved}</td>
                  <td className="py-1 pr-3">{r.matched}</td>
                  <td className="py-1">
                    <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${
                      r.matchRate === null ? 'bg-slate-100 text-slate-500'
                        : r.matchRate >= 60 ? 'bg-emerald-50 text-emerald-700'
                          : r.matchRate >= 35 ? 'bg-amber-50 text-amber-700' : 'bg-rose-50 text-rose-600'
                    }`}>{pctText(r.matchRate)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function SetupForecastReport() {
  const [days, setDays] = useState(14);
  const [data, setData] = useState<SetupForecastReportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (spin = false) => {
    if (spin) setLoading(true);
    try { setData(await fetchSetupForecastReport(days)); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to load report'); }
    finally { setLoading(false); }
  }, [days]);

  useEffect(() => { load(true); }, [load]);

  const t = data?.totals;
  const etaErr = data?.timing?.avgActualMinutes !== null && data?.timing?.avgActualMinutes !== undefined
    && data?.timing?.avgEtaMidMinutes !== null && data?.timing?.avgEtaMidMinutes !== undefined
    ? Math.round(data.timing.avgActualMinutes - data.timing.avgEtaMidMinutes)
    : null;

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 pb-24">
      <ReportsTabs />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-black text-slate-900">
            <Crosshair size={20} className="text-violet-500" />Setup Forecast Accuracy
          </h1>
          <p className="text-sm font-semibold text-slate-500">
            How many conditional forecasts were made, how many price actually reached, and how many played out the predicted way.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-lg border border-slate-200 bg-slate-50 p-0.5">
            {DAY_OPTIONS.map((d) => (
              <button key={d} type="button" onClick={() => setDays(d)}
                className={`rounded-md px-2.5 py-1 text-xs font-bold transition ${days === d ? 'bg-violet-600 text-white' : 'text-slate-500 hover:bg-white'}`}>
                {d}d
              </button>
            ))}
          </div>
          <button onClick={() => load(true)} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-bold text-slate-600 hover:bg-slate-50">
            {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCcw size={15} />}Refresh
          </button>
        </div>
      </div>

      <ErrorBanner error={error} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Forecasts made" value={numText(t?.forecasts ?? null)} sub={`${t?.waiting ?? 0} still waiting`} tone="violet" />
        <Stat label="Price arrived" value={numText(t?.resolved ?? null)}
          sub={`${pctText(t?.arrivalRate ?? null)} of those that had a verdict`} />
        <Stat label="Played out as predicted" value={numText(t?.matched ?? null)} tone="emerald"
          sub={`${pctText(t?.matchRate ?? null)} of arrivals`} />
        <Stat label="Never arrived" value={numText(t?.expired ?? null)} tone="amber"
          sub="condition never occurred — not a wrong call" />
        <Stat label="Premise changed" value={numText(t?.superseded ?? null)}
          sub="level swept or setup gone before arrival" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="mb-2 text-sm font-black text-slate-700">Timing accuracy</h3>
          <div className="space-y-1 text-[12px] font-semibold text-slate-600">
            <p>Predicted arrival (avg mid-ETA): <b>{numText(data?.timing?.avgEtaMidMinutes ?? null)} min</b></p>
            <p>Actual arrival (avg): <b>{numText(data?.timing?.avgActualMinutes ?? null)} min</b></p>
            <p className={etaErr === null ? 'text-slate-400' : Math.abs(etaErr) <= 30 ? 'text-emerald-700' : 'text-amber-700'}>
              Error: <b>{etaErr === null ? 'n/a' : `${etaErr > 0 ? '+' : ''}${etaErr} min`}</b>
              {etaErr !== null && Math.abs(etaErr) <= 30 ? ' — the ETA band is holding up' : ''}
            </p>
          </div>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="mb-2 text-sm font-black text-slate-700">Follow-through on matched forecasts</h3>
          <div className="space-y-1 text-[12px] font-semibold text-slate-600">
            <p>Best move in the predicted direction: <b className="text-emerald-700">{numText(data?.followThrough?.matchedAvgMfePips ?? null)} pips</b></p>
            <p>Worst move against it: <b className="text-rose-600">{numText(data?.followThrough?.matchedAvgMaePips ?? null)} pips</b></p>
            <p className="text-[11px] font-medium text-slate-400">
              Measured over the bars after the event. A matched scenario is not the same as a winning trade — this shows whether the move followed.
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <GroupTable title="By scenario" keyLabel="Scenario" rows={data?.byScenario || []} />
        <GroupTable title="By leading strategy" keyLabel="Strategy" rows={data?.byStrategy || []} />
        <GroupTable title="By symbol" keyLabel="Symbol" rows={data?.bySymbol || []} />
      </div>

      {(data?.actualsWhenMismatched?.length || 0) > 0 && (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="mb-2 text-sm font-black text-slate-700">When it missed, what happened instead</h3>
          <div className="flex flex-wrap gap-2">
            {data!.actualsWhenMismatched.map((a) => (
              <span key={a.actual} className="rounded-lg bg-slate-100 px-2.5 py-1 text-[12px] font-bold text-slate-600">
                {a.actual === 'GAPPED' ? 'gapped past the level' : a.actual.replace('_', ' ').toLowerCase()}
                <span className="ml-1.5 text-slate-400">×{a.count}</span>
              </span>
            ))}
          </div>
          <p className="mt-2 flex items-start gap-1.5 text-[11px] font-semibold text-slate-400">
            <Info size={12} className="mt-0.5 shrink-0" />
            A miss names what price actually did, so a wrong scenario is distinguishable from a wrong level.
          </p>
        </div>
      )}
    </div>
  );
}
