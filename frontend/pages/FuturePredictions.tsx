import React, { useEffect, useMemo, useState } from 'react';
import { Brain, TrendingUp, TrendingDown, Minus, Trophy, Clock, Activity, History, Newspaper, Lock, LogIn, Hourglass, BarChart3, CalendarClock, Zap, Sparkles, X, Loader2 } from 'lucide-react';
import { useMt5Stream, fetchLatestForexSignals, analyzeForecast } from '../mt5Api';
import type { FttPrediction, PostNewsSignal, ScanResult, ExecutionForecast, ForecastAnalysis } from '../types';

function digitsFor(symbol: string) {
  const s = symbol.toUpperCase();
  return /XAU|GOLD|XAG/.test(s) ? 2 : /JPY/.test(s) ? 3 : 5;
}
function px(v: number | null, symbol: string) {
  if (v === null || v === undefined) return 'n/a';
  return Number(v).toFixed(digitsFor(symbol));
}
function money(v: number | null | undefined) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return 'n/a';
  return `$${Number(v).toFixed(2)}`;
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

// ── Execution forecast helpers ──
const FORECAST_BASIS_LABEL: Record<string, string> = {
  IMMEDIATE: 'Ready now',
  NEXT_CANDLE: 'Next candle',
  NEWS: 'News event',
  PULLBACK: 'Pullback',
  SCORE_SLOPE: 'Score rising',
  SESSION: 'Session open',
  UNKNOWN: 'No clear path',
};

/** Short "⚡ USD CPI 18:30" news label for a forecast row. */
function newsPill(f: ExecutionForecast) {
  if (!f.newsImminent && !f.newsTier) return null;
  const t = f.newsEventTime ? ` ${clock(f.newsEventTime)}` : '';
  return `⚡ ${f.newsEvent || 'High-impact news'}${t}`;
}
function tierBadge(tier?: string | null) {
  if (tier === 'A') return { label: 'SPIKE', cls: 'bg-rose-500 text-white' };
  if (tier === 'B') return { label: 'CONFIRMED', cls: 'bg-emerald-500 text-white' };
  return null;
}

function forecastStatusStyle(status: string) {
  switch (status) {
    case 'READY': return { cls: 'bg-emerald-500 text-white', accent: 'border-l-emerald-400' };
    case 'DELAYED': return { cls: 'bg-amber-500 text-white', accent: 'border-l-amber-400' };
    case 'FORECASTED': return { cls: 'bg-indigo-500 text-white', accent: 'border-l-indigo-400' };
    default: return { cls: 'bg-slate-400 text-white', accent: 'border-l-slate-300' };
  }
}

/** Remaining time to ETA, signed: "in 12m" / "due now" / "3m late". */
function etaLabel(iso: string | null, nowMs: number) {
  if (!iso) return '—';
  const ms = new Date(iso).getTime() - nowMs;
  if (!Number.isFinite(ms)) return '—';
  if (ms <= -60000) return `${relMins(-ms)} late`;
  if (Math.abs(ms) < 60000) return 'due now';
  return `in ${relMins(ms)}`;
}

