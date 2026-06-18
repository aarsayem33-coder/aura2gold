import React, { useState } from 'react';
import { Server, ShieldCheck, Wifi, Cpu, HardDrive, RefreshCw, Activity, Copy } from 'lucide-react';
import { postMt5Heartbeat, useMt5Stream } from '../mt5Api';
import { formatBdDateTime } from '../utils/time';

const samplePayload = {
  account: '8923410',
  broker: 'Aura Prime Markets',
  terminal: 'MetaTrader 5',
  balance: 10000,
  equity: 10084.5,
  freeMargin: 9320.1,
  profit: 84.5,
  currency: 'USD',
  candles: [
    { symbol: 'XAUUSD', timeframe: 'M15', time: new Date().toISOString(), open: 2050.1, high: 2054.2, low: 2049.7, close: 2052.8, volume: 1234 },
  ],
  trades: [
    { ticket: '123456', symbol: 'XAUUSD', type: 'buy', volume: 0.1, openPrice: 2050.25, currentPrice: 2052.8, sl: 2045, tp: 2060, profit: 28.4, status: 'open' },
  ],
  signals: [
    { symbol: 'XAUUSD', timeframe: 'M15', type: 'Bullish Candle', direction: 'buy', price: 2052.8, rule: 'Gold Breakout', message: 'XAUUSD M15 bullish candle signal' },
  ],
};

