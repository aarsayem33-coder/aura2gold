export interface Alert {
  id: string;
  symbol: string;
  timeframe: string;
  type: string;
  price: number;
  timestamp: string;
  receivedAt?: string;
  status: 'Delivered' | 'Failed' | 'Pending';
  message: string;
  direction?: 'up' | 'down' | 'neutral';
  bid?: number | null;
  ask?: number | null;
  volume?: number | null;
  account?: string | null;
  broker?: string | null;
  terminal?: string | null;
  rule?: string | null;
  delivery?: {
    channel: string;
    recipient: string;
    messageId?: string;
    error?: string;
  } | null;
  raw?: Record<string, unknown>;
}

export interface Rule {
  id: string;
  symbol: string;
  timeframe: string;
  type: string;
  targetPrice?: number;
  channels: {
    mt5: boolean;
    email: boolean;
    whatsapp: boolean;
    sms: boolean;
  };
  active: boolean;
}

export interface NotificationLog {
  id: string;
  channel: string;
  recipient: string;
  status: 'Success' | 'Failed';
  timestamp: string;
  error?: string;
  signalId?: string | null;
  messageId?: string;
  message?: string;
}

export interface Mt5Status {
  connected: boolean;
  lastHeartbeatAt: string | null;
  lastSignalAt: string | null;
  account: string | null;
  broker: string | null;
  terminal: string | null;
  version: string | null;
  accountSnapshot: Mt5AccountSnapshot | null;
  signalCount: number;
  candleCount: number;
  tradeCount: number;
  indicatorCount?: number;
  aiDecisionCount?: number;
  openTradesCount: number;
  symbols: string[];
  timeframes: string[];
  latestSignal: Alert | null;
  latestCandle: Mt5Candle | null;
  latestTrade: Mt5Trade | null;
  latestAiDecision?: AiDecision | null;
  geminiConfigured?: boolean;
  geminiModel?: string;
  serverTime: string;
  serverTimeBd?: string;
  appTimeZone?: string;
  ingestUrl: string;
  heartbeatUrl: string;
  snapshotUrl: string;
  candlesUrl: string;
  tradesUrl: string;
}

export interface IndicatorValue {
  id: string;
  symbol: string;
  timeframe: string;
  candleTime: string;
  indicator: string;
  value1: number | null;
  value2: number | null;
  value3: number | null;
  value4: number | null;
  value5: number | null;
  createdAt?: string;
  raw?: Record<string, unknown>;
}

export interface AiDecision {
  id: string;
  symbol: string;
  timeframe: string;
  decision: 'STRONG_BUY' | 'BUY' | 'HOLD' | 'SELL' | 'STRONG_SELL';
  confidence: number;
  entry_price: number | null;
  stop_loss: number | null;
  take_profit_1: number | null;
  take_profit_2: number | null;
  take_profit_3: number | null;
  risk_reward_ratio: number | null;
  reasoning: string | null;
  signals_snapshot?: unknown;
  indicators_snapshot?: Record<string, IndicatorValue> | null;
  market_context?: Record<string, unknown> | null;
  outcome: 'WIN' | 'LOSS' | 'BREAKEVEN' | 'PENDING' | 'EXPIRED';
  outcome_pips?: number | null;
  created_at: string;
  expired_at?: string | null;
  trade_trigger?: string | null;
  predicted_time?: string | null;
  suggested_lot_size?: number | null;
  risk_level?: string | null;
  system_decision?: {
    decision: 'STRONG_BUY' | 'BUY' | 'HOLD' | 'SELL' | 'STRONG_SELL';
    confidence: number;
    compositeScore: number;
    entryPrice: number | null;
    stopLoss: number | null;
    slTip: string;
    takeProfit1: number | null;
    takeProfit2: number | null;
    takeProfit3: number | null;
    tpTip: string;
    riskRewardRatio: number | null;
    entryTrigger?: string | null;
    entryTimingInstruction?: string | null;
    timingTip?: string | null;
    remainingSeconds?: number | null;
    bodyRatio?: number | null;
    fixedRiskRewardRatio?: number | null;
    realisticTarget?: number | null;
    netConviction?: number | null;
    regime?: string | null;
    htfBias?: string | null;
    rejectionReasons?: string[] | null;
    newsRisk?: {
      block: boolean;
      caution: boolean;
      reason: string;
      minutesUntil: number | null;
      event: { title: string; currency: string; impact: string; timeIso: string } | null;
    } | null;
    adrExhausted: boolean;
    adrUsagePercent: number;
    fvgs: Array<{
      type: 'BULLISH' | 'BEARISH';
      top: number;
      bottom: number;
      midpoint: number;
      time: string;
    }>;
    orderBlocks: Array<{
      type: 'BULLISH' | 'BEARISH';
      top: number;
      bottom: number;
      time: string;
    }>;
    grade?: string | null;
    buyScore?: number | null;
    sellScore?: number | null;
    confluences?: Array<{
      name: string;
      type: 'bullish' | 'bearish' | 'both';
      points: number;
      reason: string;
    }> | null;
  } | null;
}

