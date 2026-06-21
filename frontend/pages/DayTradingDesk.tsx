import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, LineChart, TrendingUp, TrendingDown, Minus, AlertTriangle, Target, Crosshair, Layers, Droplets, Zap } from 'lucide-react';
import { fetchStructureDesk } from '../mt5Api';
import type { StructureDeskResponse, StructureDesk, LiquidityPool } from '../types';

const TF_OPTIONS = ['M2', 'M5', 'M15', 'M30', 'H1'];

function fmt(v: number | null | undefined, d = 2) {
  return v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(d);
}

function PhasePill({ phase }: { phase: string }) {
  const map: Record<string, string> = {
    UPTREND: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    DOWNTREND: 'bg-rose-50 text-rose-700 border-rose-200',
    CONSOLIDATION: 'bg-amber-50 text-amber-700 border-amber-200',
    SIDEWAYS: 'bg-slate-100 text-slate-500 border-slate-200',
  };
  const Icon = phase === 'UPTREND' ? TrendingUp : phase === 'DOWNTREND' ? TrendingDown : Minus;
  return <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-black ${map[phase] || map.SIDEWAYS}`}><Icon size={12} />{phase}</span>;
}

function DecisionTag({ d }: { d: string }) {
  if (d.includes('BUY')) return <span className="rounded px-1.5 py-0.5 text-[11px] font-black bg-emerald-50 text-emerald-700 border border-emerald-200">{d}</span>;
  if (d.includes('SELL')) return <span className="rounded px-1.5 py-0.5 text-[11px] font-black bg-rose-50 text-rose-700 border border-rose-200">{d}</span>;
  return <span className="rounded px-1.5 py-0.5 text-[11px] font-bold bg-slate-100 text-slate-500 border border-slate-200">HOLD</span>;
}

function ageMins(ms: number | null) {
  if (!ms) return '';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

function PoolChip({ p }: { p: LiquidityPool }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-mono ${p.swept ? 'bg-slate-100 text-slate-400 line-through' : p.type === 'BSL' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
      {fmt(p.price)}{p.equal ? <span className="font-bold">×{p.touches}</span> : null}
    </span>
  );
}

function DisplacementBadge({ d }: { d: { present: boolean; strong?: boolean; atrMultiple: number } }) {
  if (d.present) {
    return <span className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-black ${d.strong ? 'bg-emerald-100 text-emerald-700' : 'bg-emerald-50 text-emerald-600'}`}>⚡ displacement {d.atrMultiple}×{d.strong ? ' (strong)' : ''}</span>;
  }
  return <span className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-black bg-amber-50 text-amber-700">no displacement — weak break</span>;
}

