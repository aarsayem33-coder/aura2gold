import React, { useEffect, useMemo, useState } from 'react';
import { Activity, BarChart3, Loader2, Search, Wallet, CalendarClock, AlertTriangle } from 'lucide-react';
import DecisionCard from '../components/DecisionCard';
import CompositeGauge from '../components/CompositeGauge';
import Mt5CandlestickChart from '../components/Mt5CandlestickChart';
import SignalGrid from '../components/SignalGrid';
import { fetchMt5CandleCoverage, fetchMt5Candles, fetchEconomicNews, triggerAiAnalysis, useMt5Stream } from '../mt5Api';
import type { Mt5Candle, Mt5CandleCoverageRow, NewsEvent } from '../types';

function scoreFromDecision(decision?: string | null) {
  if (decision === 'STRONG_BUY') return 0.8;
  if (decision === 'BUY') return 0.45;
  if (decision === 'STRONG_SELL') return -0.8;
  if (decision === 'SELL') return -0.45;
  return 0;
}

function money(value?: number | null, currency = 'USD') {
  if (value === null || value === undefined) return 'n/a';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);
}

function timeframeToMs(tf: string): number {
  const m = /^([MHDW])(\d+)?$/.exec((tf || '').toUpperCase());
  if (!m) return 5 * 60 * 1000;
  const unit = m[1];
  const n = Number(m[2] || 1);
  if (unit === 'M') return n * 60 * 1000;
  if (unit === 'H') return n * 60 * 60 * 1000;
  if (unit === 'D') return 24 * 60 * 60 * 1000;
  if (unit === 'W') return 7 * 24 * 60 * 60 * 1000;
  return 5 * 60 * 1000;
}

function pipSizeFor(symbol: string): number {
  const s = (symbol || '').toUpperCase();
  if (s.includes('XAU') || s.includes('GOLD')) return 0.1;
  if (s.includes('JPY')) return 0.01;
  return 0.0001;
}

