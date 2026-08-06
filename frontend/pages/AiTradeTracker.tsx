import React, { useCallback, useEffect, useState } from 'react';
import {
  Brain, Loader2, RefreshCw, TrendingUp, TrendingDown, Target, Info,
} from 'lucide-react';
import { fetchAiTracks } from '../mt5Api';
import type { AiTracksResponse, AiTrack } from '../mt5Api';

/**
 * What every chart AI analysis actually did.
 *
 * The score is the claim; this page is the evidence. Its reason to exist is the calibration
 * table — a setup score that does not predict the outcome is a number, not a signal, and
 * nothing else on the page can tell you which one you have.
 */
const money = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(2)}`;
const num = (v: number | null | undefined, dp = 2) =>
  v === null || v === undefined ? '—' : v.toFixed(dp);
const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`;
const tone = (v: number | null | undefined) =>
  v === null || v === undefined ? 'text-slate-500' : v > 0 ? 'text-emerald-700' : v < 0 ? 'text-rose-700' : 'text-slate-500';

const STATUS_STYLE: Record<string, string> = {
  TP3: 'bg-emerald-600 text-white',
  TP2: 'bg-emerald-100 text-emerald-800',
  TP1: 'bg-emerald-50 text-emerald-700',
  RUNNING: 'bg-sky-100 text-sky-800',
  WAITING: 'bg-slate-100 text-slate-500',
  STOPPED: 'bg-rose-600 text-white',
  EXPIRED: 'bg-slate-100 text-slate-400',
  NO_TRADE: 'bg-slate-100 text-slate-400',
};

