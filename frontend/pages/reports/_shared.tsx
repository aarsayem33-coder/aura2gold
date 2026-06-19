import React from 'react';
import { NavLink } from 'react-router-dom';
import { Activity, BarChart3, CalendarClock, CheckCircle2, ClipboardList, Clock, FlaskConical, Loader2, RefreshCcw, Timer, TrendingUp, XCircle } from 'lucide-react';
import { formatBdDateParts } from '../../utils/time';

// ── formatting helpers (shared across all report pages) ──
export function price(value?: number | null, symbol?: string) {
  if (value === null || value === undefined) return 'n/a';
  const s = String(symbol || '').toUpperCase();
  const digits = /XAU|GOLD|XAG/.test(s) ? 2 : /JPY/.test(s) ? 3 : 5;
  return value.toFixed(digits);
}

export function money(value?: number | null) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'n/a';
  return `$${Number(value).toFixed(2)}`;
}

export function signedLoss(value?: number | null) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'n/a';
  return `-${money(Math.abs(Number(value)))}`;
}

export function DateCell({ value }: { value?: string | null }) {
  const parts = formatBdDateParts(value);
  return (
    <div>
      <div className="font-semibold">{parts.date}</div>
      {parts.time ? <div className="text-xs text-slate-400 font-medium mt-0.5">{parts.time}</div> : null}
    </div>
  );
}

export function delayLabel(seconds?: number | null) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return 'n/a';
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

export function delayBadgeClass(seconds?: number | null) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return 'bg-slate-100 text-slate-500 border-slate-200';
  if (seconds <= 20) return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (seconds <= 90) return 'bg-amber-50 text-amber-700 border-amber-200';
  return 'bg-red-50 text-red-700 border-red-200';
}

export function outcomeBadge(outcome: string) {
  const o = String(outcome || 'PENDING').toUpperCase();
  if (o === 'WIN' || o === 'TP1_WIN' || o === 'TP2_WIN' || o === 'TP3_WIN') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (o === 'LOSS') return 'bg-red-50 text-red-700 border-red-200';
  if (o === 'DRAW' || o === 'BREAKEVEN') return 'bg-slate-100 text-slate-600 border-slate-200';
  if (o === 'EXPIRED' || o === 'NO_TRADE') return 'bg-amber-50 text-amber-700 border-amber-200';
  if (o === 'AMBIGUOUS') return 'bg-orange-50 text-orange-700 border-orange-200';
  return 'bg-blue-50 text-blue-700 border-blue-200';
}

export function outcomeIcon(outcome: string) {
  const o = String(outcome || 'PENDING').toUpperCase();
  if (o === 'WIN' || o === 'TP1_WIN' || o === 'TP2_WIN' || o === 'TP3_WIN') return <CheckCircle2 size={12} />;
  if (o === 'LOSS') return <XCircle size={12} />;
  if (o === 'PENDING') return <Clock size={12} />;
  return null;
}

export function signalQualityBadge(quality?: string | null) {
  const q = quality || 'WATCH';
  if (q === 'A+ SIGNAL') return 'border-emerald-700 bg-emerald-600 text-white';
  if (q === 'A SIGNAL') return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  if (q === 'B SIGNAL') return 'border-blue-200 bg-blue-50 text-blue-800';
  return 'border-slate-200 bg-slate-100 text-slate-500';
}

export function gradeBadgeClass(grade?: string | null) {
  const g = String(grade || '').toUpperCase();
  if (g.includes('A+')) return 'border-emerald-700 bg-emerald-600 text-white';
  if (g.includes('A')) return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  if (g.includes('B')) return 'border-blue-200 bg-blue-50 text-blue-800';
  return 'border-slate-200 bg-slate-100 text-slate-500';
}

