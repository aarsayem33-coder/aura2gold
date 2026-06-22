import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ClipboardList, Timer, TrendingUp } from 'lucide-react';
import { fetchForexEmailReports, fetchFixedEmailReports, fetchSignalLog } from '../../mt5Api';
import type { SignalLogResponse, TradeReportSummary } from '../../types';
import { ReportsHeader, ReportsTabs, SummaryCards, ErrorBanner, rangeToParams, type RangeKey } from './_shared';

export default function ReportsOverview() {
  const [range, setRange] = useState<RangeKey>('d30');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forex, setForex] = useState<TradeReportSummary | null>(null);
  const [fixed, setFixed] = useState<TradeReportSummary | null>(null);
  const [signalLog, setSignalLog] = useState<SignalLogResponse | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = rangeToParams(range);
      const [f, x, log] = await Promise.all([
        fetchForexEmailReports({ ...p, limit: 1 }),
        fetchFixedEmailReports({ ...p, limit: 1 }),
        fetchSignalLog({ ...p, limit: 1 }),
      ]);
      setForex(f.summary);
      setFixed(x.summary);
      setSignalLog(log);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load reports overview');
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-6">
      <ReportsHeader
        title="Reports Overview"
        subtitle="Headline performance across emailed alerts and all executable system signals"
        range={range} setRange={setRange} onRefresh={() => void load()} loading={loading}
      />
      <ReportsTabs />
      <ErrorBanner error={error} />

      {forex && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-lg font-bold text-slate-900"><TrendingUp size={18} className="text-amber-500" /> Forex (emailed)</h3>
            <Link to="/reports/forex" className="inline-flex items-center gap-1 text-sm font-bold text-amber-700 hover:underline">Details <ArrowRight size={14} /></Link>
          </div>
          <SummaryCards summary={forex} market="forex" />
        </section>
      )}

      {fixed && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-lg font-bold text-slate-900"><Timer size={18} className="text-indigo-500" /> Fixed-Time (emailed)</h3>
            <Link to="/reports/fixed" className="inline-flex items-center gap-1 text-sm font-bold text-indigo-700 hover:underline">Details <ArrowRight size={14} /></Link>
          </div>
          <SummaryCards summary={fixed} market="fixed" />
        </section>
      )}

      {signalLog?.summary && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-lg font-bold text-slate-900"><ClipboardList size={18} className="text-emerald-500" /> System Signal Log (all executable A/A+)</h3>
            <Link to="/reports/signals" className="inline-flex items-center gap-1 text-sm font-bold text-emerald-700 hover:underline">Details <ArrowRight size={14} /></Link>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
              <p className="text-xs font-bold uppercase tracking-wide text-slate-400">All setups</p>
              <p className="mt-1 text-2xl font-black text-slate-900">{signalLog.summary.all.winRate}%</p>
              <p className="text-xs text-slate-500 mt-0.5">{signalLog.summary.all.total} signals · {signalLog.summary.all.settled} settled</p>
            </div>
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4 shadow-card">
              <p className="text-xs font-bold uppercase tracking-wide text-emerald-600">Emailed</p>
              <p className="mt-1 text-2xl font-black text-emerald-700">{signalLog.summary.emailed.winRate}%</p>
              <p className="text-xs text-emerald-600/80 mt-0.5">{signalLog.summary.emailed.total} signals · {signalLog.summary.emailed.settled} settled</p>
            </div>
            <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4 shadow-card">
              <p className="text-xs font-bold uppercase tracking-wide text-amber-600">Filtered (not emailed)</p>
              <p className="mt-1 text-2xl font-black text-amber-700">{signalLog.summary.filtered.winRate}%</p>
              <p className="text-xs text-amber-600/80 mt-0.5">{signalLog.summary.filtered.total} signals · {signalLog.summary.filtered.settled} settled</p>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