function ForecastStatusPill({ status }: { status: string }) {
  const { cls } = forecastStatusStyle(status);
  return <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-black uppercase ${cls}`}>{status}</span>;
}

function DecisionArrow({ decision, lean }: { decision: string | null; lean?: string | null }) {
  // A committed BUY/SELL decision shows a solid colored arrow.
  if (String(decision || '').includes('BUY')) return <TrendingUp size={13} className="text-emerald-500" />;
  if (String(decision || '').includes('SELL')) return <TrendingDown size={13} className="text-rose-500" />;
  // Still Building (decision HOLD): show the directional LEAN as a dimmed/outline
  // arrow with a "lean" tooltip so it reads as a tilt, not an actionable signal.
  if (lean === 'BUY') return <TrendingUp size={13} className="text-emerald-300" title="Leaning BUY (not yet executable)" />;
  if (lean === 'SELL') return <TrendingDown size={13} className="text-rose-300" title="Leaning SELL (not yet executable)" />;
  return <Minus size={13} className="text-slate-300" />;
}

function scoreDeltaClass(d: number | null) {
  if (d === null || d === 0) return 'text-slate-400';
  return d > 0 ? 'text-emerald-600' : 'text-rose-600';
}

/** Forecast grade from setup score (forecasts are favorable-but-waiting setups). */
function forecastGrade(score: number | null): 'A+' | 'A' | 'B' | 'Watch' {
  const s = Number(score) || 0;
  if (s >= 85) return 'A+';
  if (s >= 70) return 'A';
  if (s >= 55) return 'B';
  return 'Watch';
}
function gradeBadgeClass(g: string) {
  if (g === 'A+') return 'bg-emerald-100 text-emerald-700';
  if (g === 'A') return 'bg-blue-100 text-blue-700';
  if (g === 'B') return 'bg-amber-100 text-amber-700';
  return 'bg-slate-100 text-slate-500';
}
function recBadgeClass(rec: string) {
  if (rec === 'TRADE') return 'bg-emerald-500 text-white';
  if (rec === 'WAIT') return 'bg-amber-500 text-white';
  return 'bg-slate-500 text-white';
}

const FORECAST_TF_OPTIONS = ['All', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];
const FORECAST_STATUS_OPTIONS = ['All', 'READY', 'FORECASTED', 'DELAYED'];
const FORECAST_GRADE_OPTIONS = ['All', 'A+', 'A', 'B'];

export default function FuturePredictions() {
  const { fttPredictions, postNewsSignals, executionForecasts } = useMt5Stream();
  const [now, setNow] = useState(Date.now());
  const [forexSignals, setForexSignals] = useState<ScanResult[]>([]);
  const [forecastSort, setForecastSort] = useState<'eta' | 'score' | 'prob' | 'recent'>('eta');
  const [tfFilter, setTfFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState('All');
  const [gradeFilter, setGradeFilter] = useState('All');
  const [analysis, setAnalysis] = useState<ForecastAnalysis | null>(null);
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const fttTradeThreshold = 75;

  const runAnalyze = async (id: string) => {
    setAnalyzingId(id);
    setAnalyzeError(null);
    setAnalysis(null);
    try {
      setAnalysis(await analyzeForecast(id));
    } catch (e) {
      setAnalyzeError(e instanceof Error ? e.message : 'Analysis failed');
    } finally {
      setAnalyzingId(null);
    }
  };
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

  // Upcoming executions: active forecasts, filtered + sorted by the chosen controls.
  const upcoming = useMemo(() => {
    const list = executionForecasts.filter((f) => {
      if (!['FORECASTED', 'DELAYED', 'READY'].includes(f.status)) return false;
      if (tfFilter !== 'All' && f.timeframe !== tfFilter) return false;
      if (statusFilter !== 'All' && f.status !== statusFilter) return false;
      if (gradeFilter !== 'All' && forecastGrade(f.setupScore) !== gradeFilter) return false;
      return true;
    });
    const etaMs = (f: ExecutionForecast) => (f.expectedExecutionTime ? new Date(f.expectedExecutionTime).getTime() : Infinity);
    const scanMs = (f: ExecutionForecast) => (f.scanTime ? new Date(f.scanTime).getTime() : 0);
    return list.sort((a, b) => {
      if (forecastSort === 'score') return (Number(b.setupScore) || 0) - (Number(a.setupScore) || 0);
      if (forecastSort === 'prob') return (Number(b.executionProbability) || 0) - (Number(a.executionProbability) || 0);
      if (forecastSort === 'recent') return scanMs(b) - scanMs(a);
      return etaMs(a) - etaMs(b);
    });
  }, [executionForecasts, forecastSort, tfFilter, statusFilter, gradeFilter]);
  const hero = upcoming.find((f) => f.status === 'READY') || upcoming[0] || null;
  const lastForecastScan = useMemo(() => {
    let latest = 0;
    for (const f of executionForecasts) {
      const t = f.scanTime ? new Date(f.scanTime).getTime() : 0;
      if (t > latest) latest = t;
    }
    return latest ? new Date(latest) : null;
  }, [executionForecasts]);

  // ── Execution forecast — compact table row ──
  const renderForecastRow = (f: ExecutionForecast) => {
    const st = forecastStatusStyle(f.status);
    const grade = forecastGrade(f.setupScore);
    return (
      <tr key={f.id} className={`border-l-4 ${st.accent} hover:bg-slate-50/70`}>
        <td className="px-3 py-2">
          <div className="flex items-center gap-1.5">
            <DecisionArrow decision={f.decision} lean={f.lean} />
            <span className="font-black text-slate-900">{f.symbol}</span>
            <span className="rounded border border-slate-200 bg-slate-50 px-1 text-[10px] font-black text-slate-500">{f.timeframe}</span>
            <span className={`rounded px-1 text-[10px] font-black ${gradeBadgeClass(grade)}`}>{grade}</span>
            {(!f.decision || f.decision === 'HOLD') && (f.lean === 'BUY' || f.lean === 'SELL') && (
              <span className={`rounded px-1 text-[9px] font-black uppercase ${f.lean === 'BUY' ? 'text-emerald-500' : 'text-rose-500'}`} title="Directional lean while building — not a committed signal">
                {f.lean} lean
              </span>
            )}
            {tierBadge(f.newsTier) && (
              <span className={`rounded px-1 text-[9px] font-black uppercase ${tierBadge(f.newsTier)!.cls}`} title={f.newsTier === 'A' ? 'Tier A — immediate spike (aggressive)' : 'Tier B — confirmed reaction'}>
                {tierBadge(f.newsTier)!.label}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[10px] font-semibold text-slate-400">{f.currentStatus}</p>
          {newsPill(f) && <p className="mt-0.5 text-[10px] font-bold text-amber-600" title="High-impact news for this symbol's currency">{newsPill(f)}</p>}
        </td>
        <td className="px-3 py-2"><ForecastStatusPill status={f.status} /></td>
        <td className="px-3 py-2 text-right font-mono">
          <span className="font-black text-slate-900">{f.setupScore ?? '—'}</span>
          {f.scoreChange !== null && f.scoreChange !== 0 && (
            <span className={`ml-1 text-[10px] font-black ${scoreDeltaClass(f.scoreChange)}`}>{f.scoreChange > 0 ? '+' : ''}{f.scoreChange}</span>
          )}
        </td>
        <td className="px-3 py-2 text-right font-mono font-bold text-slate-700">{f.executionProbability ?? '—'}%</td>
        <td className="px-3 py-2 text-right">
          <span className="font-black text-slate-900">{f.expectedExecutionTime ? clock(f.expectedExecutionTime) : '—'}</span>
          <span className="ml-1.5 font-mono text-[11px] text-amber-600">{etaLabel(f.expectedExecutionTime, now)}</span>
        </td>
        <td className="px-3 py-2 text-[11px] font-semibold text-slate-500">{FORECAST_BASIS_LABEL[f.forecastBasis] || f.forecastBasis}</td>
        <td className="px-3 py-2 text-right text-[11px] text-slate-400" title="Uncalibrated model estimate — becomes a measured number once forecasts resolve (Phase 5).">
          {f.forecastConfidence ?? '—'}% <span className="text-slate-300">est.</span>
          {Number(f.reforecastCount) > 0 && <span className="ml-1 text-amber-600">·×{f.reforecastCount}</span>}
        </td>
        <td className="px-3 py-2 text-right">
          <button
            type="button"
            onClick={() => runAnalyze(f.id)}
            disabled={analyzingId === f.id}
            className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-2.5 py-1 text-[11px] font-bold text-white transition hover:bg-slate-700 disabled:opacity-50"
          >
            {analyzingId === f.id ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} className="text-amber-400" />}
            Analyze
          </button>
        </td>
      </tr>
    );
  };

  const SortBtn = ({ id, label }: { id: 'eta' | 'score' | 'prob' | 'recent'; label: string }) => (
    <button
      type="button"
      onClick={() => setForecastSort(id)}
      className={`rounded-full px-2.5 py-1 text-[11px] font-bold transition ${forecastSort === id ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
    >{label}</button>
  );

  const FilterChips = ({ options, value, onChange }: { options: string[]; value: string; onChange: (v: string) => void }) => (
    <div className="flex flex-wrap items-center gap-1">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={`rounded-full px-2 py-0.5 text-[11px] font-bold transition ${value === opt ? 'bg-amber-500 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
        >{opt}</button>
      ))}
    </div>
  );

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

      {/* Upcoming Executions — execution forecasts (compact table) */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-slate-900">
          <CalendarClock className="text-amber-500" size={18} />
          <h2 className="text-xl font-black">Upcoming Executions</h2>
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-600">Forecast · when a favorable setup becomes executable</span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-500">{upcoming.length}</span>
          {lastForecastScan && <span className="ml-auto text-[11px] font-semibold text-slate-400">Last scan {clock(lastForecastScan.toISOString())}</span>}
        </div>

        {/* Hero strip — soonest / READY forecast */}
        {hero && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl bg-gradient-to-r from-slate-900 to-slate-800 px-5 py-4 text-white shadow-lg">
            <div className="flex items-center gap-2">
              <Zap size={18} className="text-amber-400" />
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Next up</p>
                <p className="flex items-center gap-1.5 text-lg font-black leading-tight">
                  <DecisionArrow decision={hero.decision} lean={hero.lean} />{hero.symbol}
                  <span className="text-xs font-bold text-slate-400">{hero.timeframe}</span>
                  <ForecastStatusPill status={hero.status} />
                </p>
              </div>
            </div>
            <div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Expected</p><p className="text-lg font-black leading-tight">{hero.expectedExecutionTime ? clock(hero.expectedExecutionTime) : '—'} <span className="font-mono text-sm text-amber-400">{etaLabel(hero.expectedExecutionTime, now)}</span></p></div>
            <div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Score</p><p className="text-lg font-black leading-tight">{hero.setupScore ?? '—'}</p></div>
            <div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Exec. prob</p><p className="text-lg font-black leading-tight">{hero.executionProbability ?? '—'}%</p></div>
            <div className="min-w-[120px] flex-1"><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Why</p><p className="text-sm font-bold leading-tight text-slate-200">{FORECAST_BASIS_LABEL[hero.forecastBasis] || hero.forecastBasis}{hero.reason ? ` · ${hero.reason}` : ''}</p></div>
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[11px] font-bold text-slate-400">
          <div className="flex items-center gap-1.5"><span>TF:</span><FilterChips options={FORECAST_TF_OPTIONS} value={tfFilter} onChange={setTfFilter} /></div>
          <div className="flex items-center gap-1.5"><span>Status:</span><FilterChips options={FORECAST_STATUS_OPTIONS} value={statusFilter} onChange={setStatusFilter} /></div>
          <div className="flex items-center gap-1.5"><span>Grade:</span><FilterChips options={FORECAST_GRADE_OPTIONS} value={gradeFilter} onChange={setGradeFilter} /></div>
        </div>

        <div className="flex items-center gap-2 text-[11px] font-bold text-slate-400">
          <span>Sort:</span><SortBtn id="eta" label="Soonest" /><SortBtn id="score" label="Top score" /><SortBtn id="prob" label="Probability" /><SortBtn id="recent" label="Most recent" />
          <span className="ml-auto rounded bg-amber-50 px-2 py-0.5 font-semibold text-amber-700" title="Uncalibrated model estimate — becomes a measured hit-rate once forecasts resolve.">Confidence = uncalibrated estimate · not a guarantee</span>
        </div>

        {analyzeError && <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] font-semibold text-rose-700">Analyze failed: {analyzeError}</div>}

        {upcoming.length ? (
          <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="border-b border-slate-100 text-[10px] uppercase tracking-[0.15em] text-slate-500">
                <tr>
                  <th className="px-3 py-2">Symbol</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-right">Score</th>
                  <th className="px-3 py-2 text-right">Prob</th>
                  <th className="px-3 py-2 text-right">Expected execution</th>
                  <th className="px-3 py-2">Why</th>
                  <th className="px-3 py-2 text-right">Confidence</th>
                  <th className="px-3 py-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">{upcoming.map(renderForecastRow)}</tbody>
            </table>
          </div>
        ) : (
          <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-10 text-center">
            <CalendarClock className="mx-auto text-slate-300" size={36} />
            <p className="mt-3 text-sm font-bold text-slate-500">No upcoming executions forecast right now.</p>
            <p className="mt-1 text-xs font-semibold text-slate-400">The forecaster scans every hour across all symbols and timeframes (M5–D1). Favorable-but-waiting setups appear here with an estimated execution time. Keep MT5 connected.</p>
          </div>
        )}
      </section>

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

      {/* Analyze Execution Opportunity — result modal */}
      {analysis && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm" onClick={() => setAnalysis(null)}>
          <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white p-4">
              <div>
                <p className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.18em] text-amber-600"><Sparkles size={13} /> Execution Analysis</p>
                <h3 className="mt-1 text-base font-black text-slate-950">{analysis.symbol} <span className="text-sm text-slate-500">{analysis.timeframe}</span></h3>
              </div>
              <button type="button" onClick={() => setAnalysis(null)} className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><X size={16} /></button>
            </div>
            <div className="space-y-3 p-4">
              <div className="flex items-center justify-between">
                <span className={`rounded-lg px-3 py-1.5 text-sm font-black uppercase ${recBadgeClass(analysis.recommendation)}`}>{analysis.recommendation}</span>
                <div className="text-right">
                  <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Confidence</p>
                  <p className="text-xl font-black text-slate-900">{analysis.confidence}%</p>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center text-[11px]">
                <div className="rounded-lg bg-slate-50 p-2"><p className="font-black uppercase text-slate-400">Score</p><p className="text-sm font-black text-slate-800">{analysis.setupScore ?? '—'}</p></div>
                <div className="rounded-lg bg-slate-50 p-2"><p className="font-black uppercase text-slate-400">Why</p><p className="text-sm font-bold text-slate-800">{analysis.forecastBasis ? (FORECAST_BASIS_LABEL[analysis.forecastBasis] || analysis.forecastBasis) : '—'}</p></div>
                <div className="rounded-lg bg-slate-50 p-2"><p className="font-black uppercase text-slate-400">ETA</p><p className="text-sm font-bold text-slate-800">{analysis.expectedExecutionTime ? clock(analysis.expectedExecutionTime) : '—'}</p></div>
              </div>
              {/* Full trade ticket — same depth as the Signals dashboard */}
              {analysis.plan && (
                <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Trade plan</p>
                    <span className="text-[10px] font-bold text-slate-500">{analysis.plan.grade || ''}{analysis.plan.riskRewardRatio ? ` · RR ${analysis.plan.riskRewardRatio}` : ''}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 font-mono text-[11px]">
                    <div className="rounded-lg bg-white p-2"><span className="block text-[9px] font-black uppercase text-slate-400">Entry</span>{px(analysis.plan.entryPrice, analysis.symbol)}</div>
                    <div className="rounded-lg bg-red-50 p-2 text-red-700"><span className="block text-[9px] font-black uppercase text-red-400">SL</span>{px(analysis.plan.stopLoss, analysis.symbol)}</div>
                    <div className="rounded-lg bg-emerald-50 p-2 text-emerald-700"><span className="block text-[9px] font-black uppercase text-emerald-500">TP1</span>{px(analysis.plan.takeProfit1, analysis.symbol)}</div>
                    <div className="rounded-lg bg-emerald-50 p-2 text-emerald-700"><span className="block text-[9px] font-black uppercase text-emerald-500">TP2</span>{px(analysis.plan.takeProfit2, analysis.symbol)}</div>
                    <div className="rounded-lg bg-emerald-50 p-2 text-emerald-700"><span className="block text-[9px] font-black uppercase text-emerald-500">TP3</span>{px(analysis.plan.takeProfit3, analysis.symbol)}</div>
                    <div className="rounded-lg bg-white p-2"><span className="block text-[9px] font-black uppercase text-slate-400">Lot</span>{analysis.plan.lotSize ?? 'n/a'}</div>
                  </div>
                  {(analysis.plan.maxLoss !== null || analysis.plan.investment !== null) && (
                    <div className="mt-2 grid grid-cols-3 gap-2 text-center text-[11px] font-bold text-slate-600">
                      <div>Risk {analysis.plan.riskPercent ?? 'n/a'}%</div>
                      <div>Max loss {money(analysis.plan.maxLoss)}</div>
                      <div>Invest {money(analysis.plan.investment)}</div>
                    </div>
                  )}
                  {analysis.plan.confluences.length > 0 && (
                    <p className="mt-2 text-[10px] font-semibold text-slate-500">Confluences: {analysis.plan.confluences.map((c) => `${c.name} +${c.points}`).join(', ')}</p>
                  )}
                  {analysis.plan.timingTip && <p className="mt-1 text-[10px] font-medium text-slate-400">{analysis.plan.timingTip}</p>}
                </div>
              )}
              <div>
                <p className="mb-1 text-[10px] font-black uppercase tracking-wider text-slate-400">Reasoning</p>
                <ul className="space-y-1">
                  {analysis.reasoning.map((r, i) => (
                    <li key={i} className="flex items-start gap-2 text-[12px] font-semibold text-slate-600"><span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-amber-500" />{r}</li>
                  ))}
                </ul>
              </div>
              <p className="rounded-lg bg-amber-50 px-2 py-1.5 text-[10px] font-semibold text-amber-700">{analysis.note} · {analysis.source === 'ai' ? 'AI' : 'Deterministic engine'}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
