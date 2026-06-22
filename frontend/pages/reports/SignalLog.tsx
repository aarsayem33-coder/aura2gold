import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, Mail, MailX, Search, TrendingDown } from 'lucide-react';
import { fetchSignalLog } from '../../mt5Api';
import type { SignalLogBucket, SignalLogResponse, SystemSignalLogRow } from '../../types';
import {
  DateCell, ReportsHeader, ReportsTabs, ErrorBanner,
  price, outcomeBadge, outcomeIcon, gradeBadgeClass,
  rangeToParams, type RangeKey,
} from './_shared';

function BucketCard({ title, bucket, accent, hint }: { title: string; bucket: SignalLogBucket; accent: string; hint: string }) {
  return (
    <div className={`rounded-2xl border p-4 shadow-card ${accent}`}>
      <p className="text-xs font-bold uppercase tracking-wide opacity-70">{title}</p>
      <div className="mt-1 flex items-baseline gap-2">
        <p className="text-3xl font-black">{bucket.winRate}%</p>
        <span className="text-xs font-semibold opacity-70">win rate</span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-xs font-bold">
        <div>{bucket.total} signals</div>
        <div>{bucket.settled} settled</div>
        <div className={bucket.netPips >= 0 ? 'text-emerald-700' : 'text-red-700'}>{bucket.netPips >= 0 ? '+' : ''}{bucket.netPips}p</div>
      </div>
      <p className="mt-2 text-[11px] font-medium opacity-70">{hint}</p>
    </div>
  );
}

