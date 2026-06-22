import React, { useCallback, useEffect, useState } from 'react';
import { Timer, TrendingUp } from 'lucide-react';
import { fetchCalibrationReport, fetchWouldSuppress } from '../../mt5Api';
import type { CalibrationGroupStat, CalibrationResponse, WouldSuppressResponse } from '../../types';
import { ReportsHeader, ReportsTabs, ErrorBanner } from './_shared';

const FOREX_KEYS = ['grade', 'symbol', 'timeframe', 'strategyType', 'signalQuality', 'session', 'volatilityState', 'pattern'];
const FIXED_KEYS = ['grade', 'symbol', 'expiry', 'strategyType', 'qualityTier', 'session', 'volatilityState', 'ichimokuState', 'pattern'];

const KEY_LABELS: Record<string, string> = {
  grade: 'By Grade', symbol: 'By Symbol', timeframe: 'By Timeframe', expiry: 'By Expiry',
  strategyType: 'By Strategy', signalQuality: 'By Signal Quality', qualityTier: 'By Quality Tier',
  session: 'By Session', volatilityState: 'By Volatility', ichimokuState: 'By Ichimoku', pattern: 'By Pattern',
};

function LeaderboardCard({ title, rows }: { title: string; rows: CalibrationGroupStat[] }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h4 className="text-sm font-black uppercase tracking-wider text-slate-500">{title}</h4>
        <span className="text-xs font-bold text-slate-400">top 5</span>
      </div>
      <div className="space-y-2">
        {rows.slice(0, 5).map((row) => (
          <div key={`${title}-${row.value}`} className="rounded-xl border border-slate-100 bg-slate-50/80 p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-bold text-slate-800">{row.value}</div>
                <div className="text-[11px] text-slate-400">{row.total} signals · {row.settled} settled</div>
              </div>
              <div className="text-right">
                <div className="text-sm font-black text-slate-900">{row.winRate}%</div>
                <div className={`text-[11px] font-semibold ${row.netPips >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {row.netPips >= 0 ? '+' : ''}{row.netPips}
                </div>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] text-slate-500">
              <div>W {row.wins}</div>
              <div>L {row.losses}</div>
              <div>C {row.avgConfidence}</div>
            </div>
            {(row.tp1Wins || row.tp2Wins || row.tp3Wins) ? (
              <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] text-slate-500">
                <div>TP1 {row.tp1Wins ?? 0} · {row.tp1WinRate ?? 0}%</div>
                <div>TP2 {row.tp2Wins ?? 0} · {row.tp2WinRate ?? 0}%</div>
                <div>TP3 {row.tp3Wins ?? 0} · {row.tp3WinRate ?? 0}%</div>
              </div>
            ) : null}
          </div>
        ))}
        {!rows.length && <div className="text-sm text-slate-400">No calibrated rows yet.</div>}
      </div>
    </div>
  );
}

export default function CalibrationReport() {
  const [market, setMarket] = useState<'forex' | 'fixed'>('forex');
  const [days, setDays] = useState(90);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [calibration, setCalibration] = useState<CalibrationResponse | null>(null);
  const [wouldSuppress, setWouldSuppress] = useState<WouldSuppressResponse | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cal, ws] = await Promise.all([
        fetchCalibrationReport(market, { days, limit: 500 }),
        fetchWouldSuppress().catch(() => null),
      ]);
      setCalibration(cal);
      setWouldSuppress(ws);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load calibration');
    } finally {
      setLoading(false);
    }
  }, [market, days]);

  useEffect(() => { void load(); }, [load]);

  const keys = market === 'forex' ? FOREX_KEYS : FIXED_KEYS;

  return (
    <div className="space-y-6">
      <ReportsHeader
        title="Calibration"
        subtitle="Historical win rate and expectancy by category — each dimension in its own table"
        days={days} setDays={setDays} onRefresh={() => void load()} loading={loading}
      />
      <ReportsTabs />

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex gap-2 p-1 bg-slate-100 rounded-xl w-fit">
          <button type="button" onClick={() => setMarket('forex')}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition-all ${market === 'forex' ? 'bg-white text-amber-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>
            <TrendingUp size={16} /> Forex
          </button>
          <button type="button" onClick={() => setMarket('fixed')}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition-all ${market === 'fixed' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>
            <Timer size={16} /> Fixed-Time
          </button>
        </div>
        {calibration && <div className="text-sm font-bold text-slate-500">{calibration.winLossSettled ?? calibration.overall?.settled ?? 0} scored · {calibration.total} signals{calibration.expired ? ` · ${calibration.expired} expired` : ''}</div>}
      </div>

      <ErrorBanner error={error} />

      {/* Would-suppress (shadow) — the calibration gate runs in observe mode: it flags
          what it WOULD block under enforce, but nothing is actually dropped yet. */}
      {wouldSuppress && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50/50 p-4 shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <h4 className="text-sm font-black uppercase tracking-wider text-amber-700">Would-suppress (shadow)</h4>
            <div className="flex items-center gap-2 text-[11px] font-bold">
              <span className={`rounded px-1.5 py-0.5 ${wouldSuppress.mode.forex === 'enforce' ? 'bg-rose-100 text-rose-700' : wouldSuppress.mode.forex === 'observe' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>forex: {wouldSuppress.mode.forex}</span>
              <span className={`rounded px-1.5 py-0.5 ${wouldSuppress.mode.ftt === 'enforce' ? 'bg-rose-100 text-rose-700' : wouldSuppress.mode.ftt === 'observe' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>fixed: {wouldSuppress.mode.ftt}</span>
            </div>
          </div>
          {wouldSuppress.summary.length ? (
            <>
              <div className="flex flex-wrap gap-2 mb-3">
                {wouldSuppress.summary.slice(0, 12).map((s) => (
                  <span key={`${s.type}-${s.symbol}`} className="rounded-lg border border-amber-200 bg-white px-2.5 py-1 text-[12px] font-bold text-amber-800">{s.symbol} <span className="text-amber-500">×{s.count}</span></span>
                ))}
              </div>
              <div className="overflow-x-auto rounded-xl border border-amber-100 bg-white">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="border-b border-amber-100 text-[10px] uppercase tracking-[0.15em] text-amber-600">
                    <tr><th className="px-3 py-2">Signal</th><th className="px-3 py-2">Bucket</th><th className="px-3 py-2 text-right">Win%</th><th className="px-3 py-2 text-right">Settled</th><th className="px-3 py-2">Why</th><th className="px-3 py-2">When</th></tr>
                  </thead>
                  <tbody className="divide-y divide-amber-50 text-slate-700">
                    {wouldSuppress.recent.slice(0, 12).map((r, i) => (
                      <tr key={`${r.symbol}-${r.at}-${i}`}>
                        <td className="px-3 py-1.5 font-bold text-slate-800">{r.type} {r.symbol} <span className="text-[10px] text-slate-400">{r.timeframe || r.expiry || ''}</span></td>
                        <td className="px-3 py-1.5 text-[12px] text-slate-500">{r.bucket || '—'}</td>
                        <td className="px-3 py-1.5 text-right font-mono">{r.winRate ?? '—'}%</td>
                        <td className="px-3 py-1.5 text-right font-mono">{r.settled ?? '—'}</td>
                        <td className="px-3 py-1.5 text-[11px] text-slate-500">{r.reason}</td>
                        <td className="px-3 py-1.5 text-[11px] text-slate-400">{new Date(r.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="text-[12px] font-medium text-amber-700/80">Nothing flagged yet. As alerts fire, any that the gate would block under <b>enforce</b> appear here — none are dropped while in observe.</p>
          )}
          <p className="mt-2 text-[11px] font-medium text-slate-400">{wouldSuppress.note}</p>
        </div>
      )}

      {calibration && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {keys.map((key) => (
            <LeaderboardCard key={key} title={KEY_LABELS[key] || key} rows={calibration.leaderboards[key] || []} />
          ))}
        </div>
      )}

      {!loading && !calibration && (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-12 text-center text-sm font-medium text-slate-400">
          No calibration data yet.
        </div>
      )}
    </div>
  );
}
