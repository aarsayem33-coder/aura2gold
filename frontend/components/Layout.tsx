import React, { useEffect, useMemo, useState } from 'react';
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
  const recentAlerts = alerts.filter((alert) => alertAgeMs(alert) <= ALERT_HISTORY_MS);
  const latest = recentAlerts[0];
  const popupAlert = latest && alertAgeMs(latest) <= ALERT_POPUP_MS ? latest : null;
  const displayAlert = open ? latest : popupAlert;
  const isFresh = latest ? alertAgeMs(latest) < ALERT_FRESH_MS : false;

  return (
    <div className="relative">
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
        <div className="absolute right-0 top-12 z-50 w-[360px] overflow-hidden rounded-2xl border border-amber-200 bg-white shadow-2xl shadow-slate-900/15">
          <div className="flex items-start justify-between gap-3 border-b border-amber-100 bg-gradient-to-r from-amber-50 to-white p-4">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.22em] text-amber-600">Live quality signal</p>
              <h3 className="mt-1 text-base font-black text-slate-950">{alertTitle(displayAlert)}</h3>
              <p className="text-xs font-bold text-slate-500">{displayAlert.symbol} {displayAlert.timeframe || displayAlert.expiry || ''} · {displayAlert.confidence}/100 · {alertAgeLabel(displayAlert)}</p>
            </div>
            <button type="button" onClick={() => setOpen(false)} className="rounded-full p-1 text-slate-400 hover:bg-white hover:text-slate-700">
              <X size={15} />
            </button>
          </div>
          <div className="space-y-3 p-4 text-xs">
            {displayAlert.kind === 'FOREX' ? (
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
                    <span>{alert.kind === 'FOREX' ? 'FX' : 'FTT'} · {alert.symbol} {alert.timeframe || alert.expiry}</span>
                    <span>{alert.confidence}/100 · {alertAgeLabel(alert)}</span>
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
            <div className={`hidden items-center gap-2 rounded-full border px-3 py-1.5 md:flex ${status.connected ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'}`}>
              <div className={`w-2 h-2 rounded-full ${status.connected ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`}></div>
              <span className={`text-sm font-medium ${status.connected ? 'text-emerald-700' : 'text-amber-700'}`}>
                {status.connected ? 'MT5 Connected' : 'MT5 Waiting'}
              </span>
            </div>
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
        <main className="flex-1 overflow-y-auto p-6 lg:p-10">
          <div className="mx-auto max-w-7xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
