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
  /** In-chart symbol/timeframe switchers. The parent stays the data owner — these are
   *  just controlled callbacks. Switchers render only when the matching callback is given. */
  symbolOptions?: string[];
  timeframeOptions?: string[];
  onSymbolChange?: (symbol: string) => void;
  onTimeframeChange?: (timeframe: string) => void;
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

// ─────────────────────────────────────────────────────────────────────────────
// Market-structure analytics (all client-side, computed from the candle array — the
// same pattern as EMA/patterns above). Each is exposed as an optional chart overlay.
// ─────────────────────────────────────────────────────────────────────────────

type Pivot = { idx: number; time: any; price: number; kind: 'H' | 'L' };

/** Fractal swing pivots: a high is a pivot when it's the strict max over ±span bars
 *  (lows symmetric). Larger span = fewer, more significant swings. */
function detectPivots(data: ChartCandle[], span = 3): Pivot[] {
  const out: Pivot[] = [];
  for (let i = span; i < data.length - span; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - span; j <= i + span; j++) {
      if (j === i) continue;
      if (data[j].high >= data[i].high) isHigh = false;
      if (data[j].low <= data[i].low) isLow = false;
    }
    if (isHigh) out.push({ idx: i, time: data[i].time, price: data[i].high, kind: 'H' });
    if (isLow) out.push({ idx: i, time: data[i].time, price: data[i].low, kind: 'L' });
  }
  return out.sort((a, b) => a.idx - b.idx);
}

type ZigZagPoint = Pivot & { label: 'HH' | 'HL' | 'LH' | 'LL' };

/** ZigZag: alternating swing sequence (collapse consecutive same-type pivots to the
 *  most extreme one), each labelled HH / HL (bullish) or LH / LL (bearish) vs the
 *  previous same-type pivot. This is the higher-high / higher-low structure read. */
function computeZigZag(pivots: Pivot[]): ZigZagPoint[] {
  const seq: Pivot[] = [];
  for (const p of pivots) {
    const last = seq[seq.length - 1];
    if (!last) { seq.push(p); continue; }
    if (last.kind === p.kind) {
      const moreExtreme = p.kind === 'H' ? p.price > last.price : p.price < last.price;
      if (moreExtreme) seq[seq.length - 1] = p;
    } else {
      seq.push(p);
    }
  }
  return seq.map((p, i) => {
    let label: ZigZagPoint['label'] = p.kind === 'H' ? 'HH' : 'LL';
    for (let k = i - 1; k >= 0; k--) {
      if (seq[k].kind !== p.kind) continue;
      if (p.kind === 'H') label = p.price > seq[k].price ? 'HH' : 'LH';
      else label = p.price < seq[k].price ? 'LL' : 'HL';
      break;
    }
    return { ...p, label };
  });
}

/** Read trend bias from the last few zigzag points: HH+HL = up, LH+LL = down. */
function structureBias(zz: ZigZagPoint[]): 'UP' | 'DOWN' | 'RANGE' {
  const recent = zz.slice(-4).map((p) => p.label);
  const bull = recent.filter((l) => l === 'HH' || l === 'HL').length;
  const bear = recent.filter((l) => l === 'LH' || l === 'LL').length;
  if (bull >= bear + 2) return 'UP';
  if (bear >= bull + 2) return 'DOWN';
  return 'RANGE';
}

interface RegressionChannel {
  slope: number;
  mid: { time: any; value: number }[];
  upper: { time: any; value: number }[];
  lower: { time: any; value: number }[];
  endValue: number;
  projValue: number;     // regression extended `projBars` into the future
  projBars: number;
  changePct: number;     // % change across the window (slope strength)
  trending: boolean;
}

/** Least-squares regression channel over the last `lookback` closes, with ±2σ bands
 *  and a forward projection of the line (deterministic "where the trend points"). */
