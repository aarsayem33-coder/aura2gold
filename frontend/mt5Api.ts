import React, { useEffect, useMemo, useRef, useState, createContext, useContext } from 'react';
import type {
  StrategyPredictionResponse,
  PredictionReportResponse,
  SetupForecastResponse,
  SetupForecastReportResponse,
  AutoTradePendingResponse,
  ForecastAiResponse,
  StrategyRatesResponse,
  TrackedForecastResponse,
  ForecastPendingResponse,
  IctPredictionResponse,
  IctTrackedResponse,
  IctPendingResponse,
  IctTrackRecordResponse,
  IctAiResponse,
  RepriceResponse,
  LiquidityChartResponse,
  LiquidityRankResponse,
  Alert,
  AiAccuracyStats,
  AiAnalyzeResponse,
  AiDecision,
  AiDecisionResponse,
  CalibrationResponse,
  WouldSuppressResponse,
  SignalLogResponse,
  ProjectionTrackRecord,
  ForexBacktestResponse,
  EmailAlertSettings,
  EmailAlertSettingsResponse,
  FttHistoryResponse,
  FttPredictResponse,
  FttPrediction,
  FttScanResponse,
  FttScanResult,
  IndicatorResponse,
  IndicatorValue,
  Mt5AccountResponse,
  Mt5AccountSnapshot,
  Mt5Candle,
  Mt5CandleCoverageResponse,
  Mt5CandleResponse,
  Mt5HistoryResponse,
  Mt5LogsResponse,
  Mt5SignalResponse,
  Mt5Status,
  SignalEmailReportsResponse,
  Mt5Trade,
  Mt5TradeResponse,
  NotificationLog,
  NewsResponse,
  NewsSignalResponse,
  PostNewsSignal,
  PostNewsSignalResponse,
  ProjectionScanResponse,
  ProjectionAnalyzeResponse,
  ScanAllResponse,
  ScanResult,
  TopbarMarketAlert,
  TrackedAiProjection,
  TrackedAiProjectionResponse,
  TradeNewsFixedSignal,
  TradeNewsForexSignal,
  TradeNewsResponse,
  ExecutionForecast,
  ForecastResponse,
  ForecastAnalysis,
  ForecastCalibrationResponse,
  ForecastReplayResponse,
  ForecastOutcomeResponse,
  DayTradingBriefResponse,
  StructureDeskResponse,
  LiveMarketTrackerResponse,
  KeyLevelProximityResponse,
  ChallengeDashboard,
  AutoTradeStatus,
  AutoTradeReport,
  AutoTradeConfig,
  AutoTradeComboSet,
  AutoTradeValidation,
  SignalTrackerResponse,
  StrategyMeta,
  StrategySignal,
  StrategyPerformanceResponse,
  ConfluenceResponse,
  ChartAnalysisResponse,
  StrategyLiveResponse,
  StrategyFttLiveResponse,
  StrategyEntryWatchResponse,
  BreakoutLiveResponse,
  BreakoutAlertsResponse,
  BreakoutTrackingResponse,
  WouldTradeResponse,
} from './types';
import { playAlertSound, showBrowserNotification } from './utils/notifications';

const emptyStatus: Mt5Status = {
  connected: false,
  lastHeartbeatAt: null,
  lastSignalAt: null,
  account: null,
  broker: null,
  terminal: null,
  version: null,
  accountSnapshot: null,
  signalCount: 0,
  candleCount: 0,
  tradeCount: 0,
  indicatorCount: 0,
  aiDecisionCount: 0,
  openTradesCount: 0,
  symbols: [],
  timeframes: [],
  latestSignal: null,
  latestCandle: null,
  latestTrade: null,
  latestAiDecision: null,
  serverTime: new Date().toISOString(),
  ingestUrl: '/api/mt5/signals',
  heartbeatUrl: '/api/mt5/heartbeat',
  snapshotUrl: '/api/mt5/snapshot',
  candlesUrl: '/api/mt5/candles',
  tradesUrl: '/api/mt5/trades',
};

function numberOrNull(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeAlert(alert: Alert): Alert {
  return {
    ...alert,
    price: Number(alert.price || 0),
    bid: alert.bid === undefined ? null : alert.bid,
    ask: alert.ask === undefined ? null : alert.ask,
    volume: alert.volume === undefined ? null : alert.volume,
  };
}

function normalizeCandle(candle: Mt5Candle): Mt5Candle {
  let normalizedTime = candle.time;
  if (candle.time) {
    try {
      const parsed = new Date(candle.time);
      if (!Number.isNaN(parsed.getTime())) {
        normalizedTime = parsed.toISOString();
      }
    } catch (e) {
      console.warn('[mt5Api] Failed to normalize candle time:', candle.time, e);
    }
  }
  return {
    ...candle,
    time: normalizedTime,
    open: numberOrNull(candle.open),
    high: numberOrNull(candle.high),
    low: numberOrNull(candle.low),
    close: numberOrNull(candle.close),
    volume: candle.volume === undefined ? null : numberOrNull(candle.volume),
    spread: candle.spread === undefined ? null : numberOrNull(candle.spread),
  };
}

function normalizeTrade(trade: Mt5Trade): Mt5Trade {
  return {
    ...trade,
    volume: numberOrNull(trade.volume),
    openPrice: numberOrNull(trade.openPrice),
    currentPrice: numberOrNull(trade.currentPrice),
    stopLoss: numberOrNull(trade.stopLoss),
    takeProfit: numberOrNull(trade.takeProfit),
    profit: numberOrNull(trade.profit),
    swap: trade.swap === undefined ? null : numberOrNull(trade.swap),
    commission: trade.commission === undefined ? null : numberOrNull(trade.commission),
  };
}

function normalizeLog(log: NotificationLog): NotificationLog {
  return { ...log, timestamp: log.timestamp };
}

function normalizeAiDecision(decision: AiDecision): AiDecision {
  return {
    ...decision,
    confidence: numberOrNull(decision.confidence) || 0,
    entry_price: decision.entry_price === undefined ? null : numberOrNull(decision.entry_price),
    stop_loss: decision.stop_loss === undefined ? null : numberOrNull(decision.stop_loss),
    take_profit_1: decision.take_profit_1 === undefined ? null : numberOrNull(decision.take_profit_1),
    take_profit_2: decision.take_profit_2 === undefined ? null : numberOrNull(decision.take_profit_2),
    take_profit_3: decision.take_profit_3 === undefined ? null : numberOrNull(decision.take_profit_3),
    risk_reward_ratio: decision.risk_reward_ratio === undefined ? null : numberOrNull(decision.risk_reward_ratio),
    trade_trigger: decision.trade_trigger || (decision.market_context as any)?.tradeTrigger || null,
    predicted_time: decision.predicted_time || (decision.market_context as any)?.predictedTime || null,
  };
}

function normalizeTrackedAiProjection(item: TrackedAiProjection): TrackedAiProjection {
  return {
    ...item,
    entryPrice: item.entryPrice === undefined ? null : numberOrNull(item.entryPrice),
    stopLoss: item.stopLoss === undefined ? null : numberOrNull(item.stopLoss),
    takeProfit1: item.takeProfit1 === undefined ? null : numberOrNull(item.takeProfit1),
    takeProfit2: item.takeProfit2 === undefined ? null : numberOrNull(item.takeProfit2),
    takeProfit3: item.takeProfit3 === undefined ? null : numberOrNull(item.takeProfit3),
    invalidationPrice: item.invalidationPrice === undefined ? null : numberOrNull(item.invalidationPrice),
    confidence: numberOrNull(item.confidence) || 0,
    currentPrice: item.currentPrice === undefined ? null : numberOrNull(item.currentPrice),
  };
}

function upsertById<T extends { id: string }>(items: T[], item: T, limit = 300) {
  return [item, ...items.filter((existing) => existing.id !== item.id)].slice(0, limit);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`Request failed for ${url}: ${response.status}`);
  return response.json() as Promise<T>;
}

function getLocalBackendUrl(path: string) {
  if (typeof window === 'undefined') return path;
  return `http://127.0.0.1:5000${path}`;
}

async function fetchTrackedJson<T>(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(path, init);
  if (response.status === 404 && typeof window !== 'undefined' && window.location.port === '5173') {
    return fetch(getLocalBackendUrl(path), init);
  }
  return response;
}

export async function fetchMt5Status(): Promise<Mt5Status> {
  return fetchJson<Mt5Status>('/api/mt5/status');
}

export async function fetchMt5Signals(limit = 100): Promise<Mt5HistoryResponse> {
  const response = await fetchJson<Mt5HistoryResponse>(`/api/mt5/signals?limit=${limit}&candleLimit=5000&tradeLimit=200`);
  return {
    ...response,
    signals: response.signals.map(normalizeAlert),
    candles: (response.candles || []).map(normalizeCandle),
    trades: (response.trades || []).map(normalizeTrade),
  };
}

export async function fetchMt5Candles(symbol?: string, timeframe?: string, limit = 500): Promise<Mt5CandleResponse> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (symbol) params.set('symbol', symbol);
  if (timeframe) params.set('timeframe', timeframe);
  const response = await fetchJson<Mt5CandleResponse>(`/api/mt5/candles?${params.toString()}`);
  return { ...response, candles: response.candles.map(normalizeCandle) };
}

export async function fetchMt5CandleCoverage(): Promise<Mt5CandleCoverageResponse> {
  return fetchJson<Mt5CandleCoverageResponse>('/api/mt5/history/coverage');
}

export async function fetchMt5Trades(limit = 200): Promise<Mt5TradeResponse> {
  const response = await fetchJson<Mt5TradeResponse>(`/api/mt5/trades?limit=${limit}`);
  return { ...response, trades: response.trades.map(normalizeTrade) };
}

export async function fetchMt5Account(): Promise<Mt5AccountResponse> {
  return fetchJson<Mt5AccountResponse>('/api/mt5/account');
}

export async function fetchMt5Logs(limit = 100): Promise<NotificationLog[]> {
  const response = await fetchJson<Mt5LogsResponse>(`/api/notifications/logs?limit=${limit}`);
  return response.logs.map(normalizeLog);
}

export async function fetchEmailAlertSettings(): Promise<EmailAlertSettingsResponse> {
  return fetchJson<EmailAlertSettingsResponse>('/api/notifications/email-settings');
}

export async function saveEmailAlertSettings(settings: EmailAlertSettings): Promise<EmailAlertSettingsResponse> {
  const response = await fetch('/api/notifications/email-settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.error || `Failed to save email settings: ${response.status}`);
  }
  return response.json() as Promise<EmailAlertSettingsResponse>;
}

export async function fetchLatestIndicators(symbol?: string, timeframe?: string): Promise<IndicatorValue[]> {
  const params = new URLSearchParams();
  if (symbol) params.set('symbol', symbol);
  if (timeframe) params.set('timeframe', timeframe);
  const response = await fetchJson<IndicatorResponse>(`/api/mt5/indicators/latest?${params.toString()}`);
  return response.indicators;
}

