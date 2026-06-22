import React, { useCallback, useEffect, useState } from 'react';
import { fetchForexBacktestReport } from '../../mt5Api';
import type { ForexBacktestResponse } from '../../types';
import { ReportsHeader, ReportsTabs, ErrorBanner, rangeToParams, type RangeKey } from './_shared';

function BacktestCard({ backtest }: { backtest: ForexBacktestResponse }) {
  const s = backtest.summary;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h4 className="text-sm font-black uppercase tracking-wider text-slate-500">Forex backtest</h4>
        <span className="text-xs font-bold text-slate-400">historical replay</span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <div className="rounded-xl bg-slate-50 p-3"><div className="text-[11px] text-slate-400 font-bold uppercase">Settled</div><div className="text-lg font-black text-slate-900">{s.settled}/{s.valid}</div></div>
        <div className="rounded-xl bg-emerald-50 p-3"><div className="text-[11px] text-emerald-500 font-bold uppercase">Win rate</div><div className="text-lg font-black text-emerald-700">{s.winRate}%</div></div>
        <div className="rounded-xl bg-indigo-50 p-3"><div className="text-[11px] text-indigo-500 font-bold uppercase">Expectancy</div><div className="text-lg font-black text-indigo-700">{s.expectancyPips} pips</div></div>
        <div className="rounded-xl bg-amber-50 p-3"><div className="text-[11px] text-amber-500 font-bold uppercase">Avg MFE / MAE</div><div className="text-lg font-black text-amber-700">{s.avgMfePips} / {s.avgMaePips}</div></div>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-[11px] text-slate-500">
        <div>TP1 {s.tp1Wins} · {s.tp1HitRate}%</div>
        <div>TP2 {s.tp2Wins} · {s.tp2HitRate}%</div>
        <div>TP3 {s.tp3Wins} · {s.tp3HitRate}%</div>
      </div>
      {backtest.samples.length ? (
        <div className="mt-4 space-y-2">
          {backtest.samples.slice(0, 10).map((sample) => (
            <div key={sample.id} className="rounded-xl border border-slate-100 bg-slate-50/70 p-3 text-xs text-slate-600">
              <div className="flex items-center justify-between gap-3">
                <div className="font-bold text-slate-800">{sample.symbol} {sample.timeframe || ''} {sample.direction}</div>
                <div className="font-black text-slate-900">{sample.outcome}</div>
              </div>
              <div className="mt-1 grid grid-cols-2 md:grid-cols-4 gap-2">
                <div>TP{sample.tpHitLevel}</div>
                <div>P/L {sample.profitLossPips ?? 'n/a'}</div>
                <div>MFE {sample.mfePips ?? 'n/a'}</div>
                <div>MAE {sample.maePips ?? 'n/a'}</div>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function BacktestReport() {
  const [range, setRange] = useState<RangeKey>('d30');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backtest, setBacktest] = useState<ForexBacktestResponse | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const back = await fetchForexBacktestReport({ days: rangeToParams(range).days, limit: 100 });
      setBacktest(back);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load backtest');
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-6">
      <ReportsHeader
        title="Backtest"
        subtitle="Historical replay of emailed forex signals (report-based)"
        range={range} setRange={setRange} onRefresh={() => void load()} loading={loading}
      />
      <ReportsTabs />
      <ErrorBanner error={error} />
      {backtest ? <BacktestCard backtest={backtest} /> : (
        !loading && (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-12 text-center text-sm font-medium text-slate-400">
            No backtest data yet.
          </div>
        )
      )}
    </div>
  );
}
