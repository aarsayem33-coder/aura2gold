import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw, Radar, TrendingUp, TrendingDown, AlertTriangle, ShieldCheck, Mail, Cpu, Check, Crosshair, Target, Radio, Zap } from 'lucide-react';
import { fetchSignalTracker, markSignalTrackerDone, fetchStrategyEntryWatch } from '../mt5Api';
import { playAlertSound, showBrowserNotification } from '../utils/notifications';
import type { SignalTrackerResponse, SignalTrackerItem, StrategyEntryWatchItem } from '../types';

const REFRESH_MS = 20000;
const ENTRY_WATCH_REFRESH_MS = 15000;

function fmt(v: number | null | undefined, d = 2) {
  return v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(d);
}
// Symbol-aware price (gold 2dp, JPY 3dp, FX 5dp) — entry/SL/TP need full precision.
function px(v: number | null | undefined, symbol?: string) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  const s = String(symbol || '').toUpperCase();
  const digits = /XAU|GOLD|XAG/.test(s) ? 2 : /JPY/.test(s) ? 3 : 5;
  return Number(v).toFixed(digits);
}
function fmtTime(iso: string | null) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
}

function DirTag({ d }: { d: string }) {
  const up = /BUY/.test(d);
  return <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-black ${up ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>{up ? <TrendingUp size={11} /> : <TrendingDown size={11} />}{d.replace('_', ' ')}</span>;
}

function scorePill(score: number | null, grade: string | null) {
  if (score === null || score === undefined) return null;
  const g = (grade || '').toUpperCase();
  const cls = g === 'A+' ? 'bg-emerald-600 text-white' : g === 'A' ? 'bg-emerald-100 text-emerald-700' : g === 'B' ? 'bg-blue-50 text-blue-600' : 'bg-slate-100 text-slate-500';
  return <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-black ${cls}`}>{Math.round(score)}{g ? ` ${g}` : ''}</span>;
}

// Live, current-time strength: the strategy re-evaluated NOW, with a trend arrow vs the
// strength it had when the signal first fired (so you see whether it's holding up).
function CurrentStrength({ item }: { item: StrategyEntryWatchItem }) {
  const trend = item.strengthTrend;
  if (trend === 'GONE') {
    return (
      <div className="leading-tight">
        <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-black bg-slate-200 text-slate-500" title="The strategy no longer confirms this setup live">no longer confirms</span>
        <div className="mt-0.5 text-[9px] font-semibold text-slate-400">fired at {item.score != null ? Math.round(item.score) : '—'}{item.grade ? ` ${item.grade}` : ''}</div>
      </div>
    );
  }
  const arrow = trend === 'STRONGER' ? <TrendingUp size={11} className="text-emerald-600" /> : trend === 'WEAKER' ? <TrendingDown size={11} className="text-amber-600" /> : null;
  return (
    <div className="leading-tight">
      <div className="flex items-center gap-1">{scorePill(item.currentScore, item.currentGrade)}{arrow}</div>
      <div className="mt-0.5 text-[9px] font-semibold text-slate-400" title="Strength when the signal first fired">
        {trend === 'SAME' ? 'holding' : trend === 'STRONGER' ? 'strengthening' : 'weakening'} · fired {item.score != null ? Math.round(item.score) : '—'}
      </div>
    </div>
  );
}

function RiskBadge({ item }: { item: SignalTrackerItem }) {
  const map: Record<string, string> = {
    CLOSE_NOW: 'bg-rose-600 text-white',
    DANGER: 'bg-amber-500 text-white',
    CAUTION: 'bg-amber-100 text-amber-700 border border-amber-200',
    HEALTHY: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
    UNKNOWN: 'bg-slate-100 text-slate-400',
  };
  const label = item.status === 'STOPPED' ? 'STOPPED'
    : item.status.endsWith('_HIT') ? item.status.replace('_', ' ')
    : item.riskState;
  return <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-black ${map[item.riskState] || map.UNKNOWN}`}>
    {item.riskState === 'CLOSE_NOW' && <AlertTriangle size={11} />}
    {item.riskState === 'HEALTHY' && <ShieldCheck size={11} />}
    {label}
  </span>;
}

