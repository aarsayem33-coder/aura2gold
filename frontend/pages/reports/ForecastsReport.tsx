import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, FlaskConical, Trophy } from 'lucide-react';
import { fetchForecastCalibration, fetchForecastReplay, fetchForecastOutcomes } from '../../mt5Api';
import type { ForecastCalibrationResponse, ForecastReplayResponse, ForecastOutcomeResponse, TradeOutcome } from '../../types';
import { ReportsHeader, ReportsTabs, ErrorBanner, DateCell, rangeToParams, type RangeKey } from './_shared';

const BASIS_LABEL: Record<string, string> = {
  IMMEDIATE: 'Ready now', NEXT_CANDLE: 'Next candle', NEWS: 'News event', PULLBACK: 'Pullback',
  SCORE_SLOPE: 'Score rising', SESSION: 'Session open', UNKNOWN: 'No clear path', ALL: 'All bases',
};

function outcomeClass(o: TradeOutcome | null | undefined) {
  const s = String(o || 'PENDING').toUpperCase();
  if (s.endsWith('_WIN') || s === 'WIN') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (s === 'LOSS') return 'bg-rose-50 text-rose-700 border-rose-200';
  if (s === 'AMBIGUOUS') return 'bg-amber-50 text-amber-700 border-amber-200';
  if (s === 'EXPIRED') return 'bg-slate-100 text-slate-500 border-slate-200';
  return 'bg-blue-50 text-blue-600 border-blue-200';
}
function outcomeLabel(o: TradeOutcome | null | undefined) {
  const s = String(o || 'PENDING').toUpperCase();
  if (s === 'TP1_WIN') return 'WIN · TP1';
  if (s === 'TP2_WIN') return 'WIN · TP2';
  if (s === 'TP3_WIN') return 'WIN · TP3';
  return s;
}
const pipsCell = (v: number | null | undefined) => {
  if (v === null || v === undefined) return <span className="text-slate-400">—</span>;
  const cls = v > 0 ? 'text-emerald-600' : v < 0 ? 'text-rose-600' : 'text-slate-500';
  return <span className={`font-mono font-bold ${cls}`}>{v > 0 ? '+' : ''}{v}</span>;
};
const confClass: Record<string, string> = {
  strong: 'bg-emerald-100 text-emerald-700', usable: 'bg-blue-100 text-blue-700',
  early: 'bg-amber-100 text-amber-700', weak: 'bg-slate-100 text-slate-500',
};
function statusClass(s: string) {
  if (s === 'EXECUTED') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (s === 'EXPIRED') return 'bg-amber-50 text-amber-700 border-amber-200';
  return 'bg-slate-100 text-slate-500 border-slate-200';
}
const num = (v: number | null | undefined, suffix = '') => (v === null || v === undefined ? '—' : `${v}${suffix}`);

const REPLAY_TFS = ['M5', 'M15', 'M30', 'H1', 'H4', 'D1'];