function fmtAge(ms: number): string {
  if (ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

export default function TradingTerminal() {
  const { signals, candles, trades, indicators, aiDecisions, account, status, refresh } = useMt5Stream();
  const [selectedSymbol, setSelectedSymbol] = useState('');
  const [selectedTimeframe, setSelectedTimeframe] = useState('M5');
  const [advisorMode, setAdvisorMode] = useState<'ai' | 'system'>('ai');
  const [loadingAi, setLoadingAi] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [selectedCandles, setSelectedCandles] = useState<Mt5Candle[]>([]);
  const [symbolSearch, setSymbolSearch] = useState('');
  const [coverageRows, setCoverageRows] = useState<Mt5CandleCoverageRow[]>([]);
  const [symbolNews, setSymbolNews] = useState<NewsEvent[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const symbols = useMemo(() => [...new Set([...status.symbols, ...candles.map((candle) => candle.symbol), ...trades.map((trade) => trade.symbol)].filter(Boolean))].sort(), [status.symbols, candles, trades]);
  const timeframes = useMemo(() => [...new Set([...status.timeframes, ...candles.map((candle) => candle.timeframe)].filter(Boolean))].sort(), [status.timeframes, candles]);
  const filteredSymbols = useMemo(() => {
    const query = symbolSearch.trim().toUpperCase();
    if (!query) return symbols;
    return symbols.filter((symbol) => symbol.includes(query));
  }, [symbolSearch, symbols]);
  const selectedCoverageRows = useMemo(() => coverageRows.filter((row) => row.symbol === selectedSymbol), [coverageRows, selectedSymbol]);
  const coverageByTimeframe = useMemo(() => new Map(selectedCoverageRows.map((row) => [row.timeframe, row])), [selectedCoverageRows]);

  useEffect(() => {
    if (!selectedSymbol && symbols.length) setSelectedSymbol(symbols[0]);
  }, [selectedSymbol, symbols]);

  useEffect(() => {
    if (!timeframes.includes(selectedTimeframe) && timeframes.length) setSelectedTimeframe(timeframes.includes('M5') ? 'M5' : timeframes[0]);
  }, [selectedTimeframe, timeframes]);

  useEffect(() => {
    let cancelled = false;
    const loadCoverage = async () => {
      try {
        const payload = await fetchMt5CandleCoverage();
        if (!cancelled) setCoverageRows(payload.rows);
      } catch {
        if (!cancelled) setCoverageRows([]);
      }
    };
    void loadCoverage();
    const interval = window.setInterval(() => void loadCoverage(), 15000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!selectedSymbol || !selectedCoverageRows.length) return;
    const current = selectedCoverageRows.find((row) => row.timeframe === selectedTimeframe && row.count > 0);
    if (current) return;
    const preferred = selectedCoverageRows.find((row) => row.timeframe === 'M5' && row.count > 0) || selectedCoverageRows.find((row) => row.count > 0);
    if (preferred) setSelectedTimeframe(preferred.timeframe);
  }, [selectedSymbol, selectedTimeframe, selectedCoverageRows]);

  useEffect(() => {
    if (!selectedSymbol || !selectedTimeframe) return;
    let cancelled = false;
    fetchMt5Candles(selectedSymbol, selectedTimeframe, 5000)
      .then((payload) => {
        if (!cancelled) setSelectedCandles(payload.candles);
      })
      .catch(() => {
        if (!cancelled) setSelectedCandles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSymbol, selectedTimeframe]);

  useEffect(() => {
    if (!selectedSymbol) return;
    let cancelled = false;
    const loadNews = () => {
      fetchEconomicNews({ symbol: selectedSymbol, hours: 24 })
        .then((res) => { if (!cancelled) setSymbolNews(res.events || []); })
        .catch(() => { if (!cancelled) setSymbolNews([]); });
    };
    loadNews();
    const interval = window.setInterval(loadNews, 60000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [selectedSymbol]);

  const streamCandles = candles
    .filter((candle) => candle.symbol === selectedSymbol && candle.timeframe === selectedTimeframe)
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  const chartCandles = [...new Map([...selectedCandles, ...streamCandles]
    .filter((candle) => candle.symbol === selectedSymbol && candle.timeframe === selectedTimeframe)
    .map((candle) => [`${candle.symbol}|${candle.timeframe}|${candle.time}`, candle])).values()]
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  const latestChartCandle = chartCandles[chartCandles.length - 1];
  const selectedCoverage = coverageByTimeframe.get(selectedTimeframe) || null;
  const decision = aiDecisions.find((item) => item.symbol === selectedSymbol && item.timeframe === selectedTimeframe) || null;

  // Trade levels for the active advisor mode, drawn on the chart as price lines.
  const activeLevels = useMemo(() => {
    if (!decision) return null;
    const sys = decision.system_decision;
    if (advisorMode === 'system' && sys) {
      return {
        direction: sys.decision,
        entry: sys.entryPrice,
        stopLoss: sys.stopLoss,
        takeProfit1: sys.takeProfit1,
        takeProfit2: sys.takeProfit2,
        takeProfit3: sys.takeProfit3,
      };
    }
    return {
      direction: decision.decision,
      entry: decision.entry_price,
      stopLoss: decision.stop_loss,
      takeProfit1: decision.take_profit_1,
      takeProfit2: decision.take_profit_2,
      takeProfit3: decision.take_profit_3,
    };
  }, [decision, advisorMode]);

  // Freshness: how old is the decision, and is it stale relative to the timeframe?
  const freshness = useMemo(() => {
    if (!decision?.created_at) return null;
    const ageMs = now - new Date(decision.created_at).getTime();
    const tfMs = timeframeToMs(selectedTimeframe);
    // A signal is "stale" once it is older than ~1.5 candles of its own timeframe.
    const stale = ageMs > tfMs * 1.5;
    return { ageMs, stale, tfMs };
  }, [decision, now, selectedTimeframe]);

  // Live-price drift vs the signal's entry (so a stale entry is obvious before acting).
  const entryDrift = useMemo(() => {
    const livePrice = latestChartCandle?.close;
    const entry = activeLevels?.entry;
    if (livePrice == null || entry == null || !activeLevels?.direction || activeLevels.direction === 'HOLD') return null;
    const diff = livePrice - entry;
    const pips = diff / pipSizeFor(selectedSymbol);
    return { diff, pips, livePrice, entry };
  }, [latestChartCandle, activeLevels, selectedSymbol]);

  const openTrades = trades.filter((trade) => trade.status === 'open' || trade.status === 'active');
  const selectedTrades = openTrades.filter((trade) => !selectedSymbol || trade.symbol === selectedSymbol);
  const currency = account?.currency || 'USD';

  async function handleAnalyze() {
    if (!selectedSymbol) return;
    setLoadingAi(true);
    setAiError(null);
    try {
      await triggerAiAnalysis(selectedSymbol, selectedTimeframe || 'M5');
      await refresh();
    } catch (error) {
      setAiError(error instanceof Error ? error.message : 'AI analysis failed');
    } finally {
      setLoadingAi(false);
    }
  }

  return (
    <div className="terminal-page -m-6 min-h-screen space-y-6 p-6 lg:-m-10 lg:p-10">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.32em] text-amber-600">Aura Gold</p>
          <h1 className="mt-2 text-4xl font-black tracking-tight text-slate-900">Trading Decision Terminal</h1>
          <p className="mt-2 text-sm font-semibold text-slate-500">Advisory-only Gemini analysis across all tracked Exness MT5 symbols.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <div className="relative min-w-[260px]">
            <Search className="pointer-events-none absolute left-3 top-3.5 text-slate-400" size={18} />
            <input value={symbolSearch} onChange={(event) => setSymbolSearch(event.target.value)} placeholder="Search symbols..." className="w-full rounded-xl border border-slate-200 bg-white py-3 pl-10 pr-4 text-sm font-bold text-slate-900 outline-none focus:border-amber-400" />
          </div>
          <select value={selectedSymbol} onChange={(event) => setSelectedSymbol(event.target.value)} className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-900 outline-none focus:border-amber-400">
            {filteredSymbols.length ? filteredSymbols.map((symbol) => <option key={symbol}>{symbol}</option>) : <option value={selectedSymbol || ''}>{selectedSymbol || 'Waiting'}</option>}
          </select>
          <select value={selectedTimeframe} onChange={(event) => setSelectedTimeframe(event.target.value)} className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-900 outline-none focus:border-amber-400">
            {timeframes.length ? timeframes.map((timeframe) => <option key={timeframe}>{timeframe}</option>) : <option>M5</option>}
          </select>
        </div>
      </div>

      {aiError && <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700">{aiError}</div>}

      <section className="light-card rounded-3xl p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="text-xs font-black uppercase tracking-[0.24em] text-slate-500">All Imported Charts</p>
          <p className="text-xs font-bold text-slate-400">{filteredSymbols.length} of {symbols.length} symbols</p>
        </div>
        <div className="flex max-h-28 flex-wrap gap-2 overflow-y-auto pr-1">
          {filteredSymbols.map((symbol) => (
            <button key={symbol} onClick={() => setSelectedSymbol(symbol)} className={`rounded-full border px-3 py-1.5 text-xs font-black transition ${symbol === selectedSymbol ? 'border-amber-300 bg-amber-100 text-amber-800' : 'border-slate-200 bg-white text-slate-600 hover:border-amber-200 hover:text-slate-900'}`}>
              {symbol} <span className="ml-1 font-mono text-[10px] opacity-60">{coverageRows.filter((row) => row.symbol === symbol).reduce((sum, row) => sum + row.count, 0) || '...'}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[420px_1fr]">
        <div className="space-y-6">
          <DecisionCard 
            decision={decision} 
            loading={loadingAi} 
            onAnalyze={handleAnalyze} 
            advisorMode={advisorMode} 
            setAdvisorMode={setAdvisorMode} 
          />
          <CompositeGauge 
            score={advisorMode === 'system' ? scoreFromDecision(decision?.system_decision?.decision) : scoreFromDecision(decision?.decision)} 
          />
          <div className="light-card rounded-3xl p-6">
            <div className="flex items-center gap-3 text-slate-500"><Wallet size={18} /><span className="text-xs font-bold uppercase tracking-[0.24em]">Account</span></div>
            <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-2xl border border-slate-200 bg-white p-4"><p className="text-slate-500">Equity</p><p className="font-mono text-lg font-black text-slate-900">{money(account?.equity, currency)}</p></div>
              <div className="rounded-2xl border border-slate-200 bg-white p-4"><p className="text-slate-500">P/L</p><p className={`font-mono text-lg font-black ${(account?.profit || 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{money(account?.profit, currency)}</p></div>
              <div className="rounded-2xl border border-slate-200 bg-white p-4"><p className="text-slate-500">Trades</p><p className="font-mono text-lg font-black text-slate-900">{openTrades.length}</p></div>
              <div className="rounded-2xl border border-slate-200 bg-white p-4"><p className="text-slate-500">MT5</p><p className="font-mono text-lg font-black text-slate-900">{status.connected ? 'Live' : 'Waiting'}</p></div>
            </div>
          </div>

          <div className="light-card rounded-3xl p-6">
            <div className="flex items-center justify-between text-slate-500">
              <div className="flex items-center gap-3"><CalendarClock size={18} /><span className="text-xs font-bold uppercase tracking-[0.24em]">Upcoming News</span></div>
              <a href="#/calendar" className="text-[11px] font-bold text-amber-600 hover:text-amber-700">View all →</a>
            </div>
            <div className="mt-4 space-y-2">
              {symbolNews.length === 0 && (
                <p className="rounded-xl border border-dashed border-slate-200 bg-white p-4 text-center text-xs font-semibold text-slate-400">
                  No scheduled events for {selectedSymbol || 'this symbol'} in the next 24h.
                </p>
              )}
              {symbolNews.slice(0, 5).map((e) => {
                const mins = Math.round((e.timestampUtc - Date.now()) / 60000);
                const imminent = e.impact === 'HIGH' && Math.abs(mins) <= 30;
                const dot = e.impact === 'HIGH' ? 'bg-red-500' : e.impact === 'MODERATE' ? 'bg-amber-500' : 'bg-slate-400';
                return (
                  <div key={e.id} className={`flex items-center gap-3 rounded-xl border p-2.5 ${imminent ? 'border-red-200 bg-red-50' : 'border-slate-200 bg-white'}`}>
                    <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
                    <span className="w-10 shrink-0 text-[11px] font-black text-slate-700">{e.currency}</span>
                    <span className="min-w-0 flex-1 truncate text-xs font-bold text-slate-700">{e.title}</span>
                    <span className={`shrink-0 text-[11px] font-bold ${imminent ? 'text-red-600' : 'text-slate-400'}`}>
                      {imminent && <AlertTriangle size={11} className="mr-0.5 inline" />}
                      {mins >= 0 ? `${mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h`}` : 'now'}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <section className="light-card rounded-3xl p-6">
            <div className="mb-5 flex items-center justify-between">
              <div className="flex items-center gap-3 text-slate-900"><Activity className="text-amber-500" size={20} /><h2 className="text-xl font-black">Live Chart</h2></div>
              <div className="flex items-center gap-3 text-xs font-bold text-slate-500">
                {latestChartCandle ? (() => {
                  const candleAgeMs = now - (Date.parse(latestChartCandle.time) || now);
                  const feedStale = candleAgeMs > timeframeToMs(selectedTimeframe) * 2;
                  return (
                    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${feedStale ? 'border-red-200 bg-red-50 text-red-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${feedStale ? 'bg-red-500' : 'bg-emerald-500 animate-pulse'}`} />
                      {feedStale ? 'Feed stale' : 'Live'} · {chartCandles.length} bars · {fmtAge(candleAgeMs)}
                    </span>
                  );
                })() : <span>{selectedSymbol} {selectedTimeframe} collecting candles</span>}
                {loadingAi && <Loader2 size={18} className="animate-spin text-amber-500" />}
              </div>
            </div>
            <div className="mb-4 flex flex-wrap gap-2">
              {timeframes.map((timeframe) => {
                const row = coverageByTimeframe.get(timeframe);
                const count = row?.count || 0;
                return (
                  <button key={timeframe} onClick={() => setSelectedTimeframe(timeframe)} className={`rounded-xl border px-3 py-2 text-xs font-black transition ${timeframe === selectedTimeframe ? 'border-amber-300 bg-amber-100 text-amber-800' : count ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:border-amber-200' : 'border-slate-200 bg-white text-slate-400 hover:border-amber-200'}`}>
                    {timeframe} <span className="font-mono opacity-70">{count || 0}</span>
                  </button>
                );
              })}
            </div>
            {!chartCandles.length && selectedCoverageRows.length === 0 && <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-800">{selectedSymbol} is detected but its candle batch has not arrived yet. Keep MT5 running; EA 1.03 prioritizes the attached chart symbol first.</div>}
            {!chartCandles.length && selectedCoverageRows.length > 0 && <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-800">No saved candles for {selectedSymbol} {selectedTimeframe}. Choose a green timeframe above or wait for the next snapshot batch.</div>}
            {activeLevels && activeLevels.direction && activeLevels.direction !== 'HOLD' && (
              <div className={`mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-3 ${
                freshness?.stale ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-slate-50'
              }`}>
                <div className="flex items-center gap-2 text-xs font-bold">
                  <span className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 font-black ${
                    activeLevels.direction.includes('BUY') ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-700'
                  }`}>
                    {activeLevels.direction.replace('_', ' ')}
                  </span>
                  <span className="text-slate-500">
                    Signal {freshness ? fmtAge(freshness.ageMs) : 'n/a'}
                  </span>
                  {freshness?.stale && (
                    <span className="inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-amber-100 px-2 py-1 font-black text-amber-800">
                      <AlertTriangle size={11} /> STALE — re-scan before acting
                    </span>
                  )}
                </div>
                {entryDrift && (
                  <div className="flex items-center gap-2 text-xs font-bold text-slate-500">
                    <span>Entry drift:</span>
                    <span className={`font-mono font-black ${Math.abs(entryDrift.pips) > 20 ? 'text-amber-700' : 'text-slate-700'}`}>
                      {entryDrift.diff >= 0 ? '+' : ''}{entryDrift.pips.toFixed(1)} pips
                    </span>
                    <span className="text-slate-400">(live {entryDrift.livePrice} vs entry {entryDrift.entry})</span>
                  </div>
                )}
              </div>
            )}
            <div className="overflow-hidden rounded-2xl bg-white">
              <Mt5CandlestickChart candles={chartCandles} signals={signals} symbol={selectedSymbol} timeframe={selectedTimeframe} levels={activeLevels} />
            </div>
            {selectedCoverage && <p className="mt-3 text-xs font-bold text-slate-500">Saved range: {selectedCoverage.firstTime || 'n/a'} to {selectedCoverage.lastTime || 'n/a'}.</p>}
          </section>

          <SignalGrid indicators={indicators} symbol={selectedSymbol} timeframe={selectedTimeframe} />

          <section className="light-card rounded-3xl p-6">
            <div className="mb-4 flex items-center gap-3 text-slate-900"><BarChart3 className="text-amber-500" size={20} /><h2 className="text-xl font-black">Open Trades</h2></div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="text-xs uppercase tracking-[0.18em] text-slate-500"><tr><th className="p-3">Ticket</th><th className="p-3">Symbol</th><th className="p-3">Type</th><th className="p-3">Lots</th><th className="p-3">Open</th><th className="p-3">Current</th><th className="p-3">P/L</th></tr></thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {selectedTrades.map((trade) => <tr key={trade.id}><td className="p-3 font-mono">{trade.ticket}</td><td className="p-3 font-bold text-slate-900">{trade.symbol}</td><td className="p-3">{trade.type}</td><td className="p-3 font-mono">{trade.volume}</td><td className="p-3 font-mono">{trade.openPrice}</td><td className="p-3 font-mono">{trade.currentPrice}</td><td className={`p-3 font-bold ${(trade.profit || 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{money(trade.profit, currency)}</td></tr>)}
                </tbody>
              </table>
            </div>
            {!selectedTrades.length && <p className="rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm font-semibold text-slate-500">No open trades for this symbol.</p>}
          </section>
        </div>
      </div>
    </div>
  );
}
