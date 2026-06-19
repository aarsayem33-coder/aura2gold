import React, { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
  LineStyle,
} from 'lightweight-charts';
import { Maximize2, Minimize2, Crosshair } from 'lucide-react';
import type { Alert, Mt5Candle } from '../types';

/** Optional trade levels drawn as horizontal price lines on the chart. */
export interface TradeLevels {
  direction?: string | null;
  entry?: number | null;
  stopLoss?: number | null;
  takeProfit1?: number | null;
  takeProfit2?: number | null;
  takeProfit3?: number | null;
}

interface Mt5CandlestickChartProps {
  candles: Mt5Candle[];
  signals: Alert[];
  symbol: string;
  timeframe: string;
  /** When provided, Entry / SL / TP horizontal lines are rendered. */
  levels?: TradeLevels | null;
}

type ChartCandle = { time: any; open: number; high: number; low: number; close: number; volume: number };
type ChartMarker = { time: any; position: string; color: string; shape: string; text: string };

function toChartTime(value: string) {
  const parsed = new Date(value).getTime();
  if (Number.isNaN(parsed)) return Math.floor(Date.now() / 1000);
  return Math.floor(parsed / 1000);
}

/** Seconds per timeframe bucket (M5 -> 300). 0 = unknown (no bucketing). */
function timeframeSeconds(tf: string): number {
  const m = /^([MHDW])(\d+)?$/.exec((tf || '').toUpperCase());
  if (!m) return 0;
  const unit = m[1];
  const n = Number(m[2] || 1);
  if (unit === 'M') return n * 60;
  if (unit === 'H') return n * 3600;
  if (unit === 'D') return 86400;
  if (unit === 'W') return 604800;
  return 0;
}

/** Build a synthetic live-forming bar for the current period when the feed only
 * delivers closed bars (no intra-bar ticks). Flat at the last close until the next
 * real bar arrives — so the current candle slot exists and the time axis advances,
 * making the chart visibly "live" without inventing price movement. Returns null
 * when real data already covers the current period (or the timeframe is unknown). */
function formingBarFor(lastClosed: { time: number; close: number } | null, tfSec: number, nowMs = Date.now()) {
  if (!lastClosed || tfSec <= 0 || !Number.isFinite(lastClosed.close)) return null;
  const open = Math.floor(Math.floor(nowMs / 1000) / tfSec) * tfSec;
  if (lastClosed.time >= open) return null; // a real bar already occupies the current period
  return { time: open, open: lastClosed.close, high: lastClosed.close, low: lastClosed.close, close: lastClosed.close, volume: 0 };
}

/** Whole seconds remaining until the current timeframe bar closes (for the countdown). */
function secsToNextBar(tfSec: number, nowMs = Date.now()) {
  if (tfSec <= 0) return null;
  const nowSec = Math.floor(nowMs / 1000);
  return tfSec - (nowSec % tfSec);
}

/** Robust price precision: gold=2, JPY pairs=3, otherwise infer from magnitude. */
function priceDigits(symbol: string, sample?: number | null) {
  const s = (symbol || '').toUpperCase();
  if (s.includes('XAU') || s.includes('GOLD') || s.includes('XAG')) return 2;
  if (s.includes('JPY')) return 3;
  if (sample != null && Number.isFinite(sample)) {
    if (sample >= 1000) return 2;
    if (sample >= 50) return 3;
  }
  return 5;
}

function nearestCandleTime(signalTime: number, candleTimes: number[]) {
  if (!candleTimes.length) return signalTime;
  return candleTimes.reduce(
    (nearest, current) => (Math.abs(current - signalTime) < Math.abs(nearest - signalTime) ? current : nearest),
    candleTimes[0],
  );
}

function calculateEMAValues(data: { close: number }[], period: number): (number | null)[] {
  const ema: (number | null)[] = [];
  if (data.length === 0) return ema;
  const k = 2 / (period + 1);
  let prevEma = data[0].close;
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      ema.push(null);
    } else if (i === period - 1) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += data[i - j].close;
      const initialSma = sum / period;
      ema.push(initialSma);
      prevEma = initialSma;
    } else {
      const currentEma = (data[i].close - prevEma) * k + prevEma;
      ema.push(currentEma);
      prevEma = currentEma;
    }
  }
  return ema;
}

