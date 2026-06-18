import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  BellRing,
  Brain,
  CheckCircle2,
  Clock,
  Gauge,
  Loader2,
  RefreshCcw,
  Server,
  ShieldCheck,
  Sparkles,
  Timer,
  TrendingDown,
  TrendingUp,
  Wallet,
  Wifi,
  XCircle,
} from 'lucide-react';
import Mt5CandlestickChart from '../components/Mt5CandlestickChart';
import {
  fetchCalibrationReport,
  fetchFixedEmailReports,
  fetchForexEmailReports,
  fetchMt5Candles,
  triggerAllSymbolsScan,
  triggerFttScan,
  useMt5Stream,
} from '../mt5Api';
import type { CalibrationResponse, FttScanResult, Mt5Candle, ScanResult, SignalEmailReportsResponse } from '../types';
import { APP_TIME_ZONE, formatBdTime } from '../utils/time';

type ActivityItem = {
  id: string;
  tone: 'emerald' | 'red' | 'amber' | 'blue' | 'slate' | 'purple';
  label: string;
  title: string;
  meta: string;
  time?: string | null;
};

function money(value?: number | null, currency = 'USD') {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'n/a';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(value));
}

function number(value?: number | null, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'n/a';
  return Number(value).toFixed(digits);
}

function price(value?: number | null, symbol?: string) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'n/a';
  const s = String(symbol || '').toUpperCase();
  const digits = /XAU|GOLD|XAG/.test(s) ? 2 : /JPY/.test(s) ? 3 : 5;
  return Number(value).toFixed(digits);
}

function ageMs(value?: string | null) {
  if (!value) return Number.POSITIVE_INFINITY;
  const time = Date.parse(value);
  return Number.isFinite(time) ? Date.now() - time : Number.POSITIVE_INFINITY;
}

function ageLabel(value?: string | null) {
  const ms = ageMs(value);
  if (!Number.isFinite(ms)) return 'Never';
  if (ms < 15000) return 'Just now';
  if (ms < 60000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
  return formatBdTime(value, 'Never');
}

function freshnessTone(value?: string | null, warnMs = 90000, badMs = 300000) {
  const ms = ageMs(value);
  if (!Number.isFinite(ms)) return 'border-slate-200 bg-slate-50 text-slate-500';
  if (ms <= warnMs) return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (ms <= badMs) return 'border-amber-200 bg-amber-50 text-amber-700';
  return 'border-red-200 bg-red-50 text-red-700';
}

function isToday(value?: string | null) {
  if (!value) return false;
  const date = new Date(value);
  const now = new Date();
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
  return day.format(date) === day.format(now);
}

function directionTone(direction?: string | null) {
  const d = String(direction || '').toUpperCase();
  if (d.includes('BUY') || d === 'UP' || d === 'BULLISH') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (d.includes('SELL') || d === 'DOWN' || d === 'BEARISH') return 'border-red-200 bg-red-50 text-red-700';
  return 'border-slate-200 bg-slate-50 text-slate-600';
}

function qualityTone(value?: string | null) {
  const v = String(value || '').toUpperCase();
  if (v.includes('A+') || v === 'QUALITY_SIGNAL') return 'border-emerald-700 bg-emerald-600 text-white';
  if (v.includes('A') || v === 'TRADE_SIGNAL') return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  if (v.includes('B')) return 'border-blue-200 bg-blue-50 text-blue-800';
  if (v.includes('WATCH')) return 'border-amber-200 bg-amber-50 text-amber-800';
  return 'border-slate-200 bg-slate-100 text-slate-600';
}

function toneClass(tone: ActivityItem['tone']) {
  if (tone === 'emerald') return 'bg-emerald-50 text-emerald-700 border-emerald-100';
  if (tone === 'red') return 'bg-red-50 text-red-700 border-red-100';
  if (tone === 'amber') return 'bg-amber-50 text-amber-700 border-amber-100';
  if (tone === 'blue') return 'bg-blue-50 text-blue-700 border-blue-100';
  if (tone === 'purple') return 'bg-purple-50 text-purple-700 border-purple-100';
  return 'bg-slate-50 text-slate-600 border-slate-100';
}

function reportHealth(report?: SignalEmailReportsResponse | null) {
  if (!report) return { total: 0, successRate: 0, pending: 0, netPips: 0, sample: 'No report data' };
  return {
    total: report.summary.total,
    successRate: report.summary.successRate,
    pending: report.summary.pending,
    netPips: report.summary.netPips,
    sample: `${report.summary.wins}W / ${report.summary.losses}L`,
  };
}

function bestCalibration(calibration?: CalibrationResponse | null) {
  if (!calibration) return null;
  const rows = Object.values(calibration.leaderboards || {}).flat();
  return rows
    .filter((row) => row.settled >= 3)
    .sort((a, b) => (b.winRate - a.winRate) || (b.netPips - a.netPips))[0] || null;
}

function forexScore(result: ScanResult) {
  const system = result.systemDecision;
  if (!system) return 0;
  const gradeBoost = system.grade?.includes('A+') ? 20 : system.grade?.includes('A') ? 10 : 0;
  return system.confidence + gradeBoost;
}

function fttScore(result: FttScanResult) {
  const system = result.systemPrediction;
  if (!system) return 0;
  const statusBoost = system.tradeStatus === 'QUALITY_SIGNAL' ? 25 : system.tradeStatus === 'TRADE_SIGNAL' ? 12 : 0;
  return system.confidence + statusBoost;
}

function StatCard({ label, value, sub, icon: Icon, tone = 'slate' }: { label: string; value: string | number; sub?: string; icon: React.ElementType; tone?: ActivityItem['tone'] }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">{label}</p>
          <p className="mt-2 text-2xl font-black tracking-tight text-slate-950">{value}</p>
          {sub ? <p className="mt-1 text-xs font-semibold text-slate-500">{sub}</p> : null}
        </div>
        <div className={`rounded-xl border p-2 ${toneClass(tone)}`}><Icon size={18} /></div>
      </div>
    </div>
  );
}