export default function ForecastsReport() {
  const [range, setRange] = useState<RangeKey>('d90');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ForecastCalibrationResponse | null>(null);
  const [outcomes, setOutcomes] = useState<ForecastOutcomeResponse | null>(null);

  const [replaySymbol, setReplaySymbol] = useState('XAUUSD');
  const [replayTf, setReplayTf] = useState('M15');
  const [replayLoading, setReplayLoading] = useState(false);
  const [replay, setReplay] = useState<ForecastReplayResponse | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = rangeToParams(range).days;
      const [cal, out] = await Promise.all([
        fetchForecastCalibration(d),
        fetchForecastOutcomes(d).catch(() => null),
      ]);
      setData(cal);
      setOutcomes(out);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load forecast calibration');
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { void load(); }, [load]);

  const runReplay = async () => {
    setReplayLoading(true);
    setReplayError(null);
    setReplay(null);
    try {
      setReplay(await fetchForecastReplay(replaySymbol.trim().toUpperCase(), replayTf));
    } catch (err) {
      setReplayError(err instanceof Error ? err.message : 'Replay failed');
    } finally {
      setReplayLoading(false);
    }
  };

  const overall = data?.calibration.overall;
  const minSample = data?.minSampleToCalibrate ?? 20;

  return (
    <div className="space-y-6">
      <ReportsHeader
        title="Execution Forecasts"
        subtitle="Measured accuracy of execution-timing forecasts — the honest payoff: confidence flips from estimate to measured."
        range={range} setRange={setRange} onRefresh={() => void load()} loading={loading}
      />
      <ReportsTabs />
      <ErrorBanner error={error} />

      {/* Overall calibration */}
      {overall && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Resolved</p>
            <p className="mt-1 text-2xl font-black text-slate-900">{overall.samples}</p>
            <p className="text-xs text-slate-400 mt-0.5">{overall.executed} exec · {overall.expired} exp · {overall.cancelled} canc</p>
          </div>
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-4 shadow-card">
            <p className="text-xs font-bold uppercase tracking-wide text-emerald-600">Hit rate</p>
            <p className="mt-1 text-2xl font-black text-emerald-700">{num(overall.hitRate, '%')}</p>
            <p className="text-xs text-emerald-600/80 mt-0.5">became executable</p>
          </div>
          <div className="rounded-2xl border border-blue-200 bg-blue-50/50 p-4 shadow-card">
            <p className="text-xs font-bold uppercase tracking-wide text-blue-600">Timing accuracy</p>
            <p className="mt-1 text-2xl font-black text-blue-700">{num(overall.avgTimingAccuracy, '%')}</p>
            <p className="text-xs text-blue-600/80 mt-0.5">vs predicted ETA</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Score accuracy</p>
            <p className="mt-1 text-2xl font-black text-slate-900">{num(overall.avgScoreAccuracy, '%')}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Sample</p>
            <p className={`mt-1 inline-block rounded-lg px-2 py-1 text-sm font-black uppercase ${confClass[overall.confidence] || ''}`}>{overall.confidence}</p>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-amber-100 bg-amber-50/60 px-3 py-2 text-[12px] font-semibold text-amber-700">
        Live forecast confidence stays an <b>uncalibrated estimate</b> until a basis reaches <b>{minSample}</b> resolved forecasts — then it switches to the measured timing accuracy below. These are measured probabilities, not guarantees.
      </div>

      {/* By-basis calibration */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-card overflow-hidden">
        <div className="border-b border-slate-100 px-4 py-3"><h3 className="text-sm font-black uppercase tracking-wider text-slate-500">Accuracy by forecast basis</h3></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-slate-100 text-[10px] uppercase tracking-[0.15em] text-slate-500">
              <tr>
                <th className="px-4 py-2">Basis</th>
                <th className="px-4 py-2 text-right">Samples</th>
                <th className="px-4 py-2 text-right">Hit rate</th>
                <th className="px-4 py-2 text-right">Timing acc.</th>
                <th className="px-4 py-2 text-right">Reliability</th>
                <th className="px-4 py-2 text-right">Score acc.</th>
                <th className="px-4 py-2 text-right">Calibrated?</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {data?.calibration.byBasis.length ? data.calibration.byBasis.map((b) => (
                <tr key={b.basis} className="hover:bg-slate-50/70">
                  <td className="px-4 py-2 font-bold text-slate-800">{BASIS_LABEL[b.basis] || b.basis}</td>
                  <td className="px-4 py-2 text-right font-mono">{b.samples}</td>
                  <td className="px-4 py-2 text-right font-mono font-bold">{num(b.hitRate, '%')}</td>
                  <td className="px-4 py-2 text-right font-mono">{num(b.avgTimingAccuracy, '%')}</td>
                  <td className="px-4 py-2 text-right font-mono font-bold" title="hit rate × timing accuracy — low means the basis rarely executes reliably">{num(b.combinedConfidence, '%')}</td>
                  <td className="px-4 py-2 text-right font-mono">{num(b.avgScoreAccuracy, '%')}</td>
                  <td className="px-4 py-2 text-right">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${b.samples >= minSample ? 'bg-emerald-100 text-emerald-700' : confClass[b.confidence] || ''}`}>
                      {b.samples >= minSample ? 'MEASURED' : `${b.confidence} (${b.samples}/${minSample})`}
                    </span>
                  </td>
                </tr>
              )) : (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-sm font-medium text-slate-400">No resolved forecasts yet — accuracy populates as forecasts execute or expire.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Trade track record — did EXECUTED forecasts actually win? */}
      {(() => {
        const tt = outcomes?.summary.overall;
        return (
          <div className="rounded-2xl border border-slate-200 bg-white shadow-card overflow-hidden">
            <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
              <Trophy size={16} className="text-amber-500" />
              <h3 className="text-sm font-black uppercase tracking-wider text-slate-500">Trade track record</h3>
              <span className="ml-2 text-[11px] font-semibold text-slate-400">EXECUTED forecasts, settled by candle replay (TP/SL touch)</span>
            </div>
            <div className="p-4 space-y-4">
              <div className="grid grid-cols-2 lg:grid-cols-6 gap-3 text-sm">
                <div className="rounded-xl bg-slate-50 p-3"><div className="text-[11px] text-slate-400 font-bold uppercase">Settled</div><div className="text-lg font-black text-slate-900">{tt ? tt.settled : 0}<span className="text-xs font-bold text-slate-400"> / {tt ? tt.total : 0}</span></div></div>
                <div className="rounded-xl bg-emerald-50 p-3"><div className="text-[11px] text-emerald-500 font-bold uppercase">Win rate</div><div className="text-lg font-black text-emerald-700">{tt && (tt.wins + tt.losses) ? `${tt.winRate}%` : '—'}</div></div>
                <div className="rounded-xl bg-indigo-50 p-3"><div className="text-[11px] text-indigo-500 font-bold uppercase">Expectancy</div><div className={`text-lg font-black ${tt && tt.expectancyR !== null && tt.expectancyR > 0 ? 'text-emerald-700' : tt && tt.expectancyR !== null && tt.expectancyR < 0 ? 'text-rose-700' : 'text-indigo-700'}`}>{tt && tt.expectancyR !== null ? `${tt.expectancyR > 0 ? '+' : ''}${tt.expectancyR}R` : '—'}</div></div>
                <div className="rounded-xl bg-emerald-50/60 p-3"><div className="text-[11px] text-emerald-500 font-bold uppercase">Wins</div><div className="text-lg font-black text-emerald-700">{tt ? tt.wins : 0}</div></div>
                <div className="rounded-xl bg-rose-50 p-3"><div className="text-[11px] text-rose-500 font-bold uppercase">Losses</div><div className="text-lg font-black text-rose-700">{tt ? tt.losses : 0}</div></div>
                <div className="rounded-xl bg-slate-50 p-3"><div className="text-[11px] text-slate-400 font-bold uppercase">Net pips · R</div><div className={`text-lg font-black ${tt && tt.netPips > 0 ? 'text-emerald-700' : tt && tt.netPips < 0 ? 'text-rose-700' : 'text-slate-900'}`}>{tt ? `${tt.netPips > 0 ? '+' : ''}${tt.netPips}` : '—'}<span className="text-xs font-bold text-slate-400"> · {tt ? `${tt.netR > 0 ? '+' : ''}${tt.netR}R` : '—'}</span></div></div>
              </div>

              {/* By-basis win rate */}
              {outcomes?.summary.byBasis.length ? (
                <div className="overflow-x-auto rounded-xl border border-slate-100">
                  <table className="w-full min-w-[620px] text-left text-sm">
                    <thead className="border-b border-slate-100 text-[10px] uppercase tracking-[0.15em] text-slate-500">
                      <tr>
                        <th className="px-3 py-2">Basis</th>
                        <th className="px-3 py-2 text-right">Settled</th>
                        <th className="px-3 py-2 text-right">Win rate</th>
                        <th className="px-3 py-2 text-right">W / L</th>
                        <th className="px-3 py-2 text-right">Net pips</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-slate-700">
                      {outcomes.summary.byBasis.map((b) => (
                        <tr key={b.basis} className="hover:bg-slate-50/70">
                          <td className="px-3 py-2 font-bold text-slate-800">{BASIS_LABEL[b.basis] || b.basis}</td>
                          <td className="px-3 py-2 text-right font-mono">{b.settled}/{b.total}</td>
                          <td className="px-3 py-2 text-right font-mono font-bold">{(b.wins + b.losses) ? `${b.winRate}%` : '—'}</td>
                          <td className="px-3 py-2 text-right font-mono"><span className="text-emerald-600">{b.wins}</span> / <span className="text-rose-600">{b.losses}</span></td>
                          <td className="px-3 py-2 text-right">{pipsCell(b.netPips)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {/* Settled trades */}
              <div className="overflow-x-auto rounded-xl border border-slate-100">
                <table className="w-full min-w-[860px] text-left text-sm">
                  <thead className="border-b border-slate-100 text-[10px] uppercase tracking-[0.15em] text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Symbol</th>
                      <th className="px-3 py-2">Dir</th>
                      <th className="px-3 py-2">Basis</th>
                      <th className="px-3 py-2">Outcome</th>
                      <th className="px-3 py-2 text-right">Pips</th>
                      <th className="px-3 py-2 text-right">MFE / MAE</th>
                      <th className="px-3 py-2">Entered</th>
                      <th className="px-3 py-2">Settled</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-700">
                    {outcomes?.trades.length ? outcomes.trades.map((t) => (
                      <tr key={`${t.id}-${t.tradeResolvedAt || t.actualExecutionTime}`} className="hover:bg-slate-50/70">
                        <td className="px-3 py-2"><span className="font-black text-slate-900">{t.symbol}</span> <span className="text-[10px] font-bold text-slate-400">{t.timeframe}</span></td>
                        <td className="px-3 py-2 text-[12px] font-bold">{t.decision === 'BUY' ? <span className="text-emerald-600">BUY</span> : t.decision === 'SELL' ? <span className="text-rose-600">SELL</span> : <span className="text-slate-400">{t.decision || '—'}</span>}</td>
                        <td className="px-3 py-2 text-[12px] font-semibold text-slate-500">{BASIS_LABEL[t.forecastBasis] || t.forecastBasis}</td>
                        <td className="px-3 py-2"><span className={`rounded border px-1.5 py-0.5 text-[10px] font-black ${outcomeClass(t.tradeOutcome)}`}>{outcomeLabel(t.tradeOutcome)}</span></td>
                        <td className="px-3 py-2 text-right">{pipsCell(t.tradePips)}</td>
                        <td className="px-3 py-2 text-right font-mono text-[12px] text-slate-500">{t.tradeMfePips ?? '—'} / {t.tradeMaePips ?? '—'}</td>
                        <td className="px-3 py-2 text-xs"><DateCell value={t.actualExecutionTime} /></td>
                        <td className="px-3 py-2 text-xs"><DateCell value={t.tradeResolvedAt} /></td>
                      </tr>
                    )) : (
                      <tr><td colSpan={8} className="px-3 py-8 text-center text-sm font-medium text-slate-400">No settled trades yet — outcomes populate as EXECUTED forecasts reach a TP or SL.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              <p className="text-[11px] font-medium text-slate-400">{outcomes?.note || 'Settled from real candle replay (TP/SL touch). Track record only — not a guarantee.'}</p>
            </div>
          </div>
        );
      })()}

      {/* Backtest panel */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3">
          <FlaskConical size={16} className="text-indigo-500" />
          <h3 className="text-sm font-black uppercase tracking-wider text-slate-500">Backtest the forecaster</h3>
          <div className="ml-auto flex items-center gap-2">
            <input
              value={replaySymbol}
              onChange={(e) => setReplaySymbol(e.target.value)}
              placeholder="Symbol"
              className="w-28 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm font-semibold uppercase"
            />
            <select value={replayTf} onChange={(e) => setReplayTf(e.target.value)} className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-semibold">
              {REPLAY_TFS.map((tf) => <option key={tf} value={tf}>{tf}</option>)}
            </select>
            <button type="button" onClick={runReplay} disabled={replayLoading} className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-bold text-white hover:bg-slate-700 disabled:opacity-50">
              {replayLoading ? <Loader2 size={14} className="animate-spin" /> : <FlaskConical size={14} />} Run
            </button>
          </div>
        </div>
        <div className="p-4">
          {replayError && <ErrorBanner error={replayError} />}
          {replay ? (
            replay.valid ? (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                  <div className="rounded-xl bg-slate-50 p-3"><div className="text-[11px] text-slate-400 font-bold uppercase">Forecasts</div><div className="text-lg font-black text-slate-900">{replay.forecasts}</div></div>
                  <div className="rounded-xl bg-emerald-50 p-3"><div className="text-[11px] text-emerald-500 font-bold uppercase">Hit rate</div><div className="text-lg font-black text-emerald-700">{num(replay.hitRate, '%')}</div></div>
                  <div className="rounded-xl bg-blue-50 p-3"><div className="text-[11px] text-blue-500 font-bold uppercase">Timing acc.</div><div className="text-lg font-black text-blue-700">{num(replay.avgTimingAccuracy, '%')}</div></div>
                  <div className="rounded-xl bg-slate-50 p-3"><div className="text-[11px] text-slate-400 font-bold uppercase">Sample</div><div className="text-lg font-black text-slate-900 uppercase">{replay.confidence}</div></div>
                </div>
                <p className="mt-3 text-[11px] font-medium text-slate-400">{replay.note}</p>
              </>
            ) : (
              <p className="text-sm font-medium text-slate-400">{replay.reason || 'Not enough data to backtest.'}</p>
            )
          ) : (
            !replayLoading && <p className="text-sm font-medium text-slate-400">Pick a symbol/timeframe and run the walk-forward backtest. Validates the forecaster on history before trusting live numbers.</p>
          )}
        </div>
      </div>

      {/* Resolved forecasts */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-card overflow-hidden">
        <div className="border-b border-slate-100 px-4 py-3"><h3 className="text-sm font-black uppercase tracking-wider text-slate-500">Resolved forecasts</h3></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="border-b border-slate-100 text-[10px] uppercase tracking-[0.15em] text-slate-500">
              <tr>
                <th className="px-4 py-2">Symbol</th>
                <th className="px-4 py-2">Basis</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Predicted ETA</th>
                <th className="px-4 py-2">Actual</th>
                <th className="px-4 py-2 text-right">Timing</th>
                <th className="px-4 py-2 text-right">Score</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {data?.resolved.length ? data.resolved.map((f) => (
                <tr key={`${f.id}-${f.resolvedAt}`} className="hover:bg-slate-50/70">
                  <td className="px-4 py-2"><span className="font-black text-slate-900">{f.symbol}</span> <span className="text-[10px] font-bold text-slate-400">{f.timeframe}</span></td>
                  <td className="px-4 py-2 text-[12px] font-semibold text-slate-500">{BASIS_LABEL[f.forecastBasis] || f.forecastBasis}</td>
                  <td className="px-4 py-2"><span className={`rounded border px-1.5 py-0.5 text-[10px] font-black ${statusClass(f.status)}`}>{f.status}</span></td>
                  <td className="px-4 py-2 text-xs"><DateCell value={f.expectedExecutionTime} /></td>
                  <td className="px-4 py-2 text-xs"><DateCell value={f.actualExecutionTime} /></td>
                  <td className="px-4 py-2 text-right font-mono">{num(f.timingAccuracy, '%')}</td>
                  <td className="px-4 py-2 text-right font-mono">{num(f.scoreAccuracy, '%')}</td>
                </tr>
              )) : (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-sm font-medium text-slate-400">No resolved forecasts yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