/**
 * Lightweight candlestick pattern detector. Scans only the most recent bars to keep
 * the chart readable. Returns markers in ascending time order.
 */
function detectCandlePatterns(data: ChartCandle[], lookback = 160): ChartMarker[] {
  const out: ChartMarker[] = [];
  const PATTERN = '#7c3aed'; // violet to distinguish from green/red signal arrows
  const start = Math.max(1, data.length - lookback);
  for (let i = start; i < data.length; i++) {
    const c = data[i];
    const p = data[i - 1];
    const range = c.high - c.low;
    if (range <= 0) continue;
    const body = Math.abs(c.close - c.open);
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const bodyRatio = body / range;
    const curBull = c.close > c.open;
    const curBear = c.close < c.open;
    const prevBull = p.close > p.open;
    const prevBear = p.close < p.open;
    const prevBody = Math.abs(p.close - p.open);

    // Engulfing (two-candle) — strongest reversal signal, check first.
    if (curBull && prevBear && c.close >= p.open && c.open <= p.close && body > prevBody) {
      out.push({ time: c.time, position: 'belowBar', color: '#089981', shape: 'arrowUp', text: 'Bull Engulf' });
      continue;
    }
    if (curBear && prevBull && c.open >= p.close && c.close <= p.open && body > prevBody) {
      out.push({ time: c.time, position: 'aboveBar', color: '#f23645', shape: 'arrowDown', text: 'Bear Engulf' });
      continue;
    }
    // Doji — indecision.
    if (bodyRatio <= 0.1) {
      out.push({ time: c.time, position: 'aboveBar', color: PATTERN, shape: 'circle', text: 'Doji' });
      continue;
    }
    // Hammer — small body up top, long lower wick (bullish).
    if (bodyRatio <= 0.35 && lowerWick >= body * 2 && upperWick <= body) {
      out.push({ time: c.time, position: 'belowBar', color: PATTERN, shape: 'circle', text: 'Hammer' });
      continue;
    }
    // Shooting star — small body down low, long upper wick (bearish).
    if (bodyRatio <= 0.35 && upperWick >= body * 2 && lowerWick <= body) {
      out.push({ time: c.time, position: 'aboveBar', color: PATTERN, shape: 'circle', text: 'Star' });
      continue;
    }
  }
  return out;
}

