import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Loader2, RefreshCw, Crosshair, TrendingUp, TrendingDown, Zap, Target,
  Mail, Radio, History, AlertTriangle, CheckCircle2, Activity,
} from 'lucide-react';
import { fetchBreakoutLive, fetchBreakoutAlerts, fetchBreakoutTracking, useMt5Stream } from '../mt5Api';
import type { BreakoutLiveRow, BreakoutLiveResponse, BreakoutAlert, BreakoutTrackingResponse, BreakoutTrackingRow, BreakoutTrackState } from '../types';

const LIVE_REFRESH_MS = 20000;
const ALERTS_REFRESH_MS = 45000;

// Price formatting consistent with the rest of the app (gold 2dp, JPY 3dp, FX 5dp).
function price(value?: number | null, symbol?: string) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const s = String(symbol || '').toUpperCase();
  const digits = /XAU|GOLD|XAG/.test(s) ? 2 : /JPY/.test(s) ? 3 : 5;
  return Number(value).toFixed(digits);
}

function gradeChip(grade: string | null | undefined, score?: number | null) {
  const g = (grade || '').toUpperCase();
  const cls = g === 'A+' ? 'bg-emerald-600 text-white'
    : g === 'A' ? 'bg-emerald-100 text-emerald-700'
    : g === 'B' ? 'bg-blue-50 text-blue-600'
    : 'bg-slate-100 text-slate-500';
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-black ${cls}`}>
      {g || '—'}{score != null ? <span className="opacity-70">{Math.round(score)}</span> : null}
    </span>
  );
}

function PhasePill({ phase }: { phase: 'PRE' | 'CONFIRMED' }) {
  if (phase === 'CONFIRMED') {
    return <span className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-0.5 text-[11px] font-black text-white"><Zap size={12} /> CONFIRMED</span>;
  }
  return <span className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-2 py-0.5 text-[11px] font-black text-amber-700"><Target size={12} /> APPROACHING</span>;
}

function DirCell({ direction, trend }: { direction: 'BUY' | 'SELL'; trend?: string | null }) {
  const buy = direction === 'BUY';
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-black ${buy ? 'text-emerald-700' : 'text-rose-700'}`}>
      {buy ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
      {buy ? 'UP' : 'DOWN'}
      {trend && <span className="font-bold text-slate-400">· {trend === 'UP' ? 'HH/HL' : 'LH/LL'}</span>}
    </span>
  );
}

function channelChip(channel: string) {
  const email = String(channel).toUpperCase() === 'EMAIL';
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-black ${email ? 'bg-amber-100 text-amber-700' : 'bg-blue-50 text-blue-600'}`}>
      {email ? <Mail size={10} /> : <Radio size={10} />}{email ? 'EMAIL' : 'BROWSER'}
    </span>
  );
}

function TrackStatePill({ state }: { state: BreakoutTrackState }) {
  const map: Record<BreakoutTrackState, { cls: string; icon: React.ReactNode; label: string }> = {
    TARGET_HIT: { cls: 'bg-emerald-600 text-white', icon: <Target size={12} />, label: 'TARGET HIT' },
    FOLLOWING_THROUGH: { cls: 'bg-emerald-100 text-emerald-700', icon: <TrendingUp size={12} />, label: 'FOLLOWING' },
    STALLING: { cls: 'bg-amber-100 text-amber-700', icon: <Activity size={12} />, label: 'STALLING' },
    FAILED: { cls: 'bg-rose-100 text-rose-700', icon: <AlertTriangle size={12} />, label: 'FAILED' },
  };
  const m = map[state] || { cls: 'bg-slate-100 text-slate-500', icon: null, label: state };
  return <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-black ${m.cls}`}>{m.icon}{m.label}</span>;
}

