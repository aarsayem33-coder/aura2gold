import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bot, Loader2, TrendingUp, TrendingDown, Target, Percent, Gauge, Flame,
  CalendarDays, ChevronLeft, ChevronRight, Clock, Layers, Download,
} from 'lucide-react';
import { fetchAutoTradeReport } from '../mt5Api';
import type { AutoTradeReport, AutoTradeGroupRow, AutoTradeReportRow } from '../types';

const usd = (v: number | null | undefined, sign = false) => {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  const n = Number(v);
  return `${sign && n > 0 ? '+' : n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const num = (v: number | null | undefined, d = 1, sign = false) => {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  const n = Number(v);
  return `${sign && n > 0 ? '+' : ''}${n.toFixed(d)}`;
};
const digitsFor = (s: string) => (/USTEC|NAS|US30/.test(s.toUpperCase()) ? 2 : /XAU|XAG/.test(s.toUpperCase()) ? 2 : /JPY/.test(s.toUpperCase()) ? 3 : 5);
const px = (v: number | null | undefined, symbol: string) =>
  (v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(digitsFor(symbol)));
const dur = (m: number | null) => (m === null ? '—' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`);

const STATUS_CHIP: Record<string, string> = {
  CLOSED: 'bg-slate-200 text-slate-700', FILLED: 'bg-emerald-100 text-emerald-700',
  PLACED: 'bg-emerald-50 text-emerald-700', SENT: 'bg-emerald-50 text-emerald-600',
  PROPOSED: 'bg-sky-100 text-sky-700', QUEUED: 'bg-sky-50 text-sky-600',
  SHADOW: 'bg-indigo-100 text-indigo-700', CAP_ALERT: 'bg-amber-100 text-amber-700',
  GUARD_SKIP: 'bg-rose-50 text-rose-600', ERROR: 'bg-rose-100 text-rose-700',
  EXPIRED: 'bg-slate-100 text-slate-500', REJECTED: 'bg-slate-100 text-slate-500',
};

function Stat({ label, value, sub, tone = 'slate', Icon }: {
  label: string; value: string; sub?: string; tone?: 'slate' | 'emerald' | 'rose' | 'indigo' | 'amber';
  Icon?: React.ComponentType<{ size?: number; className?: string }>;
}) {
  const toneMap = {
    slate: 'text-slate-900', emerald: 'text-emerald-600', rose: 'text-rose-600',
    indigo: 'text-indigo-600', amber: 'text-amber-600',
  } as const;
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <p className="flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-slate-400">
        {Icon && <Icon size={11} />} {label}
      </p>
      <p className={`mt-0.5 text-lg font-black ${toneMap[tone]}`}>{value}</p>
      {sub && <p className="text-[10px] font-semibold text-slate-400">{sub}</p>}
    </div>
  );
}

