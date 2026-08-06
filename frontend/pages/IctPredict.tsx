import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Crosshair, Loader2, RefreshCw, ArrowUp, ArrowDown, Clock, ChevronDown, ChevronUp,
  Sparkles, AlertTriangle, CheckCircle2, XCircle, Minus, Bookmark, BookmarkCheck, Activity,
  Send, Ban, Pencil, ListOrdered, BarChart3, ShieldAlert, Target, Zap, Info, Layers, Scale,
} from 'lucide-react';
import {
  fetchIctPredictions, trackIctPrediction, fetchTrackedIctPredictions,
  placeIctOrder, fetchIctPendingOrders, cancelIctOrder,
  fetchIctTrackRecord, analyseIctPredictionWithAi, scanIctPredictions,
} from '../mt5Api';
import IctResizePanel from '../components/IctResizePanel';
import OrderModifyPanel from '../components/OrderModifyPanel';
import type { IctResizeInput } from '../mt5Api';
import type {
  IctPrediction, IctPredictionResponse, IctTrackedResponse, IctTrackedPrediction,
  IctPendingResponse, IctTrackRecordResponse, IctAiResponse, IctGate,
} from '../types';

// ICT Predict — projected sweep → breaker setups, ict-breaker and ict-break-pro only.
//
// The honesty problem this page has to solve: none of this has happened. The pool, the structure
// and the target are real; the path between them is constructed. So every surface here separates
// what was MEASURED from what was ASSUMED, and the score is never presented as a probability.

const digitsFor = (s: string) => {
  const u = (s || '').toUpperCase();
  if (/XAU|GOLD|XAG/.test(u)) return 2;
  if (u.includes('JPY')) return 3;
  if (/USTEC|NAS|US30|SPX|GER/.test(u)) return 1;
  return 5;
};
const px = (v: number | null | undefined, sym: string) =>
  (v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(digitsFor(sym)));

const SETUP_META: Record<string, { label: string; blurb: string }> = {
  BULLISH_BREAKER: {
    label: 'Bullish breaker',
    blurb: 'sell-side liquidity taken below the swing low, then a close back above the prior swing high',
  },
  BEARISH_BREAKER: {
    label: 'Bearish breaker',
    blurb: 'buy-side liquidity taken above the swing high, then a close back below the prior swing low',
  },
};

const etaText = (p: IctPrediction) => {
  const a = p.eta?.minMinutes, b = p.eta?.maxMinutes;
  if (a === null || a === undefined || b === null || b === undefined) return '—';
  const fmt = (m: number) => (m >= 90 ? `${Math.round(m / 6) / 10}h` : `${Math.round(m)}m`);
  return `${fmt(a)}–${fmt(b)}`;
};

const gradeCls = (g: string | null) => (
  g === 'A+' ? 'bg-emerald-600 text-white'
    : g === 'A' ? 'bg-emerald-100 text-emerald-800'
      : g === 'B' ? 'bg-amber-100 text-amber-800'
        : 'bg-slate-100 text-slate-600');

/**
 * A gate row, or a bonus row.
 *
 * The distinction is not cosmetic. A failed GATE means the setup was rejected; an unearned BONUS
 * means only that a score point was not added. Marking both with a red cross read as "two things
 * are wrong here" on a setup that had in fact passed everything that can reject it.
 */
function GateRow({ g, bonus = false }: { g: IctGate; bonus?: boolean }) {
  const icon = g.pass === null
    ? <Info size={12} className="mt-0.5 shrink-0 text-slate-300" />
    : g.pass
      ? <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-emerald-500" />
      : bonus
        ? <Minus size={12} className="mt-0.5 shrink-0 text-slate-300" />
        : <XCircle size={12} className="mt-0.5 shrink-0 text-rose-500" />;
  return (
    <li className="flex items-start gap-1.5">
      {icon}
      <span className="text-[11px] font-semibold text-slate-600">
        {g.label} <b className={g.pass === false && !bonus ? 'text-rose-600' : 'text-slate-800'}>{g.value ?? 'not measured'}</b>
        <span className="font-medium text-slate-400"> — {g.detail}{bonus && g.pass === false ? ' (not earned)' : ''}</span>
      </span>
    </li>
  );
}

/** The projected sequence, drawn small. The whole feature rests on it, so it must be inspectable. */
function ProjectedBars({ p }: { p: IctPrediction }) {
  const bars = p.projectedBars || [];
  if (!bars.length) return null;
  const lows = bars.map((b) => b.low), highs = bars.map((b) => b.high);
  const lo = Math.min(...lows, p.level), hi = Math.max(...highs, p.level, p.structureLevel);
  const span = hi - lo || 1;
  // Slot width carries the LABEL, not the candle: at 34px the words "displacement" and "reclaim"
  // ran into each other and read as one string.
  const W = 20, H = 110, gap = 32;
  const y = (v: number) => H - ((v - lo) / span) * H;
  const names = ['sweep', ...Array(Math.max(0, bars.length - 3)).fill('drive'), 'displace', 'reclaim'];
  return (
    <div className="overflow-x-auto">
      <div className="inline-flex flex-col gap-1">
        <svg width={bars.length * (W + gap)} height={H + 4} className="shrink-0">
          {/* The two REAL prices in the picture. Everything else is the construction. */}
          <line x1={0} x2={bars.length * (W + gap)} y1={y(p.level)} y2={y(p.level)} stroke="#f43f5e" strokeWidth="1" strokeDasharray="3 3" />
          <line x1={0} x2={bars.length * (W + gap)} y1={y(p.structureLevel)} y2={y(p.structureLevel)} stroke="#0ea5e9" strokeWidth="1" strokeDasharray="3 3" />
          {bars.map((b, i) => {
            const x = i * (W + gap) + gap / 2;
            const up = b.close >= b.open;
            const top = y(Math.max(b.open, b.close));
            const bot = y(Math.min(b.open, b.close));
            return (
              <g key={b.time || i}>
                <line x1={x + W / 2} x2={x + W / 2} y1={y(b.high)} y2={y(b.low)} stroke={up ? '#059669' : '#e11d48'} strokeWidth="1.5" />
                <rect x={x} y={top} width={W} height={Math.max(2, bot - top)} fill={up ? '#059669' : '#e11d48'} opacity={0.85} />
              </g>
            );
          })}
        </svg>
        <div className="flex" style={{ width: bars.length * (W + gap) }}>
          {bars.map((b, i) => (
            <span key={b.time || i} className="text-center text-[9px] font-bold uppercase tracking-wide text-slate-400" style={{ width: W + gap }}>
              {names[i] || 'bar'}
            </span>
          ))}
        </div>
      </div>
      <p className="mt-1 text-[10px] font-semibold text-slate-400">
        <span className="text-rose-500">▬</span> pool {px(p.level, p.symbol)} ·
        <span className="ml-1 text-sky-500">▬</span> structure to reclaim {px(p.structureLevel, p.symbol)}
        {' · '}these bars are CONSTRUCTED from the level and ATR — they have not happened
        {p.projection?.overshootAtr ? ` · reclaim overshoots by ${p.projection.overshootAtr}× ATR` : ''}
      </p>
    </div>
  );
}

