import React, { useState } from 'react';
import { Search, Filter, Download } from 'lucide-react';
import { exportSignalsCsv, useMt5Stream } from '../mt5Api';
import { bdDateStamp, formatBdDateParts } from '../utils/time';

export default function AlertHistory() {
  const { signals } = useMt5Stream();
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const filteredSignals = normalizedQuery
    ? signals.filter((signal) => JSON.stringify(signal).toLowerCase().includes(normalizedQuery))
    : signals;

  const downloadCsv = () => {
    const csv = exportSignalsCsv(filteredSignals);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `mt5-signals-${bdDateStamp()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 tracking-tight">Alert History</h2>
          <p className="text-slate-500 text-sm mt-1 font-medium">Complete log of real MT5 signals received by the backend</p>
        </div>
        <div className="flex gap-3 w-full sm:w-auto">
          <button className="flex items-center gap-2 px-4 py-2.5 bg-white border border-slate-200 rounded-xl text-sm font-bold text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-all shadow-sm">
            <Filter size={16} /> {filteredSignals.length} Records
          </button>
          <button onClick={downloadCsv} className="flex items-center gap-2 px-4 py-2.5 bg-white border border-slate-200 rounded-xl text-sm font-bold text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-all shadow-sm">
            <Download size={16} /> Export CSV
          </button>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-card overflow-hidden">
        <div className="p-5 border-b border-slate-100 flex gap-4 bg-slate-50/50">
          <div className="relative flex-1 max-w-md">
            <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
              <Search size={18} className="text-slate-400" />
            </div>
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="block w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-xl bg-white text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-gold-500/20 focus:border-gold-500 text-sm font-medium transition-all shadow-sm"
              placeholder="Search ID, symbol, type, broker, raw payload..."
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[900px]">
            <thead>
              <tr className="bg-white border-b border-slate-200 text-slate-500 text-xs uppercase tracking-wider">
                <th className="p-4 font-bold">Alert ID</th>
                <th className="p-4 font-bold">Date & Time</th>
                <th className="p-4 font-bold">Symbol</th>
                <th className="p-4 font-bold">TF</th>
                <th className="p-4 font-bold">Signal Type</th>
                <th className="p-4 font-bold">Price</th>
                <th className="p-4 font-bold">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredSignals.map((row) => {
                const time = formatBdDateParts(row.receivedAt || row.timestamp);
                return (
                  <tr key={row.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="p-4 text-sm font-mono font-medium text-slate-500">{row.id}</td>
                    <td className="p-4 text-sm text-slate-700">
                      <div className="font-semibold">{time.date}</div>
                      <div className="text-xs text-slate-400 font-medium mt-0.5">{time.time}</div>
                    </td>
                    <td className="p-4 text-sm font-bold text-slate-900">{row.symbol}</td>
                    <td className="p-4">
                      <span className="px-2.5 py-1 rounded-md text-xs font-bold bg-slate-100 border border-slate-200 text-slate-600">
                        {row.timeframe}
                      </span>
                    </td>
                    <td className="p-4 text-sm font-semibold text-slate-700">{row.type}</td>
                    <td className="p-4 text-sm font-mono font-bold text-gold-600">{row.price ? row.price.toFixed(2) : 'n/a'}</td>
                    <td className="p-4">
                      <span className={`px-2.5 py-1 rounded-md text-xs font-bold border ${row.status === 'Delivered' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : row.status === 'Failed' ? 'bg-red-50 text-red-700 border-red-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
                        {row.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {!filteredSignals.length && (
          <div className="p-10 text-center text-sm font-medium text-slate-400">No MT5 signal records match this view.</div>
        )}
        <div className="p-5 border-t border-slate-100 flex items-center justify-between text-sm text-slate-500 font-medium bg-slate-50/50">
          <span>Showing {filteredSignals.length} of {signals.length} received signals</span>
        </div>
      </div>
    </div>
  );
}
