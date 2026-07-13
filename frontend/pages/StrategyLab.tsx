import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, FlaskConical, TrendingUp, TrendingDown, BarChart3, Timer, Hourglass, Mail, Radio, Check, ChevronDown } from 'lucide-react';
import { Link } from 'react-router-dom';
import { fetchStrategies, fetchStrategySignals, fetchStrategyLive, fetchStrategyLiveFtt } from '../mt5Api';
import type { StrategyMeta, StrategySignal, StrategyLiveResponse, StrategyLiveRow, StrategyFttLiveResponse, StrategyFttLiveRow } from '../types';

const REFRESH_MS = 30000;
const FAST_REFRESH_MS = 10000; // live fixed-time grid on fast timeframes (M1/M5) — see the poll effect
const LIVE_TFS = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];
// Score-bucket filter for the recent tables.
const SCORE_BUCKETS: { key: string; label: string }[] = [
  { key: '', label: 'All scores' },
  { key: '60-75', label: '60–75' },
  { key: '75-80', label: '75–80' },
  { key: '80-85', label: '80–85' },
  { key: '85-90', label: '85–90' },
  { key: '90+', label: '90+' },
];
function inScoreBucket(score: number | null | undefined, key: string): boolean {
  if (!key) return true;
  const v = Number(score);
  if (!Number.isFinite(v)) return false;
  if (key === '90+') return v >= 90;
  const [lo, hi] = key.split('-').map(Number);
  return v >= lo && v < hi;
}
const num = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));
// Full PRICE precision — every decimal as stored (e.g. 1.10952), no capping. toPrecision(12)
// strips floating-point noise (1.1095200000000001) before String() drops trailing zeros. The
// `symbol` arg is unused (kept for call-site stability / future per-symbol tweaks).
const px = (v: number | null | undefined, _symbol?: string) => {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  return Number.isFinite(n) ? String(Number(n.toPrecision(12))) : '—';
};

type Tab = 'forex' | 'ftt';
type FilterOption = { value: string; label: string };

function MultiSelectFilter({ label, options, selected, onChange }: {
  label: string;
  options: FilterOption[];
  selected: string[];
  onChange: (values: string[]) => void;
}) {
  const selectedSet = new Set(selected);
  const summary = selected.length === 0 ? 'All' : selected.length === 1
    ? options.find((option) => option.value === selected[0])?.label || selected[0]
    : `${selected.length} selected`;
  const toggle = (value: string) => onChange(selectedSet.has(value)
    ? selected.filter((item) => item !== value)
    : [...selected, value]);

  return (
    <details className="group relative">
      <summary className={`flex cursor-pointer list-none items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-bold transition marker:hidden [&::-webkit-details-marker]:hidden ${selected.length ? 'border-violet-300 bg-violet-50 text-violet-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}>
        <span className="text-[10px] uppercase tracking-wide text-slate-400">{label}</span>
        <span className="max-w-[150px] truncate">{summary}</span>
        <ChevronDown size={12} className="text-slate-400 transition group-open:rotate-180" />
      </summary>
      <div className="absolute left-0 top-full z-50 mt-1 w-64 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
          <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">{label}</span>
          <button type="button" onClick={() => onChange([])} className="text-[10px] font-bold text-violet-600 hover:text-violet-800">Select all</button>
        </div>
        <div className="max-h-64 overflow-y-auto p-1.5">
          {options.map((option) => {
            const checked = selectedSet.has(option.value);
            return (
              <label key={option.value} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">
                <input type="checkbox" checked={checked} onChange={() => toggle(option.value)} className="sr-only" />
                <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${checked ? 'border-violet-600 bg-violet-600 text-white' : 'border-slate-300 bg-white'}`}>
                  {checked && <Check size={11} strokeWidth={3} />}
                </span>
                <span className="truncate">{option.label}</span>
              </label>
            );
          })}
        </div>
      </div>
    </details>
  );
}

function outcomeChip(o: string) {
  const s = (o || '').toUpperCase();
  if (s.endsWith('_WIN') || s === 'WIN') return 'bg-emerald-50 text-emerald-700';
  if (s === 'LOSS') return 'bg-rose-50 text-rose-700';
  if (s === 'PENDING') return 'bg-blue-50 text-blue-600';
  if (s === 'DRAW' || s === 'AMBIGUOUS') return 'bg-amber-50 text-amber-700';
  return 'bg-slate-100 text-slate-400';
}

// ENTRY / HOLD / NO-DATA command pill (same vocabulary as the fixed-time scan).
function CommandPill({ row }: { row: StrategyLiveRow }) {
  if (row.command === 'ENTRY') {
    const buy = /BUY/.test(row.direction || '');
    return <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-black ${buy ? 'bg-emerald-600 text-white' : 'bg-rose-600 text-white'}`}>{buy ? <TrendingUp size={12} /> : <TrendingDown size={12} />} ENTRY {buy ? 'BUY' : 'SELL'}</span>;
  }
  if (row.command === 'HOLD') return <span className="inline-flex rounded-md px-2 py-0.5 text-[11px] font-black bg-slate-100 text-slate-500">HOLD · NO TRADE</span>;
  return <span className="inline-flex rounded-md px-2 py-0.5 text-[11px] font-black bg-slate-50 text-slate-300">NO DATA</span>;
}

// CALL UP / CALL DOWN / HOLD pill for the fixed-time scan.
function FttCommandPill({ row }: { row: StrategyFttLiveRow }) {
  if (row.command === 'CALL') {
    const up = row.direction === 'UP';
    return <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-black ${up ? 'bg-emerald-600 text-white' : 'bg-rose-600 text-white'}`}>{up ? <TrendingUp size={12} /> : <TrendingDown size={12} />} CALL {up ? 'UP' : 'DOWN'}</span>;
  }
  if (row.command === 'HOLD') return <span className="inline-flex rounded-md px-2 py-0.5 text-[11px] font-black bg-slate-100 text-slate-500">HOLD · NO CALL</span>;
  return <span className="inline-flex rounded-md px-2 py-0.5 text-[11px] font-black bg-slate-50 text-slate-300">NO DATA</span>;
}

// Fixed-time trade-time cell. LEADS with the DURATION to set on the platform (e.g. "Set 5 min")
// — the number that actually matters for a time-based trade — then a live countdown of how much
// is left in the current bar (what to set if you enter right now). Ticks every second locally.
function ExpiryCountdown({ iso, tradeTime, label }: { iso: string | null | undefined; tradeTime?: string | null; label?: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!iso) return <span className="text-slate-300">—</span>;
  const secs = Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000));
  const mm = Math.floor(secs / 60);
  const ss = secs % 60;
  const cls = secs <= 30 ? 'bg-rose-100 text-rose-700' : secs <= 120 ? 'bg-amber-100 text-amber-700' : 'bg-blue-50 text-blue-600';
  return (
    <div className="min-w-[140px]">
      {tradeTime && (
        <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-black bg-violet-600 text-white" title="Trade time to set on your fixed-time / binary platform. Enter as the candle opens so the expiry lines up with the candle close.">
          <Timer size={11} /> Set {tradeTime}
        </span>
      )}
      <p className="mt-0.5 flex items-center gap-1 text-[10px] font-bold text-slate-500 leading-tight">
        <Hourglass size={10} className={secs <= 30 ? 'text-rose-500' : secs <= 120 ? 'text-amber-500' : 'text-blue-500'} />
        <span className={`rounded px-1 ${cls}`}>{mm}:{String(ss).padStart(2, '0')}</span> left in bar
      </p>
      {label && <p className="mt-0.5 text-[10px] font-medium text-slate-400 leading-tight">{label}</p>}
    </div>
  );
}

