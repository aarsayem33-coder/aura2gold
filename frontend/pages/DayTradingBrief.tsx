import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Loader2, RefreshCw, Sunrise, AlertTriangle, ShieldAlert, TrendingUp, TrendingDown,
  CalendarClock, Search, ArrowUpDown, Filter, X, Gauge, Ban,
} from 'lucide-react';
import { fetchDayTradingBrief } from '../mt5Api';
import type { DayTradingBriefResponse, DayTradingBriefSymbol } from '../types';

const TF_OPTIONS = ['M5', 'M15', 'M30', 'H1', 'H4'];

/**
 * How much of the average daily range is already spent before the move is treated as late.
 *
 * A day trade taken after most of the day's range is used has to fight mean reversion for the
 * rest of it. 70% is the conventional caution line; 90% is where the room left is smaller than
 * a typical stop.
 */
const ADR_CAUTION = 70;
const ADR_SPENT = 90;

function fmtTime(iso: string) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
function fmtNum(v: number | null | undefined, digits = 2) {
  return v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(digits);
}

function DecisionBadge({ d }: { d: string }) {
  const buy = /BUY/i.test(d), sell = /SELL/i.test(d);
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-black ${
      buy ? 'bg-emerald-100 text-emerald-700' : sell ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-500'
    }`}>
      {buy ? <TrendingUp size={11} /> : sell ? <TrendingDown size={11} /> : null}{d}
    </span>
  );
}

/**
 * Extension from the EMA in ATR, which is the "don't chase" number.
 *
 * Signed on purpose: +2.4 ATR above the mean and −2.4 below are opposite trades, and an
 * unsigned magnitude would make a stretched short look like a stretched long.
 */
function ExtensionCell({ s }: { s: DayTradingBriefSymbol }) {
  const v = s.emaDistanceAtr;
  if (v === null || v === undefined) return <span className="text-slate-300">—</span>;
  return (
    <span className={`font-bold tabular-nums ${s.extended ? 'text-amber-700' : 'text-slate-600'}`}>
      {v > 0 ? '+' : ''}{fmtNum(v, 2)}
      {s.extended ? <span className="ml-1 text-[10px] font-black uppercase">stretched</span> : null}
    </span>
  );
}

/** How much of the day's range is gone — the other half of "am I late?". */
function AdrBar({ pct }: { pct: number | null | undefined }) {
  if (pct === null || pct === undefined) return <span className="text-slate-300">—</span>;
  const clamped = Math.max(0, Math.min(130, pct));
  const tone = pct >= ADR_SPENT ? 'bg-rose-500' : pct >= ADR_CAUTION ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div className="min-w-[92px]">
      <div className="flex items-center justify-between text-[10px] font-bold">
        <span className={pct >= ADR_SPENT ? 'text-rose-700' : pct >= ADR_CAUTION ? 'text-amber-700' : 'text-slate-500'}>
          {Math.round(pct)}%
        </span>
        {pct >= ADR_SPENT ? <span className="text-rose-600">spent</span> : null}
      </div>
      <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, clamped)}%` }} />
      </div>
    </div>
  );
}

type SortKey = 'score' | 'extension' | 'adr' | 'rr' | 'symbol';

