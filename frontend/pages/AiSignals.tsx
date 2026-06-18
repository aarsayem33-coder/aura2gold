import React, { useEffect, useMemo, useState, useRef } from 'react';
import {
  Brain,
  Cpu,
  Loader2,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Clock,
  Sparkles,
  BarChart3,
  Percent,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Play,
  RefreshCcw,
  BellRing,
  Radio,
  Trash2
} from 'lucide-react';
import { deleteTrackedAiProjection, trackAiProjection, useMt5Stream } from '../mt5Api';
import { formatBdDateTime } from '../utils/time';
import type { TrackedAiProjection } from '../types';

// Helper to convert simple Markdown to styled HTML
function parseMarkdownToHtml(markdown: string): string {
  if (!markdown) return '';
  return markdown
    .replace(/^### (.*$)/gim, '<h3 class="text-lg font-black text-amber-500 mt-5 mb-2 border-b border-slate-700/50 pb-1">$1</h3>')
    .replace(/^## (.*$)/gim, '<h2 class="text-xl font-black text-slate-100 mt-6 mb-3">$1</h2>')
    .replace(/^# (.*$)/gim, '<h1 class="text-2xl font-black text-slate-100 mt-8 mb-4">$1</h1>')
    .replace(/^\* (.*$)/gim, '<li class="list-disc list-inside ml-4 text-slate-300 my-1 font-medium">$1</li>')
    .replace(/^- (.*$)/gim, '<li class="list-disc list-inside ml-4 text-slate-300 my-1 font-medium">$1</li>')
    .replace(/\*\*(.*?)\*\*/g, '<strong class="font-bold text-amber-400">$1</strong>')
    .replace(/\*(.*?)\*/g, '<em class="italic text-slate-300">$1</em>')
    .replace(/`(.*?)`/g, '<code class="bg-slate-800 text-slate-200 px-1.5 py-0.5 rounded font-mono text-xs">$1</code>')
    .split('\n').map(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('<h') || trimmed.startsWith('<li') || trimmed === '') {
        return line;
      }
      return `<p class="my-3 leading-relaxed text-slate-300 font-medium text-sm">${line}</p>`;
    }).join('\n');
}

interface AnalysisResult {
  decision: 'STRONG_BUY' | 'BUY' | 'HOLD' | 'SELL' | 'STRONG_SELL';
  confidence: number;
  entryPrice: number;
  atr: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  takeProfit3: number | null;
  invalidation: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  tradeTrigger: string;
  predictedTime: string;
  clinicalReport: string;
}

interface SavedAnalysis {
  symbol: string;
  tradeMode: string;
  engine?: 'ai' | 'system';
  timestamp: string;
  analysis: AnalysisResult;
}

export default function AiSignals() {
  const { status, candles, signals, trackedAiProjections, refresh } = useMt5Stream();

  // Symbols list from MT5, fallback if not connected
  const symbols = useMemo(() => {
    const list = status?.symbols && status.symbols.length
      ? status.symbols
      : ['XAUUSDm', 'EURUSDm', 'GBPUSDm', 'USDJPYm', 'AUDUSDm', 'USDCADm'];
    return [...new Set(list)].sort();
  }, [status?.symbols]);

  // States
  const [selectedSymbol, setSelectedSymbol] = useState('');
  const [tradeMode, setTradeMode] = useState<'FTT' | 'FOREX'>('FTT');
  const [analysisEngine, setAnalysisEngine] = useState<'ai' | 'system'>('ai');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentAnalysis, setCurrentAnalysis] = useState<SavedAnalysis | null>(null);

  // Timer state (seconds remaining in the 1-hour window)
  const [timerSeconds, setTimerSeconds] = useState(0);

  // Request spam protection cooldown (seconds)
  const [requestCooldown, setRequestCooldown] = useState(0);

  // Volatility shift state
  const [isVolatilityAlert, setIsVolatilityAlert] = useState(false);
  const [volatilityReason, setVolatilityReason] = useState('');

  // Audio configuration
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [trackerLoading, setTrackerLoading] = useState(false);
  const [trackerError, setTrackerError] = useState<string | null>(null);
  const [expirationMinutes, setExpirationMinutes] = useState(60);
  const [trackedView, setTrackedView] = useState<'all' | 'triggered'>('all');
  const [clockTick, setClockTick] = useState(Date.now());
  const previousDeviatedIdsRef = useRef<Set<string>>(new Set());

  // Request cooldown timer countdown effect
  useEffect(() => {
    if (requestCooldown <= 0) return;
    const interval = setInterval(() => {
      setRequestCooldown((prev) => prev - 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [requestCooldown]);

  // Set default symbol on load
  useEffect(() => {
    if (symbols.length && !selectedSymbol) {
      setSelectedSymbol(symbols[0]);
    }
  }, [symbols, selectedSymbol]);

  // Load saved analysis & initialize timer on startup or symbol/mode change
  useEffect(() => {
    if (!selectedSymbol) return;
    const storageKey = `aura_ai_analysis_${selectedSymbol}_${tradeMode}`;
    const saved = localStorage.getItem(storageKey);
    
    if (saved) {
      try {
        const parsed: SavedAnalysis = JSON.parse(saved);
        const analysisTime = new Date(parsed.timestamp).getTime();
        const oneHour = 60 * 60 * 1000;
        const elapsed = Date.now() - analysisTime;
        
        if (elapsed < oneHour) {
          setCurrentAnalysis(parsed);
          setTimerSeconds(Math.ceil((oneHour - elapsed) / 1000));
        } else {
          setCurrentAnalysis(null);
          setTimerSeconds(0);
          localStorage.removeItem(storageKey);
        }
      } catch (e) {
        console.error('Failed to parse saved AI analysis', e);
      }
    } else {
      setCurrentAnalysis(null);
      setTimerSeconds(0);
    }
  }, [selectedSymbol, tradeMode]);

  useEffect(() => {
    setExpirationMinutes(tradeMode === 'FTT' ? 60 : 240);
  }, [tradeMode]);

  useEffect(() => {
    const interval = setInterval(() => setClockTick(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Timer countdown hook
  useEffect(() => {
    if (timerSeconds <= 0) return;
    const interval = setInterval(() => {
      setTimerSeconds((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          // Remove analysis when expired
          const storageKey = `aura_ai_analysis_${selectedSymbol}_${tradeMode}`;
          localStorage.removeItem(storageKey);
          setCurrentAnalysis(null);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [timerSeconds, selectedSymbol, tradeMode]);

  // Live Price & News Monitoring (SSE conection checks)
  // We compute price deviation against entryPrice (from active analysis) to trigger warning banner
  const latestPrice = useMemo(() => {
    if (!selectedSymbol) return 0;
    const searchSymbol = selectedSymbol.toUpperCase();
    // Check candles stream first
    const entryTf = tradeMode === 'FTT' ? 'M5' : 'H1';
    const activeCandles = candles
      .filter((c) => c.symbol.toUpperCase() === searchSymbol && c.timeframe === entryTf)
      .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
    if (activeCandles.length) {
      return activeCandles[activeCandles.length - 1].close;
    }
    // Check signals fallback
    const matchedSignal = signals.find((s) => s.symbol.toUpperCase() === searchSymbol);
    return matchedSignal?.price || 0;
  }, [selectedSymbol, tradeMode, candles, signals]);

  const activeTrackedProjection = useMemo(() => {
    if (!currentAnalysis) return null;
    const currentEntry = currentAnalysis.analysis.entryPrice === null || currentAnalysis.analysis.entryPrice === undefined
      ? null
      : Number(currentAnalysis.analysis.entryPrice);
    return trackedAiProjections.find((item) => {
      const sameSymbol = item.symbol.toUpperCase() === currentAnalysis.symbol.toUpperCase();
      const sameMode = item.tradeMode === currentAnalysis.tradeMode;
      const itemEntry = item.entryPrice === null || item.entryPrice === undefined ? null : Number(item.entryPrice);
      const sameEntry = currentEntry === null && itemEntry === null
        ? true
        : currentEntry !== null && itemEntry !== null && Math.abs(itemEntry - currentEntry) < 0.00001;
      const sameDecision = String(item.decision || '').toUpperCase() === String(currentAnalysis.analysis.decision || '').toUpperCase();
      return sameSymbol && sameMode && sameDecision && sameEntry && ['PENDING', 'TRIGGERED'].includes(item.status);
    }) || null;
  }, [currentAnalysis, trackedAiProjections]);

  const visibleTrackedProjections = useMemo(() => {
    return trackedView === 'triggered'
      ? trackedAiProjections.filter((item) => item.status === 'TRIGGERED')
      : trackedAiProjections;
  }, [trackedAiProjections, trackedView]);

  const actionableAnalysis = Boolean(
    currentAnalysis && ['BUY', 'STRONG_BUY', 'SELL', 'STRONG_SELL', 'HOLD'].includes(currentAnalysis.analysis.decision)
  );

  const trackerDisabledReason = currentAnalysis && !actionableAnalysis
    ? 'Background tracking is unavailable for this decision type.'
    : null;

  const formatPrice = (value: number | null | undefined, symbol = selectedSymbol) => {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'n/a';
    return Number(value).toFixed(symbol.toUpperCase().includes('JPY') ? 3 : 5);
  };

  const formatDuration = (seconds: number) => {
    const safe = Math.max(0, Math.floor(seconds));
    const hrs = Math.floor(safe / 3600);
    const mins = Math.floor((safe % 3600) / 60);
    const secs = safe % 60;
    if (hrs > 0) return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    return `${mins}:${String(secs).padStart(2, '0')}`;
  };

  const remainingTime = (iso: string | null) => {
    if (!iso) return 'n/a';
    const diff = Math.floor((Date.parse(iso) - clockTick) / 1000);
    if (!Number.isFinite(diff)) return 'n/a';
    return diff <= 0 ? 'expired' : formatDuration(diff);
  };

  const pipSize = (symbol: string) => symbol.toUpperCase().includes('JPY') ? 0.01 : symbol.toUpperCase().includes('XAU') ? 0.1 : 0.0001;

  const distanceToEntry = (item: TrackedAiProjection) => {
    const current = item.currentPrice ?? (item.symbol.toUpperCase() === selectedSymbol.toUpperCase() ? latestPrice : null);
    if (!current || !item.entryPrice) return 'waiting for price';
    const pips = Math.abs(Number(current) - Number(item.entryPrice)) / pipSize(item.symbol);
    return `${pips.toFixed(1)} pips ${item.status === 'PENDING' ? 'to/near entry' : 'from entry'}`;
  };

  const projectionDeviation = (item: TrackedAiProjection) => {
    if (item.status !== 'PENDING') return null;
    const original = item.originalAnalysis as Partial<AnalysisResult> | null | undefined;
    const atr = Number(original?.atr || 0);
    const current = Number(item.currentPrice || 0);
    const entry = Number(item.entryPrice || 0);
    if (!atr || !current || !entry) return null;
    const priceDiff = Math.abs(current - entry);
    const threshold = 1.5 * atr;
    return {
      deviated: priceDiff > threshold,
      priceDiff,
      threshold,
      atr,
    };
  };

  const isProjectionDeviated = (item: TrackedAiProjection) => projectionDeviation(item)?.deviated === true;

  const deviatedProjections = useMemo(() => {
    return trackedAiProjections.filter(isProjectionDeviated);
  }, [trackedAiProjections]);

  const tradeTimerLabel = currentAnalysis
    ? currentAnalysis.tradeMode === 'FTT'
      ? `Trade timer: ${formatDuration(timerSeconds)} remaining`
      : `Trade timer: ${expirationMinutes}:00 selected window`
    : null;

  const handleToggleTracking = async () => {
    if (!currentAnalysis || !actionableAnalysis || trackerLoading) return;
    setTrackerLoading(true);
    setTrackerError(null);
    try {
      if (activeTrackedProjection) {
        await deleteTrackedAiProjection(activeTrackedProjection.id);
      } else {
        const expiresAt = new Date(Date.now() + expirationMinutes * 60 * 1000).toISOString();
        await trackAiProjection({
          sourceAnalysisId: `${currentAnalysis.symbol}_${currentAnalysis.tradeMode}_${currentAnalysis.timestamp}`,
          symbol: currentAnalysis.symbol,
          tradeMode: currentAnalysis.tradeMode,
          decision: currentAnalysis.analysis.decision,
          entryPrice: currentAnalysis.analysis.entryPrice,
          stopLoss: currentAnalysis.analysis.stopLoss,
          takeProfit1: currentAnalysis.analysis.takeProfit1,
          takeProfit2: currentAnalysis.analysis.takeProfit2,
          takeProfit3: currentAnalysis.analysis.takeProfit3,
          invalidation: currentAnalysis.analysis.invalidation,
          tradeTrigger: currentAnalysis.analysis.tradeTrigger,
          confidence: currentAnalysis.analysis.confidence,
          expiresAt,
          originalAnalysis: currentAnalysis.analysis,
        });
      }
    } catch (e: any) {
      setTrackerError(e.message || 'Failed to update background tracking.');
    } finally {
      setTrackerLoading(false);
    }
  };

  // Play custom alert sound
  const playAlertSound = () => {
    if (!soundEnabled) return;
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;
      const ctx = new AudioContextClass();
      
      // Multi-frequency alarm chime
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();
      
      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);
      
      osc1.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
      osc2.frequency.setValueAtTime(659.25, ctx.currentTime); // E5
      
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.001, ctx.currentTime + 0.8);
      
      osc1.start(ctx.currentTime);
      osc2.start(ctx.currentTime);
      osc1.stop(ctx.currentTime + 0.8);
      osc2.stop(ctx.currentTime + 0.8);
    } catch (e) {
      console.warn('Audio check failed:', e);
    }
  };

  useEffect(() => {
    const currentIds = new Set(deviatedProjections.map((item) => item.id));
    const hasNewDeviation = deviatedProjections.some((item) => !previousDeviatedIdsRef.current.has(item.id));
    if (hasNewDeviation) {
      playAlertSound();
    }
    previousDeviatedIdsRef.current = currentIds;
  }, [deviatedProjections, soundEnabled]);

  // Check price deviations and flag volatility alert
  useEffect(() => {
    if (!currentAnalysis || !latestPrice) {
      setIsVolatilityAlert(false);
      return;
    }
    
    const analysis = currentAnalysis.analysis;
    if (!analysis.atr) return;

    const priceDiff = Math.abs(latestPrice - analysis.entryPrice);
    const threshold = 1.5 * analysis.atr;

    if (priceDiff > threshold) {
      if (!isVolatilityAlert) {
        playAlertSound();
      }
      setIsVolatilityAlert(true);
      setVolatilityReason(
        `Critical deviation! Price moved by ${priceDiff.toFixed(5)} (Threshold: 1.5 * ATR = ${threshold.toFixed(5)}) from analysis entry price.`
      );
    } else {
      setIsVolatilityAlert(false);
    }
  }, [latestPrice, currentAnalysis, isVolatilityAlert]);

  const runAnalysisFor = async (symbol: string, mode: 'FTT' | 'FOREX', options: { bypassCooldown?: boolean } = {}) => {
    if (!symbol || loading || (!options.bypassCooldown && requestCooldown > 0)) return;
    setLoading(true);
    setError(null);
    setIsVolatilityAlert(false);
    setRequestCooldown(10); // 10-second spam protection cooldown
    setSelectedSymbol(symbol);
    setTradeMode(mode);
    
    try {
      const response = await fetch('/api/ai-signals/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, tradeMode: mode, engine: analysisEngine }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to complete AI Signals analysis.');
      }

      const newAnalysis: SavedAnalysis = {
        symbol: data.symbol,
        tradeMode: data.tradeMode,
        engine: analysisEngine,
        timestamp: data.timestamp,
        analysis: data.analysis,
      };

      // Save to localStorage
      const storageKey = `aura_ai_analysis_${symbol}_${mode}`;
      localStorage.setItem(storageKey, JSON.stringify(newAnalysis));
      
      setCurrentAnalysis(newAnalysis);
      setTimerSeconds(mode === 'FTT' ? 3600 : Math.max(3600, expirationMinutes * 60));
    } catch (e: any) {
      setError(e.message || 'An unexpected error occurred during execution.');
    } finally {
      setLoading(false);
    }
  };

  // Handle run AI analysis
  const handleRunAnalysis = () => {
    void runAnalysisFor(selectedSymbol, tradeMode);
  };

  const handleLoadAndAnalyze = (item: TrackedAiProjection) => {
    void runAnalysisFor(item.symbol, item.tradeMode, { bypassCooldown: true });
  };

  // Helper to format countdown timer
  const formatTime = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const remainingSecs = secs % 60;
    return `${mins}:${String(remainingSecs).padStart(2, '0')}`;
  };

  // Visual markers based on decision
  const decisionConfig = useMemo(() => {
    if (!currentAnalysis) return null;
    const dec = currentAnalysis.analysis.decision;
    switch (dec) {
      case 'STRONG_BUY':
        return {
          label: 'Strong Buy',
          badgeClass: 'bg-emerald-950/80 text-emerald-400 border-emerald-500/50 shadow-emerald-500/10',
          indicatorClass: 'bg-emerald-400'
        };
      case 'BUY':
        return {
          label: 'Buy',
          badgeClass: 'bg-teal-950/80 text-teal-400 border-teal-500/50 shadow-teal-500/10',
          indicatorClass: 'bg-teal-400'
        };
      case 'SELL':
        return {
          label: 'Sell',
          badgeClass: 'bg-rose-950/80 text-rose-400 border-rose-500/50 shadow-rose-500/10',
          indicatorClass: 'bg-rose-400'
        };
      case 'STRONG_SELL':
        return {
          label: 'Strong Sell',
          badgeClass: 'bg-red-950/80 text-red-400 border-red-500/50 shadow-red-500/10',
          indicatorClass: 'bg-red-400'
        };
      case 'HOLD':
      default:
        return {
          label: 'Hold (No Trade)',
          badgeClass: 'bg-slate-900/90 text-slate-400 border-slate-700 shadow-slate-500/5',
          indicatorClass: 'bg-slate-500'
        };
    }
  }, [currentAnalysis]);

  const trackerStatusClass = (status: TrackedAiProjection['status']) => {
    switch (status) {
      case 'TRIGGERED':
        return 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300 shadow-emerald-500/10';
      case 'INVALIDATED':
        return 'border-red-500/40 bg-red-500/10 text-red-300';
      case 'EXPIRED':
        return 'border-slate-700 bg-slate-900/70 text-slate-500';
      case 'PENDING':
      default:
        return 'border-blue-500/45 bg-blue-500/10 text-blue-300 shadow-blue-500/10';
    }
  };

  return (
    <div className="terminal-page -m-6 min-h-screen space-y-6 bg-[#090D16] p-6 text-slate-100 lg:-m-10 lg:space-y-7 lg:p-10">
      
      {/* Premium Header */}
      <div className="flex flex-col gap-4 border-b border-slate-800/80 pb-6 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="inline-flex h-2 w-2 rounded-full bg-amber-500 animate-ping"></span>
            <p className="text-xs font-black uppercase tracking-[0.32em] text-amber-500">Vertex Engine</p>
          </div>
          <h1 className="mt-2 flex items-center gap-3 text-3xl font-extrabold tracking-tight text-white lg:text-4xl">
            <Brain size={36} className="text-amber-500 animate-pulse" />
            AI Projections &amp; Signals
          </h1>
          <p className="mt-2 text-sm font-bold text-slate-400">
            On-demand clinical analysis combining mathematical indicators and economic calendar news.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] font-black uppercase tracking-wide">
            <span className="rounded-full border border-slate-700 bg-slate-900/70 px-3 py-1 text-slate-300">{selectedSymbol || 'No symbol'}</span>
            <span className="rounded-full border border-slate-700 bg-slate-900/70 px-3 py-1 text-slate-300">{tradeMode}</span>
            <span className={`rounded-full border px-3 py-1 ${analysisEngine === 'ai' ? 'border-amber-500/40 bg-amber-500/10 text-amber-300' : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'}`}>
              {analysisEngine === 'ai' ? 'AI Engine' : 'System Engine'}
            </span>
          </div>
        </div>

        {/* Audio Toggle */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setSoundEnabled(!soundEnabled)}
            className={`flex items-center gap-2 rounded-xl border px-4 py-2.5 text-xs font-black transition ${
              soundEnabled
                ? 'bg-amber-500/10 text-amber-400 border-amber-500/35 hover:bg-amber-500/20'
                : 'bg-slate-900/80 text-slate-500 border-slate-800 hover:border-slate-700'
            }`}
          >
            {soundEnabled ? '🔔 Alert Sounds ON' : '🔕 Mute Alerts'}
          </button>
        </div>
      </div>

      {/* Volatility anomaly banner */}
      {isVolatilityAlert && currentAnalysis && (
        <div className="flex items-start gap-4 rounded-2xl border border-red-500/40 bg-red-950/75 p-5 shadow-lg shadow-red-950/30">
          <AlertTriangle className="text-red-400 shrink-0 mt-0.5" size={24} />
          <div className="space-y-2">
            <h4 className="text-sm font-black text-red-200 uppercase tracking-wider">Dramatic Market Change Detected!</h4>
            <p className="text-xs text-red-300 font-semibold leading-relaxed">
              {volatilityReason}
            </p>
            <div className="rounded-xl bg-red-950/80 border border-red-500/20 p-3.5 text-xs text-red-200 font-bold max-w-xl">
              ⚠️ Significant market changes or high-impact news detected! We highly recommend initiating a fresh AI analysis for better observation and accurate projections.
            </div>
            <button
              onClick={handleRunAnalysis}
              disabled={loading || requestCooldown > 0}
              className="mt-2 inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-red-600 to-red-700 px-4 py-2.5 text-xs font-black text-white hover:from-red-500 hover:to-red-600 transition shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Re-analyzing...
                </>
              ) : (
                <>
                  <RefreshCcw size={14} />
                  Start Re-analysis for Better Observation
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {deviatedProjections.length > 0 && (
        <div className="rounded-2xl border border-red-500/45 bg-red-950/70 p-5 shadow-lg shadow-red-950/30">
          <div className="flex items-start gap-4">
            <AlertTriangle className="mt-0.5 shrink-0 text-red-300" size={24} />
            <div className="flex-1 space-y-3">
              <div>
                <h4 className="text-sm font-black uppercase tracking-wider text-red-100">Background Tracker Deviation Alert</h4>
                <p className="mt-1 text-xs font-semibold leading-relaxed text-red-300">
                  One or more tracked projections moved beyond 1.5x ATR from the projected entry. Re-analyze before using the old projection.
                </p>
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                {deviatedProjections.map((item) => {
                  const deviation = projectionDeviation(item);
                  return (
                    <div key={item.id} className="rounded-xl border border-red-500/30 bg-red-950/70 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-sm font-black text-white">{item.symbol}</span>
                        <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-[10px] font-black text-red-200">{item.tradeMode}</span>
                      </div>
                      <p className="mt-1 text-[11px] font-bold text-red-200">
                        Moved {formatPrice(deviation?.priceDiff, item.symbol)} vs threshold {formatPrice(deviation?.threshold, item.symbol)} from entry {formatPrice(item.entryPrice, item.symbol)}.
                      </p>
                      <button
                        type="button"
                        onClick={() => handleLoadAndAnalyze(item)}
                        disabled={loading}
                        className="mt-3 inline-flex items-center gap-2 rounded-lg bg-red-600 px-3 py-2 text-[11px] font-black text-white transition hover:bg-red-500 disabled:opacity-50"
                      >
                        <RefreshCcw size={13} />
                        Load & Analyze {item.symbol}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Setup Panel */}
      <div className="grid gap-6 md:grid-cols-[360px_1fr]">
        
        {/* Configuration Column */}
        <div className="space-y-6">
          <section className="relative overflow-hidden rounded-3xl border border-slate-800/80 bg-[#0F1524]/90 p-6 shadow-xl backdrop-blur-md">
            <div className="absolute top-0 right-0 h-40 w-40 bg-amber-500/5 rounded-full blur-3xl pointer-events-none"></div>
            
            <div className="mb-2 flex items-center gap-2.5 text-white">
              <Sparkles className="text-amber-500" size={18} />
              <h2 className="text-lg font-black">Analysis Config</h2>
            </div>
            <p className="mb-5 text-xs font-semibold text-slate-500">
              Choose market, mode, and engine first. Then run one click analysis.
            </p>

            {/* Symbol selection */}
            <div className="mb-5">
              <label className="block mb-2 text-xs font-black uppercase tracking-[0.16em] text-slate-400">Select Symbol</label>
              <select
                value={selectedSymbol}
                onChange={(e) => setSelectedSymbol(e.target.value)}
                disabled={loading}
                className="w-full rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3 text-sm font-bold text-white outline-none focus:border-amber-500 cursor-pointer transition"
              >
                {symbols.map((sym) => (
                  <option key={sym} value={sym} className="bg-slate-950">
                    {sym}
                  </option>
                ))}
              </select>
            </div>

            {/* Trade Mode selection */}
            <div className="mb-6">
              <label className="block mb-2 text-xs font-black uppercase tracking-[0.16em] text-slate-400">Trade Mode</label>
              <div className="grid grid-cols-2 gap-2 bg-slate-950 p-1.5 rounded-xl border border-slate-900">
                <button
                  type="button"
                  onClick={() => setTradeMode('FTT')}
                  disabled={loading}
                  className={`rounded-lg py-2.5 text-xs font-black transition ${
                    tradeMode === 'FTT'
                      ? 'bg-amber-500 text-slate-950 shadow-md'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Fixed Time (FTT)
                </button>
                <button
                  type="button"
                  onClick={() => setTradeMode('FOREX')}
                  disabled={loading}
                  className={`rounded-lg py-2.5 text-xs font-black transition ${
                    tradeMode === 'FOREX'
                      ? 'bg-amber-500 text-slate-950 shadow-md'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Forex
                </button>
              </div>
            </div>

            <div className="mb-6">
              <label className="block mb-2 text-xs font-black uppercase tracking-[0.16em] text-slate-400">Signal Engine</label>
              <div className="grid grid-cols-2 gap-2 bg-slate-950 p-1.5 rounded-xl border border-slate-900">
                <button
                  type="button"
                  onClick={() => setAnalysisEngine('ai')}
                  disabled={loading}
                  className={`rounded-lg py-2.5 text-xs font-black transition ${
                    analysisEngine === 'ai'
                      ? 'bg-amber-500 text-slate-950 shadow-md'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <span className="inline-flex items-center justify-center gap-1.5">
                    <Brain size={13} /> AI
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setAnalysisEngine('system')}
                  disabled={loading}
                  className={`rounded-lg py-2.5 text-xs font-black transition ${
                    analysisEngine === 'system'
                      ? 'bg-emerald-500 text-slate-950 shadow-md'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <span className="inline-flex items-center justify-center gap-1.5">
                    <Cpu size={13} /> System
                  </span>
                </button>
              </div>
              <p className="mt-2 text-[11px] font-semibold text-slate-500">
                System mode uses local S/R, volatility, news, candle patterns, trend and movement scoring without Gemini.
              </p>
            </div>

            {/* Trigger Button */}
            <button
              onClick={handleRunAnalysis}
              disabled={loading || requestCooldown > 0}
              className={`w-full rounded-xl py-3.5 text-sm font-black transition shadow-lg relative overflow-hidden group ${
                loading || requestCooldown > 0
                  ? 'bg-slate-900 border border-slate-800 text-slate-500 cursor-not-allowed shadow-none'
                  : 'bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 shadow-amber-500/10'
              }`}
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader2 size={16} className="animate-spin" />
                  Running AI Observer...
                </span>
              ) : requestCooldown > 0 ? (
                <span className="flex items-center justify-center gap-2">
                  <Clock size={16} />
                  Spam Guard: {requestCooldown}s
                </span>
              ) : timerSeconds > 0 ? (
                <span className="flex items-center justify-center gap-2">
                  <Brain size={16} />
                  Refresh 1-Hour Projections
                </span>
              ) : (
                <span className="flex items-center justify-center gap-2">
                  <Brain size={16} />
                  Trigger 1-Hour Projections
                </span>
              )}
            </button>

            {error && (
              <div className="mt-4 rounded-xl border border-red-950 bg-red-950/40 p-3.5 text-xs font-bold text-red-400 border-red-500/35">
                {error}
              </div>
            )}
          </section>

          {/* Active timer snapshot */}
          {currentAnalysis && timerSeconds > 0 && (
            <section className="rounded-3xl border border-slate-800/80 bg-[#0F1524]/90 p-5 shadow-xl text-center relative overflow-hidden">
              <div className="absolute top-0 left-0 h-1 w-full bg-slate-950">
                <div 
                  className="h-full bg-gradient-to-r from-amber-500 to-amber-600 transition-all duration-1000"
                  style={{ width: `${(timerSeconds / 3600) * 100}%` }}
                ></div>
              </div>
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Projection Expiration</p>
              <h2 className="font-mono text-3xl font-black text-amber-500 tracking-tight mt-1">
                {formatTime(timerSeconds)}
              </h2>
              <p className="text-[11px] text-slate-500 font-semibold mt-2">
                Observing {currentAnalysis.symbol} via {currentAnalysis.tradeMode} settings.
              </p>
            </section>
          )}
        </div>

        {/* Results / Analysis Panel */}
        <div>
          {currentAnalysis ? (
            <div className="grid gap-6 xl:grid-cols-[390px_1fr]">
              
              {/* Left Details column */}
              <div className="space-y-6">
                <section className="sticky top-4 rounded-3xl border border-slate-800/80 bg-[#0F1524]/90 p-6 shadow-xl relative overflow-hidden">
                  <div className="mb-4 flex items-center justify-between">
                    <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Decision Outcome</span>
                    <span className="text-xs font-mono text-slate-500">{formatBdDateTime(currentAnalysis.timestamp)}</span>
                  </div>

                  {/* Decision Badge */}
                  <div className={`rounded-2xl border p-4 text-center ${decisionConfig?.badgeClass} flex flex-col items-center justify-center gap-1.5 shadow-md`}>
                    <span className="text-[10px] font-black uppercase tracking-widest opacity-80">AI Stance</span>
                    <div className="flex items-center gap-2">
                      <span className={`inline-block h-2.5 w-2.5 rounded-full ${decisionConfig?.indicatorClass} animate-pulse`}></span>
                      <span className="font-mono text-2xl font-black">{decisionConfig?.label}</span>
                    </div>
                  </div>

                  {/* Score breakdown */}
                  <div className="mt-5 grid grid-cols-2 gap-4">
                    <div className="bg-slate-950/60 border border-slate-900 rounded-2xl p-4 text-center">
                      <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Confidence</p>
                      <h3 className="font-mono text-2xl font-black text-slate-200 mt-1">{currentAnalysis.analysis.confidence}%</h3>
                    </div>
                    <div className="bg-slate-950/60 border border-slate-900 rounded-2xl p-4 text-center">
                      <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Risk Profile</p>
                      <h3 className={`font-mono text-2xl font-black mt-1 ${
                        currentAnalysis.analysis.riskLevel === 'LOW' ? 'text-emerald-400' :
                        currentAnalysis.analysis.riskLevel === 'HIGH' ? 'text-red-400' : 'text-amber-400'
                      }`}>
                        {currentAnalysis.analysis.riskLevel}
                      </h3>
                    </div>
                  </div>

                  {/* Targets & Parameter Info */}
                  <div className="mt-5 space-y-3.5 border-t border-slate-800/60 pt-5 text-sm">
                    <div className="flex justify-between border-b border-slate-900 pb-2.5">
                      <span className="text-slate-400 font-bold">Analysis Price</span>
                      <span className="font-mono font-black text-slate-200">
                        {formatPrice(currentAnalysis.analysis.entryPrice, selectedSymbol)}
                      </span>
                    </div>

                    {currentAnalysis.tradeMode === 'FOREX' ? (
                      <>
                        <div className="flex justify-between border-b border-slate-900 pb-2.5">
                          <span className="text-slate-400 font-bold">Stop Loss (SL)</span>
                          <span className="font-mono font-black text-red-400">
                            {currentAnalysis.analysis.stopLoss ? currentAnalysis.analysis.stopLoss.toFixed(selectedSymbol.toUpperCase().includes('JPY') ? 3 : 5) : 'n/a'}
                          </span>
                        </div>
                        <div className="flex justify-between border-b border-slate-900 pb-2.5">
                          <span className="text-slate-400 font-bold">Take Profit 1</span>
                          <span className="font-mono font-black text-emerald-400">
                            {currentAnalysis.analysis.takeProfit1 ? currentAnalysis.analysis.takeProfit1.toFixed(selectedSymbol.toUpperCase().includes('JPY') ? 3 : 5) : 'n/a'}
                          </span>
                        </div>
                        <div className="flex justify-between border-b border-slate-900 pb-2.5">
                          <span className="text-slate-400 font-bold">Take Profit 2</span>
                          <span className="font-mono font-black text-emerald-400">
                            {currentAnalysis.analysis.takeProfit2 ? currentAnalysis.analysis.takeProfit2.toFixed(selectedSymbol.toUpperCase().includes('JPY') ? 3 : 5) : 'n/a'}
                          </span>
                        </div>
                        <div className="flex justify-between border-b border-slate-900 pb-2.5">
                          <span className="text-slate-400 font-bold">Take Profit 3</span>
                          <span className="font-mono font-black text-emerald-400">
                            {currentAnalysis.analysis.takeProfit3 ? currentAnalysis.analysis.takeProfit3.toFixed(selectedSymbol.toUpperCase().includes('JPY') ? 3 : 5) : 'n/a'}
                          </span>
                        </div>
                      </>
                    ) : (
                      <div className="flex justify-between border-b border-slate-900 pb-2.5">
                        <span className="text-slate-400 font-bold">Recommended Expiry</span>
                        <span className="font-mono font-black text-amber-500">1 Hour</span>
                      </div>
                    )}

                    <div className="flex justify-between border-b border-slate-900 pb-2.5">
                      <span className="text-slate-400 font-bold">Trade Trigger</span>
                      <span className="font-mono font-black text-blue-400">{currentAnalysis.analysis.tradeTrigger}</span>
                    </div>

                    <div className="flex justify-between">
                      <span className="text-slate-400 font-bold">Expected Time</span>
                      <span className="font-mono font-black text-blue-400">{currentAnalysis.analysis.predictedTime}</span>
                    </div>

                    <div className="flex justify-between border-t border-slate-900 pt-2.5">
                      <span className="text-slate-400 font-bold">Trade Timer</span>
                      <span className="font-mono font-black text-amber-400">
                        {currentAnalysis.tradeMode === 'FTT' ? formatDuration(timerSeconds) : `${expirationMinutes}:00`}
                      </span>
                    </div>
                  </div>

                  {/* Invalidation block */}
                  <div className="mt-5 rounded-2xl bg-slate-950/80 p-4 border border-slate-900">
                    <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-1.5">
                      Invalidation Level
                    </span>
                    <p className="text-xs font-semibold text-slate-400 leading-relaxed">
                      {currentAnalysis.analysis.invalidation}
                    </p>
                  </div>

                  <div className="mt-5 rounded-2xl border border-slate-700 bg-slate-900/70 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Background Tracker</p>
                        <p className="mt-1 text-xs font-semibold text-slate-400">
                          AI-free monitoring of the projected setup using live MT5 candles and local indicators.
                        </p>
                      </div>
                      <div className="flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900 px-3 py-1.5 text-[11px] font-black text-slate-400">
                        <Radio size={14} className={activeTrackedProjection ? 'text-emerald-400' : 'text-slate-600'} />
                        {activeTrackedProjection ? 'Tracking active' : 'Not tracking'}
                      </div>
                    </div>

                    <div className="mt-4 flex flex-wrap items-center gap-3">
                      <label className="inline-flex items-center gap-2 text-xs font-bold text-slate-400">
                        <input
                          type="checkbox"
                          checked={Boolean(activeTrackedProjection)}
                          onChange={handleToggleTracking}
                          disabled={!actionableAnalysis || trackerLoading}
                          className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-amber-500 focus:ring-amber-500"
                        />
                        Enable Background Alerts
                      </label>

                      <label className="flex items-center gap-2 text-xs font-bold text-slate-400">
                        Expires in
                        <select
                          value={expirationMinutes}
                          onChange={(e) => setExpirationMinutes(Number(e.target.value))}
                          disabled={Boolean(activeTrackedProjection)}
                          className="rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-1.5 text-xs font-bold text-white outline-none"
                        >
                          <option value={30}>30m</option>
                          <option value={60}>1h</option>
                          <option value={120}>2h</option>
                          <option value={240}>4h</option>
                          <option value={480}>8h</option>
                        </select>
                      </label>
                    </div>

                    {trackerError && (
                      <div className="mt-3 rounded-xl border border-red-500/30 bg-red-950/40 px-3 py-2 text-xs font-bold text-red-300">
                        {trackerError}
                      </div>
                    )}

                    {trackerDisabledReason && (
                      <div className="mt-3 rounded-xl border border-slate-700 bg-slate-900/70 px-3 py-2 text-xs font-bold text-slate-400">
                        {trackerDisabledReason}
                      </div>
                    )}

                    {trackerLoading && (
                      <div className="mt-3 flex items-center gap-2 text-xs font-bold text-slate-500">
                        <Loader2 size={14} className="animate-spin" />
                        Updating tracker...
                      </div>
                    )}
                  </div>
                </section>
              </div>

              {/* Markdown Observer Report display */}
              <section className="rounded-3xl border border-slate-800/80 bg-[#0F1524]/90 p-6 shadow-xl relative overflow-hidden">
                <div className="mb-5 flex items-center justify-between border-b border-slate-800 pb-4">
                  <div className="flex items-center gap-2">
                    <BarChart3 className="text-amber-500" size={20} />
                    <h2 className="text-xl font-black">Clinical Market Observation Report</h2>
                  </div>
                  <span className="text-xs font-bold text-slate-500 uppercase">Readable report</span>
                </div>

                <div 
                  className="prose prose-invert max-w-none prose-sm max-h-[680px] overflow-y-auto pr-1"
                  dangerouslySetInnerHTML={{ __html: parseMarkdownToHtml(currentAnalysis.analysis.clinicalReport) }}
                ></div>
              </section>

            </div>
          ) : (
            <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed border-slate-800/80 bg-[#0F1524]/40 p-12 text-center h-[520px]">
              <Brain size={64} className="text-slate-700/80 mb-4 animate-bounce" />
              <h3 className="text-xl font-bold text-slate-300">No Active Projections</h3>
              <p className="text-sm font-semibold text-slate-500 mt-2 max-w-md">
                Select an instrument and click &quot;Trigger 1-Hour Projections&quot; to fetch the latest AI-calculated market observation report and parameters.
              </p>
            </div>
          )}
        </div>

      </div>

      <section className="rounded-3xl border border-slate-800/80 bg-[#0F1524]/90 p-6 shadow-xl">
        <div className="mb-5 flex flex-col gap-3 border-b border-slate-800 pb-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-2">
            <BellRing className="text-amber-500" size={20} />
            <div>
              <h2 className="text-xl font-black">Live Tracked Projections</h2>
              <p className="text-xs font-bold text-slate-500">AI-free background checks against live MT5 telemetry.</p>
            </div>
          </div>
          <span className="rounded-full border border-slate-700 bg-slate-900/80 px-3 py-1.5 text-xs font-black text-slate-300">
            {trackedAiProjections.length} monitored setup{trackedAiProjections.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 text-xs font-bold text-slate-500">
          <p>Tracked entries can also email the configured notification address when they trigger.</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refresh()}
              className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-950 px-3 py-1.5 text-slate-400 transition hover:border-amber-500/40 hover:text-amber-300"
            >
              <RefreshCcw size={13} />
              Refresh
            </button>
            <div className="inline-flex rounded-full border border-slate-800 bg-slate-950 p-1">
              <button
                type="button"
                onClick={() => setTrackedView('all')}
                className={`rounded-full px-3 py-1.5 transition ${trackedView === 'all' ? 'bg-amber-500 text-slate-950' : 'text-slate-500 hover:text-slate-300'}`}
              >
                All
              </button>
              <button
                type="button"
                onClick={() => setTrackedView('triggered')}
                className={`rounded-full px-3 py-1.5 transition ${trackedView === 'triggered' ? 'bg-emerald-500 text-slate-950' : 'text-slate-500 hover:text-slate-300'}`}
              >
                Triggered
              </button>
            </div>
          </div>
        </div>

        {visibleTrackedProjections.length ? (
          <div className="grid gap-3 xl:grid-cols-2">
            {visibleTrackedProjections.map((item) => (
              <div
                key={item.id}
                className={`rounded-2xl p-4 ${isProjectionDeviated(item)
                  ? 'border border-red-500/50 bg-red-950/20 shadow-lg shadow-red-950/20'
                  : 'border border-slate-700 bg-slate-900/60'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-lg font-black text-white">{item.symbol}</span>
                      <span className="rounded-full border border-slate-700 bg-slate-900 px-2 py-0.5 text-[10px] font-black text-slate-400">{item.tradeMode}</span>
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] font-black ${trackerStatusClass(item.status)}`}>
                        {item.status === 'PENDING' ? 'MONITORING' : item.status}
                      </span>
                    </div>
                    <p className="mt-1 text-xs font-bold text-slate-500">
                      {item.decision.replace('_', ' ')} · {item.tradeTrigger.replace(/_/g, ' ')} · confidence {Math.round(item.confidence)}%
                    </p>
                    {isProjectionDeviated(item) && (
                      <div className="mt-2 inline-flex items-center gap-2 rounded-full border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-red-200 animate-pulse">
                        ⚠️ Critical Price Deviation Detected (Moved &gt; 1.5 * ATR)
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => deleteTrackedAiProjection(item.id).catch((e) => setTrackerError(e.message || 'Failed to delete tracker.'))}
                    className="rounded-xl border border-slate-800 bg-slate-900/80 p-2 text-slate-500 transition hover:border-red-500/40 hover:text-red-300"
                    title="Cancel tracking"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-3 text-center sm:grid-cols-3">
                  <div className="rounded-xl border border-slate-900 bg-slate-900/60 p-3">
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Entry</p>
                    <p className="mt-1 font-mono text-sm font-black text-amber-400">{formatPrice(item.entryPrice, item.symbol)}</p>
                  </div>
                  <div className="rounded-xl border border-slate-900 bg-slate-900/60 p-3">
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Current</p>
                    <p className="mt-1 font-mono text-sm font-black text-slate-200">{formatPrice(item.currentPrice, item.symbol)}</p>
                  </div>
                  <div className="rounded-xl border border-slate-900 bg-slate-900/60 p-3">
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Distance</p>
                    <p className="mt-1 text-xs font-black text-blue-300">{distanceToEntry(item)}</p>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] font-bold text-slate-500">
                  <span>Last check: {item.lastCheckedAt ? formatBdDateTime(item.lastCheckedAt) : 'waiting'}</span>
                  <span>Time left: {remainingTime(item.expiresAt)}</span>
                </div>

                {item.evaluation?.reason && (
                  <div className="mt-3 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs font-semibold text-slate-400">
                    {item.evaluation.reason}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-950/50 p-8 text-center">
            <Radio size={32} className="mx-auto text-slate-700" />
            <p className="mt-3 text-sm font-bold text-slate-400">{trackedView === 'triggered' ? 'No triggered tracked projections yet.' : 'No tracked projections yet.'}</p>
            <p className="mt-1 text-xs font-semibold text-slate-600">Run an AI observation, then enable background alerts on a BUY/SELL/HOLD setup.</p>
          </div>
        )}
      </section>

    </div>
  );
}
