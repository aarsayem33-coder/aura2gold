import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { 
  LayoutDashboard,
  Activity,
  BarChart3,
  Brain,
  BookOpen,
  SlidersHorizontal,
  Server,
  BellRing,
  Clock3,
  History,
  FileBarChart,
  Users,
  LogOut,
  Menu,
  TrendingUp,
  Database,
  Timer,
  CalendarDays,
  Newspaper,
  ShieldAlert,
  Crosshair,
  Sparkles,
  ClipboardList,
  FlaskConical,
  CalendarClock,
  Sunrise,
  LineChart,
  Radar,
  Gauge,
  ChevronDown,
  X
} from 'lucide-react';
import { useMt5Stream } from '../mt5Api';
import type { TopbarMarketAlert } from '../types';

interface LayoutProps {
  onLogout: () => void;
}

const STOP_HUNT_WINDOWS = [
  { key: 'XAU', timezone: 'America/New_York', start: '12:30', end: '14:30', label: 'NY Gold/USD' },
  { key: 'USD', timezone: 'America/New_York', start: '12:30', end: '14:30', label: 'NY USD' },
  { key: 'CAD', timezone: 'America/New_York', start: '12:30', end: '14:30', label: 'NY CAD' },
  { key: 'EUR', timezone: 'Europe/London', start: '07:00', end: '10:00', label: 'London EUR' },
  { key: 'GBP', timezone: 'Europe/London', start: '07:00', end: '10:00', label: 'London GBP' },
  { key: 'CHF', timezone: 'Europe/London', start: '07:00', end: '10:00', label: 'London CHF' },
  { key: 'JPY', timezone: 'Asia/Tokyo', start: '08:00', end: '10:30', label: 'Tokyo JPY' },
  { key: 'AUD', timezone: 'Australia/Sydney', start: '08:00', end: '10:30', label: 'Sydney AUD' },
  { key: 'NZD', timezone: 'Pacific/Auckland', start: '08:00', end: '10:30', label: 'Auckland NZD' },
  { key: 'CNH', timezone: 'Asia/Shanghai', start: '09:00', end: '11:00', label: 'Shanghai CNH' },
  { key: 'CNY', timezone: 'Asia/Shanghai', start: '09:00', end: '11:00', label: 'Shanghai CNY' },
];

function hhmmToMinutes(value: string) {
  const [h, m] = value.split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

function localMinutes(timezone: string, date: Date) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
  } catch {
    return null;
  }
}

function activeStopHuntLabels(now: Date) {
  return STOP_HUNT_WINDOWS.filter((window) => {
    const mins = localMinutes(window.timezone, now);
    if (mins === null) return false;
    const start = hhmmToMinutes(window.start);
    const end = hhmmToMinutes(window.end);
    return start <= end ? mins >= start && mins <= end : mins >= start || mins <= end;
  }).map((window) => window.label);
}

function price(value?: number | null, symbol?: string) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'n/a';
  const s = String(symbol || '').toUpperCase();
  const digits = /XAU|GOLD|XAG/.test(s) ? 2 : /JPY/.test(s) ? 3 : 5;
  return Number(value).toFixed(digits);
}

function money(value?: number | null) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'n/a';
  return `$${Number(value).toFixed(2)}`;
}

function alertTitle(alert: TopbarMarketAlert) {
  if (alert.alertKind === 'CLOSE') return `⚠ CLOSE TRADE · ${alert.direction.replace('_', ' ')}`;
  if (alert.alertKind === 'MANAGE') return `MANAGE TRADE · ${alert.direction.replace('_', ' ')}`;
  if (alert.strategySource) return `${alert.grade || ''} ${alert.strategySource} · ${alert.direction.replace('_', ' ')}`.trim();
  if (alert.kind === 'BREAKOUT') {
    const verb = alert.phase === 'PRE' ? 'APPROACHING' : 'BREAKOUT';
    return `${alert.grade || 'B'} ${verb} ${alert.direction === 'BUY' ? 'UP ▲' : 'DOWN ▼'}`;
  }
  return alert.kind === 'FOREX'
    ? `${alert.grade || 'A'} FOREX ${alert.direction.replace('_', ' ')}`
    : `${alert.quality || alert.grade || 'A'} FIXED-TIME ${alert.direction}`;
}

