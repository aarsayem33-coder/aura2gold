import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Loader2, Newspaper, RefreshCcw, ShieldAlert, Timer, TrendingDown, TrendingUp } from 'lucide-react';
import { fetchTradeNewsFixed, fetchTradeNewsForex } from '../mt5Api';
import type { TradeNewsFixedSignal, TradeNewsForexSignal } from '../types';

type Tab = 'forex' | 'fixed';

function price(value?: number | null, symbol?: string) {
  if (value === null || value === undefined) return 'n/a';
  const s = String(symbol || '').toUpperCase();
  return value.toFixed(/XAU|GOLD|XAG/.test(s) ? 2 : /JPY/.test(s) ? 3 : 5);
}

function directionClass(direction: string) {
  return direction === 'UP' || direction === 'BUY' ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : direction === 'DOWN' || direction === 'SELL' ? 'text-red-700 bg-red-50 border-red-200' : 'text-slate-600 bg-slate-50 border-slate-200';
}

function statusClass(status: string) {
  return status === 'ACTIVE' ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-amber-700 bg-amber-50 border-amber-200';
}

function qualityClass(tier?: string) {
  if (tier === 'QUALITY_SIGNAL') return 'text-white bg-emerald-600 border-emerald-700 animate-pulse';
  if (tier === 'TRADE_SIGNAL') return 'text-blue-800 bg-blue-50 border-blue-200';
  if (tier === 'NO_TRADE') return 'text-slate-500 bg-slate-100 border-slate-200';
  return 'text-amber-800 bg-amber-50 border-amber-200';
}

function ForexCard({ signal }: { signal: TradeNewsForexSignal }) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-xl font-black text-slate-900">{signal.symbol}</h3>
            <span className={`rounded-full border px-2.5 py-1 text-xs font-black ${directionClass(signal.directionLabel)}`}>{signal.directionLabel}</span>
            <span className={`rounded-full border px-2.5 py-1 text-xs font-black ${statusClass(signal.status)}`}>{signal.status}</span>
          </div>
          <p className="mt-1 text-sm font-bold text-slate-600">{signal.event.currency} · {signal.event.title}</p>
          <p className="text-xs font-semibold text-slate-400">{signal.eventType} · actual {signal.event.actual ?? 'n/a'} vs forecast {signal.event.forecast ?? 'n/a'}</p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-black text-slate-900">{Math.round(signal.confidence)}%</p>
          <p className="text-xs font-bold text-amber-600">{signal.grade}</p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-4">
        <div className="rounded-2xl bg-slate-50 p-3"><p className="text-[10px] font-black uppercase text-slate-400">Entry</p><p className="font-mono font-black">{price(signal.price, signal.symbol)}</p></div>
        <div className="rounded-2xl bg-red-50 p-3"><p className="text-[10px] font-black uppercase text-red-400">Stop</p><p className="font-mono font-black text-red-700">{price(signal.stopLoss, signal.symbol)}</p></div>
        <div className="rounded-2xl bg-emerald-50 p-3"><p className="text-[10px] font-black uppercase text-emerald-500">TP1 / TP2</p><p className="font-mono font-black text-emerald-700">{price(signal.takeProfit1, signal.symbol)} / {price(signal.takeProfit2, signal.symbol)}</p></div>
        <div className="rounded-2xl bg-amber-50 p-3"><p className="text-[10px] font-black uppercase text-amber-500">R:R</p><p className="font-mono font-black text-amber-700">{signal.riskRewardRatio ?? 'n/a'}</p></div>
      </div>

      <div className="mt-4 rounded-2xl border border-amber-100 bg-amber-50/70 p-3 text-sm font-semibold text-slate-700">
        {signal.note}
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {signal.setupChecklist.map((item) => <div key={item} className="flex items-start gap-2 text-xs font-semibold text-slate-500"><CheckCircle2 size={14} className="mt-0.5 text-emerald-500" />{item}</div>)}
      </div>
    </div>
  );
}

function FixedCard({ signal }: { signal: TradeNewsFixedSignal }) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-xl font-black text-slate-900">{signal.symbol}</h3>
            <span className={`rounded-full border px-2.5 py-1 text-xs font-black ${directionClass(signal.direction)}`}>{signal.direction}</span>
            <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-black text-indigo-700">{signal.expiry}</span>
            {signal.qualityTier && <span className={`rounded-full border px-2.5 py-1 text-xs font-black ${qualityClass(signal.qualityTier)}`}>{signal.qualityTier.replace(/_/g, ' ')}{signal.qualityScore !== undefined ? ` · ${signal.qualityScore}` : ''}</span>}
          </div>
          <p className="mt-1 text-sm font-bold text-slate-600">{signal.event.currency} · {signal.event.title}</p>
          <p className="text-xs font-semibold text-slate-400">Entry {new Date(signal.entryTime).toLocaleTimeString()} · expires {new Date(signal.expiryTime).toLocaleTimeString()}</p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-black text-indigo-700">{Math.round(signal.confidence)}%</p>
          <p className="text-xs font-bold text-slate-400">{signal.grade}</p>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 text-xs font-bold text-slate-600 sm:grid-cols-4">
        <div className="rounded-2xl bg-slate-50 p-3"><span className="text-slate-400">Bias</span><br />{signal.candleBiasTf}</div>
        <div className="rounded-2xl bg-slate-50 p-3"><span className="text-slate-400">Trend</span><br />{signal.candleTrendTf}</div>
        <div className="rounded-2xl bg-slate-50 p-3"><span className="text-slate-400">Entry</span><br />{signal.candleEntryTf}</div>
        <div className="rounded-2xl bg-slate-50 p-3"><span className="text-slate-400">Confirm</span><br />{signal.candleConfirmTf}</div>
      </div>
      <p className="mt-4 rounded-2xl border border-indigo-100 bg-indigo-50/70 p-3 text-sm font-semibold text-slate-700">{signal.reasoning}</p>
      {(signal.qualityReasons?.length || signal.riskWarnings?.length || signal.volatilityState) && (
        <div className="mt-3 rounded-2xl border border-slate-200 bg-slate-50 p-3 text-xs font-semibold text-slate-600">
          {signal.volatilityState && <p><b>Volatility:</b> {signal.volatilityState}</p>}
          {signal.qualityReasons?.length ? <p className="text-emerald-700"><b>Quality:</b> {signal.qualityReasons.join('; ')}</p> : null}
          {signal.riskWarnings?.length ? <p className="text-amber-700"><b>Warnings:</b> {signal.riskWarnings.join('; ')}</p> : null}
        </div>
      )}
    </div>
  );
}