// Entry-timing column: wait for the limit, take it now, or it's expired & gone.
function TimingCell({ timing }: { timing: import('../types').StrategyTiming | undefined }) {
  if (!timing) return <span className="text-slate-300">—</span>;
  const map: Record<string, { cls: string; label: string }> = {
    WAIT: { cls: 'bg-amber-100 text-amber-700', label: '⏳ WAIT' },
    TRADABLE: { cls: 'bg-emerald-100 text-emerald-700', label: '✅ TRADABLE NOW' },
    FILLED: { cls: 'bg-blue-100 text-blue-700', label: 'FILLED' },
    EXPIRED: { cls: 'bg-slate-100 text-slate-400', label: '✖ EXPIRED & GONE' },
    SETTLED: { cls: 'bg-blue-50 text-blue-600', label: 'DONE' },
  };
  const m = map[timing.status] || map.SETTLED;
  return (
    <div className="min-w-[150px]">
      <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-black ${m.cls}`}>{m.label}</span>
      <p className="mt-0.5 text-[10px] font-medium text-slate-400 leading-tight" title={timing.message}>{timing.message}</p>
    </div>
  );
}

// Fixed-time entry read from the last ~5 candles: does the immediate price action confirm
// the call right now (ENTER NOW), is it stretched/indecisive (WAIT FOR PULLBACK), or
// reversing against it (NO ENTRY)? The note shows the momentum count + candle pattern +
// whether price is at a local high/low — the things that flip a next-candle bet.
function CandleReadCell({ read }: { read?: import('../types').StrategyFttLiveRow['candleRead'] }) {
  if (!read) return <span className="text-slate-300">—</span>;
  const map = {
    ENTER_NOW: { cls: 'bg-emerald-100 text-emerald-700', label: '✅ ENTER NOW' },
    WAIT_PULLBACK: { cls: 'bg-amber-100 text-amber-700', label: '⏳ WAIT FOR PULLBACK' },
    NO_ENTRY: { cls: 'bg-rose-100 text-rose-700', label: '✖ NO ENTRY' },
  } as const;
  const m = map[read.verdict] || map.WAIT_PULLBACK;
  return (
    <div className="min-w-[150px]">
      <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-black ${m.cls}`}>{m.label}</span>
      <p className="mt-0.5 text-[10px] font-medium text-slate-400 leading-tight" title={`momentum ${read.momentum}${read.pattern ? ` · ${read.pattern}` : ''}`}>{read.note}</p>
    </div>
  );
}

function scoreBadge(score: number | null | undefined, grade: string | null | undefined) {
  if (score === null || score === undefined) return <span className="text-slate-300">—</span>;
  const cls = score >= 85 ? 'bg-emerald-100 text-emerald-700' : score >= 75 ? 'bg-emerald-50 text-emerald-600' : score >= 65 ? 'bg-blue-50 text-blue-600' : 'bg-slate-100 text-slate-500';
  return <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-black ${cls}`}>{Math.round(score)}{grade ? ` ${grade}` : ''}</span>;
}

// Score EVOLUTION: the first-call score is the honest basis; when a later re-evaluation of the
// same signal bar changed the quality, show first → latest with the drift direction coloured
// (↗ improved, ↘ degraded). Unchanged signals render the plain badge. Used by the recent
// tables (first = frozen DB score, latest = latest_score) AND the live grids (first = DB
// first-call score, latest = the live evaluation happening right now).
function ScoreEvolution({ first, firstGrade, latest, latestGrade, updatedAt }: {
  first: number | null | undefined; firstGrade?: string | null;
  latest: number | null | undefined; latestGrade?: string | null; updatedAt?: string | null;
}) {
  const changed = first != null && latest != null && Math.round(first) !== Math.round(latest);
  if (!changed) return scoreBadge(latest ?? first, latestGrade ?? firstGrade);
  const up = (latest as number) > (first as number);
  const updAt = updatedAt ? new Date(updatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : 'now';
  return (
    <span className="inline-flex items-center gap-0.5 whitespace-nowrap" title={`Called at ${Math.round(first as number)} (${firstGrade || '—'}) → re-evaluated to ${Math.round(latest as number)} (${latestGrade || firstGrade || '—'}) at ${updAt}`}>
      <span className="rounded bg-slate-100 px-1 py-0.5 text-[10px] font-bold text-slate-400 line-through decoration-slate-400/70">{Math.round(first as number)}</span>
      <span className={`text-[11px] font-black ${up ? 'text-emerald-600' : 'text-rose-500'}`}>{up ? '↗' : '↘'}</span>
      {scoreBadge(latest, latestGrade ?? firstGrade)}
    </span>
  );
}

// Signal-time cell: WHEN the signal was made, plus — only when the quality was re-evaluated
// afterwards — when it was last updated. The freshness / quality-drift read at a glance.
function SignalTimeCell({ signalTime, scoreUpdatedAt }: { signalTime?: string | null; scoreUpdatedAt?: string | null }) {
  return (
    <div className="whitespace-nowrap text-[11px] leading-tight">
      <div className="text-slate-500" title="When the signal was first made">{signalTime ? new Date(signalTime).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</div>
      {scoreUpdatedAt && (
        <div className="font-bold text-amber-600" title={`Quality re-evaluated ${new Date(scoreUpdatedAt).toLocaleString()}`}>
          ↻ upd {new Date(scoreUpdatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        </div>
      )}
    </div>
  );
}

// Tracking chips — was the call surfaced by the system (popup) and/or sent by email.
function SourceChips({ popupSent, emailSent }: { popupSent?: boolean | null; emailSent?: boolean | null }) {
  if (popupSent == null && emailSent == null) return <span className="text-[10px] text-slate-300">—</span>;
  return (
    <div className="flex items-center gap-1">
      <span className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-black ${popupSent ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-400'}`} title={popupSent ? 'Tracked by system (live popup)' : 'No popup'}><Radio size={9} /> SYS</span>
      <span className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-black ${emailSent ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-400'}`} title={emailSent ? 'Sent by email' : 'Not emailed'}><Mail size={9} /> MAIL</span>
    </div>
  );
}

