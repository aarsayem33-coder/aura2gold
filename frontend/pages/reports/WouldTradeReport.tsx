import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, XCircle, Wallet, Info, Rewind } from 'lucide-react';
import { fetchWouldTradeReport } from '../../mt5Api';
import type { WouldTradeResponse, WouldTradeGroup, WouldTradeGroupRow, WouldTradeReplayStats } from '../../types';
import { ErrorBanner } from './_shared';

type Dim = 'combo' | 'strategy' | 'account' | 'timeframe' | 'symbol' | 'nottaken' | 'whatif' | 'trades';

const DIMS: { key: Dim; label: string }[] = [
  { key: 'combo', label: 'Combo' },
  { key: 'strategy', label: 'Strategy' },
  { key: 'account', label: 'Account' },
  { key: 'timeframe', label: 'Timeframe' },
  { key: 'symbol', label: 'Symbol' },
  { key: 'nottaken', label: 'Never traded' },
  { key: 'whatif', label: 'What if taken' },
  { key: 'trades', label: 'All decisions' },
];

/**
 * Rows painted at once. Each is a component with nested cells; rendering every combo at once
 * locks the main thread long enough that the tab stops responding. The list is sorted by net
 * profit, so nothing meaningful sits past the cut.
 */
const MAX_RENDERED_ROWS = 100;

const money = (v: number | null | undefined, dp = 2) =>
  v === null || v === undefined || Number.isNaN(v)
    ? '—'
    : `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
const num = (v: number | null | undefined, dp = 2) =>
  v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(dp);
const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${(v * 100).toFixed(0)}%`;
const tone = (v: number | null | undefined) =>
  v === null || v === undefined || Number.isNaN(v) ? 'text-slate-500' : v > 0 ? 'text-emerald-700' : v < 0 ? 'text-rose-700' : 'text-slate-500';

function Headline({ data }: { data: WouldTradeResponse }) {
  const t = data.totals;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
        <div className="flex items-center gap-2 text-emerald-700">
          <CheckCircle2 size={16} />
          <span className="text-xs font-black uppercase tracking-wider">Taken</span>
        </div>
        <div className="mt-1 text-2xl font-black tabular-nums text-emerald-800">{t.taken.toLocaleString()}</div>
        <div className={`text-sm font-bold ${tone(t.netProfit)}`}>{money(t.netProfit)} real</div>
      </div>
      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
        <div className="flex items-center gap-2 text-slate-600">
          <XCircle size={16} />
          <span className="text-xs font-black uppercase tracking-wider">Never traded</span>
        </div>
        <div className="mt-1 text-2xl font-black tabular-nums text-slate-800">{t.notTaken.toLocaleString()}</div>
        <div className="text-sm font-semibold text-slate-500">{pct(t.fillRate)} of decisions filled</div>
      </div>
      <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4">
        <div className="flex items-center gap-2 text-sky-700">
          <Wallet size={16} />
          <span className="text-xs font-black uppercase tracking-wider">Per trade</span>
        </div>
        <div className={`mt-1 text-2xl font-black tabular-nums ${tone(t.expectancy)}`}>{money(t.expectancy)}</div>
        <div className="text-sm font-semibold text-slate-500">
          {num(t.expectancyR, 3)}R · win {pct(t.winRate)} · {num(t.netPips, 0)} pips
        </div>
      </div>
    </div>
  );
}

function Verdict({ row }: { row: WouldTradeGroupRow }) {
  if (!row.taken) return <span className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-bold text-slate-500">never traded</span>;
  if (row.belowSampleFloor) return <span className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-bold text-slate-500">too few</span>;
  if (row.significant) return <span className="rounded-lg bg-emerald-100 px-2 py-1 text-xs font-black text-emerald-700">survives</span>;
  // The honest middle case: it would look significant alone, and does not once the search is
  // priced in.
  if (row.nominallySignificant) return <span className="rounded-lg bg-amber-100 px-2 py-1 text-xs font-bold text-amber-700">could be noise</span>;
  return <span className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-bold text-slate-500">no edge</span>;
}

