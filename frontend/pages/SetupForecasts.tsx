import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Crosshair, Loader2, RefreshCw, ArrowUp, ArrowDown, Clock, ChevronDown, ChevronUp,
  TrendingUp, TrendingDown, Minus, Eye, ShieldAlert, FlaskConical, Info,
  Sparkles, AlertTriangle, CheckCircle2, XCircle, Star, CheckSquare, Square,
  Bookmark, BookmarkCheck, Activity, Send, Ban, Pencil, ListOrdered, BarChart3, HelpCircle,
} from 'lucide-react';
import { fetchSetupForecasts, analyseForecastWithAi, fetchStrategyRates, trackForecast, fetchTrackedForecasts,
  placeForecastOrder, fetchForecastPendingOrders, cancelForecastOrder } from '../mt5Api';
import OrderModifyPanel from '../components/OrderModifyPanel';
import type { SetupForecastResponse, SetupForecast, ForecastAiResponse, StrategyRatesResponse, TrackedForecastResponse, TrackedForecast, ForecastPendingResponse } from '../types';
import SetupForecastReport from './reports/SetupForecastReport';

// Conditional predictions: not "this is a signal now" (the signal pages own that), but
// "IF price reaches this level and behaves this way, THESE strategies would fire, by their
// own rules". Grouped by how far away the condition is, ranked by quality x proximity.

const digitsFor = (s: string) => {
  const u = (s || '').toUpperCase();
  if (/XAU|GOLD|XAG/.test(u)) return 2;
  if (u.includes('JPY')) return 3;
  if (/USTEC|NAS|US30|SPX|GER/.test(u)) return 1;
  return 5;
};
const px = (v: number | null | undefined, sym: string) =>
  (v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(digitsFor(sym)));

// Level types come out of detectKeyLiquidityLevels as enum-ish strings. Shown the way the
// chart and the accuracy report label them, so the same level reads identically everywhere.
const LEVEL_LABEL: Record<string, string> = {
  PDH: 'Prev day high', PDL: 'Prev day low',
  EQUAL_HIGH: 'Equal highs', EQUAL_LOW: 'Equal lows',
  MAJOR_SWING_HIGH: 'Swing high', MAJOR_SWING_LOW: 'Swing low',
  ROUND_NUMBER: 'Round number',
  LONDON_HIGH: 'London high', LONDON_LOW: 'London low',
  ASIAN_HIGH: 'Asian high', ASIAN_LOW: 'Asian low',
  NY_HIGH: 'NY high', NY_LOW: 'NY low',
  // Beyond resting liquidity: the places strategies actually wait.
  ORDER_BLOCK: 'Order block',
  SUPPORT_ZONE: 'Support zone', RESISTANCE_ZONE: 'Resistance zone',
  RETEST_SUPPORT: 'Broken high → support', RETEST_RESISTANCE: 'Broken low → resistance',
};
const levelName = (t: string | null | undefined) =>
  (t ? LEVEL_LABEL[t] || t.replace(/_/g, ' ').toLowerCase() : '—');

// Source families, coloured so a glance separates "liquidity resting here" from "an order block
// sits here". A level can belong to several — that confluence is the point, not a duplicate.
const SOURCE_META: Record<string, { label: string; cls: string }> = {
  LIQUIDITY: { label: 'LIQ', cls: 'bg-sky-100 text-sky-700' },
  ORDER_BLOCK: { label: 'OB', cls: 'bg-violet-100 text-violet-700' },
  ZONE: { label: 'S/R', cls: 'bg-amber-100 text-amber-700' },
  RETEST: { label: 'RETEST', cls: 'bg-teal-100 text-teal-700' },
};
const SourceChips = ({ sources, confluence }: { sources?: string[] | null; confluence?: number | null }) => {
  const list = (sources || []).filter((s) => SOURCE_META[s]);
  if (!list.length) return null;
  return (
    <span className="inline-flex items-center gap-1">
      {list.map((s) => (
        <span key={s} className={`rounded px-1 py-0.5 text-[9px] font-black ${SOURCE_META[s].cls}`}>
          {SOURCE_META[s].label}
        </span>
      ))}
      {(confluence || 1) > 1 && (
        <span className="rounded bg-slate-800 px-1 py-0.5 text-[9px] font-black text-white"
          title={`${confluence} sources name this same price — a stronger level than any one of them alone`}>
          ×{confluence}
        </span>
      )}
    </span>
  );
};

const SCENARIO_META: Record<string, { label: string; blurb: string }> = {
  SWEEP_REJECT: { label: 'Sweep & reject', blurb: 'runs the stops through the level, fails, turns away' },
  BREAK_HOLD: { label: 'Break & hold', blurb: 'closes through the level and holds beyond it' },
  TOUCH_REJECT: { label: 'Touch & reject', blurb: 'reaches the level without trading through, turns away' },
};

const etaText = (f: SetupForecast) => {
  const { minMinutes: a, maxMinutes: b } = f.eta || {};
  if (a === null || a === undefined || b === null || b === undefined) return '—';
  const fmt = (m: number) => (m >= 90 ? `${Math.round(m / 6) / 10}h` : `${Math.round(m)}m`);
  return `${fmt(a)}–${fmt(b)}`;
};

function DriftBadge({ f }: { f: SetupForecast }) {
  const d = f.driftSummary;
  if (!d || d.points < 2) return <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-slate-400"><Minus size={11} />new</span>;
  if (d.rank > 0.5) return <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-emerald-600"><TrendingUp size={11} />+{d.rank}</span>;
  if (d.rank < -0.5) return <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-rose-500"><TrendingDown size={11} />{d.rank}</span>;
  return <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-slate-400"><Minus size={11} />steady</span>;
}