export interface AiDecisionResponse {
  decisions: AiDecision[];
  latest?: AiDecision | null;
  status: Mt5Status;
}

export interface AiAnalyzeResponse {
  ok: boolean;
  decision: AiDecision;
  status: Mt5Status;
}

export interface IndicatorResponse {
  indicators: IndicatorValue[];
  status: Mt5Status;
}

export interface AiAccuracyStats {
  total: number;
  wins: number;
  losses: number;
  breakeven: number;
  pending: number;
  winRate: number;
}

export interface Mt5Candle {
  id: string;
  symbol: string;
  timeframe: string;
  time: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume?: number | null;
  spread?: number | null;
  sourceIp?: string | null;
  raw?: Record<string, unknown>;
}

export interface Mt5Trade {
  id: string;
  ticket: string;
  symbol: string;
  type: string;
  volume: number | null;
  openPrice: number | null;
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  profit: number | null;
  swap?: number | null;
  commission?: number | null;
  magic?: string | null;
  comment?: string | null;
  status: string;
  openTime: string;
  closeTime?: string | null;
  account?: string | null;
  broker?: string | null;
  terminal?: string | null;
  sourceIp?: string | null;
  raw?: Record<string, unknown>;
}

export interface Mt5AccountSnapshot {
  id: string;
  receivedAt: string;
  account: string | null;
  broker: string | null;
  terminal: string | null;
  version: string | null;
  balance: number | null;
  equity: number | null;
  margin: number | null;
  freeMargin: number | null;
  profit: number | null;
  currency: string | null;
  leverage: number | null;
  marginLevel: number | null;
  openOrders: number | null;
  openTrades: number | null;
  symbols: string[] | null;
  timeframes: string[] | null;
  raw?: Record<string, unknown>;
}

export interface Mt5SignalResponse {
  ok: boolean;
  signal: Alert;
  status: Mt5Status;
}

export interface Mt5HistoryResponse {
  signals: Alert[];
  candles?: Mt5Candle[];
  trades?: Mt5Trade[];
  account?: Mt5AccountSnapshot | null;
  status: Mt5Status;
}

export interface Mt5CandleResponse {
  candles: Mt5Candle[];
  status: Mt5Status;
}

export interface Mt5CandleCoverageRow {
  symbol: string;
  timeframe: string;
  count: number;
  firstTime: string | null;
  lastTime: string | null;
}

export interface Mt5CandleCoverageResponse {
  rows: Mt5CandleCoverageRow[];
  symbols: string[];
  timeframes: string[];
  status: Mt5Status;
}

export interface Mt5TradeResponse {
  trades: Mt5Trade[];
  status: Mt5Status;
}

export interface Mt5AccountResponse {
  account: Mt5AccountSnapshot | null;
  status: Mt5Status;
}

export interface Mt5LogsResponse {
  logs: NotificationLog[];
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: 'Admin' | 'Client';
  status: 'Active' | 'Inactive';
}

