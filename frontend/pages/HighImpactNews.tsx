import React, { useEffect, useMemo, useState } from 'react';
import { Newspaper, RefreshCcw, Loader2, AlertTriangle, TrendingUp, TrendingDown, Minus, Briefcase, Clock } from 'lucide-react';
import { fetchNewsSignals } from '../mt5Api';
import type { NewsSignal } from '../types';

function countdown(mins: number) {
  if (mins < 0) return 'now';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h < 24 ? `${h}h ${m}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

const IMPACT_CHIP: Record<string, string> = {
  HIGH: 'bg-red-50 text-red-700 border-red-200',
  MODERATE: 'bg-amber-50 text-amber-700 border-amber-200',
  LOW: 'bg-slate-50 text-slate-600 border-slate-200',
};

function DirBadge({ dir }: { dir: 'UP' | 'DOWN' | 'NEUTRAL' }) {
  if (dir === 'UP') return <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-black text-emerald-700"><TrendingUp size={12} /> UP</span>;
  if (dir === 'DOWN') return <span className="inline-flex items-center gap-1 rounded-md bg-red-50 px-2 py-0.5 text-xs font-black text-red-700"><TrendingDown size={12} /> DOWN</span>;
  return <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 text-xs font-black text-slate-500"><Minus size={12} /> FLAT</span>;
}

function fmt(v: number | null, symbol: string) {
  if (v === null || v === undefined) return 'n/a';
  const digits = /XAU|GOLD|XAG/.test(symbol.toUpperCase()) ? 2 : /JPY/.test(symbol.toUpperCase()) ? 3 : 5;
  return v.toFixed(digits);
}

export default function HighImpactNews() {
  const [signals, setSignals] = useState<NewsSignal[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [impact, setImpact] = useState<'HIGH' | 'MODERATE' | 'LOW'>('HIGH');
  const [, setNow] = useState(Date.now());

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchNewsSignals({ minImpact: impact, hours: 24 });
      setSignals(res.signals || []);
      setGeneratedAt(res.generatedAt);
      setSource(res.calendarSource);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load news signals');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const refresh = window.setInterval(() => void load(), 60000);
    const ticker = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { window.clearInterval(refresh); window.clearInterval(ticker); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [impact]);

  const positionSignals = useMemo(() => signals.filter((s) => s.hasPosition), [signals]);
  const otherSignals = useMemo(() => signals.filter((s) => !s.hasPosition), [signals]);
  const nextEvent = useMemo(() => [...signals].sort((a, b) => a.event.minutesUntil - b.event.minutesUntil).find((s) => s.event.minutesUntil >= 0) || null, [signals]);

  const renderCard = (s: NewsSignal) => {
    const imminent = s.event.impact === 'HIGH' && Math.abs(s.event.minutesUntil) <= 30;
    return (
      <div key={s.id} className={`light-card rounded-3xl p-5 ${imminent ? 'ring-2 ring-red-200' : ''}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-black text-slate-900">{s.symbol}</h3>
              {s.hasPosition && (
                <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-black ${s.positionSide === 'BUY' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
                  <Briefcase size={10} /> OPEN {s.positionSide}
                </span>
              )}
              <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-black uppercase ${IMPACT_CHIP[s.event.impact] || IMPACT_CHIP.LOW}`}>{s.event.impact}</span>
            </div>
            <p className="mt-1 truncate text-sm font-bold text-slate-700">{s.event.currency} · {s.event.title}</p>
            <p className="text-xs font-semibold text-slate-400">
              Forecast {s.event.forecast ?? 'n/a'} · Previous {s.event.previous ?? 'n/a'} · Trend {s.htfBias} · Price {fmt(s.price, s.symbol)}
            </p>
          </div>
          <div className="text-right">
            <p className={`text-2xl font-black ${imminent ? 'text-red-600' : 'text-slate-900'}`}>{countdown(s.event.minutesUntil)}</p>
            <p className="text-[10px] font-bold uppercase text-slate-400">{new Date(s.event.timeIso).toLocaleTimeString()}</p>
          </div>
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {s.scenarios.map((sc, i) => (
            <div key={i} className="rounded-2xl border border-slate-100 bg-slate-50 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-black uppercase tracking-wider text-slate-500">{sc.currencyEffect}</span>
                <DirBadge dir={sc.pairDirection} />
              </div>
              <p className="mt-1 text-[11px] font-bold text-slate-600">{sc.trigger}</p>
              {sc.watchLevel !== null && <p className="text-[11px] font-semibold text-slate-400">Watch level: {fmt(sc.watchLevel, s.symbol)}</p>}
              <p className="mt-1 text-[11px] text-slate-500">{sc.note}</p>
            </div>
          ))}
        </div>

        <div className="mt-3 rounded-2xl border border-amber-100 bg-amber-50/50 p-3 text-xs font-semibold text-slate-700">
          <span className="font-black text-amber-700">Desk note: </span>{s.recommendation}
        </div>
        <div className="mt-2 flex gap-4 text-[11px] font-bold text-slate-400">
          <span>Resistance {fmt(s.keyLevels.recentHigh, s.symbol)}</span>
          <span>Support {fmt(s.keyLevels.recentLow, s.symbol)}</span>
          {s.grade && <span>· {s.grade}</span>}
        </div>
      </div>
    );
  };

  return (
    <div className="terminal-page -m-6 min-h-screen space-y-6 p-6 lg:-m-10 lg:p-10">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.32em] text-amber-600">News Desk</p>
          <h1 className="mt-2 text-4xl font-black tracking-tight text-slate-900">High-Impact News Signals</h1>
          <p className="mt-2 text-sm font-semibold text-slate-500">
            Pre-release reaction plans for affected instruments — open positions prioritised. Email alerts go to your inbox at 1d / 12h / 6h / 2h / 1h / 30m / 15m / 5m.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(['HIGH', 'MODERATE', 'LOW'] as const).map((imp) => (
            <button key={imp} onClick={() => setImpact(imp)} className={`rounded-full border px-3 py-1.5 text-xs font-black transition ${impact === imp ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'}`}>
              {imp === 'MODERATE' ? 'MEDIUM+' : imp === 'LOW' ? 'ALL' : 'HIGH'}
            </button>
          ))}
          <button onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-2 rounded-xl bg-amber-500 hover:bg-amber-600 px-5 py-2.5 text-sm font-bold text-white transition disabled:opacity-50 shadow-md shadow-amber-500/20">
            {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCcw size={16} />}
            Refresh
          </button>
        </div>
      </div>

      {error && <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700">{error}</div>}

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="light-card rounded-3xl p-5">
          <div className="flex items-center gap-2 text-slate-400"><Newspaper size={16} /><span className="text-xs font-black uppercase tracking-[0.2em]">Signals</span></div>
          <p className="mt-2 text-3xl font-black text-slate-900">{signals.length}</p>
          <p className="mt-1 text-xs font-semibold text-slate-500">source: {source || 'none'}</p>
        </div>
        <div className="light-card rounded-3xl p-5">
          <div className="flex items-center gap-2 text-slate-400"><Briefcase size={16} /><span className="text-xs font-black uppercase tracking-[0.2em]">Positions At Risk</span></div>
          <p className="mt-2 text-3xl font-black text-slate-900">{positionSignals.length}</p>
          <p className="mt-1 text-xs font-semibold text-slate-500">open trades exposed to news</p>
        </div>
        <div className="light-card rounded-3xl p-5">
          <div className="flex items-center gap-2 text-slate-400"><Clock size={16} /><span className="text-xs font-black uppercase tracking-[0.2em]">Next Event</span></div>
          {nextEvent ? (
            <>
              <p className="mt-2 text-lg font-black text-slate-900 truncate">{nextEvent.event.currency} · {nextEvent.event.title}</p>
              <p className="mt-1 text-xs font-bold text-amber-600">in {countdown(nextEvent.event.minutesUntil)}</p>
            </>
          ) : <p className="mt-2 text-lg font-black text-emerald-600">None scheduled</p>}
        </div>
      </div>

      {positionSignals.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center gap-2 text-slate-900"><AlertTriangle className="text-red-500" size={18} /><h2 className="text-lg font-black">Your Open Positions vs Upcoming News</h2></div>
          <div className="grid gap-4 xl:grid-cols-2">{positionSignals.map(renderCard)}</div>
        </section>
      )}

      <section className="space-y-3">
        <div className="flex items-center gap-2 text-slate-900"><Newspaper className="text-amber-500" size={18} /><h2 className="text-lg font-black">Affected Instruments</h2></div>
        {otherSignals.length ? (
          <div className="grid gap-4 xl:grid-cols-2">{otherSignals.map(renderCard)}</div>
        ) : (
          <div className="rounded-3xl border border-dashed border-slate-200 bg-white p-12 text-center">
            <Newspaper className="mx-auto text-slate-300" size={40} />
            <p className="mt-4 text-sm font-bold text-slate-500">No upcoming {impact === 'HIGH' ? 'high-impact' : impact === 'MODERATE' ? 'medium+' : ''} events for tracked symbols.</p>
            <p className="mt-1 text-xs font-semibold text-slate-400">Signals appear once the calendar has upcoming events and candles are available. {generatedAt ? `Last scan ${new Date(generatedAt).toLocaleTimeString()}.` : ''}</p>
          </div>
        )}
      </section>
    </div>
  );
}
