import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, ScrollText, Info, ArrowRight, Filter, X } from 'lucide-react';
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

/**
 * Outcome classification.
 *
 * A settled trade is judged on its R, not on which label it stopped at: a TP1 that gave back
 * most of the move is not automatically a win, and using the status alone would disagree with
 * the expectancy figures sitting beside it. Anything unsettled is OPEN; anything that never
 * became a trade is NONE, kept separate so "no setup" cannot be counted as a loss.
 */
function predictedOutcome(i: AiResultItem): 'WIN' | 'LOSS' | 'OPEN' | 'NONE' {
  const settled = ['TP1', 'TP2', 'TP3', 'STOPPED'].includes(i.predicted.status) && i.predicted.r !== null;
  if (settled) return (i.predicted.r as number) > 0 ? 'WIN' : 'LOSS';
  if (['RUNNING', 'WAITING'].includes(i.predicted.status)) return 'OPEN';
  return 'NONE';
}
function actualOutcome(i: AiResultItem): 'WIN' | 'LOSS' | 'OPEN' | 'NONE' {
  if (!i.actual) return 'NONE';
  if (i.actual.status === 'CLOSED' && i.actual.profitUsd !== null) return i.actual.profitUsd > 0 ? 'WIN' : 'LOSS';
  if (['QUEUED', 'SENT', 'PLACED', 'FILLED'].includes(i.actual.status)) return 'OPEN';
  return 'NONE';
}

function aggregate(
  items: AiResultItem[],
  rOf: (i: AiResultItem) => number | null,
  isSettled: (i: AiResultItem) => boolean,
) {
  const settled = items.filter(isSettled);
  const wins = settled.filter((x) => (rOf(x) ?? 0) > 0).length;
  const net = settled.reduce((s, x) => s + (rOf(x) || 0), 0);
  return {
    settled: settled.length, wins, losses: settled.length - wins,
    winRate: settled.length ? Math.round((wins / settled.length) * 100) : null,
    netR: Math.round(net * 100) / 100,
    expectancyR: settled.length ? Math.round((net / settled.length) * 100) / 100 : null,
  };
}

interface Filters {
  symbol: string; timeframe: string; style: string; grade: string; direction: string;
  predicted: string; actual: string; traded: string; minConf: string; mismatch: string;
}
const NO_FILTERS: Filters = {
  symbol: 'ALL', timeframe: 'ALL', style: 'ALL', grade: 'ALL', direction: 'ALL',
  predicted: 'ALL', actual: 'ALL', traded: 'ALL', minConf: 'ALL', mismatch: 'NO',
};

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