export async function fetchAiDecisions(symbol?: string, timeframe?: string, limit = 100): Promise<AiDecision[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (symbol) params.set('symbol', symbol);
  if (timeframe) params.set('timeframe', timeframe);
  const response = await fetchJson<AiDecisionResponse>(`/api/ai/decisions?${params.toString()}`);
  return response.decisions.map(normalizeAiDecision);
}

export async function fetchLatestAiDecisions(): Promise<AiDecisionResponse> {
  const response = await fetchJson<AiDecisionResponse>('/api/ai/decisions/latest');
  return { ...response, decisions: response.decisions.map(normalizeAiDecision), latest: response.latest ? normalizeAiDecision(response.latest) : null };
}

export async function triggerAiAnalysis(symbol: string, timeframe = 'M5'): Promise<AiAnalyzeResponse> {
  const response = await fetch('/api/ai/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol, timeframe, force: true }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.error || `AI analysis failed: ${response.status}`);
  }
  const payload = (await response.json()) as AiAnalyzeResponse;
  return { ...payload, decision: normalizeAiDecision(payload.decision) };
}

// Upload a chart screenshot (base64) → AI vision trade plan, with deterministic fallback.
export async function fetchChartAnalysis(payload: {
  imageBase64?: string;
  mimeType: string;
  symbol: string;
  timeframe: string;
  tradeMode: 'FOREX' | 'FTT' | 'BOTH';
  // Professional-trader mode. Omit both and the original generic prompt is used.
  // imageBase64 may be empty: the server then renders the chart itself from the same candles
  // it analyses, so the AI sees the live market without anyone uploading a screenshot.
  style?: 'SCALP' | 'DAY';
  bias?: 'LONG' | 'SHORT' | 'BOTH';
}): Promise<ChartAnalysisResponse> {
  const response = await fetch('/api/ai/analyze-chart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.error || `Chart analysis failed: ${response.status}`);
  }
  return (await response.json()) as ChartAnalysisResponse;
}

export async function triggerAllSymbolsScan(timeframe = 'M5', symbols?: string[]): Promise<ScanAllResponse> {
  const response = await fetch('/api/signals/scan-all', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(symbols && symbols.length ? { timeframe, symbols } : { timeframe }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.error || `Scan failed: ${response.status}`);
  }
  const payload = (await response.json()) as ScanAllResponse;
  return {
    ...payload,
    results: payload.results.map((r) => ({
      ...r,
      latestAiDecision: r.latestAiDecision ? normalizeAiDecision(r.latestAiDecision) : null,
    })),
  };
}

export async function fetchAiAccuracy(): Promise<AiAccuracyStats> {
  return fetchJson<AiAccuracyStats>('/api/ai/accuracy');
}

export async function fetchEconomicNews(options: { symbol?: string; hours?: number; minImpact?: string } = {}): Promise<NewsResponse> {
  const params = new URLSearchParams();
  if (options.symbol) params.set('symbol', options.symbol);
  if (options.hours) params.set('hours', String(options.hours));
  if (options.minImpact) params.set('minImpact', options.minImpact);
  const query = params.toString();
  return fetchJson<NewsResponse>(`/api/mt5/news${query ? `?${query}` : ''}`);
}

export async function refreshNewsFallback(): Promise<{ ok: boolean; result?: unknown; sources?: unknown }> {
  const response = await fetch('/api/mt5/news/refresh', { method: 'POST' });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error((error as any)?.error || `News refresh failed: ${response.status}`);
  }
  return response.json();
}

export async function fetchNewsSignals(options: { minImpact?: string; hours?: number } = {}): Promise<NewsSignalResponse> {
  const params = new URLSearchParams();
  if (options.minImpact) params.set('minImpact', options.minImpact);
  if (options.hours) params.set('hours', String(options.hours));
  const query = params.toString();
  return fetchJson<NewsSignalResponse>(`/api/news/signals${query ? `?${query}` : ''}`);
}

export async function fetchPostNewsSignals(): Promise<PostNewsSignalResponse> {
  return fetchJson<PostNewsSignalResponse>('/api/news/post-signals');
}

export async function fetchLatestForexSignals(): Promise<{ signals: ScanResult[]; count: number; generatedAt: string }> {
  return fetchJson<{ signals: ScanResult[]; count: number; generatedAt: string }>('/api/signals/latest');
}

export async function fetchForecasts(): Promise<ForecastResponse> {
  return fetchJson<ForecastResponse>('/api/forecasts');
}

export async function fetchForecastCalibration(days = 90): Promise<ForecastCalibrationResponse> {
  return fetchJson<ForecastCalibrationResponse>(`/api/reports/forecast-calibration?days=${days}`);
}

export async function fetchForecastReplay(symbol: string, timeframe: string, bars = 1500): Promise<ForecastReplayResponse> {
  return fetchJson<ForecastReplayResponse>(`/api/reports/forecast-replay?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}&bars=${bars}`);
}

export async function fetchForecastOutcomes(days = 30, symbol?: string): Promise<ForecastOutcomeResponse> {
  const sym = symbol ? `&symbol=${encodeURIComponent(symbol)}` : '';
  return fetchJson<ForecastOutcomeResponse>(`/api/reports/forecast-outcomes?days=${days}${sym}`);
}

export async function fetchDayTradingBrief(timeframe?: string): Promise<DayTradingBriefResponse> {
  const tf = timeframe ? `?timeframe=${encodeURIComponent(timeframe)}` : '';
  return fetchJson<DayTradingBriefResponse>(`/api/day-trading/brief${tf}`);
}

export async function fetchStructureDesk(symbol?: string, timeframe = 'M5'): Promise<StructureDeskResponse> {
  const params = new URLSearchParams({ timeframe });
  if (symbol) params.set('symbol', symbol);
  return fetchJson<StructureDeskResponse>(`/api/day-trading/desk?${params.toString()}`);
}

export async function fetchSignalTracker(): Promise<SignalTrackerResponse> {
  return fetchJson<SignalTrackerResponse>('/api/signal-tracker');
}

export async function fetchLiveMarketTracker(symbol?: string, timeframe = 'M5'): Promise<LiveMarketTrackerResponse> {
  const params = new URLSearchParams({ timeframe });
  if (symbol) params.set('symbol', symbol);
  return fetchJson<LiveMarketTrackerResponse>(`/api/live-market-tracker?${params.toString()}`);
}

export async function fetchKeyLevelProximity(sensitivity?: string): Promise<KeyLevelProximityResponse> {
  const params = new URLSearchParams();
  if (sensitivity) params.set('sensitivity', sensitivity);
  const qs = params.toString();
  return fetchJson<KeyLevelProximityResponse>(`/api/key-level-proximity${qs ? `?${qs}` : ''}`);
}

export async function fetchAutoTradeStatus(): Promise<AutoTradeStatus> {
  return fetchJson<AutoTradeStatus>('/api/auto-trade');
}
export async function fetchAutoTradeReport(params: { from?: string; to?: string; broker?: string; account?: string } = {}): Promise<AutoTradeReport> {
  const q = new URLSearchParams();
  if (params.from) q.set('from', params.from);
  if (params.to) q.set('to', params.to);
  if (params.broker) q.set('broker', params.broker);
  // An explicit account wins over the broker filter — one broker can hold several accounts.
  if (params.account) q.set('account', params.account);
  const qs = q.toString();
  return fetchJson<AutoTradeReport>(`/api/auto-trade/report${qs ? `?${qs}` : ''}`);
}
/** Per-symbol contract specs the EA reported, with the derived pip/spread maths. */
export interface BrokerSpecRow {
  symbol: string; point: number; digits: number; tickValue: number; tickSize: number;
  contractSize: number; stopsLevel: number; spread: number;
  volMin: number; volMax: number; volStep: number; marginPerLot?: number;
  derived: {
    pipSize: number; valuePerPricePerLot: number | null; valuePerPipPerLot: number | null;
    minStopDistancePips: number | null; spreadPips: number | null;
  };
}
export async function fetchBrokerSpecs(): Promise<{
  account: string | null; broker: string | null; demo: boolean | null;
  leverage: number | null; freeMargin: number | null; count: number; specs: BrokerSpecRow[];
}> {
  return fetchJson('/api/auto-trade/broker-specs');
}

