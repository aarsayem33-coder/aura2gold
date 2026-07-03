import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, Trophy, Clock, Coins, Target, Layers, Award, Globe, ScrollText, TrendingUp, TrendingDown, Mail, Radio, Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import { fetchStrategies, fetchStrategyPerformance, fetchStrategySignals, fetchStrategyConfluence } from '../mt5Api';
import type {
  StrategyMeta, StrategyPerformanceResponse, StrategyForexBucket, StrategyFtBucket, StrategyAtBucket,
  StrategyTfRow, StrategySymbolRow, StrategySessionRow, StrategyComboRow, StrategySignal,
  StrategySessionBreakdown, StrategySessionStrategyRow, StrategyScoreRow,
  ConfluenceResponse, ConfluenceWin,
} from '../types';

const REFRESH_MS = 60000;
type Metric = 'forex' | 'ftt' | 'at';
const metricLabel = (m: Metric) => (m === 'ftt' ? 'fixed-time' : m === 'at' ? 'as-traded' : 'forex');
// Empty bucket so ranking/render never crashes on rows missing an as-traded bucket (older data).
const EMPTY_AT: StrategyAtBucket = { wins: 0, losses: 0, draws: 0, winLossSettled: 0, winRate: null, expectancyPips: null, confidence: 'weak' };
type RangeKey = 'today' | 'yesterday' | 'last7' | 'd30' | 'd60' | 'd90' | 'd180' | 'custom';
const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last7', label: 'Last 7 days' },
  { key: 'd30', label: '30 days' },
  { key: 'd60', label: '60 days' },
  { key: 'd90', label: '90 days' },
  { key: 'd180', label: '180 days' },
  { key: 'custom', label: 'Custom range…' },
];
type ReportParams = { days?: number; preset?: string; from?: string; to?: string };
function rangeToParams(r: RangeKey): ReportParams {
  if (r === 'today' || r === 'yesterday' || r === 'last7') return { preset: r };
  if (r === 'custom') return { preset: 'last7' }; // fallback until both custom dates are picked
  return { days: Number(r.slice(1)) };
}

const confClass: Record<string, string> = {
  strong: 'bg-emerald-100 text-emerald-700', usable: 'bg-blue-100 text-blue-700',
  early: 'bg-amber-100 text-amber-700', weak: 'bg-slate-100 text-slate-500',
};

type AnyBucketRow = { forex: StrategyForexBucket; fixedTime: StrategyFtBucket; asTraded?: StrategyAtBucket };
const pick = (row: AnyBucketRow, m: Metric): StrategyForexBucket | StrategyFtBucket | StrategyAtBucket =>
  (m === 'ftt' ? row.fixedTime : m === 'at' ? (row.asTraded ?? EMPTY_AT) : row.forex);

function rankByMetric<T extends AnyBucketRow>(rows: T[], m: Metric, minSample: number): T[] {
  return [...rows].sort((a, b) => {
    const ba = pick(a, m), bb = pick(b, m);
    const aOk = (ba.winLossSettled ?? 0) >= minSample, bOk = (bb.winLossSettled ?? 0) >= minSample;
    if (aOk !== bOk) return aOk ? -1 : 1;
    return ((bb.winRate ?? -1) - (ba.winRate ?? -1)) || ((bb.winLossSettled ?? 0) - (ba.winLossSettled ?? 0));
  });
}

const wrColor = (wr: number | null) => (wr === null ? 'text-slate-400' : wr >= 60 ? 'text-emerald-600' : wr >= 50 ? 'text-blue-600' : 'text-rose-600');
const barColor = (wr: number | null) => (wr === null ? 'bg-slate-200' : wr >= 60 ? 'bg-emerald-500' : wr >= 50 ? 'bg-blue-500' : 'bg-rose-500');

// Case-insensitive "any field contains query" — empty query matches everything.
const matchq = (q: string, ...fields: (string | null | undefined)[]) => {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((f) => (f || '').toLowerCase().includes(needle));
};

// Small uppercase group heading to organise the page into clear sections.
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h2 className="px-1 pt-1 text-[11px] font-black uppercase tracking-[0.2em] text-slate-400">{children}</h2>;
}

// Win-rate cell with a tiny progress bar + confidence chip.
function WinCell({ b, minSample, bar = true }: { b: StrategyForexBucket | StrategyFtBucket | StrategyAtBucket | null | undefined; minSample: number; bar?: boolean }) {
  if (!b) return <div className="min-w-[92px] text-right text-sm font-bold text-slate-300">—</div>;
  const settled = b.winLossSettled ?? 0;
  const trusted = settled >= minSample;
  return (
    <div className="min-w-[92px]">
      <div className="flex items-baseline justify-end gap-1">
        <span className={`text-base font-black ${wrColor(b.winRate)}`}>{b.winRate === null ? '—' : `${b.winRate}%`}</span>
      </div>
      {bar && (
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
          <div className={`h-full rounded-full ${barColor(b.winRate)}`} style={{ width: `${b.winRate === null ? 0 : Math.max(2, Math.min(100, b.winRate))}%` }} />
        </div>
      )}
      <div className={`mt-1 inline-block rounded px-1.5 py-0.5 text-[9px] font-black uppercase ${trusted ? confClass.strong : confClass[b.confidence] || ''}`}>
        {trusted ? `${b.wins}W/${b.losses}L · ${settled} scored` : `${b.confidence} (${settled})`}
      </div>
    </div>
  );
}

