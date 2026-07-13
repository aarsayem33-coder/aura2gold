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
  marketStatus?: { open: boolean; state: 'OPEN' | 'CLOSED'; reason: string };
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
    premiumDiscount?: { pct: number; zone: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM'; fit: 'GOOD' | 'POOR' | 'NEUTRAL'; rangeHigh: number; rangeLow: number; equilibrium: number } | null;
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
  forecast: boolean;
  signalTracker: boolean;
  breakout: boolean;
  breakoutEmailMinGrade: 'B' | 'A' | 'A+';
  strategyLab: boolean;
  strategyLabFixedTime: boolean;
  forexMinGrade: 'B_SETUP' | 'A_SETUP' | 'A_PLUS_SETUP';
  forexMinQuality: 'B_SIGNAL' | 'A_SIGNAL' | 'A_PLUS_SIGNAL';
  fixedTimeMinTier: 'QUALITY_SIGNAL' | 'TRADE_SIGNAL';
  postNewsForexMinGrade: 'B_NEWS_SETUP' | 'A_NEWS_SETUP' | 'A_PLUS_NEWS_SETUP';
  postNewsFixedMinTier: 'QUALITY_SIGNAL' | 'TRADE_SIGNAL';
  // Strategy Lab email rules — forex (TP/SL) framing.
  strategyLabMinScore: number;
  strategyLabMinGrade: 'ANY' | 'B' | 'A' | 'A+';
  strategyLabStrategies: Record<string, boolean>;
  // Strategy Lab email rules — fixed-time (direction at next-candle expiry) framing.
  strategyLabFttMinScore: number;
  strategyLabFttMinGrade: 'ANY' | 'B' | 'A' | 'A+';
  strategyLabFttStrategies: Record<string, boolean>;
  // Strategy Controller — master per-strategy switch (gates table, reports, popups, emails,
  // SSE). Missing entry = enabled. Optional refinements gate alert delivery.
  strategyControls?: Record<string, StrategyControl>;
  // Signal email recipients (user-managed, up to 10). Empty = backend env default address.
  emailRecipients?: string[];
  // Per-recipient routing (keyed by address): which symbols/timeframes THAT address
  // receives. Missing entry / empty lists = everything. Delivery-only.
  emailRecipientRules?: Record<string, { symbols?: string[]; timeframes?: string[] }>;
  // Per-strategy EMAIL refinements (score / grade / symbols / direction). DELIVERY-only — cuts
  // email noise per strategy without touching signal generation, logging, popups, or ranking.
  // Applies to BOTH the forex and fixed-time strategy-lab email framings. symbols empty/absent =
  // all symbols; minScore/minGrade present = override that framing's global minimum for the strategy.
  strategyLabRules?: Record<string, StrategyEmailRule>;
}

export interface StrategyEmailRule {
  minScore?: number;
  minGrade?: 'ANY' | 'B' | 'A' | 'A+';
  symbols?: string[];
  direction?: 'ANY' | 'LONG' | 'SHORT';
}