export async function fetchAutoTradeComboSets(): Promise<{ sets: AutoTradeComboSet[] }> {
  return fetchJson('/api/auto-trade/combo-sets');
}
export async function saveAutoTradeComboSet(name: string, combos: string[]): Promise<{ ok: boolean; name: string; combos: string[] }> {
  return fetchJson('/api/auto-trade/combo-sets', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, combos }),
  });
}
export async function deleteAutoTradeComboSet(name: string): Promise<{ ok: boolean }> {
  return fetchJson(`/api/auto-trade/combo-sets/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

export async function validateAutoTrade(config: Partial<AutoTradeConfig>): Promise<AutoTradeValidation> {
  return fetchJson<AutoTradeValidation>('/api/auto-trade/validate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config }),
  });
}
export async function approveAutoTrade(id: string): Promise<{ ok: boolean }> {
  return fetchJson(`/api/auto-trade/${encodeURIComponent(id)}/approve`, { method: 'POST' });
}
export async function rejectAutoTrade(id: string): Promise<{ ok: boolean }> {
  return fetchJson(`/api/auto-trade/${encodeURIComponent(id)}/reject`, { method: 'POST' });
}
export async function armAutoTradeAccount(account: string | null): Promise<{ ok: boolean; armed: string | null }> {
  return fetchJson('/api/auto-trade/arm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account }) });
}

export async function fetchChallenge(account?: string): Promise<ChallengeDashboard> {
  return fetchJson<ChallengeDashboard>(`/api/challenge${account ? `?account=${encodeURIComponent(account)}` : ''}`);
}
export async function logChallengeTrade(pnl: number, note?: string): Promise<ChallengeDashboard> {
  return fetchJson<ChallengeDashboard>('/api/challenge/trade', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pnl, note }) });
}
export async function setChallengeBalance(balance: number): Promise<ChallengeDashboard> {
  return fetchJson<ChallengeDashboard>('/api/challenge/balance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ balance }) });
}
/** Correct the STARTING balance and keep the run (history, day totals, trade log). */
export async function setChallengeInitialBalance(initialBalance: number): Promise<ChallengeDashboard> {
  return fetchJson<ChallengeDashboard>('/api/challenge/initial-balance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initialBalance }) });
}
export async function resetChallenge(initialBalance?: number): Promise<ChallengeDashboard> {
  return fetchJson<ChallengeDashboard>('/api/challenge/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initialBalance }) });
}

export async function fetchStrategies(): Promise<{ ok: boolean; strategies: StrategyMeta[]; symbols: string[]; timeframes: string[]; ftExpiryBars: number }> {
  return fetchJson('/api/strategy-lab/strategies');
}
export async function fetchStrategySignals(
  strategy?: string, timeframe?: string, includeMuted?: boolean, limit?: number,
  window?: { from?: string; to?: string; broker?: string },
): Promise<{ ok: boolean; signals: StrategySignal[] }> {
  const p = new URLSearchParams();
  if (strategy) p.set('strategy', strategy);
  if (timeframe) p.set('timeframe', timeframe);
  if (includeMuted) p.set('includeMuted', '1');
  if (limit) p.set('limit', String(limit));
  if (window?.broker) p.set('broker', window.broker);
  // Without the window the server returns the newest N regardless of what the caller
  // asked for, so the log silently disagrees with the report above it.
  if (window?.from) p.set('from', window.from);
  if (window?.to) p.set('to', window.to);
  const qs = p.toString();
  return fetchJson(`/api/strategy-lab/signals${qs ? `?${qs}` : ''}`);
}
export async function fetchStrategyPerformance(params: number | { days?: number; preset?: string; from?: string; to?: string; includeMuted?: boolean; symbol?: string; broker?: string } = {}): Promise<StrategyPerformanceResponse> {
  const opts = typeof params === 'number' ? { days: params } : params;
  const q = new URLSearchParams();
  if (opts.includeMuted) q.set('includeMuted', '1');
  // Single-symbol lens: every ranking is recomputed from that symbol's rows only.
  if (opts.symbol) q.set('symbol', opts.symbol);
  // Broker lens: signals come from that broker's own feed, so the two are not comparable.
  if (opts.broker) q.set('broker', opts.broker);
  if (opts.from && opts.to) { q.set('from', opts.from); q.set('to', opts.to); }
  else if (opts.preset) q.set('preset', opts.preset);
  else q.set('days', String(opts.days ?? 90));
  return fetchJson<StrategyPerformanceResponse>(`/api/strategy-lab/performance?${q.toString()}`);
}
export async function fetchStrategyConfluence(opts: { days?: number; preset?: string; from?: string; to?: string; timeframe?: string; symbol?: string; strategies?: string[] } = {}): Promise<ConfluenceResponse> {
  const q = new URLSearchParams();
  if (opts.from && opts.to) { q.set('from', opts.from); q.set('to', opts.to); }
  else if (opts.preset) q.set('preset', opts.preset);
  else q.set('days', String(opts.days ?? 90));
  if (opts.timeframe) q.set('timeframe', opts.timeframe);
  if (opts.symbol) q.set('symbol', opts.symbol);
  if (opts.strategies?.length) q.set('strategies', opts.strategies.join(','));
  return fetchJson<ConfluenceResponse>(`/api/strategy-lab/confluence?${q.toString()}`);
}
export async function fetchStrategyLive(strategy: string, timeframe = 'M15'): Promise<StrategyLiveResponse> {
  const p = new URLSearchParams({ strategy, timeframe });
  return fetchJson<StrategyLiveResponse>(`/api/strategy-lab/live?${p.toString()}`);
}
export async function fetchStrategyLiveFtt(strategy: string, timeframe = 'M15'): Promise<StrategyFttLiveResponse> {
  const p = new URLSearchParams({ strategy, timeframe });
  return fetchJson<StrategyFttLiveResponse>(`/api/strategy-lab/live-ftt?${p.toString()}`);
}

export async function fetchStrategyEntryWatch(options: number | {
  minScore?: number;
  maxScore?: number;
  strategies?: string[];
  symbols?: string[];
  timeframes?: string[];
} = {}): Promise<StrategyEntryWatchResponse> {
  const opts = typeof options === 'number' ? { minScore: options } : options;
  const params = new URLSearchParams();
  if (opts.minScore != null) params.set('minScore', String(opts.minScore));
  if (opts.maxScore != null) params.set('maxScore', String(opts.maxScore));
  if (opts.strategies?.length) params.set('strategies', opts.strategies.join(','));
  if (opts.symbols?.length) params.set('symbols', opts.symbols.join(','));
  if (opts.timeframes?.length) params.set('timeframes', opts.timeframes.join(','));
  const qs = params.toString();
  return fetchJson<StrategyEntryWatchResponse>(`/api/strategy-lab/entry-watch${qs ? `?${qs}` : ''}`);
}

export async function fetchBreakoutLive(timeframe = 'ALL'): Promise<BreakoutLiveResponse> {
  const p = new URLSearchParams({ timeframe });
  return fetchJson<BreakoutLiveResponse>(`/api/breakout/live?${p.toString()}`);
}
export async function fetchBreakoutAlerts(options?: { symbol?: string; limit?: number }): Promise<BreakoutAlertsResponse> {
  const p = new URLSearchParams();
  if (options?.symbol) p.set('symbol', options.symbol);
  if (options?.limit) p.set('limit', String(options.limit));
  const qs = p.toString();
  return fetchJson<BreakoutAlertsResponse>(`/api/breakout/alerts${qs ? `?${qs}` : ''}`);
}
export async function fetchBreakoutTracking(timeframe = 'ALL', windowHours?: number): Promise<BreakoutTrackingResponse> {
  const p = new URLSearchParams({ timeframe });
  if (windowHours) p.set('windowHours', String(windowHours));
  return fetchJson<BreakoutTrackingResponse>(`/api/breakout/tracking?${p.toString()}`);
}

export async function markSignalTrackerDone(id: string): Promise<{ ok: boolean; id: string }> {
  const response = await fetch(`/api/signal-tracker/${encodeURIComponent(id)}/done`, { method: 'POST' });
  if (!response.ok) throw new Error(`Failed to mark done (${response.status})`);
  return response.json();
}

// Executed Orders — user-tracked pending orders (Track button on tracker rows).
export async function fetchExecutedOrders(): Promise<import('./types').ExecutedOrdersResponse> {
  const response = await fetch('/api/executed-orders');
  if (!response.ok) throw new Error(`Failed to load executed orders (${response.status})`);
  return response.json();
}
export async function trackSignalOrder(id: string, source = 'strategy-lab'): Promise<{ ok: boolean; id: string }> {
  const response = await fetch(`/api/signal-tracker/${encodeURIComponent(id)}/track?source=${encodeURIComponent(source)}`, { method: 'POST' });
  if (!response.ok) throw new Error(`Failed to track order (${response.status})`);
  return response.json();
}
export async function untrackSignalOrder(id: string): Promise<{ ok: boolean; id: string }> {
  const response = await fetch(`/api/signal-tracker/${encodeURIComponent(id)}/untrack`, { method: 'POST' });
  if (!response.ok) throw new Error(`Failed to untrack order (${response.status})`);
  return response.json();
}

export async function analyzeForecast(id: string): Promise<ForecastAnalysis> {
  const response = await fetch(`/api/forecasts/${encodeURIComponent(id)}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.error || `Analysis failed: ${response.status}`);
  }
  return (await response.json()) as ForecastAnalysis;
}

export async function fetchTrackedAiProjections(): Promise<TrackedAiProjectionResponse> {
  const response = await fetchTrackedJson('/api/ai-signals/tracked');
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error((error as any)?.error || `Failed to load tracked projections: ${response.status}`);
  }
  const data = (await response.json()) as TrackedAiProjectionResponse;
  return { ...data, tracked: data.tracked.map(normalizeTrackedAiProjection) };
}

export async function trackAiProjection(payload: Record<string, unknown>): Promise<{ ok: boolean; tracked: TrackedAiProjection }> {
  const response = await fetchTrackedJson('/api/ai-signals/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error((error as any)?.error || `Failed to track AI projection: ${response.status}`);
  }
  const data = (await response.json()) as { ok: boolean; tracked: TrackedAiProjection };
  return { ...data, tracked: normalizeTrackedAiProjection(data.tracked) };
}

export async function deleteTrackedAiProjection(id: string): Promise<{ ok: boolean; id: string }> {
  const path = `/api/ai-signals/track/${encodeURIComponent(id)}`;
  const response = await fetchTrackedJson(path, { method: 'DELETE' });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error((error as any)?.error || `Failed to delete tracked projection: ${response.status}`);
  }
  return response.json() as Promise<{ ok: boolean; id: string }>;
}