// Tiny inline chart of rankScore over the re-scans — the drift the user asked to watch.
function DriftSpark({ f }: { f: SetupForecast }) {
  const pts = (f.drift || []).map((p) => p.rankScore);
  if (pts.length < 2) return null;
  const min = Math.min(...pts), max = Math.max(...pts);
  const span = max - min || 1;
  const W = 72, H = 20;
  const path = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i / (pts.length - 1)) * W},${H - 2 - ((v - min) / span) * (H - 4)}`).join(' ');
  const up = pts[pts.length - 1] >= pts[0];
  return (
    <svg width={W} height={H} className="shrink-0" aria-label="score drift">
      <path d={path} fill="none" stroke={up ? '#059669' : '#f43f5e'} strokeWidth="1.5" />
    </svg>
  );
}


// AI review of one forecast. A SECOND opinion beside the deterministic engine — never a
// replacement for it, so agreement and disagreement are both shown plainly, and any ticket the
// model returns that failed arithmetic checks is marked unusable rather than quietly hidden.
function AiPanel({ data }: { data: ForecastAiResponse }) {
  const ai = data.ai;
  if (!ai.available) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
        <p className="text-[11px] font-bold text-slate-500">AI review unavailable</p>
        <p className="text-[11px] font-semibold text-slate-400">{ai.summary || ai.reason}</p>
      </div>
    );
  }
  const sym = data.id.split('|')[0] || '';
  const buy = ai.direction === 'BUY';
  const verdictStyle: Record<string, string> = {
    TAKE: 'bg-emerald-100 text-emerald-800', WATCH: 'bg-amber-100 text-amber-800', SKIP: 'bg-rose-100 text-rose-700',
  };
  const agree = ai.agreesWithSystem;
  return (
    <div className="space-y-2 rounded-lg border border-violet-200 bg-violet-50/50 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-violet-700">
          <Sparkles size={12} />AI review
        </span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${verdictStyle[ai.verdict || 'WATCH'] || 'bg-slate-100 text-slate-600'}`}>
          {ai.verdict}
        </span>
        {ai.direction && ai.direction !== 'NO_TRADE' ? (
          <span className={`text-[11px] font-black ${buy ? 'text-emerald-700' : 'text-rose-600'}`}>{ai.direction}</span>
        ) : <span className="text-[11px] font-black text-slate-500">NO TRADE</span>}
        <span className="text-[11px] font-bold text-violet-800">score {ai.score ?? '—'}</span>
        <span className="text-[10px] font-semibold text-slate-500">{ai.confidence} confidence</span>
        {/* Whether the model backs the engine is the single most useful line on this panel. */}
        <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold ${agree ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
          {agree ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
          {agree ? 'agrees with the system' : 'disagrees with the system'}
        </span>
        {data.cached ? <span className="text-[10px] font-medium text-slate-400">cached</span> : null}
      </div>

      {ai.direction !== 'NO_TRADE' && (ai.entry || ai.stopLoss) ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] font-semibold text-slate-700 sm:grid-cols-4">
          <span>Entry <b>{px(ai.entry ?? null, sym)}</b></span>
          <span>SL <b className="text-rose-600">{px(ai.stopLoss ?? null, sym)}</b>{ai.stopPips ? ` (${ai.stopPips}p)` : ''}</span>
          <span>TP1 <b className="text-emerald-600">{px(ai.takeProfit1 ?? null, sym)}</b></span>
          <span>RR <b>{ai.rr ?? '—'}</b></span>
        </div>
      ) : null}

      {/* Arithmetic disagreed with the model somewhere — say so rather than showing a
          confident-looking ticket that would not survive contact with the broker. */}
      {(ai.issues?.length || 0) > 0 && (
        <div className="rounded border border-amber-300 bg-amber-50 px-2 py-1.5">
          <p className="flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-amber-800">
            <AlertTriangle size={11} />ticket failed validation — not tradable as returned
          </p>
          {ai.issues!.map((i) => <p key={i} className="text-[11px] font-semibold text-amber-800">· {i}</p>)}
        </div>
      )}

      {ai.rationale ? <p className="text-[11.5px] font-semibold leading-snug text-slate-700">{ai.rationale}</p> : null}
      {ai.expectedReaction ? (
        <p className="text-[11px] font-semibold text-slate-500"><b className="text-slate-600">Expects:</b> {ai.expectedReaction}</p>
      ) : null}
      {ai.invalidation ? (
        <p className="text-[11px] font-semibold text-slate-500"><b className="text-slate-600">Wrong if:</b> {ai.invalidation}</p>
      ) : null}
      {(ai.keyRisks?.length || 0) > 0 && (
        <ul className="space-y-0.5">
          {ai.keyRisks!.map((r) => (
            <li key={r} className="flex items-start gap-1 text-[11px] font-semibold text-slate-500">
              <span className="mt-0.5 text-amber-500">·</span>{r}
            </li>
          ))}
        </ul>
      )}
      {(data.news?.length || 0) > 0 && (
        <p className="text-[10px] font-bold text-amber-700">
          News in window: {data.news!.map((e) => `${e.currency} ${e.impact} ${e.title} (${e.in_minutes}m)`).join(' · ')}
        </p>
      )}
      {/* The exact image the model was shown, so "AI vision" is verifiable rather than a claim.
          Rendered server-side from the same candles the engine analysed. */}
      {data.saw?.chartPng ? (
        <details>
          <summary className="cursor-pointer text-[10px] font-bold text-violet-600 hover:underline">
            <Eye size={11} className="mb-0.5 mr-1 inline" />
            Chart the AI looked at ({data.saw.bars} candles, rendered from the analysed data)
          </summary>
          <img src={data.saw.chartPng} alt="chart analysed by the AI"
            className="mt-1 w-full rounded border border-slate-200" />
        </details>
      ) : null}
      <p className="text-[10px] font-medium text-slate-400">
        {data.model} · {data.saw?.vision ? `saw ${data.saw.bars} candles + chart image` : 'text only'}
        {' · '}patterns, wicks, order blocks, FVGs, S/R, sweeps and retests supplied by the engines
        {' · '}never trades, never emails
      </p>
    </div>
  );
}

/**
 * The assumed reaction, drawn.
 *
 * The scenario bars were already disclosed as OHLC text, which is complete and almost unreadable —
 * "bar1 O 4012.4 H 4014.1 L 4009.8 C 4013.6" does not tell you the wick pokes below the level and
 * closes back above it. The whole forecast rests on that shape, so it gets drawn.
 */
function ScenarioBars({ f }: { f: SetupForecast }) {
  const bars = f.scenarioBars || [];
  if (!bars.length) return null;
  const lo = Math.min(...bars.map((b) => b.low), f.level);
  const hi = Math.max(...bars.map((b) => b.high), f.level);
  const span = hi - lo || 1;
  // Slots are sized for the LABEL, not the candle — the words are the point of the picture.
  const W = 22, H = 96, gap = 34;
  const y = (v: number) => H - ((v - lo) / span) * H;
  const names = ['reaction', 'follow-through'];
  return (
    <div className="overflow-x-auto">
      <svg width={bars.length * (W + gap)} height={H + 4}>
        {/* The one REAL price in the picture. Everything else is the hypothesis. */}
        <line x1={0} x2={bars.length * (W + gap)} y1={y(f.level)} y2={y(f.level)}
          stroke="#f43f5e" strokeWidth="1" strokeDasharray="3 3" />
        {bars.map((b, i) => {
          const x = i * (W + gap) + gap / 2;
          const up = b.close >= b.open;
          const top = y(Math.max(b.open, b.close));
          const bot = y(Math.min(b.open, b.close));
          return (
            <g key={i}>
              <line x1={x + W / 2} x2={x + W / 2} y1={y(b.high)} y2={y(b.low)} stroke={up ? '#059669' : '#e11d48'} strokeWidth="1.5" />
              <rect x={x} y={top} width={W} height={Math.max(2, bot - top)} fill={up ? '#059669' : '#e11d48'} opacity={0.85} />
            </g>
          );
        })}
      </svg>
      <div className="flex" style={{ width: bars.length * (W + gap) }}>
        {bars.map((b, i) => (
          <span key={i} className="text-center text-[9px] font-bold uppercase tracking-wide text-slate-400" style={{ width: W + gap }}>
            {names[i] || 'bar'}
          </span>
        ))}
      </div>
      <p className="mt-1 text-[10px] font-semibold text-slate-400">
        <span className="text-rose-500">▬</span> the level at {px(f.level, f.symbol)} · these candles are DRAWN by the
        system from the level and current volatility — they have not happened
      </p>
      <details className="mt-1 text-[11px]">
        <summary className="cursor-pointer font-bold text-slate-400 hover:text-slate-600">exact prices</summary>
        <div className="mt-1 space-y-0.5 font-mono text-[10px] text-slate-500">
          {bars.map((b, i) => (
            <p key={i}>bar{i + 1} · O {px(b.open, f.symbol)} H {px(b.high, f.symbol)} L {px(b.low, f.symbol)} C {px(b.close, f.symbol)}</p>
          ))}
        </div>
      </details>
    </div>
  );
}

/**
 * Where the score came from, split into what the market said and what the forecast assumed.
 *
 * A forecast's score, grade and ticket are rendered identically to a live signal's, and they do
 * not mean the same thing — one reads something that happened, the other reads something drawn.
 * This panel is the only place that difference is visible, so it is written for someone who has
 * never heard the word "liquidity" and states the arrival assumption first.
 */
