import React, { useState } from 'react';
import { Bot, RefreshCcw, ShieldAlert, Target, Copy, ArrowRight, Layers, HelpCircle, Zap, Clock } from 'lucide-react';
import type { AiDecision } from '../types';

interface DecisionCardProps {
  decision?: AiDecision | null;
  loading?: boolean;
  onAnalyze?: () => void;
  advisorMode?: 'ai' | 'system';
  setAdvisorMode?: (mode: 'ai' | 'system') => void;
}

function price(value?: number | null) {
  if (value === null || value === undefined) return 'n/a';
  const abs = Math.abs(value);
  if (abs >= 1000) return value.toFixed(2); // gold / indices
  if (abs >= 50) return value.toFixed(3);   // JPY pairs
  return value.toFixed(5);                   // FX majors
}

function money(value?: number | null) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'n/a';
  return `$${Number(value).toFixed(2)}`;
}

function signedLoss(value?: number | null) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'n/a';
  return `-${money(Math.abs(Number(value)))}`;
}

function decisionClass(decision?: string) {
  if (!decision || decision === 'HOLD') return 'border-slate-200 bg-slate-50 text-slate-700';
  if (decision.includes('BUY')) return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  return 'border-red-200 bg-red-50 text-red-800';
}

const CopyButton = ({ value, label }: { value?: any; label: string }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (value === null || value === undefined) return;
    navigator.clipboard.writeText(value.toString());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      onClick={handleCopy}
      disabled={value === null || value === undefined}
      className="inline-flex items-center gap-1 rounded-md border border-slate-100 bg-slate-50 px-2 py-0.5 font-mono text-[10px] text-slate-500 hover:border-amber-200 hover:bg-amber-50 hover:text-amber-700 transition disabled:opacity-50"
      title={`Copy ${label}`}
    >
      <Copy size={10} />
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
};