// ── in-page sub-navigation across the report routes ──
const REPORT_TABS = [
  { to: '/reports', label: 'Overview', icon: BarChart3, end: true },
  { to: '/reports/forex', label: 'Forex Outcomes', icon: TrendingUp, end: false },
  { to: '/reports/fixed', label: 'Fixed Outcomes', icon: Timer, end: false },
  { to: '/reports/signals', label: 'Signal Log', icon: ClipboardList, end: false },
  { to: '/reports/calibration', label: 'Calibration', icon: Activity, end: false },
  { to: '/reports/forecasts', label: 'Forecasts', icon: CalendarClock, end: false },
  { to: '/reports/backtest', label: 'Backtest', icon: FlaskConical, end: false },
];

export function ReportsTabs() {
  return (
    <div className="flex flex-wrap gap-1.5 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-sm">
      {REPORT_TABS.map((tab) => {
        const Icon = tab.icon;
        return (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) => `inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-bold transition-all ${
              isActive ? 'bg-amber-50 text-amber-700 border border-amber-200 shadow-sm' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'
            }`}
          >
            <Icon size={15} />
            {tab.label}
          </NavLink>
        );
      })}
    </div>
  );
}

// ── shared page header with day-range filter + refresh ──
export function ReportsHeader({
  title,
  subtitle,
  days,
  setDays,
  onRefresh,
  loading,
  showDays = true,
}: {
  title: string;
  subtitle: string;
  days?: number;
  setDays?: (n: number) => void;
  onRefresh: () => void;
  loading: boolean;
  showDays?: boolean;
}) {
  return (
    <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
      <div>
        <h2 className="text-2xl font-bold text-slate-900 tracking-tight">{title}</h2>
        <p className="text-slate-500 text-sm mt-1 font-medium">{subtitle}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {showDays && setDays && (
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 shadow-sm"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last year</option>
          </select>
        )}
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-bold text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-60"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCcw size={16} />}
          Refresh
        </button>
      </div>
    </div>
  );
}

export function SummaryCards({ summary, market }: { summary: import('../../types').TradeReportSummary; market: 'forex' | 'fixed' }) {
  const plLabel = market === 'forex' ? 'Net pips' : 'Net P/L';
  return (
    <div className={`grid grid-cols-2 ${market === 'forex' ? 'lg:grid-cols-6' : 'lg:grid-cols-5'} gap-4`}>
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
        <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Emailed signals</p>
        <p className="mt-1 text-2xl font-black text-slate-900">{summary.total}</p>
      </div>
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-4 shadow-card">
        <p className="text-xs font-bold uppercase tracking-wide text-emerald-600">Success rate</p>
        <p className="mt-1 text-2xl font-black text-emerald-700">{summary.successRate}%</p>
        <p className="text-xs text-emerald-600/80 mt-0.5">{summary.wins} wins</p>
      </div>
      <div className="rounded-2xl border border-red-200 bg-red-50/50 p-4 shadow-card">
        <p className="text-xs font-bold uppercase tracking-wide text-red-600">Fail rate</p>
        <p className="mt-1 text-2xl font-black text-red-700">{summary.failRate}%</p>
        <p className="text-xs text-red-600/80 mt-0.5">{summary.losses} losses</p>
      </div>
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
        <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Pending</p>
        <p className="mt-1 text-2xl font-black text-slate-900">{summary.pending}</p>
      </div>
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card col-span-2 lg:col-span-1">
        <p className="text-xs font-bold uppercase tracking-wide text-slate-400">{plLabel}</p>
        <p className={`mt-1 text-2xl font-black ${summary.netPips >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
          {summary.netPips >= 0 ? '+' : ''}{summary.netPips}
        </p>
      </div>
      {market === 'forex' && (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card col-span-2 lg:col-span-1">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Target hits</p>
          <div className="mt-2 space-y-1 text-sm font-bold text-slate-700">
            <div>TP1 {summary.tp1Wins ?? 0} · {summary.tp1Rate ?? summary.tp1WinRate ?? 0}%</div>
            <div>TP2 {summary.tp2Wins ?? 0} · {summary.tp2Rate ?? summary.tp2WinRate ?? 0}%</div>
            <div>TP3 {summary.tp3Wins ?? 0} · {summary.tp3Rate ?? summary.tp3WinRate ?? 0}%</div>
          </div>
        </div>
      )}
    </div>
  );
}

export function ErrorBanner({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
      {error}
    </div>
  );
}
