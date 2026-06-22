import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, FlaskConical, TrendingUp, TrendingDown, BarChart3, Timer, Hourglass, Mail, Radio } from 'lucide-react';
import { Link } from 'react-router-dom';
import { fetchStrategies, fetchStrategySignals, fetchStrategyLive, fetchStrategyLiveFtt } from '../mt5Api';
import type { StrategyMeta, StrategySignal, StrategyLiveResponse, StrategyLiveRow, StrategyFttLiveResponse, StrategyFttLiveRow } from '../types';

const REFRESH_MS = 30000;
const LIVE_TFS = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];
const num = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));

type Tab = 'forex' | 'ftt';

function outcomeChip(o: string) {
  const s = (o || '').toUpperCase();
  if (s.endsWith('_WIN') || s === 'WIN') return 'bg-emerald-50 text-emerald-700';
  if (s === 'LOSS') return 'bg-rose-50 text-rose-700';
  if (s === 'PENDING') return 'bg-blue-50 text-blue-600';
  if (s === 'DRAW' || s === 'AMBIGUOUS') return 'bg-amber-50 text-amber-700';
  return 'bg-slate-100 text-slate-400';
}

// ENTRY / HOLD / NO-DATA command pill (same vocabulary as the fixed-time scan).
function CommandPill({ row }: { row: StrategyLiveRow }) {
  if (row.command === 'ENTRY') {
    const buy = /BUY/.test(row.direction || '');
    return <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-black ${buy ? 'bg-emerald-600 text-white' : 'bg-rose-600 text-white'}`}>{buy ? <TrendingUp size={12} /> : <TrendingDown size={12} />} ENTRY {buy ? 'BUY' : 'SELL'}</span>;
  }
  if (row.command === 'HOLD') return <span className="inline-flex rounded-md px-2 py-0.5 text-[11px] font-black bg-slate-100 text-slate-500">HOLD · NO TRADE</span>;
  return <span className="inline-flex rounded-md px-2 py-0.5 text-[11px] font-black bg-slate-50 text-slate-300">NO DATA</span>;
}

// CALL UP / CALL DOWN / HOLD pill for the fixed-time scan.
function FttCommandPill({ row }: { row: StrategyFttLiveRow }) {
  if (row.command === 'CALL') {
    const up = row.direction === 'UP';
    return <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-black ${up ? 'bg-emerald-600 text-white' : 'bg-rose-600 text-white'}`}>{up ? <TrendingUp size={12} /> : <TrendingDown size={12} />} CALL {up ? 'UP' : 'DOWN'}</span>;
  }
  if (row.command === 'HOLD') return <span className="inline-flex rounded-md px-2 py-0.5 text-[11px] font-black bg-slate-100 text-slate-500">HOLD · NO CALL</span>;
  return <span className="inline-flex rounded-md px-2 py-0.5 text-[11px] font-black bg-slate-50 text-slate-300">NO DATA</span>;
}

// Live countdown to the fixed-time expiry (mm:ss). Ticks every second locally.
function ExpiryCountdown({ iso, label }: { iso: string | null | undefined; label?: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!iso) return <span className="text-slate-300">—</span>;
  const secs = Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000));
  const mm = Math.floor(secs / 60);
  const ss = secs % 60;
  const cls = secs <= 30 ? 'bg-rose-100 text-rose-700' : secs <= 120 ? 'bg-amber-100 text-amber-700' : 'bg-blue-50 text-blue-600';
  return (
    <div className="min-w-[120px]">
      <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-black ${cls}`}><Hourglass size={11} /> {mm}:{String(ss).padStart(2, '0')}</span>
      {label && <p className="mt-0.5 text-[10px] font-medium text-slate-400 leading-tight">{label}</p>}
    </div>
  );
}

// Entry-timing column: wait for the limit, take it now, or it's expired & gone.
function TimingCell({ timing }: { timing: import('../types').StrategyTiming | undefined }) {
  if (!timing) return <span className="text-slate-300">—</span>;
  const map: Record<string, { cls: string; label: string }> = {
    WAIT: { cls: 'bg-amber-100 text-amber-700', label: '⏳ WAIT' },
    TRADABLE: { cls: 'bg-emerald-100 text-emerald-700', label: '✅ TRADABLE NOW' },
    EXPIRED: { cls: 'bg-slate-100 text-slate-400', label: '✖ EXPIRED & GONE' },
    SETTLED: { cls: 'bg-blue-50 text-blue-600', label: 'DONE' },
  };
  const m = map[timing.status] || map.SETTLED;
  return (
    <div className="min-w-[150px]">
      <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-black ${m.cls}`}>{m.label}</span>
      <p className="mt-0.5 text-[10px] font-medium text-slate-400 leading-tight" title={timing.message}>{timing.message}</p>
    </div>
  );
}