function PnL({ item }: { item: SignalTrackerItem }) {
  const r = item.currentR;
  const cls = r === null ? 'text-slate-400' : r > 0 ? 'text-emerald-600' : r < 0 ? 'text-rose-600' : 'text-slate-500';
  return (
    <div className="text-right">
      <div className={`font-mono font-bold ${cls}`}>{item.currentPips != null ? `${item.currentPips > 0 ? '+' : ''}${item.currentPips}p` : '—'}</div>
      <div className={`font-mono text-[11px] ${cls}`}>{r != null ? `${r > 0 ? '+' : ''}${r}R` : ''}</div>
    </div>
  );
}

// Progress along entry → TP1, with current price position (capped 0–100).
function ProgressBar({ item }: { item: SignalTrackerItem }) {
  const { entryPrice: e, stopLoss: sl, takeProfit1: tp, currentPrice: cur, direction } = item;
  if (e === null || sl === null || tp === null || cur === null) return <span className="text-slate-300 text-xs">—</span>;
  const up = /BUY/.test(direction);
  const lo = Math.min(sl, tp), hi = Math.max(sl, tp);
  const pct = Math.max(0, Math.min(100, ((cur - lo) / (hi - lo)) * 100));
  const entryPct = Math.max(0, Math.min(100, ((e - lo) / (hi - lo)) * 100));
  return (
    <div className="relative h-2.5 w-28 rounded-full bg-gradient-to-r from-rose-200 via-slate-100 to-emerald-200" title={`SL ${fmt(sl)} · Entry ${fmt(e)} · TP1 ${fmt(tp)} · Now ${fmt(cur)}`}>
      <div className="absolute top-1/2 h-3 w-0.5 -translate-y-1/2 bg-slate-400" style={{ left: `${entryPct}%` }} />
      <div className={`absolute top-1/2 h-3.5 w-1.5 -translate-y-1/2 rounded-full ${up ? 'bg-emerald-600' : 'bg-rose-600'}`} style={{ left: `calc(${pct}% - 3px)` }} />
    </div>
  );
}

