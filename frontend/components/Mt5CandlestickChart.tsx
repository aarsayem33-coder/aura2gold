import React, { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
} from 'lightweight-charts';
import { fetchChartAnalysis, previewAiOrder, placeAiOrder } from '../mt5Api';
import type { AiOrderPreview, AiOrderPlaced } from '../mt5Api';
import type { ChartAnalysisResponse } from '../types';
import {
  loadAnalysisHistory, saveAnalysis, deleteAnalysis, clearAnalysisHistory,
  latestAnalysisFor, MAX_ANALYSIS_HISTORY,
} from '../lib/aiAnalysisHistory';
import type { StoredAnalysis } from '../lib/aiAnalysisHistory';
import { Maximize2, Minimize2, Crosshair, TrendingUp, TrendingDown } from 'lucide-react';
import { timeframeSeconds, bucketPhase, bucketStart, formingBarFor, secsToNextBar } from '../lib/chartTime.js';
import type { Alert, Mt5Candle } from '../types';

/**
 * Minimum model confidence before the AI desk shows actionable trade levels.
 *
 * Below this the read is still displayed — verdict, structure, liquidity, reasoning — but the
 * entry/stop/targets and sizing are withheld. A price on screen is a price someone acts on,
 * and a 35-confidence entry looks identical to an 85-confidence one once it is rendered.
 */
const AI_PLAN_MIN_CONFIDENCE = 60;

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
  /** Small status node rendered top-center ONLY when the chart is expanded (fullscreen). */
  fullscreenBadge?: React.ReactNode;
  /**
   * Extra horizontal lines drawn on top of everything else. Purely additive: when the prop
   * is absent nothing is created and the chart behaves exactly as before, so /chart is
   * unaffected. Used by the Liquidity Chart route to draw its classified levels.
   */
  extraLines?: { price: number; color: string; title: string; dashed?: boolean }[] | null;
}

type ChartCandle = { time: any; open: number; high: number; low: number; close: number; volume: number };
type ChartMarker = { time: any; position: string; color: string; shape: string; text: string };

function toChartTime(value: string) {
  const parsed = new Date(value).getTime();
  if (Number.isNaN(parsed)) return Math.floor(Date.now() / 1000);
  return Math.floor(parsed / 1000);
}

// Bar-time arithmetic lives in ../lib/chartTime.js so it can be unit-tested (chartTime.test.mjs).


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
    // An "outside bar" can be flagged as BOTH a pivot high and low at the same index/time.
    // Keep only the first so the zigzag never has two points on one timestamp (which the
    // line series rejects — it requires strictly ascending, unique times).
    if (p.idx === last.idx) continue;
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

// ── Ichimoku Kinko Hyo (classic 9 / 26 / 52, displacement 26) ────────────────
// Proper text-book calculation: Tenkan = (9-bar high+low)/2, Kijun = (26-bar high+low)/2,
// Senkou Span A = (Tenkan+Kijun)/2 plotted 26 bars AHEAD, Span B = (52-bar high+low)/2
// plotted 26 ahead (future timestamps synthesized from the timeframe), Chikou = close
// plotted 26 bars BACK. Returns line arrays + matched Span A/B pairs for the Kumo fill.
function ichimokuData(data: ChartCandle[], tfSec: number, { conversion = 9, base = 26, spanBP = 52, displacement = 26 } = {}) {
  const n = data.length;
  if (n < spanBP + 2) return null;
  const hh = (i: number, p: number) => { let h = -Infinity; for (let k = i - p + 1; k <= i; k++) h = Math.max(h, data[k].high); return h; };
  const ll = (i: number, p: number) => { let l = Infinity; for (let k = i - p + 1; k <= i; k++) l = Math.min(l, data[k].low); return l; };
  const futureTime = (i: number): number | null => {
    const j = i + displacement;
    if (j < n) return Number(data[j].time);
    return tfSec > 0 ? Number(data[n - 1].time) + (j - (n - 1)) * tfSec : null;
  };
  const tenkan: { time: any; value: number }[] = [];
  const kijun: { time: any; value: number }[] = [];
  const chikou: { time: any; value: number }[] = [];
  const aPts: { time: any; value: number }[] = [];
  const bPts: { time: any; value: number }[] = [];
  const bByTime = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    let t: number | null = null;
    let k: number | null = null;
    if (i >= conversion - 1) { t = (hh(i, conversion) + ll(i, conversion)) / 2; tenkan.push({ time: data[i].time, value: t }); }
    if (i >= base - 1) { k = (hh(i, base) + ll(i, base)) / 2; kijun.push({ time: data[i].time, value: k }); }
    const ft = futureTime(i);
    if (ft !== null) {
      if (t !== null && k !== null) aPts.push({ time: ft, value: (t + k) / 2 });
      if (i >= spanBP - 1) { const v = (hh(i, spanBP) + ll(i, spanBP)) / 2; bPts.push({ time: ft, value: v }); bByTime.set(ft, v); }
    }
    if (i >= displacement) chikou.push({ time: data[i - displacement].time, value: data[i].close });
  }
  // Matched pairs (same displaced timestamp) for the Kumo fill + the cloud AT each time.
  const pairs = aPts.filter((p) => bByTime.has(Number(p.time))).map((p) => ({ time: Number(p.time), a: p.value, b: bByTime.get(Number(p.time)) as number }));
  return { tenkan, kijun, chikou, aPts, bPts, pairs };
}

// Kumo (cloud) fill — a lightweight-charts series primitive that paints the polygon between
// Span A and Span B (green where A ≥ B, red where B > A), behind the candles. lightweight-charts
// has no native fill-between-two-lines series, so this draws it directly on the pane canvas
// using the chart's own coordinate conversions (stays correct under zoom/pan/resize).
class KumoCloudPrimitive {
  _chart: any = null;
  _series: any = null;
  _pairs: { time: number; a: number; b: number }[] = [];
  setData(pairs: { time: number; a: number; b: number }[]) { this._pairs = pairs; }
  attached({ chart, series }: any) { this._chart = chart; this._series = series; }
  detached() { this._chart = null; this._series = null; }
  updateAllViews() { /* stateless — recomputed every draw */ }
  paneViews() {
    return [{
      zOrder: () => 'bottom' as const,
      renderer: () => ({
        draw: (target: any) => {
          const chart = this._chart, series = this._series, pairs = this._pairs;
          if (!chart || !series || pairs.length < 2) return;
          target.useMediaCoordinateSpace((scope: any) => {
            const ctx = scope.context;
            const ts = chart.timeScale();
            let seg: { x: number; ya: number; yb: number }[] = [];
            let segBull: boolean | null = null;
            const flush = () => {
              if (seg.length > 1 && segBull !== null) {
                ctx.beginPath();
                ctx.moveTo(seg[0].x, seg[0].ya);
                for (let i = 1; i < seg.length; i++) ctx.lineTo(seg[i].x, seg[i].ya);
                for (let i = seg.length - 1; i >= 0; i--) ctx.lineTo(seg[i].x, seg[i].yb);
                ctx.closePath();
                ctx.fillStyle = segBull ? 'rgba(8, 153, 129, 0.14)' : 'rgba(242, 54, 69, 0.12)';
                ctx.fill();
              }
              seg = [];
            };
            for (const p of pairs) {
              const x = ts.timeToCoordinate(p.time);
              const ya = series.priceToCoordinate(p.a);
              const yb = series.priceToCoordinate(p.b);
              if (x === null || ya === null || yb === null) { flush(); segBull = null; continue; }
              const bull = p.a >= p.b;
              if (segBull === null) segBull = bull;
              else if (bull !== segBull) { seg.push({ x, ya, yb }); flush(); segBull = bull; }
              seg.push({ x, ya, yb });
            }
            flush();
          });
        },
      }),
    }];
  }
}