export default function AiTradeTracker() {
  const [data, setData] = useState<AiTracksResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(14);
  const [symbol, setSymbol] = useState('ALL');
  const [onlyTrades, setOnlyTrades] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchAiTracks({ days, symbol }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not load AI tracks');
    } finally { setLoading(false); }
  }, [days, symbol]);

  useEffect(() => { void load(); const t = setInterval(() => void load(), 30000); return () => clearInterval(t); }, [load]);

  const s = data?.summary;
  const rows = (data?.tracks || []).filter((t) => (onlyTrades ? t.status !== 'NO_TRADE' : true));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-violet-100 p-2"><Brain className="text-violet-600" size={22} /></div>
          <div>
            <h1 className="text-xl font-black text-slate-900">AI Trade Tracker</h1>
            <p className="text-xs font-medium text-slate-400">
              Every chart analysis followed to an outcome — live P&amp;L, and whether the score predicts anything.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={symbol} onChange={(e) => setSymbol(e.target.value)}
            className="rounded-lg border border-slate-200 px-2 py-1.5 text-[12px] font-bold text-slate-600">
            <option value="ALL">All symbols</option>
            {(data?.symbols || []).map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}
            className="rounded-lg border border-slate-200 px-2 py-1.5 text-[12px] font-bold text-slate-600">
            {[1, 7, 14, 30, 90].map((d) => <option key={d} value={d}>{d}d</option>)}
          </select>
          <button type="button" onClick={() => setOnlyTrades((v) => !v)}
            className={`rounded-lg px-2.5 py-1.5 text-[12px] font-bold ${onlyTrades ? 'bg-slate-900 text-white' : 'border border-slate-200 text-slate-600'}`}>
            {onlyTrades ? 'trades only' : 'incl. HOLD'}
          </button>
          <button type="button" onClick={() => void load()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] font-bold text-slate-600 hover:bg-slate-50">
            {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}Refresh
          </button>
        </div>
      </div>

      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-bold text-rose-700">{error}</div>}

      {/* Headline. Open and closed money are separate — blending an unrealised mark into a
          realised total produces a number that describes neither. */}
      {s && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {[
            { k: 'Tracked', v: s.tracked, sub: `${s.waiting} waiting` },
            { k: 'Open', v: s.open, sub: money(s.openProfitUsd) + ' unrealised' },
            { k: 'Settled', v: s.settled, sub: `${s.wins}W / ${s.losses}L` },
            { k: 'Win rate', v: pct(s.winRate), sub: 'of settled' },
            { k: 'Expectancy', v: Number.isNaN(s.expectancyR) ? '—' : `${num(s.expectancyR, 3)}R`, sub: 'per settled trade' },
            { k: 'Realised', v: money(s.closedProfitUsd), sub: `${num(s.netR, 2)}R net` },
          ].map((c) => (
            <div key={c.k} className="rounded-xl border border-slate-200 bg-white p-2.5">
              <div className="text-[10px] font-black uppercase tracking-wider text-slate-400">{c.k}</div>
              <div className={`text-lg font-black tabular-nums ${c.k === 'Realised' ? tone(s.closedProfitUsd) : 'text-slate-800'}`}>{c.v}</div>
              <div className="text-[10px] font-semibold text-slate-400">{c.sub}</div>
            </div>
          ))}
        </div>
      )}

      {/* The point of the page. */}
      {data && data.calibration.some((b) => b.n > 0) && (
        <div className="rounded-2xl border border-violet-200 bg-violet-50/50 p-3">
          <div className="mb-2 flex items-center gap-2">
            <Target size={15} className="text-violet-600" />
            <h3 className="text-sm font-black uppercase tracking-wider text-violet-800">Does the score predict the outcome?</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-[12px]">
              <thead className="text-[10px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-2 py-1 text-left font-black">Score band</th>
                  <th className="px-2 py-1 text-right font-black">Settled</th>
                  <th className="px-2 py-1 text-right font-black">Win%</th>
                  <th className="px-2 py-1 text-right font-black">Expectancy</th>
                  <th className="px-2 py-1 text-right font-black">Net R</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-violet-100">
                {data.calibration.map((b) => (
                  <tr key={b.band} className={b.n === 0 ? 'opacity-40' : ''}>
                    <td className="px-2 py-1 font-black text-slate-700">{b.band}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{b.n}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{pct(b.winRate)}</td>
                    <td className={`px-2 py-1 text-right tabular-nums font-bold ${tone(b.expectancyR)}`}>{num(b.expectancyR, 3)}R</td>
                    <td className={`px-2 py-1 text-right tabular-nums ${tone(b.netR)}`}>{num(b.netR, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1.5 text-[11px] text-slate-500">
            A higher band should show higher expectancy. If it does not, the score is a number rather
            than a signal — and only enough settled trades can tell you which.
          </p>
        </div>
      )}

      {/* Tracks */}
      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[980px] text-[12px]">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-2.5 py-2 text-left font-black">When</th>
              <th className="px-2.5 py-2 text-left font-black">Market</th>
              <th className="px-2.5 py-2 text-left font-black">Call</th>
              <th className="px-2.5 py-2 text-right font-black">Score</th>
              <th className="px-2.5 py-2 text-right font-black">Entry / Stop</th>
              <th className="px-2.5 py-2 text-left font-black">Status</th>
              <th className="px-2.5 py-2 text-right font-black">R</th>
              <th className="px-2.5 py-2 text-right font-black">P&amp;L</th>
              <th className="px-2.5 py-2 text-right font-black">MFE / MAE</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((t: AiTrack) => {
              const buy = /BUY/.test(String(t.decision || ''));
              const sell = /SELL/.test(String(t.decision || ''));
              return (
                <tr key={t.id}>
                  <td className="px-2.5 py-1.5 whitespace-nowrap text-slate-500">{String(t.createdAt).slice(5, 16).replace('T', ' ')}</td>
                  <td className="px-2.5 py-1.5 font-bold text-slate-700">{t.symbol} <span className="text-slate-400">{t.timeframe}</span></td>
                  <td className="px-2.5 py-1.5">
                    <span className={`inline-flex items-center gap-1 font-black ${buy ? 'text-emerald-700' : sell ? 'text-rose-600' : 'text-slate-400'}`}>
                      {buy ? <TrendingUp size={11} /> : sell ? <TrendingDown size={11} /> : null}
                      {t.decision || '—'}
                    </span>
                  </td>
                  <td className="px-2.5 py-1.5 text-right tabular-nums">
                    {t.score ?? '—'}{t.grade ? <span className="ml-1 text-[10px] font-bold text-slate-400">{t.grade}</span> : null}
                  </td>
                  <td className="px-2.5 py-1.5 text-right tabular-nums text-slate-500">
                    {t.entry ?? '—'}<span className="text-slate-300"> / </span>{t.stopLoss ?? '—'}
                  </td>
                  <td className="px-2.5 py-1.5">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${STATUS_STYLE[t.status] || 'bg-slate-100 text-slate-500'}`}>{t.status}</span>
                  </td>
                  <td className={`px-2.5 py-1.5 text-right tabular-nums font-bold ${tone(t.r)}`}>{num(t.r, 2)}</td>
                  <td className={`px-2.5 py-1.5 text-right tabular-nums ${tone(t.profitUsd)}`}>{money(t.profitUsd)}</td>
                  {/* Both excursions: a trade that ran your way then stopped is a different
                      failure from one that went straight to the stop. */}
                  <td className="px-2.5 py-1.5 text-right tabular-nums text-slate-400">
                    {num(t.mfeR, 1)}<span className="text-slate-300"> / </span>{num(t.maeR, 1)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {!loading && rows.length === 0 && (
        <p className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-center text-[12px] font-semibold text-slate-500">
          Nothing tracked yet. Run an AI analysis from the chart — every scored read is recorded
          automatically, including HOLD calls.
        </p>
      )}

      {data && (
        <p className="flex gap-2 text-[11px] text-slate-400">
          <Info size={13} className="mt-0.5 shrink-0" />{data.note}
        </p>
      )}
    </div>
  );
}
