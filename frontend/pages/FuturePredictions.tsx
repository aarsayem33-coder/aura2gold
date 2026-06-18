import React, { useEffect, useMemo, useState } from 'react';
import { Brain, TrendingUp, TrendingDown, Minus, Trophy, Clock, Activity, History, Newspaper, Lock, LogIn, Hourglass, BarChart3 } from 'lucide-react';
import { useMt5Stream, fetchLatestForexSignals } from '../mt5Api';
import type { FttPrediction, PostNewsSignal, ScanResult } from '../types';

function digitsFor(symbol: string) {
  const s = symbol.toUpperCase();
  return /XAU|GOLD|XAG/.test(s) ? 2 : /JPY/.test(s) ? 3 : 5;
}
function px(v: number | null, symbol: string) {
  if (v === null || v === undefined) return 'n/a';
  return Number(v).toFixed(digitsFor(symbol));
}
/** "4:50 PM" */
function clock(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function mmss(ms: number) {
  if (ms <= 0) return '0:00';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function relMins(ms: number) {
  const m = Math.round(ms / 60000);
  if (m <= 0) return 'now';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatExpiryLabel(expiry: string) {
  const exp = String(expiry || '').trim().toLowerCase();
  if (exp === '1m') return '1 Min';
  if (exp === '2m') return '2 Min';
  if (exp === '3m') return '3 Min';
  if (exp === '4m') return '4 Min';
  if (exp === '5m') return '5 Min';
  if (exp === '10m') return '10 Min';
  if (exp === '15m') return '15 Min';
  if (exp === '20m') return '20 Min';
  if (exp === '30m') return '30 Min';
  if (exp === '40m') return '40 Min';
  if (exp === '1h') return '1 Hour';
  
  const val = parseInt(exp, 10);
  if (!isNaN(val)) {
    if (exp.endsWith('h')) return `${val} Hr`;
    return `${val} Min`;
  }
  return expiry;
}

function DirPill({ dir, size = 'md' }: { dir: string; size?: 'md' | 'lg' }) {
  const pad = size === 'lg' ? 'px-3 py-1.5 text-sm' : 'px-2.5 py-1 text-xs';
  if (dir === 'UP') return <span className={`inline-flex items-center gap-1 rounded-lg bg-emerald-500 ${pad} font-black text-white`}><TrendingUp size={size === 'lg' ? 16 : 13} /> UP</span>;
  if (dir === 'DOWN') return <span className={`inline-flex items-center gap-1 rounded-lg bg-rose-500 ${pad} font-black text-white`}><TrendingDown size={size === 'lg' ? 16 : 13} /> DOWN</span>;
  return <span className={`inline-flex items-center gap-1 rounded-lg bg-slate-300 ${pad} font-black text-slate-700`}><Minus size={13} /> HOLD</span>;
}

function accent(dir: string) {
  return dir === 'UP' ? 'border-l-emerald-400' : dir === 'DOWN' ? 'border-l-rose-400' : 'border-l-slate-300';
}

function conviction(conf: number) {
  if (conf >= 70) return { label: 'Strong', cls: 'bg-emerald-100 text-emerald-700' };
  if (conf >= 55) return { label: 'Moderate', cls: 'bg-blue-100 text-blue-700' };
  return { label: 'Weak', cls: 'bg-slate-100 text-slate-500' };
}

function fttConfidenceGrade(confidence?: number | null) {
  const c = Number(confidence);
  if (!Number.isFinite(c)) return 'WATCH ONLY';
  if (c >= 90) return 'A+ Setup';
  if (c >= 80) return 'A Setup';
  if (c >= 75) return 'B Setup';
  return 'WATCH ONLY';
}

function qualityClass(tier?: string) {
  if (tier === 'QUALITY_SIGNAL') return 'bg-emerald-600 text-white';
  if (tier === 'TRADE_SIGNAL') return 'bg-blue-100 text-blue-700';
  return 'bg-amber-100 text-amber-700';
}

export default function FuturePredictions() {
  const { fttPredictions, postNewsSignals } = useMt5Stream();
  const [now, setNow] = useState(Date.now());
  const [forexSignals, setForexSignals] = useState<ScanResult[]>([]);
  const fttTradeThreshold = 75;
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const load = () => fetchLatestForexSignals().then((r) => setForexSignals(r.signals || [])).catch(() => {});
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  // Fixed-time: only the LATEST live prediction per (symbol, expiry); drop any whose
  // window has finished (expiry crossed) so stale/expired entries never linger.
  const active = useMemo(() => {
    const latest = new Map<string, FttPrediction>();
    for (const p of fttPredictions) {
      if (p.outcome !== 'PENDING' || p.direction === 'HOLD') continue;
      if (p.confidence < fttTradeThreshold) continue;
      if (new Date(p.expiryTime).getTime() <= now) continue; // entry window finished
      const key = `${p.symbol}|${p.expiry}`;
      const cur = latest.get(key);
      if (!cur || new Date(p.created_at).getTime() > new Date(cur.created_at).getTime()) latest.set(key, p);
    }
    return [...latest.values()].sort((a, b) => new Date(a.expiryTime).getTime() - new Date(b.expiryTime).getTime());
  }, [fttPredictions, now]);

  const resolved = useMemo(() => (
    fttPredictions
      .filter((p) => ['WIN', 'LOSS', 'DRAW'].includes(p.outcome))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  ), [fttPredictions]);

  const score = useMemo(() => {
    const wins = resolved.filter((p) => p.outcome === 'WIN').length;
    const losses = resolved.filter((p) => p.outcome === 'LOSS').length;
    const draws = resolved.filter((p) => p.outcome === 'DRAW').length;
    const decided = wins + losses;
    return { wins, losses, draws, total: wins + losses + draws, winRate: decided ? Math.round((wins / decided) * 100) : 0 };
  }, [resolved]);

  // ── FTT prediction card ──
  const renderFtt = (p: FttPrediction) => {
    const expiryMs = new Date(p.expiryTime).getTime();
    const entryMs = new Date(p.entryTime).getTime();
    const remaining = expiryMs - now;
    const pct = Math.max(0, Math.min(100, (remaining / Math.max(1, expiryMs - entryMs)) * 100));
    const grade = fttConfidenceGrade(p.confidence);
    const underlyingGrade = (p.indicators as any)?.grade;
    const qualityTier = (p.indicators as any)?.qualityTier || p.tradeStatus;
    const qualityScore = (p.indicators as any)?.qualityScore;
    return (
      <div key={p.id} className={`rounded-2xl border border-slate-200 border-l-4 ${accent(p.direction)} bg-white p-5 shadow-sm transition hover:shadow-md`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-black text-slate-900">{p.symbol}</h3>
              <span className="rounded-md bg-indigo-50 px-2 py-0.5 text-[10px] font-black uppercase text-indigo-700">Fixed-Time</span>
              <span className="rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-black text-slate-600">{formatExpiryLabel(p.expiry)}</span>
              <span className={`rounded-md px-2 py-0.5 text-[10px] font-black uppercase ${p.source === 'ai' ? 'bg-violet-50 text-violet-700' : 'bg-amber-50 text-amber-700'}`}>{p.source}</span>
              {qualityTier && <span className={`rounded-md px-2 py-0.5 text-[10px] font-black uppercase ${qualityClass(qualityTier)}`}>{String(qualityTier).replace(/_/g, ' ')}{qualityScore !== undefined ? ` ${qualityScore}` : ''}</span>}
            </div>
            <p className="mt-1 text-[11px] font-bold text-slate-500">{grade}</p>
            {underlyingGrade && underlyingGrade !== grade && (
              <p className="mt-0.5 text-[10px] font-semibold text-slate-400">Underlying: {underlyingGrade}</p>
            )}
          </div>
          <DirPill dir={p.direction} size="lg" />
        </div>

        {/* Explicit entry time banner */}
        <div className="mt-4 flex items-center justify-between rounded-xl bg-slate-900 px-4 py-3 text-white">
          <div className="flex items-center gap-2">
            <LogIn size={16} className="text-amber-400" />
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Enter at</p>
              <p className="text-lg font-black leading-tight">{clock(p.entryTime)}</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Expires</p>
            <p className="text-lg font-black leading-tight">{clock(p.expiryTime)} <span className="font-mono text-amber-400">({mmss(remaining)})</span></p>
          </div>
        </div>

        <div className="mt-3 flex items-end justify-between">
          <div>
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Entry price</p>
            <p className="font-mono text-base font-black text-slate-900">{px(p.entryPrice, p.symbol)}</p>
          </div>
          <div className="text-right">
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Confidence</p>
            <p className={`text-2xl font-black ${p.confidence >= 80 ? 'text-emerald-600' : p.confidence >= 70 ? 'text-blue-600' : 'text-slate-700'}`}>{Math.round(p.confidence)}%</p>
            <span className={`mt-0.5 inline-block rounded px-1.5 py-0.5 text-[9px] font-black uppercase ${conviction(p.confidence).cls}`}>{conviction(p.confidence).label}</span>
          </div>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
          <div className={`h-full rounded-full ${p.direction === 'UP' ? 'bg-emerald-500' : 'bg-rose-500'}`} style={{ width: `${pct}%` }} />
        </div>
        {p.reasoning && <p className="mt-2 line-clamp-2 text-[11px] font-semibold text-slate-500">{p.reasoning}</p>}
      </div>
    );
  };

  // ── Post-news signal card ──
  const renderPostNews = (s: PostNewsSignal) => {
    const active = s.status === 'ACTIVE';
    const tradeableMs = new Date(s.tradeableAtIso).getTime();
    return (
      <div key={s.id} className={`rounded-2xl border border-slate-200 border-l-4 ${accent(s.direction)} bg-white p-5 shadow-sm`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-black text-slate-900">{s.symbol}</h3>
              <span className="rounded-md bg-sky-50 px-2 py-0.5 text-[10px] font-black uppercase text-sky-700">Forex</span>
              <span className={`rounded-md px-2 py-0.5 text-[10px] font-black uppercase ${active ? 'bg-emerald-500 text-white' : 'bg-amber-100 text-amber-700'}`}>{active ? 'TRADE NOW' : 'LOCKED'}</span>
            </div>
            <p className="mt-1 truncate text-xs font-bold text-slate-500">{s.event.currency} · {s.event.title}</p>
            <p className="text-[11px] font-semibold text-slate-400">Actual {s.event.actual ?? 'n/a'} vs {s.event.forecast ?? 'n/a'} · surprise {s.surprise.bias} · reacted {s.realizedDir}</p>
          </div>
          <DirPill dir={s.direction} size="lg" />
        </div>

        {/* Explicit entry time */}
        <div className={`mt-4 flex items-center justify-between rounded-xl px-4 py-3 ${active ? 'bg-emerald-600 text-white' : 'bg-slate-900 text-white'}`}>
          <div className="flex items-center gap-2">
            {active ? <LogIn size={16} className="text-emerald-200" /> : <Lock size={16} className="text-amber-400" />}
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider opacity-70">{active ? 'Enter now' : 'Enter at'}</p>
              <p className="text-lg font-black leading-tight">{clock(s.tradeableAtIso)}</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-[10px] font-bold uppercase tracking-wider opacity-70">{active ? 'Window ends' : 'Unlocks in'}</p>
            <p className="text-lg font-black leading-tight">{active ? clock(s.expiresAtIso) : relMins(tradeableMs - now)}</p>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-xl bg-slate-50 p-2"><p className="text-[10px] font-bold uppercase text-slate-400">Entry</p><p className="font-mono text-sm font-black text-slate-900">{px(s.price, s.symbol)}</p></div>
          <div className="rounded-xl bg-slate-50 p-2"><p className="text-[10px] font-bold uppercase text-slate-400">Stop</p><p className="font-mono text-sm font-black text-rose-600">{px(s.stopLoss, s.symbol)}</p></div>
          <div className="rounded-xl bg-slate-50 p-2"><p className="text-[10px] font-bold uppercase text-slate-400">TP1</p><p className="font-mono text-sm font-black text-emerald-600">{px(s.takeProfit1, s.symbol)}</p></div>
        </div>
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[11px] font-bold text-slate-400">Confidence</span>
          <span className={`text-sm font-black ${s.confidence >= 70 ? 'text-emerald-600' : 'text-slate-700'}`}>{Math.round(s.confidence)}%</span>
        </div>
        <p className="mt-1 text-[11px] font-semibold text-slate-500">{s.note}</p>
      </div>
    );
  };

  // ── Forex (non-news) system signal card ──
  const renderForex = (r: ScanResult) => {
    const sd = r.systemDecision!;
    const isBuy = String(sd.decision).includes('BUY');
    const wait = sd.entryTimingInstruction === 'WAIT_FOR_NEXT_CANDLE';
    const enterAtMs = wait && sd.remainingSeconds ? now + sd.remainingSeconds * 1000 : now;
    const enterLabel = sd.entryTrigger === 'LIMIT_PULLBACK'
      ? 'On pullback to entry'
      : wait ? `~${clock(new Date(enterAtMs).toISOString())} (next candle)` : `Now · ${clock(new Date(now).toISOString())}`;
    const conv = conviction(sd.confidence || 0);
    return (
      <div key={`${r.symbol}|${r.timeframe}`} className={`rounded-2xl border border-slate-200 border-l-4 ${isBuy ? 'border-l-emerald-400' : 'border-l-rose-400'} bg-white p-5 shadow-sm transition hover:shadow-md`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-black text-slate-900">{r.symbol}</h3>
              <span className="rounded-md bg-sky-50 px-2 py-0.5 text-[10px] font-black uppercase text-sky-700">Forex</span>
              <span className="rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-black text-slate-600">{r.timeframe}</span>
            </div>
            {sd.grade && <p className="mt-1 text-[11px] font-bold text-slate-400">{sd.grade}</p>}
          </div>
          <span className={`inline-flex items-center gap-1 rounded-lg ${isBuy ? 'bg-emerald-500' : 'bg-rose-500'} px-3 py-1.5 text-sm font-black text-white`}>
            {isBuy ? <TrendingUp size={16} /> : <TrendingDown size={16} />} {String(sd.decision).replace('_', ' ')}
          </span>
        </div>

        <div className="mt-4 flex items-center justify-between rounded-xl bg-slate-900 px-4 py-3 text-white">
          <div className="flex items-center gap-2">
            <LogIn size={16} className="text-amber-400" />
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Enter</p>
              <p className="text-base font-black leading-tight">{enterLabel}</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">R:R</p>
            <p className="text-base font-black leading-tight">{sd.riskRewardRatio ?? 'n/a'}</p>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-xl bg-slate-50 p-2"><p className="text-[10px] font-bold uppercase text-slate-400">Entry</p><p className="font-mono text-sm font-black text-slate-900">{px(sd.entryPrice, r.symbol)}</p></div>
          <div className="rounded-xl bg-slate-50 p-2"><p className="text-[10px] font-bold uppercase text-slate-400">Stop</p><p className="font-mono text-sm font-black text-rose-600">{px(sd.stopLoss, r.symbol)}</p></div>
          <div className="rounded-xl bg-slate-50 p-2"><p className="text-[10px] font-bold uppercase text-slate-400">TP1</p><p className="font-mono text-sm font-black text-emerald-600">{px(sd.takeProfit1, r.symbol)}</p></div>
        </div>
        <div className="mt-2 flex items-center justify-between">
          <span className={`rounded px-1.5 py-0.5 text-[9px] font-black uppercase ${conv.cls}`}>{conv.label}</span>
          <span className={`text-sm font-black ${(sd.confidence || 0) >= 80 ? 'text-emerald-600' : 'text-slate-700'}`}>{Math.round(sd.confidence || 0)}/100</span>
        </div>
        {sd.timingTip && <p className="mt-1 text-[11px] font-semibold text-slate-500">{sd.timingTip}</p>}
      </div>
    );
  };

  return (
    <div className="terminal-page -m-6 min-h-screen space-y-8 bg-slate-50 p-6 lg:-m-10 lg:p-10">
      {/* Hero header */}
      <div className="overflow-hidden rounded-3xl bg-gradient-to-br from-slate-900 via-slate-900 to-slate-800 p-8 text-white shadow-xl">
        <p className="text-xs font-black uppercase tracking-[0.32em] text-amber-400">Auto Feed · No Button Needed</p>
        <h1 className="mt-2 text-4xl font-black tracking-tight">Future Predictions</h1>
        <p className="mt-2 max-w-2xl text-sm font-medium text-slate-300">
          Live forward-looking direction calls (2m–1h) plus post-news entry signals — each one tells you the exact clock time to enter. Updates stream in automatically; ≥75% confidence calls are emailed.
        </p>
        <div className="mt-6 grid gap-3 sm:grid-cols-4">
          <div className="rounded-2xl bg-white/5 p-4 backdrop-blur">
            <div className="flex items-center gap-2 text-amber-400"><Trophy size={15} /><span className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-300">Win Rate</span></div>
            <p className="mt-1 text-3xl font-black">{score.winRate}%</p>
            <p className="text-[11px] font-semibold text-slate-400">{score.wins}W · {score.losses}L · {score.draws}D</p>
          </div>
          <div className="rounded-2xl bg-white/5 p-4 backdrop-blur">
            <div className="flex items-center gap-2 text-emerald-400"><Activity size={15} /><span className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-300">Active</span></div>
            <p className="mt-1 text-3xl font-black">{active.length}</p>
            <p className="text-[11px] font-semibold text-slate-400">live predictions</p>
          </div>
          <div className="rounded-2xl bg-white/5 p-4 backdrop-blur">
            <div className="flex items-center gap-2 text-rose-400"><Newspaper size={15} /><span className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-300">Post-News</span></div>
            <p className="mt-1 text-3xl font-black">{postNewsSignals.length}</p>
            <p className="text-[11px] font-semibold text-slate-400">{postNewsSignals.filter((s) => s.status === 'ACTIVE').length} tradeable now</p>
          </div>
          <div className="rounded-2xl bg-white/5 p-4 backdrop-blur">
            <div className="flex items-center gap-2 text-blue-400"><History size={15} /><span className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-300">Resolved</span></div>
            <p className="mt-1 text-3xl font-black">{score.total}</p>
            <p className="text-[11px] font-semibold text-slate-400">settled outcomes</p>
          </div>
        </div>
      </div>

      {/* Post-news entry signals */}
      {postNewsSignals.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center gap-2 text-slate-900"><Newspaper className="text-rose-500" size={18} /><h2 className="text-xl font-black">Post-News Entry Signals</h2><span className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-bold text-sky-600">Forex · after +30m blackout</span></div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{postNewsSignals.map(renderPostNews)}</div>
        </section>
      )}

      {/* Forex trade signals (no news dependency) */}
      <section className="space-y-3">
        <div className="flex items-center gap-2 text-slate-900"><BarChart3 className="text-sky-500" size={18} /><h2 className="text-xl font-black">Forex Trade Signals</h2><span className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-bold text-sky-600">B+ system setups · M5 / M15</span></div>
        {forexSignals.length ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{forexSignals.map(renderForex)}</div>
        ) : (
          <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-10 text-center">
            <BarChart3 className="mx-auto text-slate-300" size={36} />
            <p className="mt-3 text-sm font-bold text-slate-500">No qualifying forex setups right now.</p>
            <p className="mt-1 text-xs font-semibold text-slate-400">Only B-grade-and-above BUY/SELL setups appear here. The scanner re-checks every minute.</p>
          </div>
        )}
      </section>

      {/* Active predictions */}
      <section className="space-y-3">
        <div className="flex items-center gap-2 text-slate-900"><Clock className="text-amber-500" size={18} /><h2 className="text-xl font-black">Active Predictions</h2><span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-bold text-indigo-600">Fixed-Time · binary direction</span></div>
        {active.length ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{active.map(renderFtt)}</div>
        ) : (
          <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-12 text-center">
            <Hourglass className="mx-auto text-slate-300" size={40} />
            <p className="mt-4 text-sm font-bold text-slate-500">No active predictions right now.</p>
            <p className="mt-1 text-xs font-semibold text-slate-400">The scanner generates these automatically when a setup forms (once per candle bar). Keep MT5 connected.</p>
          </div>
        )}
      </section>

      {/* Resolved log */}
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center gap-2 text-slate-900"><History className="text-amber-500" size={18} /><h2 className="text-xl font-black">Resolved Predictions</h2></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="border-b border-slate-100 text-xs uppercase tracking-[0.18em] text-slate-500">
              <tr><th className="p-3">Symbol</th><th className="p-3">Expiry</th><th className="p-3">Trade Time</th><th className="p-3">Dir</th><th className="p-3">Conf</th><th className="p-3">Source</th><th className="p-3">Entered</th><th className="p-3">Entry→Exit</th><th className="p-3">Outcome</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {resolved.slice(0, 50).map((p) => (
                <tr key={p.id} className="hover:bg-slate-50/60">
                  <td className="p-3 font-black text-slate-900">{p.symbol}</td>
                  <td className="p-3 font-mono text-xs">{p.expiry}</td>
                  <td className="p-3 font-semibold text-slate-700">{formatExpiryLabel(p.expiry)}</td>
                  <td className="p-3"><DirPill dir={p.direction} /></td>
                  <td className="p-3 font-mono">{Math.round(p.confidence)}%</td>
                  <td className="p-3 text-xs uppercase">{p.source}</td>
                  <td className="p-3 text-xs text-slate-500">{clock(p.entryTime)}</td>
                  <td className="p-3 font-mono text-xs">{px(p.entryPrice, p.symbol)} → {px(p.exitPrice, p.symbol)}</td>
                  <td className="p-3"><span className={`rounded-md px-2 py-0.5 text-xs font-black ${p.outcome === 'WIN' ? 'bg-emerald-50 text-emerald-700' : p.outcome === 'LOSS' ? 'bg-rose-50 text-rose-700' : 'bg-slate-100 text-slate-600'}`}>{p.outcome}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!resolved.length && <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center text-sm font-semibold text-slate-500">No resolved predictions yet.</p>}
      </section>
    </div>
  );
}
