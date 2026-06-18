import React from 'react';
import { Activity, ArrowUpRight, ArrowDownRight, Minus, Mail, Radio } from 'lucide-react';
import { useMt5Stream } from '../mt5Api';
import type { Alert } from '../types';
import { formatBdDateTime } from '../utils/time';

function formatNumber(value?: number | null) {
  return value === null || value === undefined ? 'n/a' : value.toFixed(2);
}

function DirectionIcon({ signal }: { signal: Alert }) {
  if (signal.direction === 'up') return <ArrowUpRight size={18} className="text-emerald-500" />;
  if (signal.direction === 'down') return <ArrowDownRight size={18} className="text-red-500" />;
  return <Minus size={18} className="text-slate-400" />;
}

export default function AlertFeed() {
  const { signals, status, error } = useMt5Stream();

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:justify-between sm:items-center">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 tracking-tight">Live Alert Feed</h2>
          <p className="text-slate-500 text-sm mt-1 font-medium">Real-time signal stream from MT5 Expert Advisor WebRequest</p>
        </div>
        <div className={`flex items-center gap-2 px-4 py-2 rounded-full border shadow-sm ${status.connected ? 'bg-emerald-50 border-emerald-100' : 'bg-amber-50 border-amber-100'}`}>
          <div className={`w-2 h-2 rounded-full ${status.connected ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`}></div>
          <span className={`text-sm font-semibold ${status.connected ? 'text-emerald-700' : 'text-amber-700'}`}>
            {status.connected ? 'MT5 connected' : 'Waiting for MT5 signal'}
          </span>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
          {error}
        </div>
      )}

      <div className="bg-white rounded-2xl border border-slate-200 shadow-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[1100px]">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 text-xs uppercase tracking-wider">
                <th className="p-4 font-semibold">Received</th>
                <th className="p-4 font-semibold">Symbol</th>
                <th className="p-4 font-semibold">TF</th>
                <th className="p-4 font-semibold">Signal</th>
                <th className="p-4 font-semibold">Price</th>
                <th className="p-4 font-semibold">Bid / Ask</th>
                <th className="p-4 font-semibold">Account</th>
                <th className="p-4 font-semibold">Broker</th>
                <th className="p-4 font-semibold">Delivery</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {signals.map((signal) => (
                <React.Fragment key={signal.id}>
                  <tr className="hover:bg-slate-50/80 transition-colors align-top">
                    <td className="p-4 text-xs font-medium text-slate-500 whitespace-nowrap">
                      <div>{formatBdDateTime(signal.receivedAt || signal.timestamp)}</div>
                      <div className="font-mono text-slate-400 mt-1">{signal.id}</div>
                    </td>
                    <td className="p-4 font-bold text-slate-900">{signal.symbol}</td>
                    <td className="p-4">
                      <span className="px-2.5 py-1 rounded-md text-xs font-bold bg-slate-100 border border-slate-200 text-slate-600">
                        {signal.timeframe}
                      </span>
                    </td>
                    <td className="p-4">
                      <div className="flex items-center gap-2">
                        <DirectionIcon signal={signal} />
                        <span className={`font-semibold ${signal.direction === 'up' ? 'text-emerald-600' : signal.direction === 'down' ? 'text-red-600' : 'text-slate-600'}`}>
                          {signal.type}
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 mt-1 max-w-xs">{signal.message}</p>
                    </td>
                    <td className="p-4 font-mono font-medium text-slate-700">{formatNumber(signal.price)}</td>
                    <td className="p-4 font-mono text-sm text-slate-600">{formatNumber(signal.bid)} / {formatNumber(signal.ask)}</td>
                    <td className="p-4 text-sm font-medium text-slate-600">{signal.account || 'n/a'}</td>
                    <td className="p-4 text-sm font-medium text-slate-600">{signal.broker || 'n/a'}</td>
                    <td className="p-4">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold border ${signal.status === 'Delivered' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : signal.status === 'Failed' ? 'bg-red-50 text-red-700 border-red-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
                        {signal.delivery?.channel === 'Email' && <Mail size={13} />}
                        {signal.status}
                      </span>
                    </td>
                  </tr>
                  <tr className="bg-slate-50/50">
                    <td colSpan={9} className="px-4 pb-4">
                      <details className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                        <summary className="cursor-pointer text-sm font-bold text-slate-700">Full MT5 payload details</summary>
                        <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-50 p-4 text-xs text-slate-700">{JSON.stringify(signal.raw || signal, null, 2)}</pre>
                      </details>
                    </td>
                  </tr>
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {signals.length === 0 && (
          <div className="p-12 text-center text-slate-400">
            <Activity size={48} className="mx-auto mb-4 opacity-20" />
            <p className="font-medium">No real MT5 signals received yet.</p>
            <p className="text-sm mt-2">Send a WebRequest POST to <span className="font-mono text-slate-600">/api/mt5/signals</span> to populate this feed.</p>
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-card">
          <div className="flex items-start gap-3">
          <Radio size={20} className="text-amber-500 mt-0.5" />
          <div>
            <h3 className="font-bold text-slate-900">MT5 WebRequest endpoint</h3>
            <p className="text-sm text-slate-500 mt-1">Post signals from the Expert Advisor to <span className="font-mono text-slate-700">http://127.0.0.1:5000/api/mt5/signals</span>.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