export default function Mt5CandlestickChart({ candles, signals, symbol, timeframe, levels }: Mt5CandlestickChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const legendRef = useRef<HTMLDivElement | null>(null);

  const [showVolume, setShowVolume] = useState(true);
  const [showEma9, setShowEma9] = useState(false);
  const [showEma21, setShowEma21] = useState(false);
  const [showEma50, setShowEma50] = useState(false);
  const [showEma200, setShowEma200] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [showPatterns, setShowPatterns] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const chartRef = useRef<any>(null);
  const seriesRef = useRef<any>(null);
  const volumeSeriesRef = useRef<any>(null);
  const ema9SeriesRef = useRef<any>(null);
  const ema21SeriesRef = useRef<any>(null);
  const ema50SeriesRef = useRef<any>(null);
  const ema200SeriesRef = useRef<any>(null);
  const markersApiRef = useRef<any>(null);
  const priceLinesRef = useRef<any[]>([]);
  const lastLenRef = useRef(0);
  // Latest CLOSED bar (time in seconds + close), used to synthesize the live-forming bar.
  const lastClosedRef = useRef<{ time: number; close: number } | null>(null);
  const countdownRef = useRef<HTMLDivElement | null>(null);

  const candlesRef = useRef<Mt5Candle[]>([]);
  candlesRef.current = candles;

  // ─── Effect A: create the chart ONCE per symbol/timeframe ───────────────
  // Toggles (grid/volume/EMA/patterns) are intentionally NOT in the deps so that
  // toggling an overlay never tears the chart down — preserving the user's zoom/pan.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    lastLenRef.current = 0;

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#64748b',
        fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      },
      grid: {
        vertLines: { color: '#f1f5f9', style: LineStyle.Dashed, visible: true },
        horzLines: { color: '#f1f5f9', style: LineStyle.Dashed, visible: true },
      },
      rightPriceScale: {
        borderColor: '#e2e8f0',
        scaleMargins: { top: 0.12, bottom: 0.22 },
      },
      timeScale: { borderColor: '#e2e8f0', timeVisible: true, secondsVisible: false },
      crosshair: {
        vertLine: { color: '#cbd5e1', width: 1, style: LineStyle.Dashed },
        horzLine: { color: '#cbd5e1', width: 1, style: LineStyle.Dashed },
      },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#089981',
      downColor: '#f23645',
      borderUpColor: '#089981',
      borderDownColor: '#f23645',
      wickUpColor: '#089981',
      wickDownColor: '#f23645',
      priceLineVisible: false,
    });

    chartRef.current = chart;
    seriesRef.current = series;
    // Reset overlay/marker/line refs — they belong to the previous chart instance.
    volumeSeriesRef.current = null;
    ema9SeriesRef.current = null;
    ema21SeriesRef.current = null;
    ema50SeriesRef.current = null;
    ema200SeriesRef.current = null;
    markersApiRef.current = null;
    priceLinesRef.current = [];

    const renderLegend = (candle: any) => {
      const legendEl = legendRef.current;
      if (!legendEl) return;
      if (!candle) {
        legendEl.innerHTML = `<span class="text-[10px] text-slate-400 font-bold">${symbol} · ${timeframe}</span>`;
        return;
      }
      const digits = priceDigits(symbol, candle.close);
      const o = candle.open?.toFixed(digits) ?? 'n/a';
      const h = candle.high?.toFixed(digits) ?? 'n/a';
      const l = candle.low?.toFixed(digits) ?? 'n/a';
      const c = candle.close?.toFixed(digits) ?? 'n/a';
      const v = candle.volume?.toLocaleString?.() ?? '0';
      const isUp = candle.close >= candle.open;
      const cc = isUp ? 'text-emerald-500 font-black' : 'text-red-500 font-black';
      legendEl.innerHTML = `
        <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] font-bold text-slate-500">
          <span class="text-slate-800 text-[11px] font-black tracking-tight mr-1">${symbol}</span>
          <span class="bg-slate-100 text-slate-600 px-1 py-0.2 rounded text-[9px] font-bold mr-2">${timeframe}</span>
          <span>O<span class="${cc} ml-0.5">${o}</span></span>
          <span>H<span class="${cc} ml-0.5">${h}</span></span>
          <span>L<span class="${cc} ml-0.5">${l}</span></span>
          <span>C<span class="${cc} ml-0.5">${c}</span></span>
          <span>V<span class="text-slate-700 ml-0.5">${v}</span></span>
        </div>`;
    };

    renderLegend(candlesRef.current[candlesRef.current.length - 1]);

    chart.subscribeCrosshairMove((param: any) => {
      let candleData: any = null;
      if (param.time && param.seriesData.has(series)) {
        candleData = param.seriesData.get(series);
      } else {
        candleData = candlesRef.current[candlesRef.current.length - 1];
      }
      renderLegend(candleData);
    });

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volumeSeriesRef.current = null;
      ema9SeriesRef.current = null;
      ema21SeriesRef.current = null;
      ema50SeriesRef.current = null;
      ema200SeriesRef.current = null;
      markersApiRef.current = null;
      priceLinesRef.current = [];
    };
  }, [symbol, timeframe]);

  // ─── Effect B: grid visibility (no teardown) ────────────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.applyOptions({
      grid: {
        vertLines: { color: '#f1f5f9', style: LineStyle.Dashed, visible: showGrid },
        horzLines: { color: '#f1f5f9', style: LineStyle.Dashed, visible: showGrid },
      },
    });
  }, [showGrid]);

  // ─── Effect C: data + overlays + markers + price lines ──────────────────
  // Adds/removes series on the persistent chart instead of recreating it.
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series || candles.length === 0) return;

    // Bucket each candle to its timeframe bar-open time. The feed can deliver many
    // one-second snapshots of the SAME forming bar (different sub-minute timestamps);
    // without bucketing those render as dozens of 1-second-apart bars. We aggregate
    // them into one real bar: open from the earliest snapshot, close from the latest,
    // high/low across all, so the candle series is correct.
    const tfSec = timeframeSeconds(timeframe);
    const byBar = new Map<number, { firstSec: number; lastSec: number; candle: ChartCandle }>();
    for (const candle of candles) {
      if (candle.open === null || candle.high === null || candle.low === null || candle.close === null) continue;
      const ms = new Date(candle.time).getTime();
      if (Number.isNaN(ms)) continue;
      const sec = Math.floor(ms / 1000);
      const barTime = tfSec > 0 ? Math.floor(sec / tfSec) * tfSec : sec;
      const o = candle.open as number;
      const h = candle.high as number;
      const l = candle.low as number;
      const c = candle.close as number;
      const v = (candle.volume as number) || 0;
      const prev = byBar.get(barTime);
      if (!prev) {
        byBar.set(barTime, { firstSec: sec, lastSec: sec, candle: { time: barTime, open: o, high: h, low: l, close: c, volume: v } });
        continue;
      }
      const cd = prev.candle;
      cd.high = Math.max(cd.high, h);
      cd.low = Math.min(cd.low, l);
      cd.volume = Math.max(cd.volume, v);
      if (sec <= prev.firstSec) {
        cd.open = o;
        prev.firstSec = sec;
      }
      if (sec >= prev.lastSec) {
        cd.close = c;
        prev.lastSec = sec;
      }
    }
    const data = [...byBar.values()].map((x) => x.candle).sort((a, b) => Number(a.time) - Number(b.time));
    if (data.length === 0) return;

    // Record the latest closed bar so the 1-second live effect can keep a forming
    // bar pinned to the current period (the feed only sends closed bars).
    const lastBar = data[data.length - 1];
    lastClosedRef.current = { time: Number(lastBar.time), close: Number(lastBar.close) };

    // Render the closed bars plus a synthetic forming bar for the current period
    // (only the candlestick series gets the forming bar; overlays/markers stay on
    // closed data so EMAs/volume aren't skewed by the flat placeholder).
    const forming = formingBarFor(lastClosedRef.current, tfSec);
    series.setData(forming ? [...data, forming] : data);

    // Volume — create/remove on demand.
    if (showVolume) {
      if (!volumeSeriesRef.current) {
        volumeSeriesRef.current = chart.addSeries(HistogramSeries, {
          color: '#26a69a',
          priceFormat: { type: 'volume' },
          priceScaleId: '',
        });
        volumeSeriesRef.current.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
      }
      volumeSeriesRef.current.setData(
        data.map((d) => ({
          time: d.time,
          value: d.volume || 0,
          color: d.close >= d.open ? 'rgba(8, 153, 129, 0.22)' : 'rgba(242, 54, 69, 0.22)',
        })),
      );
    } else if (volumeSeriesRef.current) {
      chart.removeSeries(volumeSeriesRef.current);
      volumeSeriesRef.current = null;
    }

    // EMA overlays — helper handles create/remove + data.
    const applyEma = (ref: React.MutableRefObject<any>, show: boolean, period: number, color: string, title: string) => {
      if (show) {
        if (!ref.current) ref.current = chart.addSeries(LineSeries, { color, lineWidth: 2, title });
        const values = calculateEMAValues(data, period);
        ref.current.setData(
          data
            .map((d, idx) => (values[idx] !== null ? { time: d.time, value: values[idx] as number } : null))
            .filter((x): x is { time: any; value: number } => x !== null),
        );
      } else if (ref.current) {
        chart.removeSeries(ref.current);
        ref.current = null;
      }
    };
    applyEma(ema9SeriesRef, showEma9, 9, '#3b82f6', 'EMA 9');
    applyEma(ema21SeriesRef, showEma21, 21, '#8b5cf6', 'EMA 21');
    applyEma(ema50SeriesRef, showEma50, 50, '#f97316', 'EMA 50');
    applyEma(ema200SeriesRef, showEma200, 200, '#eab308', 'EMA 200');

    // Markers: signals + (optional) candlestick patterns, merged & time-sorted.
    const candleTimes = data.map((d) => Number(d.time));
    const signalMarkers: ChartMarker[] = signals
      .filter((s) => s.symbol === symbol && s.timeframe === timeframe)
      .slice(0, 50)
      .map((s) => {
        const isDown = s.direction === 'down';
        return {
          time: nearestCandleTime(toChartTime(s.receivedAt || s.timestamp), candleTimes),
          position: isDown ? 'aboveBar' : 'belowBar',
          color: isDown ? '#f23645' : '#089981',
          shape: isDown ? 'arrowDown' : 'arrowUp',
          text: s.type,
        };
      });
    const patternMarkers = showPatterns ? detectCandlePatterns(data) : [];
    const allMarkers = [...signalMarkers, ...patternMarkers].sort((a, b) => Number(a.time) - Number(b.time));
    if (!markersApiRef.current) markersApiRef.current = createSeriesMarkers(series, []);
    markersApiRef.current.setMarkers(allMarkers as any);

    // Trade level lines (Entry / SL / TP1-3) + a live price line.
    for (const line of priceLinesRef.current) {
      try {
        series.removePriceLine(line);
      } catch {
        /* chart may have been removed */
      }
    }
    priceLinesRef.current = [];

    const latestPrice = data[data.length - 1]?.close;
    const digits = priceDigits(symbol, latestPrice);
    const addLine = (price: number | null | undefined, color: string, title: string, style = LineStyle.Solid) => {
      if (price === null || price === undefined || !Number.isFinite(price)) return;
      const line = series.createPriceLine({
        price,
        color,
        lineWidth: 1.5,
        lineStyle: style,
        axisLabelVisible: true,
        title,
      });
      priceLinesRef.current.push(line);
    };

    if (levels && levels.direction && levels.direction !== 'HOLD') {
      addLine(levels.entry, '#2563eb', `ENTRY ${levels.entry?.toFixed(digits) ?? ''}`);
      addLine(levels.stopLoss, '#f23645', `SL ${levels.stopLoss?.toFixed(digits) ?? ''}`);
      addLine(levels.takeProfit1, '#089981', `TP1 ${levels.takeProfit1?.toFixed(digits) ?? ''}`, LineStyle.Dashed);
      addLine(levels.takeProfit2, '#10b981', `TP2 ${levels.takeProfit2?.toFixed(digits) ?? ''}`, LineStyle.Dashed);
      addLine(levels.takeProfit3, '#34d399', `TP3 ${levels.takeProfit3?.toFixed(digits) ?? ''}`, LineStyle.Dashed);
    } else if (latestPrice !== undefined && latestPrice !== null) {
      addLine(latestPrice, '#ca8a04', `LIVE ${latestPrice.toFixed(digits)}`, LineStyle.Dashed);
    }

    // Re-anchor to the most recent ~150 bars whenever the dataset SIZE changes
    // (initial render, REST backfill, or a freshly-closed bar). Toggling overlays
    // does not change the length, so Grid/Vol/EMA/Patterns preserve the user's zoom.
    if (data.length !== lastLenRef.current) {
      lastLenRef.current = data.length;
      const visibleBars = Math.min(data.length, 150);
      try {
        chart.timeScale().setVisibleLogicalRange({
          from: Math.max(0, data.length - visibleBars),
          to: data.length + 1,
        });
      } catch {
        chart.timeScale().fitContent();
      }
    }
  }, [candles, signals, symbol, timeframe, showVolume, showEma9, showEma21, showEma50, showEma200, showPatterns, levels]);

  // ─── Effect D: live forming bar + countdown (1s) ────────────────────────
  // The feed sends closed bars only, so without this the chart sits frozen between
  // bar closes. Each second we keep a flat forming bar pinned to the current period
  // (via series.update — cheap, no full re-render) and tick a "next bar in m:ss"
  // countdown, so the chart is visibly live. No invented price movement; the bar
  // updates for real the moment a new closed bar arrives (Effect C).
  useEffect(() => {
    const tfSec = timeframeSeconds(timeframe);
    const tick = () => {
      const el = countdownRef.current;
      if (el) {
        const secs = secsToNextBar(tfSec);
        if (secs === null) {
          el.textContent = '';
        } else {
          const m = Math.floor(secs / 60);
          const s = secs % 60;
          el.textContent = `● LIVE · next ${timeframe} in ${m}:${String(s).padStart(2, '0')}`;
        }
      }
      const series = seriesRef.current;
      if (!series) return;
      const forming = formingBarFor(lastClosedRef.current, tfSec);
      if (forming) {
        try {
          series.update(forming);
        } catch {
          /* chart may be mid-teardown */
        }
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [symbol, timeframe]);

  // Keep the chart sized correctly when toggling fullscreen.
  useEffect(() => {
    const id = window.setTimeout(() => {
      try {
        chartRef.current?.timeScale().fitContent();
      } catch {
        /* noop */
      }
    }, 60);
    return () => window.clearTimeout(id);
  }, [isFullscreen]);

  // Close fullscreen on Escape.
  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isFullscreen]);

  if (!candles.length) {
    return (
      <div className="flex h-[440px] items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50/60 text-center">
        <div>
          <p className="font-bold text-slate-600">Waiting for MT5 candle data</p>
          <p className="mt-1 text-sm text-slate-400">Post candles to /api/mt5/candles or /api/mt5/snapshot.</p>
        </div>
      </div>
    );
  }

  const toggleBtn = (active: boolean, label: string, onClick: () => void, activeClass = 'bg-amber-50 text-amber-700 border-amber-200') => (
    <button
      onClick={onClick}
      className={`rounded-lg border px-2 py-1 text-[9px] font-black transition-all ${
        active ? activeClass : 'border-transparent bg-slate-50 text-slate-500 hover:bg-slate-100'
      }`}
      title={label}
    >
      {label}
    </button>
  );

  const wrapperClass = isFullscreen
    ? 'fixed inset-0 z-[60] bg-white p-3'
    : 'relative h-[clamp(420px,52vh,640px)] w-full overflow-hidden rounded-2xl border border-slate-100 bg-white';

  return (
    <div className={wrapperClass}>
      <div className="relative h-full w-full overflow-hidden rounded-2xl">
        {/* Hover legend */}
        <div
          ref={legendRef}
          className="pointer-events-none absolute left-3 top-3 z-10 rounded-lg border border-slate-100/50 bg-white/75 px-2.5 py-1.5 shadow-sm backdrop-blur-[3px]"
        />

        {/* Live countdown to next bar close */}
        <div
          ref={countdownRef}
          className="pointer-events-none absolute bottom-12 left-3 z-10 rounded-md border border-emerald-200/60 bg-white/80 px-2 py-0.5 font-mono text-[10px] font-bold text-emerald-600 shadow-sm backdrop-blur-[3px]"
        />

        {/* Floating toolbar */}
        <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-xl border border-slate-200/60 bg-white/80 p-1 shadow-sm backdrop-blur-md">
          {toggleBtn(showGrid, 'Grid', () => setShowGrid((v) => !v))}
          {toggleBtn(showVolume, 'Vol', () => setShowVolume((v) => !v))}
          {toggleBtn(showEma9, 'EMA 9', () => setShowEma9((v) => !v), 'bg-blue-50 text-blue-700 border-blue-200')}
          {toggleBtn(showEma21, 'EMA 21', () => setShowEma21((v) => !v), 'bg-purple-50 text-purple-700 border-purple-200')}
          {toggleBtn(showEma50, 'EMA 50', () => setShowEma50((v) => !v), 'bg-orange-50 text-orange-700 border-orange-200')}
          {toggleBtn(showEma200, 'EMA 200', () => setShowEma200((v) => !v), 'bg-amber-100 text-amber-800 border-amber-200')}
          {toggleBtn(showPatterns, 'Patterns', () => setShowPatterns((v) => !v), 'bg-violet-50 text-violet-700 border-violet-200')}
          <span className="mx-0.5 h-4 w-px bg-slate-200" />
          <button
            onClick={() => {
              try {
                chartRef.current?.timeScale().fitContent();
              } catch {
                /* noop */
              }
            }}
            className="rounded-lg border border-transparent bg-slate-50 px-1.5 py-1 text-slate-500 transition-all hover:bg-slate-100"
            title="Fit / reset zoom"
          >
            <Crosshair size={12} />
          </button>
          <button
            onClick={() => setIsFullscreen((v) => !v)}
            className="rounded-lg border border-transparent bg-slate-50 px-1.5 py-1 text-slate-500 transition-all hover:bg-slate-100"
            title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
          >
            {isFullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
        </div>

        {/* Chart canvas */}
        <div ref={containerRef} className="absolute inset-0" />
      </div>
    </div>
  );
}
