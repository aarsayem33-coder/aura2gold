import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Gauge, RefreshCw, Loader2, TrendingUp, TrendingDown, Minus, AlertTriangle,
  Activity, Droplets, Layers, Zap, ShieldCheck, Ban, Clock,
} from 'lucide-react';
import Mt5CandlestickChart from '../components/Mt5CandlestickChart';
import { fetchLiveMarketTracker, fetchMt5Candles, useMt5Stream } from '../mt5Api';
import type { LiveMarketTrackerResponse, LmtOrderBlock, LmtKeyLevel, LmtSweepGrade, Mt5Candle } from '../types';

const TF_OPTIONS = ['M1', 'M5', 'M15', 'M30', 'H1'];

function digitsFor(symbol: string) {
  const s = (symbol || '').toUpperCase();
  return /USTEC|US30|US100|US500|NAS/.test(s) ? 2 : /XAU|GOLD|XAG/.test(s) ? 2 : /JPY/.test(s) ? 3 : 5;
}
function px(v: number | null | undefined, symbol: string) {
  return v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(digitsFor(symbol));
}
function num(v: number | null | undefined, d = 2) {
  return v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(d);
}

// ── Feed banner: LIVE / STALE / MARKET CLOSED — the honesty header ───────────
function FeedBanner({ t }: { t: LiveMarketTrackerResponse }) {
  const map = {
    LIVE: { wrap: 'border-emerald-200 bg-emerald-50 text-emerald-800', dot: 'bg-emerald-500 animate-pulse', label: 'LIVE' },
    STALE: { wrap: 'border-amber-200 bg-amber-50 text-amber-800', dot: 'bg-amber-500', label: 'FEED STALE' },
    MARKET_CLOSED: { wrap: 'border-slate-300 bg-slate-100 text-slate-600', dot: 'bg-slate-400', label: 'MARKET CLOSED' },
  } as const;
  const c = map[t.feedState] || map.MARKET_CLOSED;
  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-4 py-3 ${c.wrap}`}>
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${c.dot}`} />
        <span className="text-sm font-black tracking-wide">{c.label}</span>
        {t.feedState !== 'MARKET_CLOSED' && t.staleSeconds != null && (
          <span className="text-xs font-semibold opacity-70">· last tick {t.staleSeconds}s ago</span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-semibold">
        <span>Price <span className="font-mono text-sm font-bold">{px(t.price, t.symbol)}</span></span>
        <span>ATR <span className="font-mono">{num(t.atr, digitsFor(t.symbol))}</span></span>
        {t.session?.label && <span className="inline-flex items-center gap-1"><Clock size={12} />{t.session.label} · {t.session.bdTime}</span>}
      </div>
    </div>
  );
}

