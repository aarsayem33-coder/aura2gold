import React, { useEffect, useMemo, useState } from 'react';
import { Bot, RefreshCcw, Layers, Zap, Loader2, ArrowRight, Activity, TrendingUp, TrendingDown, HelpCircle, Timer, AlertTriangle, CalendarClock, Copy } from 'lucide-react';
import SignalGrid from '../components/SignalGrid';
import { useMt5Stream, triggerAllSymbolsScan, triggerFttScan, triggerFttPrediction, fetchMt5CandleCoverage } from '../mt5Api';
import type { ScanResult, FttScanResult, Mt5CandleCoverageRow, TopbarMarketAlert } from '../types';
import { orderSymbols, curatedAvailable } from '../utils/symbols';

function price(value?: number | null) {
  if (value === null || value === undefined) return 'n/a';
  return value.toFixed(value > 100 ? 2 : 5);
}

function decisionClass(decision?: string) {
  if (!decision || decision === 'HOLD') return 'bg-slate-100 text-slate-700 border-slate-200';
  if (decision.includes('BUY') || decision === 'UP') return 'bg-emerald-50 text-emerald-800 border-emerald-200';
  return 'bg-red-50 text-red-800 border-red-200';
}

function money(value?: number | null) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'n/a';
  return `$${Number(value).toFixed(2)}`;
}

function signedLoss(value?: number | null) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'n/a';
  return `-${money(Math.abs(Number(value)))}`;
}

function mapExpiryToTimeframe(expiry: string) {
  const exp = String(expiry || '5m').trim().toLowerCase();
  if (['1m', '2m', '3m', '4m'].includes(exp)) return 'M1';
  if (exp === '5m') return 'M2';
  if (exp === '10m') return 'M3';
  if (['15m', '20m', '30m', '40m'].includes(exp)) return 'M5';
  if (exp === '1h') return 'M15';
  return 'M5';
}

function getFttEntryTimerTimeframes(expiry: string) {
  const exp = String(expiry || '').trim().toLowerCase();
  if (['1m', '2m', '3m', '4m'].includes(exp)) return ['M1'];
  if (exp === '5m') return ['M2'];
  if (exp === '10m') return ['M3'];
  if (['15m', '20m'].includes(exp)) return ['M5'];
  if (['30m', '40m'].includes(exp)) return ['M15'];
  if (exp === '1h') return ['M15', 'M30'];
  return ['M5'];
}

function timeframePeriodMs(timeframe: string) {
  const tf = String(timeframe || 'M5').toUpperCase();
  if (tf === 'M1') return 60 * 1000;
  if (tf === 'M2') return 2 * 60 * 1000;
  if (tf === 'M3') return 3 * 60 * 1000;
  if (tf === 'M5') return 5 * 60 * 1000;
  if (tf === 'M15') return 15 * 60 * 1000;
  if (tf === 'M30') return 30 * 60 * 1000;
  if (tf === 'H1') return 60 * 60 * 1000;
  return 5 * 60 * 1000;
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

function getFttLiveTiming(observedTimeframe: string, direction: string, isNoiseFiltered = false) {
  const tf = String(observedTimeframe || 'M5').toUpperCase();
  const periodMs = timeframePeriodMs(tf);

  const nowMs = Date.now();
  const nextOpenMs = Math.ceil(nowMs / periodMs) * periodMs;
  const remainingMs = nextOpenMs - nowMs;
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  const elapsedSeconds = (periodMs / 1000) - remainingSeconds;
  const timerText = `${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, '0')}`;

  if (direction === 'HOLD' || !direction) {
    return {
      timing: 'HOLD_NO_TRADE',
      observedTimeframe: tf,
      badgeText: `Neutral ${tf} (${timerText})`,
      badgeClass: 'bg-slate-50 text-slate-400 border-slate-200',
      tip: 'Neutral market conditions. No trade recommended.'
    };
  }

  const immediateSecs = Math.min(30, (periodMs / 1000) * 0.1);
  const waitSecs = Math.min(30, (periodMs / 1000) * 0.1);

  if (isNoiseFiltered || remainingSeconds <= waitSecs) {
    return {
      timing: 'WAIT_FOR_NEXT_CANDLE',
      observedTimeframe: tf,
      badgeText: `⏳ Wait ${tf} (${timerText})`,
      badgeClass: 'bg-amber-100 text-amber-800 border-amber-300 animate-pulse',
      tip: isNoiseFiltered
        ? `Noise Filter Active: Awaiting entry candle close (${remainingSeconds}s remaining on ${tf}) to trigger execution.`
        : `Candle is closing in ${remainingSeconds}s. Wait for the new candle open to enter.`
    };
  } else if (elapsedSeconds <= immediateSecs) {
    return {
      timing: 'IMMEDIATE_ENTRY',
      observedTimeframe: tf,
      badgeText: `⚡ Execute ${tf} (${timerText})`,
      badgeClass: 'bg-emerald-500 text-white border-emerald-600 animate-pulse font-extrabold',
      tip: `Candle just opened (${remainingSeconds}s left). Execute ${direction} entry now for maximum momentum.`
    };
  } else if (elapsedSeconds > (periodMs / 1000) * 0.5) {
    return {
      timing: 'LATE_ENTRY_WARNING',
      observedTimeframe: tf,
      badgeText: `⚠️ Late ${tf} (${timerText})`,
      badgeClass: 'bg-rose-50 text-rose-800 border-rose-200',
      tip: `Candle is over 50% complete (${remainingSeconds}s left). Short-term reversals are likely. Avoid entry.`
    };
  } else {
    return {
      timing: 'PULLBACK_OR_MOMENTUM',
      observedTimeframe: tf,
      badgeText: `🔄 Pullback ${tf} (${timerText})`,
      badgeClass: 'bg-blue-50 text-blue-700 border-blue-200',
      tip: `Mid-candle phase (${remainingSeconds}s left). Enter on a minor pullback or if momentum continues.`
    };
  }
}

function renderGradeBadge(grade?: string | null) {
  const g = grade || 'No Setup';
  const displayLabel = g.includes('No Trade') ? 'No Setup' : g;
  
  let badgeClass = 'bg-slate-100 text-slate-600 border-slate-200';
  if (g.includes('A+')) {
    badgeClass = 'bg-emerald-600 text-white border-emerald-700 animate-pulse';
  } else if (g.includes('A')) {
    badgeClass = 'bg-emerald-50 text-emerald-800 border-emerald-200';
  } else if (g.includes('B')) {
    badgeClass = 'bg-blue-50 text-blue-800 border-blue-200';
  }
  
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wider border shadow-sm ${badgeClass}`}>
      {displayLabel}
    </span>
  );
}

function renderSignalQualityBadge(quality?: string | null) {
  const q = quality || 'WATCH';
  let badgeClass = 'bg-slate-100 text-slate-500 border-slate-200';
  if (q === 'A+ SIGNAL') badgeClass = 'bg-emerald-600 text-white border-emerald-700 animate-pulse';
  else if (q === 'A SIGNAL') badgeClass = 'bg-emerald-50 text-emerald-800 border-emerald-200';
  else if (q === 'B SIGNAL') badgeClass = 'bg-blue-50 text-blue-800 border-blue-200';

  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wider border shadow-sm ${badgeClass}`}>
      {q}
    </span>
  );
}