function ScoreBasisPanel({ f }: { f: SetupForecast }) {
  const b = f.scoreBasis;
  if (!b) return null;
  const ev = b.evidence;
  const evStyle = ev.good === true ? 'border-emerald-200 bg-emerald-50'
    : ev.good === false ? 'border-rose-200 bg-rose-50'
      : 'border-slate-200 bg-slate-50';
  return (
    <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2.5">
      <p className="text-[10px] font-black uppercase tracking-wider text-amber-800">
        Where the {f.bestScore ?? '—'} comes from
      </p>
      <p className="text-[12px] font-bold text-slate-800">{b.headline}</p>

      <div className="rounded-lg border border-slate-200 bg-white px-2.5 py-2">
        <p className="text-[11px] font-black text-slate-700">{b.scenario.name}</p>
        <p className="text-[11.5px] font-semibold leading-snug text-slate-600">{b.scenario.story}</p>
        <p className="mt-1 text-[11px] font-semibold text-slate-500">
          <b className="text-slate-700">The signal is:</b> {b.scenario.signalIs}.
          {' '}<b className="text-slate-700">It is wrong if:</b> {b.scenario.wrongIf}.
        </p>
      </div>

      <div className="grid gap-2 lg:grid-cols-2">
        <div>
          <p className="text-[10px] font-black uppercase tracking-wider text-amber-900">
            Assumed — drawn by the system, not observed
          </p>
          <ul className="mt-0.5 space-y-1">
            {b.assumed.map((x) => (
              <li key={x.label} className="flex items-start gap-1.5">
                <HelpCircle size={12} className="mt-0.5 shrink-0 text-amber-500" />
                <span className="text-[11px] font-semibold text-slate-600">
                  <b className="text-slate-800">{x.label}.</b> <span className="font-medium">{x.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="text-[10px] font-black uppercase tracking-wider text-emerald-800">
            Measured — read from the real chart
          </p>
          <ul className="mt-0.5 space-y-1">
            {b.measured.map((x) => (
              <li key={x.label} className="flex items-start gap-1.5">
                <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-emerald-500" />
                <span className="text-[11px] font-semibold text-slate-600">
                  <b className="text-slate-800">{x.label}.</b> <span className="font-medium">{x.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* The placebo control. This page runs the same strategies against random prices where no
          level exists; the gap between the two is the only hard evidence here that the LEVEL is
          doing the work rather than the drawn candle. */}
      <div className={`rounded-lg border px-2.5 py-2 ${evStyle}`}>
        <p className="flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-slate-600">
          <FlaskConical size={11} />Reality check · {ev.headline}
        </p>
        <p className="text-[11px] font-semibold text-slate-600">{ev.detail}</p>
      </div>

      <p className="text-[11px] font-bold text-amber-900">{b.caution}</p>
    </div>
  );
}

function ForecastCard({ f, selected, onSelect, perfect, tracked, onTrack, onPlace, placing }: {
  f: SetupForecast; selected: boolean; onSelect: (id: string, on: boolean) => void; perfect: Set<string>;
  tracked: boolean; onTrack: (id: string, on: boolean) => void;
  onPlace: (id: string) => void; placing: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [ai, setAi] = useState<ForecastAiResponse | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState<string | null>(null);
  // Two-step, deliberately: this queues a REAL order at the broker, and the button sits in a row
  // of harmless ones (AI analyse, Track) on a list of ~180 cards. The second click is the confirm.
  const [confirmPlace, setConfirmPlace] = useState(false);

  const runAi = async (force = false) => {
    setAiBusy(true); setAiErr(null);
    setOpen(true);                      // the answer renders in the body, so open it
    try { setAi(await analyseForecastWithAi(f.id, force)); }
    catch (e) { setAiErr(e instanceof Error ? e.message : 'AI analysis failed'); }
    finally { setAiBusy(false); }
  };
  const buy = f.expectedDirection === 'BUY';
  const meta = SCENARIO_META[f.scenario] || { label: f.scenario, blurb: '' };
  const plan = f.plan;
  const warnings = plan?.challenge?.warnings || [];
  const split = f.consensusDirection === 'SPLIT';

  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center">
        {/* Selection lives outside the toggle button — nesting a control inside a button is
            invalid HTML and the click would be swallowed by the parent. */}
        <button
          type="button"
          aria-label={selected ? 'deselect forecast' : 'select forecast'}
          onClick={(e) => { e.stopPropagation(); onSelect(f.id, !selected); }}
          className="pl-3 pr-1 text-slate-300 hover:text-violet-600"
        >
          {selected ? <CheckSquare size={16} className="text-violet-600" /> : <Square size={16} />}
        </button>
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 py-3 pl-1 pr-4 text-left">
        <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${buy ? 'bg-emerald-100 text-emerald-600' : 'bg-rose-100 text-rose-500'}`}>
          {buy ? <ArrowUp size={16} /> : <ArrowDown size={16} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-black text-slate-800">
            {f.symbol} <span className="text-slate-400">{f.timeframe}</span>
            {' '}· {f.levelLabel || levelName(f.levelType)} @ {px(f.level, f.symbol)}
            {' '}<SourceChips sources={f.levelSources} confluence={f.levelConfluence} />
          </p>
          <p className="truncate text-[11px] font-semibold text-slate-500">
            {meta.label} → {split ? 'strategies SPLIT' : f.expectedDirection}
            {' '}· {f.distance?.pips ?? '—'} pips away ({f.distance?.atr ?? '—'} ATR)
            {' '}· <Clock size={10} className="mb-0.5 inline" /> {etaText(f)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <DriftSpark f={f} />
          <div className="text-right">
            <p className="flex items-center justify-end gap-1 text-sm font-black text-violet-700">
              {f.grade ? (
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${
                  f.grade === 'A+' ? 'bg-emerald-100 text-emerald-800'
                    : f.grade === 'A' ? 'bg-emerald-50 text-emerald-700'
                      : f.grade === 'B' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500'
                }`}>{f.grade}</span>
              ) : null}
              {f.bestScore ?? '—'}
            </p>
            <DriftBadge f={f} />
          </div>
          <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">
            {f.agreeCount} strat{f.agreeCount === 1 ? '' : 's'}{f.dissentCount ? ` · ${f.dissentCount} against` : ''}
          </span>
          {open ? <ChevronUp size={15} className="text-slate-400" /> : <ChevronDown size={15} className="text-slate-400" />}
        </div>
      </button>
      </div>


      {/* The ticket, laid out like an ICT prediction card: the numbers you would actually send.
          Conditional on the scenario happening at the level — see the page caveats. */}
      {plan?.entry ? (
        <div className="border-t border-slate-100 bg-slate-50/60 px-4 py-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
            <span className="font-black uppercase tracking-wider text-slate-400">Ticket</span>
            <span className="font-semibold text-slate-700">
              entry <b className="text-slate-900">{px(plan.entry, f.symbol)}</b>
            </span>
            <span className="font-semibold text-rose-600">
              SL <b>{px(plan.stopLoss, f.symbol)}</b>
              {plan.stopPips ? <span className="text-slate-400"> ({plan.stopPips}p)</span> : null}
            </span>
            <span className="font-semibold text-emerald-600">
              TP1 <b>{px(plan.takeProfit, f.symbol)}</b>
            </span>
            {plan.takeProfit3 ? (
              <span className="font-semibold text-emerald-700">TP3 <b>{px(plan.takeProfit3, f.symbol)}</b></span>
            ) : null}
            {plan.rr ? <span className="font-semibold text-slate-600">RR <b>{plan.rr}</b></span> : null}
            <span className="ml-auto font-bold text-slate-700">
              {plan.lots ?? '—'} lots
              {plan.riskBudget ? <span className="text-slate-400"> · ${plan.riskBudget} risk</span> : null}
              {plan.convictionTier ? (
                <span className="ml-1 rounded bg-slate-200 px-1 py-0.5 text-[9px] font-black text-slate-600">
                  {plan.convictionTier}
                </span>
              ) : null}
            </span>
          </div>

          {/* Which strategies actually back this level, with their own read. Only the agreeing
              ones — a dissenting engine is shown as a count, not as support. */}
          {Array.isArray(f.fires) && f.fires.some((x) => x.agrees) ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">Supported by</span>
              {f.fires.filter((x) => x.agrees).slice(0, 6).map((x) => (
                <span
                  key={x.strategyId}
                  title={`${x.strategyId}: ${x.decision} · score ${x.score ?? '?'} · ${x.rr ?? '?'}R`}
                  className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                    x.grade === 'A+' ? 'bg-emerald-100 text-emerald-800'
                      : x.grade === 'A' ? 'bg-emerald-50 text-emerald-700'
                        : 'bg-slate-100 text-slate-600'
                  }`}
                >
                  {x.strategyId}
                  {x.score ? <span className="ml-1 opacity-70">{x.score}</span> : null}
                </span>
              ))}
              {f.dissentCount ? (
                <span className="rounded bg-rose-50 px-1.5 py-0.5 text-[10px] font-bold text-rose-600">
                  {f.dissentCount} against
                </span>
              ) : null}
            </div>
          ) : null}

          {/* The track-record badge. Deliberately NOT on strategy x symbol x timeframe x level:
              that slice has a median sample of 1 across the resolved history, so a tick there
              would be noise. It reports the grouping it actually used. */}
          {f.trackRecord ? (
            <div className="mt-1.5 flex items-start gap-1.5">
              {f.trackRecord.qualifies ? (
                <>
                  <CheckCircle2 size={13} className="mt-px shrink-0 text-emerald-600" />
                  <span className="text-[10px] font-bold text-emerald-800">
                    Proven on {f.trackRecord.grouping} —{' '}
                    {f.trackRecord.winRate !== null ? `${Math.round(f.trackRecord.winRate * 100)}% win` : 'no settled trades'}
                    {' · '}{Math.round((f.trackRecord.matchRate ?? 0) * 100)}% match over {f.trackRecord.n}
                  </span>
                </>
              ) : (
                <span className="text-[10px] font-medium text-slate-400" title={f.trackRecord.reason}>
                  {f.trackRecord.n
                    ? `${f.trackRecord.grouping}: ${f.trackRecord.n} resolved, below the bar`
                    : 'not enough history to judge this combo'}
                </span>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Per-forecast AI review. Sits outside the card's toggle button because a button
          inside a button is invalid HTML and swallows the click. */}
      <div className="flex items-center gap-2 border-t border-slate-100 px-4 py-1.5">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); runAi(false); }}
          disabled={aiBusy}
          className="inline-flex items-center gap-1 rounded-lg border border-violet-300 bg-violet-50 px-2.5 py-1 text-[11px] font-black text-violet-700 hover:bg-violet-100 disabled:opacity-50"
        >
          {aiBusy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
          {ai ? 'AI re-analyse' : 'AI analyse'}
        </button>
        {ai?.cached ? (
          <button type="button" onClick={(e) => { e.stopPropagation(); runAi(true); }}
            className="text-[10px] font-bold text-slate-400 hover:text-violet-600">force refresh</button>
        ) : null}
        {aiErr ? <span className="text-[11px] font-bold text-rose-600">{aiErr}</span> : null}
        {/* Track: pin this forecast to the Tracked tab and get one alert if it turns. */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onTrack(f.id, !tracked); }}
          className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-black ${
            tracked ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
          }`}
        >
          {tracked ? <BookmarkCheck size={12} /> : <Bookmark size={12} />}
          {tracked ? 'Tracked' : 'Track'}
        </button>

        {/* Rest a limit at the level, without having to Track it first. The forecast's whole
            premise is that price has NOT arrived, which is exactly what a resting limit is for —
            so making it reachable only from the Tracked tab was an extra step for no safety, since
            every binding check (correct side of market, challenge rules, concurrency, broker stop
            distance) runs server-side either way. */}
        {plan?.entry ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); if (confirmPlace) { onPlace(f.id); setConfirmPlace(false); } else setConfirmPlace(true); }}
            onBlur={() => setConfirmPlace(false)}
            disabled={placing}
            title={`Rest a ${f.expectedDirection} limit at ${px(plan.entry, f.symbol)} — fills only if price reaches the level`}
            className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-black disabled:opacity-50 ${
              confirmPlace ? 'border-violet-600 bg-violet-600 text-white' : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            {placing ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
            {confirmPlace ? `Confirm ${f.expectedDirection} limit @ ${px(plan.entry, f.symbol)}` : 'Place limit'}
          </button>
        ) : (
          <span className="text-[10px] font-semibold text-slate-300" title="No agreeing strategy returned usable entry/stop prices, so there is nothing to size or place">
            no ticket to place
          </span>
        )}

        {!ai && !aiBusy && !aiErr ? (
          <span className="text-[10px] font-medium text-slate-400">independent review of this level</span>
        ) : null}
      </div>

      {open && (
        <div className="space-y-3 border-t border-slate-100 px-4 py-3">
          {ai ? <AiPanel data={ai} /> : null}

          {/* Why the number is what it is, before anything that looks like a tradable price. */}
          <ScoreBasisPanel f={f} />

          <p className="text-[11px] font-semibold text-slate-500">
            If price {meta.blurb} at {px(f.level, f.symbol)}, these strategies would take it:
          </p>
          {/* Which strategies fire, by their own rules — dissenters shown, never hidden */}
          <div className="flex flex-wrap gap-1.5">
            {f.fires.map((x) => (
              <span
                key={x.strategyId}
                title={`stage ${x.stage}${x.grade ? ` · ${x.grade}` : ''}${perfect.has(x.strategyId) ? ' · 100% of its forecasts played out in the selected window' : ''}`}
                className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-bold ${x.agrees ? 'bg-violet-50 text-violet-700' : 'bg-amber-50 text-amber-700'}`}
              >
                {perfect.has(x.strategyId) ? <Star size={11} className="fill-amber-400 text-amber-500" /> : null}
                {x.strategyId} {x.decision === 'BUY' ? '↑' : '↓'} {x.score ?? '—'}{!x.agrees && ' (disagrees)'}
              </span>
            ))}
          </div>

          {plan ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2">
              <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                Conditional ticket · {plan.strategyId} · sized to challenge
              </p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] font-semibold text-slate-700 sm:grid-cols-4">
                <span>Entry <b>{px(plan.entry, f.symbol)}</b></span>
                <span>SL <b className="text-rose-600">{px(plan.stopLoss, f.symbol)}</b> ({plan.stopPips}p)</span>
                <span>TP1 <b className="text-emerald-600">{px(plan.takeProfit, f.symbol)}</b>{plan.takeProfit3 ? <> · TP3 <b className="text-emerald-600">{px(plan.takeProfit3, f.symbol)}</b></> : null}</span>
                <span>RR <b>{plan.rr ?? '—'}</b></span>
                <span>Lots <b>{plan.lots}</b>{plan.minForced ? ' (broker min)' : ''}</span>
                <span>Risk <b className={plan.overBudget ? 'text-rose-600' : ''}>${plan.lossAtStop}</b> / ${plan.riskBudget}</span>
                <span>@TP1 <b className="text-emerald-700">${plan.profitAtTp ?? '—'}</b></span>
                <span>@TP3 <b className="text-emerald-700">${plan.profitAtFinalTp ?? '—'}</b></span>
              </div>
              {warnings.length > 0 && (
                <p className="mt-1.5 flex items-start gap-1 text-[11px] font-bold text-amber-700">
                  <ShieldAlert size={13} className="mt-0.5 shrink-0" />{warnings.join(' · ')}
                </p>
              )}
            </div>
          ) : (
            <p className="text-[11px] font-semibold text-slate-400">
              No sized ticket — no agreeing strategy returned usable entry/stop prices for this scenario.
            </p>
          )}

          {/* The assumption, drawn rather than dumped as OHLC text. */}
          <div>
            <p className="mb-1 flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-slate-500">
              <Eye size={11} />The reaction being assumed
            </p>
            <ScenarioBars f={f} />
          </div>

          <p className="text-[10px] font-medium text-slate-400">
            first seen {new Date(f.createdAt).toLocaleString()} · re-scored {f.driftSummary.points}× · last {new Date(f.updatedAt).toLocaleTimeString()}
          </p>
        </div>
      )}
    </div>
  );
}


// Health of a tracked forecast. The negative verdicts are the point: a panel that only ever
// says "still valid" is a panel that lets you sit in a dead idea.
const VERDICT_STYLE: Record<string, { chip: string; label: string }> = {
  REVERSED: { chip: 'bg-rose-100 text-rose-800 border-rose-300', label: 'INVALIDATED' },
  DONT_CHASE: { chip: 'bg-orange-100 text-orange-800 border-orange-300', label: "DON'T CHASE" },
  WEAKENING: { chip: 'bg-amber-100 text-amber-800 border-amber-300', label: 'WEAKENING' },
  STALE: { chip: 'bg-slate-100 text-slate-600 border-slate-300', label: 'TIME EXPIRED' },
  HOLDING: { chip: 'bg-sky-50 text-sky-700 border-sky-200', label: 'HOLDING' },
  STRENGTHENING: { chip: 'bg-emerald-100 text-emerald-800 border-emerald-300', label: 'STRENGTHENING' },
  CLOSED: { chip: 'bg-slate-100 text-slate-500 border-slate-200', label: 'CLOSED' },
};

function TrackedCard({ t, onUntrack, onPlace, busy, placing }: {
  t: TrackedForecast; onUntrack: (id: string) => void; onPlace: (id: string) => void;
  busy: boolean; placing: boolean;
}) {
  const h = t.health;
  const v = VERDICT_STYLE[h.verdict] || VERDICT_STYLE.HOLDING;
  const buy = t.expectedDirection === 'BUY';
  const adverse = ['REVERSED', 'DONT_CHASE', 'STALE', 'CLOSED', 'WEAKENING'].includes(h.verdict);
  const drift = h.scoreChange;
  return (
    <div className={`rounded-2xl border bg-white px-4 py-3 ${h.verdict === 'REVERSED' || h.verdict === 'DONT_CHASE' ? 'border-rose-300' : 'border-slate-200'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-md border px-2 py-0.5 text-[10px] font-black ${v.chip}`}>{v.label}</span>
        <span className="text-sm font-black text-slate-800">
          {t.symbol} <span className="text-slate-400">{t.timeframe}</span> · {t.levelLabel || t.levelType} {t.level}
        </span>
        <span className={`text-[11px] font-black ${buy ? 'text-emerald-600' : 'text-rose-500'}`}>{t.expectedDirection}</span>
        <span className="text-[11px] font-semibold text-slate-500">{(t.scenario || '').replace(/_/g, ' ').toLowerCase()}</span>
        {t.alertedAt ? (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500" title={`alerted ${new Date(t.alertedAt).toLocaleString()}`}>
            alert sent
          </span>
        ) : null}
        {/* Placeable on any tracked setup that has a ticket. An adverse health verdict tints the
            button rather than removing it — DON'T CHASE in particular is exactly when a resting
            limit makes sense, since the advice is to wait for a pullback. The binding checks
            (correct side of market, challenge rules, concurrency) run server-side. */}
        {t.plan ? (
          <button onClick={() => onPlace(t.id)} disabled={placing}
            title={adverse ? 'Health is adverse — the server still validates side, challenge rules and concurrency' : 'Rest a limit order at this level'}
            className={`ml-auto inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-black text-white disabled:opacity-50 ${
              adverse ? 'bg-amber-600 hover:bg-amber-700' : 'bg-violet-600 hover:bg-violet-700'
            }`}>
            {placing ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
            {adverse ? 'Place anyway' : 'Place limit'}
          </button>
        ) : (
          <span className="ml-auto text-[10px] font-semibold text-slate-300" title="no sized ticket on this forecast">no ticket</span>
        )}
        <button onClick={() => onUntrack(t.id)} disabled={busy}
          className="text-[11px] font-bold text-slate-400 hover:text-rose-600 disabled:opacity-50">untrack</button>
      </div>

      {h.suggestion ? <p className="mt-1.5 text-[12px] font-semibold text-slate-700">{h.suggestion}</p> : null}

      <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-[11px] font-semibold text-slate-600">
        <span>Score drift <b className={drift > 0 ? 'text-emerald-700' : drift < 0 ? 'text-rose-600' : 'text-slate-500'}>
          {drift > 0 ? '+' : ''}{drift}</b></span>
        <span>Now <b>{t.price ?? '—'}</b></span>
        <span>To level <b>{h.distanceAtr ?? '—'} ATR</b></span>
        <span>Time left <b className={(h.timeLeftMinutes ?? 0) < 0 ? 'text-rose-600' : ''}>
          {h.timeLeftMinutes === null ? '—' : `${h.timeLeftMinutes}m`}</b></span>
        {h.agreeChange !== 0 ? (
          <span>Strategies <b className={h.agreeChange > 0 ? 'text-emerald-700' : 'text-rose-600'}>
            {h.agreeChange > 0 ? '+' : ''}{h.agreeChange}</b></span>
        ) : null}
      </div>

      {(h.reasons?.length || 0) > 0 && (
        <ul className="mt-1 space-y-0.5">
          {h.reasons.map((r) => (
            <li key={r} className="text-[11px] font-medium text-slate-500">· {r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}


const ORDER_STATUS_STYLE: Record<string, string> = {
  QUEUED: 'bg-sky-100 text-sky-800', SENT: 'bg-sky-100 text-sky-800',
  PLACED: 'bg-violet-100 text-violet-800', FILLED: 'bg-emerald-100 text-emerald-800',
  CLOSED: 'bg-slate-100 text-slate-600', CANCELLING: 'bg-amber-100 text-amber-800',
  CANCELLED: 'bg-slate-100 text-slate-500', REJECTED: 'bg-slate-100 text-slate-500',
  ERROR: 'bg-rose-100 text-rose-700', EXPIRED: 'bg-amber-50 text-amber-700',
};

// Orders resting at the broker that came from a forecast. Real money — so the state shown is
// the BROKER's, never an optimistic guess: a cancel stays "cancelling" until MT5 confirms it.
function PendingOrdersTab() {
  const [data, setData] = useState<ForecastPendingResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async (spin = false) => {
    if (spin) setLoading(true);
    try { setData(await fetchForecastPendingOrders()); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed to load orders'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load(true);
    const t = setInterval(() => load(false), 20000);
    return () => clearInterval(t);
  }, [load]);

  const [modifying, setModifying] = useState<string | null>(null);

  const cancel = async (id: string) => {
    setBusy(id); setErr(null); setNote(null);
    try {
      const r = await cancelForecastOrder(id);
      setNote(r.atBroker ? 'Cancel sent to MT5 — it clears once the broker confirms.' : 'Order cancelled before it reached MT5.');
      await load(false);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Cancel failed'); }
    finally { setBusy(null); }
  };

  const orders = data?.orders || [];
  const live = orders.filter((o) => o.cancellable);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 text-sm font-black uppercase tracking-wider text-slate-600">
          <ListOrdered size={14} className="text-violet-400" />Pending orders
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">{live.length} resting</span>
        </h2>
        <button onClick={() => load(true)} className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-slate-500 hover:text-violet-600">
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}Refresh
        </button>
      </div>

      {err ? <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-[12px] font-bold text-rose-600">{err}</div> : null}
      {note ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-[12px] font-bold text-emerald-700">{note}</div> : null}
      {data && (!data.bridgeReady || !data.armedMatch) ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-[12px] font-bold text-amber-800">
          {!data.bridgeReady
            ? 'The EA is not reporting — orders will sit queued until it reconnects, and cancels will not reach MT5.'
            : 'The account in MT5 does not match the armed account — dispatch is paused.'}
        </div>
      ) : null}

      {orders.length ? (
        <div className="space-y-2">
          {orders.map((o) => (
            <div key={o.id} className={`rounded-2xl border bg-white px-4 py-3 ${o.cancellable ? 'border-violet-200' : 'border-slate-200 opacity-75'}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${ORDER_STATUS_STYLE[o.status] || 'bg-slate-100 text-slate-600'}`}>{o.status}</span>
                <span className="text-sm font-black text-slate-800">
                  {o.direction} {o.symbol} <span className="text-slate-400">{o.timeframe}</span>
                </span>
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">{o.orderType}</span>
                {o.ticket ? <span className="text-[10px] font-semibold text-slate-400">#{o.ticket}</span> : null}
                {o.cancellable ? (
                  <>
                    <button onClick={() => setModifying((m) => (m === o.id ? null : o.id))}
                      className={`ml-auto inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-black ${modifying === o.id ? 'bg-slate-900 text-white' : 'border border-slate-300 bg-white text-slate-600 hover:border-sky-300 hover:text-sky-600'}`}>
                      <Pencil size={12} />Modify
                    </button>
                    <button onClick={() => cancel(o.id)} disabled={busy !== null}
                      className="inline-flex items-center gap-1 rounded-lg border border-rose-300 bg-white px-2.5 py-1 text-[11px] font-black text-rose-600 hover:bg-rose-50 disabled:opacity-50">
                      {busy === o.id ? <Loader2 size={12} className="animate-spin" /> : <Ban size={12} />}Close order
                    </button>
                  </>
                ) : (
                  <span className="ml-auto text-[11px] font-semibold text-slate-400">
                    {o.profit !== null ? `P/L $${o.profit.toFixed(2)}` : (o.reason || '').slice(0, 60)}
                  </span>
                )}
              </div>
              {modifying === o.id ? (
                <OrderModifyPanel orderId={o.id} onDone={() => { setModifying(null); void load(false); }} />
              ) : null}
              <p className="mt-1 text-[12px] font-semibold text-slate-600">
                Entry <b>{o.entry}</b> · SL <b className="text-rose-600">{o.stopLoss}</b> · TP1 <b className="text-emerald-600">{o.takeProfit1 ?? '—'}</b>
                {o.rr ? <> · RR <b>{o.rr}</b></> : null} · <b>{o.lots}</b> lots
                {o.riskAmount ? <> · risk <b>${o.riskAmount}</b></> : null}
              </p>
              <p className="mt-0.5 text-[11px] font-semibold text-slate-400">
                from {(o.scenario || '').replace(/_/g, ' ').toLowerCase()} at {o.levelLabel || 'level'} {o.level}
                {o.forecastScore ? ` · forecast score ${o.forecastScore}` : ''}
                {o.expiresAt ? ` · expires ${new Date(o.expiresAt).toLocaleTimeString()}` : ''}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-2xl border border-dashed border-slate-200 px-5 py-6 text-center text-[13px] font-semibold text-slate-400">
          No orders placed from forecasts yet. Use <b>Place limit</b> on a tracked setup.
        </p>
      )}
      <p className="text-[11px] font-semibold text-slate-400">
        These are real resting orders on MT5, sized to your challenge rules and subject to the same
        concurrency and challenge guards as the auto-trader. Closing one removes it from the broker.
      </p>
    </div>
  );
}

function TrackedTab() {
  const [data, setData] = useState<TrackedForecastResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (spin = false) => {
    if (spin) setLoading(true);
    try { setData(await fetchTrackedForecasts()); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed to load tracked forecasts'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load(true);
    const t = setInterval(() => load(false), 60000);
    return () => clearInterval(t);
  }, [load]);

  const [placing, setPlacing] = useState<string | null>(null);
  const [placed, setPlaced] = useState<string | null>(null);

  const place = async (id: string) => {
    setPlacing(id); setErr(null); setPlaced(null);
    try {
      const r = await placeForecastOrder(id);
      setPlaced(`${r.direction} limit resting at ${r.entry} · ${r.lots} lots · expires in ${r.expiresInMinutes} min.`
        + (r.warnings?.length ? ` Warnings: ${r.warnings.join('; ')}` : ''));
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not place the order'); }
    finally { setPlacing(null); }
  };

  const untrack = async (id: string) => {
    setBusy(true);
    try { await trackForecast(id, false); await load(false); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed to untrack'); }
    finally { setBusy(false); }
  };

  const rows = data?.tracked || [];
  const trouble = rows.filter((t) => ['REVERSED', 'DONT_CHASE', 'WEAKENING'].includes(t.health.verdict)).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 text-sm font-black uppercase tracking-wider text-slate-600">
          <Activity size={14} className="text-violet-400" />Tracked
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">{rows.length}</span>
        </h2>
        {trouble > 0 ? (
          <span className="rounded-md bg-rose-50 px-2 py-0.5 text-[11px] font-bold text-rose-700">{trouble} need attention</span>
        ) : null}
        <button onClick={() => load(true)} className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-slate-500 hover:text-violet-600">
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}Refresh
        </button>
      </div>
      {err ? <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-[12px] font-bold text-rose-600">{err}</div> : null}
      {placed ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-[12px] font-bold text-emerald-700">{placed}</div> : null}
      <p className="text-[11px] font-semibold text-slate-400">
        Health is re-read every minute against live price. You get exactly one email per tracked setup, the first time it turns against you — never for good news.
      </p>
      {rows.length ? (
        <div className="space-y-2">{rows.map((t) => <TrackedCard key={t.id} t={t} onUntrack={untrack} onPlace={place} busy={busy} placing={placing === t.id} />)}</div>
      ) : (
        <p className="rounded-2xl border border-dashed border-slate-200 px-5 py-6 text-center text-[13px] font-semibold text-slate-400">
          Nothing tracked yet. Hit <b>Track</b> on any forecast to watch it here.
        </p>
      )}
    </div>
  );
}

export default function SetupForecasts() {
  const [data, setData] = useState<SetupForecastResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fSymbol, setFSymbol] = useState('');
  const [fTimeframe, setFTimeframe] = useState('');
  const [fScenario, setFScenario] = useState('');
  const [fStrategy, setFStrategy] = useState('');
  const [fMinScore, setFMinScore] = useState(0);
  const [fGrade, setFGrade] = useState('');
  const [fLevelType, setFLevelType] = useState('');
  const [fSource, setFSource] = useState('');
  const [showLab, setShowLab] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<{ done: number; total: number } | null>(null);
  const [rates, setRates] = useState<StrategyRatesResponse | null>(null);
  const [rateRange, setRateRange] = useState('30d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [perfectOnly, setPerfectOnly] = useState(false);
  const [rateErr, setRateErr] = useState<string | null>(null);
  const [tab, setTab] = useState<'forecasts' | 'tracked' | 'orders' | 'report'>('forecasts');
  const [trackedIds, setTrackedIds] = useState<Set<string>>(new Set());
  const [placing, setPlacing] = useState<string | null>(null);
  const [placed, setPlaced] = useState<string | null>(null);

  const load = useCallback(async (spin = false) => {
    if (spin) setLoading(true);
    try { setData(await fetchSetupForecasts()); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed to load forecasts'); }
    finally { setLoading(false); }
  }, []);

  /**
   * Rest a limit at the forecast level. Identical call to the Tracked tab's — same endpoint, same
   * server-side gates — so there is one execution path, not two that could drift apart.
   *
   * Placing also pins the forecast (the server does this), which is why the local tracked set is
   * updated: the card should read "Tracked" immediately rather than after the next poll.
   */
  const onPlaceOrder = async (id: string) => {
    setPlacing(id); setErr(null); setPlaced(null);
    try {
      const r = await placeForecastOrder(id);
      setPlaced(`${r.direction} limit resting at ${r.entry} · ${r.lots} lots · expires in ${r.expiresInMinutes} min.`
        + (r.warnings?.length ? ` Warnings: ${r.warnings.join('; ')}` : ''));
      setTrackedIds((prev) => new Set(prev).add(id));
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not place the order'); }
    finally { setPlacing(null); }
  };

  useEffect(() => {
    load(true);
    const t = setInterval(() => load(false), 60000);
    return () => clearInterval(t);
  }, [load]);

  // Match rates drive both the star and the "perfect only" filter, so they reload whenever the
  // window changes. A custom range with no dates yet is not requested.
  useEffect(() => {
    if (rateRange === 'custom' && (!customFrom || !customTo)) return;
    let alive = true;
    fetchStrategyRates(rateRange, customFrom || undefined, customTo || undefined)
      .then((r) => { if (alive) { setRates(r); setRateErr(null); } })
      .catch((e) => { if (alive) setRateErr(e instanceof Error ? e.message : 'rates failed'); });
    return () => { alive = false; };
  }, [rateRange, customFrom, customTo]);

  const perfect = useMemo(() => new Set(rates?.perfect || []), [rates]);

  // Which forecasts are already pinned, so the button reads correctly on first paint.
  useEffect(() => {
    let alive = true;
    fetchTrackedForecasts()
      .then((r) => { if (alive) setTrackedIds(new Set((r.tracked || []).map((t) => t.id))); })
      .catch(() => { /* the button still works; it just starts unlit */ });
    return () => { alive = false; };
  }, [tab]);

  const onTrack = async (id: string, on: boolean) => {
    // Optimistic: the pin should feel instant, and a failure puts it straight back.
    setTrackedIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
    try { await trackForecast(id, on); }
    catch {
      setTrackedIds((prev) => {
        const next = new Set(prev);
        if (on) next.delete(id); else next.add(id);
        return next;
      });
    }
  };

  const toggle = (id: string, on: boolean) => setSelected((prev) => {
    const next = new Set(prev);
    if (on) next.add(id); else next.delete(id);
    return next;
  });

  // Bulk AI review. Sequential and capped: each one is a paid model call, and firing twenty in
  // parallel would burn quota and rate-limit itself.
  const bulkAnalyse = async () => {
    const ids = [...selected].slice(0, 20);
    if (!ids.length) return;
    setBulkBusy({ done: 0, total: ids.length });
    for (let i = 0; i < ids.length; i++) {
      try { await analyseForecastWithAi(ids[i]); } catch { /* keep going; one failure is not fatal */ }
      setBulkBusy({ done: i + 1, total: ids.length });
    }
    setBulkBusy(null);
    await load(false);
  };

  const all = useMemo(() => (data?.buckets || []).flatMap((b) => b.forecasts), [data]);
  const uniq = (pick: (f: SetupForecast) => string | null) =>
    Array.from(new Set(all.map(pick).filter(Boolean) as string[])).sort();
  const match = (f: SetupForecast) => (
    (!fSymbol || f.symbol === fSymbol)
    && (!fTimeframe || f.timeframe === fTimeframe)
    && (!fScenario || f.scenario === fScenario)
    && (!fStrategy || f.fires.some((x) => x.strategyId === fStrategy))
    && (f.bestScore ?? 0) >= fMinScore
    && (!fGrade || f.grade === fGrade)
    && (!fLevelType || f.levelType === fLevelType)
    // A level counts as matching a source if ANY of its sources is that family — a PDH that is
    // also an order block edge belongs to both filters, not only the one that named it first.
    && (!fSource || (f.levelSources || []).includes(fSource))
    && (!perfectOnly || f.fires.some((x) => perfect.has(x.strategyId)))
  );
  const filtersActive = Boolean(fSymbol || fTimeframe || fScenario || fStrategy || fMinScore > 0 || fGrade || fLevelType || perfectOnly);

  const disc = data?.discrimination || [];
  const dropped = disc.filter((d) => d.verdict === 'SHAPE_DRIVEN');
  const silent = disc.filter((d) => d.verdict === 'SILENT');

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 pb-24">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-black text-slate-900">
            <Crosshair size={22} className="text-violet-500" />Setup Forecasts
          </h1>
          <p className="text-sm font-semibold text-slate-500">
            Conditional predictions: if price reaches a key level and behaves a specific way, which strategies would fire — by their own rules.
            Current live setups belong on the signal pages; this looks ahead.
          </p>
        </div>
        <button onClick={() => load(true)} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-bold text-slate-600 hover:bg-slate-50">
          {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}Refresh
        </button>
      </div>

      {err && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-600">{err}</div>}

      <div className="flex gap-1.5 rounded-2xl border border-slate-200 bg-white p-1.5">
        {([['forecasts', 'Forecasts', Crosshair], ['tracked', 'Tracked', Activity], ['orders', 'Pending orders', ListOrdered], ['report', 'Report', BarChart3]] as const).map(([k, label, Icon]) => (
          <button key={k} type="button" onClick={() => setTab(k)}
            className={`inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-bold transition-all ${
              tab === k ? 'border border-violet-200 bg-violet-50 text-violet-700' : 'text-slate-500 hover:bg-slate-50'
            }`}>
            <Icon size={15} />{label}
            {k === 'tracked' && trackedIds.size > 0 ? (
              <span className="rounded-full bg-violet-600 px-1.5 text-[10px] font-black text-white">{trackedIds.size}</span>
            ) : null}
          </button>
        ))}
      </div>

      {tab === 'tracked' ? <TrackedTab /> : tab === 'orders' ? <PendingOrdersTab />
        : tab === 'report' ? <SetupForecastReport embedded /> : (<>

      {/* Outcome of a Place limit from a forecast card. Errors here are the server's refusals
          (wrong side of market, challenge guard, concurrency) and are the most useful thing on
          the page when they fire, so they get a banner rather than a toast that disappears. */}
      {err ? <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-[12px] font-bold text-rose-600">{err}</div> : null}
      {placed ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-[12px] font-bold text-emerald-700">
          {placed}
          <button type="button" onClick={() => setTab('orders')} className="underline hover:text-emerald-900">see it in Pending orders</button>
        </div>
      ) : null}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
        {([
          ['Symbol', fSymbol, setFSymbol, uniq((f) => f.symbol)],
          ['TF', fTimeframe, setFTimeframe, uniq((f) => f.timeframe)],
          ['Scenario', fScenario, setFScenario, uniq((f) => f.scenario)],
          ['Level', fLevelType, setFLevelType, uniq((f) => f.levelType)],
          ['Source', fSource, setFSource, Array.from(new Set(all.flatMap((f) => f.levelSources || []))).sort()],
          ['Strategy', fStrategy, setFStrategy, uniq((f) => f.fires.map((x) => x.strategyId)).length ? Array.from(new Set(all.flatMap((f) => f.fires.map((x) => x.strategyId)))).sort() : []],
        ] as Array<[string, string, (v: string) => void, string[]]>).map(([label, value, set, opts]) => (
          <label key={label} className="flex items-center gap-1 text-[11px] font-bold text-slate-500">
            {label}
            <select value={value} onChange={(e) => set(e.target.value)} className="rounded-md border border-slate-200 bg-slate-50 px-1.5 py-1 text-[11px] font-bold text-slate-700">
              <option value="">All</option>
              {opts.map((o) => <option key={o} value={o}>{SCENARIO_META[o]?.label || LEVEL_LABEL[o] || o}</option>)}
            </select>
          </label>
        ))}
        <label className="flex items-center gap-1 text-[11px] font-bold text-slate-500">
          Grade
          <select value={fGrade} onChange={(e) => setFGrade(e.target.value)}
            className="rounded-md border border-slate-200 bg-slate-50 px-1.5 py-1 text-[11px] font-bold text-slate-700">
            <option value="">All</option>
            {['A+', 'A', 'B', 'C'].map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1 text-[11px] font-bold text-slate-500">
          Min score
          <input type="number" min={0} max={100} value={fMinScore || ''} placeholder="0"
            onChange={(e) => setFMinScore(Number(e.target.value) || 0)}
            className="w-14 rounded-md border border-slate-200 bg-slate-50 px-1.5 py-1 text-[11px] font-bold text-slate-700" />
        </label>
        {filtersActive && (
          <button onClick={() => { setFSymbol(''); setFTimeframe(''); setFScenario(''); setFStrategy(''); setFMinScore(0); }}
            className="ml-auto text-[11px] font-bold text-violet-600 hover:underline">Clear filters</button>
        )}
        <span className="ml-auto text-[10px] font-medium text-slate-400">
          {data?.lastScan ? `scanned ${new Date(data.lastScan.at).toLocaleTimeString()} · ${data.lastScan.forecasts} forecasts · rescans every 15m` : 'no scan yet'}
        </span>
      </div>

      {/* Track-record filter. The window is explicit because "100%" means nothing without one. */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50/50 px-3 py-2">
        <span className="inline-flex items-center gap-1 text-[11px] font-black uppercase tracking-wider text-amber-800">
          <Star size={12} className="fill-amber-400 text-amber-500" />Perfect record
        </span>
        <select value={rateRange} onChange={(e) => setRateRange(e.target.value)}
          className="rounded-md border border-amber-200 bg-white px-1.5 py-1 text-[11px] font-bold text-slate-700">
          <option value="today">Today</option>
          <option value="yesterday">Yesterday</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="custom">Custom range</option>
        </select>
        {rateRange === 'custom' ? (
          <>
            <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)}
              className="rounded-md border border-amber-200 bg-white px-1.5 py-1 text-[11px] font-bold text-slate-700" />
            <span className="text-[11px] font-bold text-slate-400">to</span>
            <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)}
              className="rounded-md border border-amber-200 bg-white px-1.5 py-1 text-[11px] font-bold text-slate-700" />
          </>
        ) : null}
        <label className="flex items-center gap-1 text-[11px] font-bold text-slate-600">
          <input type="checkbox" checked={perfectOnly} onChange={(e) => setPerfectOnly(e.target.checked)} />
          only starred strategies
        </label>
        <span className="text-[10px] font-semibold text-slate-500">
          {rateErr ? <span className="text-rose-600">{rateErr}</span>
            : rates ? (
              rates.perfect.length
                ? `${rates.perfect.length} starred (${rates.perfect.join(', ')}) · ${rates.resolved} resolved ${rates.label}`
                : `no strategy is at 100% over ${rates.label} — ${rates.resolved} forecasts resolved`
            ) : 'loading…'}
        </span>
        {/* A star must mean something. Saying the bar out loud stops "100%" being read as proof. */}
        {rates ? (
          <span className="w-full text-[10px] font-medium text-slate-400">{rates.note}</span>
        ) : null}
      </div>

      {/* Bulk actions — only present once something is selected. */}
      {selected.size > 0 && (
        <div className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-violet-300 bg-violet-50 px-3 py-2 shadow-sm">
          <span className="text-[12px] font-black text-violet-800">{selected.size} selected</span>
          <button onClick={bulkAnalyse} disabled={bulkBusy !== null}
            className="inline-flex items-center gap-1 rounded-lg bg-violet-600 px-3 py-1.5 text-[11px] font-black text-white hover:bg-violet-700 disabled:opacity-50">
            {bulkBusy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            {bulkBusy ? `Analysing ${bulkBusy.done}/${bulkBusy.total}…` : `AI analyse ${Math.min(selected.size, 20)}`}
          </button>
          <button onClick={() => setSelected(new Set())} disabled={bulkBusy !== null}
            className="text-[11px] font-bold text-slate-500 hover:text-slate-800 disabled:opacity-50">clear</button>
          {selected.size > 20 ? (
            <span className="text-[10px] font-bold text-amber-700">capped at 20 per run — each is a paid model call</span>
          ) : null}
        </div>
      )}

      {/* Horizon buckets — the requested grouping, closest first, empty buckets visible */}
      {(data?.buckets || []).map((b) => {
        const rows = b.forecasts.filter(match);
        return (
          <section key={b.key}>
            <h2 className="mb-2 flex items-center gap-2 text-sm font-black uppercase tracking-wider text-slate-600">
              <Clock size={14} className="text-violet-400" />{b.label}
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">{rows.length}</span>
              {rows.length ? (
                <button
                  type="button"
                  onClick={() => {
                    const allOn = rows.every((f) => selected.has(f.id));
                    setSelected((prev) => {
                      const next = new Set(prev);
                      rows.forEach((f) => (allOn ? next.delete(f.id) : next.add(f.id)));
                      return next;
                    });
                  }}
                  className="text-[10px] font-bold normal-case tracking-normal text-violet-600 hover:underline"
                >
                  {rows.every((f) => selected.has(f.id)) ? 'deselect all' : 'select all'}
                </button>
              ) : null}
            </h2>
            {rows.length ? (
              <div className="space-y-2">{rows.map((f) => (
                <ForecastCard key={f.id} f={f} selected={selected.has(f.id)} onSelect={toggle} perfect={perfect}
                  tracked={trackedIds.has(f.id)} onTrack={onTrack}
                  onPlace={onPlaceOrder} placing={placing === f.id} />
              ))}</div>
            ) : (
              <p className="rounded-xl border border-dashed border-slate-200 px-4 py-3 text-[12px] font-semibold text-slate-400">
                {filtersActive ? 'Nothing in this window matches the filters.' : 'No forecastable setup in this window right now.'}
              </p>
            )}
          </section>
        );
      })}

      {/* Why some strategies are absent — the measured evidence, not a silent omission */}
      <section className="rounded-xl border border-slate-200 bg-white px-4 py-3">
        <button type="button" onClick={() => setShowLab(!showLab)} className="flex w-full items-center gap-2 text-left">
          <FlaskConical size={15} className="text-violet-500" />
          <span className="text-sm font-black text-slate-700">Strategy participation</span>
          <span className="text-[11px] font-semibold text-slate-400">
            {dropped.length} excluded (fire on bar shape, not levels) · {silent.length} cannot be forecast this way
          </span>
          {showLab ? <ChevronUp size={15} className="ml-auto text-slate-400" /> : <ChevronDown size={15} className="ml-auto text-slate-400" />}
        </button>
        {showLab && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[11px]">
              <thead>
                <tr className="border-b border-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  <th className="py-1 pr-3">Strategy</th><th className="py-1 pr-3">Verdict</th>
                  <th className="py-1 pr-3">Fires at levels</th><th className="py-1 pr-3">Fires at random prices</th>
                  <th className="py-1 pr-3">Lift</th><th className="py-1">Evidence</th>
                </tr>
              </thead>
              <tbody>
                {disc.map((d) => (
                  <tr key={d.strategyId} className="border-b border-slate-50 font-semibold text-slate-600">
                    <td className="py-1 pr-3">{d.strategyId}</td>
                    <td className="py-1 pr-3">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                        d.verdict === 'LEVEL_DRIVEN' ? 'bg-emerald-50 text-emerald-700'
                          : d.verdict === 'SHAPE_DRIVEN' ? 'bg-rose-50 text-rose-600'
                            : d.verdict === 'SILENT' ? 'bg-slate-100 text-slate-500' : 'bg-amber-50 text-amber-700'
                      }`}>
                        {d.verdict === 'SILENT' ? 'NEEDS MORE BARS' : d.verdict.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="py-1 pr-3">{Math.round(d.realRate * 100)}%</td>
                    <td className="py-1 pr-3">{Math.round(d.placeboRate * 100)}%</td>
                    <td className="py-1 pr-3">{d.levelOnly ? 'level-only' : d.lift !== null ? `${d.lift}×` : '—'}</td>
                    <td className="py-1 text-slate-400">{d.realScenarios}r / {d.placeboScenarios}p scenarios</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      </>)}

      {tab === 'forecasts' && (data?.caveats?.length || 0) > 0 && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
          {data!.caveats.map((c, i) => (
            <p key={i} className="flex items-start gap-1.5 text-[11px] font-semibold text-slate-500">
              <Info size={12} className="mt-0.5 shrink-0 text-slate-400" />{c}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