function MiniOpportunity({ result }: { result: ScanResult }) {
  const system = result.systemDecision;
  if (!system) return null;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-base font-black text-slate-950">{result.symbol}</span>
            <span className="text-xs font-bold text-slate-400">{result.timeframe}</span>
          </div>
          <p className="mt-1 text-xs font-semibold text-slate-500">{system.strategyType || system.regime || 'System scan'}</p>
        </div>
        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-black ${qualityTone(system.grade || '')}`}>{system.grade || 'WATCH'}</span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <div className={`rounded-xl border p-2 font-black ${directionTone(system.decision)}`}>{system.decision.replace('_', ' ')}</div>
        <div className="rounded-xl bg-slate-50 p-2 font-bold text-slate-700">{system.confidence}/100</div>
        <div className="rounded-xl bg-slate-50 p-2 font-bold text-slate-700">RR {number(system.riskRewardRatio, 1)}</div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] font-semibold text-slate-500">
        <div>Entry <span className="font-mono text-slate-800">{price(system.entryPrice, result.symbol)}</span></div>
        <div>SL <span className="font-mono text-red-700">{price(system.stopLoss, result.symbol)}</span></div>
      </div>
      {system.entryTimingInstruction ? <p className="mt-3 rounded-xl bg-amber-50 p-2 text-xs font-bold text-amber-800">{system.entryTimingInstruction}</p> : null}
    </div>
  );
}

function MiniFttOpportunity({ result }: { result: FttScanResult }) {
  const system = result.systemPrediction;
  if (!system) return null;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-base font-black text-slate-950">{result.symbol}</span>
            <span className="text-xs font-bold text-slate-400">{result.expiry}</span>
          </div>
          <p className="mt-1 text-xs font-semibold text-slate-500">Fixed-time scanner</p>
        </div>
        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-black ${qualityTone(system.tradeStatus || '')}`}>{system.tradeStatus || 'WATCH'}</span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <div className={`rounded-xl border p-2 font-black ${directionTone(system.direction)}`}>{system.direction}</div>
        <div className="rounded-xl bg-slate-50 p-2 font-bold text-slate-700">{system.confidence}/100</div>
        <div className="rounded-xl bg-slate-50 p-2 font-bold text-slate-700">{result.expiry}</div>
      </div>
      <p className="mt-3 line-clamp-2 text-xs font-semibold leading-relaxed text-slate-500">{system.reasoning || 'Awaiting scanner reasoning.'}</p>
    </div>
  );
}