function getForexSuggestedEntry(system?: ScanResult['systemDecision']) {
  const raw = [system?.entryTimingInstruction, system?.entryTrigger].filter(Boolean).join(' / ');
  const direction = String(system?.decision || 'HOLD').toUpperCase();
  const directionLabel = direction === 'STRONG_BUY' ? 'BUY'
    : direction === 'STRONG_SELL' ? 'SELL'
      : direction.includes('BUY') ? 'BUY'
        : direction.includes('SELL') ? 'SELL'
          : 'NO TRADE';
  const directionClass = directionLabel === 'BUY'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
    : directionLabel === 'SELL'
      ? 'border-red-200 bg-red-50 text-red-800'
      : 'border-slate-200 bg-slate-50 text-slate-400';
  const validTradePlan = Boolean(system?.entryPrice && system?.stopLoss && system?.takeProfit1);
  const rawSummary = `Direction: ${direction}. Timing: ${system?.entryTimingInstruction || 'n/a'}. Trigger: ${system?.entryTrigger || 'n/a'}.`;

  if (!system || direction === 'HOLD' || system.newsRisk?.block || !validTradePlan) {
    // A HOLD is usually a precision-gate veto, not "nothing here". Surface the
    // actual blocking reason + directional lean + net conviction right on the
    // collapsed card, so a good-score / no-direction setup explains itself
    // without the user having to expand the row.
    const reasons = system?.rejectionReasons || [];
    const bs = Number(system?.buyScore || 0), ss = Number(system?.sellScore || 0);
    const lean = bs > ss ? 'BUY' : ss > bs ? 'SELL' : null;
    const headTip = (system?.newsRisk?.block && system?.newsRisk?.reason)
      ? system.newsRisk.reason
      : reasons.length
        ? `Blocked: ${reasons.slice(0, 2).join('; ')}${lean ? ` · leaning ${lean} (net ${system?.netConviction ?? Math.abs(bs - ss)})` : ''}`
        : (system?.timingTip || (!validTradePlan ? 'No complete entry/SL/TP plan from backend.' : 'No active Forex setup.'));
    return {
      label: reasons.length ? 'No Trade — gated' : 'No Trade',
      directionLabel,
      directionClass,
      className: 'border-slate-200 bg-slate-50 text-slate-400',
      tip: [headTip, raw ? `Raw timing: ${raw}` : null, rawSummary].filter(Boolean).join(' '),
    };
  }

  const timing = String(system.entryTimingInstruction || system.entryTrigger || 'IMMEDIATE').toUpperCase();
  const tip = (fallback: string) => [system.timingTip || fallback, raw ? `Raw timing: ${raw}` : null, rawSummary].filter(Boolean).join(' ');
  const qualityText = `${system.grade || ''} ${system.signalQuality || ''}`.toUpperCase();
  const highQualityEnter = Number(system.confidence || 0) >= 80 && (qualityText.includes('A+ SETUP') || qualityText.includes('A SETUP') || qualityText.includes('A+ SIGNAL') || qualityText.includes('A SIGNAL'));

  if (timing === 'WAIT_FOR_NEXT_CANDLE' || timing === 'NEXT_CANDLE') {
    return {
      label: 'Wait Next Candle',
      directionLabel,
      directionClass,
      className: 'border-amber-200 bg-amber-50 text-amber-700',
      tip: tip('Wait for the next candle open before entering.'),
    };
  }
  if (timing === 'WAIT_FOR_PULLBACK' || timing === 'LIMIT_PULLBACK' || timing.includes('PULLBACK')) {
    return {
      label: 'Wait Pullback',
      directionLabel,
      directionClass,
      className: 'border-blue-200 bg-blue-50 text-blue-700',
      tip: tip('Wait for price to pull back toward the entry area instead of chasing.'),
    };
  }
  if (timing === 'BREAKOUT_CONFIRMATION' || timing === 'WAIT_FOR_BREAKOUT' || timing.includes('BREAKOUT')) {
    return {
      label: 'Wait Breakout',
      directionLabel,
      directionClass,
      className: 'border-purple-200 bg-purple-50 text-purple-700',
      tip: tip('Wait for breakout confirmation before entering.'),
    };
  }
  if (timing === 'WAIT_CONFIRMATION' || timing === 'WAIT_FOR_CONFIRMATION' || timing.includes('CONFIRM')) {
    return {
      label: 'Watch Formation',
      directionLabel,
      directionClass,
      className: 'border-indigo-200 bg-indigo-50 text-indigo-700',
      tip: tip('Direction is forming, but confirmation is not complete.'),
    };
  }
  if (timing === 'HOLD_NO_TRADE' || timing.includes('NO_TRADE')) {
    return {
      label: 'No Trade',
      directionLabel: 'NO TRADE',
      directionClass: 'border-slate-200 bg-slate-50 text-slate-400',
      className: 'border-slate-200 bg-slate-50 text-slate-400',
      tip: tip('No active Forex setup.'),
    };
  }

  if (system.rejectionReasons?.length && Number(system.confidence || 0) < 80) {
    return {
      label: 'Watch Formation',
      directionLabel,
      directionClass,
      className: 'border-indigo-200 bg-indigo-50 text-indigo-700',
      tip: `${system.rejectionReasons.slice(0, 2).join('; ')}${raw ? ` Raw timing: ${raw}` : ''} ${rawSummary}`,
    };
  }

  return {
    label: 'Enter Now',
    directionLabel,
    directionClass,
    className: highQualityEnter ? 'border-emerald-300 bg-emerald-500 text-white animate-pulse shadow-sm shadow-emerald-200' : 'border-emerald-200 bg-emerald-50 text-emerald-700',
    tip: tip('Entry window is open.'),
  };
}

function mergeScanResults(current: ScanResult[], incoming: ScanResult[]) {
  const byKey = new Map(current.map((item) => [`${item.symbol}|${item.timeframe}`, item]));
  for (const item of incoming) byKey.set(`${item.symbol}|${item.timeframe}`, item);
  return [...byKey.values()].sort((a, b) => Number(b.systemDecision?.confidence || 0) - Number(a.systemDecision?.confidence || 0));
}

function mergeFttResults(current: FttScanResult[], incoming: FttScanResult[]) {
  const byKey = new Map(current.map((item) => [`${item.symbol}|${item.expiry}`, item]));
  for (const item of incoming) byKey.set(`${item.symbol}|${item.expiry}`, item);
  return [...byKey.values()].sort((a, b) => Number(b.systemPrediction?.confidence || 0) - Number(a.systemPrediction?.confidence || 0));
}