export default function TradeTheNews() {
  const [tab, setTab] = useState<Tab>('forex');
  const [forex, setForex] = useState<TradeNewsForexSignal[]>([]);
  const [fixed, setFixed] = useState<TradeNewsFixedSignal[]>([]);
  const [activeOnly, setActiveOnly] = useState(false);
  const [minConfidence, setMinConfidence] = useState(60);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [forexRes, fixedRes] = await Promise.all([
        fetchTradeNewsForex({ activeOnly, minConfidence }),
        fetchTradeNewsFixed({ activeOnly, minConfidence }),
      ]);
      setForex(forexRes.signals || []);
      setFixed(fixedRes.signals || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load trade-news signals');
    } finally {
      setLoading(false);
    }
  }, [activeOnly, minConfidence]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30000);
    return () => window.clearInterval(timer);
  }, [load]);

  const currentCount = tab === 'forex' ? forex.length : fixed.length;
  const activeCount = useMemo(() => (tab === 'forex' ? forex : fixed).filter((s) => s.status === 'ACTIVE').length, [tab, forex, fixed]);

  return (
    <div className="terminal-page -m-6 min-h-screen space-y-6 p-6 lg:-m-10 lg:p-10">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.32em] text-red-600">News Trading Desk</p>
          <h1 className="mt-2 text-4xl font-black tracking-tight text-slate-900">Trade The News</h1>
          <p className="mt-2 max-w-3xl text-sm font-semibold text-slate-500">
            Post-release Forex and fixed-time signals. The engine waits for the actual value, market reaction, blackout window and chart confirmation before producing trade ideas.
          </p>
        </div>
        <button onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-5 py-3 text-sm font-black text-white shadow-md shadow-red-600/20 hover:bg-red-700 disabled:opacity-60">
          {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCcw size={16} />}
          Refresh
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-card"><Newspaper className="text-red-500" size={20} /><p className="mt-2 text-3xl font-black">{currentCount}</p><p className="text-xs font-bold text-slate-400">signals in current tab</p></div>
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-card"><Clock className="text-emerald-500" size={20} /><p className="mt-2 text-3xl font-black">{activeCount}</p><p className="text-xs font-bold text-slate-400">active post-blackout setups</p></div>
        <div className="rounded-3xl border border-amber-200 bg-amber-50 p-5"><ShieldAlert className="text-amber-600" size={20} /><p className="mt-2 text-sm font-black text-amber-800">No blind prediction</p><p className="text-xs font-semibold text-amber-700">Avoid release candles. Trade only after reaction and confirmation.</p></div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-3xl border border-slate-200 bg-white p-3 shadow-card">
        <div className="flex gap-2 rounded-2xl bg-slate-100 p-1">
          <button onClick={() => setTab('forex')} className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-black ${tab === 'forex' ? 'bg-white text-red-700 shadow-sm' : 'text-slate-500'}`}><TrendingUp size={16} /> Forex</button>
          <button onClick={() => setTab('fixed')} className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-black ${tab === 'fixed' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500'}`}><Timer size={16} /> Fixed-Time</button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600"><input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} /> Active only</label>
          <select value={minConfidence} onChange={(e) => setMinConfidence(Number(e.target.value))} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600">
            <option value={50}>50%+ confidence</option>
            <option value={60}>60%+ confidence</option>
            <option value={70}>70%+ confidence</option>
            <option value={75}>75%+ email-grade</option>
          </select>
        </div>
      </div>

      {error && <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-700">{error}</div>}

      <section className="grid gap-4 xl:grid-cols-2">
        {tab === 'forex' ? forex.map((signal) => <ForexCard key={signal.id} signal={signal} />) : fixed.map((signal) => <FixedCard key={signal.id} signal={signal} />)}
      </section>

      {!loading && currentCount === 0 && (
        <div className="rounded-3xl border border-dashed border-slate-200 bg-white p-12 text-center">
          <AlertTriangle className="mx-auto text-slate-300" size={42} />
          <p className="mt-4 text-sm font-black text-slate-600">No trade-news signals right now.</p>
          <p className="mt-1 text-xs font-semibold text-slate-400">Signals appear only after a relevant actual release and the post-news blackout window.</p>
        </div>
      )}
    </div>
  );
}