export interface ScanResult {
  symbol: string;
  timeframe: string;
  systemDecision: {
    decision: 'STRONG_BUY' | 'BUY' | 'HOLD' | 'SELL' | 'STRONG_SELL';
    confidence: number;
    compositeScore: number;
    entryPrice: number | null;
    stopLoss: number | null;
    slTip: string;
    takeProfit1: number | null;
    takeProfit2: number | null;
    takeProfit3: number | null;
    tpTip: string;
    riskRewardRatio: number | null;
    entryTrigger?: string | null;
    entryTimingInstruction?: string | null;
    timingTip?: string | null;
    remainingSeconds?: number | null;
    bodyRatio?: number | null;
    fixedRiskRewardRatio?: number | null;
    realisticTarget?: number | null;
    netConviction?: number | null;
    regime?: string | null;
    htfBias?: string | null;
    rejectionReasons?: string[] | null;
    newsRisk?: {
      block: boolean;
      caution: boolean;
      reason: string;
      minutesUntil: number | null;
      event: { title: string; currency: string; impact: string; timeIso: string } | null;
    } | null;
    adrExhausted: boolean;
    adrUsagePercent: number;
    fvgs: Array<{
      type: 'BULLISH' | 'BEARISH';
      top: number;
      bottom: number;
      midpoint: number;
      time: string;
    }>;
    orderBlocks: Array<{
      type: 'BULLISH' | 'BEARISH';
      top: number;
      bottom: number;
      time: string;
    }>;
    grade?: string | null;
    buyScore?: number | null;
    sellScore?: number | null;
    confluences?: Array<{
      name: string;
      type: 'bullish' | 'bearish' | 'both';
      points: number;
      reason: string;
    }> | null;
  } | null;
  latestAiDecision: AiDecision | null;
}

export interface ScanAllResponse {
  ok: boolean;
  results: ScanResult[];
  status: Mt5Status;
}

// ─── Fixed-Time Trading (FTT) ───────────────────────────────────────────

export interface FttPrediction {
  id: string;
  symbol: string;
  expiry: string;
  direction: 'UP' | 'DOWN' | 'HOLD';
  confidence: number;
  entryPrice: number | null;
  entryTime: string;
  expiryTime: string;
  exitPrice: number | null;
  outcome: 'WIN' | 'LOSS' | 'DRAW' | 'PENDING' | 'EXPIRED';
  source: 'system' | 'ai';
  reasoning: string | null;
  indicators: Record<string, unknown> | null;
  created_at: string;
}

export interface FttScanResult {
  symbol: string;
  expiry: string;
  systemPrediction: {
    direction: 'UP' | 'DOWN' | 'HOLD';
    confidence: number;
    entryPrice: number | null;
    reasoning: string;
    indicators?: Record<string, any> | null;
  } | null;
  latestAiPrediction: FttPrediction | null;
}

export interface FttScanResponse {
  ok: boolean;
  results: FttScanResult[];
  status: Mt5Status;
}

export interface FttPredictResponse {
  ok: boolean;
  prediction: FttPrediction;
  status: Mt5Status;
}

export interface FttHistoryResponse {
  predictions: FttPrediction[];
  status: Mt5Status;
}


// ─── Economic Calendar (MT5-native news) ────────────────────────────────

export type NewsImpact = 'HIGH' | 'MODERATE' | 'LOW' | 'NONE' | 'HOLIDAY';

export interface NewsEvent {
  id: string;
  currency: string;
  country: string;
  impact: NewsImpact;
  title: string;
  timestampUtc: number;
  timeIso: string;
  actual: number | null;
  forecast: number | null;
  previous: number | null;
}

export interface NewsSourceHealth {
  count: number;
  updatedAt: string | null;
  fresh: boolean;
  active: boolean;
  error: string | null;
}

export interface NewsResponse {
  events: NewsEvent[];
  count: number;
  updatedAt: string | null;
  source: string | null;
  serverGmtOffsetSec: number;
  sources?: Record<string, NewsSourceHealth>;
  status: Mt5Status;
}