export interface StrategyControl {
  enabled?: boolean;
  minScore?: number;
  direction?: 'ANY' | 'LONG' | 'SHORT';
  timeframes?: string[];
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
    premiumDiscount?: { pct: number; zone: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM'; fit: 'GOOD' | 'POOR' | 'NEUTRAL'; rangeHigh: number; rangeLow: number; equilibrium: number } | null;
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
  kind: 'FOREX' | 'FIXED_TIME' | 'BREAKOUT';
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
  // Trade-management alerts (Signal Tracker) — distinct from new-entry signals so
  // the popup never renders a "close/manage" alert as a fresh trade to enter.
  alertKind?: 'MANAGE' | 'CLOSE';
  reason?: string | null;
  action?: string | null;
  currentR?: number | null;
  currentPips?: number | null;
  // Strategy Lab signals — distinct source label so they read as a separate engine.
  strategySource?: string | null;
  // Breakout alerts (graded PRE/CONFIRMED) — additive top-bar + desktop alert.
  phase?: 'PRE' | 'CONFIRMED' | null;
  level?: number | null;
  levelStrength?: number | null;
  score?: number | null;
  trend?: 'UP' | 'DOWN' | null;
  distanceAtr?: number | null;
  bodyAtr?: number | null;
  reasons?: string[] | null;
}

// ── Breakout tracker (graded PRE/CONFIRMED breakouts on well-formed charts) ──
export interface BreakoutLiveRow {
  symbol: string;
  timeframe: string;
  phase: 'PRE' | 'CONFIRMED';
  direction: 'BUY' | 'SELL';
  trend: 'UP' | 'DOWN';
  grade: 'A+' | 'A' | 'B' | 'C';
  score: number;
  level: number;
  levelStrength: number;
  price: number;
  atr: number | null;
  distanceAtr: number | null;
  bodyAtr: number | null;
  displacement: { present: boolean; strong: boolean } | null;
  reasons: string[];
  bar: string;
  stale: boolean;
  meetsBrowserBar: boolean;
}

export interface BreakoutLiveResponse {
  ok: boolean;
  enabled: boolean;
  timeframe: string;
  timeframes: string[];
  browserMinGrade: string;
  emailMinGrade: string;
  confirmed: number;
  pre: number;
  rows: BreakoutLiveRow[];
  generatedAt: string;
}

export interface BreakoutAlert {
  id: string;
  symbol: string;
  timeframe: string;
  phase: 'PRE' | 'CONFIRMED';
  direction: 'BUY' | 'SELL';
  grade: string;
  score: number | null;
  trend: 'UP' | 'DOWN' | null;
  level: number | null;
  levelStrength: number | null;
  price: number | null;
  atr: number | null;
  distanceAtr: number | null;
  bodyAtr: number | null;
  displacement: boolean;
  channel: string;
  barTime: string | null;
  createdAt: string | null;
}

export interface BreakoutAlertsResponse {
  ok: boolean;
  alerts: BreakoutAlert[];
}

// ── Confirmed-breakout follow-through tracking (did the break extend or fail?) ─
export type BreakoutTrackState = 'FOLLOWING_THROUGH' | 'STALLING' | 'TARGET_HIT' | 'FAILED';
export interface BreakoutTrackingRow {
  id: string;
  symbol: string;
  timeframe: string;
  direction: 'BUY' | 'SELL';
  trend: string | null;
  grade: string;
  score: number;
  levelStrength: number | null;
  confirmIso: string | null;
  ageHours: number | null;
  stale: boolean;
  state: BreakoutTrackState;
  level: number;
  confirmPrice: number;
  currentPrice: number;
  targetPrice: number;
  beyond: number; beyondAtr: number; sinceConfirm: number;
  mfe: number; mfeAtr: number; mae: number; maeAtr: number;
  beyondPips: number; mfePips: number; maePips: number;
  progressPct: number; barsSince: number; atr: number;
  failed: boolean; reachedTarget: boolean;
  liveScore: number; liveGrade: string; retentionPct: number;
}
export interface BreakoutTrackingResponse {
  ok: boolean;
  timeframe: string;
  windowHours: number;
  active: BreakoutTrackingRow[];
  settled: BreakoutTrackingRow[];
  stats: { active: number; targetHit: number; failed: number; winRate: number | null };
  generatedAt: string;
}

// ── Strategy entry-watch (A/A+ ICT · ICT+ · SMC forex signals awaiting entry) ─
export interface StrategyEntryWatchItem {
  id: string;
  strategy: string;
  strategyName: string;
  symbol: string;
  timeframe: string;
  signalTime: string | null;
  direction: string;
  score: number | null;
  grade: string | null;
  // Current-time re-evaluation of the same setup (how strong it is RIGHT NOW).
  currentScore: number | null;
  currentGrade: string | null;
  currentDirection: string | null;
  strengthTrend: 'STRONGER' | 'SAME' | 'WEAKER' | 'GONE';
  executability: 'EXECUTE_NOW' | 'WAIT' | 'CAUTION' | 'MISSED' | 'FILLED';
  execMessage: string | null;
  entryPrice: number | null;
  currentPrice: number | null;
  pipsToEntry: number | null;
  liveEntryPrice: number | null;
  liveStopLoss: number | null;
  liveTakeProfit1: number | null;
  liveTakeProfit2: number | null;
  liveTakeProfit3: number | null;
  liveRiskReward: number | null;
  betterEntryAvailable: boolean;
  betterEntryPrice: number | null;
  betterStopLoss: number | null;
  betterTakeProfit1: number | null;
  betterTakeProfit2: number | null;
  betterTakeProfit3: number | null;
  betterRiskReward: number | null;
  betterLots: number | null;
  betterLossAtStop: number | null;
  entryImprovementPips: number | null;
  pipsToBetterEntry: number | null;
  activeEntryPrice: number | null;
  pipsToActiveEntry: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  takeProfit3: number | null;
  riskReward: number | null;
  lots: number | null;
  lossAtStop: number | null;
  activeLots: number | null;
  activeLossAtStop: number | null;
  entryStatus: 'WAIT' | 'AT_ENTRY' | 'MISSED';
  reachedEntry: boolean;
  executableNow: boolean;
  timingMessage: string | null;
  reason: string | null;
  popupSent: boolean | null;
  emailSent: boolean | null;
}

export interface StrategyEntryWatchResponse {
  ok: boolean;
  minScore: number;
  maxScore: number;
  windowHours: number;
  strategies: string[];
  filters?: { strategies: string[]; symbols: string[]; timeframes: string[] };
  items: StrategyEntryWatchItem[];
  generatedAt: string;
}

// ── Strategy Lab (isolated single-strategy signals) ─────────────────────────
export interface StrategyMeta {
  id: string;
  name: string;
  source: string | null;
  description: string;
  timeframes: string[];
  forexOnly?: boolean;
  control?: StrategyControl; // controller state from /strategies (default = enabled)
}
export interface StrategyTiming {
  status: 'WAIT' | 'TRADABLE' | 'FILLED' | 'EXPIRED' | 'SETTLED';
  expectEntryBy: string | null;
  message: string;
}
export interface StrategySignal {
  id: string;
  strategy: string;
  symbol: string;
  timeframe: string;
  signalTime: string | null;
  direction: string;
  score: number | null;
  grade: string | null;
  // Score evolution — latest re-detected score/grade + when it last changed (null = unchanged
  // since the first call). score/grade above stay frozen at first detection.
  latestScore?: number | null;
  latestGrade?: string | null;
  scoreUpdatedAt?: string | null;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  takeProfit3: number | null;
  riskReward: number | null;
  reason: string | null;
  strategyVersion?: number | null;
  setupPlan?: string | null;
  entryOrderType?: 'MARKET' | 'LIMIT' | 'STOP' | string | null;
  entryState?: string | null;
  entryFilledAt?: string | null;
  validUntil?: string | null;
  correctedOutcome?: string | null;
  correctedPips?: number | null;
  correctionReason?: string | null;
  lots: number | null;
  stopPips: number | null;
  lossAtStop: number | null;
  timing: StrategyTiming;
  outcome: string;
  profitLossPips: number | null;
  tpHitLevel: number | null;
  ftOutcome: string | null;
  ftPips: number | null;
  ftActionable?: boolean | null;
  ftExpiryIso?: string | null;
  // As-traded (realistic) fixed-time outcome: entered at the live price when the signal fired,
  // expired at signal_time + duration. atGapPips = atPips − ftPips (cost of the signal→entry delay).
  atOutcome?: string | null;
  atRefPrice?: number | null;
  atExitPrice?: number | null;
  atPips?: number | null;
  atGapPips?: number | null;
  atExpiryIso?: string | null;
  live?: { currentPrice: number; reference: number; pips: number; status: 'WINNING' | 'LOSING' | 'FLAT' } | null;
  popupSent?: boolean | null;
  emailSent?: boolean | null;
  resolvedAt: string | null;
}
export interface StrategyForexBucket {
  total?: number;
  wins: number; losses: number; expired: number; pending: number;
  winLossSettled: number; winRate: number | null;
  expectancyPips: number | null; expectancyR: number | null;
  // Average signal R:R offered by this bucket's forex plans (TP3 vs SL at signal time).
  avgRR?: number | null;
  confidence: 'weak' | 'early' | 'usable' | 'strong';
}
export interface StrategyCorrectedForexBucket {
  wins: number; losses: number; expired: number; ambiguous: number;
  winLossSettled: number; winRate: number | null;
  expectancyPips: number | null;
  confidence: 'weak' | 'early' | 'usable' | 'strong';
}
export interface StrategyFtBucket {
  total?: number;
  wins: number; losses: number; draws: number; pending: number;
  winLossSettled: number; winRate: number | null;
  confidence: 'weak' | 'early' | 'usable' | 'strong';
}
// As-traded (realistic) fixed-time bucket: live entry at signal time, expiry at +duration.
export interface StrategyAtBucket {
  total?: number;
  wins: number; losses: number; draws: number;
  winLossSettled: number; winRate: number | null;
  expectancyPips: number | null;
  confidence: 'weak' | 'early' | 'usable' | 'strong';
}
export interface StrategyTfRow {
  timeframe: string; total: number; forex: StrategyForexBucket; fixedTime: StrategyFtBucket; asTraded?: StrategyAtBucket; correctedForex?: StrategyCorrectedForexBucket | null;
}
export interface StrategySymbolRow {
  symbol: string; total: number; forex: StrategyForexBucket; fixedTime: StrategyFtBucket; asTraded?: StrategyAtBucket; correctedForex?: StrategyCorrectedForexBucket | null;
}
export interface StrategySessionRow {
  session: string; sessionLabel: string; bdRange: string;
  total: number; forex: StrategyForexBucket; fixedTime: StrategyFtBucket; asTraded?: StrategyAtBucket;
}
export interface StrategyComboRow {
  strategy: string; strategyName: string; symbol: string; timeframe: string;
  forexOnly?: boolean;
  total: number; forex: StrategyForexBucket; fixedTime: StrategyFtBucket; asTraded?: StrategyAtBucket;
}
export interface StrategySessionStrategyRow {
  id: string; name: string; forexOnly?: boolean; total: number; forex: StrategyForexBucket; fixedTime: StrategyFtBucket; asTraded?: StrategyAtBucket;
}
export interface StrategyScoreRow {
  band: string; label: string; range: string; order: number;
  total: number; forex: StrategyForexBucket; fixedTime: StrategyFtBucket; asTraded?: StrategyAtBucket;
}
export interface StrategySessionBreakdown {
  session: string; sessionLabel: string; bdRange: string;
  byStrategy: StrategySessionStrategyRow[];
  bySymbol: StrategySymbolRow[];
  byTimeframe: StrategyTfRow[];
}
export interface StrategyPerf {
  id: string; name: string; source: string | null; total: number;
  forexOnly?: boolean;
  forex: StrategyForexBucket; fixedTime: StrategyFtBucket; asTraded?: StrategyAtBucket; correctedForex?: StrategyCorrectedForexBucket | null;
  byTimeframe: StrategyTfRow[];
  bySymbol: StrategySymbolRow[];
  bySession: StrategySessionRow[];
  byScore?: StrategyScoreRow[];
}
// ── Confluence (combined-strategy agreement) analysis ──
export interface ConfluenceWin {
  wins: number; losses: number; draws: number; settled: number;
  winRate: number | null; confidence: 'weak' | 'early' | 'usable' | 'strong';
}
export interface ConfluenceLadderRow { agree: string; moments: number; fixedTime: ConfluenceWin; asTraded: ConfluenceWin }
export interface ConfluencePair {
  a: string; b: string; aName: string; bName: string; moments: number;
  fixedTime: ConfluenceWin; asTraded: ConfluenceWin;
  soloA: { winRate: number | null; settled: number } | null;
  soloB: { winRate: number | null; settled: number } | null;
}
export interface ConfluenceComboSymbol { symbol: string; moments: number; fixedTime: ConfluenceWin; asTraded: ConfluenceWin }
export interface ConfluenceCombo {
  strategies: string[]; names: string[]; moments: number;
  fixedTime: ConfluenceWin; asTraded: ConfluenceWin;
  solos: { id: string; name: string; moments: number; fixedTime: ConfluenceWin; asTraded: ConfluenceWin }[];
  bySymbol: ConfluenceComboSymbol[];
}
export interface ConfluenceResponse {
  ok: boolean; window: { label: string }; minSample: number;
  agreementLadder: ConfluenceLadderRow[]; topPairs: ConfluencePair[]; combo: ConfluenceCombo | null;
  generatedAt: string; error?: string;
}

export interface StrategyPerformanceResponse {
  ok: boolean; strategies: StrategyPerf[];
  timeframeRanking: StrategyTfRow[];
  symbolRanking: StrategySymbolRow[];
  sessionRanking: StrategySessionRow[];
  sessionBreakdown?: StrategySessionBreakdown[];
  scoreRanking?: StrategyScoreRow[];
  combos: StrategyComboRow[];
  window?: { from: string; to: string; label: string; preset: string | null; days: number };
  minSampleToRank: number; generatedAt: string; note: string;
}
export interface StrategyLiveRow {
  symbol: string;
  timeframe: string;
  strategyId?: string;   // set client-side when merging a multi-strategy live view
  strategyName?: string;
  command: 'ENTRY' | 'HOLD' | 'NO_DATA';
  direction?: string;
  score?: number | null;
  grade?: string | null;
  price?: number | null;
  entry?: number | null;
  stopLoss?: number | null;
  takeProfit1?: number | null;
  takeProfit2?: number | null;
  takeProfit3?: number | null;
  riskReward?: number | null;
  reason?: string | null;
  lots?: number | null;
  stopPips?: number | null;
  lossAtStop?: number | null;
  riskPercent?: number | null;
  timing?: StrategyTiming;
  // First-call enrichment from the DB (live evaluation = the CURRENT score; these are the
  // original call time + frozen first score, for the signal-time / score-evolution display).
  barIso?: string | null;
  signalTime?: string | null;
  firstScore?: number | null;
  firstGrade?: string | null;
  scoreUpdatedAt?: string | null;
}
export interface StrategyLiveResponse {
  ok: boolean; strategy: string; strategyName: string; timeframe: string; rows: StrategyLiveRow[]; generatedAt: string;
}
export interface StrategyFttLiveRow {
  symbol: string;
  timeframe: string;
  strategyId?: string;   // set client-side when merging a multi-strategy live view
  strategyName?: string;
  command: 'CALL' | 'HOLD' | 'NO_DATA';
  direction?: 'UP' | 'DOWN';
  score?: number | null;
  grade?: string | null;
  reference?: number | null;
  candleRead?: {
    verdict: 'ENTER_NOW' | 'WAIT_PULLBACK' | 'NO_ENTRY';
    momentum: 'UP' | 'DOWN' | 'MIXED';
    pattern: string;
    atExtreme: 'HIGH' | 'LOW' | null;
    note: string;
  } | null;
  expiryIso?: string | null;
  secondsToExpiry?: number | null;
  tradeMinutes?: number | null;
  tradeTimeLabel?: string | null;
  durationLabel?: string | null;
  reason?: string | null;
  // First-call enrichment (see StrategyLiveRow).
  barIso?: string | null;
  signalTime?: string | null;
  firstScore?: number | null;
  firstGrade?: string | null;
  scoreUpdatedAt?: string | null;
}
export interface StrategyFttLiveResponse {
  ok: boolean; strategy: string; strategyName: string; timeframe: string; expiryBars: number; rows: StrategyFttLiveRow[]; generatedAt: string;
}

export type SignalTrackerStatus = 'OPEN' | 'TP1_HIT' | 'TP2_HIT' | 'TP3_HIT' | 'STOPPED' | 'DANGER' | 'CLOSE_NOW' | 'EXPIRED';

export interface SignalTrackerItem {
  id: string;
  source: 'system' | 'email' | 'strategy-lab';
  // Set when source === 'strategy-lab' (filled lab trades handed off to the tracker).
  strategy?: string | null;
  strategyName?: string | null;
  symbol: string;
  timeframe: string;
  direction: string;
  signalTime: string;
  grade: string | null;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  takeProfit3: number | null;
  currentPrice: number | null;
  currentPips: number | null;
  currentR: number | null;
  mfeR: number | null;
  maeR: number | null;
  distToSlPips: number | null;
  tpHit: number;
  slHit: boolean;
  status: SignalTrackerStatus;
  riskState: 'HEALTHY' | 'CAUTION' | 'DANGER' | 'CLOSE_NOW' | 'UNKNOWN';
  severity: number;
  warningReason: string;
  suggestedAction: string;
  alertType: string | null;
  realPosition: { ticket: string; profit: number | null; volume: number | null; openPrice: number | null; currentPrice: number | null } | null;
  unrealizedProfit: number | null;
}

export interface SignalTrackerResponse {
  items: SignalTrackerItem[];
  generatedAt: string;
  config: { windowHours: number };
  note: string;
}

export interface FttHistoryResponse {
  predictions: FttPrediction[];
  status: Mt5Status;
}


// ─── Execution Forecasts (predict WHEN a setup becomes executable) ──────────

export type ForecastStatus = 'FORECASTED' | 'DELAYED' | 'CANCELLED' | 'READY' | 'EXECUTED' | 'EXPIRED';
export type ForecastBasis = 'IMMEDIATE' | 'NEXT_CANDLE' | 'NEWS' | 'PULLBACK' | 'SCORE_SLOPE' | 'SESSION' | 'UNKNOWN';

export type TradeOutcome = 'PENDING' | 'TP1_WIN' | 'TP2_WIN' | 'TP3_WIN' | 'WIN' | 'LOSS' | 'AMBIGUOUS' | 'EXPIRED';

export interface ExecutionForecast {
  id: string;
  symbol: string;
  timeframe: string;
  scanTime: string | null;
  currentStatus: string;           // Good Condition / Building / Weak
  executionStatus: 'EXECUTABLE' | 'NOT_EXECUTABLE';
  decision: string | null;
  lean?: 'BUY' | 'SELL' | 'NEUTRAL' | null;   // directional tilt while still Building (not a committed signal)
  leanConviction?: number | null;             // |buyScore - sellScore|
  setupScore: number | null;
  scoreChange: number | null;
  trendStrength: number | null;
  momentum: number | null;
  volatility: number | null;
  liquidity: number | null;
  session: string | null;
  regime: string | null;
  executionProbability: number | null;
  forecastConfidence: number | null;   // UNCALIBRATED model estimate until Phase 5
  forecastBasis: ForecastBasis;
  expectedExecutionTime: string | null;
  prevExecutionTime: string | null;
  status: ForecastStatus;
  reforecastCount: number | null;
  reason: string | null;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2?: number | null;
  takeProfit3?: number | null;
  actualExecutionTime?: string | null;
  forecastAccuracy?: number | null;
  timingAccuracy?: number | null;
  scoreAccuracy?: number | null;
  resolvedAt?: string | null;
  // Trade outcome (win/loss) for EXECUTED forecasts — settled by candle replay.
  tradeOutcome?: TradeOutcome | null;
  tradeExitPrice?: number | null;
  tradePips?: number | null;
  tradeTpHitLevel?: number | null;
  tradeMfePips?: number | null;
  tradeMaePips?: number | null;
  tradeResolvedAt?: string | null;
  newsImminent?: boolean;
  newsEvent?: string | null;       // e.g. "USD CPI"
  newsEventTime?: string | null;
  newsTier?: 'A' | 'B' | null;     // A = immediate spike, B = confirmed reaction
  calibrated: boolean;
}

export interface ForecastCalibrationBucket {
  basis: string;
  samples: number;
  executed: number;
  expired: number;
  cancelled: number;
  hitRate: number | null;
  avgTimingAccuracy: number | null;
  avgScoreAccuracy: number | null;
  combinedConfidence: number | null;   // hitRate × timingAccuracy — the honest reliability
  confidence: 'weak' | 'early' | 'usable' | 'strong';
}

export interface ForecastCalibrationResponse {
  calibration: { overall: ForecastCalibrationBucket; byBasis: ForecastCalibrationBucket[] };
  resolved: ExecutionForecast[];
  minSampleToCalibrate: number;
  note: string;
}

export interface ForecastReplayResponse {
  valid: boolean;
  reason?: string;
  symbol?: string;
  timeframe?: string;
  forecasts?: number;
  executed?: number;
  hitRate?: number | null;
  avgTimingAccuracy?: number | null;
  confidence?: 'weak' | 'early' | 'usable' | 'strong';
  note?: string;
}

export interface ForecastResponse {
  forecasts: ExecutionForecast[];
  calibrated: boolean;
  note: string;
}

export interface ForecastOutcomeBucket {
  basis: string;
  total: number;
  settled: number;
  wins: number;
  losses: number;
  ambiguous: number;
  expired: number;
  pending: number;
  netPips: number;
  netR: number;
  expectancyR: number | null;
  rCount: number;
  winRate: number;
}

// ── Day-trading discipline layer (pre-session brief + R-budget) ──────────────
export interface DayTradingDailyRisk {
  available: boolean;
  dateUtc?: string;
  settledR?: number;
  wins?: number;
  losses?: number;
  openCount?: number;
  rCount?: number;
  dailyStopR: number;
  remainingR?: number;
  limitHit?: boolean;
  note: string;
}

export interface DayTradingBriefSymbol {
  symbol: string;
  timeframe: string;
  decision: string;
  grade: string | null;
  score: number | null;
  regime: string | null;
  htfBias: string | null;
  emaDistanceAtr: number | null;
  extended: boolean;
  adrUsagePercent: number | null;
  riskRewardRatio: number | null;
  entryTiming: string | null;
  nearestSupport: number | null;
  nearestResistance: number | null;
  price: number | null;
  newsRisk: 'block' | 'caution' | null;
  forecast: { eta: string; basis: string; status: string | null } | null;
}

export interface DayTradingBriefNews {
  currency: string;
  title: string;
  impact: string;
  timeIso: string;
  timestampUtc: number;
}

export interface LiquidityPool {
  price: number;
  type: 'BSL' | 'SSL';
  touches: number;
  equal: boolean;
  swept: boolean;
  sweptAtMs: number | null;
  timeIso: string;
  distance: number;
}

export interface Displacement {
  present: boolean;
  strong?: boolean;
  atrMultiple: number;
  gapLow?: number;
  gapHigh?: number;
}

export interface BreakerBlock {
  type: 'BULLISH' | 'BEARISH';
  zoneTop: number;
  zoneBottom: number;
  entry: number;
  stop: number;
  sweepLevel: number;
  structureLevel: number;
  confirmedIso: string;
  ageBars: number;
  displacement: Displacement;
}

export interface LiquidityPlan {
  direction: 'BUY' | 'SELL';
  entry: number;
  stop: number;
  target: number;
  targetType: 'BSL' | 'SSL';
  targetEqual: boolean;
  rr: number;
  displacement: Displacement;
}

export interface PremiumDiscount {
  pct: number;
  zone: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM';
  rangeHigh: number;
  rangeLow: number;
  equilibrium: number;
}

export interface StructureDesk {
  symbol: string;
  timeframe: string;
  price: number;
  phase: 'UPTREND' | 'DOWNTREND' | 'CONSOLIDATION' | 'SIDEWAYS';
  htfBias: string | null;
  regime: string | null;
  decision: string;
  grade: string | null;
  score: number | null;
  bos: { dir: 'bullish' | 'bearish'; level: number } | null;
  sweep: 'bullish' | 'bearish' | null;
  zone: { kind: 'DEMAND' | 'SUPPLY'; low: number; high: number; imbalance: boolean } | null;
  setup: string | null;
  armed: boolean;
  premiumDiscount: PremiumDiscount | null;
  emaDistanceAtr: number | null;
  extended: boolean;
  entryTiming: string | null;
  plan: { entry: number; sl: number; tp: number | null; rr: number | null } | null;
  liquidity: {
    targetAbove: LiquidityPool | null;
    targetBelow: LiquidityPool | null;
    recentSweep: LiquidityPool | null;
    buySide: LiquidityPool[];
    sellSide: LiquidityPool[];
  };
  breaker: BreakerBlock | null;
  liquidityPlan: LiquidityPlan | null;
  drive: {
    label: 'FIRST_DRIVE' | 'SECOND_DRIVE' | 'NONE';
    basis: 'FAILED_FIRST' | 'RETEST' | null;
    note: string;
    edge?: number | null;
    drives?: number;
    isSecondDrive?: boolean;
  } | null;
  rejectionReasons: string[];
}

export interface StructureDeskResponse {
  generatedAt: string;
  timeframe: string;
  extensionAtrThreshold: number;
  primarySymbol: string;
  desks: StructureDesk[];
  note: string;
}

export interface DayTradingBriefResponse {
  generatedAt: string;
  timeframe: string;
  extensionAtrThreshold: number;
  symbols: DayTradingBriefSymbol[];
  news: DayTradingBriefNews[];
  dailyRisk: DayTradingDailyRisk;
  note: string;
}

// ── Live Market Tracker (pre-entry cockpit) ──────────────────────────────────
export interface LmtMarketStatus { open: boolean; state: 'OPEN' | 'CLOSED'; reason: string }
export interface LmtPressure {
  isProxy: boolean;
  basis: string;
  buyerPressure: number;
  sellerPressure: number;
  dominant: 'BUYERS' | 'SELLERS' | 'BALANCED';
  aggressiveBuying: number;
  aggressiveSelling: number;
  volumeRatio: number;
  volumeState: 'HIGH' | 'NORMAL' | 'LOW';
  lastCandle: { bullish: boolean; bodyPct: number; closePosPct: number };
}
export interface LmtOrderBlock {
  type: 'BULLISH' | 'BEARISH';
  kind: 'DEMAND' | 'SUPPLY';
  low: number;
  high: number;
  mid: number;
  inside: boolean;
  distancePips: number;
  distanceAtr: number | null;
  imbalance: boolean;
  displacement: boolean;
  mitigated: boolean;
  zoneActivity: { tickVolume: number; reactions: number; note: string };
  score: number;
  grade: 'A' | 'B' | 'C';
  time: string;
}
export interface LmtPricePosition {
  pct: number | null;
  zone: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM';
  label: string;
  rangeHigh: number;
  rangeLow: number;
  equilibrium: number;
}
export interface LmtVerdict {
  verdict: 'WAIT' | 'WATCH' | 'ARMED_IF_CONFIRMED' | 'NO_TRADE' | 'STALE_DATA' | 'MARKET_CLOSED';
  canEnter: boolean;
  direction: 'BUY' | 'SELL' | null;
  checklist: Record<string, boolean> | null;
  reasons: string[];
}
export interface LmtWatchRow {
  symbol: string;
  price: number;
  feedState: string;
  bias: string | null;
  verdict: string;
  buyerPressure: number;
  sellerPressure: number;
  nearestDistanceAtr: number;
}
export interface LmtKeyLevel {
  type: string; label: string; price: number; side: 'above' | 'below';
  distance: number; distancePips: number; distanceAtr: number | null;
  swept: boolean; fresh: boolean; strength: number;
}
export interface LmtSweepGrade {
  decision: 'BUY' | 'SELL';
  score: number;
  grade: string;
  entry: number; stopLoss: number; takeProfit1: number; takeProfit2: number; takeProfit3: number;
  riskRewardRatio: number;
  reason: string; barIso: string;
  meta: { sweptLevel: { type: string; price: number; strength: number }; components: Record<string, unknown>; checklist: string[] };
}
export interface LiveMarketTrackerResponse {
  ok: boolean;
  symbol: string;
  timeframe: string;
  price: number;
  atr: number | null;
  feedState: 'LIVE' | 'STALE' | 'MARKET_CLOSED';
  dataFresh: boolean;
  sourceReceivedAt: string | null;
  staleSeconds: number | null;
  marketStatus: LmtMarketStatus;
  session: { label?: string; bdTime?: string | null; key?: string } | null;
  pricePosition: LmtPricePosition | null;
  bias: 'BULLISH' | 'BEARISH' | null;
  phase: string;
  regime: string | null;
  decision: string;
  grade: string | null;
  score: number | null;
  extended: boolean;
  emaDistanceAtr: number | null;
  pressure: LmtPressure;
  orderBlocks: LmtOrderBlock[];
  nearestDemand: LmtOrderBlock | null;
  nearestSupply: LmtOrderBlock | null;
  liquidity: { targetAbove: LiquidityPool | null; targetBelow: LiquidityPool | null; recentSweep: unknown; buySide: LiquidityPool[]; sellSide: LiquidityPool[] } | null;
  keyLevels?: LmtKeyLevel[];
  nearestKeyAbove?: LmtKeyLevel | null;
  nearestKeyBelow?: LmtKeyLevel | null;
  sweepGrade?: LmtSweepGrade | null;
  recentSweep: string | null;
  breaker: unknown;
  plan: { entry: number; sl: number; tp: number | null; rr: number | null } | null;
  verdict: LmtVerdict;
  watchlist: LmtWatchRow[];
  generatedAt: string;
  honesty: string[];
  error?: string;
}

export interface ForecastOutcomeResponse {
  trades: ExecutionForecast[];
  summary: { overall: ForecastOutcomeBucket; byBasis: ForecastOutcomeBucket[] };
  retentionDays: number;
  note: string;
  filters: { symbol: string | null; outcome: string | null; days: number; limit: number };
}

export interface ForecastPlan {
  decision: string | null;
  grade: string | null;
  strategyType: string | null;
  signalQuality: string | null;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  takeProfit3: number | null;
  riskRewardRatio: number | null;
  entryTrigger: string | null;
  timingTip: string | null;
  regime: string | null;
  session: string | null;
  lotSize: number | null;
  maxLoss: number | null;
  investment: number | null;
  riskPercent: number | null;
  profitAtTp1: number | null;
  profitAtTp2: number | null;
  profitAtTp3: number | null;
  confluences: Array<{ name: string; points: number }>;
}

export interface ForecastAnalysis {
  ok: boolean;
  id: string;
  symbol: string;
  timeframe: string;
  recommendation: 'TRADE' | 'WAIT' | 'SKIP';
  confidence: number;
  reasoning: string[];
  source: 'deterministic' | 'ai';
  expectedExecutionTime: string | null;
  forecastBasis: ForecastBasis | null;
  setupScore: number | null;
  executionStatus: 'EXECUTABLE' | 'NOT_EXECUTABLE';
  plan: ForecastPlan;
  note: string;
  generatedAt: string;
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
  forexActive?: boolean; // forex report only: false when the Forex Scanner toggle is OFF (report intentionally empty)
  status?: Mt5Status;
}

// ─── AI Chart Image analysis (upload a screenshot → trade plan) ───
export interface ChartForexPlan {
  decision: string;
  entry: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  takeProfit3: number | null;
  riskReward: number | null;
  lots: number | null;
  stopPips?: number | null;
  lossAtStop?: number | null;
  riskLevel?: string;
  invalidation?: string | null;
  grade?: string | null;
}
export interface ChartTimeTrigger {
  atIso: string | null;
  atLabel: string | null;
  condition: 'ABOVE' | 'BELOW' | null;
  level: number | null;
  direction?: string;
  elseAction: string;
  basis?: string;
}
export interface ChartFttPlan {
  direction: string;
  confidence?: number | null;
  expiry?: string | null;
  suggestedTimeframe?: string | null;
  expectedCandlesInDirection?: number | null;
  persistenceRange?: { low: number | null; high: number | null; basis: string } | null;
  timeTrigger?: ChartTimeTrigger | null;
  reasoning?: string | null;
}
export interface ChartAnalysisResponse {
  ok: boolean;
  source: 'gemini-vision' | 'system-fallback';
  symbol: string;
  timeframe: string;
  tradeMode: string;
  verdict?: string | null;
  confidence?: number | null;
  detection: {
    trend?: string | null;
    regime?: string | null;
    structure?: unknown[];
    srZones?: unknown;
    patterns?: string[];
    breakout?: { phase?: string; direction?: string; grade?: string; level?: number; displacement?: boolean } | null;
    grade?: string | null;
  };
  forexPlan: ChartForexPlan | null;
  fttPlan: ChartFttPlan | null;
  breakout?: { phase?: string; direction?: string; grade?: string } | null;
  strategies?: Array<{ id: string; name: string; decision: string; score: number | null; grade: string | null }>;
  reasoning?: string;
  keyFactors?: string[];
  honesty?: string[];
  note?: string;
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

export interface WouldSuppressItem {
  type: string;
  symbol: string;
  timeframe: string | null;
  expiry: string | null;
  reason: string | null;
  bucket: string | null;
  winRate: number | null;
  settled: number | null;
  expectancy: number | null;
  at: string;
}
export interface WouldSuppressResponse {
  ok: boolean;
  mode: { forex: string; ftt: string };
  summary: { type: string; symbol: string; count: number }[];
  recent: WouldSuppressItem[];
  note: string;
}

export interface CalibrationResponse {
  ok: boolean;
  type: 'forex' | 'fixed';
  total: number;                 // all records in the window
  records?: number;
  winLossSettled?: number;       // honest scored evidence (wins + losses)
  settled?: number;              // win/loss/draw/breakeven (excludes EXPIRED/AMBIGUOUS)
  expired?: number;
  ambiguous?: number;
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