// ── The single entry verdict (the whole point of the cockpit) ────────────────
function VerdictCard({ t }: { t: LiveMarketTrackerResponse }) {
  const v = t.verdict;
  const style: Record<string, { wrap: string; chip: string; Icon: React.ComponentType<{ size?: number }>; title: string }> = {
    ARMED_IF_CONFIRMED: { wrap: 'border-emerald-300 bg-emerald-50', chip: 'bg-emerald-600 text-white', Icon: ShieldCheck, title: 'ARMED — enter only on your confirmation' },
    WATCH: { wrap: 'border-sky-300 bg-sky-50', chip: 'bg-sky-600 text-white', Icon: Activity, title: 'WATCH — setup forming' },
    WAIT: { wrap: 'border-amber-300 bg-amber-50', chip: 'bg-amber-500 text-white', Icon: Clock, title: 'WAIT — not at a good location' },
    NO_TRADE: { wrap: 'border-rose-300 bg-rose-50', chip: 'bg-rose-600 text-white', Icon: Ban, title: 'NO TRADE' },
    STALE_DATA: { wrap: 'border-slate-300 bg-slate-100', chip: 'bg-slate-500 text-white', Icon: AlertTriangle, title: 'STALE DATA — not judging entries' },
    MARKET_CLOSED: { wrap: 'border-slate-300 bg-slate-100', chip: 'bg-slate-500 text-white', Icon: Ban, title: 'MARKET CLOSED' },
  };
  const s = style[v.verdict] || style.WAIT;
  const Icon = s.Icon;
  const dirCls = v.direction === 'BUY' ? 'bg-emerald-100 text-emerald-700' : v.direction === 'SELL' ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-500';
  const checks = v.checklist ? Object.entries(v.checklist) : [];
  const CHECK_LABEL: Record<string, string> = {
    hasBias: 'Directional bias', nearStrongOb: 'At strong order block', goodLocation: 'Premium/discount location',
    liquiditySwept: 'Liquidity swept', imbalance: 'Imbalance / displacement', pressureAligns: 'Pressure aligns', notExtended: 'Not over-extended',
  };
  return (
    <div className={`rounded-2xl border p-4 ${s.wrap}`}>
      <div className="flex flex-wrap items-center gap-3">
        <span className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-black ${s.chip}`}><Icon size={16} />{v.verdict.replace(/_/g, ' ')}</span>
        {v.direction && <span className={`rounded px-2 py-1 text-xs font-black ${dirCls}`}>{v.direction}</span>}
        <span className="text-sm font-bold text-slate-700">{s.title}</span>
      </div>
      {v.reasons?.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm text-slate-700">
          {v.reasons.map((r, i) => <li key={i} className="flex gap-2"><span className="text-slate-400">•</span>{r}</li>)}
        </ul>
      )}
      {checks.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {checks.map(([k, ok]) => (
            <span key={k} className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-bold ${ok ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-500'}`}>
              {ok ? '✓' : '○'} {CHECK_LABEL[k] || k}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Buyer/seller PRESSURE PROXY meter ────────────────────────────────────────
function PressureMeter({ t }: { t: LiveMarketTrackerResponse }) {
  const p = t.pressure;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-sm font-black text-slate-800"><Gauge size={15} />Buy / Sell Pressure</h3>
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">PROXY</span>
      </div>
      <div className="flex h-7 w-full overflow-hidden rounded-lg">
        <div className="flex items-center justify-start bg-emerald-500 pl-2 text-xs font-black text-white" style={{ width: `${p.buyerPressure}%` }}>{p.buyerPressure}%</div>
        <div className="flex items-center justify-end bg-rose-500 pr-2 text-xs font-black text-white" style={{ width: `${p.sellerPressure}%` }}>{p.sellerPressure}%</div>
      </div>
      <div className="mt-1 flex justify-between text-[11px] font-bold text-slate-500">
        <span className="text-emerald-600">Buyers</span>
        <span className={`font-black ${p.dominant === 'BUYERS' ? 'text-emerald-600' : p.dominant === 'SELLERS' ? 'text-rose-600' : 'text-slate-500'}`}>{p.dominant} in control</span>
        <span className="text-rose-600">Sellers</span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-emerald-50 p-2">
          <div className="text-[10px] font-bold uppercase text-emerald-600">Aggr. Buying</div>
          <div className="text-lg font-black text-emerald-700">{p.aggressiveBuying}</div>
        </div>
        <div className="rounded-lg bg-rose-50 p-2">
          <div className="text-[10px] font-bold uppercase text-rose-600">Aggr. Selling</div>
          <div className="text-lg font-black text-rose-700">{p.aggressiveSelling}</div>
        </div>
        <div className="rounded-lg bg-slate-50 p-2">
          <div className="text-[10px] font-bold uppercase text-slate-500">Volume</div>
          <div className={`text-lg font-black ${p.volumeState === 'HIGH' ? 'text-amber-600' : p.volumeState === 'LOW' ? 'text-slate-400' : 'text-slate-700'}`}>{p.volumeRatio}×</div>
        </div>
      </div>
      <p className="mt-2 text-[11px] leading-snug text-slate-400">{p.basis}</p>
    </div>
  );
}