interface OrderBlockZone { top: number; bottom: number; time: any; index: number; bull: boolean }

/**
 * Order blocks: the last opposing candle before a displacement move, still unmitigated.
 *
 * A demand block is a DOWN candle that price then left upward by at least one ATR and has not
 * traded back through since; supply is the mirror. "Unmitigated" is the whole point — once
 * price has closed through a block its orders are filled and it stops being a level, so a
 * chart that keeps drawing it is showing history, not context.
 */
function detectOrderBlocks(data: ChartCandle[], lookback = 180): OrderBlockZone[] {
  if (!Array.isArray(data) || data.length < 30) return [];
  // Average true range over the recent window — the displacement yardstick.
  const from = Math.max(1, data.length - lookback);
  let atr = 0, atrN = 0;
  for (let i = Math.max(1, data.length - 30); i < data.length; i++) {
    atr += Math.max(data[i].high - data[i].low, Math.abs(data[i].high - data[i - 1].close), Math.abs(data[i].low - data[i - 1].close));
    atrN += 1;
  }
  atr = atrN ? atr / atrN : 0;
  if (!(atr > 0)) return [];

  const out: OrderBlockZone[] = [];
  const last = data.length - 1;
  for (let i = last - 2; i >= from; i--) {
    const c = data[i];
    const bull = c.close < c.open;            // demand = the down candle before an up move
    const bear = c.close > c.open;
    if (!bull && !bear) continue;
    const n1 = data[i + 1], n2 = data[i + 2];
    if (!n1 || !n2) continue;
    const moved = bull ? Math.max(n1.high, n2.high) - c.high : c.low - Math.min(n1.low, n2.low);
    if (!(moved >= atr)) continue;
    const height = c.high - c.low;
    if (!(height > 0) || height > atr * 2) continue;   // wider than 2 ATR is a region, not a level
    // Mitigated since? Then it is spent and must not be drawn.
    let breached = false;
    for (let j = i + 3; j <= last; j++) {
      if (bull ? data[j].low <= c.low : data[j].high >= c.high) { breached = true; break; }
    }
    if (breached) continue;
    out.push({ top: c.high, bottom: c.low, time: c.time, index: i, bull });
    if (out.length >= 4) break;                        // nearest four; more becomes a grey smear
  }
  return out;
}

/**
 * Candles that came back and touched a still-live order block — the retest.
 *
 * Only the FIRST bar of each visit counts: price sitting inside a zone for six bars is one
 * retest, not six, and circling every bar would bury the zone it is meant to highlight.
 */
function detectRetestBars(data: ChartCandle[], zones: OrderBlockZone[]): ChartMarker[] {
  if (!zones.length) return [];
  const out: ChartMarker[] = [];
  for (const z of zones) {
    let inside = false;
    for (let i = z.index + 3; i < data.length; i++) {
      const touching = data[i].low <= z.top && data[i].high >= z.bottom;
      if (touching && !inside) {
        out.push({
          time: data[i].time,
          position: z.bull ? 'belowBar' : 'aboveBar',
          color: '#d97706',
          shape: 'circle',
          text: 'retest',
        });
      }
      inside = touching;
    }
  }
  // Markers must be in ascending time order or lightweight-charts drops them silently.
  return out.sort((a, b) => Number(a.time) - Number(b.time));
}

/**
 * Transparent rectangles for the order blocks, drawn on the pane canvas behind the candles.
 *
 * Same approach as KumoCloudPrimitive: lightweight-charts has no native box shape, and using
 * the chart's own coordinate conversions keeps the boxes correct under zoom, pan and resize.
 * Grey and translucent on purpose — a zone is CONTEXT, and a solid or coloured fill would
 * hide the price action it exists to frame.
 */
