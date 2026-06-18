import React from 'react';
import { BookOpen } from 'lucide-react';
import { useMt5Stream } from '../mt5Api';

function money(value?: number | null, currency = 'USD') {
  if (value === null || value === undefined) return 'n/a';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);
}

export default function TradeJournal() {
  const { trades, account, aiDecisions } = useMt5Stream();
  const currency = account?.currency || 'USD';

  return (
    <div className="terminal-page -m-6 min-h-screen space-y-6 p-6 lg:-m-10 lg:p-10">
      <div>
        <p className="text-xs font-black uppercase tracking-[0.32em] text-amber-600">Journal</p>
        <h1 className="mt-2 text-4xl font-black tracking-tight text-slate-900">Trade Journal</h1>
        <p className="mt-2 text-sm font-semibold text-slate-500">Auto-linked MT5 trades and recent AI context.</p>
      </div>
      <section className="light-card rounded-3xl p-6">
        <div className="mb-5 flex items-center gap-3 text-slate-900"><BookOpen className="text-amber-500" size={20} /><h2 className="text-xl font-black">MT5 Trade Log</h2></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] text-left text-sm">
            <thead className="text-xs uppercase tracking-[0.18em] text-slate-500"><tr><th className="p-3">Ticket</th><th className="p-3">Symbol</th><th className="p-3">Side</th><th className="p-3">Lots</th><th className="p-3">Entry</th><th className="p-3">Current</th><th className="p-3">SL</th><th className="p-3">TP</th><th className="p-3">P/L</th></tr></thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {trades.map((trade) => <tr key={trade.id}><td className="p-3 font-mono">{trade.ticket}</td><td className="p-3 font-bold text-slate-900">{trade.symbol}</td><td className="p-3">{trade.type}</td><td className="p-3 font-mono">{trade.volume}</td><td className="p-3 font-mono">{trade.openPrice}</td><td className="p-3 font-mono">{trade.currentPrice}</td><td className="p-3 font-mono">{trade.stopLoss}</td><td className="p-3 font-mono">{trade.takeProfit}</td><td className={`p-3 font-bold ${(trade.profit || 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{money(trade.profit, currency)}</td></tr>)}
            </tbody>
          </table>
        </div>
        {!trades.length && <p className="rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm font-semibold text-slate-500">No MT5 trades received yet.</p>}
      </section>
      <section className="light-card rounded-3xl p-6">
        <h2 className="text-xl font-black text-slate-900">Recent AI Context</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {aiDecisions.slice(0, 6).map((decision) => <div key={decision.id} className="rounded-2xl border border-slate-200 bg-white p-4"><p className="font-bold text-slate-900">{decision.symbol} {decision.timeframe}</p><p className="mt-1 text-sm text-slate-500">{decision.decision} at {Math.round(decision.confidence)}%</p></div>)}
        </div>
      </section>
    </div>
  );
}