/** A compact labelled select. The label rides inside so a dozen of them stay one row. */
function Sel({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: [string, string][];
}) {
  const isSet = value !== options[0][0];
  return (
    <label className={`flex items-center gap-1 rounded-lg border px-1.5 py-1 transition ${
      isSet ? 'border-violet-400 bg-violet-50' : 'border-slate-200 bg-white'}`}>
      <span className={`text-[9px] font-black uppercase tracking-wider ${isSet ? 'text-violet-500' : 'text-slate-300'}`}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className={`cursor-pointer bg-transparent text-[11px] font-bold outline-none ${isSet ? 'text-violet-800' : 'text-slate-600'}`}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

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
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [f, setF] = useState({ ...NO_FILTERS });
  const set = (k: keyof Filters, v: string) => setF((s) => ({ ...s, [k]: v }));

  // Only `days` is a server filter — it is a SQL date bound. Everything else runs here so the
  // summary can be recomputed for whatever subset is on screen.
  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await fetchAiResults({ days })); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'could not load AI results'); }
    finally { setLoading(false); }
  }, [days]);

  useEffect(() => { void load(); const t = setInterval(() => void load(), 30000); return () => clearInterval(t); }, [load]);

  const doCancel = async (orderId: string) => {
    setBusyId(orderId);
    try { await cancelAiOrder(orderId); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'cancel failed'); }
    finally { setBusyId(null); }
  };

  const all = data?.items || [];
  const items = useMemo(() => all.filter((i) => {
    if (f.symbol !== 'ALL' && i.symbol !== f.symbol) return false;
    if (f.timeframe !== 'ALL' && i.timeframe !== f.timeframe) return false;
    if (f.style !== 'ALL' && (i.style || '—') !== f.style) return false;
    if (f.grade !== 'ALL' && (i.setupGrade || '—') !== f.grade) return false;
    if (f.direction !== 'ALL' && !String(i.decision || '').toUpperCase().includes(f.direction)) return false;
    if (f.predicted !== 'ALL' && predictedOutcome(i) !== f.predicted) return false;
    if (f.actual !== 'ALL' && actualOutcome(i) !== f.actual) return false;
    if (f.traded === 'YES' && !i.actual) return false;
    if (f.traded === 'NO' && i.actual) return false;
    if (f.minConf !== 'ALL' && (i.confidence ?? -1) < Number(f.minConf)) return false;
    // The rows worth staring at: the replay and the broker reached opposite conclusions.
    if (f.mismatch === 'YES') {
      const p = predictedOutcome(i), a = actualOutcome(i);
      if (!(p === 'WIN' && a === 'LOSS') && !(p === 'LOSS' && a === 'WIN')) return false;
    }
    return true;
  }), [all, f]);

  // Recomputed from the FILTERED rows, not the server totals — otherwise the filters would
  // change the table while the headline numbers kept describing everything, which is the
  // quickest way to draw a confident conclusion from the wrong denominator.
  const p = useMemo(() => aggregate(items, (x) => x.predicted.r,
    (x) => ['TP1', 'TP2', 'TP3', 'STOPPED'].includes(x.predicted.status) && x.predicted.r !== null), [items]);
  const a = useMemo(() => aggregate(items, (x) => x.actual?.r ?? null,
    (x) => x.actual?.status === 'CLOSED' && x.actual?.profitUsd !== null), [items]);
  const g = useMemo(() => {
    const both = items.filter((x) => x.actual?.r !== null && x.actual !== null && x.predicted.r !== null);
    const slip = items.filter((x) => x.actual?.slippagePips !== null && x.actual !== undefined && x.actual !== null);
    const mean = (arr: AiResultItem[], pick: (x: AiResultItem) => number | null) =>
      arr.length ? Math.round((arr.reduce((s, x) => s + (pick(x) || 0), 0) / arr.length) * 100) / 100 : null;
    return {
      pairs: both.length,
      predictedR: mean(both, (x) => x.predicted.r),
      actualR: mean(both, (x) => x.actual?.r ?? null),
      avgSlippagePips: mean(slip, (x) => x.actual?.slippagePips ?? null),
    };
  }, [items]);

  const placed = items.filter((i) => i.actual).length;
  const openOrders = items.filter((i) => i.actual && ['PLACED', 'SENT', 'FILLED', 'QUEUED'].includes(i.actual.status)).length;
  const netUsd = items.reduce((s, i) => s + (i.actual?.status === 'CLOSED' ? (i.actual.profitUsd || 0) : 0), 0);

  const uniq = (pick: (i: AiResultItem) => string) => [...new Set(all.map(pick))].filter(Boolean).sort();
  const activeFilters = (Object.keys(NO_FILTERS) as (keyof Filters)[]).filter((k) => f[k] !== NO_FILTERS[k]).length;

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
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}
            className="rounded-lg border border-slate-200 px-2 py-1.5 text-[12px] font-bold text-slate-600">
            {[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}
          </select>
          <button type="button" onClick={() => void load()}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[12px] font-bold text-slate-600 hover:bg-slate-50">
            {loading ? <Loader2 className="animate-spin" size={13} /> : <RefreshCw size={13} />} Refresh
          </button>
        </div>
      </div>

      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] font-bold text-rose-700">{error}</div>}

      {/* Filters. Everything below recomputes from these, headline numbers included — a filter
          that changed only the table would invite reading a win rate off the wrong denominator. */}
      <div className="rounded-2xl border border-slate-200 bg-white p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-slate-400">
            <Filter size={11} /> Filter
          </span>

          <Sel label="Predicted" value={f.predicted} onChange={(v) => set('predicted', v)}
            options={[['ALL', 'any outcome'], ['WIN', 'predicted WIN'], ['LOSS', 'predicted LOSS'], ['OPEN', 'still running'], ['NONE', 'never traded']]} />
          <Sel label="Actual" value={f.actual} onChange={(v) => set('actual', v)}
            options={[['ALL', 'any result'], ['WIN', 'real WIN'], ['LOSS', 'real LOSS'], ['OPEN', 'order live'], ['NONE', 'not placed']]} />
          <Sel label="Traded" value={f.traded} onChange={(v) => set('traded', v)}
            options={[['ALL', 'traded or not'], ['YES', 'placed only'], ['NO', 'never placed']]} />

          <span className="mx-0.5 h-4 w-px bg-slate-200" />

          <Sel label="Symbol" value={f.symbol} onChange={(v) => set('symbol', v)}
            options={[['ALL', 'all symbols'], ...uniq((i) => i.symbol).map((x) => [x, x] as [string, string])]} />
          <Sel label="TF" value={f.timeframe} onChange={(v) => set('timeframe', v)}
            options={[['ALL', 'all TFs'], ...uniq((i) => i.timeframe).map((x) => [x, x] as [string, string])]} />
          <Sel label="Style" value={f.style} onChange={(v) => set('style', v)}
            options={[['ALL', 'any style'], ...uniq((i) => i.style || '—').map((x) => [x, x] as [string, string])]} />
          <Sel label="Dir" value={f.direction} onChange={(v) => set('direction', v)}
            options={[['ALL', 'both ways'], ['BUY', 'BUY only'], ['SELL', 'SELL only']]} />
          <Sel label="Grade" value={f.grade} onChange={(v) => set('grade', v)}
            options={[['ALL', 'any grade'], ...uniq((i) => i.setupGrade || '—').map((x) => [x, x] as [string, string])]} />
          <Sel label="Conf" value={f.minConf} onChange={(v) => set('minConf', v)}
            options={[['ALL', 'any confidence'], ['50', 'conf ≥ 50'], ['60', 'conf ≥ 60'], ['70', 'conf ≥ 70'], ['80', 'conf ≥ 80']]} />

          {/* The rows where the replay and the broker disagreed — the execution cost made
              visible one trade at a time rather than as an average. */}
          <button type="button" onClick={() => set('mismatch', f.mismatch === 'YES' ? 'NO' : 'YES')}
            className={`rounded-lg border px-2 py-1 text-[11px] font-black transition ${
              f.mismatch === 'YES' ? 'border-amber-500 bg-amber-500 text-white' : 'border-amber-200 bg-amber-50 text-amber-700 hover:border-amber-400'}`}>
            replay ≠ reality
          </button>

          <div className="ml-auto flex items-center gap-2">
            <span className="text-[11px] font-bold text-slate-400">
              showing <span className="font-black text-slate-700">{items.length}</span> of {all.length}
            </span>
            {activeFilters > 0 && (
              <button type="button" onClick={() => setF({ ...NO_FILTERS })}
                className="flex items-center gap-1 rounded-lg border border-slate-300 px-2 py-1 text-[11px] font-bold text-slate-600 hover:bg-slate-50">
                <X size={11} /> clear {activeFilters}
              </button>
            )}
          </div>
        </div>
        {activeFilters > 0 && (
          <p className="mt-1.5 text-[10px] font-bold text-violet-600">
            Every figure below describes these {items.length} analyses, not the full {all.length}.
          </p>
        )}
      </div>

      {/* The two populations, kept visually apart because they answer different questions. */}
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
          <p className="mb-2 text-[11px] font-black uppercase tracking-wider text-slate-500">
            Predicted <span className="font-bold normal-case text-slate-400">· candle replay, every analysis</span>
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Analyses" value={items.length} sub={`${p.settled} settled`} />
            <Stat label="Win rate" value={p.winRate === null ? '—' : `${p.winRate}%`} sub={`${p.wins}W / ${p.losses}L`} />
            <Stat label="Expectancy" value={num(p.expectancyR)} sub="R per trade" accent={tone(p.expectancyR)} />
            <Stat label="Net" value={num(p.netR)} sub="R total" accent={tone(p.netR)} />
          </div>
        </div>
        <div className="rounded-2xl border border-violet-200 bg-violet-50/50 p-3">
          <p className="mb-2 text-[11px] font-black uppercase tracking-wider text-violet-700">
            Actual <span className="font-bold normal-case text-violet-400">· broker fills only</span>
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Placed" value={placed} sub={`${openOrders} still open`} />
            <Stat label="Win rate" value={a.winRate === null ? '—' : `${a.winRate}%`} sub={`${a.wins}W / ${a.losses}L`} />
            <Stat label="Realised" value={money(netUsd)} sub="broker P&L" accent={tone(netUsd)} />
            <Stat label="Net" value={num(a.netR)} sub="R total" accent={tone(a.netR)} />
          </div>
        </div>
      </div>

      {/* The execution gap. Only rows with BOTH numbers, or it would compare two samples. */}
      <div className="rounded-2xl border border-slate-200 bg-white p-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[11px] font-black uppercase tracking-wider text-slate-500">Execution gap</p>
          <span className="text-[11px] font-bold text-slate-400">{g.pairs} trades measured both ways</span>
        </div>
        {g.pairs > 0 ? (
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
            {activeFilters > 0 ? 'No analysis matches these filters.' : 'No AI analyses in this window.'}
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