function regressionChannel(data: ChartCandle[], lookback = 120, projBars = 12): RegressionChannel | null {
  const n = Math.min(lookback, data.length);
  if (n < 12) return null;
  const slice = data.slice(data.length - n);
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  slice.forEach((d, i) => { sx += i; sy += d.close; sxx += i * i; sxy += i * d.close; });
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  let ss = 0;
  slice.forEach((d, i) => { const yhat = intercept + slope * i; ss += (d.close - yhat) ** 2; });
  const std = Math.sqrt(ss / n) || 0;
  const at = (i: number) => intercept + slope * i;
  const mid = slice.map((d, i) => ({ time: d.time, value: at(i) }));
  const upper = slice.map((d, i) => ({ time: d.time, value: at(i) + 2 * std }));
  const lower = slice.map((d, i) => ({ time: d.time, value: at(i) - 2 * std }));
  const startValue = at(0);
  const endValue = at(n - 1);
  const projValue = at(n - 1 + projBars);
  const changePct = startValue !== 0 ? ((endValue - startValue) / startValue) * 100 : 0;
  // Trending when the regression's total rise/fall exceeds the noise band (±2σ).
  const trending = Math.abs(endValue - startValue) > 2 * std;
  return { slope, mid, upper, lower, endValue, projValue, projBars, changePct, trending };
}

/** Two most-recent swing lows → up-sloping support line; two highs → resistance line.
 *  Each rendered as a 2-point segment (auto diagonal trend lines). */
function autoTrendlines(pivots: Pivot[]) {
  const highs = pivots.filter((p) => p.kind === 'H');
  const lows = pivots.filter((p) => p.kind === 'L');
  const seg = (a?: Pivot, b?: Pivot) => (a && b ? [{ time: a.time, value: a.price }, { time: b.time, value: b.price }] : null);
  return {
    support: seg(lows[lows.length - 2], lows[lows.length - 1]),
    resistance: seg(highs[highs.length - 2], highs[highs.length - 1]),
  };
}

interface VolumeProfile {
  poc: number; vah: number; val: number;
  buyVol: number; sellVol: number; buyPct: number;
  pocDominant: 'BUY' | 'SELL';
}

/** Volume-by-price density split into buying (up-bars) vs selling (down-bars) volume.
 *  Returns the Point of Control (most-traded price) + the 70% value area, and the
 *  overall buy/sell balance — an honest density proxy (tick volume, not order flow). */
function volumeProfile(data: ChartCandle[], bins = 24, lookback = 220): VolumeProfile | null {
  const slice = data.slice(Math.max(0, data.length - lookback));
  if (slice.length < 10) return null;
  let lo = Infinity, hi = -Infinity;
  for (const d of slice) { lo = Math.min(lo, d.low); hi = Math.max(hi, d.high); }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null;
  const step = (hi - lo) / bins;
  const buy = new Array(bins).fill(0);
  const sell = new Array(bins).fill(0);
  for (const d of slice) {
    const mid = (d.high + d.low) / 2;
    let b = Math.floor((mid - lo) / step);
    if (b < 0) b = 0; if (b >= bins) b = bins - 1;
    const vol = d.volume || 1;
    if (d.close >= d.open) buy[b] += vol; else sell[b] += vol;
  }
  const total = buy.map((v, i) => v + sell[i]);
  let pocIdx = 0;
  total.forEach((v, i) => { if (v > total[pocIdx]) pocIdx = i; });
  const grand = total.reduce((a, b) => a + b, 0) || 1;
  let included = total[pocIdx], loI = pocIdx, hiI = pocIdx;
  while (included < grand * 0.7 && (loI > 0 || hiI < bins - 1)) {
    const below = loI > 0 ? total[loI - 1] : -1;
    const above = hiI < bins - 1 ? total[hiI + 1] : -1;
    if (above >= below) { hiI += 1; included += total[hiI]; } else { loI -= 1; included += total[loI]; }
  }
  const buyVol = buy.reduce((a, b) => a + b, 0);
  const sellVol = sell.reduce((a, b) => a + b, 0);
  const tot = buyVol + sellVol || 1;
  return {
    poc: lo + (pocIdx + 0.5) * step,
    vah: lo + (hiI + 1) * step,
    val: lo + loI * step,
    buyVol, sellVol,
    buyPct: Math.round((buyVol / tot) * 100),
    pocDominant: buy[pocIdx] >= sell[pocIdx] ? 'BUY' : 'SELL',
  };
}

