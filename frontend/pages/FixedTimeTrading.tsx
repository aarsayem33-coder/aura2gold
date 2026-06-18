import React, { useEffect, useMemo, useState } from 'react';
import {
  Timer,
  Activity,
  ArrowUp,
  ArrowDown,
  MinusCircle,
  Bot,
  Cpu,
  Loader2,
  RefreshCcw,
  Search,
  Trophy,
  XCircle,
  Clock,
  CheckCircle2,
  TrendingUp,
  TrendingDown,
  BarChart3,
  Volume2,
  VolumeX,
} from 'lucide-react';
import Mt5CandlestickChart from '../components/Mt5CandlestickChart';
import { fetchMt5CandleCoverage, fetchMt5Candles, fetchFttHistory, triggerFttPrediction, useMt5Stream } from '../mt5Api';
import type { FttPrediction, Mt5Candle, Mt5CandleCoverageRow } from '../types';
import { orderSymbols } from '../utils/symbols';

const EXPIRY_OPTIONS = [
  { value: '1m', label: '1 min' },
  { value: '2m', label: '2 min' },
  { value: '3m', label: '3 min' },
  { value: '4m', label: '4 min' },
  { value: '5m', label: '5 min' },
  { value: '10m', label: '10 min' },
  { value: '15m', label: '15 min' },
  { value: '20m', label: '20 min' },
  { value: '30m', label: '30 min' },
  { value: '40m', label: '40 min' },
  { value: '1h', label: '1 hour' },
];

function expiryToMs(expiry: string): number {
  const num = parseInt(expiry, 10);
  if (expiry.endsWith('h')) return num * 60 * 60 * 1000;
  return num * 60 * 1000;
}

function formatExpiryLabel(expiry: string) {
  const exp = String(expiry || '').trim().toLowerCase();
  if (exp === '1m') return '1 Min';
  if (exp === '2m') return '2 Min';
  if (exp === '3m') return '3 Min';
  if (exp === '4m') return '4 Min';
  if (exp === '5m') return '5 Min';
  if (exp === '10m') return '10 Min';
  if (exp === '15m') return '15 Min';
  if (exp === '20m') return '20 Min';
  if (exp === '30m') return '30 Min';
  if (exp === '40m') return '40 Min';
  if (exp === '1h') return '1 Hour';
  
  const val = parseInt(exp, 10);
  if (!isNaN(val)) {
    if (exp.endsWith('h')) return `${val} Hr`;
    return `${val} Min`;
  }
  return expiry;
}

function price(value?: number | null) {
  if (value === null || value === undefined) return 'n/a';
  return value.toFixed(value > 100 ? 2 : 5);
}

function directionIcon(dir: string) {
  if (dir === 'UP') return <ArrowUp size={16} className="text-emerald-500" />;
  if (dir === 'DOWN') return <ArrowDown size={16} className="text-red-500" />;
  return <MinusCircle size={14} className="text-slate-400" />;
}

function directionBadge(dir: string) {
  const base = 'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-black border';
  if (dir === 'UP') return `${base} bg-emerald-50 text-emerald-800 border-emerald-200`;
  if (dir === 'DOWN') return `${base} bg-red-50 text-red-800 border-red-200`;
  return `${base} bg-slate-100 text-slate-700 border-slate-200`;
}

function outcomeBadge(outcome: string) {
  const base = 'inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-black border';
  if (outcome === 'WIN') return `${base} bg-emerald-50 text-emerald-700 border-emerald-200`;
  if (outcome === 'LOSS') return `${base} bg-red-50 text-red-700 border-red-200`;
  if (outcome === 'DRAW') return `${base} bg-amber-50 text-amber-700 border-amber-200`;
  if (outcome === 'PENDING') return `${base} bg-blue-50 text-blue-700 border-blue-200`;
  return `${base} bg-slate-100 text-slate-500 border-slate-200`;
}

function outcomeIcon(outcome: string) {
  if (outcome === 'WIN') return <Trophy size={12} />;
  if (outcome === 'LOSS') return <XCircle size={12} />;
  if (outcome === 'PENDING') return <Clock size={12} />;
  return <CheckCircle2 size={12} />;
}

function fttConfidenceGrade(confidence?: number | null) {
  const c = Number(confidence);
  if (!Number.isFinite(c)) return 'WATCH ONLY';
  if (c >= 90) return 'A+ Setup';
  if (c >= 80) return 'A Setup';
  if (c >= 75) return 'B Setup';
  return 'WATCH ONLY';
}

