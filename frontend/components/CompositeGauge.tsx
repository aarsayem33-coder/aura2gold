import React from 'react';

interface CompositeGaugeProps {
  score?: number | null;
}

export default function CompositeGauge({ score }: CompositeGaugeProps) {
  const safeScore = Math.max(-1, Math.min(1, Number(score || 0)));
  const percent = ((safeScore + 1) / 2) * 100;

  return (
    <div className="light-card rounded-2xl p-5">
      <div className="flex items-center justify-between text-xs font-bold uppercase tracking-[0.24em] text-slate-500">
        <span>Sell</span>
        <span>Hold</span>
        <span>Buy</span>
      </div>
      <div className="relative mt-4 h-3 rounded-full bg-gradient-to-r from-red-500 via-amber-400 to-emerald-500">
        <div className="absolute top-1/2 h-6 w-6 -translate-y-1/2 rounded-full border-4 border-slate-950 bg-white shadow-xl" style={{ left: `calc(${percent}% - 12px)` }} />
      </div>
      <div className="mt-4 flex items-end justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Composite</p>
          <p className="font-mono text-3xl font-black text-slate-900">{safeScore.toFixed(2)}</p>
        </div>
        <p className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-bold text-amber-700">
          {safeScore >= 0.3 ? 'Bullish' : safeScore <= -0.3 ? 'Bearish' : 'Neutral'}
        </p>
      </div>
    </div>
  );
}