function secondsAgo(value: Date | null) {
  if (!value) return 'waiting';
  const seconds = Math.max(0, Math.floor((Date.now() - value.getTime()) / 1000));
  return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ${seconds % 60}s ago`;
}

function isAPlusOrA(value?: string | null) {
  const text = String(value || '').toUpperCase();
  return text.includes('A+ SETUP') || text.includes('A SETUP') || text.includes('A+ SIGNAL') || text.includes('A SIGNAL');
}

function forexTopbarAlert(result: ScanResult): TopbarMarketAlert | null {
  const system = result.systemDecision;
  if (!system || system.decision === 'HOLD') return null;
  if (Number(system.confidence || 0) < 80) return null;
  if (!isAPlusOrA(system.grade) && !isAPlusOrA(system.signalQuality)) return null;
  const risk = system.riskPlan || {};
  const runtime = result as ScanResult & { bar?: string; sourceReceivedAt?: string };
  const signalStamp = runtime.bar || runtime.sourceReceivedAt || `${system.entryPrice ?? 'market'}`;
  return {
    id: `scan-forex:${result.symbol}:${result.timeframe}:${system.decision}:${signalStamp}`,
    kind: 'FOREX',
    symbol: result.symbol,
    timeframe: result.timeframe,
    direction: system.decision,
    grade: system.grade || null,
    quality: system.signalQuality || null,
    confidence: Math.round(Number(system.confidence || 0)),
    entryPrice: system.entryPrice,
    stopLoss: system.stopLoss,
    takeProfit1: system.takeProfit1,
    takeProfit2: system.takeProfit2,
    takeProfit3: system.takeProfit3,
    investment: risk.marginRequired ?? risk.amountToInvestApprox ?? null,
    maxLoss: risk.lossAtStop ?? risk.maxLoss ?? risk.amountToRisk ?? risk.riskAmount ?? null,
    lotSize: risk.suggestedLotSize ?? null,
    tradeTime: runtime.bar || new Date().toISOString(),
    sessionReason: system.sessionContext?.reason || null,
    createdAt: new Date().toISOString(),
  };
}

function fttTopbarAlert(result: FttScanResult): TopbarMarketAlert | null {
  const system = result.systemPrediction;
  if (!system || system.direction === 'HOLD') return null;
  const indicators = (system.indicators || {}) as Record<string, any>;
  const tradeStatus = String(system.tradeStatus || '').toUpperCase();
  const qualityTier = String(indicators.qualityTier || indicators.grade || '').toUpperCase();
  const confidence = Number(system.confidence || 0);
  const qualifies = tradeStatus === 'QUALITY_SIGNAL' || isAPlusOrA(qualityTier) || confidence >= 80;
  if (!qualifies || confidence < 80 || tradeStatus === 'NO_TRADE') return null;
  return {
    id: `scan-ftt:${result.symbol}:${result.expiry}:${system.direction}:${system.entryPrice ?? 'market'}:${Math.round(confidence)}`,
    kind: 'FIXED_TIME',
    symbol: result.symbol,
    expiry: result.expiry,
    direction: system.direction,
    grade: String(indicators.grade || indicators.qualityTier || system.tradeStatus || ''),
    quality: String(indicators.qualityTier || system.tradeStatus || ''),
    confidence: Math.round(confidence),
    entryPrice: system.entryPrice,
    tradeTime: new Date().toISOString(),
    expiryTime: null,
    sessionReason: indicators.sessionContext?.reason || null,
    createdAt: new Date().toISOString(),
  };
}

function fttConfidenceGrade(confidence?: number | null) {
  const c = Number(confidence);
  if (!Number.isFinite(c)) return 'WATCH ONLY';
  if (c >= 90) return 'A+ Setup';
  if (c >= 80) return 'A Setup';
  if (c >= 75) return 'B Setup';
  return 'WATCH ONLY';
}

function renderFttStatusBadge(system?: FttScanResult['systemPrediction']) {
  const confidence = system?.confidence ?? 0;
  const status = system?.tradeStatus || (confidence >= 75 && system?.direction !== 'HOLD' ? 'TRADE_SIGNAL' : 'WATCH_ONLY');
  const label = status === 'QUALITY_SIGNAL' ? 'QUALITY SIGNAL' : status === 'TRADE_SIGNAL' ? fttConfidenceGrade(confidence) : status === 'NO_TRADE' ? 'NO TRADE' : 'WATCH ONLY';
  const badgeClass = status === 'QUALITY_SIGNAL'
    ? 'bg-emerald-600 text-white border-emerald-700 animate-pulse'
    : status === 'TRADE_SIGNAL'
      ? confidence >= 80
        ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
        : 'bg-blue-50 text-blue-800 border-blue-200'
      : status === 'NO_TRADE'
        ? 'bg-slate-100 text-slate-500 border-slate-200'
        : 'bg-amber-50 text-amber-800 border-amber-200';

  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[10px] font-black uppercase tracking-wider border shadow-sm ${badgeClass}`}>
      {label}
    </span>
  );
}

function getFttSuggestedEntry(result: FttScanResult, displayDirection?: string, isNoiseFiltered = false) {
  const system = result.systemPrediction;
  const indicators = (system?.indicators || {}) as Record<string, any>;
  const direction = String(displayDirection || system?.direction || 'HOLD').toUpperCase();
  const directionLabel = direction === 'UP' || direction.includes('BUY') ? 'UP'
    : direction === 'DOWN' || direction.includes('SELL') ? 'DOWN'
      : 'NO TRADE';
  const directionClass = directionLabel === 'UP'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
    : directionLabel === 'DOWN'
      ? 'border-red-200 bg-red-50 text-red-800'
      : 'border-slate-200 bg-slate-50 text-slate-400';
  const tradeStatus = String(system?.tradeStatus || '').toUpperCase();
  const confidence = Number(system?.confidence || 0);
  const qualityTier = String(indicators.qualityTier || indicators.grade || '').toUpperCase();
  const riskWarnings = Array.isArray(indicators.riskWarnings) ? indicators.riskWarnings.map(String) : [];
  const qualityReasons = Array.isArray(indicators.qualityReasons) ? indicators.qualityReasons.map(String) : [];
  const observedTimeframes = getFttEntryTimerTimeframes(result.expiry);
  const timings = observedTimeframes.map((tf) => getFttLiveTiming(tf, directionLabel, isNoiseFiltered));
  const timingRank = (timing: ReturnType<typeof getFttLiveTiming>) => {
    if (timing.timing === 'IMMEDIATE_ENTRY') return 4;
    if (timing.timing === 'WAIT_FOR_NEXT_CANDLE') return 3;
    if (timing.timing === 'PULLBACK_OR_MOMENTUM') return 2;
    if (timing.timing === 'LATE_ENTRY_WARNING') return 1;
    return 0;
  };
  const timing = [...timings].sort((a, b) => timingRank(b) - timingRank(a))[0] || getFttLiveTiming('M5', directionLabel, isNoiseFiltered);
  const timer = timing.badgeText.match(/\([^)]*\)/)?.[0] || '';
  const observedTf = timing.observedTimeframe || observedTimeframes[0] || 'M5';
  const secondaryTiming = timings.find((item) => item.observedTimeframe !== observedTf) || null;
  const secondaryLabel = secondaryTiming ? `${secondaryTiming.observedTimeframe} ${secondaryTiming.badgeText.match(/\([^)]*\)/)?.[0] || ''}`.trim() : null;
  const warningText = riskWarnings.join('; ').toUpperCase();
  const hardNoTrade = !system
    || directionLabel === 'NO TRADE'
    || tradeStatus === 'NO_TRADE'
    || confidence < 60
    || warningText.includes('NO_TRADE')
    || warningText.includes('HIGH_SPIKE')
    || warningText.includes('LOW_CHOP');
  const watchOnly = tradeStatus === 'WATCH_ONLY' || confidence < 75;
  const validTrade = ['QUALITY_SIGNAL', 'TRADE_SIGNAL'].includes(tradeStatus) || qualityTier.includes('A') || confidence >= 80;
  const baseTip = [
    `Direction: ${directionLabel}`,
    `Trade status: ${tradeStatus || 'n/a'}`,
    `Confidence: ${Math.round(confidence)}/100`,
    `Quality: ${qualityTier || 'n/a'}`,
    indicators.qualityScore !== undefined ? `Quality score: ${indicators.qualityScore}/100` : null,
    indicators.volatilityState ? `Volatility: ${indicators.volatilityState}` : null,
    indicators.ichimokuState ? `Ichimoku: ${indicators.ichimokuState}` : null,
    qualityReasons.length ? `Reason: ${qualityReasons.slice(0, 2).join('; ')}` : null,
    riskWarnings.length ? `Warning: ${riskWarnings.slice(0, 2).join('; ')}` : null,
    secondaryLabel ? `Secondary timer: ${secondaryLabel}` : null,
    timing.tip,
  ].filter(Boolean).join(' · ');

  if (hardNoTrade) {
    return {
      directionLabel: 'NO TRADE',
      directionClass: 'border-slate-200 bg-slate-50 text-slate-400',
      label: `No Trade ${observedTf} ${timer}`.trim(),
      secondaryLabel,
      className: 'border-slate-200 bg-slate-50 text-slate-400',
      tip: baseTip,
    };
  }

  if (watchOnly || !validTrade) {
    return {
      directionLabel,
      directionClass,
      label: `Watch Formation ${observedTf} ${timer}`.trim(),
      secondaryLabel,
      className: 'border-indigo-200 bg-indigo-50 text-indigo-700',
      tip: baseTip,
    };
  }

  if (timing.timing === 'WAIT_FOR_NEXT_CANDLE') {
    return { directionLabel, directionClass, label: `Wait Next Candle ${observedTf} ${timer}`.trim(), secondaryLabel, className: timing.badgeClass, tip: baseTip };
  }
  if (timing.timing === 'IMMEDIATE_ENTRY') {
    return { directionLabel, directionClass, label: `Execute ${observedTf} ${timer}`.trim(), secondaryLabel, className: timing.badgeClass, tip: baseTip };
  }
  if (timing.timing === 'LATE_ENTRY_WARNING') {
    return { directionLabel, directionClass, label: `Late ${observedTf} ${timer}`.trim(), secondaryLabel, className: timing.badgeClass, tip: baseTip };
  }
  return { directionLabel, directionClass, label: `Wait Pullback ${observedTf} ${timer}`.trim(), secondaryLabel, className: timing.badgeClass, tip: baseTip };
}