function AiPanel({ data, symbol }: { data: IctAiResponse; symbol: string }) {
  const ai = data.ai;
  if (!ai.available) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
        <p className="text-[11px] font-bold text-slate-500">AI review unavailable</p>
        <p className="text-[11px] font-semibold text-slate-400">{ai.summary || ai.reason}</p>
      </div>
    );
  }
  const buy = ai.direction === 'BUY';
  const verdictStyle: Record<string, string> = {
    TAKE: 'bg-emerald-100 text-emerald-800', WATCH: 'bg-amber-100 text-amber-800', SKIP: 'bg-rose-100 text-rose-700',
  };
  const sweepStyle: Record<string, string> = {
    REJECT: 'bg-emerald-50 text-emerald-700', ACCEPT: 'bg-rose-50 text-rose-700', UNCLEAR: 'bg-slate-100 text-slate-500',
  };
  return (
    <div className="space-y-2 rounded-lg border border-violet-200 bg-violet-50/50 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-violet-700">
          <Sparkles size={12} />ICT AI review
        </span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${verdictStyle[ai.verdict || 'WATCH'] || 'bg-slate-100 text-slate-600'}`}>{ai.verdict}</span>
        {ai.direction && ai.direction !== 'NO_TRADE'
          ? <span className={`text-[11px] font-black ${buy ? 'text-emerald-700' : 'text-rose-600'}`}>{ai.direction}</span>
          : <span className="text-[11px] font-black text-slate-500">NO TRADE</span>}
        <span className="text-[11px] font-bold text-violet-800">score {ai.score ?? '—'}</span>
        {/* The ICT question, answered. This is the line that matters most on this panel. */}
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${sweepStyle[ai.sweepOutcome || 'UNCLEAR']}`}>
          sweep {ai.sweepOutcome === 'REJECT' ? 'fails → reversal' : ai.sweepOutcome === 'ACCEPT' ? 'succeeds → continuation' : 'unclear'}
        </span>
        <span className="text-[10px] font-semibold text-slate-500">reach {ai.reachLikelihood} · {ai.confidence} confidence</span>
        <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold ${ai.agreesWithSystem ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
          {ai.agreesWithSystem ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
          {ai.agreesWithSystem ? 'agrees with the engines' : 'disagrees with the engines'}
        </span>
        {data.cached ? <span className="text-[10px] font-medium text-slate-400">cached</span> : null}
      </div>

      {ai.direction !== 'NO_TRADE' && (ai.entry || ai.stopLoss) ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] font-semibold text-slate-700 sm:grid-cols-4">
          <span>Entry <b>{px(ai.entry ?? null, symbol)}</b> <span className="text-[10px] text-slate-400">{ai.orderType}</span></span>
          <span>SL <b className="text-rose-600">{px(ai.stopLoss ?? null, symbol)}</b>{ai.stopPips ? ` (${ai.stopPips}p)` : ''}</span>
          <span>TP1 <b className="text-emerald-600">{px(ai.takeProfit1 ?? null, symbol)}</b></span>
          <span>RR <b>{ai.rr ?? '—'}</b></span>
        </div>
      ) : null}

      {(ai.issues?.length || 0) > 0 && (
        <div className="rounded border border-amber-300 bg-amber-50 px-2 py-1.5">
          <p className="flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-amber-800">
            <AlertTriangle size={11} />ticket failed validation — not tradable as returned
          </p>
          {ai.issues!.map((i) => <p key={i} className="text-[11px] font-semibold text-amber-800">· {i}</p>)}
        </div>
      )}

      {ai.rationale ? <p className="text-[11.5px] font-semibold leading-snug text-slate-700">{ai.rationale}</p> : null}
      {ai.drawOnLiquidity ? (
        <p className="text-[11px] font-semibold text-slate-500"><b className="text-slate-600">Draw:</b> {ai.drawOnLiquidity}</p>
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
      {data.saw?.chartPng ? (
        <details>
          <summary className="cursor-pointer text-[10px] font-bold text-violet-600 hover:underline">
            Chart the AI looked at ({data.saw.bars} real candles — the projected bars were withheld)
          </summary>
          <img src={data.saw.chartPng} alt="chart analysed by the AI" className="mt-1 w-full rounded border border-slate-200" />
        </details>
      ) : null}
      <p className="text-[10px] font-medium text-slate-400">
        {data.model} · the model was told which score components were assumed · never trades, never emails
      </p>
    </div>
  );
}

