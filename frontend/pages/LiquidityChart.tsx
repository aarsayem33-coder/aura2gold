import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Droplets, Loader2, RefreshCw, Wifi, WifiOff, ArrowUp, ArrowDown, ListOrdered, X } from 'lucide-react';
import Mt5CandlestickChart from '../components/Mt5CandlestickChart';
import { fetchMt5Candles, fetchLiquidityChart, fetchLiquidityRanking, useMt5Stream } from '../mt5Api';
import { mergeCandlesByTime } from '../lib/candles';
import type { Mt5Candle, LiquidityChartResponse, LiquidityLevel, LiquidityRankRow } from '../types';

const TF_OPTIONS = ['M5', 'M15', 'M30', 'H1', 'H4'];
const BAR_COUNT = 500;

// One colour per status so the chart and the table read as the same system.
const STATUS: Record<string, { label: string; chip: string; line: string; dashed?: boolean }> = {
  FRESH:           { label: 'FRESH',            chip: 'bg-emerald-100 text-emerald-800', line: '#059669' },
  TESTED:          { label: 'TESTED',           chip: 'bg-sky-100 text-sky-800',         line: '#0284c7', dashed: true },
  REJECTED:        { label: 'REJECTED',         chip: 'bg-violet-100 text-violet-800',   line: '#7c3aed' },
  SWEPT:           { label: 'SWEPT',            chip: 'bg-amber-100 text-amber-800',     line: '#d97706', dashed: true },
  BROKEN_ACCEPTED: { label: 'BROKEN + ACCEPTED', chip: 'bg-rose-100 text-rose-800',      line: '#e11d48', dashed: true },
  INVALIDATED:     { label: 'INVALIDATED',      chip: 'bg-slate-200 text-slate-600',     line: '#94a3b8', dashed: true },
};

const digitsFor = (s: string, sample: number | null) => {
  const u = (s || '').toUpperCase();
  if (/XAU|GOLD|XAG/.test(u)) return 2;
  if (u.includes('JPY')) return 3;
  if (sample != null && sample >= 1000) return 2;
  return 5;
};