interface TradeZone { top: number; bottom: number; time: any }

/** Nearest UNVIOLATED demand zone below price (buy area) and supply zone above price
 *  (sell area), built from the freshest swing pivot whose origin candle hasn't been
 *  closed through since. These are the "profitable area" bands + pip-target basis. */
function tradeZones(data: ChartCandle[], pivots: Pivot[]): { demand: TradeZone | null; supply: TradeZone | null; price: number } {
  const price = data[data.length - 1].close;
  const lows = pivots.filter((p) => p.kind === 'L');
  const highs = pivots.filter((p) => p.kind === 'H');
  let demand: TradeZone | null = null;
  for (let i = lows.length - 1; i >= 0; i--) {
    const lv = lows[i];
    if (lv.price >= price) continue;
    const c = data[lv.idx];
    const bottom = c.low, top = Math.max(c.open, c.close);
    let violated = false;
    for (let k = lv.idx + 1; k < data.length; k++) { if (data[k].close < bottom) { violated = true; break; } }
    if (!violated) { demand = { top, bottom, time: c.time }; break; }
  }
  let supply: TradeZone | null = null;
  for (let i = highs.length - 1; i >= 0; i--) {
    const hv = highs[i];
    if (hv.price <= price) continue;
    const c = data[hv.idx];
    const top = c.high, bottom = Math.min(c.open, c.close);
    let violated = false;
    for (let k = hv.idx + 1; k < data.length; k++) { if (data[k].close > top) { violated = true; break; } }
    if (!violated) { supply = { top, bottom, time: c.time }; break; }
  }
  return { demand, supply, price };
}