export default function SignalLog() {
  const [range, setRange] = useState<RangeKey>('d30');
  const [query, setQuery] = useState('');
  const [gradeFilter, setGradeFilter] = useState<'all' | 'A Setup' | 'A+ Setup'>('all');
  const [emailedFilter, setEmailedFilter] = useState<'all' | 'emailed' | 'filtered'>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<SignalLogResponse | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchSignalLog({
        ...rangeToParams(range),
        grade: gradeFilter === 'all' ? undefined : gradeFilter,
        emailed: emailedFilter === 'all' ? undefined : emailedFilter === 'emailed',
        limit: 500,
      });
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load signal log');
    } finally {
      setLoading(false);
    }
  }, [range, gradeFilter, emailedFilter]);

  useEffect(() => { void load(); }, [load]);

  const rows = data?.rows ?? [];
  const summary = data?.summary;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q));
  }, [rows, query]);

  // Edge surfaced by comparing emailed vs filtered win rates.
  const edgeNote = useMemo(() => {
    if (!summary || summary.filtered.settled < 10 || summary.emailed.settled < 10) return null;
    const diff = summary.filtered.winRate - summary.emailed.winRate;
    if (diff > 5) return { tone: 'warn', text: `Filtered-out setups are winning ${diff}% more than emailed ones — the email gate may be too strict.` };
    if (diff < -5) return { tone: 'good', text: `Emailed setups beat filtered ones by ${Math.abs(diff)}% — the gate is selecting winners.` };
    return { tone: 'neutral', text: 'Emailed and filtered setups perform similarly so far.' };
  }, [summary]);

  return (
    <div className="space-y-6">
      <ReportsHeader
        title="System Signal Log"
        subtitle="Every executable A/A+ forex setup the system produced — emailed or filtered — with auto-resolved outcomes"
        range={range} setRange={setRange} onRefresh={() => void load()} loading={loading}
      />
      <ReportsTabs />

      {summary && (
        <div className="space-y-3">
          <div className="grid gap-4 md:grid-cols-3">
            <BucketCard title="All setups" bucket={summary.all} accent="border-slate-200 bg-white text-slate-900" hint="Every A/A+ setup the system found" />
            <BucketCard title="Emailed (alerts sent)" bucket={summary.emailed} accent="border-emerald-200 bg-emerald-50/60 text-emerald-900" hint="Passed the email gate" />
            <BucketCard title="Filtered (not emailed)" bucket={summary.filtered} accent="border-amber-200 bg-amber-50/60 text-amber-900" hint="Executable but the gate held them back" />
          </div>
          {edgeNote && (
            <div className={`rounded-xl border px-4 py-3 text-sm font-semibold ${
              edgeNote.tone === 'warn' ? 'border-amber-300 bg-amber-50 text-amber-800'
                : edgeNote.tone === 'good' ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                  : 'border-slate-200 bg-slate-50 text-slate-600'
            }`}>
              {edgeNote.text}
            </div>
          )}
        </div>
      )}

      <ErrorBanner error={error} />

      <div className="bg-white rounded-2xl border border-slate-200 shadow-card overflow-hidden">
        <div className="p-5 border-b border-slate-100 flex flex-wrap gap-3 bg-slate-50/50">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
              <Search size={18} className="text-slate-400" />
            </div>
            <input
              type="text" value={query} onChange={(e) => setQuery(e.target.value)}
              className="block w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-xl bg-white text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-gold-500/20 focus:border-gold-500 text-sm font-medium shadow-sm"
              placeholder="Search symbol, outcome, pattern..."
            />
          </div>
          <select value={gradeFilter} onChange={(e) => setGradeFilter(e.target.value as typeof gradeFilter)} className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 shadow-sm">
            <option value="all">All grades</option>
            <option value="A+ Setup">A+ only</option>
            <option value="A Setup">A only</option>
          </select>
          <select value={emailedFilter} onChange={(e) => setEmailedFilter(e.target.value as typeof emailedFilter)} className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 shadow-sm">
            <option value="all">Emailed + filtered</option>
            <option value="emailed">Emailed only</option>
            <option value="filtered">Filtered only</option>
          </select>
          <div className="flex items-center gap-2 text-sm font-bold text-slate-500">
            <BarChart3 size={16} />
            {filtered.length} records
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[1200px]">
            <thead>
              <tr className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 font-bold border-b border-slate-100">
                <th className="p-4">Bar / signal time</th>
                <th className="p-4">Alert</th>
                <th className="p-4">Symbol</th>
                <th className="p-4">TF</th>
                <th className="p-4">Direction</th>
                <th className="p-4">Grade / Quality</th>
                <th className="p-4">Conf</th>
                <th className="p-4">Entry / SL / TP1</th>
                <th className="p-4">Context</th>
                <th className="p-4">Outcome</th>
                <th className="p-4">P/L (pips)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((row: SystemSignalLogRow) => (
                <tr key={row.id} className="hover:bg-slate-50/80 transition-colors">
                  <td className="p-4 text-sm text-slate-600 whitespace-nowrap"><DateCell value={row.barTime || row.signalTime} /></td>
                  <td className="p-4 whitespace-nowrap">
                    {row.emailed ? (
                      <span className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-black text-emerald-700">
                        <Mail size={11} /> Emailed
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-black text-amber-700">
                        <MailX size={11} /> Filtered
                      </span>
                    )}
                  </td>
                  <td className="p-4 text-sm font-bold text-slate-900">{row.symbol}</td>
                  <td className="p-4">
                    <span className="px-2 py-1 rounded-md text-xs font-bold bg-slate-100 border border-slate-200 text-slate-600">{row.timeframe}</span>
                  </td>
                  <td className="p-4 text-sm font-bold text-slate-800">{row.direction}</td>
                  <td className="p-4">
                    <div className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-black uppercase tracking-wider ${gradeBadgeClass(row.grade)}`}>{row.grade || '—'}</div>
                    {row.signalQuality && <div className="mt-1 text-[11px] font-semibold text-slate-500">{row.signalQuality}</div>}
                  </td>
                  <td className="p-4 text-sm font-mono font-bold text-slate-700">{row.confidence != null ? Math.round(row.confidence) : '—'}</td>
                  <td className="p-4 text-xs font-mono text-slate-600">
                    {price(row.entryPrice, row.symbol)} / {price(row.stopLoss, row.symbol)} / {price(row.takeProfit1, row.symbol)}
                  </td>
                  <td className="p-4 text-[11px] text-slate-500 max-w-[200px]">
                    {row.strategyType && <div className="font-semibold text-amber-700">{row.strategyType}</div>}
                    {row.pattern && row.pattern !== 'none' && <div>{row.pattern}</div>}
                    {row.regime && <div className="text-slate-400">{row.regime}</div>}
                    {row.session && <div className="truncate text-slate-400" title={row.session}>{row.session}</div>}
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
            <p className="text-sm font-medium text-slate-400">No logged system signals in this period yet.</p>
            <p className="text-xs text-slate-400 mt-1">Rows are created when the scanner detects an A/A+ forex setup (after a backend restart).</p>
          </div>
        )}
      </div>
    </div>
  );
}