function ForexAdvisorDetails({ result }: { result: ScanResult }) {
  const system = result.systemDecision;
  if (!system) return null;
  const confluences = system.confluences || [];
  const rejections = system.rejectionReasons || [];
  const patterns = system.candlePatterns || [];
  const dat = system.datFramework;

  return (
    <div className="grid gap-4 rounded-2xl border border-amber-100 bg-amber-50/40 p-4 text-xs md:grid-cols-3">
      <div className="space-y-2">
        <p className="font-black uppercase tracking-wider text-amber-700">Trade Readiness</p>
        <div className="rounded-xl bg-white/80 p-3 text-slate-700 shadow-sm">
          <div><b>Entry:</b> {system.entryReason || system.timingTip || 'n/a'}</div>
          <div><b>SL:</b> {system.slReason || 'n/a'}</div>
          <div><b>TP:</b> {system.tpReason || 'n/a'}</div>
          <div><b>Regime:</b> {system.regime || 'n/a'} · <b>HTF:</b> {system.htfBias || 'n/a'}</div>
          <div><b>Net conviction:</b> {system.netConviction ?? 'n/a'}</div>
        </div>
      </div>
      <div className="space-y-2">
        <p className="font-black uppercase tracking-wider text-amber-700">Framework</p>
        <div className="rounded-xl bg-white/80 p-3 text-slate-700 shadow-sm">
          {dat ? (
            <>
              <div><b>DAT:</b> {dat.score}/3</div>
              <div><b>Direction:</b> {dat.direction.reason}</div>
              <div><b>Area:</b> {dat.area.reason}</div>
              <div><b>Trigger:</b> {dat.trigger.reason}</div>
            </>
          ) : <div>DAT: n/a</div>}
          {system.sessionContext?.reason && <div className="mt-2"><b>Session:</b> {system.sessionContext.reason}</div>}
          {system.newsRisk?.reason && <div className="mt-2"><b>News:</b> {system.newsRisk.reason}</div>}
        </div>
      </div>
      <div className="space-y-2">
        <p className="font-black uppercase tracking-wider text-amber-700">Evidence</p>
        <div className="rounded-xl bg-white/80 p-3 text-slate-700 shadow-sm">
          <div><b>Confluences:</b> {confluences.length ? confluences.slice(0, 5).map((c) => `${c.name} +${c.points}`).join(', ') : 'none'}</div>
          <div className="mt-2"><b>Patterns:</b> {patterns.length ? patterns.slice(0, 4).map((p) => p.name).join(', ') : 'none'}</div>
          {rejections.length ? <div className="mt-2 text-red-700"><b>Reject:</b> {rejections.slice(0, 3).join('; ')}</div> : null}
        </div>
      </div>
    </div>
  );
}

function FttAdvisorDetails({ result }: { result: FttScanResult }) {
  const system = result.systemPrediction;
  const indicators = (system?.indicators || {}) as Record<string, any>;
  if (!system) return null;
  return (
    <div className="grid gap-4 rounded-2xl border border-indigo-100 bg-indigo-50/40 p-4 text-xs md:grid-cols-3">
      <div className="rounded-xl bg-white/80 p-3 text-slate-700 shadow-sm">
        <p className="mb-2 font-black uppercase tracking-wider text-indigo-700">Timing</p>
        <div><b>Direction:</b> {system.direction}</div>
        <div><b>Score:</b> {Math.round(system.confidence)}/100</div>
        <div><b>Status:</b> {system.tradeStatus || 'n/a'}</div>
        <div><b>Reason:</b> {system.reasoning || 'n/a'}</div>
      </div>
      <div className="rounded-xl bg-white/80 p-3 text-slate-700 shadow-sm">
        <p className="mb-2 font-black uppercase tracking-wider text-indigo-700">Quality</p>
        <div><b>Tier:</b> {String(indicators.qualityTier || indicators.grade || 'n/a')}</div>
        <div><b>Quality score:</b> {indicators.qualityScore ?? 'n/a'}</div>
        <div><b>Volatility:</b> {indicators.volatilityState || 'n/a'}</div>
        <div><b>Ichimoku:</b> {indicators.ichimokuState || 'n/a'}</div>
      </div>
      <div className="rounded-xl bg-white/80 p-3 text-slate-700 shadow-sm">
        <p className="mb-2 font-black uppercase tracking-wider text-indigo-700">Formation</p>
        <div><b>Reasons:</b> {Array.isArray(indicators.qualityReasons) && indicators.qualityReasons.length ? indicators.qualityReasons.slice(0, 3).join('; ') : 'n/a'}</div>
        <div className="mt-2 text-red-700"><b>Warnings:</b> {Array.isArray(indicators.riskWarnings) && indicators.riskWarnings.length ? indicators.riskWarnings.slice(0, 3).join('; ') : 'none'}</div>
      </div>
    </div>
  );
}

// Self-contained 1-second tick. Mounting this in a small leaf component keeps the
// per-second re-render scoped to just that component instead of the whole dashboard.
function useSecondTick() {
  const [, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((n) => (n + 1) % 86400), 1000);
    return () => clearInterval(id);
  }, []);
}

// "updated Xs ago" — ticks on its own so the header refresh label updates live
// without re-rendering the signal tables.
function TimeAgo({ date }: { date: Date | null }) {
  useSecondTick();
  return <>{secondsAgo(date)}</>;
}

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

function CopyPriceButton({ value, label }: { value?: number | string | null; label: string }) {
  const [copied, setCopied] = useState(false);
  const disabled = value === null || value === undefined || value === 'n/a';

  const handleCopy = async (event: React.MouseEvent) => {
    event.stopPropagation();
    if (disabled) return;
    try {
      await copyTextToClipboard(String(value));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1100);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      disabled={disabled}
      className={`inline-flex h-6 items-center justify-center rounded-md border bg-white shadow-sm transition disabled:cursor-not-allowed disabled:opacity-35 ${copied ? 'w-auto border-emerald-200 px-1.5 text-[10px] font-black text-emerald-700' : 'w-6 border-slate-200 text-slate-400 hover:border-amber-300 hover:bg-amber-50 hover:text-amber-700'}`}
      title={copied ? `${label} copied` : `Copy ${label}`}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
    >
      {copied ? 'Copied' : <Copy size={11} />}
    </button>
  );
}

function PriceWithCopy({ value, label, className = '', prefix = '' }: { value?: number | null; label: string; className?: string; prefix?: string }) {
  const formatted = price(value);
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      {prefix && <span className="font-sans text-[10px] font-black text-slate-400">{prefix}</span>}
      <span>{formatted}</span>
      <CopyPriceButton value={formatted} label={label} />
    </span>
  );
}