function fttGradeClass(grade: string) {
  if (grade.includes('A+')) return 'bg-emerald-600 text-white border-emerald-700 animate-pulse';
  if (grade.includes('A')) return 'bg-emerald-50 text-emerald-800 border-emerald-200';
  if (grade.includes('B')) return 'bg-blue-50 text-blue-800 border-blue-200';
  return 'bg-amber-50 text-amber-800 border-amber-200';
}

function fttQualityClass(tier?: string) {
  if (tier === 'QUALITY_SIGNAL') return 'bg-emerald-600 text-white border-emerald-700 animate-pulse';
  if (tier === 'TRADE_SIGNAL') return 'bg-blue-50 text-blue-800 border-blue-200';
  if (tier === 'NO_TRADE') return 'bg-slate-100 text-slate-500 border-slate-200';
  return 'bg-amber-50 text-amber-800 border-amber-200';
}

function useCountdown(targetTime: string | null) {
  const [remaining, setRemaining] = useState('');
  useEffect(() => {
    if (!targetTime) return;
    const interval = setInterval(() => {
      const diff = new Date(targetTime).getTime() - Date.now();
      if (diff <= 0) {
        setRemaining('Expired');
        clearInterval(interval);
        return;
      }
      const mins = Math.floor(diff / 60000);
      const secs = Math.floor((diff % 60000) / 1000);
      setRemaining(`${mins}:${String(secs).padStart(2, '0')}`);
    }, 500);
    return () => clearInterval(interval);
  }, [targetTime]);
  return remaining;
}

function PredictionCountdown({ expiryTime }: { expiryTime: string }) {
  const remaining = useCountdown(expiryTime);
  const isExpired = remaining === 'Expired';
  return (
    <span className={`font-mono text-sm font-black ${isExpired ? 'text-slate-400' : 'text-amber-600'}`}>
      {remaining || '...'}
    </span>
  );
}

