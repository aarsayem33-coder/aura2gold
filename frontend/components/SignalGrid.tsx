import React from 'react';
import type { IndicatorValue } from '../types';

interface SignalGridProps {
  indicators: IndicatorValue[];
  symbol: string;
  timeframe: string;
}

function format(value?: number | null) {
  if (value === null || value === undefined) return 'n/a';
  return Math.abs(value) > 100 ? value.toFixed(2) : value.toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
}

export default function SignalGrid({ indicators, symbol, timeframe }: SignalGridProps) {
  const latest = new Map<string, IndicatorValue>();
  for (const indicator of indicators) {
    if (indicator.symbol !== symbol || indicator.timeframe !== timeframe) continue;
    if (!latest.has(indicator.indicator)) latest.set(indicator.indicator, indicator);
  }

  const rows = [...latest.values()].sort((a, b) => a.indicator.localeCompare(b.indicator));

  return (
    <section className="light-card rounded-3xl p-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.28em] text-slate-500">Indicator Matrix</p>
          <h3 className="mt-1 text-xl font-black text-slate-900">{symbol || 'Symbol'} {timeframe || 'TF'}</h3>
        </div>
        <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-bold text-amber-700">{rows.length} live</span>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map((indicator) => (
          <div key={indicator.id} className="rounded-2xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-black uppercase tracking-[0.2em] text-amber-600">{indicator.indicator}</p>
            <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-sm text-slate-600">
              <span>v1 {format(indicator.value1)}</span>
              <span>v2 {format(indicator.value2)}</span>
              <span>v3 {format(indicator.value3)}</span>
              <span>v4 {format(indicator.value4)}</span>
            </div>
          </div>
        ))}
      </div>
      {!rows.length && <p className="mt-5 rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm font-semibold text-slate-500">Waiting for MT5 indicator data.</p>}
    </section>
  );
}
