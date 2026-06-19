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
    signalQuality?: 'A+ SIGNAL' | 'A SIGNAL' | 'B SIGNAL' | 'WATCH' | string | null;
    strategyType?: string | null;
    strategyTags?: string[] | null;
    datFramework?: {
      direction: { pass: boolean; value: string; reason: string };
      area: { pass: boolean; reason: string };
      trigger: { pass: boolean; pattern: string | null; reason: string };
      score: number;
    } | null;
    candlePatterns?: Array<{ name: string; direction: string; strength: number; reason: string }> | null;
    ote?: { active: boolean; direction: string; zone: Record<string, number> | null; reason: string } | null;
    bpr?: { active: boolean; zone: Record<string, number> | null; reason: string } | null;
    amd?: { phase: string; direction: string; active: boolean; reason: string; range?: { high: number; low: number } } | null;
    sessionContext?: { activeStopHuntWindow: boolean; reason: string; currencies: string[]; active: Array<Record<string, string>>; windows: Array<Record<string, string>> } | null;
    riskPlan?: { riskPercent: number; maxRiskPercent: number; leverage?: number; multiplier?: string; equity: number | null; riskAmount: number | null; amountToRisk?: number | null; stopPips: number | null; suggestedLotSize: number | null; marginRequired?: number | null; amountToInvestApprox?: number | null; lossAtStop?: number | null; maxLoss?: number | null; profitAtTp1?: number | null; profitAtTp2?: number | null; profitAtTp3?: number | null; passed: boolean } | null;
    entryReason?: string | null;
    slReason?: string | null;
    tpReason?: string | null;
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

export type TrackedAiProjectionStatus = 'PENDING' | 'TRIGGERED' | 'INVALIDATED' | 'EXPIRED';

export interface TrackedAiProjection {
  id: string;
  sourceAnalysisId?: string | null;
  symbol: string;
  tradeMode: 'FTT' | 'FOREX';
  decision: 'STRONG_BUY' | 'BUY' | 'HOLD' | 'SELL' | 'STRONG_SELL';
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  takeProfit3: number | null;
  invalidation: string | null;
  invalidationPrice: number | null;
  tradeTrigger: string;
  confidence: number;
  status: TrackedAiProjectionStatus;
  currentPrice: number | null;
  lastCheckedAt: string | null;
  triggeredAt: string | null;
  invalidatedAt: string | null;
  expiresAt: string | null;
  createdAt: string | null;
  evaluation?: {
    reason?: string;
    checks?: Array<{ name: string; ok: boolean; reason: string }>;
    [key: string]: unknown;
  } | null;
  originalAnalysis?: unknown;
}