// One follow-through table (used for both the live "active" set and the settled history).
function FollowThroughTable({ rows }: { rows: BreakoutTrackingRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-slate-100 text-[11px] font-black uppercase tracking-wide text-slate-400">
          <tr>
            <th className="px-5 py-2.5">Symbol · TF</th>
            <th className="px-3 py-2.5">Direction</th>
            <th className="px-3 py-2.5">Status</th>
            <th className="px-3 py-2.5" title="Live movement grade — how healthy the follow-through is right now (reach toward target · holding the gain · pullback below the level)">Movement</th>
            <th className="px-3 py-2.5">Level → now</th>
            <th className="px-3 py-2.5">Follow-through</th>
            <th className="px-3 py-2.5">MFE / MAE (pip)</th>
            <th className="px-3 py-2.5">To target</th>
            <th className="px-5 py-2.5">Age</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          {rows.map((r) => (
            <tr key={r.id} className={`hover:bg-slate-50/60 ${r.stale ? 'opacity-60' : ''}`}>
              <td className="px-5 py-3"><span className="font-black text-slate-700">{r.symbol}</span> <span className="text-[11px] font-bold text-slate-400">{r.timeframe}</span></td>
              <td className="px-3 py-3"><DirCell direction={r.direction} trend={r.trend} /></td>
              <td className="px-3 py-3"><TrackStatePill state={r.state} /></td>
              <td className="px-3 py-3">
                <div className="flex items-center gap-1.5">
                  {gradeChip(r.liveGrade, r.liveScore)}
                  <span className="text-[10px] font-bold text-slate-400" title="how much of its peak extension it's holding">{r.retentionPct}% held</span>
                </div>
              </td>
              <td className="px-3 py-3 font-mono text-[12px] text-slate-600">{price(r.level, r.symbol)} <span className="text-slate-300">→</span> <span className="font-bold text-slate-800">{price(r.currentPrice, r.symbol)}</span></td>
              <td className="px-3 py-3">
                <span className={`font-black ${r.beyondPips >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{r.beyondPips >= 0 ? '+' : ''}{r.beyondPips} pip</span>
                <span className="ml-1 text-[11px] font-bold text-slate-400">{r.beyondAtr}×ATR</span>
              </td>
              <td className="px-3 py-3 text-[12px]"><span className="font-bold text-emerald-600">{r.mfePips}</span> <span className="text-slate-300">/</span> <span className="font-bold text-rose-500">{r.maePips}</span></td>
              <td className="px-3 py-3">
                <div className="flex items-center gap-2">
                  <div className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-100">
                    <div className={`h-full rounded-full ${r.state === 'FAILED' ? 'bg-rose-400' : 'bg-emerald-500'}`} style={{ width: `${r.progressPct}%` }} />
                  </div>
                  <span className="text-[11px] font-bold text-slate-400">{r.progressPct}%</span>
                </div>
              </td>
              <td className="px-5 py-3 text-[11px] font-bold text-slate-500">{r.ageHours != null ? `${r.ageHours}h` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function timeAgo(iso?: string | null) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '—';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function StatCard({ label, value, tone, icon }: { label: string; value: React.ReactNode; tone: string; icon: React.ReactNode }) {
  return (
    <div className={`flex items-center gap-3 rounded-2xl border p-4 ${tone}`}>
      <div className="shrink-0">{icon}</div>
      <div className="min-w-0">
        <p className="text-[11px] font-black uppercase tracking-wide opacity-70">{label}</p>
        <p className="text-lg font-black leading-tight">{value}</p>
      </div>
    </div>
  );
}

export default function BreakoutTracker() {
  const { topbarAlerts } = useMt5Stream();
  const [data, setData] = useState<BreakoutLiveResponse | null>(null);
  const [alerts, setAlerts] = useState<BreakoutAlert[]>([]);
  const [tracking, setTracking] = useState<BreakoutTrackingResponse | null>(null);
  const [tab, setTab] = useState<'live' | 'tracking' | 'alerts'>('live');
  const [timeframe, setTimeframe] = useState('ALL');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tfRef = useRef(timeframe);
  tfRef.current = timeframe;

  const loadLive = useCallback(async (background = false) => {
    if (background) setRefreshing(true);
    try {
      const res = await fetchBreakoutLive(tfRef.current);
      setData(res);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load live breakouts');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const loadAlerts = useCallback(async () => {
    try {
      const res = await fetchBreakoutAlerts({ limit: 150 });
      setAlerts(res.alerts);
    } catch { /* track record is non-critical */ }
  }, []);

  const loadTracking = useCallback(async () => {
    try {
      const res = await fetchBreakoutTracking(tfRef.current);
      setTracking(res);
    } catch { /* follow-through is non-critical */ }
  }, []);

  useEffect(() => { setLoading(true); void loadLive(); void loadTracking(); }, [timeframe, loadLive, loadTracking]);
  useEffect(() => { void loadAlerts(); }, [loadAlerts]);

  useEffect(() => {
    const a = window.setInterval(() => void loadLive(true), LIVE_REFRESH_MS);
    const b = window.setInterval(() => void loadAlerts(), ALERTS_REFRESH_MS);
    const c = window.setInterval(() => void loadTracking(), LIVE_REFRESH_MS);
    return () => { window.clearInterval(a); window.clearInterval(b); window.clearInterval(c); };
  }, [loadLive, loadAlerts, loadTracking]);

  // Refetch immediately when a fresh breakout alert streams into the top bar.
  const liveBreakoutCount = topbarAlerts.filter((x) => x.kind === 'BREAKOUT').length;
  const prevCount = useRef(liveBreakoutCount);
  useEffect(() => {
    if (liveBreakoutCount > prevCount.current) { void loadLive(true); void loadAlerts(); void loadTracking(); }
    prevCount.current = liveBreakoutCount;
  }, [liveBreakoutCount, loadLive, loadAlerts, loadTracking]);

  const rows = data?.rows || [];
  const timeframes = useMemo(() => ['ALL', ...(data?.timeframes || ['M5', 'M15', 'M30', 'H1'])], [data]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-amber-200 bg-amber-50 text-amber-600">
            <Crosshair size={24} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900">Breakout Tracker</h1>
            <p className="max-w-2xl text-sm font-medium text-slate-500">
              Graded PRE (approaching a strong level) and CONFIRMED (decisive close beyond it) breakouts on
              well-formed charts only. The same isolated detector that drives the breakout alerts — never blended
              with live signals.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => { void loadLive(true); void loadAlerts(); void loadTracking(); }}
          className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-600 shadow-sm transition hover:bg-slate-50"
        >
          {refreshing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          Refresh
        </button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Confirmed now" tone="border-emerald-200 bg-emerald-50 text-emerald-800"
          icon={<Zap size={22} className="text-emerald-600" />}
          value={data ? data.confirmed : '—'}
        />
        <StatCard
          label="Approaching" tone="border-amber-200 bg-amber-50 text-amber-800"
          icon={<Target size={22} className="text-amber-600" />}
          value={data ? data.pre : '—'}
        />
        <StatCard
          label="Engine" tone="border-slate-200 bg-white text-slate-700"
          icon={data?.enabled ? <CheckCircle2 size={22} className="text-emerald-500" /> : <AlertTriangle size={22} className="text-rose-500" />}
          value={data ? (data.enabled ? 'Live' : 'Off') : '—'}
        />
        <StatCard
          label="Alert bars (browser / email)" tone="border-slate-200 bg-white text-slate-700"
          icon={<Mail size={22} className="text-amber-500" />}
          value={data ? `${data.browserMinGrade}+ / ${data.emailMinGrade}+` : '—'}
        />
      </div>

      {/* Timeframe filter */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-black uppercase tracking-wide text-slate-400">Timeframe</span>
        {timeframes.map((tf) => (
          <button
            key={tf}
            type="button"
            onClick={() => setTimeframe(tf)}
            className={`rounded-lg px-3 py-1.5 text-xs font-black transition ${
              timeframe === tf ? 'bg-amber-500 text-white shadow-sm' : 'border border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
            }`}
          >
            {tf}
          </button>
        ))}
        {data && (
          <span className="ml-auto text-[11px] font-medium text-slate-400">
            Updated {timeAgo(data.generatedAt)}
          </span>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm font-semibold text-rose-700">{error}</div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1.5 border-b border-slate-200">
        {([
          { id: 'live', label: 'Live setups', count: rows.length },
          { id: 'tracking', label: 'Follow-Through', count: tracking?.active.length ?? null },
          { id: 'alerts', label: 'Fired alerts', count: alerts.length },
        ] as const).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`-mb-px rounded-t-lg border-b-2 px-4 py-2 text-sm font-black transition ${tab === t.id ? 'border-amber-500 text-amber-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
          >
            {t.label}{t.count != null ? <span className="ml-1.5 text-[11px] font-bold opacity-60">{t.count}</span> : null}
          </button>
        ))}
      </div>

      {/* Live candidates */}
      {tab === 'live' && (
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/60 px-5 py-3">
          <h2 className="flex items-center gap-2 text-sm font-black text-slate-700"><Crosshair size={15} className="text-amber-500" /> Live setups</h2>
          <span className="text-[11px] font-bold text-slate-400">{rows.length} candidate{rows.length === 1 ? '' : 's'}</span>
        </div>
        {loading ? (
          <div className="flex items-center justify-center gap-2 p-10 text-sm font-semibold text-slate-400"><Loader2 size={18} className="animate-spin" /> Scanning charts…</div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center text-sm font-semibold text-slate-400">
            No well-formed breakout setups right now. Choppy / rangebound charts are graded out by design.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-100 text-[11px] font-black uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-5 py-2.5">Symbol · TF</th>
                  <th className="px-3 py-2.5">Phase</th>
                  <th className="px-3 py-2.5">Direction</th>
                  <th className="px-3 py-2.5">Grade</th>
                  <th className="px-3 py-2.5">Level</th>
                  <th className="px-3 py-2.5">Price now</th>
                  <th className="px-3 py-2.5">Proximity / Break</th>
                  <th className="px-3 py-2.5">Alert</th>
                  <th className="px-5 py-2.5">Why</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {rows.map((r: BreakoutLiveRow) => (
                  <tr key={`${r.symbol}|${r.timeframe}|${r.phase}`} className={`align-top ${r.stale ? 'opacity-50' : ''} hover:bg-slate-50/60`}>
                    <td className="px-5 py-3">
                      <div className="font-black text-slate-800">{r.symbol}</div>
                      <div className="text-[11px] font-bold text-slate-400">{r.timeframe}{r.stale ? ' · stale feed' : ''}</div>
                    </td>
                    <td className="px-3 py-3"><PhasePill phase={r.phase} /></td>
                    <td className="px-3 py-3"><DirCell direction={r.direction} trend={r.trend} /></td>
                    <td className="px-3 py-3">{gradeChip(r.grade, r.score)}</td>
                    <td className="px-3 py-3 font-mono text-slate-700">
                      {price(r.level, r.symbol)}
                      {r.levelStrength > 1 && <span className="ml-1 rounded bg-slate-100 px-1 text-[10px] font-black text-slate-500">{r.levelStrength}×</span>}
                    </td>
                    <td className="px-3 py-3 font-mono text-slate-700">{price(r.price, r.symbol)}</td>
                    <td className="px-3 py-3">
                      {r.phase === 'PRE' ? (
                        <span className="text-[11px] font-bold text-amber-700">{r.distanceAtr ?? '?'}× ATR away</span>
                      ) : (
                        <span className="text-[11px] font-bold text-emerald-700">
                          body {r.bodyAtr ?? '?'}× ATR
                          {r.displacement?.present && <span className="ml-1 text-violet-600">· {r.displacement.strong ? 'strong displ.' : 'displ.'}</span>}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {r.meetsBrowserBar
                        ? <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-black text-emerald-600"><Radio size={10} /> alerts</span>
                        : <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-black text-slate-400">forming</span>}
                    </td>
                    <td className="px-5 py-3">
                      <p className="max-w-xs text-[11px] font-medium leading-snug text-slate-500" title={r.reasons?.join(' · ')}>
                        {(r.reasons || []).slice(0, 3).join(' · ')}
                      </p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      )}

      {/* Follow-through — confirmed breakouts tracked live (did the break extend or fail?) */}
      {tab === 'tracking' && (
      <div className="space-y-6">
        <div className="grid grid-cols-3 gap-3">
          <StatCard label="Active" tone="border-amber-200 bg-amber-50 text-amber-800" icon={<Activity size={22} className="text-amber-600" />} value={tracking ? tracking.stats.active : '—'} />
          <StatCard label="Target hit / Failed" tone="border-slate-200 bg-white text-slate-700" icon={<Target size={22} className="text-emerald-500" />} value={tracking ? `${tracking.stats.targetHit} / ${tracking.stats.failed}` : '—'} />
          <StatCard label="Follow-through win rate" tone="border-emerald-200 bg-emerald-50 text-emerald-800" icon={<CheckCircle2 size={22} className="text-emerald-600" />} value={tracking && tracking.stats.winRate != null ? `${tracking.stats.winRate}%` : '—'} />
        </div>
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/60 px-5 py-3">
            <h2 className="flex items-center gap-2 text-sm font-black text-slate-700"><Activity size={15} className="text-amber-500" /> Developing — confirmed breakouts still extending</h2>
            <span className="text-[11px] font-bold text-slate-400">{tracking?.active.length ?? 0} active</span>
          </div>
          {!tracking ? (
            <div className="flex items-center justify-center gap-2 p-10 text-sm font-semibold text-slate-400"><Loader2 size={18} className="animate-spin" /> Tracking…</div>
          ) : tracking.active.length === 0 ? (
            <div className="p-10 text-center text-sm font-semibold text-slate-400">No confirmed breakouts are developing right now. Confirmed breaks appear here and update live until they hit target ({tracking.windowHours}h window) or fail.</div>
          ) : <FollowThroughTable rows={tracking.active} />}
        </div>
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/60 px-5 py-3">
            <h2 className="flex items-center gap-2 text-sm font-black text-slate-700"><History size={15} className="text-slate-400" /> Settled — extended to target or failed</h2>
            <span className="text-[11px] font-bold text-slate-400">last {tracking?.settled.length ?? 0}</span>
          </div>
          {!tracking || tracking.settled.length === 0 ? (
            <div className="p-8 text-center text-sm font-semibold text-slate-400">No settled breakouts in the window yet.</div>
          ) : <FollowThroughTable rows={tracking.settled} />}
        </div>
      </div>
      )}

      {/* Track record */}
      {tab === 'alerts' && (
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/60 px-5 py-3">
          <h2 className="flex items-center gap-2 text-sm font-black text-slate-700"><History size={15} className="text-slate-400" /> Recent fired alerts</h2>
          <span className="text-[11px] font-bold text-slate-400">last {alerts.length}</span>
        </div>
        {alerts.length === 0 ? (
          <div className="p-8 text-center text-sm font-semibold text-slate-400">No breakout alerts have fired yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-100 text-[11px] font-black uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-5 py-2.5">When</th>
                  <th className="px-3 py-2.5">Symbol · TF</th>
                  <th className="px-3 py-2.5">Phase</th>
                  <th className="px-3 py-2.5">Direction</th>
                  <th className="px-3 py-2.5">Grade</th>
                  <th className="px-3 py-2.5">Level</th>
                  <th className="px-5 py-2.5">Channel</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {alerts.map((a) => (
                  <tr key={a.id} className="hover:bg-slate-50/60">
                    <td className="px-5 py-2.5 text-[11px] font-bold text-slate-500" title={a.createdAt || ''}>{timeAgo(a.createdAt)}</td>
                    <td className="px-3 py-2.5"><span className="font-black text-slate-700">{a.symbol}</span> <span className="text-[11px] font-bold text-slate-400">{a.timeframe}</span></td>
                    <td className="px-3 py-2.5"><PhasePill phase={a.phase} /></td>
                    <td className="px-3 py-2.5"><DirCell direction={a.direction} trend={a.trend} /></td>
                    <td className="px-3 py-2.5">{gradeChip(a.grade, a.score)}</td>
                    <td className="px-3 py-2.5 font-mono text-slate-700">{price(a.level, a.symbol)}{(a.levelStrength ?? 0) > 1 ? <span className="ml-1 text-[10px] font-black text-slate-400">{a.levelStrength}×</span> : null}</td>
                    <td className="px-5 py-2.5">{channelChip(a.channel)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      )}
    </div>
  );
}
