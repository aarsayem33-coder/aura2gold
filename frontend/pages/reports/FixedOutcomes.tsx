import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, Search, TrendingDown } from 'lucide-react';
import { fetchFixedEmailReports } from '../../mt5Api';
import type { SignalEmailReport, TradeReportSummary } from '../../types';
import { formatBdDateTime } from '../../utils/time';
import {
  DateCell, ReportsHeader, ReportsTabs, SummaryCards, ErrorBanner,
  price, delayLabel, delayBadgeClass, outcomeBadge, outcomeIcon,
} from './_shared';

function getCalibrationPayload(payload: SignalEmailReport['payload']) {
  const calibration = (payload as { calibration?: { winRate?: number; settled?: number } } | null)?.calibration;
  if (!calibration || calibration.winRate === undefined || calibration.winRate === null) return null;
  return calibration;
}

export default function FixedOutcomes() {
  const [days, setDays] = useState(30);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reports, setReports] = useState<SignalEmailReport[]>([]);
  const [summary, setSummary] = useState<TradeReportSummary | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchFixedEmailReports({ days, limit: 300 });
      setReports(res.reports);
      setSummary(res.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load fixed-time outcomes');
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return reports;
    return reports.filter((r) => JSON.stringify(r).toLowerCase().includes(q));
  }, [reports, query]);

  return (
    <div className="space-y-6">
      <ReportsHeader
        title="Fixed-Time Outcomes"
        subtitle="Tracked outcomes for fixed-time trade alerts sent by email"
        days={days} setDays={setDays} onRefresh={() => void load()} loading={loading}
      />
      <ReportsTabs />
      {summary && <SummaryCards summary={summary} market="fixed" />}
      <ErrorBanner error={error} />

      <div className="bg-white rounded-2xl border border-slate-200 shadow-card overflow-hidden">
        <div className="p-5 border-b border-slate-100 flex gap-4 bg-slate-50/50">
          <div className="relative flex-1 max-w-md">
            <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
              <Search size={18} className="text-slate-400" />
            </div>
            <input
              type="text" value={query} onChange={(e) => setQuery(e.target.value)}
              className="block w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-xl bg-white text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-gold-500/20 focus:border-gold-500 text-sm font-medium shadow-sm"
              placeholder="Search symbol, outcome, grade..."
            />
          </div>
          <div className="flex items-center gap-2 text-sm font-bold text-slate-500">
            <BarChart3 size={16} />
            {filtered.length} records
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[1280px]">
            <thead>
              <tr className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 font-bold border-b border-slate-100">
                <th className="p-4">Signal / trade time</th>
                <th className="p-4">Emailed</th>
                <th className="p-4">Delay</th>
                <th className="p-4">Symbol</th>
                <th className="p-4">Expiry</th>
                <th className="p-4">Direction</th>
                <th className="p-4">Entry → Exit</th>
                <th className="p-4">Candle TFs</th>
                <th className="p-4">Outcome</th>
                <th className="p-4">P/L</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((row) => (
                <tr key={row.id} className="hover:bg-slate-50/80 transition-colors">
                  <td className="p-4 text-sm text-slate-600 whitespace-nowrap">
                    <DateCell value={row.tradeTime} />
                    <div className="text-xs text-slate-400 mt-1">sig {formatBdDateTime(row.signalTime)}</div>
                    {getCalibrationPayload(row.payload) && (
                      <div className="mt-1 text-[11px] font-bold text-indigo-600">
                        Calibrated {getCalibrationPayload(row.payload)?.winRate}% · {getCalibrationPayload(row.payload)?.settled ?? 0} settled
                      </div>
                    )}
                  </td>
                  <td className="p-4 text-sm text-slate-500 whitespace-nowrap"><DateCell value={row.emailSentAt} /></td>
                  <td className="p-4 whitespace-nowrap">
                    <span className={`inline-flex rounded-md border px-2.5 py-1 text-xs font-black ${delayBadgeClass(row.alertDelaySeconds)}`}>
                      {delayLabel(row.alertDelaySeconds)}
                    </span>
                    {row.sourceCandleTime ? <div className="mt-1 text-[10px] text-slate-400">candle {formatBdDateTime(row.sourceCandleTime)}</div> : null}
                  </td>
                  <td className="p-4 text-sm font-bold text-slate-900">{row.symbol}</td>
                  <td className="p-4">
                    <span className="px-2 py-1 rounded-md text-xs font-bold bg-indigo-50 border border-indigo-200 text-indigo-700">{row.expiry || 'n/a'}</span>
                  </td>
                  <td className="p-4 text-sm font-bold text-slate-800">{row.direction}</td>
                  <td className="p-4 text-xs font-mono text-slate-600">
                    {price(row.entryPrice, row.symbol)} → {price(row.exitPrice, row.symbol)}
                  </td>
                  <td className="p-4 text-xs text-slate-600 leading-relaxed">
                    <div><span className="text-slate-400">bias</span> {row.candleBiasTf || '—'}</div>
                    <div><span className="text-slate-400">trend</span> {row.candleTrendTf || '—'}</div>
                    <div><span className="text-slate-400">entry</span> <b>{row.candleEntryTf || '—'}</b></div>
                    <div><span className="text-slate-400">confirm</span> {row.candleConfirmTf || '—'}</div>
                  </td>
                  <td className="p-4">
                    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-bold border ${outcomeBadge(row.outcome)}`}>
                      {outcomeIcon(row.outcome)}{row.outcome}
                    </span>
                  </td>
                  <td className={`p-4 text-sm font-bold font-mono ${(row.profitLossPips ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {row.profitLossPips != null ? `${row.profitLossPips >= 0 ? '+' : ''}${row.profitLossPips}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!loading && !filtered.length && (
          <div className="p-12 text-center">
            <TrendingDown size={32} className="mx-auto text-slate-300 mb-3" />
            <p className="text-sm font-medium text-slate-400">No emailed fixed-time signals in this period yet.</p>
            <p className="text-xs text-slate-400 mt-1">Reports are created when the scanner sends alert emails.</p>
          </div>
        )}
      </div>
    </div>
  );
}