// ── Price position in the dealing range (premium / discount) ─────────────────
function PricePositionBar({ t }: { t: LiveMarketTrackerResponse }) {
  const pp = t.pricePosition;
  if (!pp || pp.pct == null) return null;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-black text-slate-800">Price Position</h3>
        <span className={`rounded px-2 py-0.5 text-[11px] font-black ${pp.zone === 'DISCOUNT' ? 'bg-emerald-100 text-emerald-700' : pp.zone === 'PREMIUM' ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-500'}`}>{pp.zone} · {pp.pct}%</span>
      </div>
      <div className="relative h-7 w-full overflow-hidden rounded-lg bg-gradient-to-r from-emerald-200 via-slate-100 to-rose-200">
        <div className="absolute top-0 h-full border-l-2 border-dashed border-slate-400" style={{ left: '50%' }} />
        <div className="absolute top-0 flex h-full -translate-x-1/2 items-center" style={{ left: `${pp.pct}%` }}>
          <span className="rounded bg-slate-900 px-1.5 py-0.5 text-[10px] font-black text-white">{px(t.price, t.symbol)}</span>
        </div>
      </div>
      <div className="mt-1 flex justify-between text-[11px] font-mono font-semibold text-slate-500">
        <span className="text-emerald-600">{px(pp.rangeLow, t.symbol)} (discount)</span>
        <span>{px(pp.equilibrium, t.symbol)}</span>
        <span className="text-rose-600">{px(pp.rangeHigh, t.symbol)} (premium)</span>
      </div>
      <div className="mt-1 text-center text-xs font-bold text-slate-600">{pp.label}</div>
    </div>
  );
}