// Combined live/settled cell for a fixed-time call: a pulsing green/red LIVE pill while
// PENDING (current position), or the final WIN/LOSS/DRAW + pips once settled.
function FtResultCell({ s }: { s: StrategySignal }) {
  if (s.live) {
    const st = s.live.status;
    const pillCls = st === 'WINNING' ? 'bg-emerald-100 text-emerald-700' : st === 'LOSING' ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-500';
    const dotCls = st === 'WINNING' ? 'bg-emerald-500' : st === 'LOSING' ? 'bg-rose-500' : 'bg-slate-400';
    const priceCls = st === 'WINNING' ? 'text-emerald-600' : st === 'LOSING' ? 'text-rose-600' : 'text-slate-500';
    return (
      <div className="min-w-[150px]">
        <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-black ${pillCls}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${dotCls} animate-pulse`} /> LIVE {s.live.pips > 0 ? '+' : ''}{s.live.pips}p
        </span>
        <p className="mt-0.5 font-mono text-[10px] text-slate-400">{num(s.live.reference)} → <span className={priceCls}>{num(s.live.currentPrice)}</span></p>
      </div>
    );
  }
  const atSettled = s.atOutcome && ['WIN', 'LOSS', 'DRAW'].includes(s.atOutcome);
  return (
    <div className="min-w-[150px] space-y-0.5">
      <div className="flex items-center gap-1">
        <span className="w-8 text-[8px] font-black uppercase text-slate-400" title="Idealized: signal-bar close → next-bar close. Measures the strategy's edge with no execution-timing noise.">Ideal</span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${outcomeChip(s.ftOutcome)}`}>{s.ftOutcome}</span>
        {s.ftPips !== null && <span className={`font-mono text-[11px] font-bold ${s.ftPips >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{s.ftPips > 0 ? '+' : ''}{s.ftPips}p</span>}
        {s.ftActionable === false && <span className="rounded px-1 py-0.5 text-[9px] font-black bg-amber-50 text-amber-600" title="Surfaced after its expiry candle had closed — result is real but it wasn't tradable as a fixed-time call, so it's excluded from the tradable win-rate.">LATE</span>}
      </div>
      {atSettled && (
        <div className="flex items-center gap-1">
          <span className="w-8 text-[8px] font-black uppercase text-violet-500" title="As-traded: entered at the LIVE price when the signal fired, expired at signal_time + the set duration. The realistic result.">Real</span>
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${outcomeChip(s.atOutcome as string)}`}>{s.atOutcome}</span>
          {s.atPips != null && <span className={`font-mono text-[11px] font-bold ${s.atPips >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{s.atPips > 0 ? '+' : ''}{s.atPips}p</span>}
          {s.atGapPips != null && s.atGapPips !== 0 && <span className={`text-[9px] font-bold ${s.atGapPips < 0 ? 'text-rose-400' : 'text-emerald-500'}`} title="Gap vs idealized = cost of the signal→entry delay">Δ{s.atGapPips > 0 ? '+' : ''}{s.atGapPips}</span>}
        </div>
      )}
    </div>
  );
}

// Strategy switcher for a live grid — one chip per strategy. Multi-select: click to add a
// strategy to the view, click again to remove it. Pick one to view it alone, or two+ to see
// their signals side by side (the grid then shows a Strategy column). At least one stays on.
function StrategyChips({ list, selectedIds, onToggle }: { list: StrategyMeta[]; selectedIds: string[]; onToggle: (id: string) => void }) {
  if (!list.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mr-0.5">Strategies</span>
      {list.map((s) => {
        const on = selectedIds.includes(s.id);
        return (
          <button key={s.id} type="button" onClick={() => onToggle(s.id)} aria-pressed={on}
            className={`rounded-full px-2.5 py-1 text-[11px] font-bold transition ${on ? 'bg-violet-600 text-white shadow-sm' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
            {on ? '✓ ' : ''}{s.name}
          </button>
        );
      })}
    </div>
  );
}

// Score + setup (direction) filters shared by both live grids. dir: '' = all, LONG = buy/up,
// SHORT = sell/down. mode picks the wording (forex Buy/Sell vs fixed-time Up/Down).
function GridFilters({ minScore, setMinScore, dir, setDir, mode }: { minScore: number; setMinScore: (n: number) => void; dir: string; setDir: (d: string) => void; mode: 'forex' | 'ftt' }) {
  return (
    <div className="flex items-center gap-2">
      <select value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} title="Minimum score" className="rounded-lg border border-slate-200 px-2 py-1 text-xs font-semibold">
        <option value={0}>Any score</option>
        <option value={90}>Score ≥ 90</option>
        <option value={85}>Score ≥ 85</option>
        <option value={80}>Score ≥ 80</option>
        <option value={75}>Score ≥ 75</option>
        <option value={70}>Score ≥ 70</option>
        <option value={65}>Score ≥ 65</option>
      </select>
      <select value={dir} onChange={(e) => setDir(e.target.value)} title="Setup / direction" className="rounded-lg border border-slate-200 px-2 py-1 text-xs font-semibold">
        <option value="">All setups</option>
        <option value="LONG">{mode === 'ftt' ? 'Call UP ↑' : 'Buy / Long ↑'}</option>
        <option value="SHORT">{mode === 'ftt' ? 'Call DOWN ↓' : 'Sell / Short ↓'}</option>
      </select>
    </div>
  );
}