export async function postMt5Heartbeat(payload: Record<string, unknown>): Promise<Mt5Status> {
  const response = await fetch('/api/mt5/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Heartbeat failed: ${response.status}`);
  const data = (await response.json()) as { status: Mt5Status };
  return data.status;
}

export async function postMt5Signal(payload: Record<string, unknown>): Promise<Mt5SignalResponse> {
  const response = await fetch('/api/mt5/signals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.error || `Signal ingest failed: ${response.status}`);
  }
  return response.json() as Promise<Mt5SignalResponse>;
}

interface Mt5StreamContextType {
  signals: Alert[];
  candles: Mt5Candle[];
  trades: Mt5Trade[];
  indicators: IndicatorValue[];
  aiDecisions: AiDecision[];
  fttPredictions: FttPrediction[];
  trackedAiProjections: TrackedAiProjection[];
  account: Mt5AccountSnapshot | null;
  postNewsSignals: PostNewsSignal[];
  executionForecasts: ExecutionForecast[];
  topbarAlerts: TopbarMarketAlert[];
  addTopbarAlert: (alert: TopbarMarketAlert, playSound?: boolean) => void;
  status: Mt5Status;
  logs: NotificationLog[];
  error: string | null;
  refresh: () => Promise<void>;
}

const Mt5StreamContext = createContext<Mt5StreamContextType | undefined>(undefined);

export function Mt5StreamProvider({ children }: { children: React.ReactNode }) {
  const [signals, setSignals] = useState<Alert[]>([]);
  const [candles, setCandles] = useState<Mt5Candle[]>([]);
  const [trades, setTrades] = useState<Mt5Trade[]>([]);
  const [indicators, setIndicators] = useState<IndicatorValue[]>([]);
  const [aiDecisions, setAiDecisions] = useState<AiDecision[]>([]);
  const [trackedAiProjections, setTrackedAiProjections] = useState<TrackedAiProjection[]>([]);
  const [account, setAccount] = useState<Mt5AccountSnapshot | null>(null);
  const [fttPredictions, setFttPredictions] = useState<FttPrediction[]>([]);
  const [postNewsSignals, setPostNewsSignals] = useState<PostNewsSignal[]>([]);
  const [executionForecasts, setExecutionForecasts] = useState<ExecutionForecast[]>([]);
  const [topbarAlerts, setTopbarAlerts] = useState<TopbarMarketAlert[]>([]);
  const topbarAlertIds = useRef(new Set<string>());
  const [status, setStatus] = useState<Mt5Status>(emptyStatus);
  const [logs, setLogs] = useState<NotificationLog[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const [payload, logPayload, indicatorPayload, decisionPayload] = await Promise.all([fetchMt5Signals(100), fetchMt5Logs(100), fetchLatestIndicators(), fetchLatestAiDecisions()]);
      setSignals(payload.signals.map(normalizeAlert));
      setCandles((payload.candles || []).map(normalizeCandle));
      setTrades((payload.trades || []).map(normalizeTrade));
      setIndicators(indicatorPayload);
      setAiDecisions(decisionPayload.decisions.map(normalizeAiDecision));
      setAccount(payload.account || payload.status.accountSnapshot || null);
      setStatus(payload.status);
      setLogs(logPayload.map(normalizeLog));
      setError(null);
      // FTT predictions are non-critical; load separately so a failure never blocks the rest.
      fetchFttHistory(undefined, 200).then((r) => setFttPredictions(r.predictions)).catch(() => {});
      fetchPostNewsSignals().then((r) => setPostNewsSignals(r.signals)).catch(() => {});
      fetchTrackedAiProjections().then((r) => setTrackedAiProjections(r.tracked)).catch(() => {});
      fetchForecasts().then((r) => setExecutionForecasts(r.forecasts)).catch(() => {});
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Failed to load MT5 data');
    }
  };

  const addTopbarAlert = (alert: TopbarMarketAlert, playSound = false) => {
    if (topbarAlertIds.current.has(alert.id)) return;
    topbarAlertIds.current.add(alert.id);
    setTopbarAlerts((prev) => {
      return [alert, ...prev].slice(0, 10);
    });
    if (playSound) playAlertSound();
  };

  const isQualityFttAlert = (prediction: FttPrediction) => {
    const indicators = (prediction.indicators || {}) as Record<string, unknown>;
    const tier = String(indicators.qualityTier || indicators.grade || '').toUpperCase();
    return prediction.direction !== 'HOLD'
      && Number(prediction.confidence || 0) >= 80
      && (prediction.tradeStatus === 'QUALITY_SIGNAL' || tier.includes('A+') || tier.includes('A '));
  };

  const toTopbarFttAlert = (prediction: FttPrediction): TopbarMarketAlert => {
    const indicators = (prediction.indicators || {}) as Record<string, any>;
    return {
      id: `ftt:${prediction.id}`,
      kind: 'FIXED_TIME',
      symbol: prediction.symbol,
      expiry: prediction.expiry,
      direction: prediction.direction,
      grade: String(indicators.grade || indicators.qualityTier || prediction.tradeStatus || ''),
      quality: String(indicators.qualityTier || prediction.tradeStatus || ''),
      confidence: Math.round(Number(prediction.confidence || 0)),
      entryPrice: prediction.entryPrice,
      tradeTime: prediction.entryTime,
      expiryTime: prediction.expiryTime,
      sessionReason: indicators.sessionContext?.reason || null,
      createdAt: prediction.created_at || new Date().toISOString(),
    };
  };

  useEffect(() => {
    void refresh();

    if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
      const interval = window.setInterval(() => void refresh(), 10000);
      return () => window.clearInterval(interval);
    }

    const source = new EventSource('/api/mt5/signals/stream');

    source.addEventListener('snapshot', (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent).data) as {
          signals?: Alert[];
          candles?: Mt5Candle[];
          trades?: Mt5Trade[];
          indicators?: IndicatorValue[];
          aiDecisions?: AiDecision[];
          account?: Mt5AccountSnapshot | null;
          status: Mt5Status;
        };
        if (parsed.signals?.length) setSignals(parsed.signals.map(normalizeAlert));
        if (parsed.candles?.length) setCandles(parsed.candles.map(normalizeCandle));
        if (parsed.trades?.length) setTrades(parsed.trades.map(normalizeTrade));
        if (parsed.indicators) setIndicators(parsed.indicators);
        if (parsed.aiDecisions) setAiDecisions(parsed.aiDecisions.map(normalizeAiDecision));
        setAccount(parsed.account || parsed.status.accountSnapshot || null);
        setStatus(parsed.status);
        setError(null);
      } catch {
        setError('Failed to parse MT5 snapshot');
      }
    });

    source.addEventListener('signal', (event) => {
      try {
        const signal = normalizeAlert(JSON.parse((event as MessageEvent).data) as Alert);
        setSignals((prev) => upsertById(prev, signal, 100));

        // Play sound and trigger browser notification
        playAlertSound();
        showBrowserNotification(`Forex Signal: ${signal.symbol} [${signal.timeframe}]`, {
          body: `${signal.direction ? signal.direction.toUpperCase() : signal.type} at ${signal.price || 'market'} — ${signal.message || ''}`,
          tag: `forex-${signal.id}`
        });

        if (signal.delivery) {
          setLogs((prev) => upsertById(prev, normalizeLog({
            id: `${signal.id}-${signal.delivery.channel}`,
            channel: signal.delivery.channel,
            recipient: signal.delivery.recipient,
            status: signal.delivery.error ? 'Failed' : 'Success',
            timestamp: signal.receivedAt || new Date().toISOString(),
            error: signal.delivery.error,
            signalId: signal.id,
            messageId: signal.delivery.messageId,
            message: signal.message,
          }), 100));
        }
      } catch {
        setError('Failed to parse MT5 signal');
      }
    });

    source.addEventListener('candle', (event) => {
      try {
        const candle = normalizeCandle(JSON.parse((event as MessageEvent).data) as Mt5Candle);
        setCandles((prev) => upsertById(prev, candle, 5000));
      } catch {
        setError('Failed to parse MT5 candle');
      }
    });

    source.addEventListener('trade', (event) => {
      try {
        const trade = normalizeTrade(JSON.parse((event as MessageEvent).data) as Mt5Trade);
        setTrades((prev) => upsertById(prev, trade, 200));
      } catch {
        setError('Failed to parse MT5 trade');
      }
    });

    source.addEventListener('indicator', (event) => {
      try {
        const indicator = JSON.parse((event as MessageEvent).data) as IndicatorValue;
        setIndicators((prev) => upsertById(prev, indicator, 5000));
      } catch {
        setError('Failed to parse MT5 indicator');
      }
    });

    source.addEventListener('ai_decision', (event) => {
      try {
        const decision = normalizeAiDecision(JSON.parse((event as MessageEvent).data) as AiDecision);
        setAiDecisions((prev) => upsertById(prev, decision, 200));
      } catch {
        setError('Failed to parse AI decision');
      }
    });

    source.addEventListener('quality_forex_signal', (event) => {
      try {
        const alert = JSON.parse((event as MessageEvent).data) as TopbarMarketAlert;
        addTopbarAlert(alert, true);
        showBrowserNotification(`${alert.grade || 'A'} Forex Signal: ${alert.symbol} ${alert.timeframe || ''}`, {
          body: `${alert.direction.replace('_', ' ')} ${alert.confidence}/100 · Entry ${alert.entryPrice ?? 'market'} · SL ${alert.stopLoss ?? 'n/a'}`,
          tag: alert.id,
        });
      } catch {
        setError('Failed to parse quality forex signal');
      }
    });

    source.addEventListener('breakout', (event) => {
      try {
        const p = JSON.parse((event as MessageEvent).data) as {
          id: string; phase: 'PRE' | 'CONFIRMED'; symbol: string; timeframe: string;
          direction: 'BUY' | 'SELL'; grade: string; score: number; trend: 'UP' | 'DOWN';
          level: number; levelStrength: number; price: number; distanceAtr: number | null;
          bodyAtr: number | null; reasons?: string[]; bar?: string; createdAt: string;
        };
        const dirWord = p.direction === 'BUY' ? 'UP ▲' : 'DOWN ▼';
        const alert: TopbarMarketAlert = {
          id: p.id,
          kind: 'BREAKOUT',
          symbol: p.symbol,
          timeframe: p.timeframe,
          direction: p.direction,
          grade: p.grade,
          confidence: p.score,
          entryPrice: p.price,
          createdAt: p.createdAt || new Date().toISOString(),
          phase: p.phase,
          level: p.level,
          levelStrength: p.levelStrength,
          score: p.score,
          trend: p.trend,
          distanceAtr: p.distanceAtr,
          bodyAtr: p.bodyAtr,
          reasons: p.reasons || null,
        };
        // Generous browser channel: top-bar alert + desktop notification + sound.
        addTopbarAlert(alert, true);
        const title = p.phase === 'PRE'
          ? `⚠️ ${p.grade} Approaching breakout: ${p.symbol} ${p.timeframe}`
          : `✅ ${p.grade} Breakout confirmed: ${p.symbol} ${p.timeframe}`;
        showBrowserNotification(title, {
          body: p.phase === 'PRE'
            ? `${dirWord} into ${p.level} · ${p.distanceAtr ?? '?'}× ATR away · score ${p.score}/100`
            : `${dirWord} through ${p.level} · break body ${p.bodyAtr ?? '?'}× ATR · score ${p.score}/100`,
          tag: p.id,
        });
      } catch {
        setError('Failed to parse breakout alert');
      }
    });

    source.addEventListener('ai_tracked_update', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as TrackedAiProjection & { deleted?: boolean };
        if (payload.deleted) {
          setTrackedAiProjections((prev) => prev.filter((item) => item.id !== payload.id));
          return;
        }
        const tracked = normalizeTrackedAiProjection(payload);
        setTrackedAiProjections((prev) => upsertById(prev, tracked, 200));
      } catch {
        setError('Failed to parse tracked AI projection update');
      }
    });

    source.addEventListener('ai_tracked_triggered', (event) => {
      try {
        const tracked = normalizeTrackedAiProjection(JSON.parse((event as MessageEvent).data) as TrackedAiProjection);
        setTrackedAiProjections((prev) => upsertById(prev, tracked, 200));
        playAlertSound();
        showBrowserNotification(`AI Tracked Entry: ${tracked.symbol}`, {
          body: `${tracked.decision.replace('_', ' ')} confirmed at ${tracked.currentPrice ?? tracked.entryPrice}. ${tracked.evaluation?.reason || 'Local indicators confirmed.'}`,
          tag: `ai-tracked-${tracked.id}`,
        });
      } catch {
        setError('Failed to parse tracked AI trigger');
      }
    });

    source.addEventListener('ai_tracked_invalidated', (event) => {
      try {
        const tracked = normalizeTrackedAiProjection(JSON.parse((event as MessageEvent).data) as TrackedAiProjection);
        setTrackedAiProjections((prev) => upsertById(prev, tracked, 200));
      } catch {
        setError('Failed to parse tracked AI invalidation');
      }
    });

    source.addEventListener('ai_tracked_expired', (event) => {
      try {
        const tracked = normalizeTrackedAiProjection(JSON.parse((event as MessageEvent).data) as TrackedAiProjection);
        setTrackedAiProjections((prev) => upsertById(prev, tracked, 200));
      } catch {
        setError('Failed to parse tracked AI expiration');
      }
    });

    source.addEventListener('ftt_prediction', (event) => {
      try {
        const prediction = normalizeFttPrediction(JSON.parse((event as MessageEvent).data) as FttPrediction);
        setFttPredictions((prev) => upsertById(prev, prediction, 300));
        if (isQualityFttAlert(prediction)) {
          addTopbarAlert(toTopbarFttAlert(prediction), false);
        }

        // Play sound and trigger browser notification for active FTT trades
        if (prediction.direction !== 'HOLD') {
          playAlertSound();
          showBrowserNotification(`FTT Prediction: ${prediction.symbol} [${prediction.expiry}]`, {
            body: `${prediction.direction} (Confidence: ${prediction.confidence}%) at ${prediction.entryPrice}`,
            tag: `ftt-${prediction.id}`
          });
        }
      } catch {
        setError('Failed to parse FTT prediction');
      }
    });

    source.addEventListener('post_news_signal', (event) => {
      try {
        const sig = JSON.parse((event as MessageEvent).data) as PostNewsSignal;
        setPostNewsSignals((prev) => upsertById(prev, sig, 100));
      } catch {
        setError('Failed to parse post-news signal');
      }
    });

    source.addEventListener('execution_forecast', (event) => {
      try {
        const fc = JSON.parse((event as MessageEvent).data) as ExecutionForecast;
        setExecutionForecasts((prev) => {
          const rest = prev.filter((f) => f.id !== fc.id);
          // Drop terminal forecasts from the live list; keep active ones.
          if (['CANCELLED', 'EXPIRED', 'EXECUTED'].includes(fc.status)) return rest;
          return [fc, ...rest].slice(0, 300);
        });
      } catch {
        setError('Failed to parse execution forecast');
      }
    });

    source.addEventListener('signal_tracker_alert', (event) => {
      try {
        const a = JSON.parse((event as MessageEvent).data);
        const close = (a.severity ?? 0) >= 3;
        const alert = {
          id: `tracker:${a.id}:${a.alertType}:${a.at}`,
          kind: 'FOREX' as const,
          alertKind: (close ? 'CLOSE' : 'MANAGE') as 'CLOSE' | 'MANAGE',
          symbol: a.symbol,
          timeframe: a.timeframe ?? null,
          direction: String(a.direction || ''),
          confidence: 0,
          entryPrice: a.currentPrice ?? null,
          currentR: a.currentR ?? null,
          currentPips: a.currentPips ?? null,
          reason: a.warningReason ?? null,
          action: a.suggestedAction ?? null,
          createdAt: a.at || new Date().toISOString(),
        };
        addTopbarAlert(alert, true);
        showBrowserNotification(`${close ? 'CLOSE' : 'MANAGE'} ${a.symbol} ${alert.direction}`, {
          body: `${a.warningReason || ''} — ${a.suggestedAction || ''}`,
          tag: alert.id,
        });
      } catch {
        /* ignore malformed tracker alert */
      }
    });

    source.addEventListener('strategy_signal', (event) => {
      try {
        const s = JSON.parse((event as MessageEvent).data);
        const alert = {
          id: `strat:${s.id}`,
          kind: 'FOREX' as const,
          strategySource: s.strategyName || s.strategy || 'Strategy',
          symbol: s.symbol,
          timeframe: s.timeframe ?? null,
          direction: String(s.direction || ''),
          grade: s.grade ?? null,
          confidence: Number(s.score) || 0,
          entryPrice: s.entry ?? null,
          stopLoss: s.stopLoss ?? null,
          takeProfit1: s.takeProfit1 ?? null,
          takeProfit2: s.takeProfit2 ?? null,
          takeProfit3: s.takeProfit3 ?? null,
          lotSize: s.lots ?? null,
          sessionReason: s.reason ?? null,
          createdAt: s.at || new Date().toISOString(),
        };
        addTopbarAlert(alert, true);
        showBrowserNotification(`${s.grade || ''} ${s.strategyName || 'Strategy'}: ${s.symbol} ${s.timeframe} ${alert.direction}`, {
          body: `Score ${Math.round(Number(s.score) || 0)} · ${s.lots != null ? `${s.lots} lots · ` : ''}Entry ${s.entry ?? 'market'} · SL ${s.stopLoss ?? 'n/a'} · TP1 ${s.takeProfit1 ?? 'n/a'} / TP2 ${s.takeProfit2 ?? 'n/a'} / TP3 ${s.takeProfit3 ?? 'n/a'}`,
          tag: alert.id,
        });
      } catch {
        /* ignore malformed strategy signal */
      }
    });

    source.addEventListener('strategy_ftt_signal', (event) => {
      try {
        const s = JSON.parse((event as MessageEvent).data);
        const dir = String(s.direction || '');
        const alert = {
          id: `stratftt:${s.id}`,
          kind: 'FIXED_TIME' as const,
          strategySource: s.strategyName || s.strategy || 'Strategy',
          symbol: s.symbol,
          timeframe: s.timeframe ?? null,
          expiry: s.durationLabel ?? null,
          expiryTime: s.expiryIso ?? null,
          direction: dir,
          grade: s.grade ?? null,
          confidence: Number(s.score) || 0,
          sessionReason: s.reason ?? null,
          createdAt: s.at || new Date().toISOString(),
        };
        addTopbarAlert(alert, true);
        showBrowserNotification(`${s.grade || ''} ${s.strategyName || 'Strategy'} FIXED-TIME: ${s.symbol} ${s.timeframe} ${dir}`, {
          body: `Score ${Math.round(Number(s.score) || 0)} · predict ${dir === 'UP' ? 'HIGHER' : 'LOWER'} · expiry ${s.durationLabel || 'next candle'}${s.reference != null ? ` · ref ${s.reference}` : ''}`,
          tag: alert.id,
        });
      } catch {
        /* ignore malformed strategy ftt signal */
      }
    });

    source.addEventListener('account', (event) => {
      try {
        setAccount(JSON.parse((event as MessageEvent).data) as Mt5AccountSnapshot);
      } catch {
        setError('Failed to parse MT5 account snapshot');
      }
    });

    source.addEventListener('status', (event) => {
      try {
        const nextStatus = JSON.parse((event as MessageEvent).data) as Mt5Status;
        setStatus(nextStatus);
        if (nextStatus.accountSnapshot) setAccount(nextStatus.accountSnapshot);
      } catch {
        setError('Failed to parse MT5 status');
      }
    });

    source.onerror = () => setError('MT5 stream disconnected');
    const interval = window.setInterval(() => void refresh(), 15000);

    return () => {
      source.close();
      window.clearInterval(interval);
    };
  }, []);

  const value = useMemo(() => ({
    signals,
    candles,
    trades,
    indicators,
    aiDecisions,
    fttPredictions,
    trackedAiProjections,
    account,
    postNewsSignals,
    executionForecasts,
    topbarAlerts,
    addTopbarAlert,
    status,
    logs,
    error,
    refresh
  }), [signals, candles, trades, indicators, aiDecisions, fttPredictions, trackedAiProjections, account, postNewsSignals, executionForecasts, topbarAlerts, status, logs, error]);

  return React.createElement(Mt5StreamContext.Provider, { value }, children);
}