// ── High-probability sweep grade (5-component model) ─────────────────────────
function SweepGradeCard({ sg, symbol }: { sg: LmtSweepGrade; symbol: string }) {
  const gradeCls = sg.grade.startsWith('A') ? 'bg-emerald-600 text-white' : sg.grade === 'B' ? 'bg-sky-600 text-white' : 'bg-amber-500 text-white';
  const dirCls = sg.decision === 'BUY' ? 'text-emerald-700 bg-emerald-100' : 'text-rose-700 bg-rose-100';
  return (
    <div className="rounded-2xl border border-indigo-200 bg-indigo-50/40 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-sm font-black text-indigo-900"><Zap size={15} />Sweep Quality</span>
        <span className={`rounded-lg px-2.5 py-1 text-sm font-black ${gradeCls}`}>{sg.grade} · {sg.score}</span>
        <span className={`rounded px-2 py-0.5 text-xs font-black ${dirCls}`}>{sg.decision}</span>
        <span className="text-xs font-semibold text-slate-500">swept {sg.meta.sweptLevel.type.replace(/_/g, ' ')} @ {px(sg.meta.sweptLevel.price, symbol)}</span>
        <span className="ml-auto text-xs font-bold text-slate-500">RR {sg.riskRewardRatio}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {sg.meta.checklist.map((c, i) => <span key={i} className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-600">✓ {c}</span>)}
      </div>
      <div className="mt-2 flex flex-wrap gap-3 font-mono text-[11px] text-slate-500">
        <span>entry <b className="text-slate-800">{px(sg.entry, symbol)}</b></span>
        <span>stop <b className="text-rose-600">{px(sg.stopLoss, symbol)}</b></span>
        <span>tp1 <b className="text-emerald-600">{px(sg.takeProfit1, symbol)}</b></span>
        <span>tp3 <b className="text-emerald-600">{px(sg.takeProfit3, symbol)}</b></span>
      </div>
    </div>
  );
}

// ── Key liquidity level (PDH/PDL, session H/L, round numbers, equal highs/lows) ──
function levelTone(type: string) {
  if (/^(PDH|PDL)$/.test(type)) return { tag: type, cls: 'bg-indigo-100 text-indigo-700' };
  if (/^(ASIAN|LONDON|NY)_(HIGH|LOW)$/.test(type)) return { tag: type.replace('_', ' '), cls: 'bg-sky-100 text-sky-700' };
  if (type === 'ROUND_NUMBER') return { tag: 'ROUND', cls: 'bg-amber-100 text-amber-700' };
  if (/EQUAL/.test(type)) return { tag: 'EQUAL', cls: 'bg-violet-100 text-violet-700' };
  return { tag: 'SWING', cls: 'bg-slate-100 text-slate-500' };
}
function KeyLevelRow({ l, symbol }: { l: LmtKeyLevel; symbol: string }) {
  const t = levelTone(l.type);
  return (
    <div className={`flex items-center gap-2 rounded-lg border px-2 py-1 ${l.swept ? 'border-slate-100 bg-slate-50/50 opacity-60' : 'border-slate-200'}`}>
      <span className={`rounded px-1.5 py-0.5 text-[9px] font-black ${t.cls}`}>{t.tag}</span>
      <span className="font-mono text-xs font-bold text-slate-800">{px(l.price, symbol)}</span>
      <span className="text-[10px] font-semibold text-slate-400">{l.distanceAtr != null ? `${l.distanceAtr} ATR` : `${l.distancePips}p`}</span>
      <span className="ml-auto flex items-center gap-0.5" title={`strength ${l.strength}/5 (obviousness)`}>{Array.from({ length: 5 }).map((_, i) => <span key={i} className={`h-1.5 w-1.5 rounded-full ${i < l.strength ? 'bg-indigo-500' : 'bg-slate-200'}`} />)}</span>
      {l.swept ? <span className="rounded bg-slate-200 px-1 py-0.5 text-[8px] font-black text-slate-500">SWEPT</span> : <span className="rounded bg-emerald-100 px-1 py-0.5 text-[8px] font-black text-emerald-700">FRESH</span>}
    </div>
  );
}

// ── A single order-block quality card ────────────────────────────────────────
function OrderBlockCard({ ob, symbol }: { ob: LmtOrderBlock; symbol: string }) {
  const demand = ob.kind === 'DEMAND';
  const gradeCls = ob.grade === 'A' ? 'bg-emerald-600 text-white' : ob.grade === 'B' ? 'bg-sky-600 text-white' : 'bg-slate-400 text-white';
  return (
    <div className={`rounded-xl border p-3 ${demand ? 'border-emerald-200 bg-emerald-50/40' : 'border-rose-200 bg-rose-50/40'} ${ob.inside ? 'ring-2 ring-offset-1 ' + (demand ? 'ring-emerald-400' : 'ring-rose-400') : ''}`}>
      <div className="flex items-center justify-between">
        <span className={`text-xs font-black ${demand ? 'text-emerald-700' : 'text-rose-700'}`}>{ob.kind}</span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${gradeCls}`}>{ob.grade} · {ob.score}</span>
      </div>
      <div className="mt-1 font-mono text-xs font-bold text-slate-700">{px(ob.low, symbol)} – {px(ob.high, symbol)}</div>
      <div className="mt-1 text-[11px] font-semibold text-slate-500">
        {ob.inside ? <span className="font-black text-slate-800">● price inside now</span> : <span>{ob.distancePips} pips away{ob.distanceAtr != null ? ` (${ob.distanceAtr} ATR)` : ''}</span>}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {ob.imbalance && <span className="inline-flex items-center gap-0.5 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-bold text-sky-700"><Zap size={10} />imbalance</span>}
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${ob.mitigated ? 'bg-slate-200 text-slate-500' : 'bg-emerald-100 text-emerald-700'}`}>{ob.mitigated ? 'mitigated' : 'fresh'}</span>
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500" title={ob.zoneActivity.note}>{ob.zoneActivity.reactions} reactions · {ob.zoneActivity.tickVolume} vol</span>
      </div>
    </div>
  );
}

// ── Vertical price-scaled zone map (demand/supply bands + current price) ──────
function ZoneMap({ t }: { t: LiveMarketTrackerResponse }) {
  const obs = t.orderBlocks || [];
  const H = 280;
  const lows = obs.map((o) => o.low);
  const highs = obs.map((o) => o.high);
  const min = Math.min(t.price, ...(lows.length ? lows : [t.price]));
  const max = Math.max(t.price, ...(highs.length ? highs : [t.price]));
  const pad = (max - min) * 0.08 || t.price * 0.001;
  const lo = min - pad, hi = max + pad;
  const range = hi - lo || 1;
  const y = (v: number) => ((hi - v) / range) * H;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-black text-slate-800"><Layers size={15} />Order-Block Zone Map</h3>
      <div className="relative w-full rounded-lg bg-slate-50" style={{ height: H }}>
        {obs.map((o, i) => {
          const top = y(o.high); const h = Math.max(3, y(o.low) - y(o.high));
          const demand = o.kind === 'DEMAND';
          return (
            <div key={i} className={`absolute left-0 right-0 ${demand ? 'bg-emerald-400/25 border-emerald-400' : 'bg-rose-400/25 border-rose-400'} border-y`} style={{ top, height: h }}>
              <span className={`absolute left-1 top-0 text-[9px] font-black ${demand ? 'text-emerald-700' : 'text-rose-700'}`}>{o.kind[0]}·{o.grade}</span>
            </div>
          );
        })}
        {/* current price line */}
        <div className="absolute left-0 right-0 z-10 flex items-center" style={{ top: y(t.price) }}>
          <div className="h-0.5 w-full bg-slate-900" />
          <span className="absolute right-1 -translate-y-1/2 rounded bg-slate-900 px-1.5 py-0.5 text-[10px] font-black text-white">{px(t.price, t.symbol)}</span>
        </div>
      </div>
      <div className="mt-2 flex justify-center gap-4 text-[11px] font-bold">
        <span className="text-emerald-600">▬ Demand</span>
        <span className="text-rose-600">▬ Supply</span>
        <span className="text-slate-700">▬ Price</span>
      </div>
    </div>
  );
}