function scoreBadge(score: number | null | undefined, grade: string | null | undefined) {
  if (score === null || score === undefined) return <span className="text-slate-300">—</span>;
  const cls = score >= 85 ? 'bg-emerald-100 text-emerald-700' : score >= 75 ? 'bg-emerald-50 text-emerald-600' : score >= 65 ? 'bg-blue-50 text-blue-600' : 'bg-slate-100 text-slate-500';
  return <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-black ${cls}`}>{Math.round(score)}{grade ? ` ${grade}` : ''}</span>;
}

// Tracking chips — was the call surfaced by the system (popup) and/or sent by email.
function SourceChips({ popupSent, emailSent }: { popupSent?: boolean | null; emailSent?: boolean | null }) {
  if (popupSent == null && emailSent == null) return <span className="text-[10px] text-slate-300">—</span>;
  return (
    <div className="flex items-center gap-1">
      <span className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-black ${popupSent ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-400'}`} title={popupSent ? 'Tracked by system (live popup)' : 'No popup'}><Radio size={9} /> SYS</span>
      <span className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-black ${emailSent ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-400'}`} title={emailSent ? 'Sent by email' : 'Not emailed'}><Mail size={9} /> MAIL</span>
    </div>
  );
}

// Combined live/settled cell for a fixed-time call: a pulsing green/red LIVE pill while
// PENDING (current position), or the final WIN/LOSS/DRAW + pips once settled.
function FtResultCell({ s }: { s: StrategySignal }) {
  if (s.live) {
    const st = s.live.status;
    const pillCls = st === 'WINNING' ? 'bg-emerald-100 text-emerald-700' : st === 'LOSING' ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-500';
    const dotCls = st === 'WINNING' ? 'bg-emerald-500' : st === 'LOSING' ? 'bg-rose-500' : 'bg-slate-400';
    const priceCls = st === 'WINNING' ? 'text-emerald-600' : st === 'LOSING' ? 'text-rose-600' : 'text-slate-500';
    return (
      <div className="min-w-[150px]">
        <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-black ${pillCls}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${dotCls} animate-pulse`} /> LIVE {s.live.pips > 0 ? '+' : ''}{s.live.pips}p
        </span>
        <p className="mt-0.5 font-mono text-[10px] text-slate-400">{num(s.live.reference)} → <span className={priceCls}>{num(s.live.currentPrice)}</span></p>
      </div>
    );
  }
  return (
    <div className="min-w-[110px]">
      <span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${outcomeChip(s.ftOutcome)}`}>{s.ftOutcome}</span>
      {s.ftPips !== null && <span className={`ml-1.5 font-mono text-[11px] font-bold ${s.ftPips >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{s.ftPips > 0 ? '+' : ''}{s.ftPips}p</span>}
    </div>
  );
}

export default function StrategyLab() {
  const [strategies, setStrategies] = useState<StrategyMeta[]>([]);
  const [timeframes, setTimeframes] = useState<string[]>(LIVE_TFS);
  const [selected, setSelected] = useState('');
  const [liveTf, setLiveTf] = useState('M15');
  const [histTf, setHistTf] = useState('');
  const [tab, setTab] = useState<Tab>('forex');
  const [live, setLive] = useState<StrategyLiveResponse | null>(null);
  const [ftLive, setFtLive] = useState<StrategyFttLiveResponse | null>(null);
  const [signals, setSignals] = useState<StrategySignal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchStrategies().then((m) => {
      setStrategies(m.strategies);
      if (m.timeframes?.length) setTimeframes(m.timeframes);
      setSelected((c) => c || m.strategies[0]?.id || '');
    }).catch((e) => setError(e instanceof Error ? e.message : 'Failed to load strategies'));
  }, []);

  const loadData = useCallback(async () => {
    if (!selected) return;
    setLoading(true);
    try {
      const [livePromise, sg] = await Promise.all([
        tab === 'ftt' ? fetchStrategyLiveFtt(selected, liveTf) : fetchStrategyLive(selected, liveTf),
        fetchStrategySignals(selected, histTf || undefined),
      ]);
      if (tab === 'ftt') setFtLive(livePromise as StrategyFttLiveResponse);
      else setLive(livePromise as StrategyLiveResponse);
      setSignals(sg.signals);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load strategy signals');
    } finally {
      setLoading(false);
    }
  }, [selected, liveTf, histTf, tab]);

  useEffect(() => {
    void loadData();
    const t = setInterval(() => void loadData(), REFRESH_MS);
    return () => clearInterval(t);
  }, [loadData]);

  const activeMeta = useMemo(() => strategies.find((s) => s.id === selected) || null, [strategies, selected]);
  const entries = (live?.rows || []).filter((r) => r.command === 'ENTRY');
  const calls = (ftLive?.rows || []).filter((r) => r.command === 'CALL');
  const ftStats = useMemo(() => {
    let liveWin = 0, liveLoss = 0, win = 0, loss = 0, pending = 0;
    for (const s of signals) {
      if (s.live) { if (s.live.status === 'WINNING') liveWin += 1; else if (s.live.status === 'LOSING') liveLoss += 1; }
      const o = (s.ftOutcome || '').toUpperCase();
      if (o === 'WIN') win += 1; else if (o === 'LOSS') loss += 1; else if (o === 'PENDING') pending += 1;
    }
    return { liveWin, liveLoss, win, loss, pending };
  }, [signals]);

  return (
    <div className="space-y-5 p-1">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-violet-100 p-2"><FlaskConical className="text-violet-600" size={22} /></div>
          <div>
            <h1 className="text-xl font-black text-slate-900">Strategy Lab — Signals</h1>
            <p className="text-xs font-medium text-slate-400">Live single-strategy signals (isolated engine), framed two ways: Forex (TP/SL plan) and Fixed-Time (direction at next-candle expiry).</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select value={selected} onChange={(e) => setSelected(e.target.value)} className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-semibold">
            {strategies.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select value={liveTf} onChange={(e) => setLiveTf(e.target.value)} className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-semibold" title="Live grid timeframe">
            <option value="ALL">All timeframes</option>
            {timeframes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <Link to="/strategy-lab/reports" className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-bold text-slate-600 hover:bg-slate-50"><BarChart3 size={14} /> Reports</Link>
          <button type="button" onClick={() => void loadData()} disabled={loading} className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-bold text-white hover:bg-slate-700 disabled:opacity-50">
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Refresh
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-card w-fit">
        <button type="button" onClick={() => setTab('forex')} className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-bold transition ${tab === 'forex' ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-50'}`}>
          <TrendingUp size={14} /> Forex (TP/SL)
        </button>
        <button type="button" onClick={() => setTab('ftt')} className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-bold transition ${tab === 'ftt' ? 'bg-violet-600 text-white' : 'text-slate-500 hover:bg-slate-50'}`}>
          <Timer size={14} /> Fixed-Time
        </button>
      </div>

      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">{error}</div>}

      {/* ───────────────────────── FOREX TAB ───────────────────────── */}
      {tab === 'forex' && (
        <>
          {/* LIVE COMMAND GRID — top, dashboard-style */}
          <div className="rounded-2xl border border-slate-200 bg-white shadow-card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
              <h3 className="text-sm font-black uppercase tracking-wider text-slate-500">Live signals · {activeMeta?.name || selected} · {live?.timeframe || liveTf}</h3>
              <span className="text-[11px] font-bold text-slate-400">{entries.length} ENTRY · {(live?.rows.length || 0) - entries.length} HOLD · auto-refresh 30s</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[920px] text-left text-sm">
                <thead className="border-b border-slate-100 text-[10px] uppercase tracking-[0.15em] text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Command</th>
                    <th className="px-3 py-2">Entry timing</th>
                    <th className="px-3 py-2">Symbol</th>
                    <th className="px-3 py-2 text-right">Score</th>
                    <th className="px-3 py-2 text-right">Lots</th>
                    <th className="px-3 py-2 text-right">Entry</th>
                    <th className="px-3 py-2 text-right">Stop</th>
                    <th className="px-3 py-2 text-right">TP1 / TP2 / TP3</th>
                    <th className="px-3 py-2 text-right">RR</th>
                    <th className="px-3 py-2">Why</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {live?.rows.length ? live.rows.map((r) => (
                    <tr key={`${r.symbol}-${r.timeframe}`} className={`hover:bg-slate-50/70 ${r.command === 'ENTRY' ? (/BUY/.test(r.direction || '') ? 'bg-emerald-50/30' : 'bg-rose-50/30') : ''}`}>
                      <td className="px-3 py-2"><CommandPill row={r} /></td>
                      <td className="px-3 py-2">{r.command === 'ENTRY' ? <TimingCell timing={r.timing} /> : <span className="text-slate-300">—</span>}</td>
                      <td className="px-3 py-2"><span className="font-black text-slate-900">{r.symbol}</span> <span className="text-[10px] font-bold text-slate-400">{r.timeframe}</span></td>
                      <td className="px-3 py-2 text-right">{r.command === 'ENTRY' ? scoreBadge(r.score, r.grade) : <span className="text-slate-300">—</span>}</td>
                      <td className="px-3 py-2 text-right font-mono text-[12px] font-black text-slate-900" title={r.command === 'ENTRY' && r.lossAtStop != null ? `Risk ${r.riskPercent ?? '?'}% · max loss $${r.lossAtStop} · ${r.stopPips ?? '?'} pip stop` : ''}>{r.command === 'ENTRY' && r.lots != null ? r.lots : '—'}</td>
                      <td className="px-3 py-2 text-right font-mono text-[12px]">{r.command === 'ENTRY' ? num(r.entry) : (r.price != null ? <span className="text-slate-400">{num(r.price)}</span> : '—')}</td>
                      <td className="px-3 py-2 text-right font-mono text-[12px] text-rose-600">{r.command === 'ENTRY' ? num(r.stopLoss) : '—'}</td>
                      <td className="px-3 py-2 text-right font-mono text-[11px] text-emerald-600">{r.command === 'ENTRY' ? <>{num(r.takeProfit1)} / {num(r.takeProfit2)} / {num(r.takeProfit3)}</> : '—'}</td>
                      <td className="px-3 py-2 text-right font-mono">{r.command === 'ENTRY' && r.riskReward != null ? `1:${num(r.riskReward, 1)}` : '—'}</td>
                      <td className="px-3 py-2 text-[11px] text-slate-500 max-w-[280px] truncate" title={r.reason || ''}>{r.command === 'ENTRY' ? r.reason : ''}</td>
                    </tr>
                  )) : (
                    <tr><td colSpan={10} className="px-3 py-10 text-center text-sm font-medium text-slate-400">{loading ? 'Loading…' : 'No data — make sure the MT5 feed is live for this timeframe.'}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="border-t border-slate-100 px-4 py-2 text-[11px] font-medium text-slate-400">
              ENTRY = a fresh {activeMeta?.name || 'strategy'} setup right now · HOLD = no setup on this bar · isolated lab engine, not the main system.
            </div>
          </div>

          {/* RECENT SIGNALS (history with outcomes) */}
          <div className="rounded-2xl border border-slate-200 bg-white shadow-card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
              <h3 className="text-sm font-black uppercase tracking-wider text-slate-500">Recent signals & outcomes</h3>
              <select value={histTf} onChange={(e) => setHistTf(e.target.value)} className="rounded-lg border border-slate-200 px-2 py-1 text-xs font-semibold">
                <option value="">All TFs</option>
                {timeframes.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[920px] text-left text-sm">
                <thead className="border-b border-slate-100 text-[10px] uppercase tracking-[0.15em] text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Symbol</th><th className="px-3 py-2">Dir</th>
                    <th className="px-3 py-2 text-right">Score</th><th className="px-3 py-2 text-right">Lots</th>
                    <th className="px-3 py-2 text-right">Entry / SL / TP1·2·3</th><th className="px-3 py-2 text-right">RR</th>
                    <th className="px-3 py-2">Forex</th><th className="px-3 py-2 text-right">Pips</th>
                    <th className="px-3 py-2">Fixed-time</th><th className="px-3 py-2">Signal made</th>
                    <th className="px-3 py-2">Entry timing</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {signals.length ? signals.map((s) => (
                    <tr key={s.id} className="hover:bg-slate-50/70">
                      <td className="px-3 py-2"><span className="font-black text-slate-900">{s.symbol}</span> <span className="text-[10px] font-bold text-slate-400">{s.timeframe}</span></td>
                      <td className="px-3 py-2">{/BUY/.test(s.direction) ? <span className="text-emerald-600 font-bold text-[12px]">BUY</span> : <span className="text-rose-600 font-bold text-[12px]">SELL</span>}</td>
                      <td className="px-3 py-2 text-right">{scoreBadge(s.score, s.grade)}</td>
                      <td className="px-3 py-2 text-right font-mono text-[12px] font-black text-slate-900" title={s.lossAtStop != null ? `max loss $${s.lossAtStop} · ${s.stopPips ?? '?'} pip stop` : ''}>{s.lots != null ? s.lots : '—'}</td>
                      <td className="px-3 py-2 text-right font-mono text-[11px] text-slate-500">{num(s.entryPrice)} / <span className="text-rose-500">{num(s.stopLoss)}</span> / <span className="text-emerald-600">{num(s.takeProfit1)} · {num(s.takeProfit2)} · {num(s.takeProfit3)}</span></td>
                      <td className="px-3 py-2 text-right font-mono">{s.riskReward === null ? '—' : `1:${num(s.riskReward, 1)}`}</td>
                      <td className="px-3 py-2"><span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${outcomeChip(s.outcome)}`}>{s.outcome}{s.tpHitLevel ? ` (TP${s.tpHitLevel})` : ''}</span></td>
                      <td className="px-3 py-2 text-right font-mono text-[12px]">{s.profitLossPips === null ? '—' : <span className={s.profitLossPips >= 0 ? 'text-emerald-600' : 'text-rose-600'}>{s.profitLossPips > 0 ? '+' : ''}{s.profitLossPips}</span>}</td>
                      <td className="px-3 py-2"><span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${outcomeChip(s.ftOutcome)}`}>{s.ftOutcome}</span></td>
                      <td className="px-3 py-2 text-[11px] text-slate-400">{s.signalTime ? new Date(s.signalTime).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                      <td className="px-3 py-2"><TimingCell timing={s.timing} /></td>
                    </tr>
                  )) : (
                    <tr><td colSpan={11} className="px-3 py-10 text-center text-sm font-medium text-slate-400">{loading ? 'Loading…' : 'No signals logged yet for this strategy.'}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ──────────────────────── FIXED-TIME TAB ──────────────────────── */}
      {tab === 'ftt' && (
        <>
          {/* LIVE FIXED-TIME CALL GRID */}
          <div className="rounded-2xl border border-violet-200 bg-white shadow-card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-violet-100 bg-violet-50/40 px-4 py-3">
              <h3 className="text-sm font-black uppercase tracking-wider text-violet-700">Live fixed-time calls · {activeMeta?.name || selected} · {ftLive?.timeframe || liveTf}</h3>
              <span className="text-[11px] font-bold text-slate-400">{calls.length} CALL · {(ftLive?.rows.length || 0) - calls.length} HOLD · expiry {ftLive?.expiryBars === 1 ? 'next candle' : `${ftLive?.expiryBars} candles`} · auto-refresh 30s</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead className="border-b border-slate-100 text-[10px] uppercase tracking-[0.15em] text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Call</th>
                    <th className="px-3 py-2">Symbol</th>
                    <th className="px-3 py-2 text-right">Score</th>
                    <th className="px-3 py-2 text-right">Reference</th>
                    <th className="px-3 py-2">Expires in</th>
                    <th className="px-3 py-2">Why</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {ftLive?.rows.length ? ftLive.rows.map((r) => (
                    <tr key={`${r.symbol}-${r.timeframe}`} className={`hover:bg-slate-50/70 ${r.command === 'CALL' ? (r.direction === 'UP' ? 'bg-emerald-50/30' : 'bg-rose-50/30') : ''}`}>
                      <td className="px-3 py-2"><FttCommandPill row={r} /></td>
                      <td className="px-3 py-2"><span className="font-black text-slate-900">{r.symbol}</span> <span className="text-[10px] font-bold text-slate-400">{r.timeframe}</span></td>
                      <td className="px-3 py-2 text-right">{r.command === 'CALL' ? scoreBadge(r.score, r.grade) : <span className="text-slate-300">—</span>}</td>
                      <td className="px-3 py-2 text-right font-mono text-[12px]">{r.reference != null ? num(r.reference) : '—'}</td>
                      <td className="px-3 py-2">{r.command === 'CALL' ? <ExpiryCountdown iso={r.expiryIso} label={r.durationLabel} /> : <span className="text-slate-300">—</span>}</td>
                      <td className="px-3 py-2 text-[11px] text-slate-500 max-w-[280px] truncate" title={r.reason || ''}>{r.command === 'CALL' ? r.reason : ''}</td>
                    </tr>
                  )) : (
                    <tr><td colSpan={6} className="px-3 py-10 text-center text-sm font-medium text-slate-400">{loading ? 'Loading…' : 'No data — make sure the MT5 feed is live for this timeframe.'}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="border-t border-slate-100 px-4 py-2 text-[11px] font-medium text-slate-400">
              CALL UP / DOWN = predict price will be higher / lower than the reference at the {ftLive?.expiryBars === 1 ? 'next-candle' : 'expiry'} close · HOLD = no call this bar · isolated lab engine, not the main FTT engine.
            </div>
          </div>

          {/* RECENT FIXED-TIME OUTCOMES — every call tracked (system + email), live P/L */}
          <div className="rounded-2xl border border-slate-200 bg-white shadow-card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-black uppercase tracking-wider text-slate-500">Recent fixed-time calls & outcomes</h3>
                <span className="hidden sm:inline text-[11px] font-bold text-slate-400">every signal tracked · live position</span>
              </div>
              <div className="flex items-center gap-2">
                {/* Live + settled summary chips */}
                <div className="hidden items-center gap-1.5 md:flex">
                  <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 text-[10px] font-black text-emerald-700"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" /> {ftStats.liveWin} live win</span>
                  <span className="inline-flex items-center gap-1 rounded-md bg-rose-50 px-2 py-0.5 text-[10px] font-black text-rose-700"><span className="h-1.5 w-1.5 rounded-full bg-rose-500 animate-pulse" /> {ftStats.liveLoss} live loss</span>
                  <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-black text-slate-500">{ftStats.win}W / {ftStats.loss}L settled</span>
                </div>
                <select value={histTf} onChange={(e) => setHistTf(e.target.value)} className="rounded-lg border border-slate-200 px-2 py-1 text-xs font-semibold">
                  <option value="">All TFs</option>
                  {timeframes.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="border-b border-slate-100 text-[10px] uppercase tracking-[0.15em] text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Call</th>
                    <th className="px-3 py-2">Symbol</th>
                    <th className="px-3 py-2 text-right">Score</th>
                    <th className="px-3 py-2">Live / Result</th>
                    <th className="px-3 py-2">Track</th>
                    <th className="px-3 py-2">Signal made</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {signals.length ? signals.map((s) => {
                    const up = /BUY/.test(s.direction);
                    const liveTint = s.live ? (s.live.status === 'WINNING' ? 'bg-emerald-50/40' : s.live.status === 'LOSING' ? 'bg-rose-50/40' : '') : '';
                    return (
                      <tr key={s.id} className={`hover:bg-slate-50/70 ${liveTint}`}>
                        <td className="px-3 py-2">
                          {up
                            ? <span className="inline-flex items-center gap-1 rounded-md bg-emerald-600/10 px-1.5 py-0.5 text-[11px] font-black text-emerald-700"><TrendingUp size={12} /> UP</span>
                            : <span className="inline-flex items-center gap-1 rounded-md bg-rose-600/10 px-1.5 py-0.5 text-[11px] font-black text-rose-700"><TrendingDown size={12} /> DOWN</span>}
                        </td>
                        <td className="px-3 py-2"><span className="font-black text-slate-900">{s.symbol}</span> <span className="text-[10px] font-bold text-slate-400">{s.timeframe}</span></td>
                        <td className="px-3 py-2 text-right">{scoreBadge(s.score, s.grade)}</td>
                        <td className="px-3 py-2"><FtResultCell s={s} /></td>
                        <td className="px-3 py-2"><SourceChips popupSent={s.popupSent} emailSent={s.emailSent} /></td>
                        <td className="px-3 py-2 text-[11px] text-slate-400 whitespace-nowrap">{s.signalTime ? new Date(s.signalTime).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                      </tr>
                    );
                  }) : (
                    <tr><td colSpan={6} className="px-3 py-10 text-center text-sm font-medium text-slate-400">{loading ? 'Loading…' : 'No fixed-time calls logged yet for this strategy.'}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="border-t border-slate-100 px-4 py-2 text-[11px] font-medium text-slate-400">
              <span className="font-bold text-emerald-600">LIVE</span> = open call, coloured by current position (green winning / red losing vs the reference) · settled rows show WIN / LOSS / DRAW at expiry ·
              <span className="font-bold"> SYS</span>/<span className="font-bold">MAIL</span> = tracked by system popup / sent by email · multiple calls on the same candle are all kept · see <Link to="/strategy-lab/reports" className="font-bold text-violet-600 hover:underline">Reports</Link> for win rates.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