// A compact "top pick" summary card.
function PickCard({ icon, label, title, subtitle, b, minSample }: {
  icon: React.ReactNode; label: string; title: string; subtitle?: string | null;
  b: (StrategyForexBucket | StrategyFtBucket | StrategyAtBucket) | null; minSample: number;
}) {
  const wr = b?.winRate ?? null;
  const settled = b?.winLossSettled ?? 0;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
      <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-wider text-slate-400">{icon} {label}</div>
      <div className="mt-2 flex items-end justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-black text-slate-900" title={title}>{title || '—'}</p>
          {subtitle && <p className="truncate text-[11px] font-semibold text-slate-400">{subtitle}</p>}
        </div>
        <div className={`shrink-0 text-2xl font-black ${wrColor(wr)}`}>{wr === null ? '—' : `${wr}%`}</div>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${barColor(wr)}`} style={{ width: `${wr === null ? 0 : Math.max(2, Math.min(100, wr))}%` }} />
      </div>
      <p className="mt-1.5 text-[10px] font-bold uppercase text-slate-400">{settled >= minSample ? `${settled} scored · trusted` : `${settled} scored · ${b?.confidence || 'no'} sample`}</p>
    </div>
  );
}

const expLabel = (b: StrategyForexBucket) =>
  b.expectancyPips === null ? '—'
    : `${b.expectancyPips > 0 ? '+' : ''}${b.expectancyPips}p${b.expectancyR !== null ? ` · ${b.expectancyR > 0 ? '+' : ''}${b.expectancyR}R` : ''}`;

// Average signal R:R the bucket's forex plans offered (TP3 vs SL at signal time).
const rrLabel = (b: StrategyForexBucket) => (b.avgRR == null ? '—' : `1:${b.avgRR}`);

function outcomeChip(o: string) {
  const s = (o || '').toUpperCase();
  if (s.endsWith('_WIN') || s === 'WIN') return 'bg-emerald-50 text-emerald-700';
  if (s === 'LOSS') return 'bg-rose-50 text-rose-700';
  if (s === 'PENDING') return 'bg-blue-50 text-blue-600';
  if (s === 'DRAW' || s === 'AMBIGUOUS') return 'bg-amber-50 text-amber-700';
  return 'bg-slate-100 text-slate-400';
}

// System / email tracking chips for a signal.
function SourceChips({ popupSent, emailSent }: { popupSent?: boolean | null; emailSent?: boolean | null }) {
  if (popupSent == null && emailSent == null) return <span className="text-[10px] text-slate-300">—</span>;
  return (
    <div className="flex items-center gap-1">
      <span className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-black ${popupSent ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-400'}`} title={popupSent ? 'Tracked by system (live popup)' : 'No popup'}><Radio size={9} /> SYS</span>
      <span className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-black ${emailSent ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-400'}`} title={emailSent ? 'Sent by email' : 'Not emailed'}><Mail size={9} /> MAIL</span>
    </div>
  );
}