// Merge fresh candles into the existing set, keyed by bar time (latest wins), sorted
// ascending and capped. Lets the live SSE stream update the chart between REST polls.
function mergeCandlesByTime(prev: Mt5Candle[], incoming: Mt5Candle[], cap = 600): Mt5Candle[] {
  const map = new Map<string, Mt5Candle>();
  for (const c of prev) map.set(c.time, c);
  for (const c of incoming) map.set(c.time, c);
  const merged = [...map.values()].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

export default function LiveMarketTracker() {
  const { status, candles: streamCandles } = useMt5Stream();
  const [symbol, setSymbol] = useState<string>('');
  const [timeframe, setTimeframe] = useState<string>('M5');
  const [data, setData] = useState<LiveMarketTrackerResponse | null>(null);
  const [candles, setCandles] = useState<Mt5Candle[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;
  const inFlightRef = useRef(false);
  // Which instrument the `candles` array currently holds. Used to REPLACE (not merge) on an
  // instrument switch — so we never mix bars across symbols AND never empty the array (emptying
  // would unmount the chart via the candles.length gate below, losing its fullscreen state).
  const candlesKeyRef = useRef('');

  const symbolOptions = useMemo(() => {
    const fromStatus = status?.symbols || [];
    const fromData = data?.watchlist?.map((w) => w.symbol) || [];
    return Array.from(new Set([...fromStatus, ...fromData])).sort();
  }, [status?.symbols, data?.watchlist]);

  // Default the symbol once data is available.
  useEffect(() => {
    if (!symbol && symbolOptions.length) setSymbol(symbolOptions.find((s) => /XAU|GOLD/.test(s)) || symbolOptions[0]);
  }, [symbol, symbolOptions]);

  const load = useCallback(async (showSpinner = false) => {
    if (inFlightRef.current) return; // don't let a slow request stack under the 3s poll
    inFlightRef.current = true;
    if (showSpinner) setLoading(true);
    try {
      const t = await fetchLiveMarketTracker(symbolRef.current || undefined, timeframe);
      setData(t);
      setError(t.error || null);
      try {
        const c = await fetchMt5Candles(t.symbol, timeframe, 300);
        const key = `${(t.symbol || '').toUpperCase()}|${timeframe.toUpperCase()}`;
        const fresh = c.candles || [];
        // Same instrument → merge (keeps live SSE bars); switched instrument → replace wholesale
        // (clears the old symbol's bars without ever emptying the array / unmounting the chart).
        setCandles((prev) => (key === candlesKeyRef.current ? mergeCandlesByTime(prev, fresh) : fresh));
        candlesKeyRef.current = key;
      } catch { /* chart is best-effort */ }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load tracker');
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, [timeframe]);

  useEffect(() => {
    load(true);
    // 3s poll for the analytics + banner (verdict / pressure / price). The chart itself
    // updates faster via the live-stream merge below, so ticks land well under 3s.
    const id = setInterval(() => load(false), 3000);
    return () => clearInterval(id);
  }, [load, symbol]);

  // Live-stream fast path: merge SSE candle pushes for the active symbol/timeframe into the
  // chart the instant they arrive (sub-second), instead of waiting for the next REST poll.
  useEffect(() => {
    const sym = (data?.symbol || '').toUpperCase();
    const tf = timeframe.toUpperCase();
    const key = `${sym}|${tf}`;
    // Only merge once the REST load has this instrument in place — never merge across a switch.
    if (!sym || !streamCandles?.length || key !== candlesKeyRef.current) return;
    const relevant = streamCandles.filter((c) => (c.symbol || '').toUpperCase() === sym && (c.timeframe || '').toUpperCase() === tf);
    if (relevant.length) setCandles((prev) => mergeCandlesByTime(prev, relevant));
  }, [streamCandles, data?.symbol, timeframe]);

  const plan = data?.plan;
  const levels = plan ? { direction: data?.verdict.direction || undefined, entry: plan.entry, stopLoss: plan.sl, takeProfit1: plan.tp ?? undefined } : null;

  // Small MT feed indicator (connected state + last-tick age) — shown only when the chart is
  // expanded (the chart component renders it in fullscreen only).
  const feedBadge = data ? (() => {
    const fs = data.feedState;
    const c = fs === 'LIVE'
      ? { dot: 'bg-emerald-500 animate-pulse', wrap: 'border-emerald-200 bg-emerald-50/90 text-emerald-700', label: 'MT LIVE' }
      : fs === 'STALE'
        ? { dot: 'bg-amber-500', wrap: 'border-amber-200 bg-amber-50/90 text-amber-700', label: 'MT STALE' }
        : { dot: 'bg-slate-400', wrap: 'border-slate-200 bg-slate-100/90 text-slate-500', label: 'MT OFFLINE' };
    const age = data.staleSeconds == null ? null : data.staleSeconds < 60 ? `${data.staleSeconds}s` : `${Math.floor(data.staleSeconds / 60)}m`;
    return (
      <div className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-black shadow-sm backdrop-blur-[3px] ${c.wrap}`}>
        <span className={`h-2 w-2 rounded-full ${c.dot}`} />
        <span>{c.label}</span>
        {fs !== 'MARKET_CLOSED' && age && <span className="font-semibold opacity-70">· tick {age} ago</span>}
      </div>
    );
  })() : null;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-black text-slate-900"><Gauge size={22} className="text-indigo-600" />Live Market Tracker</h1>
          <p className="text-sm font-semibold text-slate-500">Pre-entry decision cockpit — is price at a good location, right now?</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-bold text-slate-700">
            {!symbolOptions.length && <option value="">Loading…</option>}
            {symbolOptions.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <div className="flex overflow-hidden rounded-lg border border-slate-300">
            {TF_OPTIONS.map((tf) => (
              <button key={tf} onClick={() => setTimeframe(tf)} className={`px-3 py-1.5 text-xs font-black ${timeframe === tf ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>{tf}</button>
            ))}
          </div>
          <button onClick={() => load(true)} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-bold text-slate-600 hover:bg-slate-50">
            {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}Refresh
          </button>
        </div>
      </div>

      {error && <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm font-semibold text-rose-700">{error}</div>}
      {!data && !error && <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-slate-400"><Loader2 className="mx-auto animate-spin" /> Loading cockpit…</div>}

      {data && (
        <>
          <FeedBanner t={data} />
          <VerdictCard t={data} />
          {data.sweepGrade && <SweepGradeCard sg={data.sweepGrade} symbol={data.symbol} />}

          <div className="grid gap-4 lg:grid-cols-2">
            <PricePositionBar t={data} />
            <PressureMeter t={data} />
          </div>

          {/* Chart + zone map */}
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2 rounded-2xl border border-slate-200 bg-white p-2">
              {candles.length > 0
                ? <Mt5CandlestickChart
                    candles={candles} signals={[]} symbol={data.symbol} timeframe={timeframe} levels={levels}
                    symbolOptions={symbolOptions} timeframeOptions={TF_OPTIONS}
                    onSymbolChange={setSymbol} onTimeframeChange={setTimeframe}
                    fullscreenBadge={feedBadge}
                  />
                : <div className="flex h-72 items-center justify-center text-sm text-slate-400">No candle data for {data.symbol} {timeframe}.</div>}
            </div>
            <ZoneMap t={data} />
          </div>

          {/* Nearest zones summary */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50/40 p-3">
              <h3 className="flex items-center gap-1.5 text-sm font-black text-emerald-700"><TrendingUp size={15} />Nearest Demand</h3>
              {data.nearestDemand ? <OrderBlockCard ob={data.nearestDemand} symbol={data.symbol} /> : <p className="mt-2 text-sm text-slate-400">None detected.</p>}
            </div>
            <div className="rounded-2xl border border-rose-200 bg-rose-50/40 p-3">
              <h3 className="flex items-center gap-1.5 text-sm font-black text-rose-700"><TrendingDown size={15} />Nearest Supply</h3>
              {data.nearestSupply ? <OrderBlockCard ob={data.nearestSupply} symbol={data.symbol} /> : <p className="mt-2 text-sm text-slate-400">None detected.</p>}
            </div>
          </div>

          {/* All order blocks */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <h3 className="mb-3 flex items-center gap-1.5 text-sm font-black text-slate-800"><Layers size={15} />Detected Order Blocks ({data.orderBlocks.length})</h3>
            {data.orderBlocks.length
              ? <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{data.orderBlocks.map((ob, i) => <OrderBlockCard key={i} ob={ob} symbol={data.symbol} />)}</div>
              : <p className="text-sm text-slate-400">No order blocks detected on this timeframe.</p>}
          </div>

          {/* Key liquidity levels (institutional map) */}
          {(data.keyLevels?.length ?? 0) > 0 && (
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <h3 className="mb-1 flex items-center gap-1.5 text-sm font-black text-slate-800"><Layers size={15} />Key Liquidity Levels</h3>
              <p className="mb-3 text-[11px] text-slate-400">PDH/PDL · session highs/lows · round numbers · equal highs/lows · major swings. Stronger (more dots) = more obvious = more stops resting there → higher-quality sweep target. Sorted by distance.</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <div className="mb-1 text-[10px] font-black uppercase tracking-wider text-rose-500">Above price · buy-side liquidity</div>
                  <div className="space-y-1">
                    {data.keyLevels!.filter((l) => l.side === 'above').sort((a, b) => a.distance - b.distance).slice(0, 7).map((l, i) => <KeyLevelRow key={i} l={l} symbol={data.symbol} />)}
                    {data.keyLevels!.filter((l) => l.side === 'above').length === 0 && <p className="text-xs text-slate-300">none nearby</p>}
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-[10px] font-black uppercase tracking-wider text-emerald-500">Below price · sell-side liquidity</div>
                  <div className="space-y-1">
                    {data.keyLevels!.filter((l) => l.side === 'below').sort((a, b) => a.distance - b.distance).slice(0, 7).map((l, i) => <KeyLevelRow key={i} l={l} symbol={data.symbol} />)}
                    {data.keyLevels!.filter((l) => l.side === 'below').length === 0 && <p className="text-xs text-slate-300">none nearby</p>}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Watchlist */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <h3 className="mb-3 flex items-center gap-1.5 text-sm font-black text-slate-800"><Activity size={15} />Watchlist — {timeframe}</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-slate-200 text-left text-[11px] uppercase text-slate-400">
                  <th className="py-1.5 pr-2">Symbol</th><th className="px-2">Feed</th><th className="px-2">Bias</th><th className="px-2">Verdict</th><th className="px-2">Buy/Sell</th><th className="px-2">Nearest OB</th>
                </tr></thead>
                <tbody>
                  {data.watchlist.map((w) => (
                    <tr key={w.symbol} className={`border-b border-slate-100 hover:bg-slate-50 ${w.symbol === data.symbol ? 'bg-indigo-50/40' : ''}`}>
                      <td className="py-1.5 pr-2"><button onClick={() => setSymbol(w.symbol)} className="font-black text-indigo-600 hover:underline">{w.symbol}</button></td>
                      <td className="px-2 text-[11px] font-bold text-slate-500">{w.feedState}</td>
                      <td className="px-2">{w.bias === 'BULLISH' ? <TrendingUp size={14} className="text-emerald-500" /> : w.bias === 'BEARISH' ? <TrendingDown size={14} className="text-rose-500" /> : <Minus size={14} className="text-slate-300" />}</td>
                      <td className="px-2 text-[11px] font-black text-slate-700">{w.verdict.replace(/_/g, ' ')}</td>
                      <td className="px-2"><span className="font-bold text-emerald-600">{w.buyerPressure}</span><span className="text-slate-300">/</span><span className="font-bold text-rose-600">{w.sellerPressure}</span></td>
                      <td className="px-2 font-mono text-xs text-slate-500">{w.nearestDistanceAtr >= 99 ? '—' : `${w.nearestDistanceAtr} ATR`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Honesty footnotes */}
          {data.honesty?.length > 0 && (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
              <div className="flex items-center gap-1.5 text-xs font-black text-slate-500"><Droplets size={13} />Honesty</div>
              <ul className="mt-1 space-y-0.5 text-[11px] leading-snug text-slate-500">
                {data.honesty.map((h, i) => <li key={i}>• {h}</li>)}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