// ── Existing live-trade health view ─────────────────────────────────────────
function LiveTradesTab({ data, loading, markDone, doneIds }: {
  data: SignalTrackerResponse | null; loading: boolean;
  markDone: (id: string) => void; doneIds: Set<string>;
}) {
  const items = (data?.items || []).filter((i) => !doneIds.has(i.id));
  const closeNow = items.filter((i) => i.riskState === 'CLOSE_NOW');
  const danger = items.filter((i) => i.riskState === 'DANGER');

  return (
    <div className="space-y-5">
      {closeNow.length > 0 && (
        <div className="rounded-2xl border border-rose-300 bg-rose-50 p-4">
          <div className="flex items-center gap-2 text-rose-700 font-black"><AlertTriangle size={18} /> {closeNow.length} trade{closeNow.length > 1 ? 's' : ''} flagged CLOSE NOW</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {closeNow.map((i) => (
              <span key={i.id} className="rounded-lg border border-rose-200 bg-white px-2.5 py-1 text-[12px] font-bold text-rose-700">{i.symbol} {i.timeframe} {i.direction.replace('_', ' ')} · {i.currentR != null ? `${i.currentR}R` : ''} · {i.warningReason}</span>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-card"><div className="text-[11px] font-bold uppercase text-slate-400">Tracking</div><div className="text-2xl font-black text-slate-900">{items.length}</div></div>
        <div className="rounded-2xl border border-rose-200 bg-rose-50/50 p-3 shadow-card"><div className="text-[11px] font-bold uppercase text-rose-500">Close now</div><div className="text-2xl font-black text-rose-700">{closeNow.length}</div></div>
        <div className="rounded-2xl border border-amber-200 bg-amber-50/50 p-3 shadow-card"><div className="text-[11px] font-bold uppercase text-amber-500">Danger</div><div className="text-2xl font-black text-amber-700">{danger.length}</div></div>
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-3 shadow-card"><div className="text-[11px] font-bold uppercase text-emerald-600">Healthy</div><div className="text-2xl font-black text-emerald-700">{items.filter((i) => i.riskState === 'HEALTHY').length}</div></div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white shadow-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="border-b border-slate-100 text-[10px] uppercase tracking-[0.15em] text-slate-500">
              <tr>
                <th className="px-3 py-2">Signal</th>
                <th className="px-3 py-2">Dir</th>
                <th className="px-3 py-2 text-right">Entry / SL / TP1</th>
                <th className="px-3 py-2 text-right">Now</th>
                <th className="px-3 py-2">Progress</th>
                <th className="px-3 py-2 text-right">P&amp;L</th>
                <th className="px-3 py-2 text-right">Live $</th>
                <th className="px-3 py-2">State</th>
                <th className="px-3 py-2">What to do</th>
                <th className="px-3 py-2 text-center">Done</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {items.length ? items.map((i) => (
                <tr key={i.id} className={`hover:bg-slate-50/70 ${i.riskState === 'CLOSE_NOW' ? 'bg-rose-50/40' : ''}`}>
                  <td className="px-3 py-2">
                    <div className="font-black text-slate-900">{i.symbol} <span className="text-[10px] font-bold text-slate-400">{i.timeframe}</span></div>
                    <div className="flex items-center gap-1 text-[10px] font-semibold text-slate-400">
                      {i.source === 'email' ? <><Mail size={10} /> emailed</> : <><Cpu size={10} /> system</>} · {fmtTime(i.signalTime)}
                    </div>
                  </td>
                  <td className="px-3 py-2"><DirTag d={i.direction} /></td>
                  <td className="px-3 py-2 text-right font-mono text-[11px] text-slate-500">{fmt(i.entryPrice)} / {fmt(i.stopLoss)} / {fmt(i.takeProfit1)}</td>
                  <td className="px-3 py-2 text-right font-mono">{fmt(i.currentPrice)}</td>
                  <td className="px-3 py-2"><ProgressBar item={i} /></td>
                  <td className="px-3 py-2"><PnL item={i} /></td>
                  <td className="px-3 py-2 text-right font-mono">{i.unrealizedProfit != null ? <span className={i.unrealizedProfit >= 0 ? 'text-emerald-600 font-bold' : 'text-rose-600 font-bold'}>{i.unrealizedProfit}</span> : <span className="text-slate-300">—</span>}</td>
                  <td className="px-3 py-2"><RiskBadge item={i} /></td>
                  <td className="px-3 py-2 text-[12px]">
                    <div className="font-semibold text-slate-700">{i.warningReason}</div>
                    {i.riskState !== 'HEALTHY' && <div className="text-[11px] text-slate-500">→ {i.suggestedAction}</div>}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <button
                      type="button"
                      onClick={() => markDone(i.id)}
                      title="I closed this trade — stop tracking & alerting"
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-bold text-slate-600 hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700"
                    >
                      <Check size={12} /> Done
                    </button>
                  </td>
                </tr>
              )) : (
                <tr><td colSpan={10} className="px-3 py-10 text-center text-sm font-medium text-slate-400">{loading ? 'Loading…' : 'No active signals being tracked right now.'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {data?.note && <p className="text-[11px] font-medium text-slate-400 px-1">{data.note}</p>}
    </div>
  );
}

// Executability verdict — the whole point of this tab: is the setup strong enough to
// take RIGHT NOW (price at entry + still confirms), or wait for a better position.
function ExecPill({ item }: { item: StrategyEntryWatchItem }) {
  const map: Record<string, { cls: string; label: string; icon: React.ReactNode }> = {
    EXECUTE_NOW: { cls: 'bg-emerald-600 text-white', label: 'EXECUTE NOW', icon: <Zap size={11} /> },
    WAIT: { cls: 'bg-amber-100 text-amber-700', label: 'WAIT', icon: <Target size={11} /> },
    CAUTION: { cls: 'bg-orange-100 text-orange-700 border border-orange-200', label: 'CAUTION', icon: <AlertTriangle size={11} /> },
    MISSED: { cls: 'bg-slate-100 text-slate-400', label: 'MISSED', icon: null },
  };
  const m = map[item.executability] || map.WAIT;
  return (
    <div className="min-w-[150px]">
      <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-black ${m.cls}`}>{m.icon}{m.label}</span>
      {item.execMessage && <p className="mt-0.5 max-w-[230px] text-[10px] font-medium leading-tight text-slate-400" title={item.execMessage}>{item.execMessage}</p>}
    </div>
  );
}

function SourceChips({ popupSent, emailSent }: { popupSent: boolean | null; emailSent: boolean | null }) {
  return (
    <div className="flex items-center gap-1">
      <span className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-black ${popupSent ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-300'}`} title={popupSent ? 'Surfaced by system (live popup)' : 'No popup'}><Radio size={9} /> SYS</span>
      <span className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-black ${emailSent ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-300'}`} title={emailSent ? 'Sent by email' : 'Not emailed'}><Mail size={9} /> MAIL</span>
    </div>
  );
}

// ── New tab: A/A+ ICT · ICT+ · SMC forex signals waiting for the entry fill ──
function EntryWatchTab() {
  const [items, setItems] = useState<StrategyEntryWatchItem[]>([]);
  const [meta, setMeta] = useState<{ minScore: number; windowHours: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seenExecutable = useRef<Set<string>>(new Set());
  const firstLoad = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await fetchStrategyEntryWatch();
      setItems(res.items);
      setMeta({ minScore: res.minScore, windowHours: res.windowHours });
      setError(null);

      // Notify the moment a tracked signal becomes EXECUTABLE NOW — price has reached the
      // entry AND the setup still confirms its strength live (skip the first load so we
      // don't fire for everything already executable when the page opens).
      const executable = res.items.filter((i) => i.executableNow);
      if (!firstLoad.current) {
        for (const i of executable) {
          if (!seenExecutable.current.has(i.id)) {
            playAlertSound();
            showBrowserNotification(`✅ Executable now: ${i.symbol} ${i.timeframe}`, {
              body: `${i.strategyName} · ${i.direction.replace('_', ' ')} @ ${px(i.entryPrice, i.symbol)} · strength ${i.currentGrade || i.grade || ''} ${i.currentScore ?? i.score ?? ''} · SL ${px(i.stopLoss, i.symbol)} · ${i.lots ?? '?'} lots`,
              tag: `entrywatch-${i.id}`,
            });
          }
        }
      }
      seenExecutable.current = new Set(executable.map((i) => i.id));
      firstLoad.current = false;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load entry watch');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), ENTRY_WATCH_REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const executable = items.filter((i) => i.executability === 'EXECUTE_NOW');
  const waiting = items.filter((i) => i.executability === 'WAIT');
  const caution = items.filter((i) => i.executability === 'CAUTION');

  return (
    <div className="space-y-5">
      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">{error}</div>}

      {executable.length > 0 && (
        <div className="rounded-2xl border border-emerald-300 bg-emerald-50 p-4">
          <div className="flex items-center gap-2 font-black text-emerald-700"><Zap size={18} /> {executable.length} signal{executable.length > 1 ? 's' : ''} executable now</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {executable.map((i) => (
              <span key={i.id} className="rounded-lg border border-emerald-200 bg-white px-2.5 py-1 text-[12px] font-bold text-emerald-700">{i.symbol} {i.timeframe} {i.direction.replace('_', ' ')} @ {px(i.entryPrice, i.symbol)} · {i.strategyName} · {i.currentGrade || i.grade || ''} {i.currentScore ?? i.score ?? ''}</span>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-3 shadow-card"><div className="text-[11px] font-bold uppercase text-emerald-600">Execute now</div><div className="text-2xl font-black text-emerald-700">{executable.length}</div></div>
        <div className="rounded-2xl border border-amber-200 bg-amber-50/50 p-3 shadow-card"><div className="text-[11px] font-bold uppercase text-amber-500">Wait</div><div className="text-2xl font-black text-amber-700">{waiting.length}</div></div>
        <div className="rounded-2xl border border-orange-200 bg-orange-50/50 p-3 shadow-card"><div className="text-[11px] font-bold uppercase text-orange-500">Caution</div><div className="text-2xl font-black text-orange-700">{caution.length}</div></div>
        <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-card"><div className="text-[11px] font-bold uppercase text-slate-400">Filter</div><div className="text-sm font-black text-slate-700">{meta ? `A/A+ ≥ ${meta.minScore} · ${meta.windowHours}h` : '—'}</div></div>
      </div>

      <p className="px-1 text-[11px] font-medium text-slate-400">
        ICT · ICT+ · all SMC strategies. Grade A / A+ forex signals (score ≥ {meta?.minScore ?? 80}). Strength is re-evaluated
        live, so each row tells you whether it's strong enough to <strong>execute now</strong> (price at entry + still confirms) or
        to <strong>wait for a better position</strong> — with a desktop alert + sound the moment one becomes executable.
      </p>

      <div className="rounded-2xl border border-slate-200 bg-white shadow-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1040px] text-left text-sm">
            <thead className="border-b border-slate-100 text-[10px] uppercase tracking-[0.15em] text-slate-500">
              <tr>
                <th className="px-3 py-2">Symbol</th>
                <th className="px-3 py-2">Signal Time</th>
                <th className="px-3 py-2">Strength now</th>
                <th className="px-3 py-2 text-right">Entry</th>
                <th className="px-3 py-2 text-right">Current</th>
                <th className="px-3 py-2 text-right">Pips Diff</th>
                <th className="px-3 py-2 text-right">SL</th>
                <th className="px-3 py-2 text-right">Vol</th>
                <th className="px-3 py-2 text-right">TP</th>
                <th className="px-3 py-2">Dir</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Src</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {items.length ? items.map((i) => (
                <tr key={i.id} className={`hover:bg-slate-50/70 ${i.executability === 'EXECUTE_NOW' ? 'bg-emerald-50/50' : i.executability === 'MISSED' ? 'opacity-50' : ''}`}>
                  <td className="px-3 py-2">
                    <div className="font-black text-slate-900">{i.symbol} <span className="text-[10px] font-bold text-slate-400">{i.timeframe}</span></div>
                    <div className="text-[10px] font-semibold text-slate-400">{i.strategyName}</div>
                  </td>
                  <td className="px-3 py-2 text-[11px] font-semibold text-slate-500">{fmtTime(i.signalTime)}</td>
                  <td className="px-3 py-2"><CurrentStrength item={i} /></td>
                  <td className="px-3 py-2 text-right font-mono text-slate-700">{px(i.entryPrice, i.symbol)}</td>
                  <td className="px-3 py-2 text-right font-mono font-bold text-slate-900">{px(i.currentPrice, i.symbol)}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {i.pipsToEntry == null ? <span className="text-slate-300">—</span>
                      : i.pipsToEntry <= 0
                        ? <span className="font-bold text-emerald-600" title="Price has reached / passed the entry">{i.pipsToEntry}p ✓</span>
                        : <span className="text-amber-600" title="Pips price must still move to reach entry">{i.pipsToEntry}p</span>}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-rose-600">{px(i.stopLoss, i.symbol)}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-600">{i.lots != null ? i.lots : '—'}</td>
                  <td className="px-3 py-2 text-right font-mono text-emerald-700">{px(i.takeProfit1, i.symbol)}</td>
                  <td className="px-3 py-2"><DirTag d={i.direction} /></td>
                  <td className="px-3 py-2"><ExecPill item={i} /></td>
                  <td className="px-3 py-2"><SourceChips popupSent={i.popupSent} emailSent={i.emailSent} /></td>
                </tr>
              )) : (
                <tr><td colSpan={12} className="px-3 py-10 text-center text-sm font-medium text-slate-400">{loading ? 'Loading…' : 'No A/A+ ICT · SMC signals waiting for entry right now.'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

type Tab = 'live' | 'entry';

export default function SignalTracker() {
  const [tab, setTab] = useState<Tab>('live');
  const [data, setData] = useState<SignalTrackerResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchSignalTracker());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load signal tracker');
    } finally {
      setLoading(false);
    }
  }, []);

  const markDone = useCallback(async (id: string) => {
    setDoneIds((prev) => new Set(prev).add(id));  // optimistic remove
    try {
      await markSignalTrackerDone(id);
    } catch {
      setDoneIds((prev) => { const n = new Set(prev); n.delete(id); return n; });  // revert on failure
      setError('Failed to mark trade as done — try again.');
    }
  }, []);

  useEffect(() => {
    if (tab !== 'live') return;
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [load, tab]);

  return (
    <div className="space-y-5 p-1">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-indigo-100 p-2"><Radar className="text-indigo-600" size={22} /></div>
          <div>
            <h1 className="text-xl font-black text-slate-900">Signal Tracker</h1>
            <p className="text-xs font-medium text-slate-400">Live health of given signals — P&amp;L, danger detection, and a high-grade entry watch.</p>
          </div>
        </div>
        {tab === 'live' && (
          <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-bold text-white hover:bg-slate-700 disabled:opacity-50">
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Refresh
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-slate-200">
        <button
          type="button"
          onClick={() => setTab('live')}
          className={`-mb-px flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm font-bold transition ${tab === 'live' ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
        >
          <Radar size={15} /> Live Trades
        </button>
        <button
          type="button"
          onClick={() => setTab('entry')}
          className={`-mb-px flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm font-bold transition ${tab === 'entry' ? 'border-emerald-500 text-emerald-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
        >
          <Crosshair size={15} /> Entry Watch <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-black text-emerald-600">A / A+</span>
        </button>
      </div>

      {error && tab === 'live' && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">{error}</div>}

      {tab === 'live'
        ? <LiveTradesTab data={data} loading={loading} markDone={(id) => void markDone(id)} doneIds={doneIds} />
        : <EntryWatchTab />}
    </div>
  );
}
