import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, ScrollText, Info, ArrowRight } from 'lucide-react';
import { fetchAiResults, cancelAiOrder } from '../mt5Api';
import type { AiResultsResponse, AiResultItem } from '../mt5Api';

/**
 * Predicted vs actually executed.
 *
 * Two different questions, deliberately not merged into one number. PREDICTED replays candles
 * against the plan and covers every analysis, including the ones never traded — the only
 * unbiased sample of the model's judgement. ACTUAL is broker truth and exists only where an
 * order was placed.
 *
 * The gap between them is execution cost: a replay fills at the exact planned price with no
 * spread, no slippage and no rejected order. Reporting only the replay would flatter the
 * system; reporting only the fills would throw away every call you chose not to take.
 */
const money = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(2)}`;
const num = (v: number | null | undefined, dp = 2) =>
  v === null || v === undefined ? '—' : v.toFixed(dp);
const tone = (v: number | null | undefined) =>
  v === null || v === undefined ? 'text-slate-500' : v > 0 ? 'text-emerald-700' : v < 0 ? 'text-rose-700' : 'text-slate-500';

const PRED_STYLE: Record<string, string> = {
  TP3: 'bg-emerald-600 text-white', TP2: 'bg-emerald-100 text-emerald-800',
  TP1: 'bg-emerald-50 text-emerald-700', RUNNING: 'bg-sky-100 text-sky-800',
  WAITING: 'bg-slate-100 text-slate-500', STOPPED: 'bg-rose-600 text-white',
  EXPIRED: 'bg-slate-100 text-slate-400', NO_TRADE: 'bg-slate-100 text-slate-400',
};
const ORDER_STYLE: Record<string, string> = {
  CLOSED: 'bg-slate-800 text-white', FILLED: 'bg-emerald-600 text-white',
  PLACED: 'bg-sky-100 text-sky-800', SENT: 'bg-sky-50 text-sky-700',
  QUEUED: 'bg-amber-100 text-amber-800', CANCELLING: 'bg-amber-50 text-amber-700',
  CANCELLED: 'bg-slate-100 text-slate-400', REJECTED: 'bg-slate-100 text-slate-400',
  EXPIRED: 'bg-slate-100 text-slate-400', ERROR: 'bg-rose-600 text-white',
};

function Stat({ label, value, sub, accent }: { label: string; value: React.ReactNode; sub?: React.ReactNode; accent?: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3">
      <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">{label}</p>
      <p className={`mt-0.5 text-lg font-black ${accent || 'text-slate-900'}`}>{value}</p>
      {sub && <p className="text-[10px] font-bold text-slate-400">{sub}</p>}
    </div>
  );
}

export default function AiResults() {
  const [data, setData] = useState<AiResultsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [symbol, setSymbol] = useState('ALL');
  const [onlyPlaced, setOnlyPlaced] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await fetchAiResults({ days, symbol })); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'could not load AI results'); }
    finally { setLoading(false); }
  }, [days, symbol]);

  useEffect(() => { void load(); const t = setInterval(() => void load(), 30000); return () => clearInterval(t); }, [load]);

  const doCancel = async (orderId: string) => {
    setBusyId(orderId);
    try { await cancelAiOrder(orderId); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'cancel failed'); }
    finally { setBusyId(null); }
  };

  const items = (data?.items || []).filter((i) => (onlyPlaced ? i.actual !== null : true));
  const symbols = [...new Set((data?.items || []).map((i) => i.symbol))].sort();
  const p = data?.predicted, a = data?.actual, g = data?.gap;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-violet-100 p-2"><ScrollText className="text-violet-600" size={22} /></div>
          <div>
            <h1 className="text-xl font-black text-slate-900">AI Results</h1>
            <p className="text-xs font-medium text-slate-400">
              What the model predicted, next to what the broker actually paid.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={symbol} onChange={(e) => setSymbol(e.target.value)}
            className="rounded-lg border border-slate-200 px-2 py-1.5 text-[12px] font-bold text-slate-600">
            <option value="ALL">All symbols</option>
            {symbols.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}
            className="rounded-lg border border-slate-200 px-2 py-1.5 text-[12px] font-bold text-slate-600">
            {[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}
          </select>
          <button type="button" onClick={() => setOnlyPlaced((v) => !v)}
            className={`rounded-lg border px-2 py-1.5 text-[12px] font-bold transition ${
              onlyPlaced ? 'border-violet-500 bg-violet-500 text-white' : 'border-slate-200 text-slate-500 hover:border-slate-300'}`}>
            {onlyPlaced ? 'traded only' : 'all analyses'}
          </button>
          <button type="button" onClick={() => void load()}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[12px] font-bold text-slate-600 hover:bg-slate-50">
            {loading ? <Loader2 className="animate-spin" size={13} /> : <RefreshCw size={13} />} Refresh
          </button>
        </div>
      </div>

      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] font-bold text-rose-700">{error}</div>}

      {/* The two populations, kept visually apart because they answer different questions. */}
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
          <p className="mb-2 text-[11px] font-black uppercase tracking-wider text-slate-500">
            Predicted <span className="font-bold normal-case text-slate-400">· candle replay, every analysis</span>
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Tracked" value={p?.tracked ?? '—'} sub={`${p?.settled ?? 0} settled`} />
            <Stat label="Win rate" value={p?.winRate === null || p?.winRate === undefined ? '—' : `${p.winRate}%`} sub={`${p?.wins ?? 0}W / ${p?.losses ?? 0}L`} />
            <Stat label="Expectancy" value={num(p?.expectancyR)} sub="R per trade" accent={tone(p?.expectancyR)} />
            <Stat label="Net" value={num(p?.netR)} sub="R total" accent={tone(p?.netR)} />
          </div>
        </div>
        <div className="rounded-2xl border border-violet-200 bg-violet-50/50 p-3">
          <p className="mb-2 text-[11px] font-black uppercase tracking-wider text-violet-700">
            Actual <span className="font-bold normal-case text-violet-400">· broker fills only</span>
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Placed" value={a?.placed ?? 0} sub={`${a?.open ?? 0} still open`} />
            <Stat label="Win rate" value={a?.winRate === null || a?.winRate === undefined ? '—' : `${a.winRate}%`} sub={`${a?.wins ?? 0}W / ${a?.losses ?? 0}L`} />
            <Stat label="Realised" value={money(a?.netProfitUsd)} sub="broker P&L" accent={tone(a?.netProfitUsd)} />
            <Stat label="Net" value={num(a?.netR)} sub="R total" accent={tone(a?.netR)} />
          </div>
        </div>
      </div>

      {/* The execution gap. Only rows with BOTH numbers, or it would compare two samples. */}
      <div className="rounded-2xl border border-slate-200 bg-white p-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[11px] font-black uppercase tracking-wider text-slate-500">Execution gap</p>
          <span className="text-[11px] font-bold text-slate-400">{g?.pairs ?? 0} trades measured both ways</span>
        </div>
        {g && g.pairs > 0 ? (
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <span className={`font-mono text-lg font-black ${tone(g.predictedR)}`}>{num(g.predictedR)}R</span>
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">predicted</span>
            <ArrowRight size={16} className="text-slate-300" />
            <span className={`font-mono text-lg font-black ${tone(g.actualR)}`}>{num(g.actualR)}R</span>
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">actual</span>
            {g.predictedR !== null && g.actualR !== null && (
              <span className={`rounded px-2 py-0.5 text-[11px] font-black ${g.actualR >= g.predictedR ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
                {g.actualR >= g.predictedR ? '+' : ''}{(g.actualR - g.predictedR).toFixed(2)}R vs replay
              </span>
            )}
            {g.avgSlippagePips !== null && (
              <span className="ml-auto text-[11px] font-bold text-slate-500">
                avg slippage <span className={`font-mono font-black ${g.avgSlippagePips > 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{num(g.avgSlippagePips, 1)}</span> pips
              </span>
            )}
          </div>
        ) : (
          <p className="mt-1 text-[11px] font-medium text-slate-400">
            No trade has been both predicted and executed yet. Place an AI plan as an order and its real fill will appear here beside the replay.
          </p>
        )}
      </div>

      {/* Per-analysis detail. */}
      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
        <table className="w-full min-w-[1040px] text-left text-[12px]">
          <thead className="border-b border-slate-200 bg-slate-50 text-[10px] font-black uppercase tracking-wider text-slate-400">
            <tr>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">Market</th>
              <th className="px-3 py-2">Call</th>
              <th className="px-3 py-2 text-right">Conf</th>
              <th className="px-3 py-2 text-right">Score</th>
              <th className="px-3 py-2">Predicted</th>
              <th className="px-3 py-2 text-right">Pred R</th>
              <th className="px-3 py-2">Order</th>
              <th className="px-3 py-2 text-right">Real R</th>
              <th className="px-3 py-2 text-right">P&amp;L</th>
              <th className="px-3 py-2 text-right">Slip</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {items.map((i: AiResultItem) => (
              <React.Fragment key={i.id}>
                <tr className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                  <td className="whitespace-nowrap px-3 py-2 font-bold text-slate-500">
                    {i.createdAt ? new Date(i.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-black text-slate-800">{i.symbol} <span className="font-bold text-slate-400">{i.timeframe}</span></td>
                  <td className="px-3 py-2">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${
                      String(i.decision).includes('BUY') ? 'bg-emerald-100 text-emerald-800'
                        : String(i.decision).includes('SELL') ? 'bg-rose-100 text-rose-800' : 'bg-slate-100 text-slate-500'}`}>
                      {i.decision || '—'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-bold text-slate-600">{i.confidence ?? '—'}</td>
                  <td className="px-3 py-2 text-right font-bold text-slate-600">
                    {i.setupScore ?? '—'}{i.setupGrade ? <span className="ml-1 text-slate-400">{i.setupGrade}</span> : null}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${PRED_STYLE[i.predicted.status] || 'bg-slate-100 text-slate-500'}`}>
                      {i.predicted.status}
                    </span>
                  </td>
                  <td className={`px-3 py-2 text-right font-mono font-black ${tone(i.predicted.r)}`}>{num(i.predicted.r)}</td>
                  <td className="px-3 py-2">
                    {i.actual ? (
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${ORDER_STYLE[i.actual.status] || 'bg-slate-100 text-slate-500'}`}>
                        {i.actual.orderType} {i.actual.status}
                      </span>
                    ) : <span className="text-[11px] font-bold text-slate-300">not traded</span>}
                  </td>
                  <td className={`px-3 py-2 text-right font-mono font-black ${tone(i.actual?.r)}`}>{num(i.actual?.r)}</td>
                  <td className={`px-3 py-2 text-right font-mono font-black ${tone(i.actual?.profitUsd)}`}>{money(i.actual?.profitUsd)}</td>
                  <td className={`px-3 py-2 text-right font-mono font-bold ${i.actual?.slippagePips ? (i.actual.slippagePips > 0 ? 'text-rose-600' : 'text-emerald-600') : 'text-slate-400'}`}>
                    {i.actual?.slippagePips === null || i.actual?.slippagePips === undefined ? '—' : num(i.actual.slippagePips, 1)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button type="button" onClick={() => setOpenId(openId === i.id ? null : i.id)}
                      className="text-[10px] font-black uppercase tracking-wider text-violet-600 hover:text-violet-800">
                      {openId === i.id ? 'hide' : 'detail'}
                    </button>
                  </td>
                </tr>
                {openId === i.id && (
                  <tr className="border-b border-slate-100 bg-slate-50/80">
                    <td colSpan={12} className="px-3 py-2.5">
                      <div className="grid gap-3 md:grid-cols-3">
                        <div>
                          <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">The plan</p>
                          <p className="mt-0.5 font-mono text-[11px] font-bold text-slate-700">
                            entry {num(i.plan.entry, 5)} · SL {num(i.plan.stopLoss, 5)}
                          </p>
                          <p className="font-mono text-[11px] font-bold text-slate-500">
                            TP {num(i.plan.takeProfit1, 5)} / {num(i.plan.takeProfit2, 5)} / {num(i.plan.takeProfit3, 5)}
                          </p>
                          <p className="text-[11px] font-bold text-slate-500">
                            {i.plan.lots ?? '—'} lots · R:R {num(i.plan.riskReward)}
                          </p>
                        </div>
                        <div>
                          <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Replay says</p>
                          <p className="mt-0.5 text-[11px] font-bold text-slate-600">
                            {i.predicted.entered ? 'entered' : 'never entered'} · MFE {num(i.predicted.mfeR)}R · MAE {num(i.predicted.maeR)}R
                          </p>
                          {i.predicted.exitPrice !== null && (
                            <p className="font-mono text-[11px] font-bold text-slate-500">exit {num(i.predicted.exitPrice, 5)} after {i.predicted.barsHeld ?? '—'} bars</p>
                          )}
                          {i.predicted.note && <p className="mt-0.5 text-[11px] font-medium text-slate-500">{i.predicted.note}</p>}
                        </div>
                        <div>
                          <p className="text-[10px] font-black uppercase tracking-wider text-violet-500">The broker says</p>
                          {i.actual ? (
                            <>
                              <p className="mt-0.5 font-mono text-[11px] font-bold text-slate-700">
                                {i.actual.ticket ? `ticket ${i.actual.ticket}` : 'no ticket yet'}
                                {i.actual.fillPrice !== null && ` · filled ${num(i.actual.fillPrice, 5)}`}
                              </p>
                              {i.actual.closePrice !== null && (
                                <p className="font-mono text-[11px] font-bold text-slate-500">closed {num(i.actual.closePrice, 5)}</p>
                              )}
                              <p className="text-[11px] font-bold text-slate-500">
                                {i.actual.orderedLots ?? '—'} lots · risked {money(i.actual.riskAmount)}
                              </p>
                              {i.actual.reason && <p className="mt-0.5 text-[11px] font-medium leading-snug text-slate-500">{i.actual.reason}</p>}
                              {['QUEUED', 'SENT', 'PLACED'].includes(i.actual.status) && (
                                <button type="button" disabled={busyId === i.actual.orderId}
                                  onClick={() => void doCancel(i.actual!.orderId)}
                                  className="mt-1 rounded-lg border border-rose-200 px-2 py-1 text-[10px] font-black text-rose-600 hover:bg-rose-50 disabled:text-slate-300">
                                  {busyId === i.actual.orderId ? 'cancelling…' : 'cancel this order'}
                                </button>
                              )}
                            </>
                          ) : (
                            <p className="mt-0.5 text-[11px] font-medium text-slate-400">Never placed — the replay above is the only measurement of this call.</p>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
        {!items.length && !loading && (
          <p className="px-3 py-6 text-center text-[12px] font-bold text-slate-400">
            {onlyPlaced ? 'No AI plan has been placed as an order yet.' : 'No AI analyses in this window.'}
          </p>
        )}
      </div>

      {data?.notes?.length ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-slate-400">
            <Info size={11} /> How to read this
          </p>
          {data.notes.map((nte) => <p key={nte} className="mt-0.5 text-[11px] font-medium leading-snug text-slate-500">{nte}</p>)}
        </div>
      ) : null}
    </div>
  );
}
