import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ShieldQuestion, Loader2, RefreshCw, CheckCircle2, XCircle, AlertTriangle,
  Clock, ArrowUp, ArrowDown, Plug, History, Crosshair, RotateCcw, ArrowRight,
} from 'lucide-react';
import { fetchAutoTradePending, approveAutoTrade, rejectAutoTrade, repriceAutoTrade } from '../mt5Api';
import type { AutoTradePendingResponse, PendingAutoTrade, RepriceResponse } from '../types';

// Every trade the auto-trader wants to place but will NOT send to MT5 without an explicit yes.
// These expire on a server-enforced deadline, so the page refreshes itself and counts down from
// the row's real expiresAt rather than guessing.

const px = (v: number | null, symbol: string) => {
  if (v === null || v === undefined) return '—';
  const u = (symbol || '').toUpperCase();
  const d = /XAU|GOLD|XAG/.test(u) ? 2 : u.includes('JPY') ? 3 : /USTEC|NAS|US30|SPX/.test(u) ? 1 : 5;
  return v.toFixed(d);
};
const usd = (v: number | null) => (v === null || v === undefined ? '—' : `$${Number(v).toFixed(2)}`);

function Countdown({ expiresAt, onDead }: { expiresAt: string | null; onDead: () => void }) {
  const [left, setLeft] = useState(() => (expiresAt ? Date.parse(expiresAt) - Date.now() : 0));
  const dead = useRef(false);
  useEffect(() => {
    if (!expiresAt) return undefined;
    const t = setInterval(() => {
      const ms = Date.parse(expiresAt) - Date.now();
      setLeft(ms);
      // Tell the page once, so an elapsed proposal stops looking actionable without waiting
      // for the next poll — the server would reject it with 410 anyway.
      if (ms <= 0 && !dead.current) { dead.current = true; onDead(); }
    }, 1000);
    return () => clearInterval(t);
  }, [expiresAt, onDead]);
  if (!expiresAt) return <span className="font-mono text-xs font-black text-slate-400">no deadline</span>;
  const secs = Math.max(0, Math.round(left / 1000));
  const urgent = secs < 120;
  return (
    <span className={`font-mono text-sm font-black ${secs === 0 ? 'text-slate-400' : urgent ? 'text-rose-600' : 'text-slate-600'}`}>
      {secs === 0 ? 'expired' : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`}
    </span>
  );
}


const money = (v: number | null | undefined) =>
  (v === null || v === undefined ? '—' : `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`);

// Before/after for a re-priced ticket. Every figure is shown in price, pips AND dollars,
// because "SL 4072.68" tells you nothing about what you stand to lose.
function RepricePanel({ r, sym }: { r: RepriceResponse; sym: string }) {
  const Row = ({ label, before, after, tone }: { label: string; before: React.ReactNode; after: React.ReactNode; tone?: string }) => (
    <tr className="border-b border-slate-100 last:border-0">
      <td className="py-1 pr-3 text-[11px] font-bold uppercase tracking-wider text-slate-400">{label}</td>
      <td className="py-1 pr-2 text-[12px] font-semibold text-slate-400 line-through">{before}</td>
      <td className="py-1 pr-2 text-slate-300"><ArrowRight size={12} /></td>
      <td className={`py-1 text-[13px] font-black ${tone || 'text-slate-800'}`}>{after}</td>
    </tr>
  );
  return (
    <div className="mt-2 rounded-xl border border-violet-200 bg-violet-50/50 px-3 py-2">
      <p className="mb-1 text-[10px] font-black uppercase tracking-wider text-violet-700">
        Re-priced to market {r.market} · drifted {r.driftPips} pips
      </p>
      <table className="w-full">
        <tbody>
          <Row label="Entry" before={r.before.entry} after={r.after.entry} />
          <Row label="Stop loss" before={r.before.stopLoss} after={r.after.stopLoss} tone="text-rose-600" />
          <Row label="Take profit" before={r.before.takeProfit1 ?? '—'} after={r.after.takeProfit1 ?? '—'} tone="text-emerald-600" />
          <Row label="Volume" before={`${r.before.lots} lots`} after={`${r.after.lots} lots`} />
          <Row label="Risk" before={money(r.before.riskUsd)} after={
            <span className={r.after.overBudget ? 'text-rose-600' : 'text-slate-800'}>
              {money(r.after.riskUsd)}<span className="ml-1 text-[10px] font-semibold text-slate-400">of {money(r.after.budget)}</span>
            </span>} />
          <Row label="Reward @TP1" before={money(r.before.rewardUsd)} after={
            <span className="text-emerald-700">{money(r.after.rewardUsd)}</span>} />
          {r.after.rewardFinalUsd !== null && r.after.rewardFinalUsd !== undefined ? (
            <Row label="Reward @final" before="—" after={<span className="text-emerald-700">{money(r.after.rewardFinalUsd)}</span>} />
          ) : null}
          <Row label="RR" before={r.before.rr ?? '—'} after={r.after.rr ?? '—'} />
          <Row label="Stop size" before={`${r.before.stopPips ?? '—'} pips`} after={`${r.after.stopPips ?? '—'} pips`} />
        </tbody>
      </table>
      {/* The stop keeps its distance, not its level. Saying so stops "re-priced" reading as
          "the setup is intact" when the level that justified it has been left behind. */}
      {r.structuralWarning ? (
        <p className="mt-1.5 flex items-start gap-1 text-[11px] font-bold text-amber-800">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />{r.structuralWarning}
        </p>
      ) : null}
      {r.after.minForced ? (
        <p className="mt-1 text-[11px] font-bold text-amber-800">Broker minimum lot forced — risk exceeds the budget.</p>
      ) : null}
      {r.challenge.warnings.length ? (
        <p className="mt-1 flex items-start gap-1 text-[11px] font-bold text-amber-800">
          <ShieldAlert size={12} className="mt-0.5 shrink-0" />{r.challenge.warnings.join(' · ')}
        </p>
      ) : null}
    </div>
  );
}

function TradeCard({ t, busy, onApprove, onReject, onDead, actionable, onReprice, repricing, repriced }: {
  t: PendingAutoTrade; busy: string | null; actionable: boolean;
  onApprove: (id: string) => void; onReject: (id: string) => void; onDead: () => void;
  onReprice: (id: string) => void; repricing: boolean; repriced: RepriceResponse | null;
}) {
  const buy = t.direction === 'BUY';
  return (
    <div className={`rounded-2xl border bg-white px-5 py-4 shadow-sm ${actionable ? 'border-sky-300' : 'border-slate-200 opacity-70'}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-base font-black text-slate-900">
            <span className={`inline-flex h-7 w-7 items-center justify-center rounded-lg ${buy ? 'bg-emerald-100 text-emerald-600' : 'bg-rose-100 text-rose-500'}`}>
              {buy ? <ArrowUp size={15} /> : <ArrowDown size={15} />}
            </span>
            {t.direction} {t.symbol}
            <span className="text-slate-400">{t.timeframe}</span>
            <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">{t.orderType}</span>
          </p>
          <p className="mt-1 text-[12px] font-semibold text-slate-600">
            Entry <b>{px(t.entry, t.symbol)}</b> · SL <b className="text-rose-600">{px(t.stopLoss, t.symbol)}</b> · TP1 <b className="text-emerald-600">{px(t.takeProfit1, t.symbol)}</b>
            {t.takeProfit3 ? <> · TP3 <b className="text-emerald-600">{px(t.takeProfit3, t.symbol)}</b></> : null}
            {t.rr ? <> · RR <b>{t.rr}</b></> : null}
          </p>
          <p className="mt-0.5 text-[12px] font-semibold text-slate-500">
            <b>{t.lots ?? '—'}</b> lots · risk <b>{usd(t.riskAmount)}</b>
            {t.riskMode ? <span className="text-slate-400"> ({t.riskMode})</span> : null}
            {' · '}{t.strategyName}
            {t.score !== null ? <> · <b>{t.score}</b>{t.grade ? ` ${t.grade}` : ''}</> : null}
            {t.session ? <span className="text-slate-400"> · {t.session}</span> : null}
          </p>
          {/* Was this trade already predicted? Approving a setup the system forecast 40 minutes
              ago is a different decision from approving one that appeared from nowhere. */}
          {t.forecastMatch ? (
            <Link
              to="/future-predictions/setups"
              className={`mt-1.5 inline-flex flex-wrap items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-bold hover:brightness-95 ${
                t.forecastMatch.strength === 'STRONG'
                  ? 'border-violet-300 bg-violet-50 text-violet-800'
                  : 'border-slate-200 bg-slate-50 text-slate-600'
              }`}
            >
              <Crosshair size={12} />
              {t.forecastMatch.strength === 'STRONG' ? 'MATCHES A FORECAST' : 'close to a forecast'}
              <span className="font-semibold">
                {t.forecastMatch.scenario.replace(/_/g, ' ').toLowerCase()} at {t.forecastMatch.levelLabel || 'level'} {t.forecastMatch.level}
                {t.forecastMatch.forecastScore !== null ? ` · score ${t.forecastMatch.forecastScore}` : ''}
                {t.forecastMatch.bestStrategy ? ` · ${t.forecastMatch.bestStrategy}` : ''}
              </span>
              <span className="font-medium opacity-70">({t.forecastMatch.confidence}% · {t.forecastMatch.reasons[0]})</span>
            </Link>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
            <Clock size={11} />{actionable ? 'expires in' : 'window closed'}
          </span>
          <Countdown expiresAt={t.expiresAt} onDead={onDead} />
          {actionable ? (
            <div className="flex items-center gap-2">
              <button
                disabled={busy !== null}
                onClick={() => onApprove(t.id)}
                className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-black text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {busy === t.id ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}APPROVE
              </button>
              <button
                disabled={busy !== null || repricing}
                onClick={() => onReprice(t.id)}
                title="Re-anchor entry, stop, target and volume to the current market"
                className="inline-flex items-center gap-1 rounded-lg border border-violet-300 bg-violet-50 px-3 py-2 text-xs font-black text-violet-700 hover:bg-violet-100 disabled:opacity-50"
              >
                {repricing ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}RE-PRICE
              </button>
              <button
                disabled={busy !== null}
                onClick={() => onReject(t.id)}
                className="inline-flex items-center gap-1 rounded-lg border border-rose-300 bg-white px-3 py-2 text-xs font-black text-rose-600 hover:bg-rose-50 disabled:opacity-50"
              >
                <XCircle size={14} />REJECT
              </button>
            </div>
          ) : (
            <span className="rounded-lg bg-slate-100 px-3 py-1.5 text-[11px] font-bold text-slate-500">too late to approve</span>
          )}
        </div>
      </div>
      {repriced ? <RepricePanel r={repriced} sym={t.symbol} /> : null}
    </div>
  );
}

export default function AutoTradeApprovals() {
  const [data, setData] = useState<AutoTradePendingResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [repricing, setRepricing] = useState<string | null>(null);
  const [repriced, setRepriced] = useState<Record<string, RepriceResponse>>({});

  const load = useCallback(async (spin = false) => {
    if (spin) setLoading(true);
    try { setData(await fetchAutoTradePending()); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed to load approvals'); }
    finally { setLoading(false); }
  }, []);

  // These expire in minutes, so poll briskly.
  useEffect(() => {
    load(true);
    const t = setInterval(() => load(false), 15000);
    return () => clearInterval(t);
  }, [load]);

  const reprice = async (id: string) => {
    setRepricing(id); setErr(null); setNote(null);
    try {
      const r = await repriceAutoTrade(id);
      setRepriced((prev) => ({ ...prev, [id]: r }));
      await load(false);          // the stored row changed; show the new numbers everywhere
    } catch (e) { setErr(e instanceof Error ? e.message : 'Re-price failed'); }
    finally { setRepricing(null); }
  };

  const act = async (id: string, kind: 'approve' | 'reject') => {
    setBusy(id); setNote(null); setErr(null);
    try {
      if (kind === 'approve') await approveAutoTrade(id); else await rejectAutoTrade(id);
      setNote(kind === 'approve'
        ? 'Approved — queued for the EA. It reaches MT5 on the next poll.'
        : 'Rejected — nothing was sent.');
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : `Failed to ${kind}`);
      await load();   // the row may have expired or been guarded server-side
    } finally { setBusy(null); }
  };

  const pending = data?.pending || [];
  const expired = data?.expired || [];
  const recent = data?.recent || [];
  // Approving only queues the order — if the EA is not connected or the armed account does not
  // match, nothing will actually be sent, and saying so up front beats a silent no-op.
  const bridgeWarn = data && (!data.bridgeReady || !data.armedMatch);
  const modeWarn = data && data.mode !== 'ASK';

  return (
    <div className="mx-auto max-w-[1200px] space-y-4 pb-24">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-black text-slate-900">
            <ShieldQuestion size={22} className="text-sky-500" />Request Approval
          </h1>
          <p className="text-sm font-semibold text-slate-500">
            Trades the auto-trader wants to place. Nothing is sent to MT5 until you approve it here.
          </p>
        </div>
        <button onClick={() => load(true)} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-bold text-slate-600 hover:bg-slate-50">
          {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}Refresh
        </button>
      </div>

      {err && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-600">{err}</div>}
      {note && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-700">{note}</div>}

      {modeWarn && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] font-bold text-amber-800">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span>
            Auto-trading is in <b>{data!.mode}</b> mode, not ASK — new setups will not ask for approval.
            {' '}<Link to="/auto-trading" className="underline">Change the mode</Link>.
          </span>
        </div>
      )}
      {bridgeWarn && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] font-bold text-amber-800">
          <Plug size={15} className="mt-0.5 shrink-0" />
          <span>
            {!data!.bridgeReady
              ? 'The EA bridge is not reporting — approving will queue the order, but nothing reaches MT5 until the EA reconnects.'
              : 'The account logged into MT5 does not match the armed account — dispatch is paused, so an approved order will not be sent.'}
          </span>
        </div>
      )}

      <section>
        <h2 className="mb-2 flex items-center gap-2 text-sm font-black uppercase tracking-wider text-slate-600">
          Waiting on you
          <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-bold text-sky-700">{pending.length}</span>
          {data ? <span className="text-[10px] font-semibold normal-case tracking-normal text-slate-400">approval window {data.approvalWindowMinutes} min</span> : null}
        </h2>
        {pending.length ? (
          <div className="space-y-2">
            {pending.map((t) => (
              <TradeCard key={t.id} t={t} busy={busy} actionable
                onApprove={(id) => act(id, 'approve')} onReject={(id) => act(id, 'reject')}
                onDead={() => load(false)}
                onReprice={reprice} repricing={repricing === t.id} repriced={repriced[t.id] || null} />
            ))}
          </div>
        ) : (
          <p className="rounded-2xl border border-dashed border-slate-200 px-5 py-6 text-center text-[13px] font-semibold text-slate-400">
            Nothing is waiting for approval. Setups appear here the moment the auto-trader proposes one.
          </p>
        )}
      </section>

      {expired.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-black uppercase tracking-wider text-slate-500">
            Missed the window <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">{expired.length}</span>
          </h2>
          <p className="mb-2 text-[11px] font-semibold text-slate-400">
            The approval deadline passed, so these can no longer be sent — the setup is stale.
          </p>
          <div className="space-y-2">
            {expired.map((t) => (
              <TradeCard key={t.id} t={t} busy={busy} actionable={false}
                onApprove={() => {}} onReject={() => {}} onDead={() => {}}
                onReprice={() => {}} repricing={false} repriced={null} />
            ))}
          </div>
        </section>
      )}

      {recent.length > 0 && (
        <section>
          <h2 className="mb-2 flex items-center gap-2 text-sm font-black uppercase tracking-wider text-slate-600">
            <History size={14} className="text-slate-400" />Recently decided
          </h2>
          <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
            <table className="w-full min-w-[760px] text-left text-[12px]">
              <thead>
                <tr className="border-b border-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  <th className="px-4 py-2">Trade</th><th className="px-4 py-2">Strategy</th>
                  <th className="px-4 py-2">Status</th><th className="px-4 py-2">Result</th>
                  <th className="px-4 py-2">When</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((t) => (
                  <tr key={t.id} className="border-b border-slate-50 font-semibold text-slate-600">
                    <td className="px-4 py-2">
                      <span className={t.direction === 'BUY' ? 'text-emerald-600' : 'text-rose-500'}>{t.direction}</span>
                      {' '}{t.symbol} <span className="text-slate-400">{t.timeframe}</span>
                    </td>
                    <td className="px-4 py-2">{t.strategyName}</td>
                    <td className="px-4 py-2">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                        ['FILLED', 'CLOSED', 'SENT'].includes(t.status) ? 'bg-emerald-50 text-emerald-700'
                          : t.status === 'QUEUED' ? 'bg-sky-50 text-sky-700'
                            : t.status === 'REJECTED' ? 'bg-slate-100 text-slate-500'
                              : 'bg-rose-50 text-rose-600'
                      }`}>{t.status}</span>
                    </td>
                    <td className={`px-4 py-2 font-bold ${t.profit === null ? 'text-slate-400' : t.profit >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>
                      {t.profit === null ? (t.reason || '—') : usd(t.profit)}
                    </td>
                    <td className="px-4 py-2 text-slate-400">
                      {t.updatedAt ? new Date(t.updatedAt).toLocaleString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <p className="text-[11px] font-semibold text-slate-400">
        Approving queues the order for the EA to collect on its next poll — it is not an instant fill.
        Rejecting sends nothing. Anything left past its window expires on the server and cannot be revived.
      </p>
    </div>
  );
}