// Fixed-time live/settled cell: pulsing green/red LIVE pill while pending, else WIN/LOSS/DRAW.
function FtResultCell({ s }: { s: StrategySignal }) {
  if (s.live) {
    const st = s.live.status;
    const pillCls = st === 'WINNING' ? 'bg-emerald-100 text-emerald-700' : st === 'LOSING' ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-500';
    const dotCls = st === 'WINNING' ? 'bg-emerald-500' : st === 'LOSING' ? 'bg-rose-500' : 'bg-slate-400';
    return (
      <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-black ${pillCls}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${dotCls} animate-pulse`} /> LIVE {s.live.pips > 0 ? '+' : ''}{s.live.pips}p
      </span>
    );
  }
  return (
    <span>
      <span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${outcomeChip(s.ftOutcome)}`}>{s.ftOutcome}</span>
      {s.ftPips !== null && <span className={`ml-1 font-mono text-[11px] font-bold ${s.ftPips >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{s.ftPips > 0 ? '+' : ''}{s.ftPips}p</span>}
      {s.ftActionable === false && <span className="ml-1 rounded px-1 py-0.5 text-[9px] font-black bg-amber-50 text-amber-600" title="Surfaced after its expiry candle had closed — real result, but not tradable as a fixed-time call (excluded from the tradable win-rate).">LATE</span>}
    </span>
  );
}

export default function StrategyLabReports() {
  const [strategies, setStrategies] = useState<StrategyMeta[]>([]);
  const [selected, setSelected] = useState('');
  const [perf, setPerf] = useState<StrategyPerformanceResponse | null>(null);
  const [signals, setSignals] = useState<StrategySignal[]>([]);
  const [range, setRange] = useState<RangeKey>('last7');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [tab, setTab] = useState<'forex' | 'ftt' | 'at' | 'confluence'>('forex');
  const metric: Metric = tab === 'ftt' ? 'ftt' : tab === 'at' ? 'at' : 'forex';
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchStrategies().then((m) => {
      // Disabled strategies are hidden from reports too (manage them on Settings).
      const visible = (m.strategies || []).filter((s) => s.control?.enabled !== false);
      setStrategies(visible);
      setSelected((c) => c || visible[0]?.id || '');
    }).catch(() => {});
  }, []);

  // Resolve the active date window: a valid custom from–to wins, else the preset/day range.
  const reportParams: ReportParams = useMemo(
    () => (range === 'custom' && customFrom && customTo && customFrom <= customTo) ? { from: customFrom, to: customTo } : rangeToParams(range),
    [range, customFrom, customTo],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try { setPerf(await fetchStrategyPerformance(reportParams)); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed to load performance'); }
    finally { setLoading(false); }
  }, [reportParams]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const loadSignals = useCallback(async () => {
    if (!selected) return;
    try { const r = await fetchStrategySignals(selected); setSignals(r.signals); } catch { /* log is best-effort */ }
  }, [selected]);

  useEffect(() => {
    void loadSignals();
    const t = setInterval(() => void loadSignals(), REFRESH_MS);
    return () => clearInterval(t);
  }, [loadSignals]);

  const minSample = perf?.minSampleToRank ?? 20;
  const activePerf = useMemo(() => perf?.strategies.find((s) => s.id === selected) || null, [perf, selected]);

  // Client-side re-rank by the chosen metric (forex / fixed-time).
  const rankedStrategies = useMemo(() => rankByMetric(perf?.strategies || [], metric, minSample), [perf, metric, minSample]);
  const rankedTf = useMemo(() => rankByMetric(perf?.timeframeRanking || [], metric, minSample), [perf, metric, minSample]);
  const rankedSymbols = useMemo(() => rankByMetric(perf?.symbolRanking || [], metric, minSample), [perf, metric, minSample]);
  const rankedSessions = useMemo(() => rankByMetric(perf?.sessionRanking || [], metric, minSample), [perf, metric, minSample]);
  const rankedScore = useMemo(() => rankByMetric(perf?.scoreRanking || [], metric, minSample), [perf, metric, minSample]);
  const rankedCombos = useMemo(() => rankByMetric(perf?.combos || [], metric, minSample), [perf, metric, minSample]);
  // Search filter (applies to the leaderboard + combos).
  const visibleStrategies = useMemo(() => rankedStrategies.filter((s) => matchq(query, s.name, s.source, s.id)), [rankedStrategies, query]);
  const visibleCombos = useMemo(() => rankedCombos.filter((c) => matchq(query, c.strategyName, c.symbol, c.timeframe)), [rankedCombos, query]);
  const sessionBreakdown = perf?.sessionBreakdown || [];
  const tfBySel = useMemo(() => rankByMetric(activePerf?.byTimeframe || [], metric, minSample), [activePerf, metric, minSample]);
  const symBySel = useMemo(() => rankByMetric(activePerf?.bySymbol || [], metric, minSample), [activePerf, metric, minSample]);
  const sessBySel = useMemo(() => rankByMetric(activePerf?.bySession || [], metric, minSample), [activePerf, metric, minSample]);
  const scoreBySel = useMemo(() => rankByMetric(activePerf?.byScore || [], metric, minSample), [activePerf, metric, minSample]);

  // Signal log filtered to the selected date window (matches the performance window).
  const logSignals = useMemo(() => {
    const w = perf?.window;
    if (!w) return signals;
    const from = Date.parse(w.from), to = Date.parse(w.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return signals;
    return signals.filter((s) => { const t = s.signalTime ? Date.parse(s.signalTime) : NaN; return Number.isFinite(t) && t >= from && t < to; });
  }, [signals, perf]);

  function bestOf<T extends AnyBucketRow>(rows: T[]): T | null {
    if (!rows.length) return null;
    const trusted = rows.find((r) => (pick(r, metric).winLossSettled ?? 0) >= minSample);
    return trusted || rows[0];
  }
  const bestStrategy = bestOf(rankedStrategies);
  const bestTf = bestOf(rankedTf);
  const bestSymbol = bestOf(rankedSymbols);
  const bestSession = bestOf(rankedSessions) as StrategySessionRow | null;

  const totalSignals = (perf?.strategies || []).reduce((a, s) => a + (s.total || 0), 0);

  const MetricToggle = (
    <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-0.5">
      <button type="button" onClick={() => setTab('forex')} className={`rounded-md px-3 py-1 text-xs font-bold transition ${tab === 'forex' ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-50'}`}>Forex</button>
      <button type="button" onClick={() => setTab('ftt')} className={`rounded-md px-3 py-1 text-xs font-bold transition ${tab === 'ftt' ? 'bg-violet-600 text-white' : 'text-slate-500 hover:bg-slate-50'}`}>Fixed-Time</button>
      <button type="button" onClick={() => setTab('at')} className={`rounded-md px-3 py-1 text-xs font-bold transition ${tab === 'at' ? 'bg-teal-600 text-white' : 'text-slate-500 hover:bg-slate-50'}`} title="As-traded: realistic result — entered at the live price when the signal fired, expiry at +duration.">As-traded</button>
      <button type="button" onClick={() => setTab('confluence')} className={`inline-flex items-center gap-1 rounded-md px-3 py-1 text-xs font-bold transition ${tab === 'confluence' ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:bg-slate-50'}`}><Layers size={12} />Confluence</button>
    </div>
  );

  return (
    <div className="space-y-5 p-1">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-amber-100 p-2"><Trophy className="text-amber-600" size={22} /></div>
          <div>
            <h1 className="text-xl font-black text-slate-900">Strategy Lab — Reports</h1>
            <p className="text-xs font-medium text-slate-400">What actually works — ranked by win rate across strategies, timeframes, symbols & combos. Measured forex (TP/SL) + fixed-time.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {MetricToggle}
          <select value={range} onChange={(e) => setRange(e.target.value as RangeKey)} className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-semibold">
            {RANGE_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
          {range === 'custom' && (
            <div className="flex items-center gap-1 rounded-lg border border-indigo-200 bg-indigo-50/50 px-2 py-1">
              <input type="date" value={customFrom} max={customTo || undefined} onChange={(e) => setCustomFrom(e.target.value)} className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-xs font-semibold" />
              <span className="text-xs font-bold text-slate-400">→</span>
              <input type="date" value={customTo} min={customFrom || undefined} onChange={(e) => setCustomTo(e.target.value)} className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-xs font-semibold" />
            </div>
          )}
          <Link to="/strategy-lab" className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-bold text-slate-600 hover:bg-slate-50">Signals</Link>
          <button type="button" onClick={() => { void load(); void loadSignals(); }} disabled={loading} className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-bold text-white hover:bg-slate-700 disabled:opacity-50">
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Refresh
          </button>
        </div>
      </div>

      {tab === 'confluence' && <ConfluenceTab strategies={strategies} rangeParams={reportParams} rangeLabel={perf?.window?.label || RANGE_OPTIONS.find((o) => o.key === range)?.label || ''} />}

      {tab !== 'confluence' && (<>
      {/* SEARCH — filters the strategy leaderboard, combos & per-session strategy lists */}
      <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 shadow-card">
        <Search size={16} className="shrink-0 text-slate-400" />
        <input
          type="text" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Search strategies, symbols or timeframes…"
          className="w-full bg-transparent text-sm font-semibold text-slate-700 placeholder:font-medium placeholder:text-slate-400 focus:outline-none"
        />
        {query && <button type="button" onClick={() => setQuery('')} className="shrink-0 rounded-md px-2 py-0.5 text-xs font-bold text-slate-400 hover:bg-slate-100 hover:text-slate-600">Clear</button>}
      </div>

      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">{error}</div>}

      {/* TOP PICKS — best in each dimension, by the chosen metric */}
      <SectionLabel>Overview · best in each dimension</SectionLabel>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <PickCard icon={<Award size={12} />} label={`Best strategy · ${metricLabel(metric)}`} title={bestStrategy?.name || '—'} subtitle={`${bestStrategy?.total ?? 0} signals`} b={bestStrategy ? pick(bestStrategy, metric) : null} minSample={minSample} />
        <PickCard icon={<Clock size={12} />} label="Best timeframe" title={bestTf?.timeframe || '—'} subtitle={`${bestTf?.total ?? 0} signals (all strategies)`} b={bestTf ? pick(bestTf, metric) : null} minSample={minSample} />
        <PickCard icon={<Coins size={12} />} label="Best symbol" title={bestSymbol?.symbol || '—'} subtitle={`${bestSymbol?.total ?? 0} signals (all strategies)`} b={bestSymbol ? pick(bestSymbol, metric) : null} minSample={minSample} />
        <PickCard icon={<Globe size={12} />} label="Best session (BD time)" title={bestSession?.sessionLabel || '—'} subtitle={bestSession?.bdRange || 'all strategies'} b={bestSession ? pick(bestSession, metric) : null} minSample={minSample} />
      </div>

      {/* STRATEGY LEADERBOARD */}
      <SectionLabel>Leaderboards · ranked by {metricLabel(metric)} win rate</SectionLabel>
      <div className="rounded-2xl border border-slate-200 bg-white shadow-card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3">
          <Trophy size={16} className="text-amber-500" />
          <h3 className="text-sm font-black uppercase tracking-wider text-slate-500">Strategy leaderboard · {perf?.window?.label || RANGE_OPTIONS.find((o) => o.key === range)?.label}</h3>
          <span className="ml-1 text-[11px] font-semibold text-slate-400">ranked by {metricLabel(metric)} win rate · trusted once ≥ {minSample} scored · {totalSignals} signals total{query ? ` · filtered: “${query}”` : ''}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="border-b border-slate-100 text-[10px] uppercase tracking-[0.15em] text-slate-500">
              <tr>
                <th className="px-4 py-2 w-10">#</th>
                <th className="px-4 py-2">Strategy</th>
                <th className="px-4 py-2 text-right">Forex win%</th>
                <th className="px-4 py-2 text-right">Expectancy</th>
                <th className="px-4 py-2 text-right" title="Average signal risk-to-reward the strategy's forex plans offered (TP3 vs SL at signal time).">Avg RR</th>
                <th className="px-4 py-2 text-right" title="Idealized: signal-bar close → next-bar close.">Fixed-time win%</th>
                <th className="px-4 py-2 text-right" title="As-traded: live entry when the signal fired, expiry at +duration. The realistic number.">As-traded win%</th>
                <th className="px-4 py-2 text-right">Signals</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {visibleStrategies.length ? visibleStrategies.map((s, i) => (
                <tr key={s.id} className={`hover:bg-slate-50/70 cursor-pointer ${s.id === selected ? 'bg-violet-50/50' : ''}`} onClick={() => setSelected(s.id)}>
                  <td className="px-4 py-2 font-black text-slate-400">{i + 1}</td>
                  <td className="px-4 py-2"><span className="font-bold text-slate-800">{s.name}</span>{s.source && <span className="block text-[10px] font-semibold text-slate-400 max-w-[260px] truncate" title={s.source}>{s.source}</span>}</td>
                  <td className="px-4 py-2"><div className="flex justify-end"><WinCell b={s.forex} minSample={minSample} /></div></td>
                  <td className="px-4 py-2 text-right font-mono text-xs">{expLabel(s.forex)}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs font-bold text-slate-700">{rrLabel(s.forex)}</td>
                  <td className="px-4 py-2"><div className="flex justify-end"><WinCell b={s.fixedTime} minSample={minSample} /></div></td>
                  <td className="px-4 py-2"><div className="flex justify-end"><WinCell b={s.asTraded} minSample={minSample} /></div></td>
                  <td className="px-4 py-2 text-right font-mono font-bold">{s.total}</td>
                </tr>
              )) : (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-sm font-medium text-slate-400">{loading ? 'Loading…' : query ? `No strategies match “${query}”.` : 'No strategy signals settled yet — they populate as the lab scans and outcomes resolve.'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* TIMEFRAME + SYMBOL + SESSION + SCORE global rankings (across all strategies) */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 xl:grid-cols-4">
        <RankTable
          title="Timeframe ranking" sub="all strategies" icon={<Clock size={16} className="text-blue-500" />}
          colLabel="TF" rows={rankedTf} keyOf={(r) => (r as StrategyTfRow).timeframe} render={(r) => (r as StrategyTfRow).timeframe} metric={metric} minSample={minSample}
        />
        <RankTable
          title="Symbol ranking" sub="all strategies" icon={<Coins size={16} className="text-amber-500" />}
          colLabel="Symbol" rows={rankedSymbols} keyOf={(r) => (r as StrategySymbolRow).symbol} render={(r) => (r as StrategySymbolRow).symbol} metric={metric} minSample={minSample}
        />
        <RankTable
          title="Session ranking" sub="Bangladesh time" icon={<Globe size={16} className="text-violet-500" />}
          colLabel="Session" rows={rankedSessions} keyOf={(r) => (r as StrategySessionRow).session}
          render={(r) => {
            const s = r as StrategySessionRow;
            return (<><span className="font-black text-slate-800">{s.sessionLabel}</span><span className="block text-[10px] font-semibold text-slate-400">{s.bdRange}</span></>);
          }}
          metric={metric} minSample={minSample}
        />
        <RankTable
          title="Setup score ranking" sub="grade band · all strategies" icon={<Award size={16} className="text-emerald-500" />}
          colLabel="Setup" rows={rankedScore} keyOf={(r) => (r as StrategyScoreRow).band}
          render={(r) => {
            const s = r as StrategyScoreRow;
            return (<><span className="font-black text-slate-800">{s.label}</span><span className="block text-[10px] font-semibold text-slate-400">{s.range}</span></>);
          }}
          metric={metric} minSample={minSample}
        />
      </div>

      {/* SESSION-WISE TOP PERFORMERS — per session: top strategies / symbols / timeframes */}
      <SectionLabel>Session-wise top performers · {metricLabel(metric)}</SectionLabel>
      <SessionBreakdownSection data={sessionBreakdown} metric={metric} minSample={minSample} query={query} loading={loading} />

      {/* BEST COMBOS — strategy × symbol × timeframe */}
      <SectionLabel>Sharpest edges</SectionLabel>
      <div className="rounded-2xl border border-slate-200 bg-white shadow-card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3">
          <Target size={16} className="text-violet-500" />
          <h3 className="text-sm font-black uppercase tracking-wider text-slate-500">Best combos · strategy × symbol × timeframe</h3>
          <span className="ml-1 text-[11px] font-semibold text-slate-400">the sharpest edges, ranked by {metricLabel(metric)} win rate</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead className="border-b border-slate-100 text-[10px] uppercase tracking-[0.15em] text-slate-500">
              <tr>
                <th className="px-4 py-2 w-10">#</th>
                <th className="px-4 py-2">Strategy</th>
                <th className="px-4 py-2">Symbol</th>
                <th className="px-4 py-2">TF</th>
                <th className="px-4 py-2 text-right">Forex win%</th>
                <th className="px-4 py-2 text-right">Exp</th>
                <th className="px-4 py-2 text-right" title="Average signal risk-to-reward of this combo's forex plans.">RR</th>
                <th className="px-4 py-2 text-right">Fixed-time win%</th>
                <th className="px-4 py-2 text-right">As-traded win%</th>
                <th className="px-4 py-2 text-right">Signals</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {visibleCombos.length ? visibleCombos.slice(0, 25).map((c, i) => (
                <tr key={`${c.strategy}-${c.symbol}-${c.timeframe}`} className="hover:bg-slate-50/70">
                  <td className="px-4 py-2 font-black text-slate-400">{i + 1}</td>
                  <td className="px-4 py-2 font-bold text-slate-700">{c.strategyName}</td>
                  <td className="px-4 py-2 font-black text-slate-900">{c.symbol}</td>
                  <td className="px-4 py-2 font-bold text-slate-500">{c.timeframe}</td>
                  <td className="px-4 py-2"><div className="flex justify-end"><WinCell b={c.forex} minSample={minSample} bar={false} /></div></td>
                  <td className="px-4 py-2 text-right font-mono text-xs">{expLabel(c.forex)}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs font-bold text-slate-700">{rrLabel(c.forex)}</td>
                  <td className="px-4 py-2"><div className="flex justify-end"><WinCell b={c.fixedTime} minSample={minSample} bar={false} /></div></td>
                  <td className="px-4 py-2"><div className="flex justify-end"><WinCell b={c.asTraded} minSample={minSample} bar={false} /></div></td>
                  <td className="px-4 py-2 text-right font-mono font-bold">{c.total}</td>
                </tr>
              )) : (
                <tr><td colSpan={10} className="px-4 py-8 text-center text-sm font-medium text-slate-400">{loading ? 'Loading…' : query ? `No combos match “${query}”.` : 'No combos settled yet.'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* SELECTED STRATEGY DEEP-DIVE: by timeframe + by symbol */}
      <SectionLabel>Deep dive · selected strategy</SectionLabel>
      <div className="rounded-2xl border border-slate-200 bg-white shadow-card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <div className="flex items-center gap-2">
            <Layers size={16} className="text-slate-500" />
            <h3 className="text-sm font-black uppercase tracking-wider text-slate-500">Deep dive · {activePerf?.name || selected}</h3>
          </div>
          <select value={selected} onChange={(e) => setSelected(e.target.value)} className="rounded-lg border border-slate-200 px-2 py-1 text-xs font-semibold">
            {strategies.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-1 gap-0 lg:grid-cols-2 xl:grid-cols-4 lg:divide-x lg:divide-slate-100">
          <BreakdownTable title="By timeframe" colLabel="TF" rows={tfBySel} keyOf={(r) => (r as StrategyTfRow).timeframe} render={(r) => (r as StrategyTfRow).timeframe} minSample={minSample} loading={loading} />
          <BreakdownTable title="By symbol" colLabel="Symbol" rows={symBySel} keyOf={(r) => (r as StrategySymbolRow).symbol} render={(r) => (r as StrategySymbolRow).symbol} minSample={minSample} loading={loading} />
          <BreakdownTable title="By session (BD time)" colLabel="Session" rows={sessBySel} keyOf={(r) => (r as StrategySessionRow).session}
            render={(r) => { const s = r as StrategySessionRow; return (<><span className="font-bold">{s.sessionLabel}</span><span className="block text-[10px] font-semibold text-slate-400">{s.bdRange}</span></>); }}
            minSample={minSample} loading={loading} />
          <BreakdownTable title="By setup score" colLabel="Setup" rows={scoreBySel} keyOf={(r) => (r as StrategyScoreRow).band}
            render={(r) => { const s = r as StrategyScoreRow; return (<><span className="font-bold">{s.label}</span><span className="block text-[10px] font-semibold text-slate-400">{s.range}</span></>); }}
            minSample={minSample} loading={loading} />
        </div>
      </div>

      {/* PER-SIGNAL TRACKED LOG — every signal (system + email), forex + fixed-time, live */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <div className="flex items-center gap-2">
            <ScrollText size={16} className="text-slate-500" />
            <h3 className="text-sm font-black uppercase tracking-wider text-slate-500">Signal log · {activePerf?.name || selected}</h3>
            <span className="ml-1 text-[11px] font-semibold text-slate-400">every call tracked by system &amp; email · live position · {logSignals.length} in {perf?.window?.label || 'window'}</span>
          </div>
          <select value={selected} onChange={(e) => setSelected(e.target.value)} className="rounded-lg border border-slate-200 px-2 py-1 text-xs font-semibold">
            {strategies.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead className="border-b border-slate-100 text-[10px] uppercase tracking-[0.15em] text-slate-500">
              <tr>
                <th className="px-3 py-2">Dir</th>
                <th className="px-3 py-2">Symbol</th>
                <th className="px-3 py-2 text-right">Score</th>
                <th className="px-3 py-2 text-right" title="Signal risk-to-reward of the forex plan (TP3 vs SL at signal time).">RR</th>
                <th className="px-3 py-2">Forex result</th>
                <th className="px-3 py-2 text-right">Pips</th>
                <th className="px-3 py-2">Fixed-time (live/result)</th>
                <th className="px-3 py-2">Track</th>
                <th className="px-3 py-2">Signal made</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {logSignals.length ? logSignals.slice(0, 80).map((s) => {
                const up = /BUY/.test(s.direction);
                const liveTint = s.live ? (s.live.status === 'WINNING' ? 'bg-emerald-50/40' : s.live.status === 'LOSING' ? 'bg-rose-50/40' : '') : '';
                return (
                  <tr key={s.id} className={`hover:bg-slate-50/70 ${liveTint}`}>
                    <td className="px-3 py-2">
                      {up
                        ? <span className="inline-flex items-center gap-1 rounded-md bg-emerald-600/10 px-1.5 py-0.5 text-[11px] font-black text-emerald-700"><TrendingUp size={12} /> BUY</span>
                        : <span className="inline-flex items-center gap-1 rounded-md bg-rose-600/10 px-1.5 py-0.5 text-[11px] font-black text-rose-700"><TrendingDown size={12} /> SELL</span>}
                    </td>
                    <td className="px-3 py-2"><span className="font-black text-slate-900">{s.symbol}</span> <span className="text-[10px] font-bold text-slate-400">{s.timeframe}</span></td>
                    <td className="px-3 py-2 text-right">{s.score === null ? <span className="text-slate-300">—</span> : <span className="font-black text-slate-700">{Math.round(s.score)}{s.grade ? ` ${s.grade}` : ''}</span>}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs font-bold text-slate-700">{s.riskReward == null ? <span className="text-slate-300">—</span> : `1:${s.riskReward}`}</td>
                    <td className="px-3 py-2"><span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${outcomeChip(s.outcome)}`}>{s.outcome}{s.tpHitLevel ? ` (TP${s.tpHitLevel})` : ''}</span></td>
                    <td className="px-3 py-2 text-right font-mono text-[12px]">{s.profitLossPips === null ? '—' : <span className={s.profitLossPips >= 0 ? 'text-emerald-600' : 'text-rose-600'}>{s.profitLossPips > 0 ? '+' : ''}{s.profitLossPips}</span>}</td>
                    <td className="px-3 py-2"><FtResultCell s={s} /></td>
                    <td className="px-3 py-2"><SourceChips popupSent={s.popupSent} emailSent={s.emailSent} /></td>
                    <td className="px-3 py-2 text-[11px] text-slate-400 whitespace-nowrap">{s.signalTime ? new Date(s.signalTime).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                  </tr>
                );
              }) : (
                <tr><td colSpan={9} className="px-3 py-8 text-center text-sm font-medium text-slate-400">No signals logged yet for this strategy.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="border-t border-slate-100 px-4 py-2 text-[11px] font-medium text-slate-400">
          Every signal is logged (system) regardless of score; <span className="font-bold">SYS</span> = surfaced as a popup, <span className="font-bold">MAIL</span> = emailed · <span className="font-bold text-emerald-600">LIVE</span> shows the fixed-time call&apos;s current position (green winning / red losing) · multiple calls on the same candle are all kept.
        </div>
      </div>

      {perf?.note && <p className="text-[11px] font-medium text-slate-400 px-1">{perf.note}</p>}
      </>)}
    </div>
  );
}

// Global rank table (timeframe / symbol / session) — both win rates + signals, ranked.
// ─── Confluence tab: do strategies AGREEING produce more accurate signals? ────
function ConfluenceTab({ strategies, rangeParams, rangeLabel }: {
  strategies: StrategyMeta[]; rangeParams: ReportParams; rangeLabel: string;
}) {
  const [data, setData] = useState<ConfluenceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [combo, setCombo] = useState<string[]>([]);
  const [basis, setBasis] = useState<'ft' | 'at'>('ft');
  const rp = `${rangeParams.preset || ''}|${rangeParams.days || ''}|${rangeParams.from || ''}|${rangeParams.to || ''}`;
  const cs = combo.join(',');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchStrategyConfluence({ ...rangeParams, strategies: combo })
      .then((d) => { if (alive) setData(d); })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [rp, cs]); // eslint-disable-line react-hooks/exhaustive-deps

  const minSample = data?.minSample ?? 12;
  const pickW = (o: { fixedTime: ConfluenceWin; asTraded: ConfluenceWin }) => (basis === 'at' ? o.asTraded : o.fixedTime);
  const toggle = (id: string) => setCombo((c) => (c.includes(id) ? c.filter((x) => x !== id) : (c.length >= 3 ? c : [...c, id])));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-indigo-200 bg-indigo-50/50 px-4 py-3">
        <div className="flex items-start gap-2">
          <Layers className="mt-0.5 shrink-0 text-indigo-600" size={18} />
          <div>
            <h3 className="text-sm font-black text-indigo-900">Confluence — do strategies agreeing produce more accurate signals?</h3>
            <p className="text-[11px] font-medium text-indigo-700/80">When 2+ strategies fire the SAME direction on the SAME candle for a symbol, that&apos;s a confluence. Win rate = the next-candle outcome (shared by all agreeing strategies). {rangeLabel}.</p>
          </div>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-indigo-200 bg-white p-0.5">
          <button type="button" onClick={() => setBasis('ft')} className={`rounded-md px-2.5 py-1 text-[11px] font-bold ${basis === 'ft' ? 'bg-violet-600 text-white' : 'text-slate-500'}`}>Fixed-time</button>
          <button type="button" onClick={() => setBasis('at')} className={`rounded-md px-2.5 py-1 text-[11px] font-bold ${basis === 'at' ? 'bg-violet-600 text-white' : 'text-slate-500'}`}>As-traded</button>
        </div>
      </div>

      {loading && !data && <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-slate-400"><Loader2 className="mx-auto animate-spin" /> Loading confluence…</div>}

      <SectionLabel>Agreement ladder · more strategies agreeing = higher win rate?</SectionLabel>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {(data?.agreementLadder || []).map((r) => {
          const w = pickW(r);
          return (
            <div key={r.agree} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
              <div className="text-[10px] font-black uppercase tracking-wider text-slate-400">{r.agree === '1' ? '1 strategy' : `${r.agree} agree`}</div>
              <div className={`mt-1 text-2xl font-black ${wrColor(w.winRate)}`}>{w.winRate === null ? '—' : `${w.winRate}%`}</div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${barColor(w.winRate)}`} style={{ width: `${w.winRate ?? 0}%` }} /></div>
              <div className="mt-1 text-[10px] font-bold text-slate-400">{r.moments} moments · {w.settled} scored</div>
            </div>
          );
        })}
      </div>

      <SectionLabel>Best 2-strategy pairs · when both agree (≥{minSample} scored)</SectionLabel>
      <div className="rounded-2xl border border-slate-200 bg-white shadow-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-slate-100 text-[10px] uppercase tracking-[0.15em] text-slate-500">
              <tr>
                <th className="px-4 py-2 w-8">#</th>
                <th className="px-4 py-2">Pair (agree, same candle)</th>
                <th className="px-4 py-2 text-right">Combined win%</th>
                <th className="px-4 py-2 text-right">Solo A / B</th>
                <th className="px-4 py-2 text-right">Lift</th>
                <th className="px-4 py-2 text-right">Moments</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {(data?.topPairs || []).length ? data!.topPairs.map((p, i) => {
                const w = pickW(p);
                const soloAvg = (p.soloA?.winRate != null && p.soloB?.winRate != null) ? (p.soloA.winRate + p.soloB.winRate) / 2 : null;
                const lift = (w.winRate != null && soloAvg != null) ? Math.round((w.winRate - soloAvg) * 10) / 10 : null;
                return (
                  <tr key={`${p.a}|${p.b}`} className="hover:bg-slate-50/70">
                    <td className="px-4 py-2 font-black text-slate-400">{i + 1}</td>
                    <td className="px-4 py-2 font-bold text-slate-800">{p.aName} <span className="text-indigo-400">+</span> {p.bName}</td>
                    <td className="px-4 py-2 text-right"><span className={`font-black ${wrColor(w.winRate)}`}>{w.winRate === null ? '—' : `${w.winRate}%`}</span> <span className="text-[10px] text-slate-400">({w.settled})</span></td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-slate-500">{p.soloA?.winRate ?? '—'} / {p.soloB?.winRate ?? '—'}</td>
                    <td className={`px-4 py-2 text-right font-black ${lift == null ? 'text-slate-300' : lift > 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{lift == null ? '—' : `${lift > 0 ? '+' : ''}${lift}`}</td>
                    <td className="px-4 py-2 text-right font-mono">{p.moments}</td>
                  </tr>
                );
              }) : <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-400">{loading ? 'Loading…' : 'No pairs with enough shared signals yet — confluence data builds as the lab logs more.'}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <SectionLabel>Custom combo · pick 2–3 strategies to test together</SectionLabel>
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
        <div className="flex flex-wrap gap-1.5">
          {strategies.map((s) => {
            const on = combo.includes(s.id);
            return <button key={s.id} type="button" onClick={() => toggle(s.id)} className={`rounded-full border px-2.5 py-1 text-[11px] font-bold transition ${on ? 'border-indigo-500 bg-indigo-600 text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'} ${!on && combo.length >= 3 ? 'opacity-40' : ''}`}>{s.name}</button>;
          })}
        </div>
        {combo.length < 2 && <p className="mt-3 text-xs font-semibold text-slate-400">Select at least 2 strategies to see their combined win rate vs each alone — e.g. ICT Breaker + 3-Candle on gold.</p>}
        {combo.length >= 2 && data?.combo && (() => {
          const w = pickW(data.combo);
          return (
            <div className="mt-4 space-y-3">
              <div className="flex flex-wrap items-end gap-4 rounded-xl border border-indigo-200 bg-indigo-50/50 p-4">
                <div>
                  <div className="text-[10px] font-black uppercase text-indigo-500">When all {combo.length} agree</div>
                  <div className={`text-3xl font-black ${wrColor(w.winRate)}`}>{w.winRate === null ? '—' : `${w.winRate}%`}</div>
                  <div className="text-[11px] font-bold text-slate-500">{data.combo.moments} moments · {w.settled} scored</div>
                </div>
                <div className="flex-1 space-y-1">
                  {data.combo.solos.map((s) => { const sw = pickW(s); return (
                    <div key={s.id} className="flex items-center gap-2 text-[11px]">
                      <span className="w-44 truncate font-semibold text-slate-500">{s.name} alone</span>
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100"><div className={`h-full ${barColor(sw.winRate)}`} style={{ width: `${sw.winRate ?? 0}%` }} /></div>
                      <span className={`w-12 text-right font-bold ${wrColor(sw.winRate)}`}>{sw.winRate === null ? '—' : `${sw.winRate}%`}</span>
                    </div>
                  ); })}
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="w-44 truncate font-black text-indigo-700">All agree together</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100"><div className={`h-full ${barColor(w.winRate)}`} style={{ width: `${w.winRate ?? 0}%` }} /></div>
                    <span className={`w-12 text-right font-black ${wrColor(w.winRate)}`}>{w.winRate === null ? '—' : `${w.winRate}%`}</span>
                  </div>
                </div>
              </div>
              {data.combo.bySymbol.length > 0 && (
                <div>
                  <div className="mb-1 text-[10px] font-black uppercase tracking-wider text-slate-400">By symbol (all agree)</div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                    {data.combo.bySymbol.map((b) => { const bw = pickW(b); return (
                      <div key={b.symbol} className="rounded-lg border border-slate-200 p-2">
                        <div className="text-[11px] font-black text-slate-700">{b.symbol}</div>
                        <div className={`text-lg font-black ${wrColor(bw.winRate)}`}>{bw.winRate === null ? '—' : `${bw.winRate}%`}</div>
                        <div className="text-[9px] font-bold text-slate-400">{bw.settled} scored</div>
                      </div>
                    ); })}
                  </div>
                </div>
              )}
            </div>
          );
        })()}
      </div>
    </div>
  );
}

function RankTable({ title, sub, icon, colLabel, rows, keyOf, render, metric, minSample }: {
  title: string; sub: string; icon: React.ReactNode; colLabel: string;
  rows: (StrategyTfRow | StrategySymbolRow | StrategySessionRow | StrategyScoreRow)[];
  keyOf: (r: StrategyTfRow | StrategySymbolRow | StrategySessionRow | StrategyScoreRow) => string;
  render: (r: StrategyTfRow | StrategySymbolRow | StrategySessionRow | StrategyScoreRow) => React.ReactNode;
  metric: Metric; minSample: number;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-card overflow-hidden">
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
        {icon}
        <h3 className="text-sm font-black uppercase tracking-wider text-slate-500">{title}</h3>
        <span className="ml-1 text-[11px] font-semibold text-slate-400">{sub} · by {metricLabel(metric)} win%</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-100 text-[10px] uppercase tracking-[0.15em] text-slate-500">
            <tr>
              <th className="px-4 py-2 w-8">#</th>
              <th className="px-4 py-2">{colLabel}</th>
              <th className={`px-4 py-2 text-right ${metric === 'forex' ? 'text-slate-800' : ''}`}>Forex</th>
              <th className={`px-4 py-2 text-right ${metric === 'ftt' ? 'text-violet-600' : ''}`}>Fixed-time</th>
              <th className={`px-4 py-2 text-right ${metric === 'at' ? 'text-teal-600' : ''}`}>As-traded</th>
              <th className="px-4 py-2 text-right">Signals</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-slate-700">
            {rows.length ? rows.map((r, i) => (
              <tr key={keyOf(r)} className="hover:bg-slate-50/70">
                <td className="px-4 py-2 font-black text-slate-400">{i + 1}</td>
                <td className="px-4 py-2 font-black text-slate-800">{render(r)}</td>
                <td className="px-4 py-2"><div className="flex justify-end"><WinCell b={r.forex} minSample={minSample} bar={false} /></div></td>
                <td className="px-4 py-2"><div className="flex justify-end"><WinCell b={r.fixedTime} minSample={minSample} bar={false} /></div></td>
                <td className="px-4 py-2"><div className="flex justify-end"><WinCell b={r.asTraded} minSample={minSample} bar={false} /></div></td>
                <td className="px-4 py-2 text-right font-mono font-bold">{r.total}</td>
              </tr>
            )) : (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-sm font-medium text-slate-400">No data yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Per-strategy breakdown table (timeframe / symbol / session) with expectancy.
function BreakdownTable({ title, colLabel, rows, keyOf, render, minSample, loading }: {
  title: string; colLabel: string; rows: (StrategyTfRow | StrategySymbolRow | StrategySessionRow | StrategyScoreRow)[];
  keyOf: (r: StrategyTfRow | StrategySymbolRow | StrategySessionRow | StrategyScoreRow) => string;
  render: (r: StrategyTfRow | StrategySymbolRow | StrategySessionRow | StrategyScoreRow) => React.ReactNode;
  minSample: number; loading: boolean;
}) {
  return (
    <div>
      <div className="px-4 py-2.5 text-[11px] font-black uppercase tracking-wider text-slate-400">{title}</div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-y border-slate-100 text-[10px] uppercase tracking-[0.15em] text-slate-500">
            <tr>
              <th className="px-4 py-2">{colLabel}</th>
              <th className="px-4 py-2 text-right">Forex win%</th>
              <th className="px-4 py-2 text-right">Exp</th>
              <th className="px-4 py-2 text-right" title="Average signal risk-to-reward of the forex plans in this bucket.">RR</th>
              <th className="px-4 py-2 text-right">Fixed-time</th>
              <th className="px-4 py-2 text-right">As-traded</th>
              <th className="px-4 py-2 text-right">Signals</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-slate-700">
            {rows.length ? rows.map((r) => (
              <tr key={keyOf(r)} className="hover:bg-slate-50/70">
                <td className="px-4 py-2 font-bold">{render(r)}</td>
                <td className="px-4 py-2"><div className="flex justify-end"><WinCell b={r.forex} minSample={minSample} bar={false} /></div></td>
                <td className="px-4 py-2 text-right font-mono text-xs">{expLabel(r.forex)}</td>
                <td className="px-4 py-2 text-right font-mono text-xs font-bold text-slate-700">{rrLabel(r.forex)}</td>
                <td className="px-4 py-2"><div className="flex justify-end"><WinCell b={r.fixedTime} minSample={minSample} bar={false} /></div></td>
                <td className="px-4 py-2"><div className="flex justify-end"><WinCell b={r.asTraded} minSample={minSample} bar={false} /></div></td>
                <td className="px-4 py-2 text-right font-mono font-bold">{r.total}</td>
              </tr>
            )) : (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-sm font-medium text-slate-400">{loading ? 'Loading…' : 'No settled signals for this strategy yet.'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}


// One ranked mini-list (top strategies / symbols / timeframes) inside a session card.
function MiniRank<T extends AnyBucketRow & { total: number }>({ title, icon, rows, keyOf, render, metric, minSample, empty }: {
  title: string; icon: React.ReactNode; rows: T[];
  keyOf: (r: T) => string; render: (r: T) => React.ReactNode;
  metric: Metric; minSample: number; empty: string;
}) {
  const ranked = rankByMetric(rows, metric, minSample);
  return (
    <div className="overflow-hidden">
      <div className="flex items-center gap-1.5 px-4 py-2.5 text-[11px] font-black uppercase tracking-wider text-slate-400">{icon}{title}</div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-y border-slate-100 text-[10px] uppercase tracking-[0.15em] text-slate-500">
            <tr>
              <th className="px-3 py-2 w-7">#</th>
              <th className="px-3 py-2">{title.replace('Top ', '')}</th>
              <th className={`px-3 py-2 text-right ${metric === 'forex' ? 'text-slate-700' : ''}`}>Forex</th>
              <th className={`px-3 py-2 text-right ${metric === 'ftt' ? 'text-violet-600' : ''}`}>Fixed-time</th>
              <th className={`px-3 py-2 text-right ${metric === 'at' ? 'text-teal-600' : ''}`}>As-traded</th>
              <th className="px-3 py-2 text-right">Sig</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-slate-700">
            {ranked.length ? ranked.slice(0, 8).map((r, i) => (
              <tr key={keyOf(r)} className="hover:bg-slate-50/70">
                <td className="px-3 py-2 font-black text-slate-400">{i + 1}</td>
                <td className="px-3 py-2 font-bold text-slate-800">{render(r)}</td>
                <td className="px-3 py-2"><div className="flex justify-end"><WinCell b={r.forex} minSample={minSample} bar={false} /></div></td>
                <td className="px-3 py-2"><div className="flex justify-end"><WinCell b={r.fixedTime} minSample={minSample} bar={false} /></div></td>
                <td className="px-3 py-2"><div className="flex justify-end"><WinCell b={r.asTraded} minSample={minSample} bar={false} /></div></td>
                <td className="px-3 py-2 text-right font-mono font-bold">{r.total}</td>
              </tr>
            )) : (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-[12px] font-medium text-slate-400">{empty}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Session tabs + 3 ranked mini-lists (top strategies / symbols / timeframes) for the picked
// session. Each row shows BOTH forex & fixed-time win rates; the active metric drives the order.
function SessionBreakdownSection({ data, metric, minSample, query, loading }: {
  data: StrategySessionBreakdown[]; metric: Metric; minSample: number; query: string; loading: boolean;
}) {
  const [tab, setTab] = useState('');
  useEffect(() => {
    if (!data.length) return;
    setTab((cur) => (data.some((d) => d.session === cur) ? cur : data[0].session));
  }, [data]);
  if (!data.length) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white px-4 py-8 text-center text-sm font-medium text-slate-400 shadow-card">
        {loading ? 'Loading…' : 'No session data yet — populates as the lab scans and outcomes resolve.'}
      </div>
    );
  }
  const active = data.find((d) => d.session === tab) || data[0];
  const strategyRows = active.byStrategy.filter((s) => matchq(query, s.name, s.id));
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-card overflow-hidden">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-100 px-3 py-2.5">
        <Globe size={15} className="mr-1 text-violet-500" />
        {data.map((d) => {
          const on = d.session === active.session;
          return (
            <button key={d.session} type="button" onClick={() => setTab(d.session)} title={d.bdRange}
              className={`rounded-lg px-3 py-1 text-xs font-bold transition ${on ? 'bg-violet-600 text-white' : 'text-slate-500 hover:bg-slate-100'}`}>
              {d.sessionLabel}
            </button>
          );
        })}
        <span className="ml-auto text-[11px] font-semibold text-slate-400">{active.bdRange} · ranked by {metricLabel(metric)} win%</span>
      </div>
      <div className="grid grid-cols-1 gap-0 lg:grid-cols-3 lg:divide-x lg:divide-slate-100">
        <MiniRank<StrategySessionStrategyRow> title="Top strategies" icon={<Award size={13} className="text-amber-500" />} rows={strategyRows}
          keyOf={(r) => r.id} render={(r) => r.name} metric={metric} minSample={minSample}
          empty={query ? `No strategies match “${query}”.` : 'No data.'} />
        <MiniRank<StrategySymbolRow> title="Top symbols" icon={<Coins size={13} className="text-amber-500" />} rows={active.bySymbol}
          keyOf={(r) => r.symbol} render={(r) => r.symbol} metric={metric} minSample={minSample} empty="No data." />
        <MiniRank<StrategyTfRow> title="Top timeframes" icon={<Clock size={13} className="text-blue-500" />} rows={active.byTimeframe}
          keyOf={(r) => r.timeframe} render={(r) => r.timeframe} metric={metric} minSample={minSample} empty="No data." />
      </div>
    </div>
  );
}
