import React, { useCallback, useEffect, useState } from 'react';
import { Trophy, RefreshCw, Loader2, AlertTriangle, ShieldCheck, TrendingUp, TrendingDown, Ban, Wallet } from 'lucide-react';
import { fetchChallenge, logChallengeTrade, setChallengeBalance, setChallengeInitialBalance, resetChallenge } from '../mt5Api';
import type { ChallengeDashboard } from '../types';

const usd = (v: number | null | undefined) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

const STATUS: Record<ChallengeDashboard['status'], { label: string; wrap: string; chip: string; Icon: React.ComponentType<{ size?: number }> }> = {
  IN_PROGRESS: { label: 'IN PROGRESS', wrap: 'border-sky-300 bg-sky-50', chip: 'bg-sky-600 text-white', Icon: TrendingUp },
  AT_RISK: { label: 'AT RISK — near a limit', wrap: 'border-amber-300 bg-amber-50', chip: 'bg-amber-500 text-white', Icon: AlertTriangle },
  TARGET_MET: { label: 'TARGET MET 🎉', wrap: 'border-emerald-300 bg-emerald-50', chip: 'bg-emerald-600 text-white', Icon: ShieldCheck },
  BREACH_DAILY: { label: 'BREACHED — daily loss limit', wrap: 'border-rose-300 bg-rose-50', chip: 'bg-rose-600 text-white', Icon: Ban },
  BREACH_MAX_DD: { label: 'BREACHED — max drawdown', wrap: 'border-rose-300 bg-rose-50', chip: 'bg-rose-600 text-white', Icon: Ban },
};

function Meter({ label, value, max, tone, foot }: { label: string; value: number; max: number; tone: string; foot: string }) {
  const pct = Math.max(0, Math.min(100, max > 0 ? (value / max) * 100 : 0));
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">{label}</span>
        <span className="text-xs font-black text-slate-700">{usd(value)}</span>
      </div>
      <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-[10px] font-medium text-slate-400">{foot}</p>
    </div>
  );
}