export default function MT5Connection() {
  const { status, signals, refresh } = useMt5Stream();
  const [testing, setTesting] = useState(false);
  const latestSignal = signals[0];
  const connectionTitle = status.connected ? 'Connected & Receiving' : 'Waiting for Exness EA';
  const heartbeatLabel = status.connected ? 'Last EA heartbeat' : 'Last cached heartbeat';

  const testConnection = async () => {
    setTesting(true);
    try {
      await postMt5Heartbeat({ manualTest: true, terminal: 'Manual dashboard test', version: 'local' });
      await refresh();
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h2 className="text-2xl font-bold text-slate-900 tracking-tight">MT5 Connection Status</h2>
        <p className="text-slate-500 text-sm mt-1 font-medium">Monitor the live connection between MT5 Expert Advisor WebRequest and this dashboard</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className={`bg-white rounded-2xl border shadow-card p-6 relative overflow-hidden ${status.connected ? 'border-emerald-100' : 'border-amber-100'}`}>
          <div className={`absolute top-0 left-0 w-full h-1 ${status.connected ? 'bg-emerald-500' : 'bg-amber-500'}`}></div>
          <div className="flex items-center gap-4 mb-6 mt-2">
            <div className={`w-16 h-16 rounded-2xl flex items-center justify-center border shadow-sm ${status.connected ? 'bg-emerald-50 border-emerald-100' : 'bg-amber-50 border-amber-100'}`}>
              <Server size={32} className={status.connected ? 'text-emerald-600' : 'text-amber-600'} />
            </div>
            <div>
              <h3 className="text-xl font-bold text-slate-900">{connectionTitle}</h3>
              <p className="text-sm text-slate-500 font-medium">{heartbeatLabel}: {formatBdDateTime(status.lastHeartbeatAt, 'Never')}</p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex justify-between items-center py-3 border-b border-slate-100">
              <span className="text-slate-500 text-sm font-medium">Connection Type</span>
              <span className="text-slate-900 font-bold text-sm">MT5 WebRequest POST</span>
            </div>
            <div className="flex justify-between items-center py-3 border-b border-slate-100">
              <span className="text-slate-500 text-sm font-medium">{status.connected ? 'MT5 Account' : 'Cached Account'}</span>
              <span className="text-slate-900 font-bold text-sm">{status.account || 'Not reported yet'}</span>
            </div>
            <div className="flex justify-between items-center py-3 border-b border-slate-100">
              <span className="text-slate-500 text-sm font-medium">{status.connected ? 'Broker' : 'Cached Broker'}</span>
              <span className="text-slate-900 font-bold text-sm">{status.broker || 'Not reported yet'}</span>
            </div>
            <div className="flex justify-between items-center py-3 border-b border-slate-100">
              <span className="text-slate-500 text-sm font-medium">Signals Received</span>
              <span className="text-slate-900 font-bold text-sm">{status.signalCount}</span>
            </div>
            <div className="flex justify-between items-center py-3">
              <span className="text-slate-500 text-sm font-medium">Last Signal</span>
              <span className="text-slate-900 font-bold text-sm">{formatBdDateTime(status.lastSignalAt, 'Never')}</span>
            </div>
          </div>

          <button onClick={testConnection} disabled={testing} className="w-full mt-6 flex items-center justify-center gap-2 py-3 rounded-xl border border-slate-200 text-slate-700 font-semibold hover:bg-slate-50 hover:border-slate-300 transition-all shadow-sm disabled:opacity-60">
            <RefreshCw size={18} className={testing ? 'animate-spin' : ''} /> {testing ? 'Testing...' : 'Test API Receiver'}
          </button>
          <p className="mt-3 text-xs font-medium text-slate-500">This test only checks the local API. It does not mark MT5 as connected.</p>
        </div>

        <div className="space-y-6">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-card p-6">
            <h4 className="text-sm font-bold text-slate-800 mb-5 flex items-center gap-2 uppercase tracking-wider">
              <ShieldCheck size={18} className="text-gold-500" /> WebRequest Setup
            </h4>
            <div className="space-y-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">Full Snapshot URL</p>
                <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                  <code className="flex-1 text-xs text-slate-700 break-all">http://127.0.0.1:5000/api/mt5/snapshot</code>
                  <Copy size={16} className="text-slate-400" />
                </div>
              </div>
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">Candles URL</p>
                <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                  <code className="flex-1 text-xs text-slate-700 break-all">http://127.0.0.1:5000/api/mt5/candles</code>
                  <Copy size={16} className="text-slate-400" />
                </div>
              </div>
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">Trades URL</p>
                <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                  <code className="flex-1 text-xs text-slate-700 break-all">http://127.0.0.1:5000/api/mt5/trades</code>
                  <Copy size={16} className="text-slate-400" />
                </div>
              </div>
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">Heartbeat URL</p>
                <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                  <code className="flex-1 text-xs text-slate-700 break-all">http://127.0.0.1:5000/api/mt5/heartbeat</code>
                  <Copy size={16} className="text-slate-400" />
                </div>
              </div>
              <p className="text-sm text-slate-600 font-medium">In MT5, add <span className="font-mono">http://127.0.0.1:5000</span> under Tools, Options, Expert Advisors, Allow WebRequest.</p>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 shadow-card p-6">
            <h4 className="text-sm font-bold text-slate-800 mb-5 flex items-center gap-2 uppercase tracking-wider">
              <Activity size={18} className="text-blue-500" /> Latest Signal
            </h4>
            {latestSignal ? (
              <div className="space-y-3 text-sm">
                <div className="flex justify-between"><span className="text-slate-500">Symbol</span><span className="font-bold text-slate-900">{latestSignal.symbol}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Type</span><span className="font-bold text-slate-900">{latestSignal.type}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Price</span><span className="font-bold text-gold-600">{latestSignal.price?.toFixed(2)}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Delivery</span><span className="font-bold text-slate-900">{latestSignal.status}</span></div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-slate-50 p-4 rounded-xl border border-slate-100">
                  <Cpu size={20} className="text-slate-400 mb-2" />
                  <p className="text-2xl font-bold text-slate-900">0</p>
                  <p className="text-xs text-slate-500 font-medium mt-1">Signals</p>
                </div>
                <div className="bg-slate-50 p-4 rounded-xl border border-slate-100">
                  <HardDrive size={20} className="text-slate-400 mb-2" />
                  <p className="text-2xl font-bold text-slate-900">Idle</p>
                  <p className="text-xs text-slate-500 font-medium mt-1">Receiver</p>
                </div>
                <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 col-span-2 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-white rounded-lg shadow-sm border border-slate-100">
                      <Wifi size={18} className="text-slate-400" />
                    </div>
                    <p className="text-sm font-semibold text-slate-600">Waiting for first WebRequest</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-card overflow-x-auto">
        <p className="text-xs font-bold uppercase tracking-wider text-amber-600 mb-3">Example JSON payload</p>
        <pre className="text-xs text-slate-700">{JSON.stringify(samplePayload, null, 2)}</pre>
      </div>
    </div>
  );
}