export function useMt5Stream() {
  const context = useContext(Mt5StreamContext);
  if (context === undefined) {
    throw new Error('useMt5Stream must be used within an Mt5StreamProvider');
  }
  return context;
}

export function exportSignalsCsv(signals: Alert[]) {
  const headers = ['id', 'timestamp', 'symbol', 'timeframe', 'type', 'direction', 'price', 'bid', 'ask', 'volume', 'account', 'broker', 'terminal', 'status', 'message'];
  const rows = signals.map((signal) => headers.map((header) => {
    const value = (signal as Record<string, unknown>)[header];
    if (value === undefined || value === null) return '';
    const text = String(value).replace(/"/g, '""');
    return `"${text}"`;
  }).join(','));
  return [headers.join(','), ...rows].join('\n');
}

// ─── Fixed-Time Trading (FTT) API ──────────────────────────────────────

function normalizeFttPrediction(p: FttPrediction): FttPrediction {
  return {
    ...p,
    confidence: numberOrNull(p.confidence) || 0,
    entryPrice: p.entryPrice === undefined ? null : numberOrNull(p.entryPrice),
    exitPrice: p.exitPrice === undefined ? null : numberOrNull(p.exitPrice),
  };
}

export async function triggerFttPrediction(symbol: string, expiry: string, source: 'system' | 'ai'): Promise<FttPredictResponse> {
  const response = await fetch('/api/ftt/predict', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol, expiry, source }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.error || `FTT prediction failed: ${response.status}`);
  }
  const payload = (await response.json()) as FttPredictResponse;
  return { ...payload, prediction: normalizeFttPrediction(payload.prediction) };
}

export async function triggerFttScan(expiry: string, symbols?: string[]): Promise<FttScanResponse> {
  const response = await fetch('/api/ftt/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(symbols && symbols.length ? { expiry, symbols } : { expiry }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.error || `FTT scan failed: ${response.status}`);
  }
  return (await response.json()) as FttScanResponse;
}

export async function fetchFttHistory(symbol?: string, limit = 100): Promise<FttHistoryResponse> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (symbol) params.set('symbol', symbol);
  const response = await fetchJson<FttHistoryResponse>(`/api/ftt/history?${params.toString()}`);
  return { ...response, predictions: response.predictions.map(normalizeFttPrediction) };
}

export async function fetchForexEmailReports(options?: {
  symbol?: string;
  days?: number;
  outcome?: string;
  limit?: number;
}): Promise<SignalEmailReportsResponse> {
  const params = new URLSearchParams();
  if (options?.symbol) params.set('symbol', options.symbol);
  if ((options as { preset?: string })?.preset) params.set('preset', (options as { preset?: string }).preset as string);
  else if (options?.days) params.set('days', String(options.days));
  if (options?.outcome) params.set('outcome', options.outcome);
  if (options?.limit) params.set('limit', String(options.limit));
  const qs = params.toString();
  return fetchJson<SignalEmailReportsResponse>(`/api/reports/forex${qs ? `?${qs}` : ''}`);
}

export async function fetchFixedEmailReports(options?: {
  symbol?: string;
  days?: number;
  outcome?: string;
  limit?: number;
}): Promise<SignalEmailReportsResponse> {
  const params = new URLSearchParams();
  if (options?.symbol) params.set('symbol', options.symbol);
  if ((options as { preset?: string })?.preset) params.set('preset', (options as { preset?: string }).preset as string);
  else if (options?.days) params.set('days', String(options.days));
  if (options?.outcome) params.set('outcome', options.outcome);
  if (options?.limit) params.set('limit', String(options.limit));
  const qs = params.toString();
  return fetchJson<SignalEmailReportsResponse>(`/api/reports/fixed${qs ? `?${qs}` : ''}`);
}

export async function fetchSignalLog(options?: {
  symbol?: string;
  days?: number;
  grade?: string;
  outcome?: string;
  emailed?: boolean;
  limit?: number;
}): Promise<SignalLogResponse> {
  const params = new URLSearchParams();
  if (options?.symbol) params.set('symbol', options.symbol);
  if ((options as { preset?: string })?.preset) params.set('preset', (options as { preset?: string }).preset as string);
  else if (options?.days) params.set('days', String(options.days));
  if (options?.grade) params.set('grade', options.grade);
  if (options?.outcome) params.set('outcome', options.outcome);
  if (options?.emailed !== undefined) params.set('emailed', String(options.emailed));
  if (options?.limit) params.set('limit', String(options.limit));
  const qs = params.toString();
  return fetchJson<SignalLogResponse>(`/api/reports/signal-log${qs ? `?${qs}` : ''}`);
}

export async function fetchCalibrationReport(type: 'forex' | 'fixed', options?: {
  symbol?: string;
  days?: number;
  limit?: number;
}): Promise<CalibrationResponse> {
  const params = new URLSearchParams();
  if (options?.symbol) params.set('symbol', options.symbol);
  if (options?.days) params.set('days', String(options.days));
  if (options?.limit) params.set('limit', String(options.limit));
  const qs = params.toString();
  return fetchJson<CalibrationResponse>(`/api/reports/calibration/${type}${qs ? `?${qs}` : ''}`);
}

export async function fetchWouldSuppress(): Promise<WouldSuppressResponse> {
  return fetchJson<WouldSuppressResponse>('/api/reports/would-suppress');
}