// ── Profit calendar: one month of realized P&L, colour-scaled by size ──────────
function ProfitCalendar({ byDay }: { byDay: AutoTradeReport['byDay'] }) {
  const dayMap = useMemo(() => new Map(byDay.map((d) => [d.date, d])), [byDay]);
  const latest = byDay.length ? byDay[byDay.length - 1].date : new Date().toISOString().slice(0, 10);
  const [cursor, setCursor] = useState(() => latest.slice(0, 7));   // YYYY-MM
  useEffect(() => { setCursor(latest.slice(0, 7)); }, [latest]);

  const [y, m] = cursor.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const startDow = first.getUTCDay();                                // 0=Sun
  const maxAbs = Math.max(1, ...byDay.filter((d) => d.date.startsWith(cursor)).map((d) => Math.abs(d.profit)));

  const monthRows = byDay.filter((d) => d.date.startsWith(cursor));
  const monthProfit = monthRows.reduce((a, d) => a + d.profit, 0);
  const monthTrades = monthRows.reduce((a, d) => a + d.trades, 0);
  const monthPips = monthRows.reduce((a, d) => a + d.pips, 0);

  const shift = (delta: number) => {
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    setCursor(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  };

  const cells: React.ReactNode[] = [];
  for (let i = 0; i < startDow; i++) cells.push(<div key={`pad${i}`} />);
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${cursor}-${String(d).padStart(2, '0')}`;
    const row = dayMap.get(key);
    const intensity = row ? Math.min(1, Math.abs(row.profit) / maxAbs) : 0;
    const bg = !row ? 'bg-slate-50'
      : row.profit > 0 ? `rgba(16,185,129,${0.15 + intensity * 0.6})`
        : row.profit < 0 ? `rgba(244,63,94,${0.15 + intensity * 0.6})` : 'rgba(148,163,184,0.2)';
    cells.push(
      <div key={key}
        title={row ? `${key}: ${usd(row.profit, true)} · ${row.trades} trade(s) · ${num(row.pips, 1, true)} pips · ${row.wins}W/${row.losses}L` : `${key}: no trades`}
        className={`flex min-h-[54px] flex-col rounded-lg border p-1.5 ${row ? 'border-transparent' : 'border-slate-100'} ${!row ? bg : ''}`}
        style={row ? { background: bg } : undefined}>
        <span className="text-[10px] font-black text-slate-500">{d}</span>
        {row && (
          <>
            <span className={`text-[11px] font-black leading-tight ${row.profit >= 0 ? 'text-emerald-800' : 'text-rose-800'}`}>{usd(row.profit, true)}</span>
            <span className="text-[9px] font-bold text-slate-500">{row.trades}t · {num(row.pips, 0, true)}p</span>
          </>
        )}
      </div>,
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3">
        <div className="flex items-center gap-2">
          <CalendarDays size={16} className="text-indigo-600" />
          <h3 className="text-sm font-bold text-slate-900">Profit calendar</h3>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-xs font-black ${monthProfit >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
            {usd(monthProfit, true)} <span className="font-semibold text-slate-400">· {monthTrades} trades · {num(monthPips, 1, true)} pips</span>
          </span>
          <div className="flex items-center gap-1">
            <button onClick={() => shift(-1)} className="rounded-md border border-slate-200 p-1 hover:bg-slate-50"><ChevronLeft size={14} /></button>
            <span className="w-24 text-center text-xs font-black text-slate-700">
              {first.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}
            </span>
            <button onClick={() => shift(1)} className="rounded-md border border-slate-200 p-1 hover:bg-slate-50"><ChevronRight size={14} /></button>
          </div>
        </div>
      </div>
      <div className="px-5 py-3">
        <div className="mb-1 grid grid-cols-7 gap-1">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
            <div key={d} className="text-center text-[9px] font-black uppercase tracking-wider text-slate-400">{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1">{cells}</div>
      </div>
    </div>
  );
}

function BreakdownCard({ title, rows, Icon }: { title: string; rows: AutoTradeGroupRow[]; Icon: React.ComponentType<{ size?: number; className?: string }> }) {
  if (!rows.length) return null;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-card">
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5">
        <Icon size={14} className="text-slate-400" />
        <h3 className="text-xs font-black uppercase tracking-wider text-slate-600">{title}</h3>
      </div>
      <table className="w-full text-left text-xs">
        <thead><tr className="text-[9px] font-black uppercase tracking-wider text-slate-400">
          <th className="px-4 py-1.5">Name</th><th className="px-2 py-1.5 text-right">Trades</th>
          <th className="px-2 py-1.5 text-right">Win%</th><th className="px-2 py-1.5 text-right">Pips</th>
          <th className="px-4 py-1.5 text-right">Profit</th>
        </tr></thead>
        <tbody className="divide-y divide-slate-50">
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="px-4 py-1.5 font-bold text-slate-700">{r.key}</td>
              <td className="px-2 py-1.5 text-right text-slate-500">{r.trades} <span className="text-[10px] text-slate-400">({r.wins}W/{r.losses}L)</span></td>
              <td className={`px-2 py-1.5 text-right font-bold ${(r.winRate ?? 0) >= 50 ? 'text-emerald-600' : 'text-rose-600'}`}>{r.winRate === null ? '—' : `${r.winRate}%`}</td>
              <td className={`px-2 py-1.5 text-right font-semibold ${r.pips >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{num(r.pips, 1, true)}</td>
              <td className={`px-4 py-1.5 text-right font-black ${r.profit >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{usd(r.profit, true)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AutoTradeReport({ from, to, broker }: { from?: string; to?: string; broker?: string }) {
  // Account lens. A broker can hold several accounts — evaluation, funded, demo — and
  // adding their results together makes every number meaningless. Empty = all accounts.
  const [account, setAccount] = useState('');
  const [data, setData] = useState<AutoTradeReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'CLOSED' | 'ALL'>('CLOSED');

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await fetchAutoTradeReport({ from, to, broker, account: account || undefined })); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed to load report'); }
    finally { setLoading(false); }
  }, [from, to, broker, account]);

  useEffect(() => { void load(); const t = setInterval(() => void load(), 30000); return () => clearInterval(t); }, [load]);

  const visibleTrades: AutoTradeReportRow[] = useMemo(() => {
    if (!data) return [];
    return statusFilter === 'CLOSED' ? data.trades.filter((t) => t.status === 'CLOSED') : data.trades;
  }, [data, statusFilter]);

  const exportCsv = () => {
    if (!data) return;
    const head = ['closedAt', 'createdAt', 'status', 'strategy', 'symbol', 'timeframe', 'direction', 'orderType', 'lots', 'entry', 'fill', 'stopLoss', 'closePrice', 'stopPips', 'pips', 'profit', 'R', 'riskAmount', 'riskMode', 'score', 'grade', 'rr', 'session', 'durationMin', 'ticket', 'account'];
    const rows = visibleTrades.map((t) => [t.closedAt || '', t.createdAt || '', t.status, t.strategyName, t.symbol, t.timeframe, t.direction, t.orderType, t.lots ?? '', t.entry ?? '', t.fillPrice ?? '', t.stopLoss ?? '', t.closePrice ?? '', t.stopPips ?? '', t.pips ?? '', t.profit ?? '', t.rMultiple ?? '', t.riskAmount ?? '', t.riskMode ?? '', t.score ?? '', t.grade ?? '', t.rr ?? '', t.session ?? '', t.durationMin ?? '', t.ticket ?? '', t.account ?? ''].join(','));
    const blob = new Blob([[head.join(','), ...rows].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `auto-trades-${from || 'all'}_${to || 'now'}.csv`;
    a.click();
  };

  if (err) return <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm font-semibold text-rose-700">{err}</div>;
  if (!data) return <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-slate-400"><Loader2 className="mx-auto animate-spin" /> Loading auto-trade report…</div>;

  const s = data.summary;
  const hasClosed = s.trades > 0;

  const accounts = data.accounts || [];
  const activeAcct = accounts.find((a) => a.account === account) || null;

  return (
    <div className="space-y-4">
      {/* Account lens. One broker can hold an evaluation, a funded account and a demo at
          once; summing them produces a net that describes no real account. Every number
          below is scoped to whatever is picked here. */}
      {accounts.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2.5">
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Account</span>
          <select
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            className={`rounded-lg border px-2.5 py-1.5 text-sm font-bold ${account ? 'border-indigo-400 bg-indigo-50 text-indigo-800' : 'border-slate-300 text-slate-800'}`}
          >
            <option value="">All accounts ({accounts.length})</option>
            {accounts.filter((a) => a.account).map((a) => (
              <option key={a.account as string} value={a.account as string}>
                {(a.broker || 'Unknown')} · {a.account} — {a.executed} executed
              </option>
            ))}
          </select>
          {activeAcct ? (
            <span className="flex flex-wrap items-center gap-2 text-[11px] font-semibold text-slate-500">
              <span>{activeAcct.server || '—'}</span>
              {activeAcct.demo === true && <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-black text-slate-600">DEMO</span>}
              {activeAcct.demo === false && <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-black text-rose-700">LIVE MONEY</span>}
              {activeAcct.live && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-black text-emerald-700">CONNECTED</span>}
              <span className={activeAcct.net >= 0 ? 'text-emerald-600' : 'text-rose-600'}>
                net {activeAcct.net >= 0 ? '+' : ''}{activeAcct.net.toFixed(2)}
              </span>
            </span>
          ) : (
            <span className="text-[11px] font-medium text-amber-700">
              Showing every account together — the totals below mix accounts and describe none of them individually.
            </span>
          )}
        </div>
      )}

      {/* Headline stats */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
        <Stat label="Net profit" value={usd(s.netProfit, true)} tone={s.netProfit >= 0 ? 'emerald' : 'rose'} Icon={TrendingUp}
          sub={`${usd(s.grossProfit)} won · ${usd(s.grossLoss)} lost`} />
        <Stat label="Win rate" value={s.winRate === null ? '—' : `${s.winRate}%`} tone={(s.winRate ?? 0) >= 50 ? 'emerald' : 'rose'} Icon={Percent}
          sub={`${s.wins}W / ${s.losses}L${s.breakeven ? ` / ${s.breakeven}BE` : ''}`} />
        <Stat label="Total pips" value={num(s.totalPips, 1, true)} tone={s.totalPips >= 0 ? 'emerald' : 'rose'} Icon={Target}
          sub={`avg ${num(s.avgPips, 1, true)} / trade`} />
        <Stat label="Profit factor" value={s.profitFactor === null ? '∞' : num(s.profitFactor, 2)} tone={(s.profitFactor ?? 0) >= 1 ? 'emerald' : 'rose'} Icon={Gauge}
          sub={`expectancy ${usd(s.expectancy, true)}`} />
        <Stat label="Avg R" value={s.avgR === null ? '—' : `${num(s.avgR, 2)}R`} tone={(s.avgR ?? 0) >= 0 ? 'emerald' : 'rose'} Icon={Layers}
          sub={`avg win ${usd(s.avgWin)} · loss ${usd(s.avgLoss)}`} />
        <Stat label="Streaks" value={`${s.maxWinStreak}W / ${s.maxLossStreak}L`} tone="indigo" Icon={Flame}
          sub={`best ${usd(s.bestTrade, true)} · worst ${usd(s.worstTrade, true)}`} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
        <Stat label="Closed trades" value={String(s.trades)} sub={`${s.totalRows} decisions logged`} />
        <Stat label="Open now" value={String(s.openTrades)} tone={s.openTrades ? 'emerald' : 'slate'} sub={`${s.pendingApproval} awaiting approval`} />
        <Stat label="Trading days" value={String(s.tradingDays)} sub={`${s.profitDays} profitable`} />
        <Stat label="Avg / day" value={usd(s.avgPerDay, true)} tone={(s.avgPerDay ?? 0) >= 0 ? 'emerald' : 'rose'} Icon={CalendarDays}
          sub={s.bestDay ? `best ${s.bestDay.date} ${usd(s.bestDay.profit, true)}` : undefined} />
        <Stat label="Avg hold" value={dur(s.avgDurationMin)} Icon={Clock} sub={s.worstDay ? `worst day ${usd(s.worstDay.profit, true)}` : undefined} />
        <Stat label="Shadow / errors" value={`${s.shadowCount} / ${s.errors}`} tone={s.errors ? 'rose' : 'slate'} sub="shadow = would-have-traded" />
      </div>

      {!hasClosed && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm font-semibold text-amber-900">
          No closed auto-trades in this window yet. Shadow decisions and pending trades still appear in the table below — profit stats fill in once real trades close through the EA bridge.
        </div>
      )}

      <ProfitCalendar byDay={data.byDay} />

      <div className="grid gap-3 lg:grid-cols-2">
        <BreakdownCard title="By strategy" rows={data.byStrategy} Icon={Bot} />
        <BreakdownCard title="By symbol" rows={data.bySymbol} Icon={Target} />
        <BreakdownCard title="By timeframe" rows={data.byTimeframe} Icon={Clock} />
        <BreakdownCard title="By session" rows={data.bySession} Icon={CalendarDays} />
        <BreakdownCard title="By direction" rows={data.byDirection} Icon={TrendingDown} />
        <BreakdownCard title="By grade" rows={data.byGrade} Icon={Gauge} />
      </div>

      {/* Full trade log */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3">
          <h3 className="text-sm font-bold text-slate-900">Trade log <span className="font-semibold text-slate-400">({visibleTrades.length})</span></h3>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg border border-slate-200 p-0.5">
              {(['CLOSED', 'ALL'] as const).map((f) => (
                <button key={f} onClick={() => setStatusFilter(f)} className={`rounded-md px-2.5 py-1 text-[11px] font-bold ${statusFilter === f ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-50'}`}>{f === 'CLOSED' ? 'Closed only' : 'All decisions'}</button>
              ))}
            </div>
            <button onClick={exportCsv} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-bold text-slate-600 hover:bg-slate-50"><Download size={12} />CSV</button>
            {loading && <Loader2 size={14} className="animate-spin text-slate-400" />}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead><tr className="border-b border-slate-100 text-[9px] font-black uppercase tracking-wider text-slate-400">
              <th className="px-4 py-2">Closed / opened</th><th className="px-2 py-2">Status</th><th className="px-2 py-2">Trade</th>
              <th className="px-2 py-2 text-right">Lots</th><th className="px-2 py-2 text-right">Entry → Exit</th>
              <th className="px-2 py-2 text-right">SL dist</th><th className="px-2 py-2 text-right">Pips</th>
              <th className="px-2 py-2 text-right">P&amp;L</th><th className="px-2 py-2 text-right">R</th>
              <th className="px-2 py-2 text-right">Held</th><th className="px-2 py-2">Ticket</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-50">
              {visibleTrades.map((t) => (
                <tr key={t.id} className="hover:bg-slate-50/60">
                  <td className="whitespace-nowrap px-4 py-2 text-slate-500">
                    {t.closedAt ? new Date(t.closedAt).toLocaleString() : '—'}
                    <span className="block text-[10px] text-slate-400">{t.createdAt ? new Date(t.createdAt).toLocaleString() : ''}</span>
                  </td>
                  <td className="px-2 py-2"><span className={`rounded-full px-2 py-0.5 text-[9px] font-black ${STATUS_CHIP[t.status] || 'bg-slate-100 text-slate-500'}`}>{t.status}</span></td>
                  <td className="px-2 py-2 font-semibold text-slate-700">
                    {t.direction} {t.symbol} {t.timeframe}
                    <span className="block text-[10px] font-medium text-slate-400">{t.strategyName} · {t.score} {t.grade} · RR {t.rr ?? '—'} · {t.orderType} · {t.session}</span>
                  </td>
                  <td className="px-2 py-2 text-right font-bold text-slate-700">{t.lots ?? '—'}<span className="block text-[9px] font-medium text-slate-400">{t.riskMode}</span></td>
                  <td className="whitespace-nowrap px-2 py-2 text-right font-mono text-[11px] text-slate-600">
                    {px(t.fillPrice ?? t.entry, t.symbol)} → {px(t.closePrice, t.symbol)}
                    <span className="block text-[9px] text-slate-400">SL {px(t.stopLoss, t.symbol)} · TP {px(t.takeProfit1, t.symbol)}</span>
                  </td>
                  <td className="px-2 py-2 text-right text-slate-500">{t.stopPips === null ? '—' : `${num(t.stopPips, 1)}p`}</td>
                  <td className={`px-2 py-2 text-right font-bold ${(t.pips ?? 0) >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{t.pips === null ? '—' : num(t.pips, 1, true)}</td>
                  <td className={`px-2 py-2 text-right font-black ${(t.profit ?? 0) >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{t.profit === null ? '—' : usd(t.profit, true)}</td>
                  <td className={`px-2 py-2 text-right font-bold ${(t.rMultiple ?? 0) >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{t.rMultiple === null ? '—' : `${num(t.rMultiple, 2)}R`}</td>
                  <td className="px-2 py-2 text-right text-slate-500">{dur(t.durationMin)}</td>
                  <td className="px-2 py-2 text-[10px] text-slate-400">{t.ticket ?? '—'}<span className="block">{t.account ?? ''}</span></td>
                </tr>
              ))}
              {!visibleTrades.length && (
                <tr><td colSpan={11} className="px-4 py-8 text-center text-xs font-medium text-slate-400">No trades in this window.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-[11px] font-medium text-slate-400">
        Pips are measured fill → close in the instrument's own pip size (gold/indices use points). R-multiple = realized P&amp;L ÷ the risk budgeted for that trade. Only CLOSED trades count toward profit stats; SHADOW rows are decisions the system logged without placing an order.
      </p>
    </div>
  );
}