class OrderBlockPrimitive {
  _chart: any = null;
  _series: any = null;
  _zones: OrderBlockZone[] = [];
  setData(zones: OrderBlockZone[]) { this._zones = zones; }
  attached({ chart, series }: any) { this._chart = chart; this._series = series; }
  detached() { this._chart = null; this._series = null; }
  updateAllViews() { /* stateless — recomputed every draw */ }
  paneViews() {
    return [{
      zOrder: () => 'bottom' as const,
      renderer: () => ({
        draw: (target: any) => {
          const chart = this._chart, series = this._series, zones = this._zones;
          if (!chart || !series || !zones.length) return;
          target.useMediaCoordinateSpace((scope: any) => {
            const ctx = scope.context;
            const ts = chart.timeScale();
            for (const z of zones) {
              const yTop = series.priceToCoordinate(z.top);
              const yBot = series.priceToCoordinate(z.bottom);
              if (yTop === null || yBot === null) continue;
              // From the block's own bar to the right edge: the zone is live until price
              // mitigates it, so it should extend to now rather than stop where it formed.
              const x0 = ts.timeToCoordinate(z.time);
              const left = x0 === null ? 0 : x0;
              const right = scope.mediaSize.width;
              ctx.fillStyle = 'rgba(100, 116, 139, 0.16)';
              ctx.fillRect(left, Math.min(yTop, yBot), Math.max(0, right - left), Math.abs(yBot - yTop));
              ctx.strokeStyle = 'rgba(100, 116, 139, 0.55)';
              ctx.setLineDash([4, 3]);
              ctx.lineWidth = 1;
              ctx.strokeRect(left, Math.min(yTop, yBot), Math.max(0, right - left), Math.abs(yBot - yTop));
              ctx.setLineDash([]);
            }
          });
        },
      }),
    }];
  }
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

export default function Mt5CandlestickChart({ candles, signals, symbol, timeframe, levels, symbolOptions, timeframeOptions, onSymbolChange, onTimeframeChange, fullscreenBadge, extraLines }: Mt5CandlestickChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const legendRef = useRef<HTMLDivElement | null>(null);

  const [showVolume, setShowVolume] = useState(true);
  const [showEma9, setShowEma9] = useState(false);
  const [showEma21, setShowEma21] = useState(false);
  const [showEma50, setShowEma50] = useState(false);
  const [showEma200, setShowEma200] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [showPatterns, setShowPatterns] = useState(false);
  const [showIchimoku, setShowIchimoku] = useState(false);
  const [showTrend, setShowTrend] = useState(false);
  const [showTrendlines, setShowTrendlines] = useState(false);
  const [showZigzag, setShowZigzag] = useState(false);
  const [showDensity, setShowDensity] = useState(false);
  const [showZones, setShowZones] = useState(false);
  const [showOrderBlocks, setShowOrderBlocks] = useState(false);
  // AI trade-desk panel. Style and direction are chosen BEFORE the read, because a scalper and
  // a day trader take different trades off the same chart.
  const [aiOpen, setAiOpen] = useState(false);
  const [aiStyle, setAiStyle] = useState<'SCALP' | 'DAY'>('DAY');
  const [aiBias, setAiBias] = useState<'LONG' | 'SHORT' | 'BOTH'>('BOTH');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState<string | null>(null);
  const [aiOut, setAiOut] = useState<ChartAnalysisResponse | null>(null);
  // Reads are kept for later: the panel used to lose its result the moment it closed, and each
  // one costs a Gemini call. History holds the last 20 in full; the drawer reopens any of them.
  const [aiHistory, setAiHistory] = useState<StoredAnalysis[]>(() => loadAnalysisHistory());
  const [aiHistoryOpen, setAiHistoryOpen] = useState(false);
  // Which stored read is on screen, so the drawer can mark it and so a restored read is not
  // mistaken for one just produced by the button.
  const [aiViewingId, setAiViewingId] = useState<string | null>(null);

  // Reopening the panel brings back the last read for THIS series rather than an empty box.
  // Only when nothing is displayed, so it can never overwrite a fresh result.
  useEffect(() => {
    if (!aiOpen || aiOut || aiBusy) return;
    const last = latestAnalysisFor(symbol, timeframe);
    if (last) { setAiOut(last.result); setAiViewingId(last.id); }
  }, [aiOpen, aiOut, aiBusy, symbol, timeframe]);

  const runAi = async () => {
    // A new read invalidates any ticket sized against the previous one.
    setAiBusy(true); setAiErr(null); setAiOut(null); setAiViewingId(null); resetOrderState();
    try {
      // No image is sent: the server renders the chart from the same candles it analyses, so
      // what the model sees and what the maths reconciles against cannot drift apart.
      const out = await fetchChartAnalysis({
        symbol, timeframe, tradeMode: 'FOREX', style: aiStyle,
        bias: aiStyle === 'SCALP' ? aiBias : 'BOTH', mimeType: 'image/png',
      });
      setAiOut(out);
      const next = saveAnalysis({
        symbol, timeframe, style: aiStyle,
        bias: aiStyle === 'SCALP' ? aiBias : 'BOTH',
        result: out,
      });
      setAiHistory(next);
      setAiViewingId(next[0]?.id ?? null);
    } catch (e) {
      setAiErr(e instanceof Error ? e.message : 'Analysis failed');
    } finally { setAiBusy(false); }
  };

  // Placing the AI plan as a real resting order. Manual only, and deliberately two-step: the
  // first click sizes and validates, the second sends. A single button that both sized and
  // placed would mean the first time you see the risk figure is after the order exists.
  const [orderBusy, setOrderBusy] = useState(false);
  const [orderPreview, setOrderPreview] = useState<AiOrderPreview | null>(null);
  const [orderPlaced, setOrderPlaced] = useState<AiOrderPlaced | null>(null);
  const [orderErr, setOrderErr] = useState<string | null>(null);

  const resetOrderState = () => { setOrderPreview(null); setOrderPlaced(null); setOrderErr(null); };

  const doPreviewOrder = async (trackId: string) => {
    setOrderBusy(true); setOrderErr(null); setOrderPlaced(null);
    try { setOrderPreview(await previewAiOrder(trackId)); }
    catch (e) { setOrderErr(e instanceof Error ? e.message : 'Could not size this ticket'); }
    finally { setOrderBusy(false); }
  };

  const doPlaceOrder = async (trackId: string) => {
    setOrderBusy(true); setOrderErr(null);
    try {
      const placed = await placeAiOrder(trackId);
      setOrderPlaced(placed);
      setOrderPreview(null);
    } catch (e) { setOrderErr(e instanceof Error ? e.message : 'Could not place this order'); }
    finally { setOrderBusy(false); }
  };

  const openStoredAnalysis = (entry: StoredAnalysis) => {
    setAiOut(entry.result);
    setAiViewingId(entry.id);
    setAiErr(null);
    setAiHistoryOpen(false);
    resetOrderState();
  };
  const [isFullscreen, setIsFullscreen] = useState(false);

  const chartRef = useRef<any>(null);
  const seriesRef = useRef<any>(null);
  const volumeSeriesRef = useRef<any>(null);
  const ema9SeriesRef = useRef<any>(null);
  const ema21SeriesRef = useRef<any>(null);
  const ema50SeriesRef = useRef<any>(null);
  const ema200SeriesRef = useRef<any>(null);
  const markersApiRef = useRef<any>(null);
  const obPrimitiveRef = useRef<any>(null);
  const priceLinesRef = useRef<any[]>([]);
  // Market-structure overlay series/lines (separate from trade-level price lines so
  // toggling them never clears Entry/SL/TP).
  const regMidRef = useRef<any>(null);
  const regUpRef = useRef<any>(null);
  const regLowRef = useRef<any>(null);
  const trendlineSupRef = useRef<any>(null);
  const trendlineResRef = useRef<any>(null);
  const zigzagRef = useRef<any>(null);
  // Ichimoku overlay series + the Kumo cloud-fill primitive (attached to the Span A series).
  const ichiTenkanRef = useRef<any>(null);
  const ichiKijunRef = useRef<any>(null);
  const ichiChikouRef = useRef<any>(null);
  const ichiSpanARef = useRef<any>(null);
  const ichiSpanBRef = useRef<any>(null);
  const kumoRef = useRef<KumoCloudPrimitive | null>(null);
  const analysisLinesRef = useRef<any[]>([]);
  const analysisBadgeRef = useRef<HTMLDivElement | null>(null);
  const resizeChartRef = useRef<(() => void) | null>(null);
  const lastLenRef = useRef(0);
  // Latest CLOSED bar (time in seconds + close), used to synthesize the live-forming bar.
  const lastClosedRef = useRef<{ time: number; close: number } | null>(null);
  // The newest bar exactly as the feed reported it, including receivedAt. formingBarFor needs
  // the arrival time to judge whether the feed is actually live — a forming bar keeps the
  // period's opening timestamp for the whole period, so its own time says nothing about that.
  const liveBarRef = useRef<any>(null);
  // Broker bar phase measured off the feed, so the countdown and the forming bar land on
  // the SAME boundaries as the real bars (see bucketPhase).
  const phaseRef = useRef(0);
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
      // Explicit initial size + a ResizeObserver below (see resizeChart). autoSize is NOT used:
      // its internal observer lags on the fullscreen transition, leaving the canvas at the old
      // size so zoom rendered candles against wrong dimensions. Manual resize is reliable.
      width: Math.max(1, container.clientWidth),
      height: Math.max(1, container.clientHeight),
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#64748b',
        fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: '#f1f5f9', style: LineStyle.Dashed, visible: true },
        horzLines: { color: '#f1f5f9', style: LineStyle.Dashed, visible: true },
      },
      rightPriceScale: {
        borderColor: '#e2e8f0',
        scaleMargins: { top: 0.12, bottom: 0.22 },
      },
      // rightOffset keeps the newest candle off the hard edge; barSpacing/minBarSpacing give a
      // clean default candle width and let the user zoom in far without candles collapsing.
      timeScale: { borderColor: '#e2e8f0', timeVisible: true, secondsVisible: false, rightOffset: 6, barSpacing: 8, minBarSpacing: 0.5 },
      crosshair: {
        // Normal = the price (horizontal) line follows the mouse to ANY level, instead of
        // Magnet mode's snapping to the nearest candle O/H/L/C — so you can measure freely.
        mode: CrosshairMode.Normal,
        vertLine: { color: '#f97316', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#ea580c' },
        horzLine: { color: '#f97316', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#ea580c' },
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
    obPrimitiveRef.current = null;
    priceLinesRef.current = [];
    regMidRef.current = null;
    regUpRef.current = null;
    regLowRef.current = null;
    trendlineSupRef.current = null;
    trendlineResRef.current = null;
    zigzagRef.current = null;
    ichiTenkanRef.current = null;
    ichiKijunRef.current = null;
    ichiChikouRef.current = null;
    ichiSpanARef.current = null;
    ichiSpanBRef.current = null;
    kumoRef.current = null;
    analysisLinesRef.current = [];
    // Drop the previous instrument's last-closed reference so Effect D can't paint a stale
    // forming bar (old symbol's price) onto the fresh series before new data loads.
    lastClosedRef.current = null;
    liveBarRef.current = null;

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

    // Reliable resize: observe the container box and resize the chart to match (rAF-batched so
    // rapid changes — fullscreen enter/exit, window resize, layout shifts — repaint the canvas at
    // the correct dimensions). Preserves the user's zoom. This is what fixes candles rendering
    // wrong after zooming in fullscreen.
    let rafId = 0;
    const resizeChart = () => {
      const w = Math.floor(container.clientWidth);
      const h = Math.floor(container.clientHeight);
      if (w > 0 && h > 0) { try { chart.resize(w, h); } catch { /* mid-teardown */ } }
    };
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = window.requestAnimationFrame(resizeChart);
    });
    ro.observe(container);
    resizeChartRef.current = resizeChart;
    resizeChart(); // ensure correct size on first paint

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      resizeChartRef.current = null;
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
    // Read the broker's bar phase off the feed before bucketing — see bucketPhase().
    const allSecs: number[] = [];
    for (const candle of candles) {
      const ms = new Date(candle.time).getTime();
      if (!Number.isNaN(ms)) allSecs.push(Math.floor(ms / 1000));
    }
    const phase = bucketPhase(allSecs, tfSec);
    phaseRef.current = phase;
    const byBar = new Map<number, { firstSec: number; lastSec: number; candle: ChartCandle }>();
    for (const candle of candles) {
      if (candle.open === null || candle.high === null || candle.low === null || candle.close === null) continue;
      const ms = new Date(candle.time).getTime();
      if (Number.isNaN(ms)) continue;
      const sec = Math.floor(ms / 1000);
      const barTime = tfSec > 0 ? bucketStart(sec, tfSec, phase) : sec;
      const o = candle.open as number;
      const h = candle.high as number;
      const l = candle.low as number;
      const c = candle.close as number;
      const v = (candle.volume as number) || 0;
      // Data-sanity guard: a single garbage candle (0 / negative / non-finite / inverted) would
      // drag the price-scale autoscale to ~0 and squash all real candles into a thin band at the
      // top. Prices are always > 0 for these instruments, so drop anything invalid.
      if (![o, h, l, c].every((x) => Number.isFinite(x) && x > 0) || h < l) continue;
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
    let data = [...byBar.values()].map((x) => x.candle).sort((a, b) => Number(a.time) - Number(b.time));
    if (data.length === 0) return;

    // Drop internally-inconsistent bars (open/close outside [low,high]) — corrupt feed data that
    // otherwise renders as a full-height spike. (Dropped, not clamped: clamping would turn it into
    // a giant fake candle that blows the vertical scale and squashes real candles when centered.)
    data = data.filter((d) => d.low <= d.open && d.open <= d.high && d.low <= d.close && d.close <= d.high && d.high >= d.low);
    // Drop isolated glitch spikes: a bar whose price sits far outside the LOCAL median of nearby
    // bars (a lone candle jumping ~6%+ away from its neighbours and back — a stale/feed error). A
    // local window tracks genuine trends, so trending bars are always kept; only isolated outliers
    // are removed. Safety-capped (must keep ≥85%) so a real regime shift can never blank the chart.
    if (data.length >= 7) {
      const closes = data.map((d) => d.close);
      const W = 7;
      const kept = data.filter((d, i) => {
        const win = closes.slice(Math.max(0, i - W), Math.min(closes.length, i + W + 1)).slice().sort((a, b) => a - b);
        const med = win[Math.floor(win.length / 2)];
        return !(med > 0) || (d.low >= med * 0.94 && d.high <= med * 1.06);
      });
      if (kept.length >= Math.floor(data.length * 0.85)) data = kept;
    }
    if (data.length === 0) return;

    // Record the latest closed bar so the 1-second live effect can keep a forming
    // bar pinned to the current period (the feed only sends closed bars).
    const lastBar = data[data.length - 1];
    lastClosedRef.current = { time: Number(lastBar.time), close: Number(lastBar.close) };
    // Carry receivedAt through from the source candle for this bar so the live check has it.
    const srcNewest = [...(candles || [])].sort(
      (a, b) => Date.parse(String(b.time)) - Date.parse(String(a.time)),
    )[0];
    liveBarRef.current = srcNewest
      ? {
        time: Math.floor(Date.parse(String(srcNewest.time)) / 1000),
        open: Number(srcNewest.open), high: Number(srcNewest.high),
        low: Number(srcNewest.low), close: Number(srcNewest.close),
        volume: Number(srcNewest.volume) || 0,
        receivedAt: (srcNewest as any).receivedAt ?? null,
      }
      : null;

    // Render the closed bars plus a synthetic forming bar for the current period
    // (only the candlestick series gets the forming bar; overlays/markers stay on
    // closed data so EMAs/volume aren't skewed by the flat placeholder).
    const forming = formingBarFor(lastClosedRef.current, tfSec, phase, Date.now(), liveBarRef.current);
    // APPEND only when the forming bar is genuinely a new period. Now that the feed streams the
    // real forming bar, `data` usually ALREADY ends with it — appending then produces two bars
    // at the same timestamp and lightweight-charts rejects the whole series ("data must be asc
    // ordered by time"). When it is already there, setData carries it and the 1-second effect
    // keeps it updated in place.
    const lastTime = Number(data[data.length - 1].time);
    series.setData(forming && Number(forming.time) > lastTime ? [...data, forming] : data);

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
      // Enforce strictly-ascending, unique timestamps — lightweight-charts throws otherwise.
      const clean = points
        ? points.filter((p, i, arr) => Number.isFinite(p.value) && (i === 0 || Number(p.time) > Number(arr[i - 1].time)))
        : null;
      if (show && clean && clean.length >= 2) {
        if (!ref.current) ref.current = chart.addSeries(LineSeries, opts);
        ref.current.applyOptions(opts);
        ref.current.setData(clean);
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

    // Caller-supplied lines (Liquidity Chart). No-op when the prop is absent.
    if (Array.isArray(extraLines)) {
      for (const l of extraLines) {
        addAnalysisLine(l.price, l.color, l.title, l.dashed ? LineStyle.Dashed : LineStyle.Solid);
      }
    }

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

    // Ichimoku Kinko Hyo (9/26/52, displacement 26): Tenkan + Kijun + Chikou lines and the
    // Kumo — Span A/B projected 26 bars into the FUTURE with a true cloud fill painted by
    // KumoCloudPrimitive (green where A ≥ B, red where B > A), behind the candles.
    const ichi = showIchimoku && tfSec > 0 ? ichimokuData(data, tfSec) : null;
    if ((!showIchimoku || !ichi) && kumoRef.current && ichiSpanARef.current) {
      try { ichiSpanARef.current.detachPrimitive(kumoRef.current); } catch { /* series may be gone */ }
      kumoRef.current = null;
    }
    applyLine(ichiTenkanRef, !!ichi, ichi?.tenkan, { color: '#2962ff', lineWidth: 1, title: 'Tenkan 9', lastValueVisible: false, priceLineVisible: false });
    applyLine(ichiKijunRef, !!ichi, ichi?.kijun, { color: '#b71c1c', lineWidth: 1, title: 'Kijun 26', lastValueVisible: false, priceLineVisible: false });
    applyLine(ichiChikouRef, !!ichi, ichi?.chikou, { color: '#43a047', lineWidth: 1, lineStyle: LineStyle.Dotted, title: 'Chikou', lastValueVisible: false, priceLineVisible: false });
    applyLine(ichiSpanARef, !!ichi, ichi?.aPts, { color: 'rgba(8, 153, 129, 0.65)', lineWidth: 1, title: 'Span A', lastValueVisible: false, priceLineVisible: false });
    applyLine(ichiSpanBRef, !!ichi, ichi?.bPts, { color: 'rgba(242, 54, 69, 0.65)', lineWidth: 1, title: 'Span B', lastValueVisible: false, priceLineVisible: false });
    if (ichi && ichiSpanARef.current) {
      if (!kumoRef.current) {
        kumoRef.current = new KumoCloudPrimitive();
        try { ichiSpanARef.current.attachPrimitive(kumoRef.current); } catch { kumoRef.current = null; }
      }
      kumoRef.current?.setData(ichi.pairs);
      // Badge: where price sits vs the CURRENT cloud (the pair displaced onto the last bar)
      // plus the Tenkan/Kijun relation — the classic Ichimoku read at a glance.
      const nowT = Number(data[data.length - 1].time);
      const pairNow = ichi.pairs.find((p) => p.time === nowT) || null;
      const lastClose = data[data.length - 1].close;
      const tkLast = ichi.tenkan[ichi.tenkan.length - 1]?.value;
      const kjLast = ichi.kijun[ichi.kijun.length - 1]?.value;
      if (pairNow) {
        const cloudTop = Math.max(pairNow.a, pairNow.b);
        const cloudBot = Math.min(pairNow.a, pairNow.b);
        const pos = lastClose > cloudTop ? 'ABOVE' : lastClose < cloudBot ? 'BELOW' : 'INSIDE';
        const col = pos === 'ABOVE' ? '#089981' : pos === 'BELOW' ? '#f23645' : '#64748b';
        const tk = Number.isFinite(tkLast) && Number.isFinite(kjLast)
          ? (tkLast > kjLast ? 'TK>KJ' : tkLast < kjLast ? 'TK<KJ' : 'TK=KJ') : '';
        badgeChips.push(`<span class="font-black" style="color:${col}">☁ ${pos} KUMO</span><span class="text-slate-400">${tk}${pairNow.a >= pairNow.b ? ' · cloud bullish' : ' · cloud bearish'}</span>`);
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

    // Order blocks: transparent grey boxes behind the candles, with the bars that came back
    // to them circled. The primitive is attached once to the candle series and then simply
    // fed new data — re-attaching on every render leaks a primitive per pass.
    const obZones = showOrderBlocks ? detectOrderBlocks(data) : [];
    if (!obPrimitiveRef.current) {
      obPrimitiveRef.current = new OrderBlockPrimitive();
      try { series.attachPrimitive(obPrimitiveRef.current); } catch { obPrimitiveRef.current = null; }
    }
    obPrimitiveRef.current?.setData(obZones);
    const retestMarkers = obZones.length ? detectRetestBars(data, obZones) : [];
    if (obZones.length) {
      badgeChips.push(`<span class="font-black text-slate-500">▭ ${obZones.length} OB</span><span class="text-slate-400">${retestMarkers.length} retest${retestMarkers.length === 1 ? '' : 's'}</span>`);
    }

    const allMarkers = [...signalMarkers, ...patternMarkers, ...analysisMarkers, ...retestMarkers].sort((a, b) => Number(a.time) - Number(b.time));
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
  }, [candles, signals, symbol, timeframe, showVolume, showEma9, showEma21, showEma50, showEma200, showPatterns, showIchimoku, showTrend, showTrendlines, showZigzag, showDensity, showZones, showOrderBlocks, levels, extraLines]);

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
        const secs = secsToNextBar(tfSec, phaseRef.current);
        if (secs === null) {
          el.textContent = '';
        } else {
          const m = Math.floor(secs / 60);
          const s = secs % 60;
          // Says LIVE only when a real forming bar is arriving. A placeholder that called
          // itself live would be the chart claiming more than the feed supports.
          const fb = formingBarFor(lastClosedRef.current, tfSec, phaseRef.current, Date.now(), liveBarRef.current);
          const isLive = Boolean(fb && (fb as any).live);
          el.textContent = `${isLive ? '● LIVE' : '○ waiting for tick'} · next ${timeframe} in ${m}:${String(s).padStart(2, '0')}`;
        }
      }
      const series = seriesRef.current;
      if (!series) return;
      const forming = formingBarFor(lastClosedRef.current, tfSec, phaseRef.current, Date.now(), liveBarRef.current);
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

  // Keep the chart sized correctly when toggling fullscreen. Force an explicit resize across a
  // couple of frames (the layout settles over 1–2 frames) — preserves zoom, unlike fitContent.
  useEffect(() => {
    let r1 = 0, r2 = 0;
    r1 = window.requestAnimationFrame(() => {
      resizeChartRef.current?.();
      r2 = window.requestAnimationFrame(() => resizeChartRef.current?.());
    });
    // Lock body scroll while the chart is fullscreen so the page behind can't scroll under it.
    if (isFullscreen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); document.body.style.overflow = prev; };
    }
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); };
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
    : 'relative h-[clamp(300px,58vh,640px)] w-full overflow-hidden rounded-2xl border border-slate-100 bg-white';

  // When the in-chart symbol/TF switcher is shown, push the legend + badge down so
  // they don't sit under it.
  const hasSwitcher = Boolean(onSymbolChange || onTimeframeChange);
  const tfOpts = timeframeOptions?.length ? timeframeOptions : [timeframe];
  const symOpts = symbolOptions?.length ? symbolOptions : [symbol];

  return (
    <div className={wrapperClass}>
      <div className="relative h-full w-full overflow-hidden rounded-2xl">
        {/* Feed/status badge — only when expanded (fullscreen), top-center */}
        {isFullscreen && fullscreenBadge && (
          <div className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2">{fullscreenBadge}</div>
        )}

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
          {toggleBtn(showIchimoku, 'Ichimoku', () => setShowIchimoku((v) => !v), 'bg-cyan-50 text-cyan-700 border-cyan-200')}
          {toggleBtn(showPatterns, 'Patterns', () => setShowPatterns((v) => !v), 'bg-violet-50 text-violet-700 border-violet-200')}
          <span className="mx-0.5 h-4 w-px bg-slate-200" />
          {toggleBtn(showTrend, 'Trend', () => setShowTrend((v) => !v), 'bg-teal-50 text-teal-700 border-teal-200')}
          {toggleBtn(showTrendlines, 'Lines', () => setShowTrendlines((v) => !v), 'bg-rose-50 text-rose-700 border-rose-200')}
          {toggleBtn(showZigzag, 'ZigZag', () => setShowZigzag((v) => !v), 'bg-indigo-50 text-indigo-700 border-indigo-200')}
          {toggleBtn(showDensity, 'Density', () => setShowDensity((v) => !v), 'bg-amber-50 text-amber-700 border-amber-200')}
          {toggleBtn(showZones, 'Zones', () => setShowZones((v) => !v), 'bg-emerald-50 text-emerald-700 border-emerald-200')}
          {toggleBtn(showOrderBlocks, 'Order blocks', () => setShowOrderBlocks((v) => !v), 'bg-slate-100 text-slate-700 border-slate-300')}
          <button
            type="button"
            onClick={() => setAiOpen((v) => !v)}
            className={`rounded-lg border px-2.5 py-1 text-[11px] font-black transition-colors ${
              aiOpen ? 'border-violet-500 bg-violet-500 text-white' : 'border-violet-200 bg-violet-50 text-violet-700 hover:border-violet-400'
            }`}
            title={`Professional AI read of the live ${symbol} ${timeframe} chart`}
          >AI analysis</button>
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

        {/* AI trade-desk panel. Overlays the chart so the read sits beside the price action
            it describes. The style/direction choice happens BEFORE the read — a scalper and a
            day trader take different trades off the same chart. */}
        {aiOpen && (
          <div className="absolute inset-x-2 top-12 z-40 max-h-[88%] overflow-y-auto rounded-xl border border-violet-200 bg-white/97 p-3 shadow-xl backdrop-blur sm:inset-x-auto sm:right-2 sm:w-[24rem]">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-black uppercase tracking-wider text-violet-700">
                AI desk · {symbol} {timeframe}
              </p>
              <div className="flex items-center gap-2">
                {/* Closing is no longer destructive — every read is in history — but the way
                    back has to be visible, or the panel still feels like it lost the result. */}
                <button
                  type="button"
                  onClick={() => setAiHistoryOpen((v) => !v)}
                  className={`rounded-md border px-1.5 py-0.5 text-[10px] font-black transition ${
                    aiHistoryOpen
                      ? 'border-violet-500 bg-violet-500 text-white'
                      : 'border-violet-200 bg-violet-50 text-violet-700 hover:border-violet-400'
                  }`}
                  title={`Last ${MAX_ANALYSIS_HISTORY} saved reads`}
                >History{aiHistory.length ? ` (${aiHistory.length})` : ''}</button>
                <button type="button" onClick={() => setAiOpen(false)} className="text-[11px] font-bold text-slate-400 hover:text-slate-600">close</button>
              </div>
            </div>

            {aiHistoryOpen && (
              <div className="mt-2 rounded-lg border border-violet-200 bg-violet-50/60 p-1.5">
                <div className="flex items-center justify-between px-0.5">
                  <p className="text-[10px] font-black uppercase tracking-wider text-violet-700">
                    Saved reads · last {MAX_ANALYSIS_HISTORY}
                  </p>
                  {aiHistory.length > 0 && (
                    <button
                      type="button"
                      onClick={() => { setAiHistory(clearAnalysisHistory()); setAiViewingId(null); }}
                      className="text-[10px] font-bold text-slate-400 hover:text-rose-600"
                    >clear all</button>
                  )}
                </div>

                {aiHistory.length === 0 ? (
                  <p className="px-0.5 py-2 text-[10px] font-medium text-slate-500">
                    No saved reads yet. Every analysis you run is kept here automatically.
                  </p>
                ) : (
                  <ul className="mt-1 max-h-56 space-y-1 overflow-y-auto pr-0.5">
                    {aiHistory.map((h) => {
                      const when = new Date(h.savedAt);
                      const isCurrent = h.id === aiViewingId;
                      const isThisSeries = h.symbol === symbol && h.timeframe === timeframe;
                      return (
                        <li key={h.id}>
                          <div className={`flex items-center gap-1 rounded-md border px-1.5 py-1 transition ${
                            isCurrent ? 'border-violet-400 bg-white' : 'border-transparent bg-white/70 hover:border-violet-300'
                          }`}>
                            <button
                              type="button"
                              onClick={() => openStoredAnalysis(h)}
                              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                              title={`Reopen this read from ${when.toLocaleString()}`}
                            >
                              <span className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-black ${
                                h.result.verdict === 'TAKE' ? 'bg-emerald-100 text-emerald-800'
                                  : h.result.verdict === 'WATCH' ? 'bg-amber-100 text-amber-800' : 'bg-slate-200 text-slate-700'
                              }`}>{h.result.verdict || '—'}</span>
                              <span className="min-w-0 truncate text-[10px] font-black text-slate-700">
                                {h.symbol} {h.timeframe}
                                {/* Reads from other series stay listed but are marked, so a
                                    EURUSD read is never mistaken for the chart in front of you. */}
                                {!isThisSeries && <span className="ml-1 font-bold text-amber-600">other chart</span>}
                              </span>
                              <span className="ml-auto shrink-0 text-[9px] font-bold text-slate-400">
                                {h.style === 'SCALP' ? 'scalp' : 'day'} · {when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                const next = deleteAnalysis(h.id);
                                setAiHistory(next);
                                if (aiViewingId === h.id) { setAiViewingId(null); setAiOut(null); }
                              }}
                              className="shrink-0 px-0.5 text-[11px] font-bold leading-none text-slate-300 hover:text-rose-600"
                              title="Remove this read"
                            >×</button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}

            <div className="mt-2 flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 p-0.5">
              {(['SCALP', 'DAY'] as const).map((v) => (
                <button key={v} type="button" onClick={() => setAiStyle(v)}
                  className={`flex-1 rounded-md px-2 py-1 text-[11px] font-black transition ${
                    aiStyle === v ? 'bg-violet-600 text-white' : 'text-slate-500 hover:bg-white'
                  }`}>{v === 'SCALP' ? 'Scalping' : 'Day trading'}</button>
              ))}
            </div>

            {/* Direction is asked ONLY for scalping — a scalper usually has a side in mind and
                wants it stress-tested; a day read starts from the higher-timeframe bias. */}
            {aiStyle === 'SCALP' && (
              <div className="mt-1.5">
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Position you are considering</p>
                <div className="mt-1 flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 p-0.5">
                  {(['LONG', 'SHORT', 'BOTH'] as const).map((v) => (
                    <button key={v} type="button" onClick={() => setAiBias(v)}
                      className={`flex-1 rounded-md px-2 py-1 text-[11px] font-black transition ${
                        aiBias === v ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-white'
                      }`}>{v === 'BOTH' ? 'Open read' : v}</button>
                  ))}
                </div>
                {aiBias !== 'BOTH' && (
                  <p className="mt-1 text-[10px] font-medium text-slate-400">
                    It will judge whether a {aiBias.toLowerCase()} is justified — and say no if it is not.
                  </p>
                )}
              </div>
            )}

            <button type="button" onClick={runAi} disabled={aiBusy}
              className="mt-2 w-full rounded-lg bg-violet-600 px-3 py-2 text-xs font-black text-white transition hover:bg-violet-700 disabled:bg-slate-300">
              {aiBusy ? 'Reading the chart…' : 'Analyse this chart'}
            </button>

            {aiErr && <p className="mt-2 rounded-lg bg-rose-50 px-2 py-1.5 text-[11px] font-bold text-rose-700">{aiErr}</p>}

            {aiOut && (
              <div className="mt-2 space-y-2">
                {/* A read pulled back from history describes the chart as it was THEN. Price has
                    moved since, so the entry/stop levels below may no longer be valid — say so
                    explicitly rather than let an old ticket read as a live one. */}
                {(() => {
                  const viewed = aiHistory.find((h) => h.id === aiViewingId);
                  if (!viewed) return null;
                  const ageMin = Math.round((Date.now() - new Date(viewed.savedAt).getTime()) / 60000);
                  if (ageMin < 1) return null;
                  const stale = ageMin >= 15;
                  return (
                    <div className={`rounded-lg border px-2 py-1 ${
                      stale ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-slate-50'
                    }`}>
                      <p className={`text-[10px] font-bold ${stale ? 'text-amber-800' : 'text-slate-500'}`}>
                        Saved read from {new Date(viewed.savedAt).toLocaleString()} ·{' '}
                        {ageMin < 60 ? `${ageMin}m` : `${Math.floor(ageMin / 60)}h ${ageMin % 60}m`} ago
                        {stale && ' — levels may be out of date, re-run for a current read'}
                      </p>
                    </div>
                  );
                })()}
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${
                    aiOut.verdict === 'TAKE' ? 'bg-emerald-100 text-emerald-800'
                      : aiOut.verdict === 'WATCH' ? 'bg-amber-100 text-amber-800' : 'bg-slate-200 text-slate-700'
                  }`}>{aiOut.verdict || '—'}</span>
                  {/* The call itself. The field is `decision`, not `direction` — reading the
                      wrong name meant the panel never showed BUY or SELL at all.
                      Matched on /BUY|SELL/ rather than equality because the model also returns
                      STRONG_BUY and STRONG_SELL, which an === check silently painted as a sell.
                      Always rendered, including HOLD: "no trade" is an answer, and a blank
                      space reads as a missing one. */}
                  {(() => {
                    const call = String(aiOut.forexPlan?.decision || aiOut.fttPlan?.direction || '').toUpperCase();
                    if (!call) return null;
                    const buy = /BUY/.test(call);
                    const sell = /SELL/.test(call);
                    return (
                      <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[12px] font-black ${
                        buy ? 'bg-emerald-600 text-white' : sell ? 'bg-rose-600 text-white' : 'bg-slate-200 text-slate-700'
                      }`}>
                        {buy ? <TrendingUp size={12} /> : sell ? <TrendingDown size={12} /> : null}
                        {call.replace('_', ' ')}
                      </span>
                    );
                  })()}
                  <span className="text-[11px] font-bold text-slate-500">conf {aiOut.confidence ?? '—'}</span>
                  {aiOut.instrument && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-black text-slate-600">{aiOut.instrument}</span>}
                </div>

                {/* The ticket. Score and grade are computed server-side from checkable
                    evidence — geometry, R:R measured to the final target, engine agreement,
                    HTF alignment, stop sanity — not from the model's own confidence. */}
                {(() => {
                  const fp = aiOut.forexPlan as (typeof aiOut.forexPlan & {
                    setupScore?: number | null; setupGrade?: string | null;
                    scoreBreakdown?: Array<{ factor: string; points: number; why: string }>;
                    scoreNote?: string | null; lots?: number | null;
                    suggestedLots?: number | null; sizingIsHypothetical?: boolean;
                    stopPips?: number | null; lossAtStop?: number | null;
                  }) | null | undefined;
                  if (!fp) return null;
                  // No entry => no ticket. Say so plainly rather than rendering empty fields.
                  if (fp.entry == null) {
                    return fp.scoreNote ? (
                      <p className="rounded-lg bg-slate-100 px-2 py-1.5 text-[11px] font-bold text-slate-500">{fp.scoreNote}</p>
                    ) : null;
                  }
                  // Confidence gate. Below the bar the levels are withheld rather than shown
                  // greyed out: a price on screen is a price someone acts on, and a low-conviction
                  // entry/SL/TP reads exactly like a high-conviction one once it is in front of you.
                  // The reason is always stated — a panel that silently drops its numbers is worse
                  // than one that shows them, because the user cannot tell it from a bug.
                  const conf = typeof aiOut.confidence === 'number' ? aiOut.confidence : null;
                  if (conf === null || conf < AI_PLAN_MIN_CONFIDENCE) {
                    return (
                      <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2">
                        <p className="text-[11px] font-black text-slate-600">
                          Trade levels hidden{conf === null ? ' — no confidence reported' : ` — confidence ${conf}`}
                        </p>
                        <p className="mt-0.5 text-[10px] font-medium leading-snug text-slate-500">
                          {conf === null
                            ? 'The model did not return a confidence value, so this read cannot be shown to clear the bar.'
                            : `Entry, stop, targets and sizing are shown only at ${AI_PLAN_MIN_CONFIDENCE} or above. The read below still stands — it just is not a ticket.`}
                        </p>
                      </div>
                    );
                  }
                  const gradeCls = fp.setupGrade === 'A+' || fp.setupGrade === 'A' ? 'bg-emerald-600'
                    : fp.setupGrade === 'B' ? 'bg-sky-600'
                      : fp.setupGrade === 'C' ? 'bg-amber-600' : 'bg-rose-600';
                  const row = (k: string, v: React.ReactNode) => (
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{k}</span>
                      <span className="font-mono text-[11px] font-black text-slate-800">{v}</span>
                    </div>
                  );
                  return (
                    <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2">
                      <div className="mb-1.5 flex items-center gap-2">
                        {fp.setupGrade && (
                          <span className={`rounded px-2 py-0.5 text-[11px] font-black text-white ${gradeCls}`}>{fp.setupGrade}</span>
                        )}
                        {fp.setupScore != null && (
                          <span className="text-[11px] font-black text-slate-600">score {fp.setupScore}</span>
                        )}
                        {fp.riskReward != null && (
                          <span className="ml-auto rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-black text-white">
                            1:{fp.riskReward}
                          </span>
                        )}
                      </div>
                      <div className="space-y-0.5">
                        {row('Entry', fp.entry)}
                        {row('Stop loss', <span className="text-rose-600">{fp.stopLoss ?? '—'}</span>)}
                        {fp.takeProfit1 != null && row('TP1', <span className="text-emerald-700">{fp.takeProfit1}</span>)}
                        {fp.takeProfit2 != null && row('TP2', <span className="text-emerald-700">{fp.takeProfit2}</span>)}
                        {fp.takeProfit3 != null && row('TP3', <span className="text-emerald-700">{fp.takeProfit3}</span>)}
                        {/* Lot size. When the call is not tradeable the number is still shown —
                            stop distance and risk-at-stop were already displayed on a HOLD, so
                            hiding only the lot size was inconsistent rather than cautious — but
                            it is labelled so it can never read as a live position. */}
                        {fp.lots != null
                          ? row('Lot size', fp.lots)
                          : fp.suggestedLots != null && row(
                            'Lot size (if taken)',
                            <span className="text-slate-500">{fp.suggestedLots}</span>,
                          )}
                        {fp.stopPips != null && row('Stop', `${fp.stopPips} pips`)}
                        {fp.lossAtStop != null && row('Risk at stop', `$${fp.lossAtStop}`)}
                      </div>
                      {/* Send it to MT5. Only for an actionable call on a live read — a saved
                          read from history describes a chart that has since moved, and its
                          prices are no longer a ticket. */}
                      {(() => {
                        const tradeable = /BUY|SELL/.test(String(fp.decision || '').toUpperCase());
                        const isSaved = aiViewingId !== null && aiHistory.some((h) => h.id === aiViewingId && Date.now() - new Date(h.savedAt).getTime() > 60000);
                        if (!tradeable || !aiOut.trackId) return null;
                        return (
                          <div className="mt-2 border-t border-slate-200 pt-2">
                            {isSaved ? (
                              <p className="text-[10px] font-bold text-slate-400">
                                Saved read — re-run the analysis to place this on live prices.
                              </p>
                            ) : orderPlaced ? (
                              <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-2 py-1.5">
                                <p className="text-[11px] font-black text-emerald-800">
                                  {orderPlaced.orderType} order queued · {orderPlaced.lots} lots @ {orderPlaced.entry}
                                </p>
                                <p className="mt-0.5 text-[10px] font-medium text-emerald-700">{orderPlaced.note}</p>
                                {orderPlaced.warnings.length > 0 && (
                                  <p className="mt-0.5 text-[10px] font-bold text-amber-700">{orderPlaced.warnings.join(' · ')}</p>
                                )}
                              </div>
                            ) : orderPreview ? (
                              <div className="rounded-lg border border-violet-300 bg-violet-50 px-2 py-1.5">
                                <p className="text-[10px] font-black uppercase tracking-wider text-violet-700">
                                  Confirm · {orderPreview.validation.verdict}
                                </p>
                                <p className="mt-0.5 font-mono text-[11px] font-black text-slate-800">
                                  {orderPreview.direction} {orderPreview.ticket.lots} lots @ {orderPreview.entry} · SL {orderPreview.ticket.stopLoss}
                                </p>
                                <p className="text-[10px] font-bold text-slate-600">
                                  Risk ${orderPreview.ticket.riskUsd} · {orderPreview.ticket.stopPips} pips
                                  {orderPreview.ticket.rr != null && ` · 1:${orderPreview.ticket.rr}`}
                                </p>
                                {/* Warnings are shown BEFORE the confirm button, never after. */}
                                {orderPreview.validation.warnings.map((w) => (
                                  <p key={w} className="mt-0.5 text-[10px] font-bold leading-snug text-amber-700">⚠ {w}</p>
                                ))}
                                <div className="mt-1.5 flex gap-1.5">
                                  <button
                                    type="button" disabled={orderBusy}
                                    onClick={() => void doPlaceOrder(aiOut.trackId as string)}
                                    className="flex-1 rounded-lg bg-violet-600 px-2 py-1.5 text-[11px] font-black text-white transition hover:bg-violet-700 disabled:bg-slate-300"
                                  >{orderBusy ? 'Sending…' : 'Confirm & send to MT5'}</button>
                                  <button
                                    type="button" onClick={resetOrderState}
                                    className="rounded-lg border border-slate-300 px-2 py-1.5 text-[11px] font-bold text-slate-500 hover:bg-white"
                                  >Cancel</button>
                                </div>
                              </div>
                            ) : (
                              <button
                                type="button" disabled={orderBusy}
                                onClick={() => void doPreviewOrder(aiOut.trackId as string)}
                                className="w-full rounded-lg border border-violet-300 bg-white px-2 py-1.5 text-[11px] font-black text-violet-700 transition hover:border-violet-500 hover:bg-violet-50 disabled:text-slate-400"
                              >{orderBusy ? 'Sizing…' : 'Place as resting order →'}</button>
                            )}
                            {orderErr && (
                              <p className="mt-1 rounded-lg bg-rose-50 px-2 py-1 text-[10px] font-bold leading-snug text-rose-700">{orderErr}</p>
                            )}
                          </div>
                        );
                      })()}

                      {/* Why this grade — an unexplained score is indistinguishable from a guess. */}
                      {fp.scoreBreakdown && fp.scoreBreakdown.length > 0 && (
                        <details className="mt-1.5">
                          <summary className="cursor-pointer text-[10px] font-bold uppercase tracking-wider text-slate-400 hover:text-slate-600">
                            why this grade
                          </summary>
                          <div className="mt-1 space-y-0.5">
                            {fp.scoreBreakdown.map((b) => (
                              <div key={b.factor} className="flex items-baseline gap-1.5 text-[10px]">
                                <span className={`w-7 shrink-0 text-right font-mono font-black ${b.points >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>
                                  {b.points >= 0 ? '+' : ''}{b.points}
                                </span>
                                <span className="font-bold text-slate-600">{b.factor}</span>
                                <span className="text-slate-400">{b.why}</span>
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
                    </div>
                  );
                })()}

                {/* Strategy agreement — INFORMATION. The AI read independently; this only says
                    whether the deterministic engines happened to land the same way. */}
                {aiOut.strategyMatch && (
                  <div className={`rounded-lg border px-2 py-1.5 ${
                    aiOut.strategyMatch.verdict === 'ALIGNED' ? 'border-emerald-200 bg-emerald-50'
                      : aiOut.strategyMatch.verdict === 'CONTRARY' ? 'border-rose-200 bg-rose-50'
                        : 'border-slate-200 bg-slate-50'
                  }`}>
                    <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">
                      Strategy match <span className="font-semibold normal-case tracking-normal text-slate-400">— information only</span>
                    </p>
                    <p className="mt-0.5 text-[11px] font-bold text-slate-700">{aiOut.strategyMatch.note}</p>
                    {aiOut.strategyMatch.agreeing.length > 0 && (
                      <p className="mt-1 text-[10px] font-bold text-emerald-700">
                        agrees: {aiOut.strategyMatch.agreeing.map((x) => x.name || x.id).join(', ')}
                      </p>
                    )}
                    {aiOut.strategyMatch.opposing.length > 0 && (
                      <p className="mt-0.5 text-[10px] font-bold text-rose-700">
                        disagrees: {aiOut.strategyMatch.opposing.map((x) => x.name || x.id).join(', ')}
                      </p>
                    )}
                  </div>
                )}

                {/* MARKET READ — the structured facts, as scannable chips. These come back as
                    discrete fields, so rendering them as chips instead of leaving them buried
                    in the prose is free readability. */}
                {(() => {
                  const d = aiOut.detection || {};
                  const chips: Array<[string, string, string]> = [];
                  if (d.trend) chips.push(['trend', String(d.trend), 'bg-slate-100 text-slate-700']);
                  if (d.regime) chips.push(['regime', String(d.regime), 'bg-slate-100 text-slate-700']);
                  // 'NONE' is the absence of a breakout, not a fact worth a chip.
                  if (d.breakout?.phase && String(d.breakout.phase).toUpperCase() !== 'NONE') {
                    chips.push(['breakout', `${d.breakout.phase}${d.breakout.direction ? ` ${d.breakout.direction}` : ''}`,
                      d.breakout.phase === 'CONFIRMED' ? 'bg-violet-100 text-violet-700' : 'bg-slate-100 text-slate-600']);
                  }
                  if (!chips.length && !(d.patterns || []).length) return null;
                  return (
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Market read</p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {chips.map(([k, v, cls]) => (
                          <span key={k} className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${cls}`}>
                            <span className="opacity-60">{k}</span> {v}
                          </span>
                        ))}
                        {(d.patterns || []).slice(0, 4).map((pt) => (
                          <span key={String(pt)} className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-bold text-indigo-700">{String(pt)}</span>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {/* WHY — the model already returns discrete key factors. Bullets are far easier
                    to scan than the same points buried in a paragraph. */}
                {(aiOut.keyFactors || []).length > 0 && (
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Why</p>
                    <ul className="mt-1 space-y-0.5">
                      {(aiOut.keyFactors || []).slice(0, 6).map((f, i) => (
                        <li key={i} className="flex gap-1.5 text-[11px] font-medium leading-snug text-slate-600">
                          <span className="mt-[3px] h-1 w-1 shrink-0 rounded-full bg-violet-400" />
                          <span>{f}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* INVALIDATION — what kills the idea. Distinct from the rationale and the most
                    actionable line in the whole read, so it gets its own box. */}
                {aiOut.forexPlan?.invalidation && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5">
                    <p className="text-[10px] font-black uppercase tracking-wider text-amber-700">Invalidated if</p>
                    <p className="mt-0.5 text-[11px] font-semibold leading-snug text-amber-900">{aiOut.forexPlan.invalidation}</p>
                  </div>
                )}

                {/* The full rationale stays available but collapsed — it was dominating the panel
                    as a wall of text, which is what made the read hard to use. */}
                {aiOut.reasoning && (
                  <details>
                    <summary className="cursor-pointer text-[10px] font-black uppercase tracking-wider text-slate-400 hover:text-slate-600">
                      full rationale
                    </summary>
                    <p className="mt-1 whitespace-pre-wrap text-[11px] font-medium leading-relaxed text-slate-600">{aiOut.reasoning}</p>
                  </details>
                )}

                {aiOut.dataFresh === false && (
                  <p className="rounded bg-amber-50 px-2 py-1 text-[10px] font-bold text-amber-800">
                    Candles are not live — last-session study, not a live signal.
                  </p>
                )}
                <p className="text-[10px] font-medium text-slate-400">
                  An independent second opinion. It never places a trade and never feeds the auto-trader.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Chart canvas — always mounted so the chart instance never loses its container
            (prevents a blank chart if candles briefly empty then return). */}
        <div ref={containerRef} className="absolute inset-0" />

        {/* Waiting overlay while there's no candle data (kept as an overlay, not a replacement). */}
        {!candles.length && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-50/70 text-center backdrop-blur-[1px]">
            <div>
              <p className="font-bold text-slate-600">Waiting for MT5 candle data…</p>
              <p className="mt-1 text-sm text-slate-400">{symbol} · {timeframe}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
