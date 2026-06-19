import React, { useEffect, useMemo, useState } from 'react';
import { CalendarDays, RefreshCcw, AlertTriangle, Clock, Loader2, Filter, TrendingUp, Database, Cloud, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { fetchEconomicNews, refreshNewsFallback } from '../mt5Api';
import type { NewsEvent, NewsImpact, NewsSourceHealth } from '../types';

const IMPACT_META: Record<NewsImpact, { label: string; dot: string; chip: string; bar: string; rank: number }> = {
  HIGH: { label: 'High', dot: 'bg-red-500', chip: 'bg-red-50 text-red-700 border-red-200', bar: 'bg-red-500', rank: 3 },
  MODERATE: { label: 'Medium', dot: 'bg-amber-500', chip: 'bg-amber-50 text-amber-700 border-amber-200', bar: 'bg-amber-400', rank: 2 },
  LOW: { label: 'Low', dot: 'bg-slate-400', chip: 'bg-slate-50 text-slate-600 border-slate-200', bar: 'bg-slate-300', rank: 1 },
  NONE: { label: 'None', dot: 'bg-slate-300', chip: 'bg-slate-50 text-slate-500 border-slate-200', bar: 'bg-slate-200', rank: 0 },
  HOLIDAY: { label: 'Holiday', dot: 'bg-indigo-400', chip: 'bg-indigo-50 text-indigo-600 border-indigo-200', bar: 'bg-indigo-300', rank: 0 },
};

const CURRENCY_FILTERS = ['ALL', 'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD', 'XAU'];
type DateFilter = 'TODAY' | 'TOMORROW' | 'WEEK' | 'ALL';
const DAY_MS = 86400000;

function fmtValue(v: number | null) {
  if (v === null || v === undefined) return '—';
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function dayKey(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

function timeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function countdown(ms: number) {
  const abs = Math.abs(ms);
  const mins = Math.round(abs / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hrs}h ${rem}m`;
}

function startOfLocalDay(ms: number) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function isTodayLocal(ms: number) {
  return startOfLocalDay(ms) === startOfLocalDay(Date.now());
}

/** [from, to) epoch-ms window for the active date filter (local day boundaries). */
function activeRange(dateFilter: DateFilter, pickedDate: string): [number | null, number | null] {
  const todayStart = startOfLocalDay(Date.now());
  if (pickedDate) {
    const d = new Date(`${pickedDate}T00:00:00`);
    if (!Number.isNaN(d.getTime())) {
      const s = startOfLocalDay(d.getTime());
      return [s, s + DAY_MS];
    }
  }
  if (dateFilter === 'TODAY') return [todayStart, todayStart + DAY_MS];
  if (dateFilter === 'TOMORROW') return [todayStart + DAY_MS, todayStart + 2 * DAY_MS];
  if (dateFilter === 'WEEK') return [todayStart, todayStart + 7 * DAY_MS];
  return [null, null]; // ALL
}

export default function EconomicCalendar() {
  const [events, setEvents] = useState<NewsEvent[]>([]);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [sources, setSources] = useState<Record<string, NewsSourceHealth>>({});
  const [loading, setLoading] = useState(false);
  const [refreshingFallback, setRefreshingFallback] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currency, setCurrency] = useState('ALL');
  const [minImpact, setMinImpact] = useState<'ALL' | 'HIGH' | 'MODERATE'>('ALL');
  const [dateFilter, setDateFilter] = useState<DateFilter>('TODAY'); // present date first by default
  const [pickedDate, setPickedDate] = useState(''); // YYYY-MM-DD overrides the chips
  const [now, setNow] = useState(Date.now());

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchEconomicNews({ hours: 168 }); // backend also returns the past 24h
      setEvents(res.events || []);
      setUpdatedAt(res.updatedAt);
      setSource(res.source);
      setSources(res.sources || {});
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load economic calendar');
    } finally {
      setLoading(false);
    }
  }

  async function handleRefreshFallback() {
    setRefreshingFallback(true);
    setError(null);
    try {
      await refreshNewsFallback();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Fallback refresh failed');
    } finally {
      setRefreshingFallback(false);
    }
  }

  useEffect(() => {
    void load();
    const refresh = window.setInterval(() => void load(), 60000);
    const ticker = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { window.clearInterval(refresh); window.clearInterval(ticker); };
  }, []);

  const [rangeFrom, rangeTo] = useMemo(() => activeRange(dateFilter, pickedDate), [dateFilter, pickedDate, now]);

  const filtered = useMemo(() => {
    return events.filter((e) => {
      if (currency !== 'ALL' && e.currency !== currency) return false;
      if (minImpact === 'HIGH' && e.impact !== 'HIGH') return false;
      if (minImpact === 'MODERATE' && !['HIGH', 'MODERATE'].includes(e.impact)) return false;
      if (rangeFrom !== null && rangeTo !== null && !(e.timestampUtc >= rangeFrom && e.timestampUtc < rangeTo)) return false;
      return true;
    });
  }, [events, currency, minImpact, rangeFrom, rangeTo]);

  const grouped = useMemo(() => {
    const map = new Map<string, NewsEvent[]>();
    for (const e of [...filtered].sort((a, b) => a.timestampUtc - b.timestampUtc)) {
      const key = dayKey(e.timeIso);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    }
    return [...map.entries()];
  }, [filtered]);

  const nextHigh = useMemo(() => {
    return [...events]
      .filter((e) => e.impact === 'HIGH' && e.timestampUtc >= now)
      .sort((a, b) => a.timestampUtc - b.timestampUtc)[0] || null;
  }, [events, now]);

  const highCount = filtered.filter((e) => e.impact === 'HIGH').length;
  const rangeLabel = pickedDate
    ? new Date(`${pickedDate}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
    : dateFilter === 'TODAY' ? 'Today' : dateFilter === 'TOMORROW' ? 'Tomorrow' : dateFilter === 'WEEK' ? 'This week' : 'All loaded';

  // Step the picked date by ±1 day (keeps the FF-style day navigation handy).
  function stepPicked(dir: number) {
    const baseMs = pickedDate ? new Date(`${pickedDate}T00:00:00`).getTime() : startOfLocalDay(Date.now());
    const next = new Date(startOfLocalDay(baseMs) + dir * DAY_MS);
    const yyyy = next.getFullYear();
    const mm = String(next.getMonth() + 1).padStart(2, '0');
    const dd = String(next.getDate()).padStart(2, '0');
    setPickedDate(`${yyyy}-${mm}-${dd}`);
  }

  const dateChips: { key: DateFilter; label: string }[] = [
    { key: 'TODAY', label: 'Today' },
    { key: 'TOMORROW', label: 'Tomorrow' },
    { key: 'WEEK', label: 'This Week' },
    { key: 'ALL', label: 'All' },
  ];

  return (
    <div className="terminal-page -m-6 min-h-screen space-y-6 p-6 lg:-m-10 lg:p-10">
      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.32em] text-amber-600">Macro</p>
          <h1 className="mt-2 text-4xl font-black tracking-tight text-slate-900">Economic Calendar</h1>
          <p className="mt-2 text-sm font-semibold text-slate-500">
            The native MT5 economic calendar from your terminal (the same feed Exness shows), with Trading Economics as fallback. Both engines gate trades around high-impact news.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={handleRefreshFallback}
            disabled={refreshingFallback}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 px-4 py-2.5 text-sm font-bold text-slate-700 transition disabled:opacity-50"
            title="Re-poll the Trading Economics fallback source now"
          >
            {refreshingFallback ? <Loader2 size={16} className="animate-spin" /> : <Cloud size={16} />}
            Refresh Fallback
          </button>
          <button
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-xl bg-amber-500 hover:bg-amber-600 px-5 py-2.5 text-sm font-bold text-white transition disabled:opacity-50 shadow-md shadow-amber-500/20"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCcw size={16} />}
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700">{error}</div>
      )}

      {/* Summary strip */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="light-card rounded-3xl p-5">
          <div className="flex items-center gap-2 text-slate-400"><CalendarDays size={16} /><span className="text-xs font-black uppercase tracking-[0.2em]">{rangeLabel}</span></div>
          <p className="mt-2 text-3xl font-black text-slate-900">{filtered.length}</p>
          <p className="mt-1 text-xs font-semibold text-slate-500">{highCount} high-impact · {events.length} loaded total</p>
        </div>
        <div className="light-card rounded-3xl p-5">
          <div className="flex items-center gap-2 text-slate-400"><AlertTriangle size={16} /><span className="text-xs font-black uppercase tracking-[0.2em]">Next High-Impact</span></div>
          {nextHigh ? (
            <>
              <p className="mt-2 text-lg font-black text-slate-900 truncate">{nextHigh.currency} · {nextHigh.title}</p>
              <p className="mt-1 text-xs font-bold text-red-600">in {countdown(nextHigh.timestampUtc - now)} · {timeLabel(nextHigh.timeIso)}</p>
            </>
          ) : (
            <p className="mt-2 text-lg font-black text-emerald-600">All clear</p>
          )}
        </div>
        <div className="light-card rounded-3xl p-5">
          <div className="flex items-center gap-2 text-slate-400"><Clock size={16} /><span className="text-xs font-black uppercase tracking-[0.2em]">Active Source</span></div>
          <p className="mt-2 text-sm font-black text-slate-900">
            {source === 'mt5-ea' ? 'MetaTrader 5 (native)' : source === 'trading-economics' ? 'Trading Economics (fallback)' : 'Awaiting data'}
          </p>
          <div className="mt-2 space-y-1.5">
            {(['mt5-ea', 'trading-economics'] as const).map((key) => {
              const h = sources[key];
              const label = key === 'mt5-ea' ? 'MT5' : 'TradingEconomics';
              const Icon = key === 'mt5-ea' ? Database : Cloud;
              const dot = !h || !h.count ? 'bg-slate-300' : h.fresh ? 'bg-emerald-500' : 'bg-amber-500';
              return (
                <div key={key} className="flex items-center gap-2 text-[11px] font-bold">
                  <span className={`h-2 w-2 rounded-full ${dot}`} />
                  <Icon size={12} className="text-slate-400" />
                  <span className="text-slate-600">{label}</span>
                  <span className="text-slate-400">{h ? `${h.count} ev` : '—'}</span>
                  {h?.active && <span className="rounded bg-amber-100 px-1 text-[9px] font-black text-amber-700">ACTIVE</span>}
                  {h?.error && <span className="truncate text-rose-500" title={h.error}>err</span>}
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-[11px] font-semibold text-slate-400">
            {updatedAt ? (() => {
              const ms = new Date(updatedAt).getTime();
              const ageSec = Math.max(0, Math.floor((now - ms) / 1000));
              const age = ageSec < 60 ? `${ageSec}s ago` : `${Math.floor(ageSec / 60)}m ${ageSec % 60}s ago`;
              const local = new Date(updatedAt).toLocaleTimeString();
              const utc = new Date(updatedAt).toLocaleTimeString('en-GB', { timeZone: 'UTC', hour12: false });
              return `Last push ${age} · ${local} local · ${utc} UTC`;
            })() : 'No data yet'}
          </p>
        </div>
      </div>

      {/* Date navigation (Forex-Factory style) */}
      <div className="light-card rounded-3xl p-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-slate-500"><CalendarDays size={16} /><span className="text-xs font-black uppercase tracking-[0.2em]">Date</span></div>
        <div className="flex flex-wrap gap-1.5">
          {dateChips.map((d) => (
            <button
              key={d.key}
              onClick={() => { setDateFilter(d.key); setPickedDate(''); }}
              className={`rounded-full border px-3 py-1.5 text-xs font-black transition ${!pickedDate && dateFilter === d.key ? 'border-amber-300 bg-amber-100 text-amber-800' : 'border-slate-200 bg-white text-slate-600 hover:border-amber-200'}`}
            >
              {d.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <button onClick={() => stepPicked(-1)} className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-500 hover:bg-slate-50" title="Previous day"><ChevronLeft size={15} /></button>
          <input
            type="date"
            value={pickedDate}
            onChange={(e) => setPickedDate(e.target.value)}
            className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm font-bold text-slate-700 outline-none focus:border-amber-400"
          />
          <button onClick={() => stepPicked(1)} className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-500 hover:bg-slate-50" title="Next day"><ChevronRight size={15} /></button>
          {pickedDate && (
            <button onClick={() => setPickedDate('')} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-bold text-slate-500 hover:bg-slate-50" title="Clear date"><X size={13} /> Clear</button>
          )}
        </div>
      </div>

      {/* Currency + impact filters */}
      <div className="light-card rounded-3xl p-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-slate-500"><Filter size={16} /><span className="text-xs font-black uppercase tracking-[0.2em]">Filters</span></div>
        <div className="flex flex-wrap gap-1.5">
          {CURRENCY_FILTERS.map((c) => (
            <button key={c} onClick={() => setCurrency(c)} className={`rounded-full border px-3 py-1.5 text-xs font-black transition ${currency === c ? 'border-amber-300 bg-amber-100 text-amber-800' : 'border-slate-200 bg-white text-slate-600 hover:border-amber-200'}`}>{c}</button>
          ))}
        </div>
        <div className="ml-auto flex gap-1.5">
          {(['ALL', 'MODERATE', 'HIGH'] as const).map((imp) => (
            <button key={imp} onClick={() => setMinImpact(imp)} className={`rounded-full border px-3 py-1.5 text-xs font-black transition ${minImpact === imp ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'}`}>{imp === 'ALL' ? 'All impact' : imp === 'MODERATE' ? 'Medium+' : 'High only'}</button>
          ))}
        </div>
      </div>

      {/* Empty states */}
      {!events.length && !loading && (
        <div className="rounded-3xl border border-dashed border-slate-200 bg-white p-12 text-center">
          <TrendingUp className="mx-auto text-slate-300" size={40} />
          <p className="mt-4 text-sm font-bold text-slate-500">No calendar events yet.</p>
          <p className="mt-1 text-xs font-semibold text-slate-400">Primary source is the MT5 EA (<code>InpSendNews=true</code>). The Trading Economics fallback needs a registered API key in <code>TRADING_ECONOMICS_API_KEY</code> (the free guest key is no longer accepted). Use "Refresh Fallback" after setting a key.</p>
        </div>
      )}
      {events.length > 0 && !grouped.length && !loading && (
        <div className="rounded-3xl border border-dashed border-slate-200 bg-white p-10 text-center">
          <CalendarDays className="mx-auto text-slate-300" size={36} />
          <p className="mt-3 text-sm font-bold text-slate-500">No events for {rangeLabel.toLowerCase()} with these filters.</p>
          <p className="mt-1 text-xs font-semibold text-slate-400">Try “This Week”, “All”, or a different currency/impact.</p>
        </div>
      )}

      {/* Calendar list */}
      <div className="space-y-6">
        {grouped.map(([day, dayEvents]) => {
          const isToday = dayEvents.length > 0 && isTodayLocal(dayEvents[0].timestampUtc);
          return (
            <section key={day} className={`light-card rounded-3xl overflow-hidden ${isToday ? 'ring-2 ring-amber-200' : ''}`}>
              <div className={`sticky top-0 z-10 flex items-center justify-between border-b px-6 py-3 backdrop-blur ${isToday ? 'border-amber-100 bg-amber-50/80' : 'border-slate-100 bg-slate-50/80'}`}>
                <div className="flex items-center gap-2">
                  <h3 className={`text-sm font-black uppercase tracking-[0.16em] ${isToday ? 'text-amber-800' : 'text-slate-700'}`}>{day}</h3>
                  {isToday && <span className="rounded-full bg-amber-500 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-white">Today</span>}
                </div>
                <span className="text-xs font-bold text-slate-400">{dayEvents.length} events</span>
              </div>
              <div className="divide-y divide-slate-100">
                {dayEvents.map((e) => {
                  const meta = IMPACT_META[e.impact] || IMPACT_META.NONE;
                  const delta = e.timestampUtc - now;
                  const past = delta < 0;
                  const imminent = e.impact === 'HIGH' && Math.abs(delta) <= 30 * 60 * 1000;
                  return (
                    <div key={e.id} className={`flex items-center gap-4 px-6 py-3.5 transition ${imminent ? 'bg-red-50/60' : past ? 'opacity-55 hover:opacity-100 hover:bg-slate-50/50' : 'hover:bg-slate-50/50'}`}>
                      {/* Impact color bar (FF-style) */}
                      <span className={`h-9 w-1 shrink-0 rounded-full ${meta.bar}`} />
                      <div className="w-16 shrink-0">
                        <p className="font-mono text-sm font-black text-slate-900">{timeLabel(e.timeIso)}</p>
                        {!past && delta <= 12 * 60 * 60 * 1000 && (
                          <p className="text-[10px] font-bold text-amber-600">in {countdown(delta)}</p>
                        )}
                        {past && <p className="text-[10px] font-bold text-slate-400">done</p>}
                      </div>
                      <div className="w-12 shrink-0">
                        <span className="inline-flex rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-black text-slate-700">{e.currency || '—'}</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5 w-24">
                        <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
                        <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-black uppercase ${meta.chip}`}>{meta.label}</span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-bold text-slate-800">{e.title}</p>
                        {imminent && <p className="text-[10px] font-black uppercase tracking-wider text-red-600">⚠ Trading blocked around this release</p>}
                      </div>
                      <div className="hidden shrink-0 gap-6 text-right sm:flex">
                        <div className="w-16"><p className="text-[10px] font-bold uppercase text-slate-400">Actual</p><p className="font-mono text-sm font-black text-slate-900">{fmtValue(e.actual)}</p></div>
                        <div className="w-16"><p className="text-[10px] font-bold uppercase text-slate-400">Forecast</p><p className="font-mono text-sm font-bold text-slate-600">{fmtValue(e.forecast)}</p></div>
                        <div className="w-16"><p className="text-[10px] font-bold uppercase text-slate-400">Previous</p><p className="font-mono text-sm font-bold text-slate-400">{fmtValue(e.previous)}</p></div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