export async function fetchForexBacktestReport(options?: {
  symbol?: string;
  days?: number;
  limit?: number;
}): Promise<ForexBacktestResponse> {
  const params = new URLSearchParams();
  if (options?.symbol) params.set('symbol', options.symbol);
  if (options?.days) params.set('days', String(options.days));
  if (options?.limit) params.set('limit', String(options.limit));
  const qs = params.toString();
  return fetchJson<ForexBacktestResponse>(`/api/reports/backtest/forex${qs ? `?${qs}` : ''}`);
}

export async function fetchWouldTradeReport(options?: {
  days?: number;
  minTrades?: number;
  account?: string;
}): Promise<WouldTradeResponse> {
  const params = new URLSearchParams();
  if (options?.days) params.set('days', String(options.days));
  if (options?.minTrades) params.set('minTrades', String(options.minTrades));
  if (options?.account) params.set('account', options.account);
  const qs = params.toString();
  return fetchJson<WouldTradeResponse>(`/api/reports/would-trade${qs ? `?${qs}` : ''}`);
}

export async function fetchTradeNewsForex(options?: {
  minConfidence?: number;
  activeOnly?: boolean;
}): Promise<TradeNewsResponse<TradeNewsForexSignal>> {
  const params = new URLSearchParams();
  if (options?.minConfidence !== undefined) params.set('minConfidence', String(options.minConfidence));
  if (options?.activeOnly !== undefined) params.set('activeOnly', String(options.activeOnly));
  const qs = params.toString();
  return fetchJson<TradeNewsResponse<TradeNewsForexSignal>>(`/api/trade-news/forex${qs ? `?${qs}` : ''}`);
}

export async function fetchTradeNewsFixed(options?: {
  minConfidence?: number;
  activeOnly?: boolean;
  expiries?: string[];
}): Promise<TradeNewsResponse<TradeNewsFixedSignal>> {
  const params = new URLSearchParams();
  if (options?.minConfidence !== undefined) params.set('minConfidence', String(options.minConfidence));
  if (options?.activeOnly !== undefined) params.set('activeOnly', String(options.activeOnly));
  if (options?.expiries?.length) params.set('expiries', options.expiries.join(','));
  const qs = params.toString();
  return fetchJson<TradeNewsResponse<TradeNewsFixedSignal>>(`/api/trade-news/fixed${qs ? `?${qs}` : ''}`);
}




// ─── Pullback Level & Timing Projections ───────────────────────────────

/** Deterministic math projections for the curated symbols (cached 60s server-side). */
export async function fetchProjectionScan(timeframe = 'M15', force = false): Promise<ProjectionScanResponse> {
  const params = new URLSearchParams({ timeframe });
  if (force) params.set('force', '1');
  return fetchJson<ProjectionScanResponse>(`/api/projections/scan?${params.toString()}`);
}

/** On-demand Gemini validation for a single symbol — only call when the user enables AI. */
export async function triggerProjectionAnalysis(symbol: string, timeframe = 'M15'): Promise<ProjectionAnalyzeResponse> {
  const response = await fetch('/api/projections/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol, timeframe }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error((error as any)?.error || `Projection analysis failed: ${response.status}`);
  }
  return (await response.json()) as Promise<ProjectionAnalyzeResponse>;
}

// ─── Pullback Projection Reminders & Saved Observations ────────────────

export async function scheduleProjectionReminder(params: {
  projection_id: string;
  symbol: string;
  timeframe: string;
  bias: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  suitability: { forex: boolean; ftt: boolean; fttExpiry: string };
  projectedTouchMs: number;
  email?: string;
  mathConfidence: number;
  grade: string;
  rationale?: string;
  ai_on: boolean;
}): Promise<{ ok: boolean; reminderId: string }> {
  const response = await fetch('/api/projections/reminders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.error || `Failed to schedule reminder: ${response.status}`);
  }
  return response.json();
}

export async function fetchActiveProjectionReminders(): Promise<{ ok: boolean; activeReminders: { id: string; projection_id: string }[] }> {
  return fetchJson<{ ok: boolean; activeReminders: { id: string; projection_id: string }[] }>('/api/projections/reminders/active');
}

export async function deleteProjectionReminder(id: string): Promise<{ ok: boolean }> {
  const response = await fetch(`/api/projections/reminders/${id}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.error || `Failed to cancel reminder: ${response.status}`);
  }
  return response.json();
}

export async function saveProjection(params: {
  projection_id: string;
  symbol: string;
  timeframe: string;
  bias: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  suitability: { forex: boolean; ftt: boolean; fttExpiry: string };
  projectedTouchMs: number;
  mathConfidence: number;
  grade: string;
  rationale?: string;
}): Promise<{ ok: boolean; savedId: string }> {
  const response = await fetch('/api/projections/saved', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.error || `Failed to save projection: ${response.status}`);
  }
  return response.json();
}

export async function fetchSavedProjections(): Promise<{ ok: boolean; savedProjections: any[] }> {
  return fetchJson<{ ok: boolean; savedProjections: any[] }>('/api/projections/saved');
}

export async function fetchProjectionTrackRecord(days?: number): Promise<ProjectionTrackRecord> {
  const qs = days ? `?days=${days}` : '';
  return fetchJson<ProjectionTrackRecord>(`/api/projections/track-record${qs}`);
}

export async function updateSavedProjectionOutcome(id: string, outcome: 'WIN' | 'LOSS' | 'DRAW' | 'PENDING'): Promise<{ ok: boolean }> {
  const response = await fetch(`/api/projections/saved/${id}/outcome`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ outcome }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.error || `Failed to update outcome: ${response.status}`);
  }
  return response.json();
}

export async function deleteSavedProjection(id: string): Promise<{ ok: boolean }> {
  const response = await fetch(`/api/projections/saved/${id}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.error || `Failed to delete saved projection: ${response.status}`);
  }
  return response.json();
}

export interface StrategyBrokerRow { broker: string; signals: number; symbols: number; symbolList: string[]; firstSeen: string | null; lastSeen: string | null }
/** Which brokers appear in the signal history, for the report filter. */
export async function fetchStrategyBrokers(window?: { from?: string; to?: string; days?: number; preset?: string }): Promise<{ ok: boolean; live: string | null; brokers: StrategyBrokerRow[] }> {
  const q = new URLSearchParams();
  if (window?.from && window?.to) { q.set('from', window.from); q.set('to', window.to); }
  else if (window?.preset) q.set('preset', window.preset);
  else q.set('days', String(window?.days ?? 90));
  return fetchJson(`/api/strategy-lab/brokers?${q.toString()}`);
}

export interface BridgeAccountRow { login: string; broker: string | null; server: string | null; demo: boolean | null; lastSeenAt: string | null; hasProfile: boolean }
/** Per-account risk profiles, which login is connected, and every account the bridge has seen. */
export async function fetchAccountProfiles(): Promise<{
  ok: boolean; activeAccount: string | null; activeBroker: string | null; armed: string | null;
  usingProfile: boolean; accounts: BridgeAccountRow[];
}> {
  return fetchJson('/api/account-profiles');
}

/** Classified liquidity read for one symbol/timeframe (Liquidity Chart route). */
export async function fetchLiquidityChart(symbol: string, timeframe: string): Promise<LiquidityChartResponse> {
  const q = new URLSearchParams({ symbol, timeframe });
  return fetchJson<LiquidityChartResponse>(`/api/liquidity-chart?${q.toString()}`);
}

/** Liquidity read scored across every live symbol, ranked best-positioned first. */
export async function fetchLiquidityRanking(timeframe: string): Promise<LiquidityRankResponse> {
  return fetchJson<LiquidityRankResponse>(`/api/liquidity-chart/ranking?timeframe=${encodeURIComponent(timeframe)}`);
}

/** Every enabled strategy scored and ranked inside a 1-3 hour window. */
export async function fetchStrategyPredictions(horizonHours = 3): Promise<StrategyPredictionResponse> {
  return fetchJson<StrategyPredictionResponse>(`/api/strategy-predictions?horizonHours=${encodeURIComponent(String(horizonHours))}`);
}

/** How the recorded predictions actually turned out. */
export async function fetchPredictionReport(days = 30): Promise<PredictionReportResponse> {
  return fetchJson<PredictionReportResponse>(`/api/reports/predictions?days=${encodeURIComponent(String(days))}`);
}

/** Active conditional setup forecasts, grouped into horizon buckets. */
export async function fetchSetupForecasts(): Promise<SetupForecastResponse> {
  return fetchJson<SetupForecastResponse>('/api/setup-forecasts');
}

/** How the setup forecasts actually resolved: arrivals, matches, timing. */
export async function fetchSetupForecastReport(days = 14): Promise<SetupForecastReportResponse> {
  return fetchJson<SetupForecastReportResponse>(`/api/reports/setup-forecasts?days=${encodeURIComponent(String(days))}`);
}

/** Trades waiting on your approval before they can be sent to MT5. */
export async function fetchAutoTradePending(): Promise<AutoTradePendingResponse> {
  return fetchJson<AutoTradePendingResponse>('/api/auto-trade/pending');
}

/** AI second opinion on one setup forecast. Read-only — it can never place a trade. */
export async function analyseForecastWithAi(id: string, force = false): Promise<ForecastAiResponse> {
  return fetchJson<ForecastAiResponse>(
    `/api/setup-forecasts/${encodeURIComponent(id)}/analyze${force ? '?force=1' : ''}`,
    { method: 'POST' },
  );
}

/** Per-strategy forecast match rates over a window (powers the star and the 100% filter). */
export async function fetchStrategyRates(range: string, from?: string, to?: string): Promise<StrategyRatesResponse> {
  const q = new URLSearchParams({ range, offsetMinutes: String(-new Date().getTimezoneOffset()) });
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  return fetchJson<StrategyRatesResponse>(`/api/setup-forecasts/strategy-rates?${q.toString()}`);
}

/** Pin or unpin a forecast for tracking. */
export async function trackForecast(id: string, tracked: boolean): Promise<{ ok: boolean; tracked: boolean }> {
  return fetchJson(`/api/setup-forecasts/${encodeURIComponent(id)}/track`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tracked }),
  });
}

/** Tracked forecasts with a live health read. */
export async function fetchTrackedForecasts(): Promise<TrackedForecastResponse> {
  return fetchJson<TrackedForecastResponse>('/api/setup-forecasts/tracked');
}

/** Rest a LIMIT order at the forecast level. Places a REAL order on MT5. */
export async function placeForecastOrder(id: string, expiryMinutes?: number) {
  return fetchJson<{ ok: boolean; id: string; direction: string; entry: number; lots: number; expiresInMinutes: number; warnings: string[]; note: string }>(
    `/api/setup-forecasts/${encodeURIComponent(id)}/place-order`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiryMinutes }) },
  );
}

/** Resting orders placed from forecasts. */
export async function fetchForecastPendingOrders(): Promise<ForecastPendingResponse> {
  return fetchJson<ForecastPendingResponse>('/api/setup-forecasts/pending-orders');
}

/** Pull a resting order off the broker. */
export async function cancelForecastOrder(orderId: string) {
  return fetchJson<{ ok: boolean; cancelled: boolean; atBroker: boolean; note?: string }>(
    `/api/setup-forecasts/order/${encodeURIComponent(orderId)}/cancel`, { method: 'POST' },
  );
}