const ALERT_FRESH_MS = 15000;
const ALERT_POPUP_MS = 30000;
const ALERT_HISTORY_MS = 30 * 60 * 1000;

function alertAgeMs(alert: TopbarMarketAlert) {
  const created = Date.parse(alert.createdAt || '');
  return Number.isFinite(created) ? Date.now() - created : Number.POSITIVE_INFINITY;
}

function alertAgeLabel(alert: TopbarMarketAlert) {
  const age = alertAgeMs(alert);
  if (age < ALERT_FRESH_MS) return 'New';
  const mins = Math.floor(age / 60000);
  if (mins < 1) return `${Math.floor(age / 1000)}s ago`;
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function TopbarMarketAlerts({ alerts }: { alerts: TopbarMarketAlert[] }) {
  const [open, setOpen] = useState(false);
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const recentAlerts = alerts.filter((alert) => alertAgeMs(alert) <= ALERT_HISTORY_MS);
  const latest = recentAlerts[0];
  // Auto-popup for fresh alerts — suppressed once the user dismisses that alert via X.
  const popupAlert = latest && latest.id !== dismissedId && alertAgeMs(latest) <= ALERT_POPUP_MS ? latest : null;
  const displayAlert = open ? latest : popupAlert;
  const isFresh = latest ? alertAgeMs(latest) < ALERT_FRESH_MS : false;
  const closePopup = () => {
    if (displayAlert) setDismissedId(displayAlert.id);
    setOpen(false);
  };

  // Close the popup on any click outside it (or Escape) — anytime it is visible.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isShown = Boolean((open || popupAlert) && displayAlert);
  useEffect(() => {
    if (!isShown) return;
    const handlePointer = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) closePopup();
    };
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closePopup(); };
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isShown, displayAlert?.id]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`relative inline-flex h-10 items-center gap-2 rounded-full border px-3 text-sm font-black transition-all ${isFresh ? 'border-amber-300 bg-amber-50 text-amber-800 shadow-lg shadow-amber-200/60 animate-pulse' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
      >
        <BellRing size={17} className={isFresh ? 'text-amber-600' : 'text-slate-400'} />
        <span className="hidden xl:inline">Market Alerts</span>
        {recentAlerts.length > 0 && <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-black text-white">{recentAlerts.length}</span>}
      </button>
      {(open || popupAlert) && displayAlert && (
        // ALWAYS docked to the bottom-right corner (auto-popup AND click-opened) so the alert
        // panel never covers the tables being read. Click-outside / Escape still close it.
        <div className="fixed bottom-4 right-4 z-50 max-h-[72vh] w-[360px] overflow-y-auto rounded-2xl border border-amber-200 bg-white shadow-2xl shadow-slate-900/15">
          <div className="flex items-start justify-between gap-3 border-b border-amber-100 bg-gradient-to-r from-amber-50 to-white p-4">
            <div>
              <p className={`text-[10px] font-black uppercase tracking-[0.22em] ${displayAlert.alertKind === 'CLOSE' ? 'text-rose-600' : displayAlert.strategySource ? 'text-violet-600' : displayAlert.kind === 'BREAKOUT' ? (displayAlert.phase === 'PRE' ? 'text-amber-600' : 'text-emerald-600') : 'text-amber-600'}`}>{displayAlert.alertKind ? 'Trade management alert' : displayAlert.strategySource ? `Strategy Lab · ${displayAlert.strategySource}` : displayAlert.kind === 'BREAKOUT' ? (displayAlert.phase === 'PRE' ? 'Approaching breakout' : 'Breakout confirmed') : 'Live quality signal'}</p>
              <h3 className={`mt-1 text-base font-black ${displayAlert.alertKind === 'CLOSE' ? 'text-rose-700' : 'text-slate-950'}`}>{alertTitle(displayAlert)}</h3>
              <p className="text-xs font-bold text-slate-500">{displayAlert.symbol} {displayAlert.timeframe || displayAlert.expiry || ''} · {displayAlert.alertKind ? (displayAlert.currentR != null ? `${displayAlert.currentR}R` : '') : `${displayAlert.confidence}/100`} · {alertAgeLabel(displayAlert)}</p>
            </div>
            <button type="button" onClick={closePopup} className="rounded-full p-1 text-slate-400 hover:bg-white hover:text-slate-700">
              <X size={15} />
            </button>
          </div>
          <div className="space-y-3 p-4 text-xs">
            {displayAlert.alertKind ? (
              <>
                <div className="grid grid-cols-2 gap-2 font-mono text-slate-700">
                  <div className="rounded-xl bg-slate-50 p-2"><span className="block text-[10px] font-bold uppercase text-slate-400">Now</span>{price(displayAlert.entryPrice, displayAlert.symbol)}</div>
                  <div className={`rounded-xl p-2 ${(displayAlert.currentR ?? 0) >= 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}><span className="block text-[10px] font-bold uppercase opacity-70">Position</span>{displayAlert.currentPips != null ? `${displayAlert.currentPips} pips` : 'n/a'} {displayAlert.currentR != null ? `(${displayAlert.currentR}R)` : ''}</div>
                </div>
                {displayAlert.reason && <p className={`rounded-xl p-2 font-semibold ${displayAlert.alertKind === 'CLOSE' ? 'bg-rose-50 text-rose-800' : 'bg-amber-50 text-amber-800'}`}>{displayAlert.reason}</p>}
                {displayAlert.action && <p className="rounded-xl bg-slate-900 p-2 font-bold text-white">→ {displayAlert.action}</p>}
              </>
            ) : displayAlert.kind === 'BREAKOUT' ? (
              <>
                <div className="grid grid-cols-2 gap-2 font-mono text-slate-700">
                  <div className="rounded-xl bg-slate-50 p-2"><span className="block text-[10px] font-bold uppercase text-slate-400">Level</span>{price(displayAlert.level, displayAlert.symbol)}{(displayAlert.levelStrength ?? 0) > 1 ? ` ·${displayAlert.levelStrength}x` : ''}</div>
                  <div className="rounded-xl bg-slate-50 p-2"><span className="block text-[10px] font-bold uppercase text-slate-400">Price now</span>{price(displayAlert.entryPrice, displayAlert.symbol)}</div>
                  <div className={`col-span-2 rounded-xl p-2 ${displayAlert.phase === 'PRE' ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'}`}>
                    <span className="block text-[10px] font-bold uppercase opacity-70">{displayAlert.phase === 'PRE' ? 'Approaching' : 'Confirmed'} · {displayAlert.trend === 'UP' ? 'HH/HL' : 'LH/LL'}</span>
                    {displayAlert.phase === 'PRE'
                      ? `${displayAlert.distanceAtr ?? '?'}× ATR from level`
                      : `break body ${displayAlert.bodyAtr ?? '?'}× ATR`}
                  </div>
                </div>
                {Array.isArray(displayAlert.reasons) && displayAlert.reasons.length > 0 && (
                  <p className="rounded-xl bg-slate-50 p-2 font-semibold text-slate-600">{displayAlert.reasons.slice(0, 3).join(' · ')}</p>
                )}
              </>
            ) : displayAlert.kind === 'FOREX' ? (
              <>
                <div className="grid grid-cols-2 gap-2 font-mono text-slate-700">
                  <div className="rounded-xl bg-slate-50 p-2"><span className="block text-[10px] font-bold uppercase text-slate-400">Entry</span>{price(displayAlert.entryPrice, displayAlert.symbol)}</div>
                  <div className="rounded-xl bg-red-50 p-2 text-red-700"><span className="block text-[10px] font-bold uppercase text-red-400">Stop Loss</span>{price(displayAlert.stopLoss, displayAlert.symbol)}</div>
                  <div className="col-span-2 rounded-xl bg-emerald-50 p-2 text-emerald-700"><span className="block text-[10px] font-bold uppercase text-emerald-500">TP1 / TP2 / TP3</span>{price(displayAlert.takeProfit1, displayAlert.symbol)} / {price(displayAlert.takeProfit2, displayAlert.symbol)} / {price(displayAlert.takeProfit3, displayAlert.symbol)}</div>
                </div>
                <div className="grid grid-cols-3 gap-2 font-bold text-slate-600">
                  <div>Lot {displayAlert.lotSize ?? 'n/a'}</div>
                  <div>Invest {money(displayAlert.investment)}</div>
                  <div>Max loss {money(displayAlert.maxLoss)}</div>
                </div>
              </>
            ) : (
              <div className="grid grid-cols-2 gap-2 font-mono text-slate-700">
                <div className="rounded-xl bg-slate-50 p-2"><span className="block text-[10px] font-bold uppercase text-slate-400">Trade Time</span>{displayAlert.tradeTime ? new Date(displayAlert.tradeTime).toLocaleTimeString() : 'n/a'}</div>
                <div className="rounded-xl bg-indigo-50 p-2 text-indigo-700"><span className="block text-[10px] font-bold uppercase text-indigo-400">Expiry</span>{displayAlert.expiryTime ? new Date(displayAlert.expiryTime).toLocaleTimeString() : displayAlert.expiry || 'n/a'}</div>
                <div className="col-span-2 rounded-xl bg-slate-50 p-2"><span className="block text-[10px] font-bold uppercase text-slate-400">Entry</span>{price(displayAlert.entryPrice, displayAlert.symbol)}</div>
              </div>
            )}
            {displayAlert.sessionReason && <p className="rounded-xl bg-amber-50 p-2 font-semibold text-amber-800">{displayAlert.sessionReason}</p>}
            {recentAlerts.length > 1 && (
              <div className="border-t border-slate-100 pt-2">
                {recentAlerts.filter((alert) => alert.id !== displayAlert.id).slice(0, 4).map((alert) => (
                  <div key={alert.id} className="flex items-center justify-between py-1 text-[11px] font-bold text-slate-500">
                    <span>{alert.kind === 'FOREX' ? 'FX' : alert.kind === 'BREAKOUT' ? 'BO' : 'FTT'} · {alert.symbol} {alert.timeframe || alert.expiry}</span>
                    <span>{alert.kind === 'BREAKOUT' ? `${alert.grade || 'B'} · ${alert.phase === 'PRE' ? 'pre' : 'conf'}` : `${alert.confidence}/100`} · {alertAgeLabel(alert)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface NavChild { path: string; icon: React.ComponentType<{ size?: number; className?: string }>; label: string; end?: boolean }
interface NavGroupItem { path: string; icon: React.ComponentType<{ size?: number; className?: string }>; label: string; children: NavChild[] }

// Collapsible sidebar group (used for Reports). Auto-expands when any child route
// is active; the parent header highlights too.
function NavGroup({ item, pathname, onNavigate }: { item: NavGroupItem; pathname: string; onNavigate: () => void }) {
  const Icon = item.icon;
  const isGroupActive = pathname === item.path || pathname.startsWith(`${item.path}/`);
  const [open, setOpen] = useState(isGroupActive);
  useEffect(() => { if (isGroupActive) setOpen(true); }, [isGroupActive]);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 font-medium transition-all duration-200 ${
          isGroupActive ? 'border border-amber-200 bg-amber-50 text-amber-700 shadow-sm' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'
        }`}
      >
        <Icon size={20} className={isGroupActive ? 'text-amber-600' : 'text-slate-400'} />
        <span className="flex-1 text-left">{item.label}</span>
        <ChevronDown size={16} className={`transition-transform ${open ? 'rotate-180' : ''} ${isGroupActive ? 'text-amber-600' : 'text-slate-400'}`} />
      </button>
      {open && (
        <div className="mt-1 ml-4 space-y-1 border-l border-slate-200 pl-3">
          {item.children.map((child) => {
            const ChildIcon = child.icon;
            return (
              <NavLink
                key={child.path}
                to={child.path}
                end={child.end}
                onClick={onNavigate}
                className={({ isActive }) => `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-all ${
                  isActive ? 'bg-amber-50 text-amber-700' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                <ChildIcon size={16} className="text-slate-400" />
                <span>{child.label}</span>
              </NavLink>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function Layout({ onLogout }: LayoutProps) {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const location = useLocation();
  const { status, topbarAlerts } = useMt5Stream();

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const activeStopHunts = useMemo(() => activeStopHuntLabels(now), [now]);
  const stopHuntLabel = activeStopHunts.length ? activeStopHunts.slice(0, 2).join(', ') : 'No Stop-Hunt';

  const navItems = [
    { path: '/', icon: LayoutDashboard, label: 'Dashboard' },
    { path: '/terminal', icon: Activity, label: 'Terminal' },
    { path: '/signals', icon: BarChart3, label: 'Signals' },
    { path: '/fixed-time', icon: Timer, label: 'Fixed-Time' },
    { path: '/future-predictions', icon: Brain, label: 'Future Predictions' },
    { path: '/day-trading', icon: Sunrise, label: 'Pre-Session Brief' },
    { path: '/day-trading-desk', icon: LineChart, label: 'Day Trading Desk' },
    { path: '/live-market-tracker', icon: Gauge, label: 'Live Market Tracker' },
    { path: '/signal-tracker', icon: Radar, label: 'Signal Tracker' },
    { path: '/breakout', icon: Crosshair, label: 'Breakout Tracker' },
    {
      path: '/strategy-lab', icon: FlaskConical, label: 'Strategy Lab',
      children: [
        { path: '/strategy-lab', icon: Radar, label: 'Signals', end: true },
        { path: '/strategy-lab/reports', icon: BarChart3, label: 'Reports' },
      ],
    },
    { path: '/projections', icon: Crosshair, label: 'Pullback Projections' },
    { path: '/calendar', icon: CalendarDays, label: 'Economic Calendar' },
    { path: '/news-high-impact', icon: Newspaper, label: 'High-Impact News' },
    { path: '/trade-news', icon: ShieldAlert, label: 'Trade The News' },
    { path: '/analysis', icon: Brain, label: 'AI Analysis' },
    { path: '/ai-signals', icon: Sparkles, label: 'AI Signals' },
    { path: '/mt5', icon: Server, label: 'MT5 Connection' },
    { path: '/data', icon: Database, label: 'Historical Data' },
    { path: '/notifications', icon: BellRing, label: 'Notifications' },
    { path: '/history', icon: History, label: 'Alert History' },
    {
      path: '/reports', icon: FileBarChart, label: 'Reports',
      children: [
        { path: '/reports', icon: BarChart3, label: 'Overview', end: true },
        { path: '/reports/forex', icon: TrendingUp, label: 'Forex Outcomes' },
        { path: '/reports/fixed', icon: Timer, label: 'Fixed Outcomes' },
        { path: '/reports/signals', icon: ClipboardList, label: 'Signal Log' },
        { path: '/reports/calibration', icon: Activity, label: 'Calibration' },
        { path: '/reports/forecasts', icon: CalendarClock, label: 'Forecasts' },
        { path: '/reports/backtest', icon: FlaskConical, label: 'Backtest' },
      ],
    },
    { path: '/admin', icon: Users, label: 'Admin / Clients' },
  ];

  const toggleMobileMenu = () => setIsMobileMenuOpen(!isMobileMenuOpen);

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50 text-slate-900">
      {/* Mobile Sidebar Overlay */}
      {isMobileMenuOpen && (
        <div 
          className="fixed inset-0 z-40 bg-slate-900/25 backdrop-blur-sm transition-opacity lg:hidden"
          onClick={toggleMobileMenu}
        />
      )}

      {/* Sidebar */}
      <aside className={`
        fixed lg:static inset-y-0 left-0 z-50 w-72 border-r border-slate-200 bg-white/95 shadow-xl shadow-slate-200/60 backdrop-blur-xl transform transition-transform duration-300 ease-in-out lg:shadow-none
        ${isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        flex flex-col
      `}>
        <div className="flex h-20 items-center justify-center border-b border-slate-200/80">
          <div className="flex items-center gap-2 text-amber-500">
            <TrendingUp size={28} strokeWidth={2.5} />
            <span className="text-xl font-black tracking-tight text-slate-900">AURA<span className="text-amber-500">GOLD</span></span>
          </div>
        </div>

        <nav className="flex-1 px-4 py-6 space-y-1.5 overflow-y-auto">
          {navItems.map((item) => {
            if ('children' in item && item.children) {
              return (
                <NavGroup
                  key={item.path}
                  item={item as NavGroupItem}
                  pathname={location.pathname}
                  onNavigate={() => setIsMobileMenuOpen(false)}
                />
              );
            }
            const Icon = item.icon;
            const isActive = location.pathname === item.path;
            return (
              <NavLink
                key={item.path}
                to={item.path}
                onClick={() => setIsMobileMenuOpen(false)}
                  className={`flex items-center gap-3 rounded-xl px-4 py-3 font-medium transition-all duration-200 ${
                  isActive
                    ? 'border border-amber-200 bg-amber-50 text-amber-700 shadow-sm'
                    : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                <Icon size={20} className={isActive ? 'text-amber-600' : 'text-slate-400'} />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>

        <div className="border-t border-slate-200 p-4">
          <button 
            onClick={onLogout}
            className="flex w-full items-center gap-3 rounded-xl px-4 py-3 font-medium text-slate-500 transition-colors hover:bg-red-50 hover:text-red-600"
          >
            <LogOut size={20} className="text-slate-400" />
            <span>Logout</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Topbar */}
        <header className="z-10 flex h-20 shrink-0 items-center justify-between border-b border-slate-200 bg-white/90 px-6 shadow-sm lg:px-10">
          <div className="flex items-center gap-4">
            <button 
              onClick={toggleMobileMenu}
              className="text-slate-500 transition-colors hover:text-slate-900 lg:hidden"
            >
              <Menu size={24} />
            </button>
              <h1 className="hidden text-xl font-semibold tracking-tight text-slate-900 sm:block">
                {(() => {
                  const exact = navItems.find((item) => item.path === location.pathname);
                  if (exact) return exact.label;
                  for (const item of navItems) {
                    if ('children' in item && item.children) {
                      const child = item.children.find((c) => c.path === location.pathname);
                      if (child) return `${item.label} · ${child.label}`;
                    }
                  }
                  return 'Dashboard';
                })()}
              </h1>
          </div>

          <div className="flex min-w-0 items-center gap-3 lg:gap-4">
            <div className="hidden items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm font-bold text-slate-700 xl:flex">
              <Clock3 size={15} className="text-slate-400" />
              <span>{now.toLocaleTimeString()}</span>
            </div>
            <div className={`hidden max-w-[260px] items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-bold lg:flex ${activeStopHunts.length ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-slate-200 bg-slate-50 text-slate-500'}`} title={activeStopHunts.join(', ') || 'No mapped stop-hunt window active'}>
              <span className={`h-2 w-2 rounded-full ${activeStopHunts.length ? 'bg-amber-500 animate-pulse' : 'bg-slate-300'}`} />
              <span className="truncate">{stopHuntLabel}</span>
              {activeStopHunts.length > 2 && <span className="text-[10px]">+{activeStopHunts.length - 2}</span>}
            </div>
            <TopbarMarketAlerts alerts={topbarAlerts} />
            {(() => {
              const marketClosed = status.marketStatus?.open === false;
              // Market closed is an expected, non-error state (weekend) → neutral slate, no pulse.
              // Otherwise fall back to the live connection indicator (emerald = up, amber = waiting).
              const tone = marketClosed
                ? { wrap: 'border-slate-200 bg-slate-50', dot: 'bg-slate-400', text: 'text-slate-600', label: 'Market Closed' }
                : status.connected
                  ? { wrap: 'border-emerald-200 bg-emerald-50', dot: 'bg-emerald-500 animate-pulse', text: 'text-emerald-700', label: 'MT5 Connected' }
                  : { wrap: 'border-amber-200 bg-amber-50', dot: 'bg-amber-500', text: 'text-amber-700', label: 'MT5 Waiting' };
              return (
                <div
                  title={marketClosed ? status.marketStatus?.reason : undefined}
                  className={`hidden items-center gap-2 rounded-full border px-3 py-1.5 md:flex ${tone.wrap}`}
                >
                  <div className={`w-2 h-2 rounded-full ${tone.dot}`}></div>
                  <span className={`text-sm font-medium ${tone.text}`}>{tone.label}</span>
                </div>
              );
            })()}
            <div className="flex items-center gap-3 border-l border-slate-200 pl-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-full border border-amber-200 bg-amber-50 shadow-sm">
                <span className="text-sm font-bold text-amber-700">AD</span>
              </div>
              <div className="hidden sm:block">
                <p className="text-sm font-semibold leading-tight text-slate-900">Admin User</p>
                <p className="text-xs font-medium text-slate-500">System Administrator</p>
              </div>
            </div>
          </div>
        </header>

        {/* Page Content */}
        {/* Top padding lives on the INNER div, not the scroll container: a sticky child cannot
            stick above a scroll container's own padding, which let content scroll through a
            see-through strip above sticky toolbars. Visual spacing is identical. */}
        <main className="flex-1 overflow-y-auto px-6 pb-6 lg:px-10 lg:pb-10">
          <div className={location.pathname === '/signals' ? 'flex min-h-full w-full max-w-none flex-col pt-6 lg:pt-10' : 'mx-auto max-w-7xl pt-6 lg:pt-10'}>
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