export default function StrategyLab() {
  const [strategies, setStrategies] = useState<StrategyMeta[]>([]);
  const [timeframes, setTimeframes] = useState<string[]>(LIVE_TFS);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]); // strategies shown in the live grids (multi-select)
  const [liveTf, setLiveTf] = useState('M15');
  const [histTfs, setHistTfs] = useState<string[]>([]);
  const [histStrategies, setHistStrategies] = useState<string[]>([]);
  const [scoreBuckets, setScoreBuckets] = useState<string[]>([]);
  const [symbolFilters, setSymbolFilters] = useState<string[]>([]);
  const [showMuted, setShowMuted] = useState(false);    // reveal strategies muted in the Strategy Controller
  const [tab, setTab] = useState<Tab>('forex');
  // Fixed-time tab hides forex-only strategies (e.g. LIL SWEEP-PRO+, Special Forex
  // Sniper) — they never produce FTT alerts, so listing them there is noise. On tab
  // switch, prune any selected/filtered strategy that isn't valid for the FTT view.
  const tabStrategies = useMemo(() => (tab === 'ftt' ? strategies.filter((s) => !s.forexOnly) : strategies), [strategies, tab]);
  useEffect(() => {
    if (tab !== 'ftt' || !strategies.length) return;
    const allowed = new Set(strategies.filter((s) => !s.forexOnly).map((s) => s.id));
    setSelectedIds((prev) => {
      const next = prev.filter((id) => allowed.has(id));
      if (next.length === prev.length) return prev;
      return next.length ? next : (allowed.size ? [allowed.values().next().value as string] : []);
    });
    setHistStrategies((prev) => prev.filter((id) => allowed.has(id)));
  }, [strategies, tab]);
  const [live, setLive] = useState<StrategyLiveResponse | null>(null);
  const [ftLive, setFtLive] = useState<StrategyFttLiveResponse | null>(null);
  const [signals, setSignals] = useState<StrategySignal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchStrategies().then((m) => {
      // Only show strategies that are ON in the Strategy Controller — a disabled strategy
      // disappears from the live grid, chips and dropdowns (manage it on the Settings page).
      const visible = (m.strategies || []).filter((s) => s.control?.enabled !== false);
      setStrategies(visible);
      if (m.timeframes?.length) setTimeframes(m.timeframes);
      if (m.symbols?.length) setSymbols(m.symbols);
      setSelectedIds((c) => c.length ? c : (visible[0]?.id ? [visible[0].id] : []));
    }).catch((e) => setError(e instanceof Error ? e.message : 'Failed to load strategies'));
  }, []);

  const stratName = useCallback((id: string) => strategies.find((s) => s.id === id)?.name || id, [strategies]);

  // Toggle a strategy in/out of the live-grid view; never let the last one be removed.
  const toggleStrategy = useCallback((id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? (prev.length > 1 ? prev.filter((x) => x !== id) : prev) : [...prev, id]));
  }, []);

  // Live grids merge every SELECTED strategy (one fetch each, tagged with its name).
  const loadLive = useCallback(async () => {
    if (!selectedIds.length) return;
    const ids = selectedIds;
    try {
      if (tab === 'ftt') {
        const results = await Promise.all(ids.map((id) => fetchStrategyLiveFtt(id, liveTf).then((r) => ({ id, r })).catch(() => null)));
        const rows: StrategyFttLiveResponse['rows'] = [];
        let expiryBars = 1; let strategyName = '';
        for (const item of results) { if (!item) continue; expiryBars = item.r.expiryBars; strategyName = item.r.strategyName; for (const row of item.r.rows) rows.push({ ...row, strategyId: item.id, strategyName: item.r.strategyName }); }
        setFtLive({ ok: true, strategy: ids.join(','), strategyName, timeframe: liveTf, expiryBars, rows, generatedAt: new Date().toISOString() });
      } else {
        const results = await Promise.all(ids.map((id) => fetchStrategyLive(id, liveTf).then((r) => ({ id, r })).catch(() => null)));
        const rows: StrategyLiveResponse['rows'] = [];
        let strategyName = '';
        for (const item of results) { if (!item) continue; strategyName = item.r.strategyName; for (const row of item.r.rows) rows.push({ ...row, strategyId: item.id, strategyName: item.r.strategyName }); }
        setLive({ ok: true, strategy: ids.join(','), strategyName, timeframe: liveTf, rows, generatedAt: new Date().toISOString() });
      }
    } catch { /* live grid best-effort */ }
  }, [selectedIds, liveTf, tab]);

  // Load one broad history dataset; the four history controls combine client-side so
  // selecting several strategies/timeframes never causes serial API requests.
  const loadSignals = useCallback(async () => {
    try { const sg = await fetchStrategySignals(undefined, undefined, showMuted, 500); setSignals(sg.signals); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed to load strategy signals'); }
  }, [showMuted]);

  const loadData = useCallback(async () => {
    setLoading(true);
    await Promise.allSettled([loadLive(), loadSignals()]);
    setLoading(false);
  }, [loadLive, loadSignals]);

  // Initial load + immediate refresh whenever the selectors change (the Refresh button also
  // calls loadData). The periodic polling is handled by the two interval effects below.
  useEffect(() => { void loadData(); }, [loadData]);

  // Live grid poll — TIMEFRAME-AWARE: on the fixed-time tab viewing a fast timeframe (M1/M5)
  // a freshly-closed bar matters within seconds, so poll at FAST_REFRESH_MS (10s). Everywhere
  // else (forex tab, or M15+ where bars close slowly) stay at 30s to avoid wasted scans.
  useEffect(() => {
    const fast = tab === 'ftt' && (liveTf === 'M1' || liveTf === 'M5');
    const t = setInterval(() => void loadLive(), fast ? FAST_REFRESH_MS : REFRESH_MS);
    return () => clearInterval(t);
  }, [loadLive, tab, liveTf]);

  // Recent-signals poll — always the steady 30s cadence (one DB-backed query).
  useEffect(() => {
    const t = setInterval(() => void loadSignals(), REFRESH_MS);
    return () => clearInterval(t);
  }, [loadSignals]);

  const selectedMetas = useMemo(() => strategies.filter((s) => selectedIds.includes(s.id)), [strategies, selectedIds]);
  const multiStrategy = selectedIds.length > 1;
  const liveTitle = selectedMetas.length === 1 ? selectedMetas[0].name : `${selectedIds.length} strategies`;
  // Live-grid filters (apply to BOTH the forex and fixed-time live tables): minimum score +
  // setup direction. When a filter is active — or when more than one strategy is selected —
  // we show only the actionable rows that pass (HOLD/NO_DATA noise is hidden, which also
  // keeps the merged multi-strategy view readable); otherwise the grid shows every row.
  const [minScore, setMinScore] = useState(0);
  const [dirFilter, setDirFilter] = useState(''); // '' | 'LONG' | 'SHORT'
  const [actionableView, setActionableView] = useState(true); // default: hide HOLD noise, signals only
  const liveFilterActive = minScore > 0 || dirFilter !== '';
  const actionableOnly = actionableView || liveFilterActive || multiStrategy;
  // Rank helpers — ENTER-NOW / tradable rows always surface FIRST, then waiting, then the rest.
  const timingRank = (st?: string) => (st === 'TRADABLE' ? 0 : st === 'WAIT' ? 1 : 2);
  const readRank = (v?: string) => (v === 'ENTER_NOW' ? 0 : v === 'WAIT_PULLBACK' ? 1 : 2);
  const forexRows = useMemo(() => {
    const rows = (live?.rows || []).filter((r) => !actionableOnly || (r.command === 'ENTRY'
      && (minScore === 0 || (r.score ?? 0) >= minScore)
      && (!dirFilter || (dirFilter === 'LONG' ? /BUY/.test(r.direction || '') : /SELL/.test(r.direction || '')))));
    return [...rows].sort((a, b) =>
      (Number(b.command === 'ENTRY') - Number(a.command === 'ENTRY'))
      || (timingRank(a.timing?.status) - timingRank(b.timing?.status))
      || ((b.score ?? 0) - (a.score ?? 0)));
  }, [live, minScore, dirFilter, actionableOnly]);
  const ftRows = useMemo(() => {
    const rows = (ftLive?.rows || []).filter((r) => !actionableOnly || (r.command === 'CALL'
      && (minScore === 0 || (r.score ?? 0) >= minScore)
      && (!dirFilter || (dirFilter === 'LONG' ? r.direction === 'UP' : r.direction === 'DOWN'))));
    return [...rows].sort((a, b) =>
      (Number(b.command === 'CALL') - Number(a.command === 'CALL'))
      || (readRank(a.candleRead?.verdict) - readRank(b.candleRead?.verdict))
      || ((b.score ?? 0) - (a.score ?? 0)));
  }, [ftLive, minScore, dirFilter, actionableOnly]);
  const entries = forexRows.filter((r) => r.command === 'ENTRY');
  const calls = ftRows.filter((r) => r.command === 'CALL');
  const tradableNow = entries.filter((r) => r.timing?.status === 'TRADABLE').length;
  const enterNowCalls = calls.filter((r) => r.candleRead?.verdict === 'ENTER_NOW').length;
  const holdCount = tab === 'ftt'
    ? (ftLive?.rows.length || 0) - (ftLive?.rows || []).filter((r) => r.command === 'CALL').length
    : (live?.rows.length || 0) - (live?.rows || []).filter((r) => r.command === 'ENTRY').length;
  // Recent-table multi-filters apply to BOTH recent tables. Empty selection means all.
  const histSymbolOptions = useMemo(() => Array.from(new Set([...symbols, ...signals.map((s) => s.symbol)])).sort(), [symbols, signals]);
  const filteredSignals = useMemo(
    () => signals.filter((s) =>
      (!histStrategies.length || histStrategies.includes(s.strategy))
      && (!histTfs.length || histTfs.includes(s.timeframe))
      && (!symbolFilters.length || symbolFilters.includes(s.symbol))
      && (!scoreBuckets.length || scoreBuckets.some((bucket) => inScoreBucket(s.score, bucket)))),
    [signals, histStrategies, histTfs, symbolFilters, scoreBuckets],
  );
  // Recent tables: actionable-NOW first (forex TRADABLE limit / fixed-time LIVE open call),
  // then newest signal first.
  const sortedSignals = useMemo(() => filteredSignals
    .filter((s) => tab !== 'ftt' || s.ftOutcome !== null)
    .sort((a, b) => {
    const act = (s: StrategySignal) => (tab === 'ftt' ? Number(Boolean(s.live)) : Number(s.timing?.status === 'TRADABLE'));
    return (act(b) - act(a)) || (new Date(b.signalTime || 0).getTime() - new Date(a.signalTime || 0).getTime());
  }), [filteredSignals, tab]);
  // Fired fixed-time calls that are STILL within their expiry window — surfaced from the
  // logged-signal feed (all strategies/TFs, DB-backed → reload-safe) so every call that
  // fired a browser alert is visible in the signal portion, independent of the
  // strategy/timeframe selectors and the live re-evaluation (which drops one-candle calls).
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNowTick(Date.now()), 1000); return () => clearInterval(t); }, []);
  // High-quality gate for the "Just fired" panel: only A/A+ setups, scored 85+, on M15
  // and above (M1/M5 noise excluded). The full live grid below is unaffected.
  const HQ_TFS = new Set(['M15', 'M30', 'H1', 'H4', 'D1']);
  const liveCalls = useMemo(() => signals
    .filter((s) => (s.ftOutcome || '').toUpperCase() === 'PENDING' && s.ftExpiryIso && new Date(s.ftExpiryIso).getTime() > nowTick)
    .filter((s) => HQ_TFS.has((s.timeframe || '').toUpperCase())
      && (Number(s.score) || 0) >= 85
      && ['A', 'A+'].includes((s.grade || '').toUpperCase()))
    .sort((a, b) => new Date(a.ftExpiryIso || 0).getTime() - new Date(b.ftExpiryIso || 0).getTime()),
  [signals, nowTick]);
  // FILTER-AWARE header stats for the recent tables: computed from the rows currently
  // shown (strategy/TF/score/symbol filters applied), so the W/L and win% always describe
  // exactly what you're looking at. Four framings: forex settled (TP/SL), fixed-time ideal,
  // as-traded REAL, and live open positions.
  const tableStats = useMemo(() => {
    let fxW = 0, fxL = 0, ftW = 0, ftL = 0, atW = 0, atL = 0, liveW = 0, liveL = 0, pending = 0;
    for (const s of filteredSignals) {
      const fo = (s.outcome || '').toUpperCase();
      if (fo.endsWith('_WIN') || fo === 'WIN') fxW += 1; else if (fo === 'LOSS') fxL += 1;
      const ft = (s.ftOutcome || '').toUpperCase();
      if (ft === 'WIN') ftW += 1; else if (ft === 'LOSS') ftL += 1; else if (ft === 'PENDING') pending += 1;
      const at = (s.atOutcome || '').toUpperCase();
      if (at === 'WIN') atW += 1; else if (at === 'LOSS') atL += 1;
      if (s.live) { if (s.live.status === 'WINNING') liveW += 1; else if (s.live.status === 'LOSING') liveL += 1; }
    }
    const pct = (w: number, l: number) => (w + l > 0 ? Math.round((w / (w + l)) * 100) : null);
    return { fxW, fxL, fxPct: pct(fxW, fxL), ftW, ftL, ftPct: pct(ftW, ftL), atW, atL, atPct: pct(atW, atL), liveW, liveL, pending };
  }, [filteredSignals]);
  // Compact stat chip: label + W/L + win% — tone follows the win rate.
  const statChip = (label: string, w: number, l: number, pctv: number | null, title: string) => (
    <span title={title} className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-black ${pctv === null ? 'bg-slate-100 text-slate-400' : pctv >= 55 ? 'bg-emerald-50 text-emerald-700' : pctv >= 45 ? 'bg-blue-50 text-blue-600' : 'bg-rose-50 text-rose-600'}`}>
      <span className="font-bold uppercase tracking-wide opacity-70">{label}</span>
      <span className="text-emerald-600">{w}W</span>/<span className="text-rose-500">{l}L</span>
      {pctv !== null && <span>· {pctv}%</span>}
    </span>
  );
  const headerStatChips = (
    <div className="flex flex-wrap items-center gap-1">
      {statChip('Forex', tableStats.fxW, tableStats.fxL, tableStats.fxPct, 'Forex settled (TP hit vs SL) in the filtered rows')}
      {statChip('Fixed', tableStats.ftW, tableStats.ftL, tableStats.ftPct, 'Fixed-time IDEAL outcome (signal-bar close → next-bar close) in the filtered rows')}
      {statChip('Real', tableStats.atW, tableStats.atL, tableStats.atPct, 'As-traded / REAL outcome (live entry at signal time, set duration) in the filtered rows')}
      {(tableStats.liveW > 0 || tableStats.liveL > 0) && (
        <span className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-1.5 py-0.5 text-[10px] font-black text-white" title="Open fixed-time calls right now: currently winning / losing">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> LIVE {tableStats.liveW}▲ {tableStats.liveL}▼
        </span>
      )}
    </div>
  );
  const historyFiltersActive = histStrategies.length + histTfs.length + scoreBuckets.length + symbolFilters.length > 0;
  const historyFilters = (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-0.5 text-[10px] font-black uppercase tracking-wider text-slate-400">Filter history</span>
      <MultiSelectFilter
        label="Strategy"
        options={tabStrategies.map((strategy) => ({ value: strategy.id, label: strategy.name }))}
        selected={histStrategies}
        onChange={setHistStrategies}
      />
      <MultiSelectFilter
        label="Timeframe"
        options={timeframes.map((timeframe) => ({ value: timeframe, label: timeframe }))}
        selected={histTfs}
        onChange={setHistTfs}
      />
      <MultiSelectFilter
        label="Score"
        options={SCORE_BUCKETS.filter((bucket) => bucket.key).map((bucket) => ({ value: bucket.key, label: bucket.label }))}
        selected={scoreBuckets}
        onChange={setScoreBuckets}
      />
      <MultiSelectFilter
        label="Symbol"
        options={histSymbolOptions.map((symbol) => ({ value: symbol, label: symbol }))}
        selected={symbolFilters}
        onChange={setSymbolFilters}
      />
      {historyFiltersActive && (
        <button type="button" onClick={() => { setHistStrategies([]); setHistTfs([]); setScoreBuckets([]); setSymbolFilters([]); }} className="rounded-lg px-2 py-1.5 text-[11px] font-bold text-rose-500 hover:bg-rose-50">
          Clear filters
        </button>
      )}
      <button type="button" onClick={() => setShowMuted((value) => !value)} title="Muted strategies are hidden by default" className={`rounded-lg border px-2 py-1.5 text-xs font-bold transition-colors ${showMuted ? 'border-gold-500 bg-gold-50 text-gold-700' : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'}`}>{showMuted ? 'Incl. muted' : 'Active only'}</button>
    </div>
  );

  return (
    <div className="space-y-3 pb-8">
      {/* ── STICKY COMMAND BAR: tabs · filters · strategies · refresh — always reachable.
           Negative margins consume <main>'s padding so the bar sits flush under the topbar
           with a SOLID background: scrolling content can never peek through above it. ── */}
      <div className="sticky top-0 z-30 -mx-6 bg-slate-50 px-6 pb-1.5 pt-1.5 shadow-[0_10px_14px_-14px_rgba(15,23,42,0.25)] lg:-mx-10 lg:px-10">
        <div className="rounded-2xl border border-slate-200 bg-white px-3 py-2 shadow-card">
          {/* Row 1 — identity, tabs, refresh */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2">
              <FlaskConical className="text-violet-600" size={18} />
              <h1 className="text-sm font-black text-slate-900">Strategy Lab</h1>
            </div>
            <div className="flex items-center gap-0.5 rounded-lg border border-slate-200 bg-slate-50 p-0.5">
              <button type="button" onClick={() => setTab('forex')} className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-bold transition ${tab === 'forex' ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-white'}`}>
                <TrendingUp size={12} /> Forex
              </button>
              <button type="button" onClick={() => setTab('ftt')} className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-bold transition ${tab === 'ftt' ? 'bg-violet-600 text-white' : 'text-slate-500 hover:bg-white'}`}>
                <Timer size={12} /> Fixed-Time
              </button>
            </div>
            {/* Actionable summary — the numbers that matter, always visible */}
            {tab === 'forex' ? (
              <div className="flex items-center gap-1.5 text-[10px] font-black">
                <span className={`rounded-md px-2 py-1 ${tradableNow ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-400'}`}>{tradableNow} ENTER NOW</span>
                <span className="rounded-md bg-amber-50 px-2 py-1 text-amber-600">{entries.length - tradableNow} WAIT</span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 text-[10px] font-black">
                <span className={`rounded-md px-2 py-1 ${enterNowCalls ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-400'}`}>{enterNowCalls} ENTER NOW</span>
                <span className="rounded-md bg-amber-50 px-2 py-1 text-amber-600">{calls.length - enterNowCalls} WAIT</span>
              </div>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              <Link to="/strategy-lab/reports" className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50"><BarChart3 size={13} /> Reports</Link>
              <button type="button" onClick={() => void loadData()} disabled={loading} className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-bold text-white hover:bg-slate-700 disabled:opacity-50">
                {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Refresh
              </button>
            </div>
          </div>
          {/* Row 2 — live-grid filters */}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-1.5">
            <select value={liveTf} onChange={(e) => setLiveTf(e.target.value)} className="rounded-lg border border-slate-200 px-2 py-1 text-xs font-semibold" title="Live grid timeframe">
              <option value="ALL">All TFs (live)</option>
              {timeframes.map((t) => <option key={t} value={t}>{t} live</option>)}
            </select>
            <GridFilters minScore={minScore} setMinScore={setMinScore} dir={dirFilter} setDir={setDirFilter} mode={tab} />
            <button type="button" onClick={() => setActionableView((v) => !v)} title="Hide/show HOLD rows in the live grid"
              className={`rounded-lg border px-2 py-1 text-xs font-bold transition ${actionableView ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'}`}>
              {actionableView ? '● Signals only' : `○ All rows (+${holdCount} hold)`}
            </button>
          </div>
          {/* Row 3 — strategy chips */}
          <div className="mt-1.5 border-t border-slate-100 pt-1.5">
            <StrategyChips list={tabStrategies} selectedIds={selectedIds} onToggle={toggleStrategy} />
          </div>
        </div>
      </div>

      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm font-semibold text-rose-700">{error}</div>}

      {/* ───────────────────────── FOREX TAB ───────────────────────── */}
      {tab === 'forex' && (
        <>
          {/* LIVE COMMAND GRID — ENTER NOW first, then WAIT, then expired */}
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2">
              <h3 className="text-xs font-black uppercase tracking-wider text-slate-500">Live signals · {liveTitle} · {liveTf}</h3>
              <span className="text-[11px] font-bold text-slate-400">{entries.length} signal{entries.length === 1 ? '' : 's'}{actionableOnly ? '' : ` · ${holdCount} hold`} · sorted: tradable first · auto-refresh 30s</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[920px] text-left text-sm">
                <thead className="border-b border-slate-100 text-[10px] uppercase tracking-[0.15em] text-slate-500">
                  <tr>
                    <th className="px-3 py-1.5">Command</th>
                    {multiStrategy && <th className="px-3 py-1.5">Strategy</th>}
                    <th className="px-3 py-1.5">Entry timing</th>
                    <th className="px-3 py-1.5">Symbol</th>
                    <th className="px-3 py-1.5 text-right">Score</th>
                    <th className="px-3 py-1.5">Signal time</th>
                    <th className="px-3 py-1.5 text-right">Lots</th>
                    <th className="px-3 py-1.5 text-right">Entry / Stop</th>
                    <th className="px-3 py-1.5 text-right">TP1 / TP2 / TP3</th>
                    <th className="px-3 py-1.5 text-right">RR</th>
                    <th className="px-3 py-1.5">Why</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {forexRows.length ? forexRows.map((r) => {
                    const tradable = r.command === 'ENTRY' && r.timing?.status === 'TRADABLE';
                    const rowTint = tradable
                      ? 'bg-emerald-50/70 shadow-[inset_3px_0_0_#059669]'
                      : r.command === 'ENTRY' ? (/BUY/.test(r.direction || '') ? 'bg-emerald-50/25' : 'bg-rose-50/25') : '';
                    return (
                      <tr key={`${r.strategyId || ''}-${r.symbol}-${r.timeframe}`} className={`hover:bg-slate-50/70 ${rowTint}`}>
                        <td className="px-3 py-1.5"><CommandPill row={r} /></td>
                        {multiStrategy && <td className="whitespace-nowrap px-3 py-1.5 text-[11px] font-bold text-violet-700">{r.strategyName || stratName(r.strategyId || '')}</td>}
                        <td className="px-3 py-1.5">{r.command === 'ENTRY' ? <TimingCell timing={r.timing} /> : <span className="text-slate-300">—</span>}</td>
                        <td className="px-3 py-1.5"><span className="font-black text-slate-900">{r.symbol}</span> <span className="text-[10px] font-bold text-slate-400">{r.timeframe}</span></td>
                        <td className="px-3 py-1.5 text-right">{r.command === 'ENTRY' ? <ScoreEvolution first={r.firstScore ?? r.score} firstGrade={r.firstGrade ?? r.grade} latest={r.score} latestGrade={r.grade} updatedAt={r.scoreUpdatedAt} /> : <span className="text-slate-300">—</span>}</td>
                        <td className="px-3 py-1.5">{r.command === 'ENTRY' ? <SignalTimeCell signalTime={r.signalTime ?? r.barIso} scoreUpdatedAt={r.scoreUpdatedAt} /> : <span className="text-slate-300">—</span>}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-[12px] font-black text-slate-900" title={r.command === 'ENTRY' && r.lossAtStop != null ? `Risk ${r.riskPercent ?? '?'}% · max loss $${r.lossAtStop} · ${r.stopPips ?? '?'} pip stop` : ''}>{r.command === 'ENTRY' && r.lots != null ? r.lots : '—'}</td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono text-[11px] leading-tight">
                          {r.command === 'ENTRY'
                            ? <><div>{px(r.entry, r.symbol)}</div><div className="text-rose-600">{px(r.stopLoss, r.symbol)}</div></>
                            : (r.price != null ? <span className="text-slate-400">{px(r.price, r.symbol)}</span> : '—')}
                        </td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono text-[11px] leading-tight text-emerald-600">
                          {r.command === 'ENTRY' ? <><div>{px(r.takeProfit1, r.symbol)} / {px(r.takeProfit2, r.symbol)}</div><div>{px(r.takeProfit3, r.symbol)}</div></> : '—'}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono">{r.command === 'ENTRY' && r.riskReward != null ? `1:${num(r.riskReward, 1)}` : '—'}</td>
                        <td className="min-w-[200px] max-w-[340px] whitespace-normal break-words px-3 py-1.5 align-top text-[11px] leading-snug text-slate-500" title={r.reason || ''}>{r.command === 'ENTRY' ? r.reason : ''}</td>
                      </tr>
                    );
                  }) : (
                    <tr><td colSpan={multiStrategy ? 11 : 10} className="px-3 py-8 text-center text-sm font-medium text-slate-400">{loading ? 'Loading…' : liveFilterActive ? 'No setups match the current score / setup filter.' : 'No live setups right now — the grid fills the moment a strategy fires.'}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="border-t border-slate-100 px-4 py-1.5 text-[11px] font-medium text-slate-400">
              <span className="font-bold text-emerald-600">Green-edged row</span> = tradable at the entry right now · ENTRY = a fresh {selectedMetas.length === 1 ? selectedMetas[0].name : 'strategy'} setup · isolated lab engine, not the main system.
            </div>
          </div>

          {/* RECENT SIGNALS — tradable-now pinned on top, then newest first */}
          <div className="relative rounded-2xl border border-slate-200 bg-white shadow-card">
            <div className="space-y-2 border-b border-slate-100 px-4 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-xs font-black uppercase tracking-wider text-slate-500">Recent signals &amp; outcomes <span className="text-[11px] font-bold text-slate-400">· {showMuted ? 'incl. muted' : 'active only'} · tradable pinned first</span></h3>
                <div className="flex flex-wrap items-center gap-2">
                  {headerStatChips}
                  <span className="text-[11px] font-bold text-slate-400">{sortedSignals.length} shown</span>
                </div>
              </div>
              {historyFilters}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1000px] text-left text-sm">
                <thead className="border-b border-slate-100 text-[10px] uppercase tracking-[0.15em] text-slate-500">
                  <tr>
                    <th className="px-3 py-1.5">Strategy</th>
                    <th className="px-3 py-1.5">Symbol</th><th className="px-3 py-1.5">Dir</th>
                    <th className="px-3 py-1.5 text-right">Score</th><th className="px-3 py-1.5 text-right">Lots</th>
                    <th className="px-3 py-1.5 text-right">Entry / SL</th>
                    <th className="px-3 py-1.5 text-right">TP1 · TP2 · TP3</th>
                    <th className="px-3 py-1.5 text-right">RR</th>
                    <th className="px-3 py-1.5">Forex</th><th className="px-3 py-1.5 text-right">Pips</th>
                    <th className="px-3 py-1.5">Fixed-time</th><th className="px-3 py-1.5">Signal time</th>
                    <th className="px-3 py-1.5">Entry timing</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {sortedSignals.length ? sortedSignals.map((s) => {
                    const tradable = s.timing?.status === 'TRADABLE';
                    return (
                      <tr key={s.id} className={`hover:bg-slate-50/70 ${tradable ? 'bg-emerald-50/60 shadow-[inset_3px_0_0_#059669]' : ''}`}>
                        <td className="whitespace-nowrap px-3 py-1.5 text-[11px] font-bold text-violet-700">{stratName(s.strategy)}</td>
                        <td className="px-3 py-1.5"><span className="font-black text-slate-900">{s.symbol}</span> <span className="text-[10px] font-bold text-slate-400">{s.timeframe}</span></td>
                        <td className="px-3 py-1.5">{/BUY/.test(s.direction) ? <span className="text-[12px] font-bold text-emerald-600">BUY</span> : <span className="text-[12px] font-bold text-rose-600">SELL</span>}</td>
                        <td className="px-3 py-1.5 text-right"><ScoreEvolution first={s.score} firstGrade={s.grade} latest={s.latestScore ?? s.score} latestGrade={s.latestGrade ?? s.grade} updatedAt={s.scoreUpdatedAt} /></td>
                        <td className="px-3 py-1.5 text-right font-mono text-[12px] font-black text-slate-900" title={s.lossAtStop != null ? `max loss $${s.lossAtStop} · ${s.stopPips ?? '?'} pip stop` : ''}>{s.lots != null ? s.lots : '—'}</td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono text-[11px] leading-tight">
                          <div>{px(s.entryPrice, s.symbol)}</div>
                          <div className="text-rose-500">{px(s.stopLoss, s.symbol)}</div>
                        </td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono text-[11px] leading-tight text-emerald-600">
                          <div>{px(s.takeProfit1, s.symbol)} · {px(s.takeProfit2, s.symbol)}</div>
                          <div>{px(s.takeProfit3, s.symbol)}</div>
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono">{s.riskReward === null ? '—' : `1:${num(s.riskReward, 1)}`}</td>
                        <td className="px-3 py-1.5"><span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${outcomeChip(s.outcome)}`}>{s.outcome}{s.tpHitLevel ? ` (TP${s.tpHitLevel})` : ''}</span></td>
                        <td className="px-3 py-1.5 text-right font-mono text-[12px]">{s.profitLossPips === null ? '—' : <span className={s.profitLossPips >= 0 ? 'text-emerald-600' : 'text-rose-600'}>{s.profitLossPips > 0 ? '+' : ''}{s.profitLossPips}</span>}</td>
                        <td className="px-3 py-1.5"><span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${outcomeChip(s.ftOutcome)}`}>{s.ftOutcome}</span></td>
                        <td className="px-3 py-1.5"><SignalTimeCell signalTime={s.signalTime} scoreUpdatedAt={s.scoreUpdatedAt} /></td>
                        <td className="px-3 py-1.5"><TimingCell timing={s.timing} /></td>
                      </tr>
                    );
                  }) : (
                    <tr><td colSpan={13} className="px-3 py-8 text-center text-sm font-medium text-slate-400">{loading ? 'Loading…' : (signals.length ? 'No signals match the selected history filters.' : 'No signals logged yet.')}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ──────────────────────── FIXED-TIME TAB ──────────────────────── */}
      {tab === 'ftt' && (
        <>
          {/* LIVE FIXED-TIME CALL GRID — ENTER NOW first */}
          <div className="overflow-hidden rounded-2xl border border-violet-200 bg-white shadow-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-violet-100 bg-violet-50/40 px-4 py-2">
              <h3 className="text-xs font-black uppercase tracking-wider text-violet-700">Live fixed-time calls · {liveTitle} · {liveTf}</h3>
              <span className="text-[11px] font-bold text-slate-400">{calls.length} call{calls.length === 1 ? '' : 's'} · sorted: enter-now first · expiry {ftLive?.expiryBars === 1 ? 'next candle' : `${ftLive?.expiryBars} candles`} · auto-refresh {liveTf === 'M1' || liveTf === 'M5' ? '10s' : '30s'}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1000px] text-left text-sm">
                <thead className="border-b border-slate-100 text-[10px] uppercase tracking-[0.15em] text-slate-500">
                  <tr>
                    <th className="px-3 py-1.5">Call</th>
                    {multiStrategy && <th className="px-3 py-1.5">Strategy</th>}
                    <th className="px-3 py-1.5">Symbol</th>
                    <th className="px-3 py-1.5 text-right">Score</th>
                    <th className="px-3 py-1.5">Signal time</th>
                    <th className="px-3 py-1.5 text-right">Reference</th>
                    <th className="px-3 py-1.5">Trade time</th>
                    <th className="px-3 py-1.5">Entry read (last 5 candles)</th>
                    <th className="px-3 py-1.5">Why</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {ftRows.length ? ftRows.map((r) => {
                    const enterNow = r.command === 'CALL' && r.candleRead?.verdict === 'ENTER_NOW';
                    const rowTint = enterNow
                      ? 'bg-emerald-50/70 shadow-[inset_3px_0_0_#059669]'
                      : r.command === 'CALL' ? (r.direction === 'UP' ? 'bg-emerald-50/25' : 'bg-rose-50/25') : '';
                    return (
                      <tr key={`${r.strategyId || ''}-${r.symbol}-${r.timeframe}`} className={`hover:bg-slate-50/70 ${rowTint}`}>
                        <td className="px-3 py-1.5"><FttCommandPill row={r} /></td>
                        {multiStrategy && <td className="whitespace-nowrap px-3 py-1.5 text-[11px] font-bold text-violet-700">{r.strategyName || stratName(r.strategyId || '')}</td>}
                        <td className="px-3 py-1.5"><span className="font-black text-slate-900">{r.symbol}</span> <span className="text-[10px] font-bold text-slate-400">{r.timeframe}</span></td>
                        <td className="px-3 py-1.5 text-right">{r.command === 'CALL' ? <ScoreEvolution first={r.firstScore ?? r.score} firstGrade={r.firstGrade ?? r.grade} latest={r.score} latestGrade={r.grade} updatedAt={r.scoreUpdatedAt} /> : <span className="text-slate-300">—</span>}</td>
                        <td className="px-3 py-1.5">{r.command === 'CALL' ? <SignalTimeCell signalTime={r.signalTime ?? r.barIso} scoreUpdatedAt={r.scoreUpdatedAt} /> : <span className="text-slate-300">—</span>}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-[12px]">{r.reference != null ? num(r.reference) : '—'}</td>
                        <td className="px-3 py-1.5">{r.command === 'CALL' ? <ExpiryCountdown iso={r.expiryIso} tradeTime={r.tradeTimeLabel} /> : <span className="text-slate-300">—</span>}</td>
                        <td className="px-3 py-1.5">{r.command === 'CALL' ? <CandleReadCell read={r.candleRead} /> : <span className="text-slate-300">—</span>}</td>
                        <td className="min-w-[200px] max-w-[340px] whitespace-normal break-words px-3 py-1.5 align-top text-[11px] leading-snug text-slate-500" title={r.reason || ''}>{r.command === 'CALL' ? r.reason : ''}</td>
                      </tr>
                    );
                  }) : (
                    <tr><td colSpan={multiStrategy ? 9 : 8} className="px-3 py-8 text-center text-sm font-medium text-slate-400">{loading ? 'Loading…' : liveFilterActive ? 'No calls match the current score / setup filter.' : 'No live calls right now — the grid fills the moment a strategy fires.'}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="border-t border-slate-100 px-4 py-1.5 text-[11px] font-medium text-slate-400">
              <span className="font-bold text-emerald-600">Green-edged row</span> = entry read confirms ENTER NOW · <span className="font-bold text-violet-700">Trade time</span> = the expiry to set on your platform (enter as a new candle opens so expiry lines up with the close; entering mid-bar → set the "left in bar" time) · CALL UP / DOWN = price higher / lower than the reference at expiry close · isolated lab engine.
            </div>
          </div>

          {/* RECENT FIXED-TIME OUTCOMES — live calls pinned first, then newest */}
          <div className="relative rounded-2xl border border-slate-200 bg-white shadow-card">
            <div className="space-y-2 border-b border-slate-100 px-4 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-xs font-black uppercase tracking-wider text-slate-500">Recent fixed-time calls &amp; outcomes <span className="text-[11px] font-bold text-slate-400">· live pinned first</span></h3>
                <div className="flex flex-wrap items-center gap-2">
                  {headerStatChips}
                  <span className="text-[11px] font-bold text-slate-400">{tableStats.pending} pending · {sortedSignals.length} shown</span>
                </div>
              </div>
              {historyFilters}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead className="border-b border-slate-100 text-[10px] uppercase tracking-[0.15em] text-slate-500">
                  <tr>
                    <th className="px-3 py-1.5">Strategy</th>
                    <th className="px-3 py-1.5">Call</th>
                    <th className="px-3 py-1.5">Symbol</th>
                    <th className="px-3 py-1.5 text-right">Score</th>
                    <th className="px-3 py-1.5">Live / Result</th>
                    <th className="px-3 py-1.5">Track</th>
                    <th className="px-3 py-1.5">Signal time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {sortedSignals.length ? sortedSignals.map((s) => {
                    const up = /BUY/.test(s.direction);
                    const liveTint = s.live ? (s.live.status === 'WINNING' ? 'bg-emerald-50/50 shadow-[inset_3px_0_0_#059669]' : s.live.status === 'LOSING' ? 'bg-rose-50/50 shadow-[inset_3px_0_0_#e11d48]' : 'bg-slate-50/60') : '';
                    return (
                      <tr key={s.id} className={`hover:bg-slate-50/70 ${liveTint}`}>
                        <td className="whitespace-nowrap px-3 py-1.5 text-[11px] font-bold text-violet-700">{stratName(s.strategy)}</td>
                        <td className="px-3 py-1.5">
                          {up
                            ? <span className="inline-flex items-center gap-1 rounded-md bg-emerald-600/10 px-1.5 py-0.5 text-[11px] font-black text-emerald-700"><TrendingUp size={12} /> UP</span>
                            : <span className="inline-flex items-center gap-1 rounded-md bg-rose-600/10 px-1.5 py-0.5 text-[11px] font-black text-rose-700"><TrendingDown size={12} /> DOWN</span>}
                        </td>
                        <td className="px-3 py-1.5"><span className="font-black text-slate-900">{s.symbol}</span> <span className="text-[10px] font-bold text-slate-400">{s.timeframe}</span></td>
                        <td className="px-3 py-1.5 text-right"><ScoreEvolution first={s.score} firstGrade={s.grade} latest={s.latestScore ?? s.score} latestGrade={s.latestGrade ?? s.grade} updatedAt={s.scoreUpdatedAt} /></td>
                        <td className="px-3 py-1.5"><FtResultCell s={s} /></td>
                        <td className="px-3 py-1.5"><SourceChips popupSent={s.popupSent} emailSent={s.emailSent} /></td>
                        <td className="px-3 py-1.5"><SignalTimeCell signalTime={s.signalTime} scoreUpdatedAt={s.scoreUpdatedAt} /></td>
                      </tr>
                    );
                  }) : (
                    <tr><td colSpan={7} className="px-3 py-8 text-center text-sm font-medium text-slate-400">{loading ? 'Loading…' : (signals.length ? 'No calls match the selected history filters.' : 'No fixed-time calls logged yet.')}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="border-t border-slate-100 px-4 py-1.5 text-[11px] font-medium text-slate-400">
              <span className="font-bold text-emerald-600">LIVE</span> = open call, coloured by current position · <span className="font-black text-slate-500">Ideal</span> = signal-bar close → next-bar close (strategy edge) · <span className="font-black text-violet-500">Real</span> = as-traded (live price at signal, set duration); <span className="font-bold">Δ</span> = pips the signal→entry delay cost ·
              <span className="font-bold"> SYS</span>/<span className="font-bold">MAIL</span> = system popup / email · see <Link to="/strategy-lab/reports" className="font-bold text-violet-600 hover:underline">Reports</Link> for win rates.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