/** Re-anchor a stale proposal to the live market before approving it. */
export async function repriceAutoTrade(id: string): Promise<RepriceResponse> {
  return fetchJson<RepriceResponse>(`/api/auto-trade/${encodeURIComponent(id)}/reprice`, { method: 'POST' });
}

// ─── ICT Predict ─────────────────────────────────────────────────────────────

/**
 * Active ICT predictions. Every filter is applied SERVER-side so the page and the API cannot
 * disagree about what "within 50 pips" means — pip distance is measured to the resting entry.
 */
export async function fetchIctPredictions(filters: {
  symbol?: string; timeframe?: string; setup?: string; direction?: string;
  grade?: string; strategy?: string; proOnly?: boolean;
  minScore?: number; minRR?: number; maxPips?: number; minPips?: number;
} = {}): Promise<IctPredictionResponse> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    q.set(k, v === true ? '1' : String(v));
  }
  const qs = q.toString();
  return fetchJson<IctPredictionResponse>(`/api/ict-predictions${qs ? `?${qs}` : ''}`);
}

/** Pin or unpin an ICT prediction for tracking. */
export async function trackIctPrediction(id: string, tracked: boolean) {
  return fetchJson<{ ok: boolean; tracked: boolean }>(`/api/ict-predictions/${encodeURIComponent(id)}/track`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tracked }),
  });
}

/** Tracked predictions with a live ICT health read (approaching / swept / confirmed / failed). */
export async function fetchTrackedIctPredictions(): Promise<IctTrackedResponse> {
  return fetchJson<IctTrackedResponse>('/api/ict-predictions/tracked');
}

export interface IctResizeInput {
  lots?: number;
  /** Solve for lots from a stop distance instead of naming a lot size. */
  stopPips?: number;
  slUsd: number;
  tpUsd?: number | null;
  tp2Usd?: number | null;
  tp3Usd?: number | null;
}

export interface IctResizePreview {
  ok: boolean;
  symbol: string; timeframe: string; direction: string; entry: number;
  ticket: {
    ok: boolean; lots: number;
    stopLoss: number; takeProfit1: number | null; takeProfit2: number | null; takeProfit3: number | null;
    stopPips: number; tp1Pips: number | null; tp3Pips: number | null;
    riskUsd: number; rewardUsd: number | null; rr: number | null;
  };
  validation: {
    verdict: 'OK' | 'RISKY' | 'REJECT' | 'INVALID';
    errors: string[]; warnings: string[]; notes: string[];
    /** Advisory only — a manual ticket over budget still places. */
    overBudget?: boolean;
  };
  suggestion: { suggestedStopPips: number; suggestedLots: number | null; why: string } | null;
  context: {
    riskBudget: number | null;
    riskPct: number | null;
    /** Set when the budget is larger than today's remaining daily-loss / drawdown room. */
    roomWarning: string | null;
    safePerTradeRisk: number | null;
    equity: number | null;
    atrPips: number | null; spreadPips: number | null;
    pipValuePerLot: number; pipSize: number; digits: number | null;
    originalLots: number | null; originalStopPips: number | null;
  };
}



// ── Liquidity events: alerted levels and what price did with them ────────────
export interface LiquidityEvent {
  id: string; symbol: string; timeframe: string;
  level: number; levelType: string | null; levelLabel: string | null;
  strength: number | null; side: string; tier: string | null;
  alertPrice: number | null; distancePips: number | null; emailed: boolean;
  status: 'WAITING' | 'RECLAIMED' | 'BROKE_AND_HELD' | 'NO_FOLLOW_THROUGH' | 'DEAD';
  /** Only true once displacement (reclaim) or a held retest (break) has appeared. */
  confirmed: boolean;
  direction: 'BUY' | 'SELL' | null;
  barsToResolve: number | null;
  followThroughPips: number | null;
  adversePips: number | null;
  touches: number | null; closesBeyond: number | null;
  evidence: string | null;
  alertedAt: string; resolvedAt: string | null;
}
export interface LiquidityEventsResponse {
  days: number; symbol: string; confirmedOnly: boolean; generatedAt: string;
  events: LiquidityEvent[];
  summary: {
    alerts: number; waiting: number; noFollowThrough: number; dead: number;
    resolved: number; reclaimed: number; brokeAndHeld: number;
    reclaimRate: number | null; avgFollowThroughPips: number | null;
    confirmed: {
      resolved: number; reclaimed: number; brokeAndHeld: number;
      reclaimRate: number | null; avgFollowThroughPips: number | null;
      confirmationRate: number | null;
    };
  };
  symbols: string[];
  legend: Record<string, string>;
  note: string;
}

export async function fetchLiquidityEvents(options?: {
  days?: number; symbol?: string; confirmedOnly?: boolean;
}): Promise<LiquidityEventsResponse> {
  const p = new URLSearchParams();
  if (options?.days) p.set('days', String(options.days));
  if (options?.symbol) p.set('symbol', options.symbol);
  if (options?.confirmedOnly) p.set('confirmedOnly', '1');
  const qs = p.toString();
  return fetchJson<LiquidityEventsResponse>(`/api/liquidity/events${qs ? `?${qs}` : ''}`);
}



// ── AI chart analysis tracking ──────────────────────────────────────────────
export interface AiTrack {
  id: string; symbol: string; timeframe: string;
  tradeMode: string | null; style: string | null; bias: string | null;
  verdict: string | null; decision: string | null;
  confidence: number | null;
  score: number | null; grade: string | null;
  entry: number | null; stopLoss: number | null;
  takeProfit1: number | null; takeProfit3: number | null;
  lots: number | null; riskReward: number | null;
  status: 'WAITING' | 'RUNNING' | 'TP1' | 'TP2' | 'TP3' | 'STOPPED' | 'EXPIRED' | 'NO_TRADE';
  entered: boolean;
  r: number | null; profitUsd: number | null;
  /** Both excursions: a trade that ran your way then stopped is a different failure. */
  mfeR: number | null; maeR: number | null;
  currentPrice: number | null; exitPrice: number | null;
  barsHeld: number | null; note: string | null;
  createdAt: string; resolvedAt: string | null;
}
export interface AiTracksResponse {
  days: number; symbol: string; generatedAt: string;
  tracks: AiTrack[];
  summary: {
    tracked: number; waiting: number; open: number; settled: number;
    wins: number; losses: number; winRate: number | null;
    expectancyR: number; netR: number;
    openProfitUsd: number; closedProfitUsd: number;
    avgMfeR: number | null; avgMaeR: number | null;
  };
  calibration: { band: string; n: number; winRate: number | null; expectancyR: number | null; netR: number | null }[];
  symbols: string[];
  note: string;
}

export async function fetchAiTracks(options?: { days?: number; symbol?: string }): Promise<AiTracksResponse> {
  const p = new URLSearchParams();
  if (options?.days) p.set('days', String(options.days));
  if (options?.symbol) p.set('symbol', options.symbol);
  const qs = p.toString();
  return fetchJson<AiTracksResponse>(`/api/ai/tracks${qs ? `?${qs}` : ''}`);
}

// ── Placing an AI chart plan as a real resting order ────────────────────────
export interface AiOrderTicket {
  ok: boolean; lots: number; stopLoss: number;
  takeProfit1: number | null; takeProfit2: number | null; takeProfit3: number | null;
  stopPips: number | null; riskUsd: number | null; rewardUsd: number | null;
  rr: number | null; lossAtStop: number | null;
}
export interface AiOrderPreview {
  ok: boolean; symbol: string; timeframe: string; direction: string; entry: number;
  ticket: AiOrderTicket;
  validation: { verdict: string; errors: string[]; warnings: string[]; notes: string[] };
  context: {
    riskBudget: number | null; roomWarning: string | null; safePerTradeRisk: number | null;
    equity: number | null; originalLots: number | null; originalStopPips: number | null;
    confidence: number | null; setupScore: number | null; setupGrade: string | null;
  };
}
export interface AiOrderPlaced {
  ok: boolean; id: string; orderType: string; direction: string;
  entry: number; stopLoss: number; takeProfit1: number | null;
  lots: number; stopPips: number | null; lossAtStop: number | null;
  expiresInMinutes: number; warnings: string[]; note: string;
}