export default function ChallengeTracker() {
  const [d, setD] = useState<ChallengeDashboard | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pnl, setPnl] = useState('');
  const [note, setNote] = useState('');
  const [balanceInput, setBalanceInput] = useState('');
  const [initialInput, setInitialInput] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (spin = false) => {
    if (spin) setLoading(true);
    try { setD(await fetchChallenge()); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed to load'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(true); const id = setInterval(() => load(false), 15000); return () => clearInterval(id); }, [load]);

  const doTrade = async (sign: 1 | -1) => {
    const val = Number(pnl);
    if (!Number.isFinite(val) || val === 0) return;
    setBusy(true);
    try { setD(await logChallengeTrade(sign * Math.abs(val), note)); setPnl(''); setNote(''); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(false); }
  };
  const doBalance = async () => {
    const val = Number(balanceInput);
    if (!Number.isFinite(val) || val <= 0) return;
    setBusy(true);
    try { setD(await setChallengeBalance(val)); setBalanceInput(''); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(false); }
  };
  // Correct the starting balance and KEEP the run. Every rule line derives from it, so a
  // stale value quietly shrinks the per-trade cap that gates auto-trade signals.
  const doInitial = async () => {
    const val = Number(initialInput);
    if (!Number.isFinite(val) || val <= 0) return;
    setBusy(true);
    try { setD(await setChallengeInitialBalance(val)); setInitialInput(''); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(false); }
  };
  const doReset = async () => {
    const typed = Number(initialInput);
    const from = Number.isFinite(typed) && typed > 0 ? typed : undefined;
    if (!window.confirm(`Start a fresh challenge from ${from !== undefined ? `$${from.toLocaleString()}` : 'the configured starting balance'}? This clears the current run.`)) return;
    setBusy(true);
    try { setD(await resetChallenge(from)); setInitialInput(''); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(false); }
  };

  const s = d ? STATUS[d.status] : null;

  return (
    <div className="mx-auto max-w-5xl space-y-4 pb-24">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-black text-slate-900"><Trophy size={22} className="text-amber-500" />Challenge Tracker</h1>
          <p className="text-sm font-semibold text-slate-500">Live distance to every prop-firm rule line. Simulated — log your trades or correct the balance to keep it honest.</p>
        </div>
        <button onClick={() => load(true)} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-bold text-slate-600 hover:bg-slate-50">
          {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}Refresh
        </button>
      </div>

      {err && <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm font-semibold text-rose-700">{err}</div>}
      {!d && !err && <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-slate-400"><Loader2 className="mx-auto animate-spin" /> Loading…</div>}

      {d && s && (
        <>
          <div className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-5 py-4 ${s.wrap}`}>
            <div className="flex items-center gap-3">
              <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-black ${s.chip}`}><s.Icon size={14} />{s.label}</span>
              <span className="text-sm font-bold text-slate-600">{d.rules.preset} · {d.rules.phase}</span>
            </div>
            <div className="text-right">
              <p className="text-2xl font-black text-slate-900">{usd(d.currentBalance)}</p>
              <p className={`text-xs font-bold ${d.totalProfit >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{d.totalProfit >= 0 ? '+' : ''}{usd(d.totalProfit)} total · today {d.todayPnl >= 0 ? '+' : ''}{usd(d.todayPnl)}</p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Profit target</span>
                <span className="text-xs font-black text-emerald-600">{d.progressPct}%</span>
              </div>
              <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.max(0, Math.min(100, d.progressPct))}%` }} /></div>
              <p className="mt-1 text-[10px] font-medium text-slate-400">to {usd(d.target)} ({d.rules.profitTargetPct}% of {usd(d.initialBalance)})</p>
            </div>
            <Meter label="Daily-loss room" value={d.roomToDailyLoss} max={d.dayStartBalance * d.rules.dailyLossPct / 100} tone={d.roomToDailyLoss <= d.initialBalance * 0.005 ? 'bg-rose-500' : 'bg-amber-500'} foot={`floor ${usd(d.dailyFloor)} · ${d.rules.dailyLossPct}% of day start`} />
            <Meter label="Max-drawdown room" value={d.roomToMaxDrawdown} max={d.initialBalance * d.rules.maxDrawdownPct / 100} tone={d.roomToMaxDrawdown <= d.initialBalance * 0.005 ? 'bg-rose-500' : 'bg-indigo-500'} foot={`floor ${usd(d.ddFloor)} · ${d.rules.maxDrawdownPct}% ${d.rules.drawdownType}`} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3"><p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Trading days</p><p className={`text-lg font-black ${d.tradingDays >= d.minTradingDays ? 'text-emerald-600' : 'text-slate-800'}`}>{d.tradingDays} <span className="text-xs text-slate-400">/ {d.minTradingDays} min</span></p></div>
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3"><p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Consistency</p><p className={`text-lg font-black ${d.consistencyOk ? 'text-emerald-600' : 'text-rose-600'}`}>{d.consistencyUsedPct}% <span className="text-xs text-slate-400">/ {d.consistencyLimitPct}% cap</span></p></div>
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3"><p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Safe risk / trade</p><p className="text-lg font-black text-slate-800">{usd(d.safePerTradeRisk)}</p></div>
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3"><p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Peak balance</p><p className="text-lg font-black text-slate-800">{usd(d.peakBalance)}</p></div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-white shadow-card">
              <div className="border-b border-slate-100 px-5 py-3"><h3 className="text-sm font-bold text-slate-900">Log a trade result</h3><p className="text-xs font-medium text-slate-500">Enter the USD result of a trade you took. Updates the simulated balance + today's P&amp;L.</p></div>
              <div className="space-y-3 px-5 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-bold text-slate-400">$</span>
                  <input type="number" step="0.01" value={pnl} onChange={(e) => setPnl(e.target.value)} placeholder="amount" className="w-28 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm font-bold text-slate-800" />
                  <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="note (optional)" className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm text-slate-700" />
                </div>
                <div className="flex gap-2">
                  <button disabled={busy} onClick={() => doTrade(1)} className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-bold text-white hover:bg-emerald-700 disabled:opacity-50"><TrendingUp size={15} />Win</button>
                  <button disabled={busy} onClick={() => doTrade(-1)} className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-rose-600 px-3 py-2 text-sm font-bold text-white hover:bg-rose-700 disabled:opacity-50"><TrendingDown size={15} />Loss</button>
                </div>
              </div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white shadow-card">
              <div className="border-b border-slate-100 px-5 py-3"><h3 className="text-sm font-bold text-slate-900">Correct / reset</h3><p className="text-xs font-medium text-slate-500">Set the balance to match your real account, or start a fresh challenge.</p></div>
              <div className="space-y-4 px-5 py-4">
                <div>
                  <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Current balance</label>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <Wallet size={15} className="text-slate-400" />
                    <input type="number" step="0.01" value={balanceInput} onChange={(e) => setBalanceInput(e.target.value)} placeholder={`${d.currentBalance}`} className="w-32 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm font-bold text-slate-800" />
                    <button disabled={busy} onClick={doBalance} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50">Set balance</button>
                  </div>
                </div>
                {/* Starting balance drives the drawdown floor, the profit target and the
                    per-trade cap that gates auto-trade signals — so it has to be editable
                    without throwing away the run. */}
                <div className="border-t border-slate-100 pt-3">
                  <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Starting balance</label>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <Trophy size={15} className="text-amber-400" />
                    <input type="number" step="0.01" value={initialInput} onChange={(e) => setInitialInput(e.target.value)} placeholder={`${d.initialBalance}`} className="w-32 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm font-bold text-slate-800" />
                    <button disabled={busy} onClick={doInitial} className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-bold text-amber-800 hover:bg-amber-100 disabled:opacity-50">Set starting balance</button>
                  </div>
                  <p className="mt-1.5 text-[11px] font-medium text-slate-400">
                    Currently {usd(d.initialBalance)} → drawdown floor {usd(d.ddFloor)}, target {usd(d.target)}, safe risk/trade {usd(d.safePerTradeRisk)}. Keeps your history.
                  </p>
                </div>
                <button disabled={busy} onClick={doReset} className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-bold text-rose-700 hover:bg-rose-100 disabled:opacity-50"><RefreshCw size={13} />Reset challenge{initialInput.trim() ? ` from $${initialInput.trim()}` : ''}</button>
              </div>
            </div>
          </div>

          {d.recentTrades.length > 0 && (
            <div className="rounded-2xl border border-slate-200 bg-white shadow-card">
              <div className="border-b border-slate-100 px-5 py-3"><h3 className="text-sm font-bold text-slate-900">Recent activity</h3></div>
              <div className="divide-y divide-slate-100">
                {d.recentTrades.map((t, i) => (
                  <div key={i} className="flex items-center justify-between px-5 py-2 text-sm">
                    <span className="text-slate-500">{new Date(t.ts).toLocaleString()}{t.note ? ` · ${t.note}` : ''}</span>
                    <span className="flex items-center gap-3"><span className={`font-bold ${t.pnl >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{t.pnl >= 0 ? '+' : ''}{usd(t.pnl)}</span><span className="font-mono text-xs text-slate-400">{usd(t.balanceAfter)}</span></span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="text-[11px] font-medium text-slate-400">Simulated tracker — not connected to your real broker/prop account. Verify the rule numbers against your current Hola Prime plan (Notification Settings → Account &amp; Sizing). Educational risk tracking, not financial advice.</p>
        </>
      )}
    </div>
  );
}
