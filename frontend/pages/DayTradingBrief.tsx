import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Sunrise, AlertTriangle, ShieldAlert, TrendingUp, TrendingDown, CalendarClock } from 'lucide-react';
import { fetchDayTradingBrief } from '../mt5Api';
import type { DayTradingBriefResponse, DayTradingBriefSymbol } from '../types';

const TF_OPTIONS = ['M5', 'M15', 'M30', 'H1', 'H4'];

function fmtTime(iso: string) {
  try { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
}
function fmtNum(v: number | null, digits = 2) {
  return v === null || v === undefined ? '—' : v.toFixed(digits);
}

function DecisionBadge({ d }: { d: string }) {
  if (d === 'BUY' || d === 'STRONG_BUY') return <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-black bg-emerald-50 text-emerald-700 border border-emerald-200"><TrendingUp size={11} />{d}</span>;
  if (d === 'SELL' || d === 'STRONG_SELL') return <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-black bg-rose-50 text-rose-700 border border-rose-200"><TrendingDown size={11} />{d}</span>;
  return <span className="rounded px-1.5 py-0.5 text-[11px] font-bold bg-slate-100 text-slate-500 border border-slate-200">HOLD</span>;
}

function ExtensionCell({ s }: { s: DayTradingBriefSymbol }) {
  if (s.emaDistanceAtr === null) return <span className="text-slate-400">—</span>;
  const cls = s.extended ? 'text-amber-700 font-black' : 'text-slate-600 font-mono';
  return (
    <span className={cls} title="Signed ATR distance from EMA. High magnitude = stretched (don't chase).">
      {s.emaDistanceAtr > 0 ? '+' : ''}{s.emaDistanceAtr.toFixed(2)}σ
      {s.extended && <AlertTriangle size={12} className="inline ml-1 -mt-0.5" />}
    </span>
  );
}

export default function DayTradingBrief() {
  const [tf, setTf] = useState('M15');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<DayTradingBriefResponse | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchDayTradingBrief(tf));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load brief');
    } finally {
      setLoading(false);
    }
  }, [tf]);

  useEffect(() => { void load(); }, [load]);

  const dr = data?.dailyRisk;

  return (
    <div className="space-y-6 p-1">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-amber-100 p-2"><Sunrise className="text-amber-600" size={22} /></div>
          <div>
            <h1 className="text-xl font-black text-slate-900">Pre-Session Brief</h1>
            <p className="text-xs font-medium text-slate-400">Bias · extension · levels · news · daily risk — your one screen before the session.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select value={tf} onChange={(e) => setTf(e.target.value)} className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-semibold">
            {TF_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-bold text-white hover:bg-slate-700 disabled:opacity-50">
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Refresh
          </button>
        </div>
      </div>

      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">{error}</div>}

      {/* Daily risk budget */}
      {dr && (
        <div className={`rounded-2xl border p-4 shadow-card ${dr.limitHit ? 'border-rose-300 bg-rose-50' : 'border-slate-200 bg-white'}`}>
          <div className="flex items-center gap-2 mb-3">
            <ShieldAlert size={16} className={dr.limitHit ? 'text-rose-600' : 'text-slate-500'} />
            <h3 className="text-sm font-black uppercase tracking-wider text-slate-500">Daily risk budget</h3>
            {dr.dateUtc && <span className="text-[11px] font-semibold text-slate-400">{dr.dateUtc} (UTC)</span>}
          </div>
          {dr.available ? (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 text-sm">
                <div className="rounded-xl bg-slate-50 p-3"><div className="text-[11px] text-slate-400 font-bold uppercase">Net today</div><div className={`text-lg font-black ${(dr.settledR ?? 0) > 0 ? 'text-emerald-700' : (dr.settledR ?? 0) < 0 ? 'text-rose-700' : 'text-slate-900'}`}>{(dr.settledR ?? 0) > 0 ? '+' : ''}{fmtNum(dr.settledR ?? 0, 2)}R</div></div>
                <div className="rounded-xl bg-emerald-50 p-3"><div className="text-[11px] text-emerald-500 font-bold uppercase">Wins</div><div className="text-lg font-black text-emerald-700">{dr.wins ?? 0}</div></div>
                <div className="rounded-xl bg-rose-50 p-3"><div className="text-[11px] text-rose-500 font-bold uppercase">Losses</div><div className="text-lg font-black text-rose-700">{dr.losses ?? 0}</div></div>
                <div className="rounded-xl bg-blue-50 p-3"><div className="text-[11px] text-blue-500 font-bold uppercase">Open</div><div className="text-lg font-black text-blue-700">{dr.openCount ?? 0}</div></div>
                <div className="rounded-xl bg-slate-50 p-3"><div className="text-[11px] text-slate-400 font-bold uppercase">Stop at</div><div className="text-lg font-black text-slate-900">-{fmtNum(dr.dailyStopR, 0)}R</div></div>
              </div>
              <p className={`mt-3 text-[12px] font-semibold ${dr.limitHit ? 'text-rose-700' : 'text-slate-500'}`}>{dr.note}</p>
            </>
          ) : (
            <p className="text-sm font-medium text-slate-400">{dr.note}</p>
          )}
        </div>
      )}

      {/* News today */}
      {data?.news.length ? (
        <div className="rounded-2xl border border-slate-200 bg-white shadow-card overflow-hidden">
          <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
            <CalendarClock size={16} className="text-indigo-500" />
            <h3 className="text-sm font-black uppercase tracking-wider text-slate-500">High-impact news (next 24h)</h3>
          </div>
          <div className="flex flex-wrap gap-2 p-4">
            {data.news.map((n) => (
              <span key={`${n.currency}-${n.title}-${n.timestampUtc}`} className="inline-flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1 text-[12px] font-semibold text-amber-800">
                <span className="font-black">{n.currency}</span> {n.title} <span className="text-amber-500">· {fmtTime(n.timeIso)}</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {/* Symbols table */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-card overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h3 className="text-sm font-black uppercase tracking-wider text-slate-500">Market map · {data?.timeframe || tf}</h3>
          {data && <span className="text-[11px] font-semibold text-slate-400">extension flag at |{data.extensionAtrThreshold}σ| from EMA</span>}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] text-left text-sm">
            <thead className="border-b border-slate-100 text-[10px] uppercase tracking-[0.15em] text-slate-500">
              <tr>
                <th className="px-4 py-2">Symbol</th>
                <th className="px-4 py-2">Decision</th>
                <th className="px-4 py-2 text-right">Score</th>
                <th className="px-4 py-2">Grade</th>
                <th className="px-4 py-2">Regime</th>
                <th className="px-4 py-2">HTF bias</th>
                <th className="px-4 py-2 text-right">Extension</th>
                <th className="px-4 py-2 text-right">ADR%</th>
                <th className="px-4 py-2 text-right">R:R</th>
                <th className="px-4 py-2 text-right">Support / Resist.</th>
                <th className="px-4 py-2">Forecast</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {data?.symbols.length ? data.symbols.map((s) => (
                <tr key={s.symbol} className={`hover:bg-slate-50/70 ${s.decision !== 'HOLD' ? 'bg-emerald-50/20' : ''}`}>
                  <td className="px-4 py-2 font-black text-slate-900">{s.symbol}{s.newsRisk && <ShieldAlert size={12} className={`inline ml-1 -mt-0.5 ${s.newsRisk === 'block' ? 'text-rose-500' : 'text-amber-500'}`} />}</td>
                  <td className="px-4 py-2"><DecisionBadge d={s.decision} /></td>
                  <td className="px-4 py-2 text-right font-mono font-bold">{s.score ?? '—'}</td>
                  <td className="px-4 py-2 text-[12px] font-semibold text-slate-500">{s.grade || '—'}</td>
                  <td className="px-4 py-2 text-[12px] capitalize">{s.regime || '—'}</td>
                  <td className="px-4 py-2 text-[12px] font-semibold">{s.htfBias || '—'}</td>
                  <td className="px-4 py-2 text-right"><ExtensionCell s={s} /></td>
                  <td className="px-4 py-2 text-right font-mono text-[12px]">{s.adrUsagePercent === null ? '—' : `${Math.round(s.adrUsagePercent)}%`}</td>
                  <td className="px-4 py-2 text-right font-mono text-[12px]">{s.riskRewardRatio === null ? '—' : `1:${fmtNum(s.riskRewardRatio, 1)}`}</td>
                  <td className="px-4 py-2 text-right font-mono text-[11px] text-slate-500">{fmtNum(s.nearestSupport, 2)} / {fmtNum(s.nearestResistance, 2)}</td>
                  <td className="px-4 py-2 text-[11px]">{s.forecast ? <span className="text-indigo-600 font-semibold">{fmtTime(s.forecast.eta)}</span> : <span className="text-slate-300">—</span>}</td>
                </tr>
              )) : (
                <tr><td colSpan={11} className="px-4 py-10 text-center text-sm font-medium text-slate-400">{loading ? 'Loading…' : 'No symbols with fresh candle data. Make sure the MT5 feed is live.'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {data?.note && <p className="text-[11px] font-medium text-slate-400 px-1">{data.note}</p>}
    </div>
  );
}
