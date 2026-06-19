import React, { useEffect, useMemo, useRef, useState, createContext, useContext } from 'react';
import type {
  Alert,
  AiAccuracyStats,
  AiAnalyzeResponse,
  AiDecision,
  AiDecisionResponse,
  CalibrationResponse,
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

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
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
    topbarAlerts,
    addTopbarAlert,
    status,
    logs,
    error,
    refresh
  }), [signals, candles, trades, indicators, aiDecisions, fttPredictions, trackedAiProjections, account, postNewsSignals, topbarAlerts, status, logs, error]);

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
  if (options?.days) params.set('days', String(options.days));
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
  if (options?.days) params.set('days', String(options.days));
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
  if (options?.days) params.set('days', String(options.days));
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
