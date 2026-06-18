import React, { useEffect, useMemo, useState } from 'react';
import { Database, Loader2, Search } from 'lucide-react';
import Mt5CandlestickChart from '../components/Mt5CandlestickChart';
import { fetchMt5CandleCoverage, fetchMt5Candles, useMt5Stream } from '../mt5Api';
import type { Mt5Candle, Mt5CandleCoverageRow } from '../types';
import { curatedAvailable } from '../utils/symbols';

const MIN_AI_CANDLES = 100;

function formatDate(value?: string | null) {
  if (!value) return 'n/a';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export default function HistoricalData() {
  const { status, signals } = useMt5Stream();
  const [rows, setRows] = useState<Mt5CandleCoverageRow[]>([]);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [timeframes, setTimeframes] = useState<string[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState('');
  const [selectedTimeframe, setSelectedTimeframe] = useState('M5');
  const [symbolSearch, setSymbolSearch] = useState('');
  const [candles, setCandles] = useState<Mt5Candle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refreshCoverage() {
    setLoading(true);
    setError(null);
    try {
      const payload = await fetchMt5CandleCoverage();
      // Focus the Historical Data view on the curated liquid majors + gold only.
      const curated = curatedAvailable(payload.symbols);
      const curatedSet = new Set(curated.map((s) => s.toUpperCase()));
      const curatedRows = payload.rows.filter((row) => curatedSet.has(String(row.symbol).toUpperCase()));
      const curatedTimeframes = [...new Set(curatedRows.map((row) => row.timeframe))].sort();
      setRows(curatedRows);
      setSymbols(curated);
      setTimeframes(curatedTimeframes);
      if (!selectedSymbol && curated.length) setSelectedSymbol(curated[0]);
      if (!curatedTimeframes.includes(selectedTimeframe) && curatedTimeframes.length) setSelectedTimeframe(curatedTimeframes.includes('M5') ? 'M5' : curatedTimeframes[0]);
    } catch (coverageError) {
      setError(coverageError instanceof Error ? coverageError.message : 'Failed to load historical data coverage');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshCoverage();
    const interval = window.setInterval(() => void refreshCoverage(), 30000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!selectedSymbol || !selectedTimeframe) return;
    let cancelled = false;
    fetchMt5Candles(selectedSymbol, selectedTimeframe, 5000)
      .then((payload) => {
        if (!cancelled) setCandles(payload.candles);
      })
      .catch(() => {
        if (!cancelled) setCandles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSymbol, selectedTimeframe]);

  const filteredSymbols = useMemo(() => {
    const query = symbolSearch.trim().toUpperCase();
    if (!query) return symbols;
    return symbols.filter((symbol) => symbol.includes(query));
  }, [symbolSearch, symbols]);

  const selectedRows = useMemo(() => rows.filter((row) => row.symbol === selectedSymbol), [rows, selectedSymbol]);
  const selectedCoverage = selectedRows.find((row) => row.timeframe === selectedTimeframe) || null;
  const totalCandles = rows.reduce((sum, row) => sum + row.count, 0);
  const readyRows = rows.filter((row) => row.count >= MIN_AI_CANDLES).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.32em] text-amber-600">Historical Data</p>
          <h1 className="mt-2 text-4xl font-black tracking-tight text-slate-900">Saved Candle Coverage</h1>
          <p className="mt-2 text-sm font-semibold text-slate-500">Live MT5 snapshots are saved per symbol and timeframe so AI analysis can use deeper market context.</p>
        </div>
        <button onClick={() => void refreshCoverage()} className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-black text-amber-700 hover:bg-amber-100">
          Refresh Coverage
        </button>
      </div>

      {error && <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700">{error}</div>}

      <div className="grid gap-4 md:grid-cols-4">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-400">MT5</p><p className="mt-2 text-2xl font-black text-slate-900">{status.connected ? 'Live' : 'Waiting'}</p></div>
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-400">Symbols</p><p className="mt-2 text-2xl font-black text-slate-900">{symbols.length}</p></div>
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-400">Saved Candles</p><p className="mt-2 text-2xl font-black text-slate-900">{totalCandles.toLocaleString()}</p></div>
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-400">AI-Ready Sets</p><p className="mt-2 text-2xl font-black text-slate-900">{readyRows}</p></div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
        <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center gap-3"><Database className="text-amber-500" size={20} /><h2 className="text-lg font-black text-slate-900">Symbols</h2></div>
          <div className="relative mb-4">
            <Search className="pointer-events-none absolute left-3 top-3 text-slate-400" size={18} />
            <input value={symbolSearch} onChange={(event) => setSymbolSearch(event.target.value)} placeholder="Search XAU, EUR, GBP, JPY..." className="w-full rounded-xl border border-slate-200 py-2.5 pl-10 pr-3 text-sm font-bold outline-none focus:border-amber-400" />
          </div>
          <div className="max-h-[520px] space-y-2 overflow-y-auto pr-1">
            {filteredSymbols.map((symbol) => {
              const count = rows.filter((row) => row.symbol === symbol).reduce((sum, row) => sum + row.count, 0);
              return (
                <button key={symbol} onClick={() => setSelectedSymbol(symbol)} className={`flex w-full items-center justify-between rounded-2xl border px-4 py-3 text-left transition ${symbol === selectedSymbol ? 'border-amber-300 bg-amber-50' : 'border-slate-200 hover:border-amber-200'}`}>
                  <span className="font-black text-slate-900">{symbol}</span>
                  <span className="text-xs font-bold text-slate-500">{count.toLocaleString()}</span>
                </button>
              );
            })}
          </div>
        </section>

        <div className="space-y-6">
          <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h2 className="text-xl font-black text-slate-900">{selectedSymbol || 'Select a symbol'} Chart Import View</h2>
                <p className="text-sm font-semibold text-slate-500">{selectedCoverage ? `${selectedCoverage.count} candles from ${formatDate(selectedCoverage.firstTime)} to ${formatDate(selectedCoverage.lastTime)}` : 'Waiting for candles on this timeframe.'}</p>
              </div>
              <select value={selectedTimeframe} onChange={(event) => setSelectedTimeframe(event.target.value)} className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-900 outline-none focus:border-amber-400">
                {timeframes.length ? timeframes.map((timeframe) => <option key={timeframe}>{timeframe}</option>) : <option>M5</option>}
              </select>
            </div>
            <div className="overflow-hidden rounded-2xl bg-slate-50">
              <Mt5CandlestickChart candles={candles} signals={signals} symbol={selectedSymbol} timeframe={selectedTimeframe} />
            </div>
          </section>

          <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-black text-slate-900">Timeframe Coverage</h2>
              {loading && <Loader2 size={18} className="animate-spin text-amber-500" />}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="text-xs uppercase tracking-[0.18em] text-slate-500"><tr><th className="p-3">Timeframe</th><th className="p-3">Candles</th><th className="p-3">First saved</th><th className="p-3">Last saved</th><th className="p-3">AI readiness</th></tr></thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {selectedRows.map((row) => <tr key={`${row.symbol}-${row.timeframe}`}><td className="p-3 font-black text-slate-900">{row.timeframe}</td><td className="p-3 font-mono">{row.count.toLocaleString()}</td><td className="p-3">{formatDate(row.firstTime)}</td><td className="p-3">{formatDate(row.lastTime)}</td><td className="p-3"><span className={`rounded-full px-3 py-1 text-xs font-black ${row.count >= MIN_AI_CANDLES ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>{row.count >= MIN_AI_CANDLES ? 'Ready' : 'Collecting'}</span></td></tr>)}
                </tbody>
              </table>
            </div>
            {!selectedRows.length && <p className="rounded-2xl border border-dashed border-slate-200 p-8 text-center text-sm font-semibold text-slate-500">No saved candle history for this symbol yet.</p>}
          </section>
        </div>
      </div>
    </div>
  );
}