function PredictionCard({
  p, tracked, onTrack, onPlace, placing,
}: {
  p: IctPrediction; tracked: boolean;
  onTrack: (id: string, on: boolean) => void;
  onPlace: (id: string, override?: IctResizeInput) => void;
  placing: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [ai, setAi] = useState<IctAiResponse | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState<string | null>(null);
  const [confirmPlace, setConfirmPlace] = useState(false);
  const [resizing, setResizing] = useState(false);
  const buy = p.direction === 'BUY';
  const meta = SETUP_META[p.setup] || { label: p.setup, blurb: '' };
  const lo = p.limitOrder;
  const sz = p.sizing;

  const runAi = async () => {
    setAiBusy(true); setAiErr(null);
    try { setAi(await analyseIctPredictionWithAi(p.id)); }
    catch (e) { setAiErr(e instanceof Error ? e.message : 'AI review failed'); }
    finally { setAiBusy(false); }
  };

  return (
    <div className={`rounded-2xl border bg-white px-4 py-3 shadow-sm ${p.proQualified ? 'border-emerald-300' : 'border-slate-200'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[12px] font-black ${buy ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-600'}`}>
          {buy ? <ArrowUp size={13} /> : <ArrowDown size={13} />}{p.direction}
        </span>
        <span className="text-[14px] font-black text-slate-900">{p.symbol}</span>
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-bold text-slate-600">{p.timeframe}</span>
        <span className="text-[12px] font-bold text-slate-600">{meta.label}</span>
        {p.proQualified ? (
          <span className="inline-flex items-center gap-1 rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-black text-white"
            title="Cleared the ict-break-pro overlay — validated out-of-sample at 92% win vs an 88% baseline, keeping about one signal in three">
            <Zap size={10} />PRO
          </span>
        ) : null}
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${gradeCls(p.grade)}`}>{p.grade || '—'}</span>
        <span className="text-[12px] font-bold text-slate-700">{p.bestScore ?? '—'}</span>
        <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-slate-500">
          <Clock size={12} />{etaText(p)}
        </span>
      </div>

      <p className="mt-1.5 text-[12px] font-semibold text-slate-600">
        Sweep <b className="text-slate-900">{px(p.level, p.symbol)}</b>
        {p.levelLabel ? <span className="text-slate-400"> ({p.levelLabel})</span> : null}
        {' → reclaim '}<b className="text-slate-900">{px(p.structureLevel, p.symbol)}</b>
        <span className="text-slate-400"> · {meta.blurb}</span>
      </p>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] font-semibold text-slate-600">
        <span><b className="text-slate-900">{p.distance?.pips ?? '—'}</b> pips away <span className="text-slate-400">({p.distance?.atr ?? '—'}× ATR)</span></span>
        <span>RR <b className="text-slate-900">{p.rr ?? '—'}</b></span>
        <span className="text-slate-400">{p.bestStrategy}</span>
      </div>

      {/* The resting order, which is the actionable output of the whole page. */}
      {lo ? (
        <div className={`mt-2 rounded-lg border px-3 py-2 ${p.placeable === false ? 'border-amber-300 bg-amber-50' : 'border-sky-200 bg-sky-50/60'}`}>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] font-bold text-slate-700">
            <span className="inline-flex items-center gap-1 rounded bg-sky-600 px-1.5 py-0.5 text-[10px] font-black text-white">
              <ListOrdered size={10} />{lo.type.replace('_', ' ')}
            </span>
            <span>at <b>{px(lo.entry, p.symbol)}</b></span>
            <span>SL <b className="text-rose-600">{px(lo.stopLoss, p.symbol)}</b>{lo.stopPips ? ` (${lo.stopPips}p)` : ''}</span>
            <span>TP <b className="text-emerald-600">{px(lo.takeProfit1, p.symbol)}</b> / {px(lo.takeProfit2, p.symbol)} / {px(lo.takeProfit3, p.symbol)}</span>
            <span>RR <b>{lo.rr ?? '—'}</b></span>
          </p>

          {/* Position size. Without it the row shows a price and a stop but not what the trade
              would actually cost, which is the number that decides whether you take it. */}
          {sz && sz.lots ? (
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] font-bold text-slate-700">
              <span className="inline-flex items-center gap-1 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-black text-white">
                <Scale size={10} />{sz.lots} lots
              </span>
              <span>risk <b className={sz.overBudget ? 'text-rose-600' : 'text-slate-900'}>${sz.lossAtStop}</b>
                {sz.riskBudget ? <span className="font-semibold text-slate-400"> / ${sz.riskBudget} budget</span> : null}</span>
              {sz.profitAtTp !== null && sz.profitAtTp !== undefined
                ? <span>@TP1 <b className="text-emerald-700">${sz.profitAtTp}</b></span> : null}
              {sz.profitAtFinalTp !== null && sz.profitAtFinalTp !== undefined
                ? <span>@TP3 <b className="text-emerald-700">${sz.profitAtFinalTp}</b></span> : null}
              {sz.minForced ? <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-black text-amber-800">broker minimum lot — risk exceeds budget</span> : null}
            </p>
          ) : sz?.unavailable ? (
            <p className="mt-1 text-[11px] font-bold text-amber-800">Not sized: {sz.unavailable}</p>
          ) : null}

          {(sz?.warnings?.length || 0) > 0 && (
            <p className="mt-1 flex items-start gap-1 text-[11px] font-bold text-amber-800">
              <ShieldAlert size={12} className="mt-0.5 shrink-0" />{sz!.warnings!.join(' · ')}
            </p>
          )}

          {p.placeable === false ? (
            <p className="mt-1 flex items-start gap-1 text-[11px] font-bold text-amber-800">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />{p.placeableNote}
            </p>
          ) : (
            <p className="mt-0.5 text-[10px] font-semibold text-slate-500">
              Anchored to the real level, with the stop beyond the projected sweep. Fills only if price trades into the
              liquidity. Size is from your challenge budget at scan time and is re-checked when you place.
            </p>
          )}
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button onClick={() => onTrack(p.id, !tracked)}
          className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-bold ${tracked ? 'bg-violet-600 text-white' : 'border border-slate-200 text-slate-600 hover:border-violet-300 hover:text-violet-600'}`}>
          {tracked ? <BookmarkCheck size={12} /> : <Bookmark size={12} />}{tracked ? 'Tracked' : 'Track'}
        </button>
        {/* Two steps, deliberately. This sends a REAL order to the broker, and it sits next to
            Track and the AI button on a list of forty rows — a single misplaced click was enough
            to queue one during testing. The second click is the confirmation. */}
        <button onClick={() => (confirmPlace ? onPlace(p.id) : setConfirmPlace(true))}
          onBlur={() => setConfirmPlace(false)}
          disabled={!lo || placing || p.placeable === false}
          className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-bold disabled:opacity-40 ${confirmPlace ? 'bg-sky-600 text-white' : 'border border-slate-200 text-slate-600 hover:border-sky-300 hover:text-sky-600'}`}>
          {placing ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
          {confirmPlace ? `Confirm ${lo?.type.replace('_', ' ').toLowerCase()} at ${px(lo?.entry, p.symbol)}` : 'Place limit'}
        </button>
        <button onClick={runAi} disabled={aiBusy}
          className="inline-flex items-center gap-1 rounded-lg border border-violet-200 px-2 py-1 text-[11px] font-bold text-violet-600 hover:bg-violet-50 disabled:opacity-40">
          {aiBusy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}ICT AI analysis
        </button>
        <button onClick={() => setResizing((v) => !v)} disabled={!lo || p.placeable === false}
          className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-bold disabled:opacity-40 ${resizing ? 'bg-slate-900 text-white' : 'border border-slate-200 text-slate-600 hover:border-slate-400'}`}>
          <Scale size={12} />Resize
        </button>
        <button onClick={() => setOpen((v) => !v)}
          className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-slate-400 hover:text-slate-600">
          {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}{open ? 'Hide' : 'Measurements & projection'}
        </button>
      </div>

      {resizing && lo && (
        <IctResizePanel id={p.id} symbol={p.symbol} onPlace={onPlace} placing={placing} />
      )}

      {aiErr ? <p className="mt-2 text-[11px] font-bold text-rose-600">{aiErr}</p> : null}
      {ai ? <div className="mt-2"><AiPanel data={ai} symbol={p.symbol} /></div> : null}

      {open ? (
        <div className="mt-3 grid gap-3 border-t border-slate-100 pt-3 lg:grid-cols-2">
          <div className="space-y-2">
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">PRO overlay gates</p>
            <ul className="space-y-1">{(p.measurements?.gates || []).map((g) => <GateRow key={g.label} g={g} />)}</ul>
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Bonuses (score only, never gates)</p>
            <ul className="space-y-1">{(p.measurements?.bonuses || []).map((g) => <GateRow key={g.label} g={g} bonus />)}</ul>

            {/* Not decoration. Two of the five score components are decided by the projection's
                geometry, and a score printed without that caveat reads as evidence. */}
            {p.scoreBasis ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-2.5 py-2">
                <p className="text-[10px] font-black uppercase tracking-wider text-amber-800">Where the {p.bestScore} comes from</p>
                <p className="mt-0.5 text-[10px] font-black text-amber-900">ASSUMED by the projection</p>
                {p.scoreBasis.assumed.map((x) => <p key={x} className="text-[11px] font-semibold text-amber-800">· {x}</p>)}
                <p className="mt-1 text-[10px] font-black text-emerald-800">MEASURED from the market</p>
                {p.scoreBasis.measured.map((x) => <p key={x} className="text-[11px] font-semibold text-emerald-800">· {x}</p>)}
                <p className="mt-1 text-[11px] font-bold text-amber-900">{p.scoreBasis.caution}</p>
              </div>
            ) : null}

            {(p.refused?.length || 0) > 0 && (
              <div>
                <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Did not fire</p>
                {p.refused.map((r) => (
                  <p key={r.strategyId} className="text-[11px] font-semibold text-slate-500">
                    <b>{r.strategyId}</b> — {r.reason}
                  </p>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">The projected sequence</p>
            <ProjectedBars p={p} />
            {p.strategyPlan ? (
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2">
                <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                  {p.strategyPlan.strategyId || p.bestStrategy}'s own entry ({p.strategyPlan.orderType})
                </p>
                <p className="text-[11.5px] font-bold text-slate-700">
                  {p.strategyPlan.direction} {px(p.strategyPlan.entry, p.symbol)} · SL <span className="text-rose-600">{px(p.strategyPlan.stopLoss, p.symbol)}</span>
                  {' · TP '}<span className="text-emerald-600">{px(p.strategyPlan.takeProfit1, p.symbol)}</span> / {px(p.strategyPlan.takeProfit2, p.symbol)} / {px(p.strategyPlan.takeProfit3, p.symbol)}
                  {' · RR '}{p.strategyPlan.rr ?? '—'}
                </p>
                <p className="mt-0.5 text-[10px] font-semibold text-slate-400">{p.strategyPlan.note}</p>
              </div>
            ) : null}
            {p.fires.map((f) => (
              <p key={f.strategyId} className="text-[11px] font-semibold text-slate-500">
                <b className="text-slate-700">{f.strategyId}</b> {f.decision} · {f.score} {f.grade} — {f.reason}
              </p>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

const TRACK_META: Record<string, { label: string; cls: string }> = {
  CONFIRMED: { label: 'Breaker confirmed', cls: 'bg-emerald-600 text-white' },
  SWEPT_WAITING: { label: 'Swept — awaiting reclaim', cls: 'bg-sky-100 text-sky-800' },
  AT_THE_POOL: { label: 'At the pool', cls: 'bg-amber-100 text-amber-800' },
  FAILED_SWEEP: { label: 'Accepted through — failed', cls: 'bg-rose-100 text-rose-700' },
  DRIFTED_AWAY: { label: 'Drifted away', cls: 'bg-slate-100 text-slate-600' },
  STALE: { label: 'Window expired', cls: 'bg-slate-100 text-slate-500' },
  APPROACHING: { label: 'Approaching', cls: 'bg-slate-100 text-slate-600' },
  CLOSED: { label: 'Closed', cls: 'bg-slate-100 text-slate-400' },
};

function TrackedTab({ onPlace, placing }: { onPlace: (id: string, override?: IctResizeInput) => void; placing: string | null }) {
  const [data, setData] = useState<IctTrackedResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Same two-step confirmation as the prediction cards: this reaches the broker.
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = useCallback(async (spin = false) => {
    if (spin) setLoading(true);
    try { setData(await fetchTrackedIctPredictions()); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed to load tracked predictions'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(true); const t = setInterval(() => load(false), 60000); return () => clearInterval(t); }, [load]);

  const untrack = async (id: string) => { try { await trackIctPrediction(id, false); await load(false); } catch { /* the row stays; retry */ } };
  const rows = data?.tracked || [];
  const hot = rows.filter((t) => ['CONFIRMED', 'SWEPT_WAITING', 'AT_THE_POOL'].includes(t.health.verdict)).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 text-sm font-black uppercase tracking-wider text-slate-600">
          <Activity size={14} className="text-violet-400" />Tracked
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">{rows.length}</span>
        </h2>
        {hot > 0 ? <span className="rounded-md bg-sky-50 px-2 py-0.5 text-[11px] font-bold text-sky-700">{hot} in play</span> : null}
        <button onClick={() => load(true)} className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-slate-500 hover:text-violet-600">
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}Refresh
        </button>
      </div>
      {err ? <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-[12px] font-bold text-rose-600">{err}</div> : null}
      <p className="text-[11px] font-semibold text-slate-400">
        Health is re-read every minute. The sweep is measured from the wick, not the close — a level taken and reclaimed is
        the setup working, and a level taken and left behind is the setup failing. One email per prediction, the first time
        there is something to do.
      </p>
      {rows.length ? (
        <div className="space-y-2">
          {rows.map((t: IctTrackedPrediction) => {
            const m = TRACK_META[t.health.verdict] || { label: t.health.verdict, cls: 'bg-slate-100 text-slate-600' };
            return (
              <div key={t.id} className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded px-2 py-0.5 text-[10px] font-black ${m.cls}`}>{m.label}</span>
                  <span className="text-[13px] font-black text-slate-900">{t.symbol}</span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-bold text-slate-600">{t.timeframe}</span>
                  <span className={`text-[12px] font-black ${t.direction === 'BUY' ? 'text-emerald-700' : 'text-rose-600'}`}>{t.direction}</span>
                  <span className="text-[12px] font-semibold text-slate-500">pool {px(t.level, t.symbol)}</span>
                  {t.proQualified ? <span className="rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-black text-white">PRO</span> : null}
                  <span className="ml-auto text-[11px] font-semibold text-slate-400">
                    price {px(t.price, t.symbol)}
                    {t.health.throughAtr !== null && t.health.throughAtr > 0 ? ` · ${t.health.throughAtr}× ATR through` : ''}
                    {t.health.timeLeftMinutes !== null ? ` · ${t.health.timeLeftMinutes}m left` : ''}
                  </span>
                </div>
                {t.health.suggestion ? <p className="mt-1.5 text-[12px] font-bold text-slate-700">{t.health.suggestion}</p> : null}
                <ul className="mt-1 space-y-0.5">
                  {t.health.reasons.map((r) => <li key={r} className="text-[11px] font-semibold text-slate-500">· {r}</li>)}
                </ul>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button onClick={() => (confirmId === t.id ? onPlace(t.id) : setConfirmId(t.id))}
                    onBlur={() => setConfirmId((c) => (c === t.id ? null : c))}
                    disabled={!t.limitOrder || placing === t.id}
                    className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-bold disabled:opacity-40 ${confirmId === t.id ? 'bg-sky-600 text-white' : 'border border-slate-200 text-slate-600 hover:border-sky-300 hover:text-sky-600'}`}>
                    {placing === t.id ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                    {confirmId === t.id ? `Confirm at ${px(t.limitOrder?.entry, t.symbol)}` : 'Place limit'}
                  </button>
                  <button onClick={() => untrack(t.id)}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-bold text-slate-500 hover:border-rose-300 hover:text-rose-600">
                    <Ban size={12} />Untrack
                  </button>
                  {t.alertedAt ? <span className="text-[10px] font-semibold text-slate-400">alerted {new Date(t.alertedAt).toLocaleTimeString()}</span> : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="rounded-2xl border border-dashed border-slate-200 px-5 py-6 text-center text-[13px] font-semibold text-slate-400">
          Nothing tracked yet. Hit <b>Track</b> on any prediction to watch it here.
        </p>
      )}
    </div>
  );
}

function OrdersTab() {
  const [data, setData] = useState<IctPendingResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [modifying, setModifying] = useState<string | null>(null);

  const load = useCallback(async (spin = false) => {
    if (spin) setLoading(true);
    try { setData(await fetchIctPendingOrders()); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed to load orders'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(true); const t = setInterval(() => load(false), 30000); return () => clearInterval(t); }, [load]);

  const cancel = async (id: string) => {
    setBusy(id);
    try { await cancelIctOrder(id); await load(false); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not cancel'); }
    finally { setBusy(null); }
  };

  const orders = data?.orders || [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 text-sm font-black uppercase tracking-wider text-slate-600">
          <ListOrdered size={14} className="text-sky-400" />Limit orders
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">{orders.length}</span>
        </h2>
        <span className={`rounded px-2 py-0.5 text-[10px] font-bold ${data?.bridgeReady ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
          EA bridge {data?.bridgeReady ? 'ready' : 'not polling'}
        </span>
        <span className={`rounded px-2 py-0.5 text-[10px] font-bold ${data?.armedMatch ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
          armed account {data?.armedMatch ? 'matches' : 'mismatch'}
        </span>
        <button onClick={() => load(true)} className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-slate-500 hover:text-sky-600">
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}Refresh
        </button>
      </div>
      {err ? <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-[12px] font-bold text-rose-600">{err}</div> : null}
      {orders.length ? (
        <div className="space-y-2">
          {orders.map((o) => (
            <div key={o.id} className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-sky-600 px-1.5 py-0.5 text-[10px] font-black text-white">{o.orderType}</span>
                <span className="text-[13px] font-black text-slate-900">{o.symbol}</span>
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-bold text-slate-600">{o.timeframe}</span>
                <span className={`text-[12px] font-black ${o.direction === 'BUY' ? 'text-emerald-700' : 'text-rose-600'}`}>{o.direction}</span>
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-600">{o.status}</span>
                {o.proQualified ? <span className="rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-black text-white">PRO</span> : null}
                {o.cancellable ? (
                  <>
                    <button onClick={() => setModifying((m) => (m === o.id ? null : o.id))}
                      className={`ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-bold ${modifying === o.id ? 'bg-slate-900 text-white' : 'border border-slate-200 text-slate-500 hover:border-sky-300 hover:text-sky-600'}`}>
                      <Pencil size={12} />Modify
                    </button>
                    <button onClick={() => cancel(o.id)} disabled={busy === o.id}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-bold text-slate-500 hover:border-rose-300 hover:text-rose-600 disabled:opacity-40">
                      {busy === o.id ? <Loader2 size={12} className="animate-spin" /> : <Ban size={12} />}Cancel
                    </button>
                  </>
                ) : null}
              </div>
              {modifying === o.id ? (
                <OrderModifyPanel orderId={o.id} onDone={() => { setModifying(null); void load(false); }} />
              ) : null}
              <p className="mt-1 text-[12px] font-semibold text-slate-600">
                Entry <b>{px(o.entry, o.symbol)}</b> · SL <b className="text-rose-600">{px(o.stopLoss, o.symbol)}</b>
                {' · TP '}<b className="text-emerald-600">{px(o.takeProfit1, o.symbol)}</b>
                {o.rr ? <> · RR <b>{o.rr}</b></> : null} · <b>{o.lots}</b> lots
                {o.riskAmount ? <> · risk <b>${o.riskAmount}</b></> : null}
              </p>
              <p className="mt-0.5 text-[11px] font-semibold text-slate-400">
                from {(o.setup || '').replace(/_/g, ' ').toLowerCase()} at {o.levelLabel || 'swing'} {px(o.level, o.symbol)}
                {o.structureLevel ? ` → reclaim ${px(o.structureLevel, o.symbol)}` : ''}
                {o.predictionScore ? ` · score ${o.predictionScore}` : ''}
                {o.expiresAt ? ` · expires ${new Date(o.expiresAt).toLocaleTimeString()}` : ''}
                {o.ticket ? ` · ticket ${o.ticket}` : ''}
              </p>
              {o.reason ? <p className="mt-0.5 text-[11px] font-medium text-slate-400">{o.reason}</p> : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-2xl border border-dashed border-slate-200 px-5 py-6 text-center text-[13px] font-semibold text-slate-400">
          No orders placed from ICT predictions yet. Use <b>Place limit</b> on a prediction.
        </p>
      )}
      <p className="text-[11px] font-semibold text-slate-400">
        These are REAL resting orders on MT5, sized to your challenge rules and subject to the same concurrency and
        challenge guards as the auto-trader. Cancelling removes them from the broker.
      </p>
    </div>
  );
}

function RecordTab() {
  const [data, setData] = useState<IctTrackRecordResponse | null>(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchIctTrackRecord(days)
      .then((r) => { if (alive) { setData(r); setErr(null); } })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : 'Failed to load the track record'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [days]);

  const pct = (v: number | null) => (v === null || v === undefined ? '—' : `${v}%`);
  const Table = ({ title, rows, keyName }: { title: string; rows: Array<Record<string, unknown>>; keyName: string }) => (
    <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
      <p className="border-b border-slate-100 px-4 py-2 text-[10px] font-black uppercase tracking-wider text-slate-500">{title}</p>
      <table className="w-full min-w-[560px] text-left text-[12px]">
        <thead className="text-[10px] font-black uppercase tracking-wider text-slate-400">
          <tr>
            <th className="px-4 py-2">{keyName}</th><th className="px-3 py-2">n</th>
            <th className="px-3 py-2">reached</th><th className="px-3 py-2">reclaimed</th>
            <th className="px-3 py-2">win rate</th><th className="px-3 py-2">W/L</th><th className="px-3 py-2">pips</th><th className="px-3 py-2">R</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={String(r[keyName])} className="border-t border-slate-50">
              <td className="px-4 py-1.5 font-bold text-slate-700">{String(r[keyName])}</td>
              <td className="px-3 py-1.5 font-semibold text-slate-500">{String(r.n)}</td>
              <td className="px-3 py-1.5 font-semibold text-slate-600">{pct(r.arrivalRate as number | null)}</td>
              <td className="px-3 py-1.5 font-semibold text-slate-600">{pct(r.reclaimRate as number | null)}</td>
              <td className="px-3 py-1.5 font-black text-slate-800">{pct(r.winRate as number | null)}</td>
              <td className="px-3 py-1.5 font-semibold text-slate-500">{String(r.wins)}/{String(r.losses)}</td>
              <td className={`px-3 py-1.5 font-bold ${Number(r.pips) >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{String(r.pips)}</td>
              <td className={`px-3 py-1.5 font-bold ${Number(r.r) >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{String(r.r)}</td>
            </tr>
          ))}
          {!rows.length ? <tr><td colSpan={8} className="px-4 py-3 text-center font-semibold text-slate-400">nothing resolved yet</td></tr> : null}
        </tbody>
      </table>
    </div>
  );

  const o = data?.overall;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 text-sm font-black uppercase tracking-wider text-slate-600">
          <BarChart3 size={14} className="text-emerald-400" />Track record
        </h2>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}
          className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-bold text-slate-600">
          {[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>last {d} days</option>)}
        </select>
        {loading ? <Loader2 size={13} className="animate-spin text-slate-400" /> : null}
        <span className="text-[11px] font-semibold text-slate-400">{data?.resolved ?? 0} resolved</span>
      </div>
      {err ? <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-[12px] font-bold text-rose-600">{err}</div> : null}

      {o ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: 'Reached the pool', value: pct(o.arrivalRate), sub: `${o.arrived} of ${o.n} predictions` },
            { label: 'Reclaimed after the sweep', value: pct(o.reclaimRate), sub: `${o.reclaimed} of ${o.arrived} arrivals` },
            { label: 'Win rate on the resting order', value: pct(o.winRate), sub: `${o.wins}W / ${o.losses}L / ${o.ambiguous} ambiguous` },
            { label: 'Net', value: `${o.pips} pips`, sub: `${o.r}R` },
          ].map((c) => (
            <div key={c.label} className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
              <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">{c.label}</p>
              <p className="text-xl font-black text-slate-900">{c.value}</p>
              <p className="text-[11px] font-semibold text-slate-400">{c.sub}</p>
            </div>
          ))}
        </div>
      ) : null}

      {/* The claim the PRO overlay makes, measured on THIS page's own predictions rather than
          inherited from the original study. */}
      {data?.proComparison ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {([['Cleared the PRO overlay', data.proComparison.proQualified], ['Did not clear it', data.proComparison.notQualified]] as const).map(([label, b]) => (
            <div key={label} className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
              <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">{label}</p>
              <p className="text-[13px] font-bold text-slate-800">
                {pct(b.winRate)} win · {pct(b.reclaimRate)} reclaim · {b.pips} pips
              </p>
              <p className="text-[11px] font-semibold text-slate-400">{b.n} predictions, {b.settled} settled</p>
            </div>
          ))}
        </div>
      ) : null}

      <Table title="By strategy" rows={data?.byStrategy || []} keyName="strategy" />
      <Table title="By timeframe" rows={data?.byTimeframe || []} keyName="timeframe" />
      <Table title="By setup" rows={data?.bySetup || []} keyName="setup" />
      <Table title="By symbol" rows={data?.bySymbol || []} keyName="symbol" />

      {(data?.notes || []).map((nt) => <p key={nt} className="text-[11px] font-semibold text-slate-400">· {nt}</p>)}
    </div>
  );
}

export default function IctPredict() {
  const [data, setData] = useState<IctPredictionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<'predictions' | 'orders' | 'tracked' | 'record'>('predictions');
  const [trackedIds, setTrackedIds] = useState<Set<string>>(new Set());
  const [placing, setPlacing] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  // Filters. Everything is sent to the API so the page and the server cannot disagree about
  // what a filter means — pip distance especially, which is measured to the resting entry.
  const [fSymbol, setFSymbol] = useState('');
  const [fTimeframe, setFTimeframe] = useState('');
  const [fSetup, setFSetup] = useState('');
  const [fDirection, setFDirection] = useState('');
  const [fGrade, setFGrade] = useState('');
  const [fStrategy, setFStrategy] = useState('');
  const [fProOnly, setFProOnly] = useState(false);
  const [fMinScore, setFMinScore] = useState(0);
  const [fMinRR, setFMinRR] = useState(0);
  const [fMaxPips, setFMaxPips] = useState('');
  const [fMinPips, setFMinPips] = useState('');

  const filters = useMemo(() => ({
    symbol: fSymbol, timeframe: fTimeframe, setup: fSetup, direction: fDirection,
    grade: fGrade, strategy: fStrategy, proOnly: fProOnly,
    minScore: fMinScore || undefined, minRR: fMinRR || undefined,
    maxPips: fMaxPips === '' ? undefined : Number(fMaxPips),
    minPips: fMinPips === '' ? undefined : Number(fMinPips),
  }), [fSymbol, fTimeframe, fSetup, fDirection, fGrade, fStrategy, fProOnly, fMinScore, fMinRR, fMaxPips, fMinPips]);

  const load = useCallback(async (spin = false) => {
    if (spin) setLoading(true);
    try { setData(await fetchIctPredictions(filters)); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed to load ICT predictions'); }
    finally { setLoading(false); }
  }, [filters]);

  useEffect(() => { load(true); const t = setInterval(() => load(false), 60000); return () => clearInterval(t); }, [load]);

  useEffect(() => {
    let alive = true;
    fetchTrackedIctPredictions()
      .then((r) => { if (alive) setTrackedIds(new Set((r.tracked || []).map((t) => t.id))); })
      .catch(() => { /* the button still works; it just starts unlit */ });
    return () => { alive = false; };
  }, [tab]);

  const onTrack = async (id: string, on: boolean) => {
    // Optimistic: the pin should feel instant, and a failure puts it straight back.
    setTrackedIds((prev) => { const next = new Set(prev); if (on) next.add(id); else next.delete(id); return next; });
    try { await trackIctPrediction(id, on); }
    catch {
      setTrackedIds((prev) => { const next = new Set(prev); if (on) next.delete(id); else next.add(id); return next; });
    }
  };

  const onPlace = async (id: string, override?: IctResizeInput) => {
    setPlacing(id); setErr(null); setNotice(null);
    try {
      const r = await placeIctOrder(id, undefined, override);
      setNotice(`${r.orderType.replace('_', ' ')}${r.resized ? ' (resized)' : ''} resting at ${r.entry} · ${r.lots} lots · SL ${r.stopLoss}${r.stopPips ? ` (${r.stopPips}p)` : ''} · expires in ${r.expiresInMinutes} min.`
        + (r.warnings?.length ? ` Warnings: ${r.warnings.join('; ')}` : ''));
      setTrackedIds((prev) => new Set(prev).add(id));
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not place the order'); }
    finally { setPlacing(null); }
  };

  const rescan = async () => {
    setScanning(true); setNotice(null);
    try {
      const r = await scanIctPredictions();
      setNotice(r.started ? 'Scan started — results appear within a couple of minutes.' : (r.reason || 'A scan is already running.'));
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not start the scan'); }
    finally { setScanning(false); }
  };

  const rows = data?.predictions || [];
  const uniq = (pick: (p: IctPrediction) => string | null) =>
    Array.from(new Set(rows.map(pick).filter(Boolean) as string[])).sort();
  const proCount = rows.filter((p) => p.proQualified).length;
  const offStrategies = (data?.strategies || []).filter((s) => !s.enabled);

  const selectCls = 'rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-bold text-slate-600';

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 pb-24">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-black text-slate-900">
            <Target size={22} className="text-emerald-500" />ICT Predict
          </h1>
          <p className="text-[12px] font-semibold text-slate-500">
            Projected sweep → breaker setups for <b>ICT Breaker</b> and <b>ICT Breaker Pro</b> only. The pool, the
            structure and the target are read from live candles; the path between them is constructed and shown.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={rescan} disabled={scanning}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-[11px] font-bold text-slate-600 hover:border-emerald-300 hover:text-emerald-600 disabled:opacity-40">
            {scanning ? <Loader2 size={12} className="animate-spin" /> : <Layers size={12} />}Re-scan
          </button>
          <button onClick={() => load(true)}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-[11px] font-bold text-slate-600 hover:border-emerald-300 hover:text-emerald-600">
            {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}Refresh
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1 border-b border-slate-200">
        {([
          ['predictions', 'Predictions', rows.length],
          ['orders', 'Limit orders', null],
          ['tracked', 'Tracked', trackedIds.size],
          ['record', 'Track record', null],
        ] as const).map(([k, label, count]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`-mb-px border-b-2 px-3 py-2 text-[12px] font-bold ${tab === k ? 'border-emerald-500 text-emerald-700' : 'border-transparent text-slate-400 hover:text-slate-600'}`}>
            {label}{count !== null && count !== undefined ? ` (${count})` : ''}
          </button>
        ))}
      </div>

      {err ? <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-[12px] font-bold text-rose-600">{err}</div> : null}
      {notice ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-[12px] font-bold text-emerald-700">{notice}</div> : null}

      {tab === 'predictions' ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2">
            <select value={fSymbol} onChange={(e) => setFSymbol(e.target.value)} className={selectCls}>
              <option value="">all symbols</option>
              {uniq((p) => p.symbol).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select value={fTimeframe} onChange={(e) => setFTimeframe(e.target.value)} className={selectCls}>
              <option value="">all timeframes</option>
              {(data?.timeframes || []).map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select value={fSetup} onChange={(e) => setFSetup(e.target.value)} className={selectCls}>
              <option value="">all setups</option>
              {Object.entries(SETUP_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <select value={fDirection} onChange={(e) => setFDirection(e.target.value)} className={selectCls}>
              <option value="">both directions</option>
              <option value="BUY">BUY (buy limits)</option>
              <option value="SELL">SELL (sell limits)</option>
            </select>
            <select value={fStrategy} onChange={(e) => setFStrategy(e.target.value)} className={selectCls}>
              <option value="">both engines</option>
              {(data?.strategies || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <select value={fGrade} onChange={(e) => setFGrade(e.target.value)} className={selectCls}>
              <option value="">any grade</option>
              {['A+', 'A', 'B', 'C'].map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
            <label className="flex items-center gap-1 text-[11px] font-bold text-slate-600">
              min score
              <input type="number" min={0} max={100} value={fMinScore} onChange={(e) => setFMinScore(Number(e.target.value) || 0)}
                className="w-16 rounded-lg border border-slate-200 px-2 py-1 text-[11px]" />
            </label>
            <label className="flex items-center gap-1 text-[11px] font-bold text-slate-600">
              min RR
              <input type="number" min={0} step={0.5} value={fMinRR} onChange={(e) => setFMinRR(Number(e.target.value) || 0)}
                className="w-16 rounded-lg border border-slate-200 px-2 py-1 text-[11px]" />
            </label>
            {/* Pip distance to the resting entry — how far price has to travel before this
                becomes a live trade. The most practical filter on the page. */}
            <label className="flex items-center gap-1 text-[11px] font-bold text-slate-600" title="Distance from live price to the resting entry">
              pips
              <input type="number" min={0} placeholder="min" value={fMinPips} onChange={(e) => setFMinPips(e.target.value)}
                className="w-16 rounded-lg border border-slate-200 px-2 py-1 text-[11px]" />
              <span className="text-slate-300">–</span>
              <input type="number" min={0} placeholder="max" value={fMaxPips} onChange={(e) => setFMaxPips(e.target.value)}
                className="w-16 rounded-lg border border-slate-200 px-2 py-1 text-[11px]" />
            </label>
            <button onClick={() => setFProOnly((v) => !v)}
              className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-bold ${fProOnly ? 'bg-emerald-600 text-white' : 'border border-slate-200 text-slate-600 hover:border-emerald-300'}`}
              title="Only setups that clear the ict-break-pro overlay">
              <Zap size={11} />PRO only
            </button>
            <span className="ml-auto text-[11px] font-semibold text-slate-400">
              {rows.length} shown · {proCount} PRO
              {data?.lastScan?.at ? ` · scanned ${new Date(data.lastScan.at).toLocaleTimeString()}` : ' · no scan yet'}
            </span>
          </div>

          {offStrategies.length ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-[11px] font-bold text-amber-800">
              {offStrategies.map((s) => s.name).join(' and ')} {offStrategies.length === 1 ? 'is' : 'are'} turned OFF in the
              Strategy Controller, so nothing from {offStrategies.length === 1 ? 'it' : 'them'} is shown here. Scanning and
              logging continue in the background for ranking.
            </div>
          ) : null}

          {rows.length ? (
            <div className="space-y-2">
              {rows.map((p) => (
                <PredictionCard key={p.id} p={p} tracked={trackedIds.has(p.id)}
                  onTrack={onTrack} onPlace={onPlace} placing={placing === p.id} />
              ))}
            </div>
          ) : (
            <p className="rounded-2xl border border-dashed border-slate-200 px-5 py-8 text-center text-[13px] font-semibold text-slate-400">
              {loading ? 'Loading…' : 'No ICT predictions right now. Either every nearby pool has already been swept, or no projected sequence passes the engines’ own rules. Try Re-scan, or widen the filters.'}
            </p>
          )}

          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-slate-500">
              <ShieldAlert size={12} />Read this before trading anything here
            </p>
            {(data?.caveats || []).map((c) => <p key={c} className="text-[11px] font-semibold text-slate-500">· {c}</p>)}
          </div>
        </div>
      ) : null}

      {tab === 'orders' ? <OrdersTab /> : null}
      {tab === 'tracked' ? <TrackedTab onPlace={onPlace} placing={placing} /> : null}
      {tab === 'record' ? <RecordTab /> : null}
    </div>
  );
}