export default function FixedTimeTrading() {
  const fttTradeThreshold = 75;
  const { signals, candles, indicators, status, refresh } = useMt5Stream();
  const [selectedSymbol, setSelectedSymbol] = useState('');
  const [selectedExpiry, setSelectedExpiry] = useState('5m');
  const [advisorMode, setAdvisorMode] = useState<'system' | 'ai'>('system');
  const [loadingPrediction, setLoadingPrediction] = useState(false);
  const [predictionError, setPredictionError] = useState<string | null>(null);
  const [latestPrediction, setLatestPrediction] = useState<FttPrediction | null>(null);
  const [predictions, setPredictions] = useState<FttPrediction[]>([]);
  const [symbolSearch, setSymbolSearch] = useState('');
  const [selectedCandles, setSelectedCandles] = useState<Mt5Candle[]>([]);
  const [coverageRows, setCoverageRows] = useState<Mt5CandleCoverageRow[]>([]);

  // High-Precision Timing States
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [candleSecondsLeft, setCandleSecondsLeft] = useState(0);
  const [candlePercentElapsed, setCandlePercentElapsed] = useState(0);

  const symbols = useMemo(
    () => orderSymbols([
      ...coverageRows.map((r) => r.symbol),
      ...status.symbols,
      ...candles.map((c) => c.symbol),
    ]),
    [coverageRows, status.symbols, candles],
  );
  const filteredSymbols = useMemo(() => {
    const q = symbolSearch.trim().toUpperCase();
    if (!q) return symbols;
    return symbols.filter((s) => s.includes(q));
  }, [symbolSearch, symbols]);

  // Chart timeframe: use M1 for 1m-4m, M2 for 5m, M3 for 10m, M5 for 15m-40m, M15 for 1h
  const chartTimeframe = useMemo(() => {
    const exp = String(selectedExpiry || '5m').trim().toLowerCase();
    if (['1m', '2m', '3m', '4m'].includes(exp)) return 'M1';
    if (exp === '5m') return 'M2';
    if (exp === '10m') return 'M3';
    if (['15m', '20m', '30m', '40m'].includes(exp)) return 'M5';
    if (exp === '1h') return 'M15';
    return 'M5';
  }, [selectedExpiry]);

  const timeframes = useMemo(
    () => [...new Set([...status.timeframes, ...candles.map((c) => c.timeframe)].filter(Boolean))].sort(),
    [status.timeframes, candles],
  );

  // Native Web Audio API Chime Synth
  const playChime = (type: 'beep' | 'go') => {
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;
      const ctx = new AudioContextClass();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      
      osc.connect(gain);
      gain.connect(ctx.destination);
      
      if (type === 'beep') {
        osc.frequency.setValueAtTime(880, ctx.currentTime); // High pitch warning A
        gain.gain.setValueAtTime(0.08, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.12);
      } else {
        osc.frequency.setValueAtTime(1046.50, ctx.currentTime); // C6 chime
        gain.gain.setValueAtTime(0.12, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.25);
      }
    } catch (e) {
      console.warn('Audio play blocked or failed:', e);
    }
  };

  // High-precision ticking candle countdown
  useEffect(() => {
    let lastPlayedSecond = -1;
    const interval = setInterval(() => {
      const tf = chartTimeframe;
      let periodMs = 5 * 60 * 1000;
      if (tf === 'M1') periodMs = 60 * 1000;
      else if (tf === 'M2') periodMs = 2 * 60 * 1000;
      else if (tf === 'M3') periodMs = 3 * 60 * 1000;
      else if (tf === 'M5') periodMs = 5 * 60 * 1000;
      else if (tf === 'M15') periodMs = 15 * 60 * 1000;
      else if (tf === 'M30') periodMs = 30 * 60 * 1000;
      else if (tf === 'H1') periodMs = 60 * 60 * 1000;

      const nowMs = Date.now();
      const nextOpenMs = Math.ceil(nowMs / periodMs) * periodMs;
      const remainingMs = nextOpenMs - nowMs;
      const remainingSeconds = Math.ceil(remainingMs / 1000);
      const elapsedSeconds = (periodMs / 1000) - remainingSeconds;
      
      setCandleSecondsLeft(remainingSeconds);
      setCandlePercentElapsed((elapsedSeconds / (periodMs / 1000)) * 100);

      // Sound alerts at 3, 2, 1, 0 (rollover) seconds
      if (soundEnabled && remainingSeconds !== lastPlayedSecond) {
        if (remainingSeconds === 3 || remainingSeconds === 2 || remainingSeconds === 1) {
          playChime('beep');
          lastPlayedSecond = remainingSeconds;
        } else if (remainingSeconds === periodMs / 1000 || remainingSeconds === 0) {
          playChime('go');
          lastPlayedSecond = remainingSeconds;
        }
      }
    }, 200);
    
    return () => clearInterval(interval);
  }, [chartTimeframe, soundEnabled]);

  // Dynamic timing advice calculation based on active candle tick
  const dynamicTimingInfo = useMemo(() => {
    const direction = latestPrediction?.direction || 'HOLD';
    
    if (direction === 'HOLD') {
      return {
        instruction: 'HOLD_NO_TRADE',
        badgeText: 'Neutral / No Setup',
        badgeClass: 'bg-slate-100 text-slate-600 border-slate-200',
        tip: 'No clear trade direction. Click Get Prediction to activate guidelines.',
        progressColor: 'bg-slate-300'
      };
    }

    const ema9Entry = indicators.find((ind) => {
      const name = String(ind.indicator || ind.name || '').toUpperCase();
      return name === 'EMA9' || name === 'EMA 9' || name === 'EMA_9';
    });
    const ema9 = ema9Entry ? Number(ema9Entry.value1) : null;
    const currentPrice = latestPrediction.entryPrice;
    const ema9PriceStr = ema9 ? ema9.toFixed(currentPrice > 100 ? 2 : 5) : '';

    let periodSecs = 300;
    if (chartTimeframe === 'M1') periodSecs = 60;
    else if (chartTimeframe === 'M2') periodSecs = 120;
    else if (chartTimeframe === 'M3') periodSecs = 180;
    else if (chartTimeframe === 'M5') periodSecs = 300;
    else if (chartTimeframe === 'M15') periodSecs = 900;
    else if (chartTimeframe === 'M30') periodSecs = 1800;
    else if (chartTimeframe === 'H1') periodSecs = 3600;

    const immediateSecs = Math.min(30, periodSecs * 0.1);
    const waitSecs = Math.min(30, periodSecs * 0.1);

    if (candleSecondsLeft <= waitSecs) {
      return {
        instruction: 'WAIT_FOR_NEXT_CANDLE',
        badgeText: '⏳ Wait Candle',
        badgeClass: 'bg-amber-100 text-amber-800 border-amber-300',
        tip: `Current candle is closing in ${candleSecondsLeft}s. Wait for the new candle open to enter immediately.`,
        progressColor: 'bg-amber-500 animate-pulse'
      };
    } else if (candleSecondsLeft >= (periodSecs - immediateSecs)) {
      return {
        instruction: 'IMMEDIATE_ENTRY',
        badgeText: '⚡ Execute Now',
        badgeClass: 'bg-emerald-500 text-white border-emerald-600 animate-pulse',
        tip: `New candle just opened (${candleSecondsLeft}s remaining). Execute ${direction} trade now for maximum momentum.`,
        progressColor: 'bg-emerald-500'
      };
    } else if (candleSecondsLeft < (periodSecs * 0.5)) {
      return {
        instruction: 'LATE_ENTRY_WARNING',
        badgeText: '⚠️ Late / High Risk',
        badgeClass: 'bg-rose-100 text-rose-800 border-rose-300',
        tip: `Candle is over 50% complete (${candleSecondsLeft}s left). High risk of short-term retracement before expiry.`,
        progressColor: 'bg-rose-500'
      };
    } else {
      return {
        instruction: 'PULLBACK_OR_MOMENTUM',
        badgeText: '🔄 Pullback / Mnt',
        badgeClass: 'bg-blue-100 text-blue-800 border-blue-300',
        tip: ema9PriceStr 
          ? `Price is mid-candle (${candleSecondsLeft}s left). Enter on a pullback to EMA9 (around ${ema9PriceStr}) for a better price, or enter now on momentum.`
          : `Price is mid-candle (${candleSecondsLeft}s left). Wait for a minor pullback or enter now if momentum is strong.`,
        progressColor: 'bg-blue-500'
      };
    }
  }, [candleSecondsLeft, latestPrediction, chartTimeframe, indicators]);

  useEffect(() => {
    if (!selectedSymbol && symbols.length) setSelectedSymbol(symbols[0]);
  }, [selectedSymbol, symbols]);

  // Load coverage
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const payload = await fetchMt5CandleCoverage();
        if (!cancelled) setCoverageRows(payload.rows);
      } catch {
        if (!cancelled) setCoverageRows([]);
      }
    };
    void load();
    const interval = window.setInterval(() => void load(), 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // Load chart candles for selected symbol + chart timeframe
  useEffect(() => {
    if (!selectedSymbol || !chartTimeframe) return;
    let cancelled = false;
    fetchMt5Candles(selectedSymbol, chartTimeframe, 5000)
      .then((p) => { if (!cancelled) setSelectedCandles(p.candles); })
      .catch(() => { if (!cancelled) setSelectedCandles([]); });
    return () => { cancelled = true; };
  }, [selectedSymbol, chartTimeframe]);

  // Load prediction history
  useEffect(() => {
    if (!selectedSymbol) return;
    let cancelled = false;
    fetchFttHistory(selectedSymbol, 50)
      .then((p) => { if (!cancelled) setPredictions(p.predictions); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selectedSymbol]);

  // Refresh predictions every 5 seconds for outcome resolution
  useEffect(() => {
    if (!selectedSymbol) return;
    const interval = setInterval(() => {
      fetchFttHistory(selectedSymbol, 50)
        .then((p) => setPredictions(p.predictions))
        .catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, [selectedSymbol]);

  const streamCandles = candles
    .filter((c) => c.symbol === selectedSymbol && c.timeframe === chartTimeframe)
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  const chartCandles = [
    ...new Map(
      [...selectedCandles, ...streamCandles]
        .filter((c) => c.symbol === selectedSymbol && c.timeframe === chartTimeframe)
        .map((c) => [`${c.symbol}|${c.timeframe}|${c.time}`, c]),
    ).values(),
  ].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

  const activePredictions = predictions.filter((p) => p.outcome === 'PENDING');
  const resolvedPredictions = predictions.filter((p) => p.outcome !== 'PENDING');
  const wins = predictions.filter((p) => p.outcome === 'WIN').length;
  const losses = predictions.filter((p) => p.outcome === 'LOSS').length;
  const winRate = wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : 0;
  const latestWatchOnlyPrediction = latestPrediction && latestPrediction.confidence < fttTradeThreshold ? latestPrediction : null;
  const latestFttGrade = latestPrediction ? fttConfidenceGrade(latestPrediction.confidence) : null;
  const latestUnderlyingGrade = latestPrediction ? (latestPrediction.indicators as any)?.grade : null;
  const latestQualityTier = latestPrediction ? ((latestPrediction.indicators as any)?.qualityTier || latestPrediction.tradeStatus) : null;
  const latestQualityScore = latestPrediction ? (latestPrediction.indicators as any)?.qualityScore : null;
  const latestRiskWarnings = latestPrediction ? ((latestPrediction.indicators as any)?.riskWarnings || []) : [];
  const latestQualityReasons = latestPrediction ? ((latestPrediction.indicators as any)?.qualityReasons || []) : [];
  const latestPatterns = latestPrediction ? ((latestPrediction.indicators as any)?.detectedPatterns || []) : [];
  const latestVolatility = latestPrediction ? (latestPrediction.indicators as any)?.volatilityState : null;

  async function handlePredict() {
    if (!selectedSymbol) return;
    setLoadingPrediction(true);
    setPredictionError(null);
    try {
      const result = await triggerFttPrediction(selectedSymbol, selectedExpiry, advisorMode);
      setLatestPrediction(result.prediction);
      setPredictions((prev) => [result.prediction, ...prev.filter((p) => p.id !== result.prediction.id)]);
    } catch (error) {
      setPredictionError(error instanceof Error ? error.message : 'Prediction failed');
    } finally {
      setLoadingPrediction(false);
    }
  }

  return (
    <div className="terminal-page -m-6 min-h-screen space-y-6 p-6 lg:-m-10 lg:p-10">
      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.32em] text-amber-600">Fixed-Time</p>
          <h1 className="mt-2 text-4xl font-black tracking-tight text-slate-900">
            Fixed-Time Predictions
          </h1>
          <p className="mt-2 text-sm font-semibold text-slate-500">
            Predict price direction within a fixed time window. Advisory only — no trades placed.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[220px]">
            <Search className="pointer-events-none absolute left-3 top-3.5 text-slate-400" size={18} />
            <input
              value={symbolSearch}
              onChange={(e) => setSymbolSearch(e.target.value)}
              placeholder="Search symbols..."
              className="w-full rounded-xl border border-slate-200 bg-white py-3 pl-10 pr-4 text-sm font-bold text-slate-900 outline-none focus:border-amber-400"
            />
          </div>
          <select
            value={selectedSymbol}
            onChange={(e) => setSelectedSymbol(e.target.value)}
            className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-900 outline-none focus:border-amber-400"
          >
            {filteredSymbols.length
              ? filteredSymbols.map((s) => <option key={s}>{s}</option>)
              : <option value={selectedSymbol || ''}>{selectedSymbol || 'Waiting'}</option>}
          </select>
        </div>
      </div>

      {/* Symbol Chips */}
      <section className="light-card rounded-3xl p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="text-xs font-black uppercase tracking-[0.24em] text-slate-500">
            Available Instruments
          </p>
          <p className="text-xs font-bold text-slate-400">
            {filteredSymbols.length} of {symbols.length} symbols
          </p>
        </div>
        <div className="flex max-h-28 flex-wrap gap-2 overflow-y-auto pr-1">
          {filteredSymbols.map((s) => (
            <button
              key={s}
              onClick={() => setSelectedSymbol(s)}
              className={`rounded-full border px-3 py-1.5 text-xs font-black transition ${
                s === selectedSymbol
                  ? 'border-amber-300 bg-amber-100 text-amber-800'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-amber-200 hover:text-slate-900'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[420px_1fr]">
        {/* Left Column: Prediction Panel */}
        <div className="space-y-6">
          {/* Prediction Card */}
          <section className="light-card rounded-3xl p-6">
            <div className="mb-5 flex items-center gap-3 text-slate-900">
              <Timer className="text-amber-500" size={22} />
              <h2 className="text-xl font-black">Prediction Setup</h2>
            </div>

            {/* Expiry Selector */}
            <div className="mb-5">
              <p className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-slate-500">Expiry Window</p>
              <div className="flex flex-wrap gap-2">
                {EXPIRY_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setSelectedExpiry(opt.value)}
                    className={`rounded-xl border px-3 py-2 text-xs font-black transition ${
                      selectedExpiry === opt.value
                        ? 'border-amber-300 bg-amber-100 text-amber-800'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-amber-200'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Advisor Mode Toggle */}
            <div className="mb-5">
              <p className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-slate-500">Advisor Mode</p>
              <div className="flex gap-2">
                <button
                  onClick={() => setAdvisorMode('system')}
                  className={`flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-bold transition ${
                    advisorMode === 'system'
                      ? 'border-blue-300 bg-blue-50 text-blue-800'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-blue-200'
                  }`}
                >
                  <Cpu size={16} />
                  System
                </button>
                <button
                  onClick={() => setAdvisorMode('ai')}
                  className={`flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-bold transition ${
                    advisorMode === 'ai'
                      ? 'border-violet-300 bg-violet-50 text-violet-800'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-violet-200'
                  }`}
                >
                  <Bot size={16} />
                  AI (Gemini)
                </button>
              </div>
            </div>

            {/* Predict Button */}
            <button
              onClick={handlePredict}
              disabled={loadingPrediction || !selectedSymbol}
              className={`w-full rounded-xl px-6 py-3.5 text-sm font-black transition shadow-lg disabled:opacity-50 ${
                advisorMode === 'ai'
                  ? 'bg-violet-500 hover:bg-violet-600 text-white shadow-violet-500/20'
                  : 'bg-blue-500 hover:bg-blue-600 text-white shadow-blue-500/20'
              }`}
            >
              {loadingPrediction ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 size={16} className="animate-spin" />
                  Analyzing...
                </span>
              ) : advisorMode === 'ai' ? (
                <span className="inline-flex items-center gap-2">
                  <Bot size={16} />
                  Ask AI Prediction
                </span>
              ) : (
                <span className="inline-flex items-center gap-2">
                  <Cpu size={16} />
                  Get System Prediction
                </span>
              )}
            </button>

            {predictionError && (
              <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-700">
                {predictionError}
              </div>
            )}

            {/* High-Precision Execution Timing Hub */}
            <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50/50 p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Timer size={16} className="text-amber-500" />
                  <span className="text-xs font-black uppercase tracking-wider text-slate-500">Execution Timing Hub</span>
                </div>
                <button
                  onClick={() => setSoundEnabled((prev) => !prev)}
                  className={`flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-black transition border ${
                    soundEnabled 
                      ? 'bg-amber-100 text-amber-800 border-amber-300' 
                      : 'bg-slate-100 text-slate-600 border-slate-200'
                  }`}
                >
                  {soundEnabled ? (
                    <>
                      <Volume2 size={12} className="text-amber-600 animate-pulse" />
                      <span>Sound ON</span>
                    </>
                  ) : (
                    <>
                      <VolumeX size={12} className="text-slate-400" />
                      <span>Sound OFF</span>
                    </>
                  )}
                </button>
              </div>

              {/* Big Countdown & Progress */}
              <div className="bg-white rounded-xl border border-slate-100 p-4 mb-3 shadow-sm flex items-center justify-between gap-4">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Current Candle Timer ({chartTimeframe})</p>
                  <p className="font-mono text-3xl font-black text-slate-900 tracking-tight mt-1">
                    {Math.floor(candleSecondsLeft / 60)}:{String(candleSecondsLeft % 60).padStart(2, '0')}
                  </p>
                </div>
                <div className="flex-1 max-w-[150px]">
                  <div className="flex justify-between text-[10px] font-black text-slate-400 mb-1">
                    <span>Progress</span>
                    <span>{Math.round(candlePercentElapsed)}%</span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                    <div 
                      className={`h-full transition-all duration-300 ${dynamicTimingInfo.progressColor}`}
                      style={{ width: `${candlePercentElapsed}%` }}
                    />
                  </div>
                </div>
              </div>

              {/* Dynamic Action Instruction */}
              <div className={`rounded-xl border p-3.5 ${dynamicTimingInfo.badgeClass} flex flex-col gap-1 shadow-sm`}>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-black uppercase tracking-wider">Entry Guide</span>
                  <span className="font-mono text-[10px] font-extrabold uppercase">
                    {dynamicTimingInfo.badgeText}
                  </span>
                </div>
                <p className="text-xs font-bold leading-relaxed">
                  {dynamicTimingInfo.tip}
                </p>
              </div>
              
              {/* Live Sound Alert Prompt */}
              {soundEnabled && candleSecondsLeft <= 5 && candleSecondsLeft > 0 && (
                <div className="mt-3 text-center text-xs font-black text-amber-600 animate-pulse">
                  🚨 Prepare Entry! T-Minus {candleSecondsLeft}s...
                </div>
              )}
            </div>

            {/* Latest Prediction Result */}
            {latestPrediction && (
              <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-5">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {directionIcon(latestPrediction.direction)}
                    <span className={directionBadge(latestPrediction.direction)}>
                      {latestPrediction.direction}
                    </span>
                    {latestFttGrade && (
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wider border shadow-sm ${fttGradeClass(latestFttGrade)}`}>
                        {latestFttGrade}
                      </span>
                    )}
                    {latestQualityTier && (
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wider border shadow-sm ${fttQualityClass(latestQualityTier)}`}>
                        {String(latestQualityTier).replace(/_/g, ' ')}{latestQualityScore !== undefined ? ` · Q${latestQualityScore}` : ''}
                      </span>
                    )}
                    <span className={`rounded-full px-3 py-1 text-[10px] font-black uppercase tracking-wider border shadow-sm ${latestPrediction.confidence >= fttTradeThreshold ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 'bg-amber-50 text-amber-800 border-amber-200'}`}>
                      {latestPrediction.confidence >= fttTradeThreshold ? 'TRADE SIGNAL' : 'WATCH ONLY'}
                    </span>
                  </div>
                  <span className={`rounded-full px-3 py-1 text-xs font-black uppercase tracking-wider border shadow-sm ${
                    latestPrediction.confidence >= 90 ? 'bg-emerald-600 text-white border-emerald-700 animate-pulse' :
                    latestPrediction.confidence >= 80 ? 'bg-emerald-50 text-emerald-800 border-emerald-200' :
                    latestPrediction.confidence >= 70 ? 'bg-blue-50 text-blue-800 border-blue-200' :
                    'bg-slate-100 text-slate-700 border-slate-200'
                  }`}>
                    Score: {latestPrediction.confidence} / 100
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-xs font-bold text-slate-400">Entry</p>
                    <p className="font-mono font-black text-slate-900">{price(latestPrediction.entryPrice)}</p>
                  </div>
                  <div>
                    <p className="text-xs font-bold text-slate-400">Expiry</p>
                    <p className="font-mono font-black text-amber-600">{selectedExpiry}</p>
                  </div>
                  <div>
                    <p className="text-xs font-bold text-slate-400">Countdown</p>
                    <PredictionCountdown expiryTime={latestPrediction.expiryTime} />
                  </div>
                  <div>
                    <p className="text-xs font-bold text-slate-400">Source</p>
                    <p className="text-xs font-black text-slate-600">
                      {latestPrediction.source === 'ai' ? '🤖 AI' : '⚙️ System'}
                    </p>
                  </div>
                </div>

                {latestWatchOnlyPrediction && (
                  <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-bold text-amber-800">
                    Watch only: confidence {Math.round(latestWatchOnlyPrediction.confidence)} is below the trade threshold of {fttTradeThreshold}.
                  </div>
                )}

                {latestUnderlyingGrade && latestUnderlyingGrade !== latestFttGrade && (
                  <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs font-bold text-slate-500">
                    Underlying system setup: {latestUnderlyingGrade}
                  </div>
                )}

                {(latestPatterns.length > 0 || latestVolatility || latestQualityReasons.length > 0 || latestRiskWarnings.length > 0) && (
                  <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs font-semibold text-slate-600">
                    {latestPatterns.length > 0 && <p><b>Patterns:</b> {latestPatterns.join(', ')}</p>}
                    {latestVolatility && <p><b>Volatility:</b> {latestVolatility}</p>}
                    {latestQualityReasons.length > 0 && <p className="text-emerald-700"><b>Quality:</b> {latestQualityReasons.join('; ')}</p>}
                    {latestRiskWarnings.length > 0 && <p className="text-amber-700"><b>Warnings:</b> {latestRiskWarnings.join('; ')}</p>}
                  </div>
                )}

                {/* Confluences Points Breakdown */}
                {latestPrediction.indicators?.confluences && latestPrediction.indicators.confluences.length > 0 && (
                  <div className="mt-4 space-y-2 rounded-xl border border-slate-100 bg-slate-50 p-4">
                    <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2 border-b border-slate-200 pb-1.5">
                      Institutional Confluences ({latestPrediction.indicators.buyScore ?? 0} Buy / {latestPrediction.indicators.sellScore ?? 0} Sell)
                    </span>
                    <div className="grid grid-cols-1 gap-1.5 max-h-36 overflow-y-auto pr-1">
                      {latestPrediction.indicators.confluences.map((c: any, idx: number) => (
                        <div key={idx} className="flex items-center justify-between text-[11px] font-semibold text-slate-700 py-0.5 border-b border-dashed border-slate-100 last:border-0">
                          <span className="flex items-center gap-1.5">
                            <span className={c.type === 'bullish' ? 'text-emerald-600 font-bold' : c.type === 'bearish' ? 'text-red-500 font-bold' : 'text-slate-400 font-bold'}>
                              {c.type === 'bullish' ? '✓' : c.type === 'bearish' ? '✗' : '•'}
                            </span>
                            <span className="text-slate-700">{c.name}</span>
                          </span>
                          <span className={c.type === 'bullish' ? 'text-emerald-600 font-bold' : c.type === 'bearish' ? 'text-red-600 font-bold' : 'text-slate-500 font-bold'}>
                            +{c.points}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                
                {/* Reference to Live Timing Hub */}
                <div className="mt-4 rounded-xl border border-slate-100 bg-slate-50 p-3 text-xs font-semibold text-slate-500 text-center">
                  💡 Watch the <span className="font-black text-amber-600">Execution Timing Hub</span> above for real-time entry alerts and sound countdowns.
                </div>

                {latestPrediction.reasoning && (
                  <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50 p-3 text-xs font-medium text-slate-600">
                    {latestPrediction.reasoning}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Stats Card */}
          <section className="light-card rounded-3xl p-6">
            <div className="mb-4 flex items-center gap-3 text-slate-900">
              <BarChart3 className="text-amber-500" size={20} />
              <h2 className="text-lg font-black">Prediction Stats</h2>
            </div>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="rounded-2xl border border-slate-200 bg-white p-4">
                <p className="text-xs font-bold text-slate-400">Win Rate</p>
                <p className={`font-mono text-2xl font-black ${winRate >= 60 ? 'text-emerald-600' : winRate >= 40 ? 'text-amber-600' : 'text-red-600'}`}>
                  {winRate}%
                </p>
              </div>
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                <p className="text-xs font-bold text-emerald-600">Wins</p>
                <p className="font-mono text-2xl font-black text-emerald-700">{wins}</p>
              </div>
              <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
                <p className="text-xs font-bold text-red-600">Losses</p>
                <p className="font-mono text-2xl font-black text-red-700">{losses}</p>
              </div>
            </div>
          </section>

          {/* Active Predictions */}
          {activePredictions.length > 0 && (
            <section className="light-card rounded-3xl p-6">
              <div className="mb-4 flex items-center gap-3 text-slate-900">
                <Clock className="text-blue-500" size={20} />
                <h2 className="text-lg font-black">Active ({activePredictions.length})</h2>
              </div>
              <div className="space-y-3">
                {activePredictions.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between rounded-2xl border border-blue-100 bg-blue-50/50 p-4"
                  >
                    <div className="flex items-center gap-3">
                      {directionIcon(p.direction)}
                      <div>
                        <p className="text-sm font-black text-slate-900">{p.symbol}</p>
                        <p className="text-xs font-bold text-slate-400">
                          {p.source === 'ai' ? '🤖 AI' : '⚙️ Sys'} · {p.expiry}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <PredictionCountdown expiryTime={p.expiryTime} />
                      <p className="text-xs font-bold text-slate-400">{p.confidence}%</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* Right Column: Chart + History */}
        <div className="space-y-6">
          {/* Chart */}
          <section className="light-card rounded-3xl p-6">
            <div className="mb-5 flex items-center justify-between">
              <div className="flex items-center gap-3 text-slate-900">
                <Activity className="text-amber-500" size={20} />
                <h2 className="text-xl font-black">Live Chart</h2>
              </div>
              <div className="flex items-center gap-3 text-xs font-bold text-slate-500">
                <span>{selectedSymbol} · {chartTimeframe} · {chartCandles.length} candles</span>
              </div>
            </div>
            <div className="overflow-hidden rounded-2xl bg-white">
              <Mt5CandlestickChart
                candles={chartCandles}
                signals={signals}
                symbol={selectedSymbol}
                timeframe={chartTimeframe}
              />
            </div>
          </section>

          {/* History Table */}
          <section className="light-card rounded-3xl p-6">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-3 text-slate-900">
                <Trophy className="text-amber-500" size={20} />
                <h2 className="text-xl font-black">Prediction History</h2>
              </div>
              <span className="text-xs font-bold text-slate-400">
                {predictions.length} predictions
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[800px] text-left text-sm">
                <thead className="text-xs uppercase tracking-[0.18em] text-slate-500 border-b border-slate-100">
                  <tr>
                    <th className="p-3">Time</th>
                    <th className="p-3">Symbol</th>
                    <th className="p-3">Expiry</th>
                    <th className="p-3">Trade Time</th>
                    <th className="p-3 text-center">Direction</th>
                    <th className="p-3 text-center">Confidence</th>
                    <th className="p-3">Entry</th>
                    <th className="p-3">Exit</th>
                    <th className="p-3">Source</th>
                    <th className="p-3 text-center">Outcome</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {predictions.map((p) => (
                    <tr key={p.id} className="hover:bg-slate-50/50 transition">
                      <td className="p-3 font-mono text-xs text-slate-500">
                        {new Date(p.created_at).toLocaleTimeString()}
                      </td>
                      <td className="p-3 font-black text-slate-900">{p.symbol}</td>
                      <td className="p-3 font-mono text-xs font-bold text-slate-400">{p.expiry}</td>
                      <td className="p-3 font-semibold text-slate-700">{formatExpiryLabel(p.expiry)}</td>
                      <td className="p-3 text-center">
                        <span className={directionBadge(p.direction)}>
                          {directionIcon(p.direction)}
                          {p.direction}
                        </span>
                      </td>
                      <td className="p-3 text-center font-mono font-black text-slate-900">
                        {p.confidence}%
                      </td>
                      <td className="p-3 font-mono font-bold text-slate-900">{price(p.entryPrice)}</td>
                      <td className="p-3 font-mono font-bold text-slate-600">
                        {p.exitPrice ? price(p.exitPrice) : <PredictionCountdown expiryTime={p.expiryTime} />}
                      </td>
                      <td className="p-3 text-xs font-bold text-slate-500">
                        {p.source === 'ai' ? '🤖 AI' : '⚙️ System'}
                      </td>
                      <td className="p-3 text-center">
                        <span className={outcomeBadge(p.outcome)}>
                          {outcomeIcon(p.outcome)}
                          {p.outcome}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {predictions.length === 0 && (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm font-semibold text-slate-500">
                No predictions yet. Select a symbol and click the predict button above.
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
