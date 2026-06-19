import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Target, Clock, TrendingUp, TrendingDown, Sparkles, RefreshCw, Calculator,
  CheckCircle2, XCircle, MinusCircle, Gauge, Timer, Crosshair, Loader2, Info,
  Bell, BellOff, Bookmark, Save, Check, Trash2, Trophy, HelpCircle, X,
} from 'lucide-react';
import {
  fetchProjectionScan,
  triggerProjectionAnalysis,
  scheduleProjectionReminder,
  fetchActiveProjectionReminders,
  deleteProjectionReminder,
  saveProjection,
  fetchSavedProjections,
  updateSavedProjectionOutcome,
  deleteSavedProjection,
  fetchProjectionTrackRecord,
} from '../mt5Api';
import type {
  ProjectionSymbolResult, ProjectionItem, ProjectionAiResult, ProjectionAiValidation,
  ProjectionReminder, SavedProjection, ProjectionTrackRecord, ProjectionTrackBucket,
} from '../types';

const TIMEFRAMES = ['M5', 'M15', 'M30', 'H1'];

function digitsFor(symbol: string) {
  const s = symbol.toUpperCase();
  return /XAU|GOLD|XAG/.test(s) ? 2 : /JPY/.test(s) ? 3 : 5;
}
function px(v: number | null, symbol: string) {
  if (v === null || v === undefined || Number.isNaN(v)) return 'n/a';
  return Number(v).toFixed(digitsFor(symbol));
}
/** Absolute clock in Bangladesh time (Asia/Dhaka), matching the dashboard timezone. */
function bdClock(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Dhaka' });
}
function relFromMs(targetMs: number, now: number) {
  const m = Math.round((targetMs - now) / 60000);
  if (m <= 0) return 'due now';
  if (m < 60) return `in ${m}m`;
  return `in ${Math.floor(m / 60)}h ${m % 60}m`;
}
function trendBadge(t: string) {
  if (t === 'BULLISH') return 'bg-emerald-100 text-emerald-700';
  if (t === 'BEARISH') return 'bg-rose-100 text-rose-700';
  return 'bg-slate-100 text-slate-500';
}
function confColor(c: number) {
  if (c >= 70) return 'text-emerald-600';
  if (c >= 50) return 'text-blue-600';
  return 'text-slate-600';
}

function AiStatusBadge({ status }: { status: ProjectionAiValidation['status'] }) {
  if (status === 'APPROVED') {
    return <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500 px-2 py-0.5 text-[10px] font-black uppercase text-white"><CheckCircle2 size={12} /> Approved</span>;
  }
  if (status === 'REJECTED') {
    return <span className="inline-flex items-center gap-1 rounded-md bg-rose-500 px-2 py-0.5 text-[10px] font-black uppercase text-white"><XCircle size={12} /> Rejected</span>;
  }
  return <span className="inline-flex items-center gap-1 rounded-md bg-slate-400 px-2 py-0.5 text-[10px] font-black uppercase text-white"><MinusCircle size={12} /> Neutral</span>;
}

function DirPill({ dir }: { dir: 'UP' | 'DOWN' }) {
  return dir === 'UP'
    ? <span className="inline-flex items-center gap-1 rounded-lg bg-emerald-500 px-2.5 py-1 text-xs font-black text-white"><TrendingUp size={13} /> UP</span>
    : <span className="inline-flex items-center gap-1 rounded-lg bg-rose-500 px-2.5 py-1 text-xs font-black text-white"><TrendingDown size={13} /> DOWN</span>;
}

function Toggle({ on, onChange, label, accent }: { on: boolean; onChange: (v: boolean) => void; label: React.ReactNode; accent: string }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      className="flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 shadow-sm transition hover:bg-slate-50"
    >
      <span className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${on ? accent : 'bg-slate-300'}`}>
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${on ? 'translate-x-4' : 'translate-x-0.5'}`} />
      </span>
      <span className="text-sm font-bold text-slate-700">{label}</span>
    </button>
  );
}