// The only time-sensitive cell in an FTT row (live entry-window countdown). Self-ticks
// so the surrounding row/table doesn't re-render every second.
function FttSuggestedEntryCell({ result }: { result: FttScanResult }) {
  useSecondTick();
  const system = result.systemPrediction;
  const isNoiseFiltered = system?.indicators?.noiseFilterActive === true;
  const displayDir = isNoiseFiltered ? system?.indicators?.systemDecision : (system?.direction || 'HOLD');
  const fttSuggestedEntry = getFttSuggestedEntry(result, displayDir, isNoiseFiltered);
  return (
    <div className="inline-flex flex-col gap-1" title={fttSuggestedEntry.tip}>
      <span className={`inline-flex w-fit rounded-lg border px-2 py-0.5 text-[10px] font-black ${fttSuggestedEntry.directionClass}`}>
        {fttSuggestedEntry.directionLabel}
      </span>
      <span className={`inline-flex w-fit rounded-lg border px-2 py-1 text-[10px] font-black transition-colors ${fttSuggestedEntry.className}`}>
        {fttSuggestedEntry.label}
      </span>
      {fttSuggestedEntry.secondaryLabel && (
        <span className="text-[10px] font-bold text-slate-400">
          {fttSuggestedEntry.secondaryLabel}
        </span>
      )}
    </div>
  );
}

// Make a clickable table row keyboard-operable: Enter/Space fires the same toggle.
function handleRowKey(event: React.KeyboardEvent, toggle: () => void) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    toggle();
  }
}