/** Size and judge the ticket WITHOUT sending anything. */
export async function previewAiOrder(trackId: string, override?: Record<string, number>): Promise<AiOrderPreview> {
  const r = await fetch(`/api/ai/tracks/${encodeURIComponent(trackId)}/preview-order`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(override || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `preview failed: ${r.status}`);
  return j as AiOrderPreview;
}

/** Queue the plan for the EA. This places a REAL order. */
export async function placeAiOrder(trackId: string, body?: { expiryMinutes?: number; override?: Record<string, number> }): Promise<AiOrderPlaced> {
  const r = await fetch(`/api/ai/tracks/${encodeURIComponent(trackId)}/place-order`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `place failed: ${r.status}`);
  return j as AiOrderPlaced;
}

export async function cancelAiOrder(orderId: string): Promise<{ ok: boolean; cancelled: boolean; atBroker: boolean; note?: string }> {
  const r = await fetch(`/api/ai/tracks/order/${encodeURIComponent(orderId)}/cancel`, { method: 'POST' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `cancel failed: ${r.status}`);
  return j;
}

// ── Predicted vs actually executed ──────────────────────────────────────────
export interface AiResultItem {
  id: string; symbol: string; timeframe: string; style: string | null;
  createdAt: string | null; verdict: string | null; decision: string | null;
  confidence: number | null; setupScore: number | null; setupGrade: string | null;
  plan: {
    entry: number | null; stopLoss: number | null;
    takeProfit1: number | null; takeProfit2: number | null; takeProfit3: number | null;
    lots: number | null; riskReward: number | null;
  };
  predicted: {
    status: string; entered: boolean; r: number | null; profitUsd: number | null;
    mfeR: number | null; maeR: number | null; exitPrice: number | null;
    barsHeld: number | null; note: string | null;
  };
  actual: {
    orderId: string; status: string; orderType: string;
    ticket: string | null; positionId: string | null;
    orderedEntry: number | null; orderedLots: number | null;
    fillPrice: number | null; closePrice: number | null;
    profitUsd: number | null; riskAmount: number | null; r: number | null;
    slippagePips: number | null;
    filledAt: string | null; closedAt: string | null; placedAt: string | null;
    reason: string | null;
  } | null;
}
export interface AiResultsResponse {
  ok: boolean; days: number; symbol: string; generatedAt: string;
  items: AiResultItem[];
  predicted: { settled: number; wins: number; losses: number; winRate: number | null; netR: number | null; expectancyR: number | null; tracked: number };
  actual: { settled: number; wins: number; losses: number; winRate: number | null; netR: number | null; expectancyR: number | null; placed: number; netProfitUsd: number | null; open: number };
  gap: { pairs: number; predictedR: number | null; actualR: number | null; avgSlippagePips: number | null };
  calibration: Array<{ band: string; n: number; winRate: number | null; expectancyR: number | null; netR: number | null }>;
  notes: string[];
}

export async function fetchAiResults(options?: { days?: number; symbol?: string }): Promise<AiResultsResponse> {
  const p = new URLSearchParams();
  if (options?.days) p.set('days', String(options.days));
  if (options?.symbol) p.set('symbol', options.symbol);
  const qs = p.toString();
  return fetchJson<AiResultsResponse>(`/api/ai/results${qs ? `?${qs}` : ''}`);
}

// ── The hourly AI sweep ─────────────────────────────────────────────────────
export interface AiScannerItem {
  id: string; symbol: string; timeframe: string;
  source: 'CHART_AI' | 'SETUP_FORECAST' | 'ICT_PREDICT' | string;
  direction: string | null;
  entry: number | null; stopLoss: number | null;
  takeProfit1: number | null; takeProfit2: number | null; takeProfit3: number | null;
  lots: number | null; riskUsd: number | null; rr: number | null;
  score: number | null; grade: string | null; confidence: number | null;
  entryTiming: string | null; note: string | null;
  trackId: string | null; forecastId: string | null; ictPredictionId: string | null;
  /** The engine's own place-order route. Each source owns its guard stack. */
  placeUrl: string | null;
  order: { id: string; status: string; orderType: string; ticket: string | null; fillPrice: number | null; profit: number | null } | null;
}
export interface AiScannerRun {
  id: string; ranAt: string | null; finishedAt: string | null;
  symbols: string[]; timeframe: string;
  reads: number; opportunities: number; emailed: boolean; emailTo: string | null;
  note: string | null; items: AiScannerItem[];
}
export interface AiScannerResponse {
  ok: boolean; symbols: string[]; timeframe: string; enabled: boolean; intervalMinutes: number;
  bridgeReady: boolean; armedMatch: boolean; mode: string;
  runs: AiScannerRun[]; note: string;
}

export async function fetchAiScanner(limit = 12): Promise<AiScannerResponse> {
  return fetchJson<AiScannerResponse>(`/api/ai-scanner?limit=${limit}`);
}

export async function runAiScannerNow(): Promise<{ ok: boolean; runId?: string; reads?: number; opportunities?: number; emailed?: boolean; error?: string }> {
  const r = await fetch('/api/ai-scanner/scan', { method: 'POST' });
  return r.json();
}

/** Place a scanned opportunity through whichever engine produced it. */
export async function placeScannerItem(placeUrl: string): Promise<{ ok: boolean; id?: string; orderType?: string; lots?: number; note?: string; warnings?: string[] }> {
  const r = await fetch(placeUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `place failed: ${r.status}`);
  return j;
}

// ── AI models and API keys ──────────────────────────────────────────────────
/** Sent in place of a secret the browser was never given. */
export const AI_KEY_KEEP = '__KEEP__';

export interface AiProviderConfig {
  id: string; label: string; docs: string; vision: boolean; keyLabel: string;
  hasKey: boolean; keySource: 'saved' | 'environment' | 'none'; keyMasked: string;
  model: string; models: string[]; modelsAreLive: boolean;
  lastTestedAt: string | null; lastTestOk: boolean | null; lastTestNote: string | null;
}
export interface AiConfigResponse {
  ok: boolean; activeProvider: string; configFile: string;
  activeGeminiModel: string; providers: AiProviderConfig[];
}

export async function fetchAiConfig(): Promise<AiConfigResponse> {
  return fetchJson<AiConfigResponse>('/api/ai-config');
}

export async function saveAiConfig(update: {
  activeProvider?: string;
  providers?: Record<string, { apiKey?: string; model?: string }>;
}): Promise<AiConfigResponse> {
  const r = await fetch('/api/ai-config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(update),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `save failed: ${r.status}`);
  return j as AiConfigResponse;
}

export async function testAiProvider(provider: string, apiKey?: string): Promise<AiConfigResponse & { note: string; models: string[] }> {
  const r = await fetch('/api/ai-config/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, ...(apiKey ? { apiKey } : {}) }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `test failed: ${r.status}`);
  return j;
}

// ── ICT Sniper: immediate bare entry on an "enter now" ict-breaker signal ────
export interface SniperConfig {
  enabled: boolean;
  symbols: string[];
  timeframes: string[];
  minGrade: string;
  maxConcurrent: number;
  maxPerDay: number;
  /** Seconds the position runs with NO stop before one is attached. */
  stopDelaySeconds: number;
  /** This mode's own dollar risk, independent of Account & Sizing. */
  riskUsd: number;
}
export interface SniperTrade {
  id: string; symbol: string; timeframe: string; direction: string;
  lots: number | null; riskUsd: number | null;
  entry: number | null; fillPrice: number | null;
  stopLoss: number | null; takeProfit1: number | null;
  status: string; reason: string | null; ticket: string | null; positionId: string | null;
  profit: number | null;
  createdAt: string; filledAt: string | null; closedAt: string | null;
  /** Filled, live, and no stop on it yet — the window this mode deliberately opens. */
  unprotected: boolean;
}
export interface SniperDecision {
  at: string; fired: boolean; symbol: string; timeframe: string;
  strategy?: string; grade?: string | null; direction?: string; lots?: number; reason: string;
}
export interface SniperResponse {
  config: SniperConfig;
  interlocks: { autoTradeMode: string; bridgeReady: boolean; armedMatch: boolean; dispatchable: boolean };
  trades: SniperTrade[];
  decisions: SniperDecision[];
  summary: {
    openCount: number; unprotectedCount: number; todayCount: number;
    closedCount: number; netProfit: number | null; wins: number;
  };
  available: { symbols: string[]; timeframes: string[] };
  note: string;
}

export async function fetchSniper(): Promise<SniperResponse> {
  return fetchJson<SniperResponse>('/api/auto-trade/sniper');
}
export async function saveSniper(config: Partial<SniperConfig>): Promise<{ ok: boolean; config: SniperConfig }> {
  return fetchJson<{ ok: boolean; config: SniperConfig }>('/api/auto-trade/sniper', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config),
  });
}

// ── Modify a resting limit order (shared by ICT setups and Setup Forecasts) ──
export interface OrderModifyLeg {
  price: number; pips: number | null; usd: number | null;
  side: string; correctSide: boolean;
}
export interface OrderModifyOrder {
  id: string | null; symbol: string | null; timeframe: string | null;
  direction: string | null; orderType: string | null; status: string | null; ticket: string | null;
  entry: number | null; lots: number | null;
  stop: OrderModifyLeg | null; tp1: OrderModifyLeg | null;
  tp2: OrderModifyLeg | null; tp3: OrderModifyLeg | null;
  rr: number | null; riskUsd: number | null; rewardUsd: number | null;
  notional: number | null; notionalMultiple: number | null;
  modifiable: boolean;
}
export interface OrderModifyRead {
  ok: boolean;
  order: OrderModifyOrder;
  context: {
    pipSize: number; pipValuePerLot: number; digits: number | null;
    contractSize: number; accountEquity: number | null; riskBudget: number | null;
    minStopDistance: number | null; volMin: number; volMax: number | null; volStep: number;
  };
}
/** Edits arrive in ONE unit per leg; the server recomputes the other three. */
export interface OrderModifyChanges {
  lots?: number; entry?: number;
  slPrice?: number; slPips?: number; slUsd?: number;
  tp1Price?: number; tp1Pips?: number; tp1Usd?: number;
  tp3Price?: number; tp3Pips?: number; tp3Usd?: number;
}
export interface OrderModifyPreview {
  ok: boolean; preview?: boolean;
  plan: {
    ok: boolean;
    before: OrderModifyOrder; after: OrderModifyOrder;
    changed: string[];
    /** MT5 cannot change a resting order volume — a lot change is a cancel and a re-place. */
    requiresReplace: boolean;
    replaceWarning: string | null;
    unchanged: boolean;
  };
  validation: { verdict: 'OK' | 'RISKY' | 'REJECT' | 'INVALID'; errors: string[]; warnings: string[] };
  marketPrice?: number | null;
}
export interface OrderModifyResult extends OrderModifyPreview {
  replaced: boolean; newId?: string; note: string;
}

export async function fetchOrderModify(id: string): Promise<OrderModifyRead> {
  return fetchJson<OrderModifyRead>(`/api/orders/${encodeURIComponent(id)}/modify`);
}
export async function previewOrderModify(id: string, changes: OrderModifyChanges): Promise<OrderModifyPreview> {
  return fetchJson<OrderModifyPreview>(`/api/orders/${encodeURIComponent(id)}/modify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preview: true, changes }),
  });
}
export async function commitOrderModify(id: string, changes: OrderModifyChanges): Promise<OrderModifyResult> {
  return fetchJson<OrderModifyResult>(`/api/orders/${encodeURIComponent(id)}/modify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes }),
  });
}

/** Price the resized ticket and judge it. Read-only — places nothing. */
export async function previewIctOrder(id: string, input: IctResizeInput): Promise<IctResizePreview> {
  return fetchJson<IctResizePreview>(
    `/api/ict-predictions/${encodeURIComponent(id)}/preview-order`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) },
  );
}

/** Rest the BUY/SELL LIMIT at the pool. Places a REAL order on MT5. */
export async function placeIctOrder(id: string, expiryMinutes?: number, override?: IctResizeInput) {
  return fetchJson<{
    ok: boolean; id: string; orderType: string; direction: string;
    entry: number; stopLoss: number; takeProfit: number | null; lots: number;
    stopPips: number | null; expiresInMinutes: number; warnings: string[]; lossAtStop: number | null;
    resized?: boolean; note: string;
  }>(`/api/ict-predictions/${encodeURIComponent(id)}/place-order`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiryMinutes, override }),
  });
}

/** Resting orders placed from ICT predictions. */
export async function fetchIctPendingOrders(): Promise<IctPendingResponse> {
  return fetchJson<IctPendingResponse>('/api/ict-predictions/pending-orders');
}

/** Pull a resting ICT order off the broker. */
export async function cancelIctOrder(orderId: string) {
  return fetchJson<{ ok: boolean; cancelled: boolean; atBroker: boolean; note?: string }>(
    `/api/ict-predictions/order/${encodeURIComponent(orderId)}/cancel`, { method: 'POST' },
  );
}

/** How these predictions actually played out: arrival, reclaim, and what the resting order paid. */
export async function fetchIctTrackRecord(days = 30): Promise<IctTrackRecordResponse> {
  return fetchJson<IctTrackRecordResponse>(`/api/ict-predictions/track-record?days=${encodeURIComponent(String(days))}`);
}

/** ICT-specific AI second opinion on one prediction. Read-only; never trades or emails. */
export async function analyseIctPredictionWithAi(id: string, force = false): Promise<IctAiResponse> {
  return fetchJson<IctAiResponse>(
    `/api/ict-predictions/${encodeURIComponent(id)}/analyze${force ? '?force=1' : ''}`, { method: 'POST' },
  );
}

/** Kick a manual scan. Returns immediately; poll fetchIctPredictions and watch lastScan.at. */
export async function scanIctPredictions() {
  return fetchJson<{ ok: boolean; started: boolean; reason?: string; note?: string }>(
    '/api/ict-predictions/scan', { method: 'POST' },
  );
}