export default function Mt5CandlestickChart({ candles, signals, symbol, timeframe, levels, symbolOptions, timeframeOptions, onSymbolChange, onTimeframeChange }: Mt5CandlestickChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const legendRef = useRef<HTMLDivElement | null>(null);

  const [showVolume, setShowVolume] = useState(true);
  const [showEma9, setShowEma9] = useState(false);
  const [showEma21, setShowEma21] = useState(false);
  const [showEma50, setShowEma50] = useState(false);
  const [showEma200, setShowEma200] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [showPatterns, setShowPatterns] = useState(false);
  const [showTrend, setShowTrend] = useState(false);
  const [showTrendlines, setShowTrendlines] = useState(false);
  const [showZigzag, setShowZigzag] = useState(false);
  const [showDensity, setShowDensity] = useState(false);
  const [showZones, setShowZones] = useState(false);
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
  // Market-structure overlay series/lines (separate from trade-level price lines so
  // toggling them never clears Entry/SL/TP).
  const regMidRef = useRef<any>(null);
  const regUpRef = useRef<any>(null);
  const regLowRef = useRef<any>(null);
  const trendlineSupRef = useRef<any>(null);
  const trendlineResRef = useRef<any>(null);
  const zigzagRef = useRef<any>(null);
  const analysisLinesRef = useRef<any[]>([]);
  const analysisBadgeRef = useRef<HTMLDivElement | null>(null);
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
    regMidRef.current = null;
    regUpRef.current = null;
    regLowRef.current = null;
    trendlineSupRef.current = null;
    trendlineResRef.current = null;
    zigzagRef.current = null;
    analysisLinesRef.current = [];

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
      regMidRef.current = null;
      regUpRef.current = null;
      regLowRef.current = null;
      trendlineSupRef.current = null;
      trendlineResRef.current = null;
      zigzagRef.current = null;
      analysisLinesRef.current = [];
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

    // ── Market-structure overlays (trend / trendlines / zigzag / density / zones) ──
    const aDigits = priceDigits(symbol, data[data.length - 1]?.close);
    const fmt = (v: number) => v.toFixed(aDigits);
    // Generic create/remove + setData for a 2+-point overlay line series.
    const applyLine = (ref: React.MutableRefObject<any>, show: boolean, points: { time: any; value: number }[] | null | undefined, opts: any) => {
      if (show && points && points.length >= 2) {
        if (!ref.current) ref.current = chart.addSeries(LineSeries, opts);
        ref.current.applyOptions(opts);
        ref.current.setData(points);
      } else if (ref.current) {
        chart.removeSeries(ref.current);
        ref.current = null;
      }
    };
    // Rebuild the horizontal analysis price lines (density / zones / projection) fresh
    // each pass. Kept separate from the Entry/SL/TP lines so the two never clash.
    for (const l of analysisLinesRef.current) { try { series.removePriceLine(l); } catch { /* removed */ } }
    analysisLinesRef.current = [];
    const addAnalysisLine = (price: number | null | undefined, color: string, title: string, style = LineStyle.Solid) => {
      if (price === null || price === undefined || !Number.isFinite(price)) return;
      analysisLinesRef.current.push(series.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
    };

    const needPivots = showTrendlines || showZigzag || showZones;
    const pivots = needPivots ? detectPivots(data, 3) : [];
    const analysisMarkers: ChartMarker[] = [];
    const badgeChips: string[] = [];

    // Trend: regression channel + forward projection + a direction chip.
    const rc = showTrend ? regressionChannel(data) : null;
    {
      const up = (rc?.slope ?? 0) >= 0;
      const trendCol = !rc ? '#64748b' : !rc.trending ? '#64748b' : up ? '#089981' : '#f23645';
      applyLine(regMidRef, showTrend && !!rc, rc?.mid, { color: trendCol, lineWidth: 2, lineStyle: LineStyle.Solid, title: 'Trend', lastValueVisible: false, priceLineVisible: false });
      applyLine(regUpRef, showTrend && !!rc, rc?.upper, { color: trendCol, lineWidth: 1, lineStyle: LineStyle.Dashed, lastValueVisible: false, priceLineVisible: false });
      applyLine(regLowRef, showTrend && !!rc, rc?.lower, { color: trendCol, lineWidth: 1, lineStyle: LineStyle.Dashed, lastValueVisible: false, priceLineVisible: false });
      if (showTrend && rc) {
        addAnalysisLine(rc.projValue, trendCol, `PROJ ${fmt(rc.projValue)}`, LineStyle.Dotted);
        const dir = !rc.trending ? 'RANGE' : up ? 'UPTREND' : 'DOWNTREND';
        const projPips = Math.abs(rc.projValue - rc.endValue) / (aDigits >= 4 ? 0.0001 : aDigits === 3 ? 0.01 : 0.1);
        badgeChips.push(`<span class="font-black" style="color:${trendCol}">▲ ${dir}</span><span class="text-slate-400">·</span><span>${rc.changePct >= 0 ? '+' : ''}${rc.changePct.toFixed(2)}% · proj ${up ? '↑' : '↓'} ~${Math.round(projPips)}p</span>`);
      }
    }

    // Auto diagonal trendlines (support / resistance) from the last two swing pivots.
    const tl = showTrendlines ? autoTrendlines(pivots) : null;
    applyLine(trendlineSupRef, showTrendlines && !!tl?.support, tl?.support, { color: '#10b981', lineWidth: 2, lineStyle: LineStyle.Solid, title: 'Support', lastValueVisible: false, priceLineVisible: false });
    applyLine(trendlineResRef, showTrendlines && !!tl?.resistance, tl?.resistance, { color: '#ef4444', lineWidth: 2, lineStyle: LineStyle.Solid, title: 'Resistance', lastValueVisible: false, priceLineVisible: false });

    // ZigZag structure + HH/HL/LH/LL labels.
    if (showZigzag) {
      const zz = computeZigZag(pivots);
      applyLine(zigzagRef, true, zz.map((p) => ({ time: p.time, value: p.price })), { color: '#6366f1', lineWidth: 2, lineStyle: LineStyle.Solid, title: 'ZigZag', lastValueVisible: false, priceLineVisible: false });
      for (const p of zz) {
        const bull = p.label === 'HH' || p.label === 'HL';
        analysisMarkers.push({ time: p.time, position: p.kind === 'H' ? 'aboveBar' : 'belowBar', color: bull ? '#089981' : '#f23645', shape: 'circle', text: p.label });
      }
      const bias = structureBias(zz);
      const biasCol = bias === 'UP' ? '#089981' : bias === 'DOWN' ? '#f23645' : '#64748b';
      badgeChips.push(`<span class="font-black" style="color:${biasCol}">⟿ ${bias}</span><span class="text-slate-400">structure</span>`);
    } else {
      applyLine(zigzagRef, false, null, {});
    }

    // Density: volume-by-price (POC + value area) + buy/sell balance chip.
    const vp = showDensity ? volumeProfile(data) : null;
    if (showDensity && vp) {
      addAnalysisLine(vp.poc, '#d97706', `POC ${fmt(vp.poc)}`, LineStyle.Solid);
      addAnalysisLine(vp.vah, '#94a3b8', `VAH ${fmt(vp.vah)}`, LineStyle.Dashed);
      addAnalysisLine(vp.val, '#94a3b8', `VAL ${fmt(vp.val)}`, LineStyle.Dashed);
      const densCol = vp.buyPct >= 55 ? '#089981' : vp.buyPct <= 45 ? '#f23645' : '#64748b';
      badgeChips.push(`<span class="font-black" style="color:${densCol}">◧ ${vp.buyPct}% buy</span><span class="text-slate-400">density · POC ${vp.pocDominant.toLowerCase()}</span>`);
    }

    // Profitable buy/sell areas: nearest unviolated demand & supply zone bands.
    if (showZones) {
      const tz = tradeZones(data, pivots);
      if (tz.demand) {
        addAnalysisLine(tz.demand.top, '#059669', `BUY ${fmt(tz.demand.top)}`, LineStyle.Solid);
        addAnalysisLine(tz.demand.bottom, '#059669', `BUY ${fmt(tz.demand.bottom)}`, LineStyle.Dashed);
        analysisMarkers.push({ time: tz.demand.time, position: 'belowBar', color: '#059669', shape: 'circle', text: 'BUY' });
      }
      if (tz.supply) {
        addAnalysisLine(tz.supply.top, '#dc2626', `SELL ${fmt(tz.supply.top)}`, LineStyle.Dashed);
        addAnalysisLine(tz.supply.bottom, '#dc2626', `SELL ${fmt(tz.supply.bottom)}`, LineStyle.Solid);
        analysisMarkers.push({ time: tz.supply.time, position: 'aboveBar', color: '#dc2626', shape: 'circle', text: 'SELL' });
      }
      if (tz.demand && tz.supply) {
        const reward = Math.abs(((tz.supply.top + tz.supply.bottom) / 2) - ((tz.demand.top + tz.demand.bottom) / 2));
        const pips = reward / (aDigits >= 4 ? 0.0001 : aDigits === 3 ? 0.01 : 0.1);
        badgeChips.push(`<span class="font-black text-slate-700">⤢ ~${Math.round(pips)}p</span><span class="text-slate-400">buy→sell range</span>`);
      }
    }

    // Render / hide the structure summary badge.
    const badgeEl = analysisBadgeRef.current;
    if (badgeEl) {
      badgeEl.innerHTML = badgeChips.map((c) => `<span class="inline-flex items-center gap-1 rounded bg-white/85 px-1.5 py-0.5">${c}</span>`).join('');
      badgeEl.style.display = badgeChips.length ? 'flex' : 'none';
    }

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
    const allMarkers = [...signalMarkers, ...patternMarkers, ...analysisMarkers].sort((a, b) => Number(a.time) - Number(b.time));
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
  }, [candles, signals, symbol, timeframe, showVolume, showEma9, showEma21, showEma50, showEma200, showPatterns, showTrend, showTrendlines, showZigzag, showDensity, showZones, levels]);

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

  // When the in-chart symbol/TF switcher is shown, push the legend + badge down so
  // they don't sit under it.
  const hasSwitcher = Boolean(onSymbolChange || onTimeframeChange);
  const tfOpts = timeframeOptions?.length ? timeframeOptions : [timeframe];
  const symOpts = symbolOptions?.length ? symbolOptions : [symbol];

  return (
    <div className={wrapperClass}>
      <div className="relative h-full w-full overflow-hidden rounded-2xl">
        {/* In-chart symbol + timeframe switcher (controlled by the parent) */}
        {hasSwitcher && (
          <div className="absolute left-3 top-3 z-20 flex items-center gap-1 rounded-xl border border-slate-200/60 bg-white/85 p-1 shadow-sm backdrop-blur-md">
            {onSymbolChange && (
              <select
                value={symbol}
                onChange={(e) => onSymbolChange(e.target.value)}
                className="rounded-lg border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] font-black text-slate-700 outline-none focus:border-indigo-400"
                title="Symbol"
              >
                {symOpts.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            )}
            {onTimeframeChange && (
              <div className="flex overflow-hidden rounded-lg border border-slate-200">
                {tfOpts.map((tf) => (
                  <button
                    key={tf}
                    onClick={() => onTimeframeChange(tf)}
                    className={`px-1.5 py-0.5 text-[10px] font-black transition-colors ${timeframe === tf ? 'bg-indigo-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}
                  >
                    {tf}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Hover legend */}
        <div
          ref={legendRef}
          className={`pointer-events-none absolute left-3 z-10 rounded-lg border border-slate-100/50 bg-white/75 px-2.5 py-1.5 shadow-sm backdrop-blur-[3px] ${hasSwitcher ? 'top-14' : 'top-3'}`}
        />

        {/* Market-structure summary badge (populated when Trend/ZigZag/Density/Zones are on) */}
        <div
          ref={analysisBadgeRef}
          style={{ display: 'none' }}
          className={`pointer-events-none absolute left-3 z-10 flex flex-wrap items-center gap-1.5 rounded-lg border border-slate-100/60 bg-white/40 px-1.5 py-1 text-[10px] font-bold text-slate-600 shadow-sm backdrop-blur-[3px] ${hasSwitcher ? 'top-[5.5rem]' : 'top-12'}`}
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
          {toggleBtn(showTrend, 'Trend', () => setShowTrend((v) => !v), 'bg-teal-50 text-teal-700 border-teal-200')}
          {toggleBtn(showTrendlines, 'Lines', () => setShowTrendlines((v) => !v), 'bg-rose-50 text-rose-700 border-rose-200')}
          {toggleBtn(showZigzag, 'ZigZag', () => setShowZigzag((v) => !v), 'bg-indigo-50 text-indigo-700 border-indigo-200')}
          {toggleBtn(showDensity, 'Density', () => setShowDensity((v) => !v), 'bg-amber-50 text-amber-700 border-amber-200')}
          {toggleBtn(showZones, 'Zones', () => setShowZones((v) => !v), 'bg-emerald-50 text-emerald-700 border-emerald-200')}
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