function PDBadge({ pd }: { pd: { zone: string; pct: number } }) {
  const cls = pd.zone === 'DISCOUNT' ? 'bg-emerald-50 text-emerald-700' : pd.zone === 'PREMIUM' ? 'bg-rose-50 text-rose-700' : 'bg-slate-100 text-slate-500';
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-black ${cls}`}>{pd.zone} {pd.pct}%</span>;
}

function DriveBadge({ drive }: { drive: StructureDesk['drive'] }) {
  if (!drive || drive.label === 'NONE') return <span className="text-slate-400">—</span>;
  if (drive.label === 'SECOND_DRIVE') {
    const tag = drive.basis === 'FAILED_FIRST' ? 'after shakeout' : drive.basis === 'RETEST' ? 'after retest' : '';
    return <span title={drive.note} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-black bg-emerald-100 text-emerald-700">2nd drive ✓{tag ? <span className="font-semibold text-emerald-600">{tag}</span> : null}</span>;
  }
  return <span title={drive.note} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-black bg-amber-50 text-amber-700">1st drive — wait</span>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 border-b border-slate-100 last:border-0">
      <span className="text-[11px] font-bold uppercase tracking-wide text-slate-400 pt-0.5">{label}</span>
      <span className="text-sm font-semibold text-slate-800 text-right">{children}</span>
    </div>
  );
}

function DeepPanel({ d }: { d: StructureDesk }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/60 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-lg font-black text-slate-900">{d.symbol}</span>
          <span className="text-[11px] font-bold text-slate-400">{d.timeframe}</span>
          <span className="text-[12px] font-mono text-slate-500">@ {fmt(d.price)}</span>
        </div>
        <div className="flex items-center gap-2">
          <PhasePill phase={d.phase} />
          <DecisionTag d={d.decision} />
          {d.armed && d.decision !== 'HOLD' && <span className="rounded bg-indigo-600 px-1.5 py-0.5 text-[10px] font-black text-white">ARMED</span>}
        </div>
      </div>
      <div className="grid md:grid-cols-2">
        <div className="px-4 py-1">
          <Row label="Trend phase"><PhasePill phase={d.phase} /></Row>
          <Row label="HTF bias (H4/H1)">{d.htfBias || '—'}</Row>
          <Row label="Regime"><span className="capitalize">{d.regime || '—'}</span></Row>
          <Row label="Premium / discount">{d.premiumDiscount ? <PDBadge pd={d.premiumDiscount} /> : <span className="text-slate-400">—</span>}</Row>
          <Row label="Last BOS">{d.bos ? <span className={d.bos.dir === 'bullish' ? 'text-emerald-700' : 'text-rose-700'}>{d.bos.dir} @ {fmt(d.bos.level)} <span className="text-[10px] text-slate-400">(close-confirmed)</span></span> : <span className="text-slate-400">none</span>}</Row>
          <Row label="Liquidity sweep">{d.sweep ? <span className="text-amber-700 font-bold">{d.sweep} sweep</span> : <span className="text-slate-400">none</span>}</Row>
        </div>
        <div className="px-4 py-1 md:border-l border-slate-100">
          <Row label="Zone">
            {d.zone ? (
              <span className={d.zone.kind === 'DEMAND' ? 'text-emerald-700' : 'text-rose-700'}>
                {d.zone.kind} {fmt(d.zone.low)}–{fmt(d.zone.high)}{' '}
                {d.zone.imbalance ? <span className="text-emerald-600 text-[10px]">imbalance ✓</span> : <span className="text-slate-400 text-[10px]">no imbalance</span>}
              </span>
            ) : <span className="text-slate-400">none</span>}
          </Row>
          <Row label="Setup">{d.setup ? <span className="font-black text-slate-900">{d.setup}</span> : <span className="text-slate-400">none</span>}</Row>
          <Row label="Drive"><DriveBadge drive={d.drive} /></Row>
          <Row label="Extension">
            {d.emaDistanceAtr === null ? '—' : (
              <span className={d.extended ? 'text-amber-700 font-black' : 'text-slate-600'}>
                {d.emaDistanceAtr > 0 ? '+' : ''}{d.emaDistanceAtr.toFixed(2)}σ {d.extended && <AlertTriangle size={12} className="inline -mt-0.5" />}
                {d.extended ? ' (stretched — don’t chase)' : ' (ok)'}
              </span>
            )}
          </Row>
          <Row label="Timing">{d.entryTiming || '—'}</Row>
          <Row label="Score / grade">{d.score ?? '—'}{d.grade ? ` · ${d.grade}` : ''}</Row>
        </div>
      </div>

      {/* Trade plan */}
      <div className="border-t border-slate-100 bg-slate-50/40 px-4 py-3">
        {d.plan ? (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
            <span className="inline-flex items-center gap-1 font-semibold text-slate-700"><Crosshair size={14} className="text-blue-500" /> Entry <b className="font-mono">{fmt(d.plan.entry)}</b></span>
            <span className="inline-flex items-center gap-1 font-semibold text-rose-700">SL <b className="font-mono">{fmt(d.plan.sl)}</b></span>
            <span className="inline-flex items-center gap-1 font-semibold text-emerald-700"><Target size={14} /> TP <b className="font-mono">{fmt(d.plan.tp)}</b></span>
            {d.plan.rr !== null && <span className="font-semibold text-indigo-700">R:R 1:{fmt(d.plan.rr, 1)}</span>}
          </div>
        ) : (
          <p className="text-xs font-medium text-slate-400">No actionable plan right now — waiting for a valid setup{d.rejectionReasons.length ? `: ${d.rejectionReasons[0]}` : '.'}</p>
        )}
      </div>

      {/* Liquidity layer — draw-on-liquidity targets, last sweep, breaker, liquidity plan */}
      <div className="border-t border-slate-100 px-4 py-3">
        <div className="flex items-center gap-2 mb-2">
          <Droplets size={15} className="text-sky-500" />
          <h4 className="text-[11px] font-black uppercase tracking-wider text-slate-500">Liquidity</h4>
        </div>

        {/* Liquidity-targeted plan (breaker entry → opposing liquidity pool) */}
        {d.liquidityPlan ? (
          <div className={`rounded-xl border px-3 py-2 mb-3 ${d.liquidityPlan.direction === 'BUY' ? 'border-emerald-200 bg-emerald-50/60' : 'border-rose-200 bg-rose-50/60'}`}>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
              <span className="inline-flex items-center gap-1 font-black"><Zap size={14} className={d.liquidityPlan.direction === 'BUY' ? 'text-emerald-600' : 'text-rose-600'} /> {d.liquidityPlan.direction} (breaker)</span>
              <span className="font-semibold text-slate-700">Entry <b className="font-mono">{fmt(d.liquidityPlan.entry)}</b></span>
              <span className="font-semibold text-rose-700">Stop <b className="font-mono">{fmt(d.liquidityPlan.stop)}</b></span>
              <span className="font-semibold text-emerald-700">Target <b className="font-mono">{fmt(d.liquidityPlan.target)}</b> <span className="text-[10px] text-slate-500">({d.liquidityPlan.targetType}{d.liquidityPlan.targetEqual ? ' eq' : ''})</span></span>
              <span className="font-black text-indigo-700">RR 1:{d.liquidityPlan.rr.toFixed(1)}</span>
              <DisplacementBadge d={d.liquidityPlan.displacement} />
            </div>
            <p className="mt-1 text-[10px] font-medium text-slate-500">Entry/stop from the breaker; target is the opposing resting liquidity (draw on liquidity). {d.liquidityPlan.displacement.present ? 'Displacement confirms institutional momentum.' : 'No displacement — treat as a low-conviction break.'}</p>
          </div>
        ) : null}

        <div className="grid md:grid-cols-2 gap-x-6">
          <div className="py-0.5">
            <Row label="Breaker">
              {d.breaker ? (
                <span className="inline-flex flex-wrap items-center gap-1.5 justify-end">
                  <span className={d.breaker.type === 'BULLISH' ? 'text-emerald-700' : 'text-rose-700'}>
                    {d.breaker.type} · zone {fmt(d.breaker.zoneBottom)}–{fmt(d.breaker.zoneTop)} <span className="text-[10px] text-slate-400">({d.breaker.ageBars} bars ago)</span>
                  </span>
                  <DisplacementBadge d={d.breaker.displacement} />
                </span>
              ) : <span className="text-slate-400">none</span>}
            </Row>
            <Row label="Last sweep">
              {d.liquidity.recentSweep ? (
                <span className="text-amber-700">{d.liquidity.recentSweep.type === 'BSL' ? 'buy-side' : 'sell-side'} @ {fmt(d.liquidity.recentSweep.price)} <span className="text-[10px] text-slate-400">{ageMins(d.liquidity.recentSweep.sweptAtMs)}</span></span>
              ) : <span className="text-slate-400">none</span>}
            </Row>
          </div>
          <div className="py-0.5">
            <Row label="Draw ↑ (target)">{d.liquidity.targetAbove ? <span className="text-emerald-700 font-mono">{fmt(d.liquidity.targetAbove.price)}{d.liquidity.targetAbove.equal ? ` ×${d.liquidity.targetAbove.touches}` : ''}</span> : <span className="text-slate-400">—</span>}</Row>
            <Row label="Draw ↓ (target)">{d.liquidity.targetBelow ? <span className="text-rose-700 font-mono">{fmt(d.liquidity.targetBelow.price)}{d.liquidity.targetBelow.equal ? ` ×${d.liquidity.targetBelow.touches}` : ''}</span> : <span className="text-slate-400">—</span>}</Row>
          </div>
        </div>

        {/* Pool chips */}
        {(d.liquidity.buySide.length > 0 || d.liquidity.sellSide.length > 0) && (
          <div className="mt-2 space-y-1">
            {d.liquidity.buySide.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5"><span className="text-[10px] font-bold uppercase text-slate-400 w-14">Buy-side</span>{d.liquidity.buySide.map((p) => <PoolChip key={`b${p.price}`} p={p} />)}</div>
            )}
            {d.liquidity.sellSide.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5"><span className="text-[10px] font-bold uppercase text-slate-400 w-14">Sell-side</span>{d.liquidity.sellSide.map((p) => <PoolChip key={`s${p.price}`} p={p} />)}</div>
            )}
            <p className="text-[10px] text-slate-400">Greyed/struck = already swept. ×N = stacked equal levels (stronger pool).</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function DayTradingDesk() {
  const [tf, setTf] = useState('M5');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<StructureDeskResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchStructureDesk(undefined, tf);
      setData(res);
      setSelected((cur) => (cur && res.desks.some((d) => d.symbol === cur)) ? cur : res.primarySymbol);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load desk');
    } finally {
      setLoading(false);
    }
  }, [tf]);

  useEffect(() => { void load(); }, [load]);

  const primary = useMemo(() => data?.desks.find((d) => d.symbol === selected) || data?.desks[0] || null, [data, selected]);

  return (
    <div className="space-y-6 p-1">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-blue-100 p-2"><LineChart className="text-blue-600" size={22} /></div>
          <div>
            <h1 className="text-xl font-black text-slate-900">Day Trading Desk</h1>
            <p className="text-xs font-medium text-slate-400">Market-structure read: trend · BOS · sweep · supply/demand · setup · plan.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select value={tf} onChange={(e) => setTf(e.target.value)} className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-semibold">
            {TF_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-bold text-white hover:bg-slate-700 disabled:opacity-50">
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Refresh
          </button>
        </div>
      </div>

      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">{error}</div>}

      <div className="grid lg:grid-cols-[280px_1fr] gap-5">
        {/* Watchlist */}
        <div className="rounded-2xl border border-slate-200 bg-white shadow-card overflow-hidden h-fit">
          <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
            <Layers size={15} className="text-slate-400" />
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-500">Watchlist · {data?.timeframe || tf}</h3>
          </div>
          <div className="divide-y divide-slate-100 max-h-[70vh] overflow-y-auto">
            {data?.desks.length ? data.desks.map((d) => (
              <button
                key={d.symbol}
                type="button"
                onClick={() => setSelected(d.symbol)}
                className={`w-full text-left px-4 py-2.5 hover:bg-slate-50 transition ${d.symbol === (primary?.symbol) ? 'bg-blue-50/60 border-l-2 border-blue-500' : ''}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-black text-slate-900 text-sm">{d.symbol}</span>
                  <DecisionTag d={d.decision} />
                </div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
                  <PhasePill phase={d.phase} />
                  {d.setup && <span className="font-semibold text-slate-600 truncate">{d.setup}</span>}
                  {d.breaker && <Zap size={11} className={d.breaker.type === 'BULLISH' ? 'text-emerald-500' : 'text-rose-500'} />}
                  {d.extended && <AlertTriangle size={11} className="text-amber-500" />}
                </div>
              </button>
            )) : (
              <div className="px-4 py-8 text-center text-sm font-medium text-slate-400">{loading ? 'Loading…' : 'No symbols with fresh candles.'}</div>
            )}
          </div>
        </div>

        {/* Deep panel */}
        <div>
          {primary ? <DeepPanel d={primary} /> : (
            !loading && <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-12 text-center text-sm font-medium text-slate-400">Pick a symbol from the watchlist.</div>
          )}
          {data?.note && <p className="mt-3 text-[11px] font-medium text-slate-400">{data.note}</p>}
        </div>
      </div>
    </div>
  );
}
