import React, { useState } from 'react';
import { Plus, Save, Trash2, Edit2, ToggleLeft, ToggleRight, Target } from 'lucide-react';
import { Rule } from '../types';

const initialRules: Rule[] = [
  { id: '1', symbol: 'XAUUSD', timeframe: 'M15', type: 'Bullish Candle', channels: { mt5: true, email: false, whatsapp: true, sms: false }, active: true },
  { id: '2', symbol: 'EURUSD', timeframe: 'H1', type: 'Break Previous High', channels: { mt5: true, email: true, whatsapp: false, sms: false }, active: true },
  { id: '3', symbol: 'US30', timeframe: 'M5', type: 'Specific Price Point', targetPrice: 39050.50, channels: { mt5: true, email: false, whatsapp: true, sms: true }, active: false },
];

export default function RulesManagement() {
  const [rules, setRules] = useState<Rule[]>(initialRules);
  const [isEditing, setIsEditing] = useState(false);

  // Form state
  const [symbol, setSymbol] = useState('XAUUSD');
  const [timeframe, setTimeframe] = useState('M15');
  const [ruleType, setRuleType] = useState('Bullish Candle');
  const [targetPrice, setTargetPrice] = useState('');
  const [channels, setChannels] = useState({ mt5: true, email: false, whatsapp: false, sms: false });
  const [isActive, setIsActive] = useState(true);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    
    const newRule: Rule = {
      id: Math.random().toString(36).substr(2, 9),
      symbol,
      timeframe,
      type: ruleType,
      targetPrice: ruleType === 'Specific Price Point' && targetPrice ? parseFloat(targetPrice) : undefined,
      channels,
      active: isActive
    };

    setRules([newRule, ...rules]);
    setIsEditing(false);
    
    // Reset form
    setRuleType('Bullish Candle');
    setTargetPrice('');
  };

  const toggleRule = (id: string) => {
    setRules(rules.map(r => r.id === id ? { ...r, active: !r.active } : r));
  };

  const deleteRule = (id: string) => {
    setRules(rules.filter(r => r.id !== id));
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 tracking-tight">Alert Rules</h2>
          <p className="text-slate-500 text-sm mt-1 font-medium">Configure when and how you receive notifications</p>
        </div>
        <button 
          onClick={() => setIsEditing(true)}
          className="flex items-center gap-2 bg-gold-500 hover:bg-gold-600 text-white font-bold py-2.5 px-5 rounded-xl shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all duration-200"
        >
          <Plus size={18} /> New Rule
        </button>
      </div>

      {isEditing && (
        <div className="bg-white rounded-2xl border border-gold-200 shadow-card p-6 sm:p-8 mb-8 relative overflow-hidden">
          <div className="absolute top-0 left-0 w-1 h-full bg-gold-500"></div>
          <h3 className="text-lg font-bold text-slate-900 mb-6 border-b border-slate-100 pb-3">Create / Edit Rule</h3>
          <form onSubmit={handleSave} className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Symbol */}
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-2">Symbol</label>
                <select 
                  value={symbol} onChange={(e) => setSymbol(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-slate-900 font-medium focus:outline-none focus:ring-2 focus:ring-gold-500/20 focus:border-gold-500 focus:bg-white transition-all"
                >
                  <optgroup label="Metals">
                    <option value="XAUUSD">XAUUSD (Gold)</option>
                    <option value="XAGUSD">XAGUSD (Silver)</option>
                  </optgroup>
                  <optgroup label="Forex Majors">
                    <option value="EURUSD">EURUSD</option>
                    <option value="GBPUSD">GBPUSD</option>
                    <option value="USDJPY">USDJPY</option>
                    <option value="USDCHF">USDCHF</option>
                    <option value="USDCAD">USDCAD</option>
                    <option value="AUDUSD">AUDUSD</option>
                    <option value="NZDUSD">NZDUSD</option>
                  </optgroup>
                  <optgroup label="Forex Minors & Crosses">
                    <option value="EURGBP">EURGBP</option>
                    <option value="EURJPY">EURJPY</option>
                    <option value="GBPJPY">GBPJPY</option>
                    <option value="AUDJPY">AUDJPY</option>
                    <option value="EURAUD">EURAUD</option>
                    <option value="GBPAUD">GBPAUD</option>
                    <option value="CHFJPY">CHFJPY</option>
                  </optgroup>
                  <optgroup label="Indices">
                    <option value="US30">US30 (Dow Jones)</option>
                    <option value="NAS100">NAS100 (Nasdaq)</option>
                    <option value="SPX500">SPX500 (S&P 500)</option>
                    <option value="GER40">GER40 (DAX)</option>
                    <option value="UK100">UK100 (FTSE)</option>
                  </optgroup>
                  <optgroup label="Cryptocurrency">
                    <option value="BTCUSD">BTCUSD (Bitcoin)</option>
                    <option value="ETHUSD">ETHUSD (Ethereum)</option>
                    <option value="SOLUSD">SOLUSD (Solana)</option>
                  </optgroup>
                </select>
              </div>

              {/* Timeframe */}
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-2">Timeframe</label>
                <select 
                  value={timeframe} onChange={(e) => setTimeframe(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-slate-900 font-medium focus:outline-none focus:ring-2 focus:ring-gold-500/20 focus:border-gold-500 focus:bg-white transition-all"
                >
                  {['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'].map(tf => (
                    <option key={tf} value={tf}>{tf}</option>
                  ))}
                </select>
              </div>

              {/* Rule Type */}
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-2">Condition / Signal Type</label>
                <select 
                  value={ruleType} onChange={(e) => setRuleType(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-slate-900 font-medium focus:outline-none focus:ring-2 focus:ring-gold-500/20 focus:border-gold-500 focus:bg-white transition-all"
                >
                  <optgroup label="Price Action">
                    <option>Market Up</option>
                    <option>Market Down</option>
                    <option>Break Previous High</option>
                    <option>Break Previous Low</option>
                  </optgroup>
                  <optgroup label="Candle Patterns">
                    <option>Bullish Candle</option>
                    <option>Bearish Candle</option>
                    <option>Big Candle</option>
                    <option>Doji Pattern</option>
                    <option>Hammer Pattern</option>
                  </optgroup>
                  <optgroup label="Custom Levels">
                    <option>Specific Price Point</option>
                  </optgroup>
                </select>
              </div>

              {/* Target Price (Conditional) */}
              {ruleType === 'Specific Price Point' && (
                <div className="md:col-span-3 lg:col-span-1">
                  <label className="block text-sm font-semibold text-slate-700 mb-2 flex items-center gap-2">
                    <Target size={16} className="text-gold-500" /> Target Price
                  </label>
                  <input 
                    type="number" 
                    step="0.01"
                    value={targetPrice} 
                    onChange={(e) => setTargetPrice(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-slate-900 font-medium focus:outline-none focus:ring-2 focus:ring-gold-500/20 focus:border-gold-500 focus:bg-white transition-all"
                    placeholder="e.g. 2050.00"
                    required
                  />
                </div>
              )}
            </div>

            {/* Channels */}
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-3">Notification Channels</label>
              <div className="flex flex-wrap gap-3">
                {(Object.keys(channels) as Array<keyof typeof channels>).map((channel) => (
                  <label key={channel} className={`
                    flex items-center gap-2 px-5 py-2.5 rounded-xl border cursor-pointer transition-all duration-200 shadow-sm
                    ${channels[channel] ? 'bg-gold-50 border-gold-200 text-gold-700' : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300 hover:bg-slate-50'}
                  `}>
                    <input 
                      type="checkbox" 
                      className="hidden"
                      checked={channels[channel]}
                      onChange={() => setChannels({...channels, [channel]: !channels[channel]})}
                    />
                    <span className="uppercase text-sm font-bold tracking-wide">{channel}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between pt-6 border-t border-slate-100">
              <div className="flex items-center gap-3">
                <button type="button" onClick={() => setIsActive(!isActive)} className="text-slate-400 hover:text-slate-600 transition-colors">
                  {isActive ? <ToggleRight size={36} className="text-emerald-500" /> : <ToggleLeft size={36} />}
                </button>
                <span className="text-sm font-bold text-slate-700">{isActive ? 'Rule Active' : 'Rule Paused'}</span>
              </div>
              <div className="flex gap-3">
                <button 
                  type="button" 
                  onClick={() => setIsEditing(false)}
                  className="px-5 py-2.5 rounded-xl border border-slate-200 text-slate-600 font-semibold hover:bg-slate-50 transition-colors"
                >
                  Cancel
                </button>
                <button 
                  type="submit"
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gold-500 text-white font-bold hover:bg-gold-600 shadow-sm hover:shadow-md transition-all"
                >
                  <Save size={18} /> Save Rule
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* Rules List */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {rules.map((rule) => (
          <div key={rule.id} className={`bg-white rounded-2xl border shadow-card p-6 transition-all duration-200 hover:shadow-md ${rule.active ? 'border-slate-200' : 'border-slate-100 opacity-75 bg-slate-50/50'}`}>
            <div className="flex justify-between items-start mb-5">
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-1 rounded-md text-xs font-bold bg-slate-100 text-slate-700 border border-slate-200 shadow-sm">{rule.symbol}</span>
            <span className="px-2.5 py-1 rounded-md text-xs font-bold bg-amber-50 text-amber-700 border border-amber-100">{rule.timeframe}</span>
          </div>
              <button onClick={() => toggleRule(rule.id)} className="text-slate-400 hover:text-slate-600 transition-colors">
                {rule.active ? <ToggleRight size={28} className="text-emerald-500" /> : <ToggleLeft size={28} />}
              </button>
            </div>
            
            <h4 className="text-lg font-bold text-slate-900 mb-4 flex items-center flex-wrap gap-2">
              {rule.type}
              {rule.targetPrice && (
                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-white border border-gold-200 text-gold-600 text-sm shadow-sm">
                  <Target size={14} /> {rule.targetPrice.toFixed(2)}
                </span>
              )}
            </h4>
            
            <div className="flex flex-wrap gap-2 mb-6">
              {Object.entries(rule.channels).map(([key, val]) => val && (
                <span key={key} className="px-2.5 py-1 rounded-md text-[10px] uppercase font-bold tracking-wider bg-slate-100 text-slate-600 border border-slate-200">
                  {key}
                </span>
              ))}
            </div>

            <div className="flex justify-end gap-2 pt-4 border-t border-slate-100">
              <button className="p-2 text-slate-400 hover:text-gold-600 hover:bg-gold-50 rounded-lg transition-colors">
                <Edit2 size={18} />
              </button>
              <button 
                onClick={() => deleteRule(rule.id)}
                className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
              >
                <Trash2 size={18} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