export default function LiquidityChart() {
  const { status, candles: streamCandles } = useMt5Stream();
  const [params, setParams] = useSearchParams();
  const symbol = params.get('symbol') || '';
  const timeframe = (params.get('tf') || 'M15').toUpperCase();
  const setSymbol = (s: string) => setParams((p) => { p.set('symbol', s); return p; }, { replace: true });
  const setTimeframe = (tf: string) => setParams((p) => { p.set('tf', tf); return p; }, { replace: true });

  const [candles, setCandles] = useState<Mt5Candle[]>([]);
  const [liq, setLiq] = useState<LiquidityChartResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showOn, setShowOn] = useState<Record<string, boolean>>({
    FRESH: true, TESTED: true, REJECTED: true, SWEPT: true, BROKEN_ACCEPTED: false, INVALIDATED: false,
  });

  // Ranking drawer: the same read scored across every live symbol.
  const [rankOpen, setRankOpen] = useState(false);
  const [rank, setRank] = useState<LiquidityRankRow[]>([]);
  const [rankLoading, setRankLoading] = useState(false);
  const [rankAt, setRankAt] = useState<string | null>(null);

  const loadRanking = useCallback(async () => {
    setRankLoading(true);
    try {
      const r = await fetchLiquidityRanking(timeframe);
      setRank(r.rows || []);
      setRankAt(r.generatedAt || null);
    } catch { /* drawer is best-effort */ }
    finally { setRankLoading(false); }
  }, [timeframe]);

  // Only scan when the drawer is actually open — it walks 500 bars per symbol.
  useEffect(() => { if (rankOpen) void loadRanking(); }, [rankOpen, loadRanking]);

  const loadedKeyRef = useRef('');
  const reqRef = useRef(0);
  const symbolOptions = useMemo(() => [...(status?.symbols || [])].sort(), [status?.symbols]);

  useEffect(() => {
    if (!symbol && symbolOptions.length) setSymbol(symbolOptions.find((s) => /XAU|GOLD/.test(s)) || symbolOptions[0]);
  }, [symbol, symbolOptions]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async (spin = false) => {
    if (!symbol) return;
    if (spin) setLoading(true);
    const key = `${symbol}|${timeframe}`;
    const myReq = ++reqRef.current;
    try {
      const [c, l] = await Promise.all([
        fetchMt5Candles(symbol, timeframe, BAR_COUNT),
        fetchLiquidityChart(symbol, timeframe).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : 'failed' } as LiquidityChartResponse)),
      ]);
      if (myReq !== reqRef.current) return;               // superseded by a newer switch
      const fresh = c.candles || [];
      const same = key === loadedKeyRef.current;
      loadedKeyRef.current = key;                          // set BEFORE the updater runs
      setCandles((prev) => (same ? mergeCandlesByTime(prev, fresh) : fresh));
      setLiq(l);
      setError(l && l.ok === false ? (l.error || 'liquidity read failed') : null);
    } catch (e) {
      if (myReq === reqRef.current) setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      if (myReq === reqRef.current) setLoading(false);
    }
  }, [symbol, timeframe]);

  useEffect(() => {
    load(true);
    const id = setInterval(() => load(false), 20000);
    return () => clearInterval(id);
  }, [load]);

  // Live candles between polls, so the chart keeps moving under the levels.
  useEffect(() => {
    if (!symbol || !streamCandles?.length) return;
    if (`${symbol}|${timeframe}` !== loadedKeyRef.current) return;
    const want = symbol.toUpperCase();
    const rel = streamCandles.filter((c) => (c.symbol || '').toUpperCase() === want && (c.timeframe || '').toUpperCase() === timeframe);
    if (rel.length) setCandles((prev) => mergeCandlesByTime(prev, rel));
  }, [streamCandles, symbol, timeframe]);

  const levels = liq?.levels || [];
  const visible = levels.filter((l) => showOn[l.status]);
  const digits = digitsFor(symbol, liq?.price ?? null);
  const px = (v: number) => Number(v).toFixed(digits);

  // Only the levels you have switched on are drawn, so the chart never gets crowded.
  const extraLines = useMemo(() => visible.map((l) => ({
    price: l.price,
    color: STATUS[l.status]?.line || '#64748b',
    title: `${l.pool} ${l.label} · ${STATUS[l.status]?.label || l.status}`,
    dashed: STATUS[l.status]?.dashed,
  })), [visible]);

  const streamLive = Boolean(status?.connected ?? status?.symbols?.length);
  const feedBadge = (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-black ${streamLive ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>
      {streamLive ? <Wifi size={11} /> : <WifiOff size={11} />}{streamLive ? 'LIVE' : 'NO FEED'}
    </span>
  );

  const bias = liq?.structure?.bias;
  const biasTone = bias === 'BULLISH' ? 'bg-emerald-600' : bias === 'BEARISH' ? 'bg-rose-600' : 'bg-slate-500';

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 pb-24">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-black text-slate-900">
            <Droplets size={22} className="text-sky-500" />Liquidity Chart
          </h1>
          <p className="text-sm font-semibold text-slate-500">
            Where stop liquidity is resting, whether it has been taken, and whether price rejected or accepted beyond it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {feedBadge}
          <button
            onClick={() => setRankOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-bold text-white hover:bg-sky-700"
          >
            <ListOrdered size={15} />Rank symbols
          </button>
          <button onClick={() => load(true)} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-bold text-slate-600 hover:bg-slate-50">
            {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}Refresh
          </button>
        </div>
      </div>

      {/* Market condition */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Market condition</p>
          <p className="mt-0.5">
            <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-black text-white ${biasTone}`}>{bias || '—'}</span>
          </p>
          {!!liq?.structure?.events?.length && (
            <p className="mt-1 text-[10px] font-bold text-slate-500">
              {liq.structure.events.map((e) => `${e.type} ${e.direction}`).join(' · ')}
            </p>
          )}
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Price</p>
          <p className="text-lg font-black text-slate-800">{liq?.price != null ? px(liq.price) : '—'}</p>
          <p className="text-[10px] font-medium text-slate-400">ATR {liq?.atr != null ? px(liq.atr) : '—'}</p>
        </div>
        <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 px-4 py-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-700">Primary draw</p>
          <p className="text-lg font-black text-emerald-800">{liq?.draw?.primary ? px(liq.draw.primary.price) : '—'}</p>
          <p className="text-[10px] font-medium text-emerald-700">{liq?.draw?.primary ? `${liq.draw.primary.pool} · ${liq.draw.primary.label}` : 'no fresh pool'}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Alternative draw</p>
          <p className="text-lg font-black text-slate-800">{liq?.draw?.alternative ? px(liq.draw.alternative.price) : '—'}</p>
          <p className="text-[10px] font-medium text-slate-400">{liq?.draw?.alternative ? `${liq.draw.alternative.pool} · ${liq.draw.alternative.label}` : '—'}</p>
        </div>
      </div>

      {error && <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">{error}</div>}

      {/* Status toggles — the brief is explicit that overcrowding is itself a failure. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Draw on chart:</span>
        {Object.entries(STATUS).map(([key, cfg]) => {
          const count = levels.filter((l) => l.status === key).length;
          const on = showOn[key];
          return (
            <button
              key={key} type="button" onClick={() => setShowOn((s) => ({ ...s, [key]: !s[key] }))}
              className={`rounded-lg border px-2.5 py-1 text-[11px] font-bold transition ${on ? cfg.chip + ' border-transparent' : 'border-slate-200 bg-white text-slate-400'}`}
            >
              {cfg.label} {count}
            </button>
          );
        })}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-2 shadow-card">
        {candles.length > 0 ? (
          <Mt5CandlestickChart
            candles={candles} signals={[]} symbol={symbol} timeframe={timeframe} levels={null}
            symbolOptions={symbolOptions} timeframeOptions={TF_OPTIONS}
            onSymbolChange={setSymbol} onTimeframeChange={setTimeframe}
            fullscreenBadge={feedBadge}
            extraLines={extraLines}
          />
        ) : (
          <div className="flex h-[420px] items-center justify-center text-sm font-semibold text-slate-400">
            {loading ? <><Loader2 className="mr-2 animate-spin" size={16} />Loading {symbol} {timeframe}…</> : `No candle data for ${symbol || 'this symbol'} ${timeframe}.`}
          </div>
        )}
      </div>

      {/* Key liquidity levels */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3">
          <h3 className="text-sm font-bold text-slate-900">Key liquidity levels</h3>
          <p className="text-[11px] font-medium text-slate-400">
            {levels.length} shown of {liq?.consideredCount ?? '—'} found
            {liq?.invalidatedCount ? ` · ${liq.invalidatedCount} invalidated and hidden` : ''}
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2">Level</th><th className="px-3 py-2">Price</th>
                <th className="px-3 py-2">Type</th><th className="px-3 py-2">Scope</th>
                <th className="px-3 py-2">Status</th><th className="px-3 py-2">Evidence</th>
                <th className="px-3 py-2">Dist</th><th className="px-3 py-2">Conf.</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {levels.map((l: LiquidityLevel, i: number) => (
                <tr key={`${l.price}-${i}`} className={l.inducement ? 'bg-amber-50/40' : ''}>
                  <td className="px-3 py-1.5 font-bold text-slate-700">
                    {l.label}
                    {l.inducement && <span className="ml-1.5 rounded bg-amber-200 px-1 text-[9px] font-black text-amber-900">INDUCEMENT</span>}
                  </td>
                  <td className="px-3 py-1.5 font-mono font-bold text-slate-800">{px(l.price)}</td>
                  <td className="px-3 py-1.5">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${l.pool === 'BSL' ? 'bg-sky-100 text-sky-700' : 'bg-rose-100 text-rose-700'}`}>
                      {l.pool === 'BSL' ? <ArrowUp size={9} className="inline" /> : <ArrowDown size={9} className="inline" />} {l.pool}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-[10px] font-bold text-slate-500">{l.scope}</td>
                  <td className="px-3 py-1.5">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${STATUS[l.status]?.chip || 'bg-slate-100 text-slate-600'}`}>
                      {STATUS[l.status]?.label || l.status}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-slate-500">{l.evidence}</td>
                  <td className="px-3 py-1.5 font-mono text-slate-400">{l.distancePips}p</td>
                  <td className="px-3 py-1.5 text-[10px] font-bold text-slate-500">{l.confidence}</td>
                </tr>
              ))}
              {!levels.length && (
                <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-400">No liquidity levels for this symbol/timeframe yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Draw on liquidity + limits */}
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white px-5 py-4">
          <h3 className="text-sm font-bold text-slate-900">Current draw on liquidity</h3>
          <p className="mt-1 text-xs font-medium text-slate-600">{liq?.draw?.basis || '—'}</p>
          <p className="mt-2 text-xs font-semibold text-slate-700">
            Invalidation: <span className="font-medium text-slate-500">{liq?.draw?.invalidation || '—'}</span>
          </p>
          {!!liq?.recentlySwept?.length && (
            <p className="mt-2 text-[11px] font-medium text-slate-500">
              Recently taken: {liq.recentlySwept.map((l) => `${l.label} ${px(l.price)}`).join(' · ')}
            </p>
          )}
        </div>
        <div className="rounded-2xl border border-slate-200 bg-slate-50 px-5 py-4">
          <h3 className="text-sm font-bold text-slate-900">What this read does not cover</h3>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] font-medium text-slate-600">
            {(liq?.caveats || ['—']).map((c, i) => <li key={i}>{c}</li>)}
          </ul>
          <p className="mt-2 text-[10px] font-medium text-slate-400">
            Scenarios, not predictions. Educational analysis — not financial advice.
          </p>
        </div>
      </div>

      {/* Ranking drawer - the same liquidity read scored across every live symbol, so you
          can see which instrument is best positioned before committing to one chart. */}
      {rankOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-slate-900/30" onClick={() => setRankOpen(false)} />
          <aside className="fixed right-0 top-0 z-50 flex h-full w-full max-w-3xl flex-col border-l border-slate-200 bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
              <div>
                <h2 className="flex items-center gap-2 text-base font-black text-slate-900">
                  <ListOrdered size={18} className="text-sky-600" />Best-positioned symbols
                </h2>
                <p className="text-[11px] font-medium text-slate-500">
                  {timeframe} - scored on which side of liquidity was taken and what is left to target
                  {rankAt ? ` - ${new Date(rankAt).toLocaleTimeString()}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => void loadRanking()} className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-bold text-slate-600 hover:bg-slate-50">
                  {rankLoading ? <Loader2 size={13} className="animate-spin" /> : 'Rescan'}
                </button>
                <button onClick={() => setRankOpen(false)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"><X size={18} /></button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {rankLoading && !rank.length && (
                <div className="flex h-40 items-center justify-center text-sm font-semibold text-slate-400">
                  <Loader2 className="mr-2 animate-spin" size={16} />Scanning every symbol...
                </div>
              )}
              <div className="space-y-2">
                {rank.map((r, i) => {
                  const tradable = r.ok && r.direction && r.rr !== null && r.rr !== undefined;
                  const buy = r.direction === 'BUY';
                  const d = digitsFor(r.symbol, r.price ?? null);
                  const fmt = (v?: number | null) => (v === null || v === undefined ? '-' : Number(v).toFixed(d));
                  return (
                    <div
                      key={r.symbol}
                      className={`rounded-xl border px-4 py-3 ${tradable ? 'border-slate-200 bg-white' : 'border-slate-200 bg-slate-50 opacity-70'}`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-black text-slate-400">#{i + 1}</span>
                          <button
                            onClick={() => { setSymbol(r.symbol); setRankOpen(false); }}
                            className="text-sm font-black text-slate-900 underline decoration-dotted hover:text-sky-700"
                            title="Open this symbol on the chart"
                          >
                            {r.symbol}
                          </button>
                          {r.direction && (
                            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-black text-white ${buy ? 'bg-emerald-600' : 'bg-rose-600'}`}>
                              {buy ? <ArrowUp size={10} /> : <ArrowDown size={10} />}{r.direction}
                            </span>
                          )}
                          {r.grade && <span className="rounded bg-slate-900 px-1.5 py-0.5 text-[10px] font-black text-white">{r.grade}</span>}
                          {r.bias && <span className="text-[10px] font-bold text-slate-400">{r.bias}</span>}
                        </div>
                        <div className="flex items-center gap-3 text-[11px] font-bold">
                          <span className="text-slate-400">score <span className="text-slate-800">{r.score ?? '-'}</span></span>
                          <span className="text-slate-400">R:R <span className={r.rr ? 'text-slate-800' : 'text-rose-500'}>{r.rr ?? 'n/a'}</span></span>
                        </div>
                      </div>

                      {r.ok && (
                        <div className="mt-1.5 grid gap-1 text-[11px] sm:grid-cols-3">
                          <span className="text-slate-500">price <span className="font-mono font-bold text-slate-700">{fmt(r.price)}</span></span>
                          <span className="text-slate-500">target <span className="font-mono font-bold text-emerald-700">{fmt(r.target?.price)}</span> {r.target?.pool || ''}</span>
                          <span className="text-slate-500">invalid <span className="font-mono font-bold text-rose-600">{fmt(r.invalidation)}</span></span>
                        </div>
                      )}

                      {!!r.reasons?.length && (
                        <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[11px] font-medium text-slate-600">
                          {r.reasons.slice(0, 3).map((x, k) => <li key={k}>{x}</li>)}
                        </ul>
                      )}
                      {!!r.blockers?.length && (
                        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] font-medium text-amber-700">
                          {r.blockers.slice(0, 2).map((x, k) => <li key={k}>{x}</li>)}
                        </ul>
                      )}
                      {!r.ok && <p className="mt-1 text-[11px] font-medium text-slate-400">{r.note}</p>}
                    </div>
                  );
                })}
                {!rankLoading && !rank.length && (
                  <p className="py-8 text-center text-sm text-slate-400">No symbols returned a liquidity read.</p>
                )}
              </div>
            </div>

            <div className="border-t border-slate-200 bg-slate-50 px-5 py-3 text-[11px] font-medium text-slate-500">
              Direction follows the side whose liquidity was most recently taken - stops run below point up, above point down.
              These are reads, not signals: no entry timing, no spread or margin check, no position sizing.
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
