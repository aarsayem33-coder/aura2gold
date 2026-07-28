import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CandlestickChart, Loader2, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import Mt5CandlestickChart from '../components/Mt5CandlestickChart';
import { fetchMt5Candles, useMt5Stream } from '../mt5Api';
import { mergeCandlesByTime } from '../lib/candles';
import type { Mt5Candle } from '../types';

// Every timeframe the feed serves. The chart's bar maths is broker-phase aware, so the
// higher frames bucket correctly (see lib/chartTime.js).
const TF_OPTIONS = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];
const BAR_COUNT = 500;

const digitsFor = (symbol: string, sample: number | null) => {
  const s = (symbol || '').toUpperCase();
  if (/XAU|GOLD|XAG/.test(s)) return 2;
  if (s.includes('JPY')) return 3;
  if (sample != null && sample >= 1000) return 2;
  return 5;
};

export default function ChartStudio() {
  const { status, candles: streamCandles } = useMt5Stream();
  const [params, setParams] = useSearchParams();

  // Symbol/timeframe live in the URL so a chart you are looking at can be linked or reloaded.
  // The symbol keeps the feed's own casing ("XAUUSDm", not "XAUUSDM") — the <select> below
  // compares by value, so upper-casing it would leave the dropdown showing nothing selected.
  const symbol = params.get('symbol') || '';
  const timeframe = (params.get('tf') || 'M15').toUpperCase();
  const setSymbol = (s: string) => setParams((p) => { p.set('symbol', s); return p; }, { replace: true });
  const setTimeframe = (tf: string) => setParams((p) => { p.set('tf', tf); return p; }, { replace: true });

  const [candles, setCandles] = useState<Mt5Candle[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);

  // Which instrument `candles` currently holds. Switching instrument REPLACES the array;
  // the same instrument MERGES, so live stream bars survive a REST refresh.
  const loadedKeyRef = useRef('');
  // Monotonic request token. A global "in flight" flag would make a timeframe click a no-op
  // whenever the 15s poll happened to be mid-air, leaving the PREVIOUS timeframe's candles
  // on screen until the next tick — H4 showing bars that closed on an M15 boundary. The
  // token instead lets every switch fire immediately and discards superseded responses, so
  // a slow reply for the old timeframe can never overwrite the new one.
  const reqRef = useRef(0);

  const symbolOptions = useMemo(() => [...(status?.symbols || [])].sort(), [status?.symbols]);

  // Default to gold once the feed reports what it carries.
  useEffect(() => {
    if (!symbol && symbolOptions.length) setSymbol(symbolOptions.find((s) => /XAU|GOLD/.test(s)) || symbolOptions[0]);
  }, [symbol, symbolOptions]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async (showSpinner = false) => {
    if (!symbol) return;
    if (showSpinner) setLoading(true);
    const key = `${symbol}|${timeframe}`;
    const myReq = ++reqRef.current;
    try {
      const res = await fetchMt5Candles(symbol, timeframe, BAR_COUNT);
      if (myReq !== reqRef.current) return;          // superseded by a newer switch
      const fresh = res.candles || [];
      // Same instrument → merge (keeps live stream bars). Switched → replace wholesale, so
      // two timeframes can never share one series.
      //
      // Decide BEFORE touching the ref. A setState updater runs during the next render, by
      // which time `loadedKeyRef.current` has already been reassigned — so comparing inside
      // the updater always sees "same instrument" and merges, silently splicing H4 bars into
      // an M15 series. That is what produced last-bar times sitting on the wrong boundary.
      const sameInstrument = key === loadedKeyRef.current;
      loadedKeyRef.current = key;
      setCandles((prev) => (sameInstrument ? mergeCandlesByTime(prev, fresh) : fresh));
      setFetchedAt(Date.now());
      setError(fresh.length ? null : `No bars returned for ${symbol} ${timeframe}.`);
    } catch (e) {
      if (myReq === reqRef.current) setError(e instanceof Error ? e.message : 'Failed to load candles');
    } finally {
      if (myReq === reqRef.current) setLoading(false);
    }
  }, [symbol, timeframe]);

  // Refetch on instrument change, then poll. The stream below keeps it live between polls.
  // Deliberately does NOT clear `candles` first: emptying the array unmounts the chart via
  // the length gate below, which throws away zoom and fullscreen state and flashes a
  // "Loading" panel on every timeframe click. load() replaces the array wholesale when the
  // instrument key changes, so the old bars simply stay on screen until the new ones land.
  useEffect(() => {
    load(true);
    const id = setInterval(() => load(false), 15000);
    return () => clearInterval(id);
  }, [load, symbol, timeframe]);

  // Live fast path: merge SSE pushes for exactly this instrument the moment they arrive.
  useEffect(() => {
    if (!symbol || !streamCandles?.length) return;
    if (`${symbol}|${timeframe}` !== loadedKeyRef.current) return;   // never merge across a switch
    // Compare case-insensitively: the feed and the URL can disagree on symbol casing.
    const want = symbol.toUpperCase();
    const relevant = streamCandles.filter(
      (c) => (c.symbol || '').toUpperCase() === want && (c.timeframe || '').toUpperCase() === timeframe,
    );
    if (relevant.length) setCandles((prev) => mergeCandlesByTime(prev, relevant));
  }, [streamCandles, symbol, timeframe]);

  const last = candles.length ? candles[candles.length - 1] : null;
  const first = candles.length ? candles[0] : null;
  const digits = digitsFor(symbol, last?.close ?? null);
  const change = last && first && Number(first.open) > 0 ? Number(last.close) - Number(first.open) : null;
  const changePct = change !== null && first ? (change / Number(first.open)) * 100 : null;
  const streamLive = Boolean(status?.connected ?? status?.symbols?.length);

  const feedBadge = (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-black ${streamLive ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>
      {streamLive ? <Wifi size={11} /> : <WifiOff size={11} />}{streamLive ? 'LIVE FEED' : 'NO FEED'}
    </span>
  );

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 pb-24">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-black text-slate-900">
            <CandlestickChart size={22} className="text-indigo-500" />Chart
          </h1>
          <p className="text-sm font-semibold text-slate-500">
            Full-size candles with indicators. Bars come straight from MT5 and are bucketed on the broker&apos;s own boundaries.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {feedBadge}
          <button
            onClick={() => load(true)}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-bold text-slate-600 hover:bg-slate-50"
          >
            {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}Refresh
          </button>
        </div>
      </div>

      {/* Compact readout, so the numbers behind the candles are checkable at a glance. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Last price</p>
          <p className="text-lg font-black text-slate-800">{last ? Number(last.close).toFixed(digits) : '—'}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Change on screen</p>
          <p className={`text-lg font-black ${change === null ? 'text-slate-800' : change >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
            {change === null ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(digits)} (${changePct!.toFixed(2)}%)`}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Bars loaded</p>
          <p className="text-lg font-black text-slate-800">{candles.length}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Last bar</p>
          <p className="text-lg font-black text-slate-800">{last ? new Date(last.time).toLocaleString() : '—'}</p>
          <p className="text-[10px] font-medium text-slate-400">
            fetched {fetchedAt ? new Date(fetchedAt).toLocaleTimeString() : '—'}
          </p>
        </div>
      </div>

      {error && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">{error}</div>
      )}

      <div className="rounded-2xl border border-slate-200 bg-white p-2 shadow-card">
        {candles.length > 0 ? (
          <Mt5CandlestickChart
            candles={candles}
            signals={[]}
            symbol={symbol}
            timeframe={timeframe}
            levels={null}
            symbolOptions={symbolOptions}
            timeframeOptions={TF_OPTIONS}
            onSymbolChange={setSymbol}
            onTimeframeChange={setTimeframe}
            fullscreenBadge={feedBadge}
          />
        ) : (
          <div className="flex h-[420px] items-center justify-center text-sm font-semibold text-slate-400">
            {loading ? <><Loader2 className="mr-2 animate-spin" size={16} />Loading {symbol} {timeframe}…</> : `No candle data for ${symbol || 'this symbol'} ${timeframe}.`}
          </div>
        )}
      </div>

      <p className="text-[11px] font-medium text-slate-400">
        The feed publishes CLOSED bars. The right-most candle is a live placeholder held flat at the last close so the
        current slot and its countdown exist — it is not invented price movement, and it is suppressed across weekend
        and feed gaps.
      </p>
    </div>
  );
}