export default function DayTradingBrief() {
  const [tf, setTf] = useState('M15');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<DayTradingBriefResponse | null>(null);

  // ── filters ────────────────────────────────────────────────────────────────
  const [q, setQ] = useState('');
  const [decision, setDecision] = useState<'ALL' | 'BUY' | 'SELL' | 'HOLD'>('ALL');
  const [minScore, setMinScore] = useState(0);
  const [regime, setRegime] = useState('ALL');
  const [bias, setBias] = useState('ALL');
  const [hideExtended, setHideExtended] = useState(false);
  const [hideNewsRisk, setHideNewsRisk] = useState(false);
  const [hideSpentAdr, setHideSpentAdr] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('score');
  const [sortDesc, setSortDesc] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchDayTradingBrief(tf));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load brief');
    } finally {
      setLoading(false);
    }
  }, [tf]);

  useEffect(() => { void load(); }, [load]);

  const all = data?.symbols || [];

  const regimes = useMemo(
    () => [...new Set(all.map((s) => s.regime).filter(Boolean))] as string[], [all],
  );
  const biases = useMemo(
    () => [...new Set(all.map((s) => s.htfBias).filter(Boolean))] as string[], [all],
  );

  const rows = useMemo(() => {
    const needle = q.trim().toUpperCase();
    const filtered = all.filter((s) => {
      if (needle && !String(s.symbol).toUpperCase().includes(needle)) return false;
      if (decision !== 'ALL' && !String(s.decision || '').toUpperCase().includes(decision)) return false;
      if (minScore > 0 && (s.score ?? 0) < minScore) return false;
      if (regime !== 'ALL' && s.regime !== regime) return false;
      if (bias !== 'ALL' && s.htfBias !== bias) return false;
      if (hideExtended && s.extended) return false;
      if (hideNewsRisk && s.newsRisk) return false;
      if (hideSpentAdr && (s.adrUsagePercent ?? 0) >= ADR_SPENT) return false;
      return true;
    });
    const val = (s: DayTradingBriefSymbol) => {
      if (sortKey === 'score') return s.score ?? -1;
      if (sortKey === 'extension') return Math.abs(s.emaDistanceAtr ?? 0);
      if (sortKey === 'adr') return s.adrUsagePercent ?? -1;
      if (sortKey === 'rr') return s.riskRewardRatio ?? -1;
      return 0;
    };
    return [...filtered].sort((a, b) => {
      if (sortKey === 'symbol') {
        return sortDesc ? String(b.symbol).localeCompare(String(a.symbol)) : String(a.symbol).localeCompare(String(b.symbol));
      }
      return sortDesc ? val(b) - val(a) : val(a) - val(b);
    });
  }, [all, q, decision, minScore, regime, bias, hideExtended, hideNewsRisk, hideSpentAdr, sortKey, sortDesc]);

  // Counted over EVERYTHING, not the filtered view — these tiles describe the session, and a
  // filter that hid the extended markets would make "0 stretched" read as "all clear".
  const stats = useMemo(() => ({
    total: all.length,
    actionable: all.filter((s) => /BUY|SELL/i.test(String(s.decision || ''))).length,
    extended: all.filter((s) => s.extended).length,
    news: all.filter((s) => s.newsRisk).length,
    adrSpent: all.filter((s) => (s.adrUsagePercent ?? 0) >= ADR_SPENT).length,
  }), [all]);

  const dr = data?.dailyRisk;
  const activeFilters = (q ? 1 : 0) + (decision !== 'ALL' ? 1 : 0) + (minScore > 0 ? 1 : 0)
    + (regime !== 'ALL' ? 1 : 0) + (bias !== 'ALL' ? 1 : 0)
    + (hideExtended ? 1 : 0) + (hideNewsRisk ? 1 : 0) + (hideSpentAdr ? 1 : 0);
  const clearAll = () => {
    setQ(''); setDecision('ALL'); setMinScore(0); setRegime('ALL'); setBias('ALL');
    setHideExtended(false); setHideNewsRisk(false); setHideSpentAdr(false);
  };

  const sortBtn = (key: SortKey, label: string) => (
    <button
      type="button"
      onClick={() => { if (sortKey === key) setSortDesc((v) => !v); else { setSortKey(key); setSortDesc(true); } }}
      className={`inline-flex items-center gap-1 ${sortKey === key ? 'text-slate-900' : 'text-slate-400 hover:text-slate-600'}`}
    >
      {label}<ArrowUpDown size={10} />
    </button>
  );

  return (
    <div className="space-y-4 p-1">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-amber-100 p-2"><Sunrise className="text-amber-600" size={22} /></div>
          <div>
            <h1 className="text-xl font-black text-slate-900">Pre-Session Brief</h1>
            <p className="text-xs font-medium text-slate-400">
              Bias · extension · ADR · levels · news · daily risk — your one screen before the session.
            </p>
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

      {/* Session shape at a glance. Counted over every market, never the filtered subset. */}
      {all.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {[
            { k: 'Markets', v: stats.total, tone: 'border-slate-200 bg-white text-slate-800', sub: `${tf} brief` },
            { k: 'Actionable', v: stats.actionable, tone: 'border-emerald-200 bg-emerald-50 text-emerald-800', sub: 'BUY or SELL' },
            { k: 'Stretched', v: stats.extended, tone: 'border-amber-200 bg-amber-50 text-amber-800', sub: "don't chase" },
            { k: 'ADR spent', v: stats.adrSpent, tone: 'border-rose-200 bg-rose-50 text-rose-800', sub: `≥${ADR_SPENT}% of range` },
            { k: 'News risk', v: stats.news, tone: 'border-slate-200 bg-slate-50 text-slate-700', sub: 'event nearby' },
          ].map((c) => (
            <div key={c.k} className={`rounded-xl border p-2.5 ${c.tone}`}>
              <div className="text-[10px] font-black uppercase tracking-wider opacity-70">{c.k}</div>
              <div className="text-xl font-black tabular-nums">{c.v}</div>
              <div className="text-[10px] font-semibold opacity-60">{c.sub}</div>
            </div>
          ))}
        </div>
      )}

      {/* Daily risk budget */}
      {dr && (
        <div className={`rounded-2xl border p-4 shadow-card ${dr.limitHit ? 'border-rose-300 bg-rose-50' : 'border-slate-200 bg-white'}`}>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <ShieldAlert size={16} className={dr.limitHit ? 'text-rose-600' : 'text-slate-500'} />
            <h3 className="text-sm font-black uppercase tracking-wider text-slate-500">Daily risk budget</h3>
            {dr.dateUtc && <span className="text-[11px] font-semibold text-slate-400">{dr.dateUtc} (UTC)</span>}
            {dr.limitHit && <span className="rounded bg-rose-600 px-2 py-0.5 text-[10px] font-black text-white">STOP HIT — DONE FOR THE DAY</span>}
          </div>
          {dr.available ? (
            <>
              <div className="grid grid-cols-2 gap-3 text-sm lg:grid-cols-5">
                <div className="rounded-xl bg-slate-50 p-3">
                  <div className="text-[11px] font-bold uppercase text-slate-400">Net today</div>
                  <div className={`text-lg font-black ${(dr.settledR ?? 0) > 0 ? 'text-emerald-700' : (dr.settledR ?? 0) < 0 ? 'text-rose-700' : 'text-slate-900'}`}>
                    {(dr.settledR ?? 0) > 0 ? '+' : ''}{fmtNum(dr.settledR ?? 0, 2)}R
                  </div>
                </div>
                <div className="rounded-xl bg-emerald-50 p-3"><div className="text-[11px] font-bold uppercase text-emerald-500">Wins</div><div className="text-lg font-black text-emerald-700">{dr.wins ?? 0}</div></div>
                <div className="rounded-xl bg-rose-50 p-3"><div className="text-[11px] font-bold uppercase text-rose-500">Losses</div><div className="text-lg font-black text-rose-700">{dr.losses ?? 0}</div></div>
                <div className="rounded-xl bg-blue-50 p-3"><div className="text-[11px] font-bold uppercase text-blue-500">Open</div><div className="text-lg font-black text-blue-700">{dr.openCount ?? 0}</div></div>
                <div className="rounded-xl bg-slate-50 p-3"><div className="text-[11px] font-bold uppercase text-slate-400">Stop at</div><div className="text-lg font-black text-slate-900">-{fmtNum(dr.dailyStopR, 0)}R</div></div>
              </div>

              {/* How much of the loss budget is gone. Drawn from the STOP downward, because the
                  number that ends the day is the loss, not the profit. */}
              {dr.dailyStopR ? (() => {
                const stop = Math.abs(Number(dr.dailyStopR)) || 1;
                const lost = Math.max(0, -(dr.settledR ?? 0));
                const used = Math.min(100, (lost / stop) * 100);
                return (
                  <div className="mt-3">
                    <div className="flex justify-between text-[11px] font-bold text-slate-500">
                      <span>Loss budget used</span>
                      <span className={used >= 100 ? 'text-rose-700' : used >= 50 ? 'text-amber-700' : 'text-slate-500'}>
                        {fmtNum(lost, 2)}R of {fmtNum(stop, 0)}R
                      </span>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
                      <div className={`h-full rounded-full ${used >= 100 ? 'bg-rose-600' : used >= 50 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${used}%` }} />
                    </div>
                  </div>
                );
              })() : null}

              <p className={`mt-3 text-[12px] font-semibold ${dr.limitHit ? 'text-rose-700' : 'text-slate-500'}`}>{dr.note}</p>
            </>
          ) : (
            <p className="text-sm font-medium text-slate-400">{dr.note}</p>
          )}
        </div>
      )}

      {/* News */}
      {data?.news && data.news.length > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3">
          <div className="mb-1.5 flex items-center gap-2">
            <CalendarClock size={15} className="text-amber-600" />
            <h3 className="text-sm font-black uppercase tracking-wider text-amber-800">Events in the window</h3>
          </div>
          <ul className="space-y-0.5 text-[12px] font-semibold text-amber-900">
            {data.news.slice(0, 6).map((nw, i) => (
              <li key={i}>{typeof nw === 'string' ? nw : JSON.stringify(nw).slice(0, 120)}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Filters */}
      <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider text-slate-400">
            <Filter size={12} />Filters
          </span>

          <div className="relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={q} onChange={(e) => setQ(e.target.value)} placeholder="symbol"
              className="w-28 rounded-lg border border-slate-200 py-1 pl-6 pr-2 text-[12px] font-semibold text-slate-700"
            />
          </div>

          <div className="flex gap-1">
            {(['ALL', 'BUY', 'SELL', 'HOLD'] as const).map((d) => (
              <button key={d} type="button" onClick={() => setDecision(d)}
                className={`rounded-md px-2 py-1 text-[11px] font-bold ${decision === d ? 'bg-slate-900 text-white' : 'border border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
                {d}
              </button>
            ))}
          </div>

          <label className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-500">
            score ≥
            <input type="number" min={0} max={100} value={minScore}
              onChange={(e) => setMinScore(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
              className="w-14 rounded-lg border border-slate-200 px-1.5 py-1 text-[12px] font-semibold text-slate-700" />
          </label>

          {regimes.length > 1 && (
            <select value={regime} onChange={(e) => setRegime(e.target.value)}
              className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-bold text-slate-600">
              <option value="ALL">any regime</option>
              {regimes.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          )}

          {biases.length > 1 && (
            <select value={bias} onChange={(e) => setBias(e.target.value)}
              className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-bold text-slate-600">
              <option value="ALL">any H4 bias</option>
              {biases.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          )}

          {/* The three discipline filters — each one hides a reason not to take the trade. */}
          {[
            { on: hideExtended, set: setHideExtended, label: 'hide stretched', icon: <Gauge size={11} /> },
            { on: hideSpentAdr, set: setHideSpentAdr, label: `hide ADR ≥${ADR_SPENT}%`, icon: <Gauge size={11} /> },
            { on: hideNewsRisk, set: setHideNewsRisk, label: 'hide news risk', icon: <Ban size={11} /> },
          ].map((t) => (
            <button key={t.label} type="button" onClick={() => t.set(!t.on)}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-bold ${t.on ? 'bg-amber-500 text-white' : 'border border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
              {t.icon}{t.label}
            </button>
          ))}

          {activeFilters > 0 && (
            <button type="button" onClick={clearAll}
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-bold text-slate-500 hover:bg-slate-50">
              <X size={11} />clear {activeFilters}
            </button>
          )}
        </div>
        <p className="mt-1.5 text-[11px] font-semibold text-slate-400">
          showing {rows.length} of {all.length} markets
        </p>
      </div>

      {/* Mobile cards */}
      <div className="grid gap-2 lg:hidden">
        {rows.map((s) => (
          <div key={s.symbol} className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-black text-slate-800">{s.symbol} <span className="text-slate-400">{s.timeframe}</span></div>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <DecisionBadge d={String(s.decision || 'HOLD')} />
                  <span className="text-[11px] font-bold text-slate-500">{s.grade}</span>
                </div>
              </div>
              <div className="text-right">
                <div className="text-lg font-black tabular-nums text-slate-800">{s.score ?? '—'}</div>
                <div className="text-[10px] font-bold uppercase text-slate-400">score</div>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
              <div><span className="text-slate-400">extension </span><ExtensionCell s={s} /></div>
              <div><span className="text-slate-400">RR </span><b>{fmtNum(s.riskRewardRatio, 1)}</b></div>
              <div className="col-span-2"><span className="text-slate-400">ADR used</span><AdrBar pct={s.adrUsagePercent} /></div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5 border-t border-slate-100 pt-2 text-[10px] font-bold">
              {s.regime && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">{s.regime}</span>}
              {s.htfBias && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">H4 {s.htfBias}</span>}
              {s.entryTiming && <span className="rounded bg-sky-50 px-1.5 py-0.5 text-sky-700">{s.entryTiming}</span>}
              {s.newsRisk && <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-amber-800"><AlertTriangle size={9} />news</span>}
            </div>
          </div>
        ))}
      </div>

      {/* Desktop table */}
      <div className="hidden overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm lg:block">
        <table className="w-full min-w-[1000px] text-[12px]">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left font-black">{sortBtn('symbol', 'Market')}</th>
              <th className="px-3 py-2 text-left font-black">Call</th>
              <th className="px-3 py-2 text-right font-black">{sortBtn('score', 'Score')}</th>
              <th className="px-3 py-2 text-left font-black">Regime / H4</th>
              <th className="px-3 py-2 text-right font-black">{sortBtn('extension', 'Extension')}</th>
              <th className="px-3 py-2 text-left font-black">{sortBtn('adr', 'ADR used')}</th>
              <th className="px-3 py-2 text-right font-black">{sortBtn('rr', 'RR')}</th>
              <th className="px-3 py-2 text-left font-black">Levels</th>
              <th className="px-3 py-2 text-left font-black">Timing</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((s) => (
              <tr key={s.symbol} className={s.newsRisk ? 'bg-amber-50/40' : ''}>
                <td className="px-3 py-2">
                  <div className="font-black text-slate-800">{s.symbol}</div>
                  <div className="text-[10px] font-semibold text-slate-400">{s.timeframe} · {fmtNum(s.price, 5)}</div>
                </td>
                <td className="px-3 py-2">
                  <DecisionBadge d={String(s.decision || 'HOLD')} />
                  <div className="mt-0.5 text-[10px] font-bold text-slate-400">{s.grade}</div>
                </td>
                <td className="px-3 py-2 text-right text-base font-black tabular-nums text-slate-800">{s.score ?? '—'}</td>
                <td className="px-3 py-2">
                  <div className="font-semibold text-slate-600">{s.regime || '—'}</div>
                  <div className="text-[10px] font-bold text-slate-400">H4 {s.htfBias || '—'}</div>
                </td>
                <td className="px-3 py-2 text-right"><ExtensionCell s={s} /></td>
                <td className="px-3 py-2"><AdrBar pct={s.adrUsagePercent} /></td>
                <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-600">{fmtNum(s.riskRewardRatio, 1)}</td>
                <td className="px-3 py-2 text-[11px] text-slate-500">
                  <div>S {fmtNum(s.nearestSupport, 5)}</div>
                  <div>R {fmtNum(s.nearestResistance, 5)}</div>
                </td>
                <td className="px-3 py-2">
                  {s.entryTiming ? <span className="rounded bg-sky-50 px-1.5 py-0.5 text-[10px] font-bold text-sky-700">{s.entryTiming}</span> : <span className="text-slate-300">—</span>}
                  {s.newsRisk ? <div className="mt-0.5 inline-flex items-center gap-1 text-[10px] font-bold text-amber-700"><AlertTriangle size={9} />news risk</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!loading && rows.length === 0 && all.length > 0 && (
        <p className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-center text-[12px] font-semibold text-slate-500">
          No market matches these filters. {activeFilters > 0 && <button type="button" onClick={clearAll} className="underline">Clear them</button>}
        </p>
      )}

      {data && (
        <p className="text-[11px] font-medium text-slate-400">
          {data.note} · generated {fmtTime(data.generatedAt)}
        </p>
      )}
    </div>
  );
}
