import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Crosshair, Loader2, RefreshCw, ArrowUp, ArrowDown, Clock, ChevronDown, ChevronUp,
  TrendingUp, TrendingDown, Minus, Eye, ShieldAlert, FlaskConical, Info,
} from 'lucide-react';
import { fetchSetupForecasts } from '../mt5Api';
import type { SetupForecastResponse, SetupForecast } from '../types';

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

function ForecastCard({ f }: { f: SetupForecast }) {
  const [open, setOpen] = useState(false);
  const buy = f.expectedDirection === 'BUY';
  const meta = SCENARIO_META[f.scenario] || { label: f.scenario, blurb: '' };
  const plan = f.plan;
  const warnings = plan?.challenge?.warnings || [];
  const split = f.consensusDirection === 'SPLIT';

  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${buy ? 'bg-emerald-100 text-emerald-600' : 'bg-rose-100 text-rose-500'}`}>
          {buy ? <ArrowUp size={16} /> : <ArrowDown size={16} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-black text-slate-800">
            {f.symbol} <span className="text-slate-400">{f.timeframe}</span>
            {' '}· {f.levelLabel || f.levelType || 'level'} @ {px(f.level, f.symbol)}
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
            <p className="text-sm font-black text-violet-700">{f.bestScore ?? '—'}</p>
            <DriftBadge f={f} />
          </div>
          <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">
            {f.agreeCount} strat{f.agreeCount === 1 ? '' : 's'}{f.dissentCount ? ` · ${f.dissentCount} against` : ''}
          </span>
          {open ? <ChevronUp size={15} className="text-slate-400" /> : <ChevronDown size={15} className="text-slate-400" />}
        </div>
      </button>

      {open && (
        <div className="space-y-3 border-t border-slate-100 px-4 py-3">
          <p className="text-[11px] font-semibold text-slate-500">
            If price {meta.blurb} at {px(f.level, f.symbol)}:
          </p>
          {/* Which strategies fire, by their own rules — dissenters shown, never hidden */}
          <div className="flex flex-wrap gap-1.5">
            {f.fires.map((x) => (
              <span
                key={x.strategyId}
                title={`stage ${x.stage}${x.grade ? ` · ${x.grade}` : ''}`}
                className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${x.agrees ? 'bg-violet-50 text-violet-700' : 'bg-amber-50 text-amber-700'}`}
              >
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

          {/* The assumption, disclosed: the exact bars every strategy was judged against */}
          <details className="text-[11px]">
            <summary className="cursor-pointer font-bold text-slate-400 hover:text-slate-600">
              <Eye size={11} className="mb-0.5 mr-1 inline" />Assumed scenario bars (the hypothesis, not real data)
            </summary>
            <div className="mt-1 space-y-0.5 font-mono text-[10px] text-slate-500">
              {f.scenarioBars.map((b, i) => (
                <p key={i}>bar{i + 1} · O {px(b.open, f.symbol)} H {px(b.high, f.symbol)} L {px(b.low, f.symbol)} C {px(b.close, f.symbol)}</p>
              ))}
            </div>
          </details>

          <p className="text-[10px] font-medium text-slate-400">
            first seen {new Date(f.createdAt).toLocaleString()} · re-scored {f.driftSummary.points}× · last {new Date(f.updatedAt).toLocaleTimeString()}
          </p>
        </div>
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
  const [showLab, setShowLab] = useState(false);

  const load = useCallback(async (spin = false) => {
    if (spin) setLoading(true);
    try { setData(await fetchSetupForecasts()); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed to load forecasts'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load(true);
    const t = setInterval(() => load(false), 60000);
    return () => clearInterval(t);
  }, [load]);

  const all = useMemo(() => (data?.buckets || []).flatMap((b) => b.forecasts), [data]);
  const uniq = (pick: (f: SetupForecast) => string | null) =>
    Array.from(new Set(all.map(pick).filter(Boolean) as string[])).sort();
  const match = (f: SetupForecast) => (
    (!fSymbol || f.symbol === fSymbol)
    && (!fTimeframe || f.timeframe === fTimeframe)
    && (!fScenario || f.scenario === fScenario)
    && (!fStrategy || f.fires.some((x) => x.strategyId === fStrategy))
    && (f.bestScore ?? 0) >= fMinScore
  );
  const filtersActive = Boolean(fSymbol || fTimeframe || fScenario || fStrategy || fMinScore > 0);

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

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
        {([
          ['Symbol', fSymbol, setFSymbol, uniq((f) => f.symbol)],
          ['TF', fTimeframe, setFTimeframe, uniq((f) => f.timeframe)],
          ['Scenario', fScenario, setFScenario, uniq((f) => f.scenario)],
          ['Strategy', fStrategy, setFStrategy, uniq((f) => f.fires.map((x) => x.strategyId)).length ? Array.from(new Set(all.flatMap((f) => f.fires.map((x) => x.strategyId)))).sort() : []],
        ] as Array<[string, string, (v: string) => void, string[]]>).map(([label, value, set, opts]) => (
          <label key={label} className="flex items-center gap-1 text-[11px] font-bold text-slate-500">
            {label}
            <select value={value} onChange={(e) => set(e.target.value)} className="rounded-md border border-slate-200 bg-slate-50 px-1.5 py-1 text-[11px] font-bold text-slate-700">
              <option value="">All</option>
              {opts.map((o) => <option key={o} value={o}>{SCENARIO_META[o]?.label || o}</option>)}
            </select>
          </label>
        ))}
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

      {/* Horizon buckets — the requested grouping, closest first, empty buckets visible */}
      {(data?.buckets || []).map((b) => {
        const rows = b.forecasts.filter(match);
        return (
          <section key={b.key}>
            <h2 className="mb-2 flex items-center gap-2 text-sm font-black uppercase tracking-wider text-slate-600">
              <Clock size={14} className="text-violet-400" />{b.label}
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">{rows.length}</span>
            </h2>
            {rows.length ? (
              <div className="space-y-2">{rows.map((f) => <ForecastCard key={f.id} f={f} />)}</div>
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

      {(data?.caveats?.length || 0) > 0 && (
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