export default function Dashboard() {
  const { signals, candles, trades, account, status, indicators, aiDecisions, fttPredictions, trackedAiProjections, postNewsSignals, topbarAlerts, logs } = useMt5Stream();
  const symbols = useMemo(() => [...new Set([...status.symbols, ...candles.map((candle) => candle.symbol), ...trades.map((trade) => trade.symbol)].filter(Boolean))].sort(), [status.symbols, candles, trades]);
  const timeframes = useMemo(() => [...new Set([...status.timeframes, ...candles.map((candle) => candle.timeframe)].filter(Boolean))].sort(), [status.timeframes, candles]);
  const primarySymbols = useMemo(() => symbols.slice(0, 10), [symbols]);
  const [selectedSymbol, setSelectedSymbol] = useState('');
  const [selectedTimeframe, setSelectedTimeframe] = useState('');
  const [selectedCandles, setSelectedCandles] = useState<Mt5Candle[]>([]);
  const [forexScan, setForexScan] = useState<ScanResult[]>([]);
  const [fttScan, setFttScan] = useState<FttScanResult[]>([]);
  const [forexReports, setForexReports] = useState<SignalEmailReportsResponse | null>(null);
  const [fixedReports, setFixedReports] = useState<SignalEmailReportsResponse | null>(null);
  const [forexCalibration, setForexCalibration] = useState<CalibrationResponse | null>(null);
  const [fixedCalibration, setFixedCalibration] = useState<CalibrationResponse | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [snapshotAt, setSnapshotAt] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedSymbol && symbols.length) setSelectedSymbol(symbols[0]);
  }, [selectedSymbol, symbols]);

  useEffect(() => {
    if (!selectedTimeframe && timeframes.length) setSelectedTimeframe(timeframes.includes('M5') ? 'M5' : timeframes[0]);
  }, [selectedTimeframe, timeframes]);

  useEffect(() => {
    if (!selectedSymbol || !selectedTimeframe) return;
    let cancelled = false;
    fetchMt5Candles(selectedSymbol, selectedTimeframe, 1200)
      .then((payload) => {
        if (!cancelled) setSelectedCandles(payload.candles);
      })
      .catch(() => {
        if (!cancelled) setSelectedCandles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSymbol, selectedTimeframe]);

  useEffect(() => {
    if (!primarySymbols.length) return;
    let cancelled = false;
    async function loadSnapshot() {
      setSnapshotLoading(true);
      setSnapshotError(null);
      try {
        const [forex, fixed, forexReportPayload, fixedReportPayload, forexCalPayload, fixedCalPayload] = await Promise.all([
          triggerAllSymbolsScan('M5', primarySymbols),
          triggerFttScan('5m', primarySymbols),
          fetchForexEmailReports({ days: 30, limit: 100 }),
          fetchFixedEmailReports({ days: 30, limit: 100 }),
          fetchCalibrationReport('forex', { days: 60, limit: 300 }),
          fetchCalibrationReport('fixed', { days: 60, limit: 300 }),
        ]);
        if (cancelled) return;
        setForexScan(forex.results || []);
        setFttScan(fixed.results || []);
        setForexReports(forexReportPayload);
        setFixedReports(fixedReportPayload);
        setForexCalibration(forexCalPayload);
        setFixedCalibration(fixedCalPayload);
        setSnapshotAt(new Date().toISOString());
      } catch (error) {
        if (!cancelled) setSnapshotError(error instanceof Error ? error.message : 'Dashboard snapshot failed');
      } finally {
        if (!cancelled) setSnapshotLoading(false);
      }
    }
    void loadSnapshot();
    const timer = window.setInterval(() => void loadSnapshot(), 30000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [primarySymbols.join('|')]);

  const streamCandles = candles
    .filter((candle) => candle.symbol === selectedSymbol && candle.timeframe === selectedTimeframe)
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  const chartCandles = [...new Map([...selectedCandles, ...streamCandles]
    .filter((candle) => candle.symbol === selectedSymbol && candle.timeframe === selectedTimeframe)
    .map((candle) => [`${candle.symbol}|${candle.timeframe}|${candle.time}`, candle])).values()]
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

  const latestCandle = chartCandles[chartCandles.length - 1] || status.latestCandle;
  const latestSignal = signals.find((signal) => signal.symbol === selectedSymbol) || signals[0];
  const latestAi = aiDecisions.find((decision) => decision.symbol === selectedSymbol) || aiDecisions[0] || status.latestAiDecision;
  const latestFtt = fttPredictions.find((prediction) => prediction.symbol === selectedSymbol) || fttPredictions[0];
  const latestPrice = latestCandle?.close || latestSignal?.price || latestFtt?.entryPrice || 0;
  const currency = account?.currency || 'USD';
  const openTrades = trades.filter((trade) => trade.status === 'open' || trade.status === 'active');
  const selectedTrades = selectedSymbol ? openTrades.filter((trade) => trade.symbol === selectedSymbol) : openTrades;
  const totalLots = openTrades.reduce((sum, trade) => sum + (Number(trade.volume) || 0), 0);
  const floatingPl = account?.profit ?? openTrades.reduce((sum, trade) => sum + (Number(trade.profit) || 0), 0);
  const exposedSymbols = [...new Set(openTrades.map((trade) => trade.symbol))];
  const bestTrade = openTrades.slice().sort((a, b) => (Number(b.profit) || 0) - (Number(a.profit) || 0))[0];
  const worstTrade = openTrades.slice().sort((a, b) => (Number(a.profit) || 0) - (Number(b.profit) || 0))[0];
  const alertsToday = signals.filter((signal) => isToday(signal.receivedAt || signal.timestamp)).length;
  const deliveredSignals = signals.filter((signal) => signal.status === 'Delivered').length;
  const deliveryRate = signals.length ? Math.round((deliveredSignals / signals.length) * 100) : 0;
  const recentIndicators = indicators.filter((indicator) => indicator.symbol === selectedSymbol).slice(0, 8);
  const bestForex = forexScan.filter((result) => result.systemDecision).sort((a, b) => forexScore(b) - forexScore(a)).slice(0, 3);
  const bestFtt = fttScan.filter((result) => result.systemPrediction).sort((a, b) => fttScore(b) - fttScore(a)).slice(0, 3);
  const forexHealth = reportHealth(forexReports);
  const fixedHealth = reportHealth(fixedReports);
  const bestForexCal = bestCalibration(forexCalibration);
  const bestFixedCal = bestCalibration(fixedCalibration);
  const activePostNews = postNewsSignals.filter((signal) => signal.status === 'ACTIVE' || signal.status === 'WAITING').slice(0, 2);
  const activeTracked = trackedAiProjections.filter((item) => item.status === 'PENDING' || item.status === 'TRIGGERED').slice(0, 3);
  const riskPosture = openTrades.length === 0 ? 'Flat' : openTrades.length <= 2 && totalLots <= 0.2 ? 'Light exposure' : openTrades.length <= 5 ? 'Active exposure' : 'High exposure';

  const recentActivity = useMemo<ActivityItem[]>(() => {
    const items: ActivityItem[] = [];
    topbarAlerts.slice(0, 4).forEach((alert) => items.push({
      id: `topbar-${alert.id}`,
      tone: alert.kind === 'FOREX' ? 'emerald' : 'purple',
      label: alert.kind === 'FOREX' ? 'A/A+ Forex' : 'Quality FTT',
      title: `${alert.symbol} ${alert.direction.replace('_', ' ')}`,
      meta: `${alert.confidence}/100 · ${alert.timeframe || alert.expiry || ''}`,
      time: alert.createdAt,
    }));
    signals.slice(0, 4).forEach((signal) => items.push({
      id: `signal-${signal.id}`,
      tone: signal.status === 'Delivered' ? 'blue' : signal.status === 'Failed' ? 'red' : 'amber',
      label: 'MT5 signal',
      title: `${signal.symbol} ${signal.type}`,
      meta: `${signal.timeframe} · ${signal.status}`,
      time: signal.receivedAt || signal.timestamp,
    }));
    fttPredictions.slice(0, 3).forEach((prediction) => items.push({
      id: `ftt-${prediction.id}`,
      tone: prediction.direction === 'HOLD' ? 'slate' : prediction.direction === 'UP' ? 'emerald' : 'red',
      label: 'FTT prediction',
      title: `${prediction.symbol} ${prediction.direction}`,
      meta: `${prediction.expiry} · ${prediction.confidence}/100`,
      time: prediction.created_at || prediction.entryTime,
    }));
    logs.slice(0, 3).forEach((log) => items.push({
      id: `log-${log.id}`,
      tone: log.status === 'Success' ? 'emerald' : 'red',
      label: log.channel,
      title: log.status === 'Success' ? 'Notification sent' : 'Notification failed',
      meta: log.recipient || log.error || 'Notification log',
      time: log.timestamp,
    }));
    return items.sort((a, b) => Date.parse(b.time || '') - Date.parse(a.time || '')).slice(0, 8);
  }, [topbarAlerts, signals, fttPredictions, logs]);

  return (
    <div className="space-y-6">
      <section className="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-card lg:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.26em] text-amber-600">Aura Command Center</p>
            <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950 lg:text-4xl">System state, signals, and risk in one view</h1>
            <p className="mt-2 max-w-3xl text-sm font-semibold text-slate-500">Minimal live cockpit built from MT5 stream data, cached scanner snapshots, email reports, and calibration evidence.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-black ${status.connected ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>
              <Wifi size={14} /> {status.connected ? 'MT5 live' : 'Waiting for MT5'}
            </span>
            <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-black ${freshnessTone(status.lastHeartbeatAt)}`}>
              <Clock size={14} /> Heartbeat {ageLabel(status.lastHeartbeatAt)}
            </span>
            <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-black text-slate-600">
              {snapshotLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCcw size={14} />} Snapshot {snapshotAt ? ageLabel(snapshotAt) : 'loading'}
            </span>
          </div>
        </div>
        {snapshotError ? <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm font-bold text-amber-800">Dashboard snapshot warning: {snapshotError}</div> : null}
      </section>

      <section className="grid grid-cols-2 gap-4 xl:grid-cols-6">
        <StatCard label="Live price" value={latestPrice ? price(latestPrice, selectedSymbol) : 'Waiting'} sub={`${selectedSymbol || 'Symbol'} · ${selectedTimeframe || 'TF'}`} icon={TrendingUp} tone="emerald" />
        <StatCard label="Candle fresh" value={ageLabel(latestCandle?.time)} sub={latestCandle?.time ? formatBdTime(latestCandle.time, 'n/a') : 'No candle'} icon={Activity} tone={ageMs(latestCandle?.time) < 120000 ? 'emerald' : 'amber'} />
        <StatCard label="Equity" value={money(account?.equity, currency)} sub={`Balance ${money(account?.balance, currency)}`} icon={Wallet} tone="blue" />
        <StatCard label="Exposure" value={openTrades.length} sub={`${riskPosture} · ${number(totalLots, 2)} lots`} icon={ShieldCheck} tone={riskPosture === 'High exposure' ? 'red' : openTrades.length ? 'amber' : 'emerald'} />
        <StatCard label="Alerts today" value={alertsToday} sub={`Delivery ${deliveryRate}%`} icon={BellRing} tone="purple" />
        <StatCard label="Data loaded" value={status.candleCount.toLocaleString()} sub={`${symbols.length} symbols · ${timeframes.length} TFs`} icon={Server} tone="slate" />
      </section>

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-black uppercase tracking-[0.18em] text-slate-500">Best Forex Now</h3>
            <BarChart3 size={18} className="text-emerald-500" />
          </div>
          {bestForex[0]?.systemDecision ? (
            <div className="mt-4">
              <div className="flex items-center justify-between gap-3">
                <div><p className="text-2xl font-black text-slate-950">{bestForex[0].symbol}</p><p className="text-xs font-bold text-slate-400">{bestForex[0].timeframe}</p></div>
                <span className={`rounded-full border px-2.5 py-1 text-xs font-black ${qualityTone(bestForex[0].systemDecision.grade || '')}`}>{bestForex[0].systemDecision.grade || 'WATCH'}</span>
              </div>
              <p className={`mt-3 inline-flex rounded-xl border px-3 py-1 text-xs font-black ${directionTone(bestForex[0].systemDecision.decision)}`}>{bestForex[0].systemDecision.decision.replace('_', ' ')}</p>
              <p className="mt-3 text-xs font-semibold leading-relaxed text-slate-500">{bestForex[0].systemDecision.entryReason || bestForex[0].systemDecision.timingTip || 'Scanner snapshot available.'}</p>
            </div>
          ) : <p className="mt-4 text-sm font-semibold text-slate-400">No cached Forex setup yet.</p>}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-black uppercase tracking-[0.18em] text-slate-500">Best FTT Now</h3>
            <Timer size={18} className="text-purple-500" />
          </div>
          {bestFtt[0]?.systemPrediction ? (
            <div className="mt-4">
              <div className="flex items-center justify-between gap-3">
                <div><p className="text-2xl font-black text-slate-950">{bestFtt[0].symbol}</p><p className="text-xs font-bold text-slate-400">{bestFtt[0].expiry}</p></div>
                <span className={`rounded-full border px-2.5 py-1 text-xs font-black ${qualityTone(bestFtt[0].systemPrediction.tradeStatus || '')}`}>{bestFtt[0].systemPrediction.tradeStatus || 'WATCH'}</span>
              </div>
              <p className={`mt-3 inline-flex rounded-xl border px-3 py-1 text-xs font-black ${directionTone(bestFtt[0].systemPrediction.direction)}`}>{bestFtt[0].systemPrediction.direction} · {bestFtt[0].systemPrediction.confidence}/100</p>
              <p className="mt-3 line-clamp-2 text-xs font-semibold leading-relaxed text-slate-500">{bestFtt[0].systemPrediction.reasoning || 'FTT scanner snapshot available.'}</p>
            </div>
          ) : <p className="mt-4 text-sm font-semibold text-slate-400">No cached FTT setup yet.</p>}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-black uppercase tracking-[0.18em] text-slate-500">AI Read</h3>
            <Brain size={18} className="text-blue-500" />
          </div>
          {latestAi ? (
            <div className="mt-4">
              <div className="flex items-center justify-between"><p className="text-2xl font-black text-slate-950">{latestAi.symbol}</p><span className="text-xs font-black text-slate-400">{latestAi.confidence}/100</span></div>
              <p className={`mt-3 inline-flex rounded-xl border px-3 py-1 text-xs font-black ${directionTone(latestAi.decision)}`}>{latestAi.decision.replace('_', ' ')}</p>
              <p className="mt-3 line-clamp-2 text-xs font-semibold leading-relaxed text-slate-500">{latestAi.trade_trigger || latestAi.reasoning || 'Latest AI decision loaded.'}</p>
            </div>
          ) : <p className="mt-4 text-sm font-semibold text-slate-400">No AI decision yet.</p>}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-black uppercase tracking-[0.18em] text-slate-500">News Watch</h3>
            <AlertTriangle size={18} className="text-amber-500" />
          </div>
          {activePostNews.length ? (
            <div className="mt-4 space-y-3">
              {activePostNews.map((signal) => (
                <div key={signal.id} className="rounded-xl bg-slate-50 p-3">
                  <div className="flex items-center justify-between"><span className="font-black text-slate-900">{signal.symbol}</span><span className={`rounded-full border px-2 py-0.5 text-[10px] font-black ${directionTone(signal.direction)}`}>{signal.direction}</span></div>
                  <p className="mt-1 line-clamp-1 text-xs font-semibold text-slate-500">{signal.event.title}</p>
                </div>
              ))}
            </div>
          ) : <p className="mt-4 text-sm font-semibold text-slate-400">No active post-news setup.</p>}
        </div>
      </section>

      <section className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-card xl:col-span-2">
          <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="flex items-center gap-2 text-lg font-black text-slate-950"><Activity size={20} className="text-amber-500" /> Live Chart</h3>
              <p className="mt-1 text-xs font-bold text-slate-400">{selectedSymbol || 'Symbol'} · {selectedTimeframe || 'Timeframe'} · candle {ageLabel(latestCandle?.time)}</p>
            </div>
            <div className="flex gap-2">
              <select value={selectedSymbol} onChange={(event) => setSelectedSymbol(event.target.value)} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-bold text-slate-700 outline-none focus:border-amber-400">
                {symbols.length ? symbols.map((symbol) => <option key={symbol}>{symbol}</option>) : <option>Waiting</option>}
              </select>
              <select value={selectedTimeframe} onChange={(event) => setSelectedTimeframe(event.target.value)} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-bold text-slate-700 outline-none focus:border-amber-400">
                {timeframes.length ? timeframes.map((timeframe) => <option key={timeframe}>{timeframe}</option>) : <option>Waiting</option>}
              </select>
            </div>
          </div>
          <Mt5CandlestickChart candles={chartCandles} signals={signals} symbol={selectedSymbol} timeframe={selectedTimeframe} />
        </div>

        <div className="space-y-6">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-card">
            <h3 className="flex items-center gap-2 text-lg font-black text-slate-950"><Gauge size={20} className="text-blue-500" /> Selected Context</h3>
            <div className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between border-b border-slate-100 pb-3"><span className="font-semibold text-slate-500">Price</span><span className="font-mono font-black text-slate-950">{latestPrice ? price(latestPrice, selectedSymbol) : 'n/a'}</span></div>
              <div className="flex justify-between border-b border-slate-100 pb-3"><span className="font-semibold text-slate-500">Last signal</span><span className="font-bold text-slate-950">{latestSignal ? `${latestSignal.type} · ${ageLabel(latestSignal.receivedAt || latestSignal.timestamp)}` : 'n/a'}</span></div>
              <div className="flex justify-between border-b border-slate-100 pb-3"><span className="font-semibold text-slate-500">Open trades</span><span className="font-black text-slate-950">{selectedTrades.length}</span></div>
              <div className="flex justify-between border-b border-slate-100 pb-3"><span className="font-semibold text-slate-500">FTT latest</span><span className="font-bold text-slate-950">{latestFtt ? `${latestFtt.direction} ${latestFtt.confidence}/100` : 'n/a'}</span></div>
              <div className="flex justify-between"><span className="font-semibold text-slate-500">Indicators</span><span className="font-black text-slate-950">{recentIndicators.length}</span></div>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-card">
            <h3 className="flex items-center gap-2 text-lg font-black text-slate-950"><ShieldCheck size={20} className="text-emerald-500" /> Risk & Exposure</h3>
            <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-xl bg-slate-50 p-3"><p className="text-[11px] font-black uppercase text-slate-400">Floating P/L</p><p className={`mt-1 text-lg font-black ${(floatingPl || 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{money(floatingPl, currency)}</p></div>
              <div className="rounded-xl bg-slate-50 p-3"><p className="text-[11px] font-black uppercase text-slate-400">Free margin</p><p className="mt-1 text-lg font-black text-slate-950">{money(account?.freeMargin, currency)}</p></div>
              <div className="rounded-xl bg-slate-50 p-3"><p className="text-[11px] font-black uppercase text-slate-400">Symbols</p><p className="mt-1 text-lg font-black text-slate-950">{exposedSymbols.length}</p></div>
              <div className="rounded-xl bg-slate-50 p-3"><p className="text-[11px] font-black uppercase text-slate-400">Lots</p><p className="mt-1 text-lg font-black text-slate-950">{number(totalLots, 2)}</p></div>
            </div>
            <div className="mt-4 space-y-2 text-xs font-semibold text-slate-500">
              <div>Best: <span className="font-bold text-emerald-600">{bestTrade ? `${bestTrade.symbol} ${money(bestTrade.profit, currency)}` : 'n/a'}</span></div>
              <div>Worst: <span className="font-bold text-red-600">{worstTrade ? `${worstTrade.symbol} ${money(worstTrade.profit, currency)}` : 'n/a'}</span></div>
            </div>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-card xl:col-span-2">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h3 className="flex items-center gap-2 text-lg font-black text-slate-950"><Sparkles size={20} className="text-amber-500" /> Opportunity Board</h3>
            <span className="text-xs font-bold text-slate-400">cached scans · not forced</span>
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div>
              <p className="mb-3 text-xs font-black uppercase tracking-[0.18em] text-slate-400">Forex</p>
              <div className="space-y-3">{bestForex.length ? bestForex.map((result) => <MiniOpportunity key={`${result.symbol}-${result.timeframe}`} result={result} />) : <div className="rounded-2xl bg-slate-50 p-5 text-sm font-semibold text-slate-400">No Forex setups in snapshot.</div>}</div>
            </div>
            <div>
              <p className="mb-3 text-xs font-black uppercase tracking-[0.18em] text-slate-400">Fixed-Time</p>
              <div className="space-y-3">{bestFtt.length ? bestFtt.map((result) => <MiniFttOpportunity key={`${result.symbol}-${result.expiry}`} result={result} />) : <div className="rounded-2xl bg-slate-50 p-5 text-sm font-semibold text-slate-400">No FTT setups in snapshot.</div>}</div>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-card">
          <h3 className="flex items-center gap-2 text-lg font-black text-slate-950"><CheckCircle2 size={20} className="text-emerald-500" /> Performance Snapshot</h3>
          <div className="mt-4 space-y-3">
            <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
              <div className="flex items-center justify-between"><span className="text-xs font-black uppercase text-slate-400">Forex 30d</span><span className="font-black text-slate-950">{forexHealth.successRate}%</span></div>
              <p className="mt-1 text-xs font-semibold text-slate-500">{forexHealth.sample} · {forexHealth.total} emailed · net {forexHealth.netPips}</p>
            </div>
            <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
              <div className="flex items-center justify-between"><span className="text-xs font-black uppercase text-slate-400">FTT 30d</span><span className="font-black text-slate-950">{fixedHealth.successRate}%</span></div>
              <p className="mt-1 text-xs font-semibold text-slate-500">{fixedHealth.sample} · {fixedHealth.total} emailed · pending {fixedHealth.pending}</p>
            </div>
            <div className="rounded-2xl border border-slate-100 bg-white p-4">
              <p className="text-xs font-black uppercase text-slate-400">Best calibrated edge</p>
              <p className="mt-2 text-sm font-black text-slate-900">{bestForexCal ? `FX ${bestForexCal.value} · ${bestForexCal.winRate}%` : bestFixedCal ? `FTT ${bestFixedCal.value} · ${bestFixedCal.winRate}%` : 'Not enough settled samples'}</p>
              <p className="mt-1 text-xs font-semibold text-slate-500">Early evidence only. Sample-size gated.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-card xl:col-span-2">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h3 className="flex items-center gap-2 text-lg font-black text-slate-950"><Activity size={20} className="text-blue-500" /> Open Trades</h3>
            <span className="text-xs font-bold text-slate-400">{openTrades.length} active · {selectedTrades.length} selected</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                <tr><th className="p-3">Ticket</th><th className="p-3">Symbol</th><th className="p-3">Type</th><th className="p-3">Lots</th><th className="p-3">Open</th><th className="p-3">Current</th><th className="p-3">SL / TP</th><th className="p-3">P/L</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {selectedTrades.map((trade) => (
                  <tr key={trade.id} className="hover:bg-slate-50/80">
                    <td className="p-3 font-mono text-slate-500">{trade.ticket}</td>
                    <td className="p-3 font-black text-slate-900">{trade.symbol}</td>
                    <td className="p-3"><span className={`rounded-full border px-2 py-0.5 text-xs font-black ${directionTone(trade.type)}`}>{trade.type}</span></td>
                    <td className="p-3 font-mono">{number(trade.volume, 2)}</td>
                    <td className="p-3 font-mono">{price(trade.openPrice, trade.symbol)}</td>
                    <td className="p-3 font-mono">{price(trade.currentPrice, trade.symbol)}</td>
                    <td className="p-3 font-mono text-slate-600">{price(trade.stopLoss, trade.symbol)} / {price(trade.takeProfit, trade.symbol)}</td>
                    <td className={`p-3 font-black ${(trade.profit || 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{money(trade.profit, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!selectedTrades.length ? <div className="rounded-2xl bg-slate-50 p-8 text-center text-sm font-semibold text-slate-400">No open trades for {selectedSymbol || 'selected symbol'}.</div> : null}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-card">
          <h3 className="flex items-center gap-2 text-lg font-black text-slate-950"><Clock size={20} className="text-amber-500" /> Recent Activity</h3>
          <div className="mt-4 space-y-3">
            {recentActivity.map((item) => (
              <div key={item.id} className="rounded-2xl border border-slate-100 bg-slate-50/70 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-black uppercase ${toneClass(item.tone)}`}>{item.label}</span>
                    <p className="mt-2 text-sm font-black text-slate-900">{item.title}</p>
                    <p className="mt-0.5 text-xs font-semibold text-slate-500">{item.meta}</p>
                  </div>
                  <span className="whitespace-nowrap text-[11px] font-bold text-slate-400">{ageLabel(item.time)}</span>
                </div>
              </div>
            ))}
            {!recentActivity.length ? <p className="text-sm font-semibold text-slate-400">No live activity yet.</p> : null}
          </div>
        </div>
      </section>
    </div>
  );
}