export interface TrackedAiProjectionResponse {
  tracked: TrackedAiProjection[];
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

export interface EmailAlertSettings {
  forexScanner: boolean;
  fixedTime: boolean;
  postNewsForex: boolean;
  postNewsFixed: boolean;
  highImpactNews: boolean;
  aiTracked: boolean;
  forexMinGrade: 'B_SETUP' | 'A_SETUP' | 'A_PLUS_SETUP';
  forexMinQuality: 'B_SIGNAL' | 'A_SIGNAL' | 'A_PLUS_SIGNAL';
  fixedTimeMinTier: 'QUALITY_SIGNAL' | 'TRADE_SIGNAL';
  postNewsForexMinGrade: 'B_NEWS_SETUP' | 'A_NEWS_SETUP' | 'A_PLUS_NEWS_SETUP';
  postNewsFixedMinTier: 'QUALITY_SIGNAL' | 'TRADE_SIGNAL';
}

export interface EmailAlertSettingsResponse {
  ok: boolean;
  settings: EmailAlertSettings;
  email_to?: string | null;
  news_email_to?: string | null;
  smtpConfigured?: boolean;
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
    strategyType?: string | null;
    strategyTags?: string[] | null;
    datFramework?: {
      direction: { pass: boolean; value: string; reason: string };
      area: { pass: boolean; reason: string };
      trigger: { pass: boolean; pattern: string | null; reason: string };
      score: number;
    } | null;
    candlePatterns?: Array<{ name: string; direction: string; strength: number; reason: string }> | null;
    ote?: { active: boolean; direction: string; zone: Record<string, number> | null; reason: string } | null;
    bpr?: { active: boolean; zone: Record<string, number> | null; reason: string } | null;
    amd?: { phase: string; direction: string; active: boolean; reason: string; range?: { high: number; low: number } } | null;
    sessionContext?: { activeStopHuntWindow: boolean; reason: string; currencies: string[]; active: Array<Record<string, string>>; windows: Array<Record<string, string>> } | null;
    riskPlan?: { riskPercent: number; maxRiskPercent: number; leverage?: number; multiplier?: string; equity: number | null; riskAmount: number | null; amountToRisk?: number | null; stopPips: number | null; suggestedLotSize: number | null; marginRequired?: number | null; amountToInvestApprox?: number | null; lossAtStop?: number | null; maxLoss?: number | null; profitAtTp1?: number | null; profitAtTp2?: number | null; profitAtTp3?: number | null; passed: boolean } | null;
    entryReason?: string | null;
    slReason?: string | null;
    tpReason?: string | null;
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
  outcome: 'WIN' | 'LOSS' | 'DRAW' | 'PENDING' | 'EXPIRED' | 'NO_TRADE';
  source: 'system' | 'ai' | 'news';
  reasoning: string | null;
  indicators: Record<string, unknown> | null;
  created_at: string;
  tradeStatus?: 'QUALITY_SIGNAL' | 'TRADE_SIGNAL' | 'WATCH_ONLY' | 'NO_TRADE';
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
    tradeStatus?: 'QUALITY_SIGNAL' | 'TRADE_SIGNAL' | 'WATCH_ONLY' | 'NO_TRADE';
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

export interface TopbarMarketAlert {
  id: string;
  kind: 'FOREX' | 'FIXED_TIME';
  symbol: string;
  timeframe?: string | null;
  expiry?: string | null;
  direction: string;
  grade?: string | null;
  quality?: string | null;
  confidence: number;
  entryPrice?: number | null;
  stopLoss?: number | null;
  takeProfit1?: number | null;
  takeProfit2?: number | null;
  takeProfit3?: number | null;
  investment?: number | null;
  maxLoss?: number | null;
  lotSize?: number | null;
  tradeTime?: string | null;
  expiryTime?: string | null;
  sessionReason?: string | null;
  createdAt: string;
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

// ─── News-reaction signals (high-impact news page) ──────────────────────

export interface NewsScenario {
  trigger: string;
  currencyEffect: string;
  pairDirection: 'UP' | 'DOWN' | 'NEUTRAL';
  watchLevel: number | null;
  note: string;
}

export interface NewsSignal {
  id: string;
  symbol: string;
  event: {
    id: string;
    title: string;
    currency: string;
    impact: NewsImpact;
    timeIso: string;
    minutesUntil: number;
    forecast: number | null;
    previous: number | null;
    actual: number | null;
  };
  hasPosition: boolean;
  positionSide: 'BUY' | 'SELL' | null;
  price: number | null;
  htfBias: string;
  compositeScore: number;
  grade: string | null;
  keyLevels: { recentHigh: number | null; recentLow: number | null };
  scenarios: NewsScenario[];
  recommendation: string;
  priority: number;
}

export interface NewsSignalResponse {
  signals: NewsSignal[];
  count: number;
  generatedAt: string;
  calendarSource: string | null;
  status: Mt5Status;
}


// ─── Post-news entry signals (after actual value prints, post +30m blackout) ──

export interface PostNewsSignal {
  id: string;
  symbol: string;
  event: {
    id: string;
    title: string;
    currency: string;
    impact: NewsImpact;
    timeIso: string;
    actual: number | null;
    forecast: number | null;
    previous: number | null;
  };
  surprise: { bias: 'bullish' | 'bearish' | 'neutral'; deltaPct: number; basis: string };
  expectedDir: 'UP' | 'DOWN' | 'NEUTRAL';
  realizedDir: 'UP' | 'DOWN' | 'NEUTRAL';
  realizedMovePct: number;
  direction: 'UP' | 'DOWN' | 'NEUTRAL';
  confidence: number;
  price: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  htfBias: string;
  status: 'WAITING' | 'ACTIVE';
  tradeableAtIso: string;
  expiresAtIso: string;
  minutesToTradeable: number;
  note: string;
}

export interface PostNewsSignalResponse {
  signals: PostNewsSignal[];
  count: number;
  generatedAt: string;
  status: Mt5Status;
}

export interface TradeNewsForexSignal extends PostNewsSignal {
  tradeType: 'forex';
  eventType: string;
  directionLabel: 'BUY' | 'SELL' | 'WAIT';
  grade: string;
  riskRewardRatio: number | null;
  setupChecklist: string[];
}

export interface TradeNewsFixedSignal {
  id: string;
  tradeType: 'fixed';
  symbol: string;
  event: PostNewsSignal['event'];
  eventType: string;
  surprise: PostNewsSignal['surprise'];
  expectedDir: PostNewsSignal['expectedDir'];
  realizedDir: PostNewsSignal['realizedDir'];
  direction: PostNewsSignal['direction'];
  expiry: string;
  confidence: number;
  grade: string;
  qualityTier?: 'QUALITY_SIGNAL' | 'TRADE_SIGNAL' | 'WATCH_ONLY' | 'NO_TRADE';
  qualityScore?: number;
  qualityReasons?: string[];
  riskWarnings?: string[];
  volatilityState?: string;
  detectedPatterns?: string[];
  entryPrice: number | null;
  entryTime: string;
  expiryTime: string;
  status: 'WAITING' | 'ACTIVE';
  candleBiasTf: string;
  candleTrendTf: string;
  candleEntryTf: string;
  candleConfirmTf: string;
  note: string;
  reasoning: string;
}

export interface TradeNewsResponse<T> {
  ok: boolean;
  type?: 'forex' | 'fixed';
  signals: T[];
  count: number;
  generatedAt: string;
  status: Mt5Status;
}


// ─── Pullback Level & Timing Projections (math + optional AI) ───────────

export interface ProjectionItem {
  id: string;
  symbol: string;
  timeframe: string;
  source: 'OB' | 'FVG';
  bias: 'BULLISH' | 'BEARISH';
  orderType: 'BUY_LIMIT' | 'SELL_LIMIT';
  directionAfterTouch: 'UP' | 'DOWN';
  currentPrice: number;
  entryPrice: number;
  zoneTop: number;
  zoneBottom: number;
  formedAt: string;
  distance: number;
  distancePips: number;
  atr: number;
  candlesToReach: number;
  minutesToReach: number;
  projectedTouchMs: number;
  projectedTouchIso: string;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  riskReward: number;
  suitability: { forex: boolean; ftt: boolean; fttExpiry: string };
  mathConfidence: number;
  grade?: string;
  rationale: string;
}

export interface ProjectionSymbolResult {
  symbol: string;
  timeframe: string;
  currentPrice: number | null;
  atr: number;
  htfTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  generatedAt?: string;
  projections: ProjectionItem[];
  outdated?: boolean;
  note?: string;
}

export interface ProjectionScanResponse {
  ok: boolean;
  timeframe: string;
  results: ProjectionSymbolResult[];
  generatedAt: string;
  cached: boolean;
  status: Mt5Status;
}

export interface ProjectionAiValidation {
  id: string;
  status: 'APPROVED' | 'REJECTED' | 'NEUTRAL';
  optimal_entry: number | null;
  predicted_time_to_reach: string;
  direction_after_touch: 'UP' | 'DOWN';
  trade_type: string[];
  ftt_expiry_recommended: string;
  stop_loss: number | null;
  take_profit: number | null;
  confidence: number;
  rationale: string;
}

export interface ProjectionAiResult {
  available: boolean;
  validations: ProjectionAiValidation[];
  overall_summary: string;
}

export interface ProjectionAnalyzeResponse {
  ok: boolean;
  symbol: string;
  timeframe: string;
  projection: ProjectionSymbolResult;
  ai: ProjectionAiResult;
  status: Mt5Status;
}

export interface ProjectionReminder {
  id: string;
  projection_id: string;
  symbol: string;
  timeframe: string;
  bias: string;
  entry_price: number;
  stop_loss: number;
  take_profit_1: number;
  take_profit_2: number;
  suitability_forex: boolean;
  suitability_ftt: boolean;
  suitability_ftt_expiry?: string;
  projected_touch_time: string;
  email: string;
  math_confidence: number;
  grade: string;
  rationale?: string;
  ai_on: boolean;
  status: 'PENDING' | 'CHECKED' | 'SENT' | 'FAILED';
  check_result_json?: string;
  created_at: string;
}

export interface SavedProjection {
  id: string;
  projection_id: string;
  symbol: string;
  timeframe: string;
  bias: 'BULLISH' | 'BEARISH';
  entry_price: number;
  stop_loss: number;
  take_profit_1: number;
  take_profit_2: number;
  suitability_forex: boolean;
  suitability_ftt: boolean;
  suitability_ftt_expiry?: string;
  projected_touch_time: string;
  math_confidence: number;
  grade: string;
  rationale?: string;
  status: 'PENDING' | 'WIN' | 'LOSS' | 'DRAW' | 'EXPIRED';
  created_at: string;
  resolved_at?: string;
}

export interface SignalEmailReport {
  id: string;
  signalType: 'forex' | 'fixed';
  referenceId?: string | null;
  symbol: string;
  timeframe?: string | null;
  expiry?: string | null;
  direction: string;
  entryPrice?: number | null;
  exitPrice?: number | null;
  stopLoss?: number | null;
  takeProfit1?: number | null;
  profitLossPips?: number | null;
  confidence?: number | null;
  grade?: string | null;
  outcome: string;
  signalTime?: string | null;
  tradeTime?: string | null;
  resolvedAt?: string | null;
  emailSentAt?: string | null;
  alertDelaySeconds?: number | null;
  sourceCandleTime?: string | null;
  sourceReceivedAt?: string | null;
  emailTo?: string | null;
  candleBiasTf?: string | null;
  candleTrendTf?: string | null;
  candleEntryTf?: string | null;
  candleConfirmTf?: string | null;
  payload?: {
    signalQuality?: string;
    strategyType?: string;
    strategyTags?: string[];
    datFramework?: {
      direction: { pass: boolean; value: string; reason: string };
      area: { pass: boolean; reason: string };
      trigger: { pass: boolean; pattern: string | null; reason: string };
      score: number;
    };
    sessionContext?: { reason?: string };
    riskPlan?: { riskPercent?: number; stopPips?: number | null; suggestedLotSize?: number | null; marginRequired?: number | null; lossAtStop?: number | null; profitAtTp1?: number | null; profitAtTp2?: number | null; profitAtTp3?: number | null; multiplier?: string; leverage?: number };
    [key: string]: unknown;
  } | null;
}

export interface TradeReportSummary {
  total: number;
  wins: number;
  losses: number;
  draws: number;
  pending: number;
  expired: number;
  tp1Wins?: number;
  tp2Wins?: number;
  tp3Wins?: number;
  tp1Rate?: number;
  tp2Rate?: number;
  tp3Rate?: number;
  tp1WinRate?: number;
  tp2WinRate?: number;
  tp3WinRate?: number;
  winRate: number;
  successRate: number;
  failRate: number;
  netPips: number;
  avgPips: number;
}

export interface SignalEmailReportsResponse {
  ok: boolean;
  type: 'forex' | 'fixed';
  reports: SignalEmailReport[];
  summary: TradeReportSummary;
  filters: Record<string, unknown>;
  status?: Mt5Status;
}

export interface CalibrationGroupStat {
  value: string;
  total: number;
  settled: number;
  wins: number;
  losses: number;
  draws: number;
  breakeven: number;
  tp1Wins?: number;
  tp2Wins?: number;
  tp3Wins?: number;
  tp1WinRate?: number;
  tp2WinRate?: number;
  tp3WinRate?: number;
  pending: number;
  noTrade: number;
  expired: number;
  ambiguous: number;
  avgConfidence: number;
  avgPips: number;
  netPips: number;
  winRate: number;
}

export interface CalibrationResponse {
  ok: boolean;
  type: 'forex' | 'fixed';
  total: number;
  overall: TradeReportSummary & {
    settled: number;
    breakeven: number;
    noTrade: number;
    ambiguous: number;
  };
  leaderboards: Record<string, CalibrationGroupStat[]>;
  dimensions: string[];
  filters: Record<string, unknown>;
  status?: Mt5Status;
}

export interface SystemSignalLogRow {
  id: string;
  symbol: string;
  timeframe: string;
  barTime: string | null;
  signalTime: string | null;
  direction: string;
  grade: string | null;
  signalQuality: string | null;
  confidence: number | null;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  takeProfit3: number | null;
  strategyType: string | null;
  session: string | null;
  regime: string | null;
  pattern: string | null;
  emailed: boolean;
  emailReportId: string | null;
  outcome: string;
  exitPrice: number | null;
  profitLossPips: number | null;
  tpHitLevel: number | null;
  mfePips: number | null;
  maePips: number | null;
  resolvedAt: string | null;
  payload: Record<string, unknown> | null;
}

export interface SignalLogBucket {
  total: number;
  settled: number;
  wins: number;
  losses: number;
  netPips: number;
  winRate: number;
}

export interface SignalLogResponse {
  ok: boolean;
  rows: SystemSignalLogRow[];
  summary: { all: SignalLogBucket; emailed: SignalLogBucket; filtered: SignalLogBucket };
  count: number;
}

export interface ProjectionTrackBucket {
  value: string;
  total: number;
  wins: number;
  losses: number;
  expired: number;
  pending: number;
  settled: number;
  hitRate: number | null;
  confidence: string;
}

export interface ProjectionTrackRecord {
  ok: boolean;
  days: number;
  overall: {
    total: number; wins: number; losses: number; expired: number; pending: number;
    settled: number; hitRate: number | null; confidence: string;
  };
  byGrade: ProjectionTrackBucket[];
  byTimeframe: ProjectionTrackBucket[];
  byBias: ProjectionTrackBucket[];
  byConfidence: ProjectionTrackBucket[];
  note: string;
}

export interface ForexBacktestSample {
  id: string;
  symbol: string;
  timeframe?: string | null;
  direction: string;
  outcome: string;
  tpHitLevel: number;
  entryPrice?: number | null;
  exitPrice?: number | null;
  profitLossPips?: number | null;
  mfePips?: number | null;
  maePips?: number | null;
  barsToResolution?: number | null;
  signalTime?: string | null;
  resolvedAt?: string | null;
}

export interface ForexBacktestResponse {
  ok: boolean;
  type: 'forex';
  summary: {
    total: number;
    valid: number;
    settled: number;
    wins: number;
    losses: number;
    breakeven: number;
    expired: number;
    ambiguous: number;
    tp1Wins: number;
    tp2Wins: number;
    tp3Wins: number;
    tp1HitRate: number;
    tp2HitRate: number;
    tp3HitRate: number;
    avgBarsToResolution: number;
    avgMfePips: number;
    avgMaePips: number;
    netPips: number;
    avgPips: number;
    expectancyPips: number;
    winRate: number;
  };
  samples: ForexBacktestSample[];
  filters: Record<string, unknown>;
  status?: Mt5Status;
}
