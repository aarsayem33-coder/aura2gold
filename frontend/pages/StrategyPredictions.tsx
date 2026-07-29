import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Brain, Loader2, RefreshCw, ArrowUp, ArrowDown, Clock, ShieldCheck, ShieldAlert, LineChart } from 'lucide-react';
import { fetchStrategyPredictions } from '../mt5Api';
import type { StrategyPredictionResponse, StrategyPrediction } from '../types';

const HORIZONS = [1, 2, 3];

const digitsFor = (s: string) => {
  const u = (s || '').toUpperCase();
  if (/XAU|GOLD|XAG/.test(u)) return 2;
  if (u.includes('JPY')) return 3;
  return 5;
};

export default function StrategyPredictions() {
  const [horizon, setHorizon] = useState(3);
  // Filters run on the already-fetched list rather than refetching: the scan is expensive
  // (600 evaluations) and the result set is small, so narrowing it should be instant.
  const [fStrategy, setFStrategy] = useState('');
  const [fTimeframe, setFTimeframe] = useState('');
  const [fSymbol, setFSymbol] = useState('');
  const [fDirection, setFDirection] = useState('');
  const [fOrderType, setFOrderType] = useState('');
  const [fMinScore, setFMinScore] = useState(0);
  const [fChallengeOnly, setFChallengeOnly] = useState(false);
  const [data, setData] = useState<StrategyPredictionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (spin = false) => {
    if (spin) setLoading(true);
    try { setData(await fetchStrategyPredictions(horizon)); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed to load predictions'); }
    finally { setLoading(false); }
  }, [horizon]);

  useEffect(() => {
    load(true);
    const t = setInterval(() => load(false), 60000);
    return () => clearInterval(t);
  }, [load]);

  const all = data?.predictions || [];
  const ch = data?.challenge;

  // Options come from what is actually on the board, so you can never pick a combination
  // that returns nothing by construction.
  const uniq = (pick: (p: StrategyPrediction) => string) =>
    Array.from(new Set(all.map(pick).filter(Boolean))).sort();
  const strategyOptions = Array.from(
    new Map(all.map((p) => [p.strategy, p.strategyName])).entries(),
  ).sort((a, b) => a[1].localeCompare(b[1]));
  const timeframeOptions = uniq((p) => p.timeframe);
  const symbolOptions = uniq((p) => p.symbol);
  const orderTypeOptions = uniq((p) => p.orderType);

  const rows = all.filter((p) => (
    (!fStrategy || p.strategy === fStrategy)
    && (!fTimeframe || p.timeframe === fTimeframe)
    && (!fSymbol || p.symbol === fSymbol)
    && (!fDirection || p.direction === fDirection)
    && (!fOrderType || p.orderType === fOrderType)
    && (p.score ?? 0) >= fMinScore
    && (!fChallengeOnly || p.challengeOk)
  ));
  const filtersActive = Boolean(fStrategy || fTimeframe || fSymbol || fDirection || fOrderType || fMinScore > 0 || fChallengeOnly);
  const clearFilters = () => {
    setFStrategy(''); setFTimeframe(''); setFSymbol(''); setFDirection(''); setFOrderType('');
    setFMinScore(0); setFChallengeOnly(false);
  };

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 pb-24">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-black text-slate-900">
            <Brain size={22} className="text-violet-500" />Strategy Predictions
          </h1>
          <p className="text-sm font-semibold text-slate-500">
            Every enabled strategy across every live symbol — kept only when the whole trade fits the window, sized to your challenge rules.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-lg border border-slate-200 bg-slate-50 p-0.5">
            {HORIZONS.map((h) => (
              <button
                key={h} type="button" onClick={() => setHorizon(h)}
                className={`rounded-md px-3 py-1 text-xs font-bold transition ${horizon === h ? 'bg-violet-600 text-white' : 'text-slate-500 hover:bg-white'}`}
              >
                {h}h
              </button>
            ))}
          </div>
          <button onClick={() => load(true)} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-bold text-slate-600 hover:bg-slate-50">
            {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}Refresh
          </button>
        </div>
      </div>

      {/* Scan + challenge context, so the numbers below are attributable */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Setups in window</p>
          <p className="text-lg font-black text-slate-800">{data?.count ?? '—'}</p>
          <p className="text-[10px] font-medium text-slate-400">
            {data ? `${data.scanned.evaluated} evaluated · ${data.scanned.outsideHorizon} beyond ${horizon}h` : ''}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Scanned</p>
          <p className="text-lg font-black text-slate-800">
            {data ? `${data.scanned.symbols} × ${data.scanned.strategies}` : '—'}
          </p>
          <p className="text-[10px] font-medium text-slate-400">{data?.scanned.timeframes.join(' · ')}</p>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50/50 px-4 py-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-amber-700">Challenge account</p>
          <p className="text-lg font-black text-amber-900">{ch?.account || '—'}</p>
          <p className="text-[10px] font-medium text-amber-700">{ch?.broker || ''}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Risk per trade</p>
          <p className="text-lg font-black text-slate-800">{ch ? `${ch.riskPerTradePct}%` : '—'}</p>
          <p className="text-[10px] font-medium text-slate-400">
            {ch ? `cap ${ch.maxRiskPerTradePct}% · safe $${ch.safePerTradeRisk}` : ''}
          </p>
        </div>
      </div>

      {err && <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">{err}</div>}

      {/* Filters. Every control narrows the same fetched list. */}
      <div className="flex flex-wrap items-end gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3">
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Strategy</span>
          <select value={fStrategy} onChange={(e) => setFStrategy(e.target.value)}
            className={`rounded-lg border px-2 py-1.5 text-xs font-bold ${fStrategy ? 'border-violet-400 bg-violet-50 text-violet-800' : 'border-slate-300 text-slate-700'}`}>
            <option value="">All ({strategyOptions.length})</option>
            {strategyOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Timeframe</span>
          <select value={fTimeframe} onChange={(e) => setFTimeframe(e.target.value)}
            className={`rounded-lg border px-2 py-1.5 text-xs font-bold ${fTimeframe ? 'border-violet-400 bg-violet-50 text-violet-800' : 'border-slate-300 text-slate-700'}`}>
            <option value="">All</option>
            {timeframeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Symbol</span>
          <select value={fSymbol} onChange={(e) => setFSymbol(e.target.value)}
            className={`rounded-lg border px-2 py-1.5 text-xs font-bold ${fSymbol ? 'border-violet-400 bg-violet-50 text-violet-800' : 'border-slate-300 text-slate-700'}`}>
            <option value="">All ({symbolOptions.length})</option>
            {symbolOptions.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Setup</span>
          <select value={fDirection} onChange={(e) => setFDirection(e.target.value)}
            className={`rounded-lg border px-2 py-1.5 text-xs font-bold ${fDirection ? 'border-violet-400 bg-violet-50 text-violet-800' : 'border-slate-300 text-slate-700'}`}>
            <option value="">Buy &amp; sell</option>
            <option value="BUY">Buy only</option>
            <option value="SELL">Sell only</option>
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Order</span>
          <select value={fOrderType} onChange={(e) => setFOrderType(e.target.value)}
            className={`rounded-lg border px-2 py-1.5 text-xs font-bold ${fOrderType ? 'border-violet-400 bg-violet-50 text-violet-800' : 'border-slate-300 text-slate-700'}`}>
            <option value="">All</option>
            {orderTypeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Min score {fMinScore || ''}</span>
          <div className="flex items-center gap-1.5">
            <input type="range" min={0} max={100} step={5} value={fMinScore}
              onChange={(e) => setFMinScore(Number(e.target.value))} className="w-28 accent-violet-600" />
            <span className={`w-8 text-xs font-black ${fMinScore ? 'text-violet-700' : 'text-slate-400'}`}>{fMinScore || 'any'}</span>
          </div>
        </label>
        <button type="button" onClick={() => setFChallengeOnly((v) => !v)}
          className={`rounded-lg border px-2.5 py-1.5 text-xs font-bold ${fChallengeOnly ? 'border-emerald-400 bg-emerald-50 text-emerald-800' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}>
          Challenge-compliant only
        </button>
        <span className="ml-auto flex items-center gap-2 text-[11px] font-bold text-slate-500">
          {rows.length} of {all.length}
          {filtersActive && (
            <button type="button" onClick={clearFilters} className="rounded-lg border border-slate-300 px-2 py-1 text-[11px] font-bold text-slate-600 hover:bg-slate-50">
              Clear
            </button>
          )}
        </span>
      </div>

      <div className="space-y-2">
        {rows.map((p: StrategyPrediction, i: number) => {
          const d = digitsFor(p.symbol);
          const px = (v?: number | null) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));
          const buy = p.direction === 'BUY';
          return (
            <div key={`${p.strategy}-${p.symbol}-${p.timeframe}`} className="rounded-2xl border border-slate-200 bg-white px-5 py-3 shadow-card">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] font-black text-slate-400">#{i + 1}</span>
                  <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-black text-white ${buy ? 'bg-emerald-600' : 'bg-rose-600'}`}>
                    {buy ? <ArrowUp size={11} /> : <ArrowDown size={11} />}{p.direction}
                  </span>
                  <span className="text-sm font-black text-slate-900">{p.symbol}</span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-black text-slate-600">{p.timeframe}</span>
                  <span className="text-xs font-bold text-slate-500">{p.strategyName}</span>
                  {p.grade && <span className="rounded bg-slate-900 px-1.5 py-0.5 text-[10px] font-black text-white">{p.grade}</span>}
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">{p.orderType}</span>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-[11px] font-bold">
                  <span className="inline-flex items-center gap-1 text-slate-500">
                    <Clock size={12} />entry <span className="text-slate-800">{p.etaLabel}</span> · to TP1 <span className="text-slate-800">{p.resolveLabel}</span>
                  </span>
                  <span className="text-slate-400">score <span className="text-slate-800">{p.score}</span></span>
                  <span className="text-violet-600">rank {p.rankScore}</span>
                </div>
              </div>

              {/* The ticket */}
              <div className="mt-2 grid gap-2 text-[11px] sm:grid-cols-3 lg:grid-cols-6">
                <span className="text-slate-500">entry <span className="block font-mono text-sm font-bold text-slate-800">{px(p.entry)}</span></span>
                <span className="text-slate-500">stop <span className="block font-mono text-sm font-bold text-rose-600">{px(p.stopLoss)}</span></span>
                <span className="text-slate-500">TP1 <span className="block font-mono text-sm font-bold text-emerald-700">{px(p.takeProfit1)}</span></span>
                <span className="text-slate-500">R:R <span className="block text-sm font-black text-slate-800">{p.rr ?? '—'}</span></span>
                <span className="text-slate-500">lots <span className="block text-sm font-black text-slate-800">{p.lots ?? '—'}</span></span>
                <span className="text-slate-500">risk <span className="block text-sm font-black text-slate-800">${p.lossAtStop ?? '—'}</span></span>
              </div>

              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                {p.challengeOk ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-black text-emerald-700">
                    <ShieldCheck size={11} />WITHIN CHALLENGE RULES ({p.riskPct}% · {p.stopPips}p stop)
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-black text-amber-800">
                    <ShieldAlert size={11} />{p.challengeWarnings?.[0] || 'challenge guard would refuse this'}
                  </span>
                )}
                <Link
                  to={`/chart/liquidity?symbol=${encodeURIComponent(p.symbol)}&tf=${encodeURIComponent(p.timeframe)}`}
                  className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-0.5 text-[10px] font-bold text-slate-500 hover:bg-slate-50"
                >
                  <LineChart size={11} />see the liquidity
                </Link>
                {p.timingMessage && <span className="text-[10px] font-medium text-slate-400">{p.timingMessage}</span>}
              </div>
            </div>
          );
        })}

        {!rows.length && !loading && (
          <div className="rounded-2xl border border-slate-200 bg-white px-5 py-10 text-center text-sm font-semibold text-slate-400">
            {all.length
              ? <>All {all.length} setups were filtered out. <button type="button" onClick={clearFilters} className="underline">Clear the filters</button> to see them.</>
              : <>No setup currently fits a {horizon}-hour window. {data ? `${data.scanned.evaluated} evaluated.` : ''}</>}
          </div>
        )}
        {loading && !rows.length && (
          <div className="rounded-2xl border border-slate-200 bg-white px-5 py-10 text-center text-slate-400">
            <Loader2 className="mx-auto animate-spin" /> Evaluating every strategy…
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-slate-50 px-5 py-4">
        <h3 className="text-sm font-bold text-slate-900">How to read these</h3>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] font-medium text-slate-600">
          {(data?.caveats || []).map((c, i) => <li key={i}>{c}</li>)}
          <li>Ranked on quality AND timing: an equal score that resolves sooner ranks higher.</li>
        </ul>
        <p className="mt-2 text-[10px] font-medium text-slate-400">
          Scenarios, not predictions of price. Educational analysis — not financial advice.
        </p>
      </div>
    </div>
  );
}
