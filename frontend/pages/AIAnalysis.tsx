import React from 'react';
import { Brain, CheckCircle2, Clock, XCircle } from 'lucide-react';
import DecisionCard from '../components/DecisionCard';
import { useMt5Stream } from '../mt5Api';
import { formatBdDateTime } from '../utils/time';

function outcomeIcon(outcome: string) {
  if (outcome === 'WIN') return <CheckCircle2 size={16} className="text-emerald-400" />;
  if (outcome === 'LOSS') return <XCircle size={16} className="text-red-400" />;
  return <Clock size={16} className="text-slate-500" />;
}

export default function AIAnalysis() {
  const { aiDecisions, status } = useMt5Stream();
  const latest = aiDecisions[0] || status.latestAiDecision || null;
  const wins = aiDecisions.filter((decision) => decision.outcome === 'WIN').length;
  const scored = aiDecisions.filter((decision) => ['WIN', 'LOSS', 'BREAKEVEN'].includes(decision.outcome));
  const winRate = scored.length ? Math.round((wins / scored.length) * 100) : 0;

  return (
    <div className="terminal-page -m-6 min-h-screen space-y-6 p-6 lg:-m-10 lg:p-10">
      <div>
        <p className="text-xs font-black uppercase tracking-[0.32em] text-amber-600">Gemini</p>
        <h1 className="mt-2 text-4xl font-black tracking-tight text-slate-900">AI Analysis</h1>
      </div>
      <DecisionCard decision={latest} />
      <div className="grid gap-4 md:grid-cols-4">
        <div className="light-card rounded-3xl p-5"><p className="text-slate-500">Decisions</p><p className="font-mono text-3xl font-black text-slate-900">{aiDecisions.length}</p></div>
        <div className="light-card rounded-3xl p-5"><p className="text-slate-500">Win Rate</p><p className="font-mono text-3xl font-black text-slate-900">{winRate}%</p></div>
        <div className="light-card rounded-3xl p-5"><p className="text-slate-500">Pending</p><p className="font-mono text-3xl font-black text-slate-900">{aiDecisions.filter((d) => d.outcome === 'PENDING').length}</p></div>
        <div className="light-card rounded-3xl p-5"><p className="text-slate-500">Model</p><p className="font-mono text-lg font-black text-slate-900">{status.geminiModel || 'n/a'}</p></div>
      </div>
      <section className="light-card rounded-3xl p-6">
        <div className="mb-5 flex items-center gap-3 text-slate-900"><Brain className="text-amber-500" size={20} /><h2 className="text-xl font-black">Decision History</h2></div>
        <div className="space-y-3">
          {aiDecisions.map((decision) => (
            <div key={decision.id} className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">{outcomeIcon(decision.outcome)}<span className="font-bold text-slate-900">{decision.symbol} {decision.timeframe}</span><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-700">{decision.decision}</span></div>
                <span className="font-mono text-sm text-slate-400">{formatBdDateTime(decision.created_at)}</span>
              </div>
              <p className="mt-3 text-sm leading-6 text-slate-600">{decision.reasoning}</p>
            </div>
          ))}
          {!aiDecisions.length && <p className="rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm font-semibold text-slate-500">No AI decisions yet. Run analysis from the Trading Terminal.</p>}
        </div>
      </section>
    </div>
  );
}