export default function DecisionCard({ 
  decision, 
  loading, 
  onAnalyze, 
  advisorMode: propAdvisorMode, 
  setAdvisorMode: propSetAdvisorMode 
}: DecisionCardProps) {
  const [localAdvisorMode, setLocalAdvisorMode] = useState<'ai' | 'system'>('ai');
  const advisorMode = propAdvisorMode !== undefined ? propAdvisorMode : localAdvisorMode;
  const setAdvisorMode = propSetAdvisorMode !== undefined ? propSetAdvisorMode : setLocalAdvisorMode;
  const context = decision?.market_context as any;
  const entryTf = decision?.timeframe || 'n/a';
  const trendTf = context?.trendTimeframe || null;
  const biasTf = context?.biasTimeframe || null;

  const trendScore = context?.trendCompositeScore;
  const biasScore = context?.biasCompositeScore;

  const isSystem = advisorMode === 'system';
  const system = decision?.system_decision;
  const riskPlan = isSystem ? system?.riskPlan : null;

  const activeRec = isSystem && system ? system.decision : (decision?.decision || 'HOLD');
  const activeConfidence = isSystem && system ? system.confidence : (decision?.confidence ?? 0);
  const activeEntryPrice = isSystem && system ? system.entryPrice : (decision?.entry_price ?? null);
  const activeSL = isSystem && system ? system.stopLoss : (decision?.stop_loss ?? null);
  const activeTP1 = isSystem && system ? system.takeProfit1 : (decision?.take_profit_1 ?? null);
  const activeTP2 = isSystem && system ? system.takeProfit2 : (decision?.take_profit_2 ?? null);
  const activeTP3 = isSystem && system ? system.takeProfit3 : (decision?.take_profit_3 ?? null);
  const activeRR = isSystem && system ? system.riskRewardRatio : (decision?.risk_reward_ratio ?? null);
  
  const activeIsBuy = activeRec.includes('BUY');
  const activeIsSell = activeRec.includes('SELL');
  const activeIsHold = !activeIsBuy && !activeIsSell;

  const activeLotSize = isSystem ? (riskPlan?.suggestedLotSize ?? null) : (decision?.suggested_lot_size ?? null);
  const activeRiskPercent = isSystem ? (riskPlan?.riskPercent ?? null) : 1.0;
  const activeRiskAmount = riskPlan?.amountToRisk ?? riskPlan?.riskAmount ?? riskPlan?.maxLoss ?? null;

  const slTipToShow = isSystem ? system?.slTip : (system?.slTip ? `System hint: ${system.slTip}` : null);
  const tpTipToShow = isSystem ? system?.tpTip : (system?.tpTip ? `System hint: ${system.tpTip}` : null);

  function getTfStatus(score?: number | null, isDecision = false, decString?: string) {
    if (isDecision && decString) {
      if (decString === 'HOLD') return { text: 'Neutral 🟡', color: 'text-amber-700 bg-amber-50 border-amber-100' };
      if (decString.includes('BUY')) return { text: 'Bullish 🟢', color: 'text-emerald-700 bg-emerald-50 border-emerald-100' };
      return { text: 'Bearish 🔴', color: 'text-red-700 bg-red-50 border-red-100' };
    }
    if (score === undefined || score === null) return { text: 'No Data ⚪', color: 'text-slate-400 bg-slate-50 border-slate-100' };
    if (score >= 0.3) return { text: 'Bullish 🟢', color: 'text-emerald-700 bg-emerald-50 border-emerald-100' };
    if (score <= -0.3) return { text: 'Bearish 🔴', color: 'text-red-700 bg-red-50 border-red-100' };
    return { text: 'Neutral 🟡', color: 'text-amber-700 bg-amber-50 border-amber-100' };
  }

  const biasStatus = getTfStatus(biasScore);
  const trendStatus = getTfStatus(trendScore);
  const entryStatus = getTfStatus(null, true, activeRec);

  return (
    <section className="light-card rounded-3xl p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-amber-600">
            {isSystem ? <Layers size={22} /> : <Bot size={22} />}
          </div>
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.28em] text-slate-500">
              {isSystem ? 'System Decision' : 'AI Decision Summary'}
            </p>
            <h2 className="mt-1 text-2xl font-black text-slate-900">{decision?.symbol || 'XAUUSD'} Setup</h2>
            {decision?.created_at && (
              <p className="mt-0.5 text-[10px] font-bold text-slate-400">
                As of {new Date(decision.created_at).toLocaleTimeString()}
              </p>
            )}
          </div>
        </div>
        <button
          onClick={onAnalyze}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm font-bold text-amber-700 transition hover:bg-amber-100 disabled:opacity-50"
        >
          <RefreshCcw size={16} className={loading ? 'animate-spin' : ''} />
          {isSystem ? 'Scan Setup' : 'Ask AI'}
        </button>
      </div>

      {/* Advisor Mode Toggle Tabs */}
      <div className="flex rounded-xl bg-slate-100 p-1 border border-slate-200">
        <button
          onClick={() => setAdvisorMode('ai')}
          className={`flex-1 rounded-lg py-2 text-xs font-bold transition flex items-center justify-center gap-1.5 ${!isSystem ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-900'}`}
        >
          <Bot size={14} />
          AI Advisor
        </button>
        <button
          onClick={() => setAdvisorMode('system')}
          className={`flex-1 rounded-lg py-2 text-xs font-bold transition flex items-center justify-center gap-1.5 ${isSystem ? 'bg-amber-500 text-white shadow-sm' : 'text-slate-500 hover:text-slate-900'}`}
        >
          <Layers size={14} />
          System Advisor (Deterministic)
        </button>
      </div>

      {/* Timeframes Analyzed */}
      <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4 space-y-3">
        <div className="flex items-center gap-2 text-slate-600">
          <Layers size={14} />
          <span className="text-xs font-black uppercase tracking-[0.16em]">Multi-Timeframe Structure</span>
        </div>
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div className="flex flex-col gap-1.5 rounded-xl border border-slate-200 bg-white p-3">
            <span className="text-slate-400 font-bold">1. Bias ({biasTf || 'H4'})</span>
            <span className={`inline-flex rounded-lg px-2 py-0.5 font-black text-[10px] w-fit ${biasStatus.color}`}>
              {biasStatus.text}
            </span>
          </div>
          <div className="flex flex-col gap-1.5 rounded-xl border border-slate-200 bg-white p-3">
            <span className="text-slate-400 font-bold">2. Trend ({trendTf || 'H1'})</span>
            <span className={`inline-flex rounded-lg px-2 py-0.5 font-black text-[10px] w-fit ${trendStatus.color}`}>
              {trendStatus.text}
            </span>
          </div>
          <div className="flex flex-col gap-1.5 rounded-xl border border-slate-200 bg-white p-3">
            <span className="text-slate-400 font-bold">3. Entry ({entryTf})</span>
            <span className={`inline-flex rounded-lg px-2 py-0.5 font-black text-[10px] w-fit ${entryStatus.color}`}>
              {entryStatus.text}
            </span>
          </div>
        </div>
      </div>

      {/* Main Signal & Sizing */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className={`rounded-2xl border p-5 flex flex-col justify-between ${decisionClass(activeRec)}`}>
          <div>
            <div className="flex justify-between items-start gap-2">
              <p className="text-xs font-bold uppercase tracking-[0.24em] opacity-75">Recommendation</p>
              {isSystem && system?.grade && (
                <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[10px] font-black uppercase tracking-wider border shadow-sm ${
                  system.grade.includes('A+') ? 'bg-emerald-600 text-white border-emerald-700 animate-pulse' :
                  system.grade.includes('A') ? 'bg-emerald-50 text-emerald-800 border-emerald-200' :
                  system.grade.includes('B') ? 'bg-blue-50 text-blue-800 border-blue-200' :
                  'bg-slate-200 text-slate-700 border-slate-300'
                }`}>
                  {system.grade}
                </span>
              )}
            </div>
            <p className="mt-2 text-3xl font-black tracking-tight">{activeRec.replace('_', ' ')}</p>
          </div>
          <div className="mt-4 flex items-center justify-between">
            <span className="font-mono text-sm font-black opacity-90">
              Score: <span className={
                activeConfidence >= 90 ? 'text-emerald-600' :
                activeConfidence >= 80 ? 'text-emerald-500' :
                activeConfidence >= 70 ? 'text-blue-500' :
                'text-slate-500'
              }>{activeConfidence ? `${Math.round(activeConfidence)}` : 'n/a'}</span> / 100
            </span>
            {activeConfidence > 0 && (
              <div className="w-24 bg-slate-200/50 h-1.5 rounded-full overflow-hidden border border-slate-100">
                <div 
                  className={`h-full rounded-full ${
                    activeConfidence >= 80 ? 'bg-emerald-500' :
                    activeConfidence >= 70 ? 'bg-blue-500' :
                    'bg-slate-400'
                  }`}
                  style={{ width: `${activeConfidence}%` }}
                />
              </div>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-amber-200 bg-amber-50/40 p-5 flex flex-col justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.24em] text-amber-700">Suggested Lot Size</p>
            <p className="mt-2 font-mono text-3xl font-black text-amber-900">{activeLotSize !== null ? activeLotSize : 'n/a'}</p>
          </div>
          <div className="mt-4 flex items-center gap-1.5 text-xs text-amber-800">
            <span className="rounded bg-amber-100 px-1 py-0.5 font-mono text-[9px] font-bold">
              {activeRiskPercent !== null ? `${activeRiskPercent}% RISK` : 'RISK PLAN'}
            </span>
            <span>{isSystem ? 'From backend risk plan' : 'From AI sizing'}</span>
            {activeLotSize && <CopyButton value={activeLotSize} label="Lot Size" />}
          </div>
        </div>
      </div>

      {/* News Risk (both modes) */}
      {system?.newsRisk && (system.newsRisk.block || system.newsRisk.caution) && (
        <div className={`rounded-2xl border p-4 flex items-start gap-3 ${system.newsRisk.block ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'}`}>
          <div className={`rounded-xl p-2.5 ${system.newsRisk.block ? 'bg-red-100 text-red-600' : 'bg-amber-100 text-amber-600'}`}>
            <ShieldAlert size={18} />
          </div>
          <div className="min-w-0">
            <p className={`text-[10px] font-black uppercase tracking-[0.2em] ${system.newsRisk.block ? 'text-red-600' : 'text-amber-700'}`}>
              {system.newsRisk.block ? 'News Block — No Trade' : 'News Caution'}
            </p>
            <p className="mt-0.5 text-sm font-bold text-slate-800">{system.newsRisk.reason || 'High-impact event nearby'}</p>
            {system.newsRisk.event && (
              <p className="text-[11px] font-semibold text-slate-500">
                {system.newsRisk.event.currency} · {system.newsRisk.event.impact} · {new Date(system.newsRisk.event.timeIso).toLocaleString()}
              </p>
            )}
          </div>
        </div>
      )}

      {isSystem && system?.datFramework && (
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">DAT / SMC Quality Gate</p>
              <p className="mt-1 text-sm font-black text-slate-800">{system.strategyType || 'SYSTEM_CONFLUENCE'} · {system.datFramework.score}/3 passed</p>
            </div>
            {system.riskPlan && (
              <div className="text-right text-xs font-bold text-slate-500">
                <div>Risk {system.riskPlan.riskPercent}% · SL {system.riskPlan.stopPips ?? 'n/a'} pips</div>
                <div>Suggested lot {system.riskPlan.suggestedLotSize ?? 'n/a'}</div>
              </div>
            )}
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            {(['direction', 'area', 'trigger'] as const).map((key) => {
              const item = system.datFramework?.[key];
              return (
                <div key={key} className={`rounded-xl border p-3 ${item?.pass ? 'border-emerald-100 bg-emerald-50 text-emerald-800' : 'border-red-100 bg-red-50 text-red-800'}`}>
                  <p className="text-[10px] font-black uppercase tracking-[0.16em]">{key}</p>
                  <p className="mt-1 text-xs font-bold">{item?.pass ? 'PASS' : 'WAIT'} · {'pattern' in (item || {}) ? (system.datFramework.trigger.pattern || 'structure') : ''}</p>
                  <p className="mt-1 text-[11px] font-semibold opacity-80">{item?.reason}</p>
                </div>
              );
            })}
          </div>
          {system.sessionContext && (
            <p className="mt-3 text-xs font-semibold text-slate-500">Session: {system.sessionContext.reason}</p>
          )}
        </div>
      )}

      {isSystem && system?.riskPlan && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50/50 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-amber-700">Position Plan</p>
              <p className="mt-1 text-sm font-black text-slate-800">
                Risk {system.riskPlan.riskPercent}% · Multiplier {system.riskPlan.multiplier || `${system.riskPlan.leverage || 'n/a'}x`}
              </p>
            </div>
            <div className="text-right">
              <p className="text-lg font-black text-amber-900">{system.riskPlan.suggestedLotSize ?? 'n/a'} lots</p>
              <p className="text-[11px] font-bold text-amber-700">suggested size</p>
            </div>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-4">
            <div className="rounded-xl bg-white/80 p-3 border border-amber-100"><p className="text-[10px] font-black uppercase text-slate-400">Amount To Risk</p><p className="font-mono text-sm font-black text-red-600">{money(system.riskPlan.amountToRisk ?? system.riskPlan.riskAmount)}</p></div>
            <div className="rounded-xl bg-white/80 p-3 border border-amber-100"><p className="text-[10px] font-black uppercase text-slate-400">Margin Needed</p><p className="font-mono text-sm font-black text-slate-800">{money(system.riskPlan.marginRequired ?? system.riskPlan.amountToInvestApprox)}</p></div>
            <div className="rounded-xl bg-white/80 p-3 border border-amber-100"><p className="text-[10px] font-black uppercase text-slate-400">Loss At SL</p><p className="font-mono text-sm font-black text-red-600">{signedLoss(system.riskPlan.lossAtStop ?? system.riskPlan.maxLoss)}</p></div>
            <div className="rounded-xl bg-white/80 p-3 border border-amber-100"><p className="text-[10px] font-black uppercase text-slate-400">Stop Distance</p><p className="font-mono text-sm font-black text-slate-800">{system.riskPlan.stopPips ?? 'n/a'} pips</p></div>
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <div className="rounded-xl bg-emerald-50 p-3 border border-emerald-100"><p className="text-[10px] font-black uppercase text-emerald-500">TP1 Profit</p><p className="font-mono text-sm font-black text-emerald-700">{money(system.riskPlan.profitAtTp1)}</p></div>
            <div className="rounded-xl bg-emerald-50 p-3 border border-emerald-100"><p className="text-[10px] font-black uppercase text-emerald-500">TP2 Profit</p><p className="font-mono text-sm font-black text-emerald-700">{money(system.riskPlan.profitAtTp2)}</p></div>
            <div className="rounded-xl bg-emerald-50 p-3 border border-emerald-100"><p className="text-[10px] font-black uppercase text-emerald-500">TP3 Profit</p><p className="font-mono text-sm font-black text-emerald-700">{money(system.riskPlan.profitAtTp3)}</p></div>
          </div>
        </div>
      )}

      {/* System Entry Timing */}
      {isSystem && (!activeIsHold || (activeConfidence >= 65 && system?.entryPrice !== null)) && system?.timingTip && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 flex items-center gap-3">
            <div className="rounded-xl bg-indigo-50 p-2.5 text-indigo-600"><Zap size={18} /></div>
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Entry Trigger</p>
              <p className="font-extrabold text-slate-800 mt-0.5 text-sm uppercase tracking-wider">
                {(system.entryTrigger || 'IMMEDIATE').replace(/_/g, ' ')}
              </p>
            </div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-4 flex items-center gap-3">
            <div className="rounded-xl bg-violet-50 p-2.5 text-violet-600"><Clock size={18} /></div>
            <div className="min-w-0">
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Timing</p>
              <p className="font-bold text-slate-700 mt-0.5 text-xs">{system.timingTip}</p>
            </div>
          </div>
        </div>
      )}

      {/* Entry Trigger & Predicted Timing */}
      {(!activeIsHold || (activeConfidence >= 65 && activeEntryPrice !== null)) && (!isSystem && (decision?.trade_trigger || decision?.predicted_time)) && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 flex items-center gap-3">
            <div className="rounded-xl bg-indigo-50 p-2.5 text-indigo-600">
              <Zap size={18} />
            </div>
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Entry Trigger Direction</p>
              <p className="font-extrabold text-slate-800 mt-0.5 text-sm uppercase tracking-wider">
                {decision?.trade_trigger ? decision.trade_trigger.replace('_', ' ') : 'Immediate'}
              </p>
            </div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-4 flex items-center gap-3">
            <div className="rounded-xl bg-violet-50 p-2.5 text-violet-600">
              <Clock size={18} />
            </div>
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Predicted Start Time</p>
              <p className="font-extrabold text-slate-800 mt-0.5 text-sm">
                {decision?.predicted_time || 'Immediate'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Execution Parameter Grid */}
      {(!activeIsHold || (activeConfidence >= 65 && activeEntryPrice !== null)) && (
        <div className="space-y-3">
          <p className="text-xs font-black uppercase tracking-[0.2em] text-slate-500 font-bold">Order Parameters</p>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 flex flex-col justify-between gap-1">
              <span className="text-slate-400 text-xs font-bold">Entry Price</span>
              <div className="flex items-center justify-between gap-2 mt-1">
                <span className="font-mono text-lg font-black text-slate-900">{price(activeEntryPrice)}</span>
                <CopyButton value={activeEntryPrice} label="Entry Price" />
              </div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4 flex flex-col justify-between gap-1">
              <span className="text-slate-400 text-xs font-bold">Risk:Reward</span>
              <div className="mt-1 flex items-center justify-between">
                <span className="font-mono text-lg font-black text-slate-900">{activeRR ?? 'n/a'}</span>
                <span className="text-[10px] font-bold text-slate-400">Target RR</span>
              </div>
            </div>
            <div className="col-span-2 rounded-2xl border border-slate-200 bg-white p-4 flex flex-col justify-between gap-1">
              <span className="text-slate-400 text-xs font-bold">Stop Loss</span>
              <div className="flex items-center justify-between gap-2 mt-1">
                <span className="font-mono text-lg font-black text-red-600">{price(activeSL)}</span>
                <CopyButton value={activeSL} label="Stop Loss" />
              </div>
              {slTipToShow && (
                <p className="mt-2 text-[11px] font-semibold text-slate-500 bg-slate-50 p-2 rounded-lg border border-slate-100 flex items-start gap-1">
                  <span>💡</span>
                  <span>{slTipToShow}</span>
                </p>
              )}
            </div>

            {/* Take Profit Targets */}
            <div className="col-span-2 rounded-2xl border border-slate-200 bg-white p-4 space-y-2">
              <span className="text-slate-400 text-xs font-bold">Take Profit Targets</span>
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-xl border border-slate-100 bg-slate-50 p-2 flex flex-col justify-between">
                  <span className="text-[10px] text-slate-400 font-bold">TP1 Target</span>
                  <div className="flex items-center justify-between mt-1">
                    <span className="font-mono text-sm font-black text-emerald-600">{price(activeTP1)}</span>
                    <CopyButton value={activeTP1} label="TP1" />
                  </div>
                </div>
                <div className="rounded-xl border border-slate-100 bg-slate-50 p-2 flex flex-col justify-between">
                  <span className="text-[10px] text-slate-400 font-bold">TP2 Target</span>
                  <div className="flex items-center justify-between mt-1">
                    <span className="font-mono text-sm font-black text-emerald-600">{price(activeTP2)}</span>
                    <CopyButton value={activeTP2} label="TP2" />
                  </div>
                </div>
                <div className="rounded-xl border border-slate-100 bg-slate-50 p-2 flex flex-col justify-between">
                  <span className="text-[10px] text-slate-400 font-bold">TP3 Target</span>
                  <div className="flex items-center justify-between mt-1">
                    <span className="font-mono text-sm font-black text-emerald-600">{price(activeTP3)}</span>
                    <CopyButton value={activeTP3} label="TP3" />
                  </div>
                </div>
              </div>
              {tpTipToShow && (
                <p className="mt-1 text-[11px] font-semibold text-slate-500 bg-slate-50 p-2 rounded-lg border border-slate-100 flex items-start gap-1">
                  <span>💡</span>
                  <span>{tpTipToShow}</span>
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* HOLD-state placeholder so Entry / SL / TP are still discoverable */}
      {activeIsHold && (activeConfidence < 65 || activeEntryPrice === null) && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-black uppercase tracking-[0.2em] text-slate-500">Order Parameters</p>
            <span className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-100 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-slate-500">
              No active trade
            </span>
          </div>
          <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-4">
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              {[
                { label: 'Entry', color: 'text-slate-400' },
                { label: 'Stop Loss', color: 'text-red-300' },
                { label: 'TP1', color: 'text-emerald-300' },
                { label: 'TP2 / TP3', color: 'text-emerald-300' },
              ].map((f) => (
                <div key={f.label} className="rounded-xl border border-slate-200 bg-white p-3">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{f.label}</span>
                  <p className={`mt-1 font-mono text-lg font-black ${f.color}`}>—</p>
                </div>
              ))}
            </div>
            <p className="mt-3 flex items-start gap-1.5 text-[11px] font-semibold text-slate-500">
              <span>💡</span>
              <span>
                Entry, Stop Loss and Take Profit levels appear here automatically once a BUY or SELL
                setup forms. Current read is <strong>HOLD</strong> (score {activeConfidence ? Math.round(activeConfidence) : 0}/100) —
                press <strong>{isSystem ? 'Scan Setup' : 'Ask AI'}</strong> after the next candle close to re-check.
              </span>
            </p>
          </div>
        </div>
      )}

      {/* Execution Directions */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3">
        <div className="flex items-center gap-2 text-slate-700">
          <HelpCircle size={16} />
          <h3 className="text-sm font-black uppercase tracking-[0.16em]">Execution Guide</h3>
        </div>
        
        {activeIsHold && (activeConfidence < 65 || activeEntryPrice === null) ? (
          <div className="text-xs text-slate-500 leading-relaxed font-semibold">
            No active trade setup is recommended at this moment. The Multi-Timeframe signals (Bias vs. Entry) are conflicted or range-bound. Hold cash and check back on the next candle closure.
          </div>
        ) : (
          <ul className="text-xs text-slate-600 space-y-2.5 list-decimal pl-4 font-semibold">
            <li>
              Open MetaTrader 5, select the asset <strong>{decision?.symbol || 'XAUUSD'}</strong>.
            </li>
            <li>
              Set the order type to <strong>{isSystem ? (activeIsBuy ? 'BUY' : 'SELL') : (decision?.trade_trigger === 'IMMEDIATE' ? (activeIsBuy ? 'BUY' : 'SELL') : (decision?.trade_trigger ? decision.trade_trigger.replace('_', ' ') : (activeIsBuy ? 'BUY LIMIT' : 'SELL LIMIT')))}</strong>.
            </li>
            <li>
              Copy and input the backend suggested lot size of <strong>{activeLotSize ?? 'n/a'}</strong>
              {activeRiskPercent !== null ? <> for <strong>{activeRiskPercent}%</strong> risk</> : null}
              {activeRiskAmount !== null ? <> ({money(activeRiskAmount)} planned risk)</> : null}.
            </li>
            <li>
              Set the price to <strong>{price(activeEntryPrice)}</strong>, the Stop Loss (SL) to <strong>{price(activeSL)}</strong>, and the Take Profit (TP) to <strong>{price(activeTP1)}</strong>.
            </li>
            <li>
              Click <strong>Place Order</strong>. (Scale out using TP2 and TP3 limits at <strong>{price(activeTP2)}</strong> and <strong>{price(activeTP3)}</strong>).
            </li>
          </ul>
        )}
      </div>

      {/* Risk and Rationale Dashboard */}
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex items-center gap-2 text-slate-400">
            <ShieldAlert size={16} />
            <span className="text-xs font-bold uppercase tracking-[0.2em]">Risk Profile</span>
          </div>
          <p className="mt-2 text-lg font-bold text-slate-900">
            {decision?.risk_level || (system?.adrExhausted ? 'HIGH' : 'MEDIUM')} RISK
          </p>
          <p className="mt-1 text-slate-500 text-xs font-semibold">
            {isSystem && riskPlan
              ? `Risk size uses the backend plan: ${riskPlan.riskPercent}% risk, ${riskPlan.maxRiskPercent}% max risk, ${riskPlan.multiplier || `${riskPlan.leverage || 'n/a'}x`} multiplier.`
              : 'Use the suggested lot size from the latest advisor output.'}
          </p>
        </div>

        {isSystem ? (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 space-y-3 md:col-span-2">
            <div className="flex items-center gap-2 text-slate-500">
              <Layers size={16} />
              <span className="text-xs font-bold uppercase tracking-[0.2em]">System Quant Rationale</span>
            </div>
            
            {/* Confluences Points Breakdown */}
            {system?.confluences && system.confluences.length > 0 && (
              <div className="space-y-2 bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
                <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2 border-b border-slate-100 pb-2">
                  Institutional Confluence Breakdown ({system.buyScore} Buy / {system.sellScore} Sell)
                </span>
                <div className="grid grid-cols-1 gap-1.5 max-h-48 overflow-y-auto pr-1">
                  {system.confluences.map((c: any, idx: number) => (
                    <div key={idx} className="flex items-center justify-between text-xs font-semibold text-slate-700 py-1.5 border-b border-dashed border-slate-100 last:border-0">
                      <span className="flex items-center gap-1.5">
                        <span className={
                          c.type === 'bullish' ? 'text-emerald-600 font-black' : 
                          c.type === 'bearish' ? 'text-red-600 font-black' : 'text-slate-400 font-black'
                        }>
                          {c.type === 'bullish' ? '✓' : c.type === 'bearish' ? '✗' : '•'}
                        </span>
                        <span className="text-slate-800">{c.name}</span>
                        <span className="text-[10px] text-slate-400 font-normal">({c.reason})</span>
                      </span>
                      <span className={`font-mono font-black text-xs ${
                        c.type === 'bullish' ? 'text-emerald-600' : 
                        c.type === 'bearish' ? 'text-red-600' : 'text-slate-500'
                      }`}>
                        +{c.points}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ADR Usage */}
            {system && (
              <div className="space-y-1 bg-white p-3 rounded-xl border border-slate-200">
                <div className="flex justify-between text-xs font-bold">
                  <span className="text-slate-600">Daily Range Usage (ADR):</span>
                  <span className={`font-mono font-black ${system.adrExhausted ? 'text-red-600 animate-pulse' : 'text-slate-700'}`}>
                    {system.adrUsagePercent > 0 ? `${system.adrUsagePercent.toFixed(1)}%` : 'n/a'}
                  </span>
                </div>
                {system.adrUsagePercent > 0 && (
                  <div className="w-full bg-slate-200 h-2 rounded-full overflow-hidden">
                    <div 
                      className={`h-full rounded-full transition-all duration-500 ${system.adrExhausted ? 'bg-red-500' : 'bg-amber-500'}`}
                      style={{ width: `${Math.min(100, system.adrUsagePercent)}%` }}
                    />
                  </div>
                )}
                {system.adrExhausted && (
                  <p className="text-[10px] font-black text-red-600 uppercase tracking-wider">
                    ⚠️ ADR EXHAUSTED! HIGH EXHAUSTION RISK. BREAKOUTS BLOCKED.
                  </p>
                )}
              </div>
            )}

            {/* Order Blocks */}
            <div className="space-y-1.5">
              <span className="text-[11px] font-bold text-slate-400 block uppercase tracking-wider">Mapped Institutional Order Blocks</span>
              {system?.orderBlocks && system.orderBlocks.length > 0 ? (
                <div className="grid grid-cols-1 gap-1.5 max-h-24 overflow-y-auto pr-1">
                  {system.orderBlocks.map((ob, idx) => (
                    <div key={idx} className={`flex items-center justify-between text-[11px] font-semibold p-2 rounded-lg border bg-white ${ob.type === 'BULLISH' ? 'border-emerald-100 text-emerald-800' : 'border-red-100 text-red-800'}`}>
                      <span className="flex items-center gap-1">
                        <span className={`w-2 h-2 rounded-full ${ob.type === 'BULLISH' ? 'bg-emerald-500' : 'bg-red-500'}`}></span>
                        {ob.type} OB
                      </span>
                      <span className="font-mono">{ob.bottom.toFixed(5)} - {ob.top.toFixed(5)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[10px] text-slate-400 italic">No structure order blocks mapped in last 200 bars.</p>
              )}
            </div>

            {/* Fair Value Gaps */}
            <div className="space-y-1.5">
              <span className="text-[11px] font-bold text-slate-400 block uppercase tracking-wider">Active Imbalances (FVG)</span>
              {system?.fvgs && system.fvgs.length > 0 ? (
                <div className="grid grid-cols-1 gap-1.5 max-h-24 overflow-y-auto pr-1">
                  {system.fvgs.map((fvg, idx) => (
                    <div key={idx} className={`flex items-center justify-between text-[11px] font-semibold p-2 rounded-lg border bg-white ${fvg.type === 'BULLISH' ? 'border-emerald-100 text-emerald-800' : 'border-red-100 text-red-800'}`}>
                      <span className="flex items-center gap-1">
                        <span className={`w-2 h-2 rounded-full ${fvg.type === 'BULLISH' ? 'bg-emerald-500' : 'bg-red-500'}`}></span>
                        {fvg.type} FVG
                      </span>
                      <span className="font-mono">Mid: {fvg.midpoint.toFixed(5)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[10px] text-slate-400 italic">No open imbalances / FVGs detected.</p>
              )}
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center gap-2 text-slate-400">
              <Target size={16} />
              <span className="text-xs font-bold uppercase tracking-[0.2em]">AI Rationale</span>
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-700 font-semibold">
              {decision?.reasoning || 'Run AI analysis after MT5 sends candles and indicators.'}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