function RankTable({ group }: { group: WouldTradeGroup }) {
  const [showWeak, setShowWeak] = useState(false);
  const eligible = useMemo(
    () => (showWeak ? group.rows : group.rows.filter((x) => !x.belowSampleFloor)),
    [group.rows, showWeak],
  );
  const rows = useMemo(() => eligible.slice(0, MAX_RENDERED_ROWS), [eligible]);
  const truncated = eligible.length - rows.length;
  const hidden = group.rows.length - eligible.length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <span className="inline-flex items-center gap-1.5 font-semibold">
          <Info size={13} />
          {group.bar.combosTested.toLocaleString()} groups compared — a result needs t ≥ {group.bar.criticalT} to beat chance, not the usual 1.96
        </span>
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setShowWeak((v) => !v)}
            className="rounded-lg border border-slate-200 px-2.5 py-1 font-bold text-slate-600 hover:bg-slate-50"
          >
            {showWeak ? 'Hide' : `Show ${hidden} with too few trades`}
          </button>
        )}
      </div>

      <div className="grid gap-2 md:hidden">
        {rows.map((x) => (
          <div key={x.key} className={`rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm ${x.belowSampleFloor ? 'opacity-60' : ''}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate font-bold text-slate-800">{x.key}</div>
                <div className="text-xs font-semibold text-slate-400">{x.taken} taken · {x.notTaken} missed</div>
              </div>
              <Verdict row={x} />
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              <div>
                <div className="text-[10px] font-black uppercase tracking-wider text-slate-400">Net</div>
                <div className={`text-base font-black tabular-nums ${tone(x.netProfit)}`}>{money(x.netProfit, 0)}</div>
              </div>
              <div>
                <div className="text-[10px] font-black uppercase tracking-wider text-slate-400">Per trade</div>
                <div className={`text-base font-black tabular-nums ${tone(x.expectancy)}`}>{money(x.expectancy, 0)}</div>
              </div>
              <div>
                <div className="text-[10px] font-black uppercase tracking-wider text-slate-400">Win</div>
                <div className="text-base font-black tabular-nums text-slate-700">{pct(x.winRate)}</div>
              </div>
            </div>
            <div className="mt-2 flex justify-between border-t border-slate-100 pt-2 text-xs text-slate-500">
              <span>{num(x.expectancyR, 3)}R avg</span>
              <span>{num(x.netPips, 0)} pips · {num(x.totalLots, 2)} lots</span>
            </div>
          </div>
        ))}
      </div>

      <div className="hidden md:block overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-3 py-2.5 text-left font-black">Group</th>
              <th className="px-3 py-2.5 text-right font-black">Taken</th>
              <th className="px-3 py-2.5 text-right font-black">Missed</th>
              <th className="px-3 py-2.5 text-right font-black">Win%</th>
              <th className="px-3 py-2.5 text-right font-black">Net profit</th>
              <th className="px-3 py-2.5 text-right font-black">Per trade</th>
              <th className="px-3 py-2.5 text-right font-black">Avg R</th>
              <th className="px-3 py-2.5 text-right font-black">Pips</th>
              <th className="px-3 py-2.5 text-right font-black">Max DD</th>
              <th className="px-3 py-2.5 text-center font-black">Verdict</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((x) => (
              <tr key={x.key} className={x.belowSampleFloor ? 'opacity-50' : ''}>
                <td className="px-3 py-2.5 font-bold text-slate-800">{x.key}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{x.taken}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-400">{x.notTaken}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{pct(x.winRate)}</td>
                <td className={`px-3 py-2.5 text-right tabular-nums font-bold ${tone(x.netProfit)}`}>{money(x.netProfit)}</td>
                <td className={`px-3 py-2.5 text-right tabular-nums ${tone(x.expectancy)}`}>{money(x.expectancy)}</td>
                <td className={`px-3 py-2.5 text-right tabular-nums ${tone(x.expectancyR)}`}>{num(x.expectancyR, 3)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">{num(x.netPips, 0)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">{money(x.maxDrawdown, 0)}</td>
                <td className="px-3 py-2.5 text-center"><Verdict row={x} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {truncated > 0 && (
        <p className="text-center text-xs font-semibold text-slate-400">
          Showing the top {MAX_RENDERED_ROWS} of {eligible.length.toLocaleString()} — the rest rank below these.
        </p>
      )}
      {!rows.length && (
        <p className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
          Nothing here has enough trades yet. Widen the range or lower the minimum.
        </p>
      )}
    </div>
  );
}

/** Why decisions never became trades. The dominant cause is what to fix. */
function NeverTraded({ data }: { data: WouldTradeResponse }) {
  if (!data.notTaken.length) {
    return <p className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">Every decision in this window reached the market.</p>;
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-500">
        {data.totals.notTaken.toLocaleString()} of {data.totals.decisions.toLocaleString()} decisions never
        became a trade. These carry no profit or loss — what a trade that never existed would have
        made is unknowable, and guessing it is what makes backtests lie.
      </p>
      {data.notTaken.map((b) => (
        <div key={b.status} className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <span className="text-sm font-black uppercase tracking-wide text-slate-800">{b.status}</span>
              <span className="ml-2 text-sm text-slate-500">{b.reason}</span>
            </div>
            <span className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-black text-slate-700">
              {b.count.toLocaleString()} · {pct(b.share)}
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-slate-400" style={{ width: `${Math.min(100, b.share * 100)}%` }} />
          </div>
          {b.examples.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs text-slate-400">
              {b.examples.map((e, i) => <li key={i} className="truncate">· {e}</li>)}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}


/**
 * What the never-traded decisions would have done, replayed against real candles.
 *
 * The number that keeps this honest is NEVER FILLED: a pending order price never returned to
 * carries no result at all. Reporting it as a win would credit a trade that could not have
 * opened, and reporting it as a loss would be equally invented.
 */
function WhatIfTaken({ data }: { data: WouldTradeResponse }) {
  const r = data.replay;
  if (!r || !r.overall.replayed) {
    return <p className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">No never-traded decisions with replayable geometry in this window.</p>;
  }
  const o = r.overall;
  const Row = ({ list, title }: { list: (WouldTradeReplayStats & { key: string })[]; title: string }) => (
    <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
          <tr>
            <th className="px-3 py-2.5 text-left font-black">{title}</th>
            <th className="px-3 py-2.5 text-right font-black">Settled</th>
            <th className="px-3 py-2.5 text-right font-black">Never filled</th>
            <th className="px-3 py-2.5 text-right font-black">Win%</th>
            <th className="px-3 py-2.5 text-right font-black">Expectancy</th>
            <th className="px-3 py-2.5 text-right font-black">Would have made</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {list.map((x) => (
            <tr key={x.key}>
              <td className="px-3 py-2.5 font-bold text-slate-800">{x.key}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{x.settled}</td>
              <td className={`px-3 py-2.5 text-right tabular-nums ${x.neverFilled ? 'text-amber-700 font-bold' : 'text-slate-400'}`}>{x.neverFilled}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{pct(x.winRate)}</td>
              <td className={`px-3 py-2.5 text-right tabular-nums font-bold ${tone(x.expectancyR)}`}>{num(x.expectancyR, 3)}R</td>
              <td className={`px-3 py-2.5 text-right tabular-nums font-bold ${tone(x.estimatedProfit)}`}>{money(x.estimatedProfit, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-indigo-200 bg-indigo-50 p-4">
        <div className="flex items-start gap-3">
          <Rewind size={20} className="mt-0.5 shrink-0 text-indigo-600" />
          <div>
            <h3 className="text-sm font-black uppercase tracking-wide text-indigo-800">
              Replayed against real candles — measured, not guessed
            </h3>
            <p className="mt-1 text-sm text-slate-700">
              {o.replayed} never-traded decisions resolved bar by bar. <strong>{o.settled}</strong> reached
              a target or a stop; <strong className="text-amber-700">{o.neverFilled}</strong> were pending
              orders price never came back to, so they carry no result at all.
            </p>
            <p className="mt-1.5 text-sm font-bold text-slate-800">
              Win {pct(o.winRate)} · expectancy {num(o.expectancyR, 3)}R ·
              would have made <span className={tone(o.estimatedProfit)}>{money(o.estimatedProfit, 0)}</span> at
              a constant ${o.riskPerTrade} risk.
            </p>
          </div>
        </div>
      </div>

      <Row list={r.byStatus} title="Why it was skipped" />
      <Row list={r.byOrderType} title="Order type" />
      <Row list={r.byStrategy.slice(0, MAX_RENDERED_ROWS)} title="Strategy" />

      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
        <h4 className="text-xs font-black uppercase tracking-wider text-slate-500">What this does and does not say</h4>
        <ul className="mt-2 space-y-1.5 text-sm text-slate-600">
          {r.caveats.map((c) => <li key={c} className="flex gap-2"><span className="text-slate-400">•</span><span>{c}</span></li>)}
        </ul>
      </div>
    </div>
  );
}

/** Every decision, newest first, so any total can be traced to the trades behind it. */
function AllDecisions({ data }: { data: WouldTradeResponse }) {
  const [onlyTaken, setOnlyTaken] = useState(false);
  const rows = useMemo(
    () => (onlyTaken ? data.trades.filter((t) => t.decision === 'TAKEN') : data.trades).slice(0, MAX_RENDERED_ROWS),
    [data.trades, onlyTaken],
  );
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span className="font-semibold">Newest {rows.length} of {data.trades.length.toLocaleString()} loaded</span>
        <button
          type="button"
          onClick={() => setOnlyTaken((v) => !v)}
          className={`rounded-lg border px-2.5 py-1 font-bold ${onlyTaken ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
        >
          {onlyTaken ? 'Showing filled only' : 'Show filled only'}
        </button>
      </div>
      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[940px] text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-3 py-2.5 text-left font-black">When</th>
              <th className="px-3 py-2.5 text-left font-black">Strategy</th>
              <th className="px-3 py-2.5 text-left font-black">Market</th>
              <th className="px-3 py-2.5 text-left font-black">Account</th>
              <th className="px-3 py-2.5 text-right font-black">Lots</th>
              <th className="px-3 py-2.5 text-right font-black">Profit</th>
              <th className="px-3 py-2.5 text-right font-black">R</th>
              <th className="px-3 py-2.5 text-left font-black">Outcome</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((t) => (
              <tr key={t.id} className={t.decision === 'TAKEN' ? '' : 'bg-slate-50/60'}>
                <td className="px-3 py-2 whitespace-nowrap text-xs text-slate-500">{String(t.createdAt).slice(0, 16).replace('T', ' ')}</td>
                <td className="px-3 py-2 font-bold text-slate-800">{t.strategy}</td>
                <td className="px-3 py-2 text-slate-600">{t.symbol} {t.timeframe} <span className={t.direction === 'BUY' ? 'text-emerald-600' : 'text-rose-600'}>{t.direction}</span></td>
                <td className="px-3 py-2 text-xs text-slate-500">{t.account}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-600">{t.lots ?? '—'}</td>
                <td className={`px-3 py-2 text-right tabular-nums font-bold ${tone(t.profit)}`}>{t.profit === null ? '—' : money(t.profit)}</td>
                <td className={`px-3 py-2 text-right tabular-nums ${tone(t.r)}`}>{num(t.r, 2)}</td>
                <td className="px-3 py-2">
                  {t.decision === 'TAKEN'
                    ? <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-bold text-emerald-700">{t.status}</span>
                    : <span className="text-xs text-slate-500" title={t.reason || ''}>{t.status} — {t.reason}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function WouldTradeReport() {
  const [data, setData] = useState<WouldTradeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dim, setDim] = useState<Dim>('combo');
  const [days, setDays] = useState(30);
  const [account, setAccount] = useState('all');
  const [minTrades, setMinTrades] = useState(10);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWouldTradeReport({ days, minTrades, account });
      setData(res);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load the would-trade ledger');
    } finally {
      setLoading(false);
    }
  }, [days, minTrades, account]);

  useEffect(() => { void load(); }, [load]);

  const group = useMemo<WouldTradeGroup | null>(() => {
    if (!data) return null;
    if (dim === 'combo') return data.byCombo;
    if (dim === 'strategy') return data.byStrategy;
    if (dim === 'account') return data.byAccount;
    if (dim === 'timeframe') return data.byTimeframe;
    if (dim === 'symbol') return data.bySymbol;
    return null;
  }, [data, dim]);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-black text-slate-800">Would Trade</h2>
            <p className="text-sm text-slate-500">
              Every MT5 decision — taken or not — across all accounts, with real broker P&amp;L.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs font-bold text-slate-500">
              Account
              <select
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                className="ml-1.5 rounded-lg border border-slate-200 px-2 py-1 text-sm font-semibold text-slate-700"
              >
                <option value="all">All accounts</option>
                {(data?.accounts || []).map((a) => (
                  <option key={a.account} value={a.account}>
                    {a.account} ({a.filled} filled)
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-bold text-slate-500">
              Days
              <select
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                className="ml-1.5 rounded-lg border border-slate-200 px-2 py-1 text-sm font-semibold text-slate-700"
              >
                {[7, 14, 30, 90, 180, 400].map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
            <label className="text-xs font-bold text-slate-500">
              Min trades
              <input
                type="number"
                value={minTrades}
                min={1}
                onChange={(e) => setMinTrades(Math.max(1, Number(e.target.value) || 1))}
                className="ml-1.5 w-16 rounded-lg border border-slate-200 px-2 py-1 text-sm font-semibold text-slate-700"
              />
            </label>
          </div>
        </div>
      </div>

      <ErrorBanner error={error} />

      {loading && !data && (
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">Loading the ledger…</div>
      )}

      {data && (
        <>
          <Headline data={data} />

          <div className="flex flex-wrap gap-1.5 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-sm">
            {DIMS.map((d) => (
              <button
                key={d.key}
                type="button"
                onClick={() => setDim(d.key)}
                className={`rounded-xl px-3.5 py-2 text-sm font-bold transition-all ${
                  dim === d.key ? 'border border-amber-200 bg-amber-50 text-amber-700 shadow-sm' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>

          {dim === 'nottaken' ? <NeverTraded data={data} />
            : dim === 'whatif' ? <WhatIfTaken data={data} />
              : dim === 'trades' ? <AllDecisions data={data} />
                : group && <RankTable group={group} />}

          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <h4 className="text-xs font-black uppercase tracking-wider text-slate-500">How to read this</h4>
            <ul className="mt-2 space-y-1.5 text-sm text-slate-600">
              {data.caveats.map((c) => <li key={c} className="flex gap-2"><span className="text-slate-400">•</span><span>{c}</span></li>)}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