export default function Projections() {
  const [timeframe, setTimeframe] = useState('M15');
  const [suitabilityFilter, setSuitabilityFilter] = useState<'ALL' | 'FOREX' | 'FTT' | 'SAVED'>('ALL');
  const [mathOn, setMathOn] = useState(true);
  const [aiOn, setAiOn] = useState(false);
  const [results, setResults] = useState<ProjectionSymbolResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [aiBySymbol, setAiBySymbol] = useState<Record<string, ProjectionAiResult>>({});
  const [aiBusy, setAiBusy] = useState<Record<string, boolean>>({});
  const [aiError, setAiError] = useState<Record<string, string>>({});

  // Reminders & Saved observation states
  const [activeReminders, setActiveReminders] = useState<{ id: string; projection_id: string }[]>([]);
  const [savedProjections, setSavedProjections] = useState<SavedProjection[]>([]);
  const [trackRecord, setTrackRecord] = useState<ProjectionTrackRecord | null>(null);
  const [reminderModalProjection, setReminderModalProjection] = useState<ProjectionItem | null>(null);
  const [reminderEmail, setReminderEmail] = useState(() => localStorage.getItem('alert_email') || 'aarsayem002@gmail.com');
  const [schedulingReminder, setSchedulingReminder] = useState(false);
  const [savingIds, setSavingIds] = useState<Record<string, boolean>>({});

  const loadRemindersAndSaved = useCallback(async () => {
    try {
      const remindersRes = await fetchActiveProjectionReminders();
      if (remindersRes.ok) {
        setActiveReminders(remindersRes.activeReminders || []);
      }
      
      const savedRes = await fetchSavedProjections();
      if (savedRes.ok) {
        setSavedProjections(savedRes.savedProjections || []);
      }

      const tr = await fetchProjectionTrackRecord();
      if (tr.ok) setTrackRecord(tr);
    } catch (e) {
      console.error('Failed to load reminders or saved projections:', e);
    }
  }, []);

  // Measured hit-rate per grade, for honest per-projection probability labels.
  const gradeHitRate = useMemo(() => {
    const map = new Map<string, ProjectionTrackBucket>();
    for (const b of trackRecord?.byGrade || []) map.set(b.value, b);
    return map;
  }, [trackRecord]);

  useEffect(() => {
    void loadRemindersAndSaved();
  }, [loadRemindersAndSaved]);

  useEffect(() => {
    const t = setInterval(() => void loadRemindersAndSaved(), 15000);
    return () => clearInterval(t);
  }, [loadRemindersAndSaved]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const loadScan = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchProjectionScan(timeframe, force);
      setResults(res.results || []);
      setGeneratedAt(res.generatedAt || null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load projections');
    } finally {
      setLoading(false);
    }
  }, [timeframe]);

  // Fetch math projections on mount / timeframe change, and refresh every 60s
  // while the deterministic layer is enabled. The cache server-side is also 60s.
  useEffect(() => {
    if (!mathOn) return;
    void loadScan(false);
    const t = setInterval(() => void loadScan(false), 60000);
    return () => clearInterval(t);
  }, [mathOn, loadScan]);

  const runAi = useCallback(async (symbol: string) => {
    setAiBusy((prev) => ({ ...prev, [symbol]: true }));
    setAiError((prev) => ({ ...prev, [symbol]: '' }));
    try {
      const res = await triggerProjectionAnalysis(symbol, timeframe);
      setAiBySymbol((prev) => ({ ...prev, [symbol]: res.ai }));
      // Keep the freshest math zones the AI actually validated.
      if (res.projection) {
        setResults((prev) => prev.map((r) => (r.symbol === symbol ? { ...res.projection } : r)));
      }
    } catch (e) {
      setAiError((prev) => ({ ...prev, [symbol]: e instanceof Error ? e.message : 'AI analysis failed' }));
    } finally {
      setAiBusy((prev) => ({ ...prev, [symbol]: false }));
    }
  }, [timeframe]);

  // Reset AI verdicts whenever the timeframe changes (zones differ per TF).
  useEffect(() => {
    setAiBySymbol({});
    setAiError({});
  }, [timeframe]);

  const handleScheduleReminder = async () => {
    if (!reminderModalProjection) return;
    setSchedulingReminder(true);
    try {
      const p = reminderModalProjection;
      const res = await scheduleProjectionReminder({
        projection_id: p.id,
        symbol: p.symbol,
        timeframe: p.timeframe,
        bias: p.bias,
        entryPrice: p.entryPrice,
        stopLoss: p.stopLoss,
        takeProfit1: p.takeProfit1,
        takeProfit2: p.takeProfit2,
        suitability: p.suitability,
        projectedTouchMs: p.projectedTouchMs,
        email: reminderEmail,
        mathConfidence: p.mathConfidence,
        grade: p.grade || 'C Setup',
        rationale: p.rationale,
        ai_on: aiOn,
      });

      if (res.ok) {
        localStorage.setItem('alert_email', reminderEmail);
        setReminderModalProjection(null);
        await loadRemindersAndSaved();
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to schedule reminder');
    } finally {
      setSchedulingReminder(false);
    }
  };

  const handleCancelReminder = async (projectionId: string) => {
    const match = activeReminders.find(r => r.projection_id === projectionId);
    if (!match) return;
    try {
      const res = await deleteProjectionReminder(match.id);
      if (res.ok) {
        await loadRemindersAndSaved();
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to cancel reminder');
    }
  };

  const handleSaveSetup = async (p: ProjectionItem) => {
    setSavingIds(prev => ({ ...prev, [p.id]: true }));
    try {
      const res = await saveProjection({
        projection_id: p.id,
        symbol: p.symbol,
        timeframe: p.timeframe,
        bias: p.bias,
        entryPrice: p.entryPrice,
        stopLoss: p.stopLoss,
        takeProfit1: p.takeProfit1,
        takeProfit2: p.takeProfit2,
        suitability: p.suitability,
        projectedTouchMs: p.projectedTouchMs,
        mathConfidence: p.mathConfidence,
        grade: p.grade || 'C Setup',
        rationale: p.rationale,
      });

      if (res.ok) {
        await loadRemindersAndSaved();
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to save setup');
    } finally {
      setSavingIds(prev => ({ ...prev, [p.id]: false }));
    }
  };

  const handleUpdateOutcome = async (id: string, outcome: 'WIN' | 'LOSS' | 'DRAW' | 'PENDING') => {
    try {
      const res = await updateSavedProjectionOutcome(id, outcome);
      if (res.ok) {
        await loadRemindersAndSaved();
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to update outcome');
    }
  };

  const handleDeleteSaved = async (id: string) => {
    if (!confirm('Are you sure you want to delete this saved projection?')) return;
    try {
      const res = await deleteSavedProjection(id);
      if (res.ok) {
        await loadRemindersAndSaved();
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to delete setup');
    }
  };

  const filteredResults = useMemo(() => {
    return results.map((r) => {
      const filteredProjections = r.projections.filter((p) => {
        if (suitabilityFilter === 'FOREX') return p.suitability.forex;
        if (suitabilityFilter === 'FTT') return p.suitability.ftt;
        return true;
      });
      return {
        ...r,
        projections: filteredProjections,
      };
    });
  }, [results, suitabilityFilter]);

  const withProjections = useMemo(
    () => filteredResults.filter((r) => r.projections && r.projections.length > 0),
    [filteredResults],
  );

  const totalZones = useMemo(
    () => withProjections.reduce((sum, r) => sum + r.projections.length, 0),
    [withProjections],
  );

  const renderProjection = (p: ProjectionItem, ai?: ProjectionAiValidation) => {
    const isBuy = p.orderType === 'BUY_LIMIT';
    return (
      <div key={p.id} className={`rounded-2xl border border-slate-200 border-l-4 ${isBuy ? 'border-l-emerald-400' : 'border-l-rose-400'} bg-white p-4 shadow-sm`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className={`rounded-md px-2 py-0.5 text-[10px] font-black uppercase ${isBuy ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
              {p.orderType.replace('_', ' ')}
            </span>
            <span className="rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-black uppercase text-slate-600">{p.source}</span>
            <span className="text-[11px] font-bold text-slate-400">bounce</span>
            <DirPill dir={p.directionAfterTouch} />
            {p.grade && (
              <span className={`inline-flex rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wider border shadow-sm ${
                p.grade.includes('A+') ? 'bg-emerald-600 text-white border-emerald-700 animate-pulse' :
                p.grade.includes('A') ? 'bg-emerald-50 text-emerald-800 border-emerald-200' :
                p.grade.includes('B') ? 'bg-blue-50 text-blue-800 border-blue-200' :
                'bg-slate-100 text-slate-600 border-slate-200'
              }`}>
                {p.grade}
              </span>
            )}
          </div>
          {ai && <AiStatusBadge status={ai.status} />}
        </div>

        {/* Timing banner — math estimate + BD clock */}
        <div className="mt-3 flex items-center justify-between rounded-xl bg-slate-900 px-4 py-3 text-white">
          <div className="flex items-center gap-2">
            <Clock size={16} className="text-amber-400" />
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Projected touch (BD time)</p>
              <p className="text-base font-black leading-tight">
                {bdClock(p.projectedTouchIso)} <span className="font-mono text-amber-400">({relFromMs(p.projectedTouchMs, now)})</span>
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">~Candles</p>
            <p className="text-base font-black leading-tight">{p.candlesToReach.toFixed(1)}</p>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
          <div className="rounded-xl bg-slate-50 p-2"><p className="text-[10px] font-bold uppercase text-slate-400">Entry</p><p className="font-mono text-sm font-black text-slate-900">{px(p.entryPrice, p.symbol)}</p></div>
          <div className="rounded-xl bg-slate-50 p-2"><p className="text-[10px] font-bold uppercase text-slate-400">Stop</p><p className="font-mono text-sm font-black text-rose-600">{px(p.stopLoss, p.symbol)}</p></div>
          <div className="rounded-xl bg-slate-50 p-2"><p className="text-[10px] font-bold uppercase text-slate-400">TP1 / TP2</p><p className="font-mono text-sm font-black text-emerald-600">{px(p.takeProfit1, p.symbol)}</p></div>
          <div className="rounded-xl bg-slate-50 p-2"><p className="text-[10px] font-bold uppercase text-slate-400">Distance</p><p className="font-mono text-sm font-black text-slate-900">{p.distancePips.toFixed(1)} pips</p></div>
        </div>

        {/* Suitability + R:R + math confidence */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {p.suitability.forex && <span className="rounded-md bg-sky-50 px-2 py-0.5 text-[10px] font-black uppercase text-sky-700">Forex Limit</span>}
          {p.suitability.ftt && <span className="rounded-md bg-indigo-50 px-2 py-0.5 text-[10px] font-black uppercase text-indigo-700">FTT · {p.suitability.fttExpiry} expiry</span>}
          <span className="rounded-md bg-slate-50 px-2 py-0.5 text-[10px] font-black uppercase text-slate-600">R:R {p.riskReward}</span>
          {(() => {
            const tr = p.grade ? gradeHitRate.get(p.grade) : undefined;
            if (!tr || tr.hitRate === null || tr.settled < 1) return null;
            return (
              <span
                title={`Measured: ${tr.wins} win / ${tr.losses} loss settled · ${tr.confidence} sample. Historical hit-rate of "${p.grade}" projections — not a guarantee.`}
                className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-2 py-0.5 text-[10px] font-black text-white"
              >
                <Trophy size={11} className="text-amber-400" /> {tr.hitRate}% hist
                <span className="font-semibold text-slate-300">({tr.settled})</span>
              </span>
            );
          })()}
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-slate-500">
            <Gauge size={13} /> Math <b className={confColor(p.mathConfidence)}>{p.mathConfidence}</b>
          </span>
        </div>

        <p className="mt-2 text-[11px] font-semibold text-slate-500">{p.rationale}</p>

        {/* AI validation detail (only present when user ran AI for this symbol) */}
        {ai && (
          <div className="mt-3 rounded-xl border border-violet-100 bg-violet-50/60 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1 text-[11px] font-black uppercase tracking-wider text-violet-700"><Sparkles size={13} /> AI Validation</span>
              <span className={`text-sm font-black ${confColor(ai.confidence)}`}>{Math.round(ai.confidence)}%</span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
              <div className="rounded-lg bg-white p-2"><p className="text-[9px] font-bold uppercase text-slate-400">Optimal entry</p><p className="font-mono text-xs font-black text-slate-900">{px(ai.optimal_entry, p.symbol)}</p></div>
              <div className="rounded-lg bg-white p-2"><p className="text-[9px] font-bold uppercase text-slate-400">AI Stop</p><p className="font-mono text-xs font-black text-rose-600">{px(ai.stop_loss, p.symbol)}</p></div>
              <div className="rounded-lg bg-white p-2"><p className="text-[9px] font-bold uppercase text-slate-400">AI TP</p><p className="font-mono text-xs font-black text-emerald-600">{px(ai.take_profit, p.symbol)}</p></div>
              <div className="rounded-lg bg-white p-2"><p className="text-[9px] font-bold uppercase text-slate-400">Time to reach</p><p className="text-[11px] font-black text-slate-900">{ai.predicted_time_to_reach || 'n/a'}</p></div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {ai.trade_type?.map((t) => (
                <span key={t} className="rounded bg-white px-2 py-0.5 text-[10px] font-black uppercase text-slate-600">{t}</span>
              ))}
              {ai.ftt_expiry_recommended && <span className="rounded bg-white px-2 py-0.5 text-[10px] font-black uppercase text-indigo-700">FTT {ai.ftt_expiry_recommended}</span>}
            </div>
            {ai.rationale && <p className="mt-2 text-[11px] font-semibold text-violet-900/80">{ai.rationale}</p>}
          </div>
        )}

        {/* Action Buttons */}
        <div className="mt-4 flex gap-2 border-t border-slate-100 pt-3">
          {(() => {
            const hasReminder = activeReminders.some(r => r.projection_id === p.id);
            const isAlreadySaved = savedProjections.some(s => s.projection_id === p.id);
            const isSaving = !!savingIds[p.id];

            return (
              <>
                {hasReminder ? (
                  <button
                    type="button"
                    onClick={() => void handleCancelReminder(p.id)}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700 transition hover:bg-rose-100"
                  >
                    <BellOff size={14} /> Cancel Alert
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setReminderModalProjection(p)}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 transition hover:bg-slate-50 hover:border-slate-300"
                  >
                    <Bell size={14} className="text-indigo-500" /> Remind Me
                  </button>
                )}

                {isAlreadySaved ? (
                  <button
                    type="button"
                    disabled
                    className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700 opacity-80"
                  >
                    <Check size={14} /> Saved Setup
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={isSaving}
                    onClick={() => void handleSaveSetup(p)}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 transition hover:bg-slate-50 hover:border-slate-300"
                  >
                    {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Bookmark size={14} className="text-amber-500" />}
                    Save Setup
                  </button>
                )}
              </>
            );
          })()}
        </div>
      </div>
    );
  };

  const renderSavedProjection = (p: SavedProjection) => {
    const isBuy = p.bias === 'BULLISH';
    
    const statusBg = 
      p.status === 'WIN' ? 'bg-emerald-500 text-white' :
      p.status === 'LOSS' ? 'bg-rose-500 text-white' :
      p.status === 'DRAW' ? 'bg-slate-500 text-white' :
      p.status === 'EXPIRED' ? 'bg-slate-400 text-white' :
      'bg-amber-500 text-white animate-pulse';

    return (
      <div key={p.id} className={`rounded-2xl border border-slate-200 border-l-4 ${isBuy ? 'border-l-emerald-400' : 'border-l-rose-400'} bg-white p-4 shadow-sm`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-black text-slate-900">{p.symbol}</span>
            <span className="rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-black uppercase text-slate-600">{p.timeframe}</span>
            <span className={`rounded-md px-2.5 py-0.5 text-[10px] font-black uppercase ${statusBg}`}>
              {p.status}
            </span>
            {p.grade && (
              <span className="inline-flex rounded-full px-2 py-0.5 text-[9px] font-black uppercase border border-slate-200 bg-slate-50 text-slate-600">
                {p.grade}
              </span>
            )}
          </div>
          <button 
            type="button" 
            onClick={() => void handleDeleteSaved(p.id)}
            className="text-slate-400 hover:text-rose-500 transition-colors p-1"
            title="Delete setup observation"
          >
            <Trash2 size={15} />
          </button>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
          <div className="rounded-xl bg-slate-50 p-2"><p className="text-[10px] font-bold uppercase text-slate-400">Entry</p><p className="font-mono text-xs font-black text-slate-900">{px(p.entry_price, p.symbol)}</p></div>
          <div className="rounded-xl bg-slate-50 p-2"><p className="text-[10px] font-bold uppercase text-slate-400">Stop</p><p className="font-mono text-xs font-black text-rose-600">{px(p.stop_loss, p.symbol)}</p></div>
          <div className="rounded-xl bg-slate-50 p-2"><p className="text-[10px] font-bold uppercase text-slate-400">TP1 / TP2</p><p className="font-mono text-xs font-black text-emerald-600">{px(p.take_profit_1, p.symbol)} / {px(p.take_profit_2, p.symbol)}</p></div>
          <div className="rounded-xl bg-slate-50 p-2"><p className="text-[10px] font-bold uppercase text-slate-400">Bias</p><p className={`text-xs font-black ${isBuy ? 'text-emerald-600' : 'text-rose-600'}`}>{p.bias}</p></div>
        </div>

        <p className="mt-2.5 text-[11px] font-semibold text-slate-500 leading-tight">
          <b>Rationale:</b> {p.rationale || 'No rationale saved.'}
        </p>

        <div className="mt-3 rounded-xl bg-slate-50 p-2.5 border border-slate-100">
          <div className="flex items-center justify-between text-[10px] font-black uppercase text-slate-400 mb-1.5">
            <span>Manual Outcome Override</span>
            {p.resolved_at && <span className="font-sans text-slate-500">Resolved: {bdClock(p.resolved_at)}</span>}
          </div>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => void handleUpdateOutcome(p.id, 'WIN')}
              className={`flex-1 py-1 px-2 text-[10px] font-bold rounded-lg border transition ${
                p.status === 'WIN' 
                  ? 'bg-emerald-500 border-emerald-500 text-white' 
                  : 'bg-white border-slate-200 text-slate-600 hover:bg-emerald-50 hover:border-emerald-200'
              }`}
            >
              🏆 Win
            </button>
            <button
              type="button"
              onClick={() => void handleUpdateOutcome(p.id, 'LOSS')}
              className={`flex-1 py-1 px-2 text-[10px] font-bold rounded-lg border transition ${
                p.status === 'LOSS' 
                  ? 'bg-rose-500 border-rose-500 text-white' 
                  : 'bg-white border-slate-200 text-slate-600 hover:bg-rose-50 hover:border-rose-200'
              }`}
            >
              ❌ Loss
            </button>
            <button
              type="button"
              onClick={() => void handleUpdateOutcome(p.id, 'DRAW')}
              className={`flex-1 py-1 px-2 text-[10px] font-bold rounded-lg border transition ${
                p.status === 'DRAW' 
                  ? 'bg-slate-600 border-slate-600 text-white' 
                  : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-100'
              }`}
            >
              🤝 Draw
            </button>
            <button
              type="button"
              onClick={() => void handleUpdateOutcome(p.id, 'PENDING')}
              className="py-1 px-2 text-[9px] font-bold rounded-lg border bg-white border-slate-200 text-slate-500 hover:bg-slate-100"
            >
              Reset
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderSymbol = (r: ProjectionSymbolResult) => {
    const ai = aiBySymbol[r.symbol];
    const busy = aiBusy[r.symbol];
    const aiMap = new Map<string, ProjectionAiValidation>();
    (ai?.validations || []).forEach((v) => aiMap.set(v.id, v));
    return (
      <section key={r.symbol} className="space-y-3 rounded-3xl border border-slate-200 bg-slate-50/60 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-2xl font-black text-slate-900">{r.symbol}</h3>
            <span className="rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-black text-slate-600">{r.timeframe}</span>
            <span className={`rounded-md px-2 py-0.5 text-[10px] font-black uppercase ${trendBadge(r.htfTrend)}`}>HTF {r.htfTrend}</span>
            <span className="text-xs font-bold text-slate-500">Price <b className="font-mono text-slate-900">{px(r.currentPrice, r.symbol)}</b></span>
            <span className="text-xs font-bold text-slate-500">ATR <b className="font-mono text-slate-900">{px(r.atr, r.symbol)}</b></span>
            <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-bold text-slate-600">{r.projections.length} zone{r.projections.length !== 1 ? 's' : ''}</span>
          </div>
          <button
            type="button"
            disabled={!aiOn || busy}
            onClick={() => runAi(r.symbol)}
            title={aiOn ? 'Validate these zones with Gemini AI' : 'Enable "Run AI Projection" first'}
            className={`inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-bold shadow-sm transition ${
              aiOn ? 'bg-violet-600 text-white hover:bg-violet-700' : 'cursor-not-allowed bg-slate-200 text-slate-400'
            } ${busy ? 'opacity-70' : ''}`}
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
            {busy ? 'Analyzing…' : ai ? 'Re-run AI' : 'Run AI'}
          </button>
        </div>

        {ai?.overall_summary && (
          <div className="rounded-xl border border-violet-100 bg-violet-50/60 px-3 py-2 text-[12px] font-semibold text-violet-900/80">
            <Sparkles size={13} className="mr-1 inline" /> {ai.overall_summary}
          </div>
        )}
        {aiError[r.symbol] && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] font-semibold text-amber-700">{aiError[r.symbol]}</div>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          {r.projections.map((p) => renderProjection(p, aiMap.get(p.id)))}
        </div>
      </section>
    );
  };

  return (
    <div className="terminal-page -m-6 min-h-screen space-y-8 bg-slate-50 p-6 lg:-m-10 lg:p-10">
      {/* Hero */}
      <div className="overflow-hidden rounded-3xl bg-gradient-to-br from-slate-900 via-slate-900 to-indigo-900 p-8 text-white shadow-xl">
        <p className="text-xs font-black uppercase tracking-[0.32em] text-amber-400">Math first · AI on demand</p>
        <h1 className="mt-2 flex items-center gap-3 text-4xl font-black tracking-tight"><Crosshair className="text-amber-400" size={34} /> Pullback &amp; Timing Projections</h1>
        <p className="mt-2 max-w-2xl text-sm font-medium text-slate-300">
          Deterministic projections of the next unmitigated Order Block / Fair Value Gap pullback entry — with an
          estimated clock time to reach it (distance ÷ ATR). Times shown in Bangladesh time. AI validation runs
          only when you switch on <b className="text-white">Run AI Projection</b> and click <b className="text-white">Run AI</b> for a symbol.
        </p>
        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl bg-white/5 p-4 backdrop-blur">
            <div className="flex items-center gap-2 text-amber-400"><Target size={15} /><span className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-300">Symbols w/ Zones</span></div>
            <p className="mt-1 text-3xl font-black">{withProjections.length}</p>
          </div>
          <div className="rounded-2xl bg-white/5 p-4 backdrop-blur">
            <div className="flex items-center gap-2 text-emerald-400"><Calculator size={15} /><span className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-300">Pullback Zones</span></div>
            <p className="mt-1 text-3xl font-black">{totalZones}</p>
          </div>
          <div className="rounded-2xl bg-white/5 p-4 backdrop-blur">
            <div className="flex items-center gap-2 text-violet-400"><Timer size={15} /><span className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-300">Last Math Scan</span></div>
            <p className="mt-1 text-xl font-black">{generatedAt ? bdClock(generatedAt) : '—'}</p>
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center gap-1.5">
          <span className="mr-1 text-xs font-black uppercase tracking-wider text-slate-400">Timeframe</span>
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              onClick={() => setTimeframe(tf)}
              className={`rounded-lg px-3 py-1.5 text-sm font-bold transition ${timeframe === tf ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
            >
              {tf}
            </button>
          ))}
        </div>
        <div className="h-6 w-px bg-slate-200" />
        <div className="flex items-center gap-1.5">
          <span className="mr-1 text-xs font-black uppercase tracking-wider text-slate-400">Filter / Feed</span>
          {(['ALL', 'FOREX', 'FTT', 'SAVED'] as const).map((type) => (
            <button
              key={type}
              onClick={() => setSuitabilityFilter(type)}
              className={`rounded-lg px-3 py-1.5 text-sm font-bold transition ${suitabilityFilter === type ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
            >
              {type === 'ALL' ? 'All Live' : type === 'FOREX' ? 'Forex (FT)' : type === 'FTT' ? 'Fixed-Time (FTT)' : 'Saved Observations'}
            </button>
          ))}
        </div>
        <div className="h-6 w-px bg-slate-200" />
        <Toggle on={mathOn} onChange={setMathOn} accent="bg-emerald-500" label={<span className="inline-flex items-center gap-1"><Calculator size={14} /> Mathematicals</span>} />
        <Toggle on={aiOn} onChange={setAiOn} accent="bg-violet-600" label={<span className="inline-flex items-center gap-1"><Sparkles size={14} /> Run AI Projection</span>} />
        <button
          onClick={() => void loadScan(true)}
          disabled={loading || !mathOn}
          className="ml-auto inline-flex items-center gap-2 rounded-xl bg-amber-500 px-4 py-2 text-sm font-bold text-white shadow-sm transition hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Refresh Math
        </button>
      </div>

      {/* Track record — measured hit-rate of saved projections (honest, never a guarantee) */}
      {trackRecord && (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Trophy size={16} className="text-amber-500" />
              <span className="text-xs font-black uppercase tracking-[0.18em] text-slate-500">Track Record</span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-black text-slate-900">{trackRecord.overall.hitRate !== null ? `${trackRecord.overall.hitRate}%` : '—'}</span>
              <span className="text-xs font-bold text-slate-400">measured hit-rate</span>
            </div>
            <div className="flex items-center gap-3 text-xs font-bold text-slate-500">
              <span className="text-emerald-600">{trackRecord.overall.wins}W</span>
              <span className="text-rose-600">{trackRecord.overall.losses}L</span>
              <span>{trackRecord.overall.settled} settled</span>
              <span className="text-slate-400">{trackRecord.overall.pending} pending · {trackRecord.overall.expired} expired</span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-black uppercase ${
                trackRecord.overall.confidence === 'strong' ? 'bg-emerald-100 text-emerald-700' :
                trackRecord.overall.confidence === 'usable' ? 'bg-blue-100 text-blue-700' :
                trackRecord.overall.confidence === 'early' ? 'bg-amber-100 text-amber-700' :
                'bg-slate-100 text-slate-500'
              }`}>{trackRecord.overall.confidence} sample</span>
            </div>
          </div>
          {trackRecord.byGrade.some((g) => g.settled > 0) && (
            <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
              {trackRecord.byGrade.filter((g) => g.settled > 0).map((g) => (
                <span key={g.value} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-bold text-slate-600" title={`${g.wins}W/${g.losses}L · ${g.confidence} sample`}>
                  <span className="font-black text-slate-800">{g.value}</span>
                  <span className={`font-black ${g.hitRate !== null && g.hitRate >= 55 ? 'text-emerald-600' : g.hitRate !== null && g.hitRate < 45 ? 'text-rose-600' : 'text-slate-600'}`}>{g.hitRate}%</span>
                  <span className="text-slate-400">({g.settled})</span>
                </span>
              ))}
            </div>
          )}
          <p className="mt-2 flex items-start gap-1.5 text-[11px] font-semibold text-slate-400">
            <Info size={12} className="mt-0.5 shrink-0" /> {trackRecord.note}
          </p>
        </div>
      )}

      {aiOn && (
        <div className="flex items-start gap-2 rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm font-semibold text-violet-800">
          <Info size={16} className="mt-0.5 shrink-0" />
          AI projection is enabled. Click <b>Run AI</b> on any symbol to validate its zones with Gemini. Each run makes one on-demand API call.
        </div>
      )}

      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">{error}</div>}

      {suitabilityFilter === 'SAVED' ? (
        savedProjections.length ? (
          <div className="grid gap-6 md:grid-cols-2 animate-in fade-in duration-300">
            {savedProjections.map(renderSavedProjection)}
          </div>
        ) : (
          <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-12 text-center">
            <Bookmark className="mx-auto text-slate-300" size={40} />
            <p className="mt-4 text-sm font-bold text-slate-500">No saved projections for observation.</p>
            <p className="mt-1 text-xs font-semibold text-slate-400">Click "Save Setup" on any active pullback projection card to track it here.</p>
          </div>
        )
      ) : !mathOn ? (
        <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-12 text-center">
          <Calculator className="mx-auto text-slate-300" size={40} />
          <p className="mt-4 text-sm font-bold text-slate-500">Mathematical projections are turned off.</p>
          <p className="mt-1 text-xs font-semibold text-slate-400">Enable the <b>Mathematicals</b> toggle to compute pullback zones and timing.</p>
        </div>
      ) : loading && !results.length ? (
        <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-12 text-center">
          <Loader2 className="mx-auto animate-spin text-slate-300" size={40} />
          <p className="mt-4 text-sm font-bold text-slate-500">Scanning for unmitigated pullback zones…</p>
        </div>
      ) : withProjections.length ? (
        <div className="space-y-6">{withProjections.map(renderSymbol)}</div>
      ) : (
        <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-12 text-center">
          <Target className="mx-auto text-slate-300" size={40} />
          <p className="mt-4 text-sm font-bold text-slate-500">No unmitigated pullback zones on the curated symbols right now.</p>
          <p className="mt-1 text-xs font-semibold text-slate-400">Projections appear when price is trading away from a fresh Order Block or Fair Value Gap. Try another timeframe, or keep MT5 connected.</p>
        </div>
      )}

      {/* Reminder Modal */}
      {reminderModalProjection && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="relative w-full max-w-md overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl animate-in zoom-in-95 duration-200">
            {/* Header */}
            <div className="bg-slate-900 p-6 text-white">
              <button
                type="button"
                onClick={() => setReminderModalProjection(null)}
                className="absolute right-4 top-4 text-slate-400 hover:text-white transition-colors"
              >
                <X size={20} />
              </button>
              <p className="text-xs font-black uppercase tracking-[0.2em] text-amber-400 flex items-center gap-1.5">
                <Bell size={14} /> Email Alerts Scheduler
              </p>
              <h2 className="mt-2 text-xl font-black tracking-tight">
                Remind Me for {reminderModalProjection.symbol}
              </h2>
              <p className="mt-1 text-xs text-slate-300">
                A market condition check runs at T-10m and a detailed alert is sent at T-5m.
              </p>
            </div>

            {/* Content */}
            <div className="p-6 space-y-4">
              <div className="rounded-2xl bg-slate-50 p-4 border border-slate-100 space-y-2">
                <div className="flex justify-between text-xs font-bold text-slate-500">
                  <span>Target Zone:</span>
                  <span className="font-mono text-slate-900">
                    {reminderModalProjection.bias} OB/FVG @ {px(reminderModalProjection.entryPrice, reminderModalProjection.symbol)}
                  </span>
                </div>
                <div className="flex justify-between text-xs font-bold text-slate-500">
                  <span>Projected Time:</span>
                  <span className="text-slate-900">
                    {bdClock(reminderModalProjection.projectedTouchIso)} ({relFromMs(reminderModalProjection.projectedTouchMs, now)})
                  </span>
                </div>
                <div className="flex justify-between text-xs font-bold text-slate-500">
                  <span>Math Confidence / Grade:</span>
                  <span className="text-slate-900">
                    {reminderModalProjection.mathConfidence}% / {reminderModalProjection.grade || 'C Setup'}
                  </span>
                </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="reminder-email-input" className="block text-xs font-bold uppercase tracking-wider text-slate-500">
                  Recipient Email Address
                </label>
                <input
                  id="reminder-email-input"
                  type="email"
                  value={reminderEmail}
                  onChange={(e) => setReminderEmail(e.target.value)}
                  placeholder="e.g. name@domain.com"
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-800 placeholder-slate-400 focus:border-indigo-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 transition-all"
                />
              </div>

              {aiOn && (
                <div className="rounded-xl border border-violet-100 bg-violet-50/60 p-3 text-xs font-semibold text-violet-800 flex items-start gap-2">
                  <Sparkles size={14} className="mt-0.5 shrink-0 text-violet-600" />
                  <span>
                    <b>AI Verification is Enabled:</b> The T-10m check will invoke Gemini to re-score the setup and provide updated target levels in your email.
                  </span>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex gap-3 bg-slate-50 px-6 py-4 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setReminderModalProjection(null)}
                className="flex-1 rounded-xl border border-slate-200 bg-white py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50 transition"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={schedulingReminder || !reminderEmail}
                onClick={() => void handleScheduleReminder()}
                className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 py-2.5 text-sm font-bold text-white hover:bg-slate-800 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {schedulingReminder ? <Loader2 size={16} className="animate-spin" /> : <Bell size={16} />}
                Set Alert
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