function ForexNewsFilterStrip({ results }: { results: ScanResult[] }) {
  const blocked = results.filter((r) => r.systemDecision?.newsRisk?.block);
  const cautions = results.filter((r) => !r.systemDecision?.newsRisk?.block && r.systemDecision?.newsRisk?.caution);
  if (!blocked.length && !cautions.length) return null;

  const affectedSymbols = [...blocked, ...cautions].map((r) => r.symbol);
  const hardBlock = blocked.length > 0;
  const title = [
    blocked.length ? `${blocked.length} blocked: ${blocked.map((r) => r.symbol).join(', ')}` : null,
    cautions.length ? `${cautions.length} caution: ${cautions.map((r) => r.symbol).join(', ')}` : null,
  ].filter(Boolean).join(' | ');

  return (
    <div className={`shrink-0 overflow-hidden rounded-xl border shadow-sm ${hardBlock ? 'border-red-200 bg-red-50 text-red-700' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
      <div className="flex items-center gap-2 px-3 py-2.5 text-xs font-black">
        <AlertTriangle size={15} className="shrink-0" />
        <span className="shrink-0 uppercase tracking-wider">News Filter</span>
        <span className="min-w-0 truncate font-bold" title={title}>
          {blocked.length ? `${blocked.length} forced HOLD` : 'No forced HOLD'}
          {cautions.length ? ` · ${cautions.length} caution` : ''}
          {' · '}{affectedSymbols.join(', ')}
        </span>
      </div>
    </div>
  );
}

function ForexTableColGroup() {
  return (
    <colgroup>
      <col className="w-[88px]" />
      <col className="w-[52px]" />
      <col className="w-[108px]" />
      <col className="w-[72px]" />
      <col className="w-[120px]" />
      <col className="w-[96px]" />
      <col className="w-[112px]" />
      <col className="w-[88px]" />
      <col className="w-[96px]" />
      <col className="w-[96px]" />
      <col className="w-[96px]" />
      <col className="w-[96px]" />
      <col className="w-[56px]" />
      <col className="w-[56px]" />
    </colgroup>
  );
}

function ForexTableHead() {
  return (
    <thead className="bg-white text-xs uppercase tracking-[0.16em] text-slate-500">
      <tr>
        <th className="px-2 py-2.5 text-left">Symbol</th>
        <th className="px-2 py-2.5 text-left">TF</th>
        <th className="px-2 py-2.5 text-center">System Advisor</th>
        <th className="px-2 py-2.5 text-center">Score</th>
        <th className="px-2 py-2.5 text-center">Setup</th>
        <th className="px-2 py-2.5 text-left">Entry Price</th>
        <th className="px-2 py-2.5 text-left">Suggested Entry</th>
        <th className="px-2 py-2.5 text-left">SL Target</th>
        <th className="px-2 py-2.5 text-left">TP Plan</th>
        <th className="px-2 py-2.5 text-left">Position</th>
        <th className="px-2 py-2.5 text-left">Risk</th>
        <th className="px-2 py-2.5 text-left">Profit Plan</th>
        <th className="px-2 py-2.5 text-left">ADR</th>
        <th className="px-2 py-2.5 text-center">News</th>
      </tr>
    </thead>
  );
}

function FttTableColGroup() {
  return (
    <colgroup>
      <col className="w-[88px]" />
      <col className="w-[64px]" />
      <col className="w-[88px]" />
      <col className="w-[108px]" />
      <col className="w-[72px]" />
      <col className="w-[120px]" />
      <col className="w-[96px]" />
      <col className="w-[96px]" />
      <col className="w-[112px]" />
      <col className="w-[96px]" />
    </colgroup>
  );
}

function FttTableHead() {
  return (
    <thead className="bg-white text-xs uppercase tracking-[0.16em] text-slate-500">
      <tr>
        <th className="px-2 py-2.5 text-left">Symbol</th>
        <th className="px-2 py-2.5 text-left">Expiry</th>
        <th className="px-2 py-2.5 text-left">Trade Time</th>
        <th className="px-2 py-2.5 text-center">System Advisor</th>
        <th className="px-2 py-2.5 text-center">Score</th>
        <th className="px-2 py-2.5 text-center">FTT Grade</th>
        <th className="px-2 py-2.5 text-center">AI Advisor</th>
        <th className="px-2 py-2.5 text-left">Entry Price</th>
        <th className="px-2 py-2.5 text-left">Suggested Entry</th>
        <th className="px-2 py-2.5 text-right">Actions</th>
      </tr>
    </thead>
  );
}

export default function SignalDashboard() {
  const { indicators, status, refresh, addTopbarAlert } = useMt5Stream();
  const [coverageRows, setCoverageRows] = useState<Mt5CandleCoverageRow[]>([]);
  const symbols = useMemo(() => orderSymbols([
    ...coverageRows.map((row) => row.symbol),
    ...status.symbols,
    ...indicators.map((indicator) => indicator.symbol),
  ]), [coverageRows, status.symbols, indicators]);
  // Curated liquid majors + gold that actually exist in this broker's symbol set.
  const primarySymbols = useMemo(() => curatedAvailable(symbols), [symbols]);
  const timeframes = useMemo(() => [...new Set([...status.timeframes, ...indicators.map((indicator) => indicator.timeframe)].filter(Boolean))].sort(), [status.timeframes, indicators]);
  
  const [selectedSymbol, setSelectedSymbol] = useState('');
  const [selectedTimeframe, setSelectedTimeframe] = useState('M5');
  const [scanTimeframe, setScanTimeframe] = useState('M5');
  const [scanResults, setScanResults] = useState<ScanResult[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [isLiveUpdating, setIsLiveUpdating] = useState(false);
  const [lastLiveUpdateAt, setLastLiveUpdateAt] = useState<Date | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [loadingAiMap, setLoadingAiMap] = useState<Record<string, boolean>>({});
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  // FTT specific state
  const [activeTab, setActiveTab] = useState<'forex' | 'ftt'>('forex');
  const [fttScanExpiry, setFttScanExpiry] = useState('5m');
  const [fttScanResults, setFttScanResults] = useState<FttScanResult[]>([]);

  // Countdown re-renders are now scoped to the small self-ticking leaf components
  // (TimeAgo, FttSuggestedEntryCell) rather than a dashboard-wide 1s tick.

  useEffect(() => {
    if (!selectedSymbol && symbols.length) setSelectedSymbol(symbols[0]);
  }, [selectedSymbol, symbols]);

  // Load full symbol coverage from the database so every synced instrument is selectable.
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
    const interval = window.setInterval(() => void load(), 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  useEffect(() => {
    if (!timeframes.includes(selectedTimeframe) && timeframes.length) setSelectedTimeframe(timeframes.includes('M5') ? 'M5' : timeframes[0]);
  }, [selectedTimeframe, timeframes]);

  async function refreshLiveForex() {
    if (!primarySymbols.length) return;
    setIsLiveUpdating(true);
    try {
      const response = await triggerAllSymbolsScan(scanTimeframe, primarySymbols);
      // Only keep rows for the active timeframe so switching TFs doesn't leave stale rows behind.
      setScanResults((prev) => mergeScanResults(prev.filter((r) => r.timeframe === scanTimeframe), response.results));
      response.results.forEach((result) => {
        const alert = forexTopbarAlert(result);
        if (alert) addTopbarAlert(alert, true);
      });
      setLastLiveUpdateAt(new Date());
      setScanError(null);
    } catch (error) {
      setScanError(error instanceof Error ? error.message : 'Live Forex stream failed');
    } finally {
      setIsLiveUpdating(false);
    }
  }

  async function refreshLiveFtt() {
    if (!primarySymbols.length) return;
    setIsLiveUpdating(true);
    try {
      const response = await triggerFttScan(fttScanExpiry, primarySymbols);
      // Only keep rows for the active expiry so switching expiries doesn't leave stale rows behind.
      setFttScanResults((prev) => mergeFttResults(prev.filter((r) => r.expiry === fttScanExpiry), response.results));
      response.results.forEach((result) => {
        const alert = fttTopbarAlert(result);
        if (alert) addTopbarAlert(alert, true);
      });
      setLastLiveUpdateAt(new Date());
      setScanError(null);
    } catch (error) {
      setScanError(error instanceof Error ? error.message : 'Live Fixed-Time stream failed');
    } finally {
      setIsLiveUpdating(false);
    }
  }

  // Quiet live cache updates: keeps the table stance visible while scanner data changes.
  useEffect(() => {
    if (!primarySymbols.length) return;
    let cancelled = false;
    const run = async () => {
      if (cancelled || document.visibilityState === 'hidden') return;
      if (activeTab === 'forex') await refreshLiveForex();
      else await refreshLiveFtt();
    };
    void run();
    const interval = window.setInterval(() => void run(), 5000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [activeTab, scanTimeframe, fttScanExpiry, primarySymbols.join('|')]);

  async function handleScan() {
    setIsScanning(true);
    setScanError(null);
    try {
      const response = await triggerAllSymbolsScan(scanTimeframe, primarySymbols);
      // Only keep rows for the active timeframe so switching TFs doesn't leave stale rows behind.
      setScanResults((prev) => mergeScanResults(prev.filter((r) => r.timeframe === scanTimeframe), response.results));
      response.results.forEach((result) => {
        const alert = forexTopbarAlert(result);
        if (alert) addTopbarAlert(alert, true);
      });
      setLastLiveUpdateAt(new Date());
    } catch (error) {
      setScanError(error instanceof Error ? error.message : 'Scanner failed');
    } finally {
      setIsScanning(false);
    }
  }

  async function handleFttScan() {
    setIsScanning(true);
    setScanError(null);
    try {
      const response = await triggerFttScan(fttScanExpiry, primarySymbols);
      // Only keep rows for the active expiry so switching expiries doesn't leave stale rows behind.
      setFttScanResults((prev) => mergeFttResults(prev.filter((r) => r.expiry === fttScanExpiry), response.results));
      response.results.forEach((result) => {
        const alert = fttTopbarAlert(result);
        if (alert) addTopbarAlert(alert, true);
      });
      setLastLiveUpdateAt(new Date());
    } catch (error) {
      setScanError(error instanceof Error ? error.message : 'FTT Scanner failed');
    } finally {
      setIsScanning(false);
    }
  }

  async function handleFttAskAi(symbol: string) {
    setLoadingAiMap(prev => ({ ...prev, [symbol]: true }));
    try {
      await triggerFttPrediction(symbol, fttScanExpiry, 'ai');
      await refresh();
      // Re-run FTT scan to update scan results with the new AI decision (merge, consistent with the live path).
      const response = await triggerFttScan(fttScanExpiry, primarySymbols);
      setFttScanResults((prev) => mergeFttResults(prev.filter((r) => r.expiry === fttScanExpiry), response.results));
      response.results.forEach((result) => {
        const alert = fttTopbarAlert(result);
        if (alert) addTopbarAlert(alert, true);
      });
    } catch (error) {
      alert(error instanceof Error ? error.message : 'FTT AI analysis failed');
    } finally {
      setLoadingAiMap(prev => ({ ...prev, [symbol]: false }));
    }
  }

  return (
    <div className="terminal-page -mx-6 flex min-h-full flex-1 flex-col gap-3 px-1 pb-3 pt-1 sm:px-1.5 lg:-mx-10 lg:px-2 lg:pb-4 lg:pt-1">
      <div className="shrink-0 overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm">
        <div className="flex flex-col gap-2 px-2 py-1.5 xl:flex-row xl:items-center xl:justify-between xl:px-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <button
              onClick={() => setActiveTab('forex')}
              className={`inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm font-black transition ${
                activeTab === 'forex'
                  ? 'border-amber-300 bg-amber-50 text-slate-950 shadow-sm'
                  : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-800'
              }`}
            >
              <Activity size={15} />
              Forex Signals
              <span className="rounded-full bg-white/80 px-2 py-0.5 text-[10px] font-black text-slate-500">{scanResults.length}</span>
            </button>
            <button
              onClick={() => setActiveTab('ftt')}
              className={`inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm font-black transition ${
                activeTab === 'ftt'
                  ? 'border-amber-300 bg-amber-50 text-slate-950 shadow-sm'
                  : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-800'
              }`}
            >
              <Timer size={15} />
              Fixed-Time Signals
              <span className="rounded-full bg-white/80 px-2 py-0.5 text-[10px] font-black text-slate-500">{fttScanResults.length}</span>
            </button>
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-black text-emerald-700">
              <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
              Live · updated <TimeAgo date={lastLiveUpdateAt} />
              {isLiveUpdating && <Loader2 size={12} className="animate-spin" />}
            </div>
          </div>

          {activeTab === 'forex' ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">TF</span>
              <select
                value={scanTimeframe}
                onChange={(event) => setScanTimeframe(event.target.value)}
                className="h-9 rounded-lg border border-slate-200 bg-white px-2.5 text-sm font-bold text-slate-900 outline-none focus:border-amber-400"
              >
                {timeframes.map((item) => <option key={item}>{item}</option>)}
              </select>
              <button
                onClick={handleScan}
                disabled={isScanning}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-950 px-3 text-sm font-black text-white shadow-md shadow-slate-900/15 transition hover:bg-amber-600 disabled:opacity-50"
              >
                {isScanning ? <Loader2 size={15} className="animate-spin" /> : <RefreshCcw size={15} />}
                Manual Refresh
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">Expiry</span>
              <select
                value={fttScanExpiry}
                onChange={(event) => setFttScanExpiry(event.target.value)}
                className="h-9 rounded-lg border border-slate-200 bg-white px-2.5 text-sm font-bold text-slate-900 outline-none focus:border-amber-400"
              >
                <option value="1m">1 min</option>
                <option value="2m">2 min</option>
                <option value="3m">3 min</option>
                <option value="4m">4 min</option>
                <option value="5m">5 min</option>
                <option value="10m">10 min</option>
                <option value="15m">15 min</option>
                <option value="20m">20 min</option>
                <option value="30m">30 min</option>
                <option value="40m">40 min</option>
                <option value="1h">1 hour</option>
              </select>
              <button
                onClick={handleFttScan}
                disabled={isScanning}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-950 px-3 text-sm font-black text-white shadow-md shadow-slate-900/15 transition hover:bg-amber-600 disabled:opacity-50"
              >
                {isScanning ? <Loader2 size={15} className="animate-spin" /> : <RefreshCcw size={15} />}
                Manual Refresh
              </button>
            </div>
          )}
        </div>
      </div>

      {scanError && (
        <div className="shrink-0 rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-700">
          {scanError}
        </div>
      )}

      {/* News filter — static row above table; never sticky, never inside scroll */}
      {activeTab === 'forex' && <ForexNewsFilterStrip results={scanResults} />}

      {/* Scanner Results Table */}
      <section className="light-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200/80 p-0 shadow-sm">
        {activeTab === 'forex' ? (
          <>
            <div className="shrink-0 overflow-x-auto border-b border-slate-200 bg-white">
              <table className="w-full min-w-[1280px] table-fixed text-left text-sm">
                <ForexTableColGroup />
                <ForexTableHead />
              </table>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full min-w-[1280px] table-fixed text-left text-sm">
                <ForexTableColGroup />
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {scanResults.map((result) => {
                    const system = result.systemDecision;
                    const isSelected = selectedSymbol === result.symbol && selectedTimeframe === result.timeframe;
                    const rowKey = `${result.symbol}|${result.timeframe}`;
                    const risk = system?.riskPlan || null;
                    const multiplier = risk?.multiplier || (risk?.leverage ? `${risk.leverage}x` : 'n/a');
                    const margin = risk?.marginRequired ?? risk?.amountToInvestApprox ?? null;
                    const amountToRisk = risk?.amountToRisk ?? risk?.riskAmount ?? null;
                    const slLoss = risk?.lossAtStop ?? risk?.maxLoss ?? null;

                    const systemDir = system?.decision || 'HOLD';
                    const suggestedEntry = getForexSuggestedEntry(system);
                    const toggleRow = () => {
                      setSelectedSymbol(result.symbol);
                      setSelectedTimeframe(result.timeframe);
                      setExpandedRow((prev) => prev === rowKey ? null : rowKey);
                    };
                    return (
                      <React.Fragment key={rowKey}>
                      <tr
                        onClick={toggleRow}
                        onKeyDown={(e) => handleRowKey(e, toggleRow)}
                        tabIndex={0}
                        role="button"
                        aria-expanded={expandedRow === rowKey}
                        className={`cursor-pointer transition hover:bg-slate-50/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${isSelected ? 'bg-amber-50/30' : ''}`}
                      >
                        <td className="px-2 py-1.5 font-black text-slate-900">{result.symbol}</td>
                        <td className="px-2 py-1.5 font-mono text-xs font-bold text-slate-400">{result.timeframe}</td>
                        <td className="px-2 py-1.5 text-center">
                          <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-black border ${decisionClass(systemDir)}`}>
                            {systemDir.replace('_', ' ')}
                          </span>
                        </td>
                        <td className="px-2 py-1.5 text-center font-mono text-sm font-extrabold">
                          {system?.confidence !== undefined ? (
                            <span className={
                              system.confidence >= 90 ? 'text-emerald-600 font-black' :
                              system.confidence >= 80 ? 'text-emerald-500 font-bold' :
                              system.confidence >= 70 ? 'text-blue-500 font-bold' :
                              'text-slate-400 font-semibold'
                            }>
                              {Math.round(system.confidence)}/100
                            </span>
                          ) : 'n/a'}
                        </td>
                        <td className="px-2 py-1.5 text-center">
                          <div className="flex flex-col items-center gap-1 leading-tight">
                            {renderSignalQualityBadge(system?.signalQuality)}
                            {renderGradeBadge(system?.grade)}
                            {system?.strategyType && (
                              <span className="text-[10px] font-black uppercase tracking-wider text-amber-700">{system.strategyType}</span>
                            )}
                            {system?.datFramework && (
                              <span className="text-[10px] font-bold text-slate-400">DAT {system.datFramework.score}/3</span>
                            )}
                            {system?.sessionContext?.reason && (
                              <span className="max-w-[115px] truncate text-[10px] font-semibold text-slate-400" title={system.sessionContext.reason}>
                                {system.sessionContext.reason}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-2 py-1.5 font-mono font-extrabold text-slate-900" onClick={(e) => e.stopPropagation()}>
                          <PriceWithCopy value={system?.entryPrice ?? null} label="Entry price" />
                        </td>
                        <td className="px-2 py-1.5">
                          <div className="inline-flex flex-col gap-1" title={suggestedEntry.tip}>
                            <span className={`inline-flex w-fit rounded-lg border px-2 py-0.5 text-[10px] font-black ${suggestedEntry.directionClass}`}>
                              {suggestedEntry.directionLabel}
                            </span>
                            <span className={`inline-flex w-fit rounded-lg border px-2 py-1 text-[10px] font-black ${suggestedEntry.className}`}>
                              {suggestedEntry.label}
                            </span>
                          </div>
                        </td>
                        <td className="px-2 py-1.5 font-mono font-bold text-red-600" onClick={(e) => e.stopPropagation()}>
                          <PriceWithCopy value={system?.stopLoss ?? null} label="Stop loss" />
                        </td>
                        <td className="px-2 py-1.5 font-mono text-xs font-bold leading-tight text-emerald-700" onClick={(e) => e.stopPropagation()}>
                          <div><PriceWithCopy value={system?.takeProfit1 ?? null} label="TP1" prefix="TP1" /></div>
                          <div><PriceWithCopy value={system?.takeProfit2 ?? null} label="TP2" prefix="TP2" /></div>
                          <div><PriceWithCopy value={system?.takeProfit3 ?? null} label="TP3" prefix="TP3" /></div>
                        </td>
                        <td className="px-2 py-1.5 text-xs leading-tight">
                          <div className="font-mono font-black text-slate-900">Lot {risk?.suggestedLotSize ?? 'n/a'}</div>
                          <div className="font-semibold text-slate-500">Multiplier {multiplier}</div>
                          <div className="font-semibold text-slate-500">Margin {money(margin)}</div>
                        </td>
                        <td className="px-2 py-1.5 text-xs leading-tight">
                          <div className="font-semibold text-slate-700">Risk {money(amountToRisk)}</div>
                          <div className="font-mono font-black text-red-600">SL Loss {signedLoss(slLoss)}</div>
                          <div className="font-semibold text-slate-500">Stop {risk?.stopPips ?? 'n/a'} pips</div>
                        </td>
                        <td className="px-2 py-1.5 text-xs leading-tight">
                          <div className="font-semibold text-emerald-700">TP1 {money(risk?.profitAtTp1)}</div>
                          <div className="font-semibold text-emerald-700">TP2 {money(risk?.profitAtTp2)}</div>
                          <div className="font-semibold text-emerald-700">TP3 {money(risk?.profitAtTp3)}</div>
                        </td>
                        <td className="px-2 py-1.5 font-mono font-bold">
                          {system && system.adrUsagePercent > 0 ? (
                            <span className={system.adrExhausted ? 'text-red-600 font-black' : 'text-slate-600'}>
                              {system.adrUsagePercent.toFixed(0)}%
                            </span>
                          ) : 'n/a'}
                        </td>
                        <td className="px-2 py-1.5 text-center">
                          {system?.newsRisk?.block ? (
                            <span className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-1.5 py-0.5 text-[9px] font-black text-red-700" title={system.newsRisk.reason || ''}>
                              <AlertTriangle size={10} /> NEWS
                            </span>
                          ) : system?.newsRisk?.caution ? (
                            <span className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[9px] font-black text-amber-700" title={system.newsRisk.reason || ''}>
                              <CalendarClock size={10} /> CAUT
                            </span>
                          ) : (
                            <span className="text-slate-300 text-xs font-bold">—</span>
                          )}
                        </td>
                      </tr>
                      {expandedRow === rowKey && (
                        <tr>
                          <td colSpan={14} className="px-2 pb-1.5 pt-0">
                            <ForexAdvisorDetails result={result} />
                          </td>
                        </tr>
                      )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            
            {scanResults.length === 0 && !isScanning && (
              <div className="m-3 rounded-2xl border border-dashed border-slate-200 bg-white p-5 text-center text-sm font-semibold text-slate-500">
                No Forex symbols scanned yet. Choose a timeframe or wait for the live stream.
              </div>
            )}
          </>
        ) : (
          <>
            <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/70 px-3 py-2">
              <div className="flex items-center gap-3 text-slate-900">
                <Timer className="text-amber-500" size={18} />
                <h2 className="text-base font-black">Fixed-Time Scan Results ({fttScanResults.length})</h2>
              </div>
            </div>

            <div className="shrink-0 overflow-x-auto border-b border-slate-200 bg-white">
              <table className="w-full min-w-[860px] table-fixed text-left text-sm">
                <FttTableColGroup />
                <FttTableHead />
              </table>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full min-w-[860px] table-fixed text-left text-sm">
                <FttTableColGroup />
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {fttScanResults.map((result) => {
                    const system = result.systemPrediction;
                    const ai = result.latestAiPrediction;
                    const isSelected = selectedSymbol === result.symbol && selectedTimeframe === mapExpiryToTimeframe(result.expiry);
                    const rowKey = `${result.symbol}|${result.expiry}`;

                    const systemDir = system?.direction || 'HOLD';
                    const aiDir = ai?.direction || 'HOLD';

                    // Live entry-window timing is computed inside FttSuggestedEntryCell (self-ticking).
                    const qualityTier = system?.tradeStatus || system?.indicators?.qualityTier;
                    const topWarning = system?.indicators?.riskWarnings?.[0] || system?.indicators?.qualityReasons?.[0] || null;
                    const toggleRow = () => {
                      setSelectedSymbol(result.symbol);
                      setSelectedTimeframe(mapExpiryToTimeframe(result.expiry));
                      setExpandedRow((prev) => prev === rowKey ? null : rowKey);
                    };

                    return (
                      <React.Fragment key={rowKey}>
                      <tr
                        onClick={toggleRow}
                        onKeyDown={(e) => handleRowKey(e, toggleRow)}
                        tabIndex={0}
                        role="button"
                        aria-expanded={expandedRow === rowKey}
                        className={`cursor-pointer transition hover:bg-slate-50/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${qualityTier === 'QUALITY_SIGNAL' ? 'bg-emerald-50/40 ring-1 ring-emerald-100' : ''} ${isSelected ? 'bg-amber-50/30' : ''}`}
                      >
                        <td className="px-2 py-1.5 font-black text-slate-900">{result.symbol}</td>
                        <td className="px-2 py-1.5 font-mono text-xs font-bold text-slate-400">{result.expiry}</td>
                        <td className="px-2 py-1.5 font-semibold text-slate-700">{formatExpiryLabel(result.expiry)}</td>
                        <td className="px-2 py-1.5 text-center">
                          <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-black border ${decisionClass(systemDir)}`}>
                            {systemDir}
                          </span>
                        </td>
                        <td className="px-2 py-1.5 text-center font-mono text-sm font-extrabold">
                          {system?.confidence !== undefined ? (
                            <span className={
                              system.confidence >= 90 ? 'text-emerald-600 font-black' :
                              system.confidence >= 80 ? 'text-emerald-500 font-bold' :
                              system.confidence >= 70 ? 'text-blue-500 font-bold' :
                              'text-slate-400 font-semibold'
                            }>
                              {Math.round(system.confidence)}/100
                            </span>
                          ) : 'n/a'}
                        </td>
                        <td className="px-2 py-1.5 text-center">
                          <div className="flex flex-col items-center gap-0.5 leading-tight">
                            {renderFttStatusBadge(system)}
                            {system?.indicators?.qualityScore !== undefined && (
                              <span className="text-[10px] font-bold text-slate-400">Q {system.indicators.qualityScore}/100</span>
                            )}
                            {topWarning && (
                              <span className="max-w-[120px] truncate text-[10px] font-semibold text-slate-400" title={String(topWarning)}>{String(topWarning)}</span>
                            )}
                          </div>
                        </td>
                        <td className="px-2 py-1.5 text-center">
                          {ai ? (
                            <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-black border ${decisionClass(aiDir)}`}>
                              {aiDir}
                            </span>
                          ) : (
                            <span className="text-slate-300 font-bold text-xs italic">Not analyzed</span>
                          )}
                        </td>
                        <td className="px-2 py-1.5 font-mono font-extrabold text-slate-900" onClick={(e) => e.stopPropagation()}>
                          <PriceWithCopy value={system?.entryPrice ?? null} label="FTT entry price" />
                        </td>
                        <td className="px-2 py-1.5 font-semibold">
                          <FttSuggestedEntryCell result={result} />
                        </td>
                        <td className="px-2 py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => handleFttAskAi(result.symbol)}
                            disabled={loadingAiMap[result.symbol]}
                            className="inline-flex items-center gap-1 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-bold text-amber-700 transition hover:bg-amber-100 disabled:opacity-50"
                          >
                            {loadingAiMap[result.symbol] ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <Bot size={12} />
                            )}
                            <span>Ask AI</span>
                          </button>
                        </td>
                      </tr>
                      {expandedRow === rowKey && (
                        <tr>
                          <td colSpan={10} className="px-2 pb-1.5 pt-0">
                            <FttAdvisorDetails result={result} />
                          </td>
                        </tr>
                      )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            
            {fttScanResults.length === 0 && !isScanning && (
              <div className="m-3 rounded-2xl border border-dashed border-slate-200 bg-white p-5 text-center text-sm font-semibold text-slate-500">
                No Fixed-Time symbols scanned yet. Choose an expiry or wait for the live stream.
              </div>
            )}
          </>
        )}
        
        {isScanning && (
          <div className="flex flex-col items-center justify-center space-y-3 py-8">
            <Loader2 size={32} className="animate-spin text-amber-500" />
            <p className="text-sm font-bold text-slate-500">Running quantitative scan on all Exness assets...</p>
          </div>
        )}
      </section>

      {/* Selected Symbol Detail Header */}
      {selectedSymbol && (
        <div className="flex flex-col gap-3 border-t border-slate-100 pt-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.32em] text-slate-500">Details</p>
            <h2 className="mt-2 text-2xl font-black text-slate-900">{selectedSymbol} {selectedTimeframe} Indicators</h2>
          </div>
          <div className="flex gap-3">
            <select 
              value={selectedSymbol} 
              onChange={(event) => setSelectedSymbol(event.target.value)} 
              className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-900 outline-none focus:border-amber-400"
            >
              {symbols.map((item) => <option key={item}>{item}</option>)}
            </select>
            <select 
              value={selectedTimeframe} 
              onChange={(event) => setSelectedTimeframe(event.target.value)} 
              className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-900 outline-none focus:border-amber-400"
            >
              {timeframes.map((item) => <option key={item}>{item}</option>)}
            </select>
          </div>
        </div>
      )}

      {/* Signal Details Grid */}
      {selectedSymbol && (
        <SignalGrid indicators={indicators} symbol={selectedSymbol} timeframe={selectedTimeframe} />
      )}
    </div>
  );
}
