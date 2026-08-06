import React, { useCallback, useEffect, useState } from 'react';
import { Crosshair, Loader2, RefreshCcw, Info } from 'lucide-react';
import { ReportsTabs, ErrorBanner } from './_shared';
import { fetchSetupForecastReport } from '../../mt5Api';
import type { SetupForecastReportResponse, ForecastSettledRow, ForecastHit } from '../../types';

// How the conditional forecasts actually turned out. Two rates, kept deliberately separate:
//   arrival rate — did price ever reach the level inside the window?
//   match rate   — of those that arrived, did it behave the way the scenario predicted?
// Collapsing them into one number would let a wrong-but-never-tested forecast look the same
// as a correct one, which is exactly what makes accuracy claims meaningless.

const DAY_OPTIONS = [1, 7, 14, 30, 90];
const pctText = (v: number | null) => (v === null || v === undefined ? 'n/a' : `${v}%`);
const numText = (v: number | null) => (v === null || v === undefined ? 'n/a' : String(v));

function Stat({ label, value, sub, tone = 'slate' }: { label: string; value: string; sub?: string; tone?: string }) {
  const tones: Record<string, string> = {
    slate: 'border-slate-200 bg-white text-slate-800',
    emerald: 'border-emerald-200 bg-emerald-50/60 text-emerald-800',
    amber: 'border-amber-200 bg-amber-50/60 text-amber-800',
    violet: 'border-violet-200 bg-violet-50/60 text-violet-800',
  };
  return (
    <div className={`rounded-2xl border px-4 py-3 shadow-sm ${tones[tone] || tones.slate}`}>
      <p className="text-[11px] font-bold uppercase tracking-wider opacity-70">{label}</p>
      <p className="text-xl font-black">{value}</p>
      {sub ? <p className="mt-0.5 text-[10px] font-semibold opacity-60">{sub}</p> : null}
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  LIQUIDITY: 'Resting liquidity', ORDER_BLOCK: 'Order blocks',
  ZONE: 'Support / resistance', RETEST: 'Retests (broken → flipped)',
};

/**
 * Strategy x level-source cross-tab, grouped by source.
 *
 * The rate alone is misleading at small samples, so every row carries its arrival count and rows
 * under five arrivals are dimmed and marked "thin" rather than dropped — hiding them would make
 * the table look more certain than the data is.
 */
function StrategyBySource({ rows }: {
  rows: Array<{ source: string; strategyId: string; resolved: number; matched: number; matchRate: number | null; avgPips: number | null }>;
}) {
  const bySource = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!bySource.has(r.source)) bySource.set(r.source, []);
    bySource.get(r.source)!.push(r);
  }
  const order = ['RETEST', 'ORDER_BLOCK', 'ZONE', 'LIQUIDITY'].filter((s) => bySource.has(s));
  for (const s of bySource.keys()) if (!order.includes(s)) order.push(s);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="text-sm font-black text-slate-700">Which strategy works at which kind of level</h3>
      <p className="mb-3 text-[11px] font-semibold text-slate-400">
        A level counted once per source that names it, so the sources do not sum to the total.
        Under 5 arrivals is marked thin — a high rate there is not yet evidence.
      </p>
      {!order.length ? (
        <p className="text-[12px] font-semibold text-slate-400">Nothing has resolved yet in this window.</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {order.map((src) => (
            <div key={src}>
              <p className="mb-1 text-[11px] font-black uppercase tracking-wider text-slate-500">
                {SOURCE_LABEL[src] || src}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[300px] text-left text-[12px]">
                  <thead>
                    <tr className="border-b border-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      <th className="py-1 pr-3">Strategy</th>
                      <th className="py-1 pr-3">Arrived</th>
                      <th className="py-1 pr-3">Match rate</th>
                      <th className="py-1">Avg pips</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bySource.get(src)!.slice(0, 8).map((r) => {
                      const thin = r.resolved < 5;
                      return (
                        <tr key={r.strategyId} className={`border-b border-slate-50 font-semibold ${thin ? 'text-slate-400' : 'text-slate-600'}`}>
                          <td className="py-1 pr-3">{r.strategyId}</td>
                          <td className="py-1 pr-3">
                            {r.resolved}
                            {thin && <span className="ml-1 rounded bg-slate-100 px-1 text-[9px] font-black text-slate-400">THIN</span>}
                          </td>
                          <td className="py-1 pr-3">
                            <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${
                              thin ? 'bg-slate-50 text-slate-400'
                                : r.matchRate === null ? 'bg-slate-100 text-slate-500'
                                  : r.matchRate >= 60 ? 'bg-emerald-50 text-emerald-700'
                                    : r.matchRate >= 35 ? 'bg-amber-50 text-amber-700' : 'bg-rose-50 text-rose-600'
                            }`}>
                              {r.matchRate === null ? 'n/a' : `${r.matchRate}%`}
                            </span>
                          </td>
                          <td className="py-1">{r.avgPips === null ? '—' : r.avgPips}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function GroupTable({ title, rows, keyLabel }: {
  title: string;
  keyLabel: string;
  rows: Array<{ key: string; resolved: number; matched: number; matchRate: number | null }>;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="mb-2 text-sm font-black text-slate-700">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-[12px] font-semibold text-slate-400">Nothing has resolved yet in this window.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[320px] text-left text-[12px]">
            <thead>
              <tr className="border-b border-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                <th className="py-1 pr-3">{keyLabel}</th>
                <th className="py-1 pr-3">Arrived</th>
                <th className="py-1 pr-3">Matched</th>
                <th className="py-1">Match rate</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-b border-slate-50 font-semibold text-slate-600">
                  <td className="py-1 pr-3">{r.key}</td>
                  <td className="py-1 pr-3">{r.resolved}</td>
                  <td className="py-1 pr-3">{r.matched}</td>
                  <td className="py-1">
                    <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${
                      r.matchRate === null ? 'bg-slate-100 text-slate-500'
                        : r.matchRate >= 60 ? 'bg-emerald-50 text-emerald-700'
                          : r.matchRate >= 35 ? 'bg-amber-50 text-amber-700' : 'bg-rose-50 text-rose-600'
                    }`}>{pctText(r.matchRate)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}


const money = (v: number | null) => (v === null || v === undefined ? 'n/a' : `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`);
const pipsText = (v: number | null) => (v === null || v === undefined ? 'n/a' : `${v > 0 ? '+' : ''}${v}p`);
const toneFor = (v: number | null) => (v === null || v === undefined ? 'text-slate-400' : v > 0 ? 'text-emerald-700' : v < 0 ? 'text-rose-600' : 'text-slate-500');

// Level types come out of detectKeyLiquidityLevels as enum-ish strings; show them the way the
// chart labels them so "which measurement pays" reads in the same language as the analysis.
const LEVEL_LABEL: Record<string, string> = {
  PDH: 'Prev day high', PDL: 'Prev day low',
  EQUAL_HIGH: 'Equal highs', EQUAL_LOW: 'Equal lows',
  MAJOR_SWING_HIGH: 'Swing high', MAJOR_SWING_LOW: 'Swing low',
  ROUND_NUMBER: 'Round number',
  LONDON_HIGH: 'London high', LONDON_LOW: 'London low',
  ASIAN_HIGH: 'Asian high', ASIAN_LOW: 'Asian low',
  NY_HIGH: 'NY high', NY_LOW: 'NY low',
};
const levelName = (t: string | null) => (t ? LEVEL_LABEL[t] || t.replace(/_/g, ' ').toLowerCase() : '-');

const OUTCOME_STYLE: Record<string, string> = {
  TP1: 'bg-emerald-50 text-emerald-700', TP2: 'bg-emerald-100 text-emerald-800', TP3: 'bg-emerald-200 text-emerald-900',
  LOSS: 'bg-rose-50 text-rose-600', AMBIGUOUS: 'bg-orange-50 text-orange-700', OPEN: 'bg-blue-50 text-blue-700',
};

/** Settled grouping: hypothetical pips and real money side by side, never blended. */
function SettledTable({ title, keyLabel, rows, note }: {
  title: string; keyLabel: string; rows: ForecastSettledRow[]; note?: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="text-sm font-black text-slate-700">{title}</h3>
      {note ? <p className="mb-2 text-[10px] font-semibold text-slate-400">{note}</p> : null}
      {rows.length === 0 ? (
        <p className="mt-2 text-[12px] font-semibold text-slate-400">No hits settled yet in this window.</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-[12px]">
            <thead>
              <tr className="border-b border-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                <th className="py-1 pr-3">{keyLabel}</th>
                <th className="py-1 pr-3">Hits</th>
                <th className="py-1 pr-3">W/L</th>
                <th className="py-1 pr-3">Win rate</th>
                <th className="py-1 pr-3">Pips</th>
                <th className="py-1">Real P/L</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-b border-slate-50 font-semibold text-slate-600">
                  <td className="py-1 pr-3">{r.key}</td>
                  <td className="py-1 pr-3">{r.matched}{r.open ? <span className="text-slate-400"> ({r.open} open)</span> : null}</td>
                  <td className="py-1 pr-3">{r.wins}/{r.losses}</td>
                  <td className="py-1 pr-3">{r.winRate === null ? 'n/a' : `${r.winRate}%`}</td>
                  <td className={`py-1 pr-3 font-bold ${toneFor(r.pips)}`}>{pipsText(r.pips)}</td>
                  <td className={`py-1 font-bold ${r.realTrades ? toneFor(r.realPnl) : 'text-slate-300'}`}>
                    {r.realTrades ? `${money(r.realPnl)} (${r.realTrades})` : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Every hit, itemised - the drill-down behind the aggregates. */
function HitsTable({ hits }: { hits: ForecastHit[] }) {
  const [showAll, setShowAll] = useState(false);
  if (!hits.length) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="text-sm font-black text-slate-700">Every hit, itemised</h3>
        <p className="mt-2 text-[12px] font-semibold text-slate-400">
          No forecast has matched yet in this window. Rows appear once price reaches a level and behaves as predicted.
        </p>
      </div>
    );
  }
  const rows = showAll ? hits : hits.slice(0, 25);
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-black text-slate-700">Every hit, itemised</h3>
        <span className="text-[10px] font-semibold text-slate-400">{hits.length} matched · best pips first</span>
      </div>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[1100px] text-left text-[11.5px]">
          <thead>
            <tr className="border-b border-slate-100 text-[10px] font-bold uppercase tracking-wider text-slate-400">
              <th className="py-1 pr-3">Symbol</th><th className="py-1 pr-3">TF</th>
              <th className="py-1 pr-3">Strategy</th><th className="py-1 pr-3">Scenario</th>
              <th className="py-1 pr-3">Level</th><th className="py-1 pr-3">Dir</th>
              <th className="py-1 pr-3">Result</th><th className="py-1 pr-3">Pips</th>
              <th className="py-1 pr-3">R</th><th className="py-1 pr-3">Est. $</th>
              <th className="py-1 pr-3">Real P/L</th><th className="py-1 pr-3">ETA vs actual</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((h) => (
              <tr key={h.id} className="border-b border-slate-50 font-semibold text-slate-600">
                <td className="py-1 pr-3 font-bold text-slate-800">{h.symbol}</td>
                <td className="py-1 pr-3">{h.timeframe}</td>
                <td className="py-1 pr-3">{h.strategy || '-'}{h.score !== null ? <span className="text-slate-400"> {h.score}</span> : null}</td>
                <td className="py-1 pr-3">{h.scenario.replace(/_/g, ' ').toLowerCase()}</td>
                <td className="py-1 pr-3">{levelName(h.levelType)}<span className="ml-1 text-slate-400">{h.level}</span></td>
                <td className={`py-1 pr-3 font-bold ${h.direction === 'BUY' ? 'text-emerald-600' : 'text-rose-500'}`}>{h.direction}</td>
                <td className="py-1 pr-3">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${OUTCOME_STYLE[h.hitOutcome || 'OPEN'] || 'bg-slate-100 text-slate-500'}`}>
                    {h.hitOutcome || 'OPEN'}
                  </span>
                </td>
                <td className={`py-1 pr-3 font-bold ${toneFor(h.hitPips)}`}>{pipsText(h.hitPips)}</td>
                <td className="py-1 pr-3">{h.hitR === null ? '-' : `${h.hitR}R`}</td>
                <td className={`py-1 pr-3 ${toneFor(h.hitProfit)}`}>{h.hitProfit === null ? '-' : money(h.hitProfit)}</td>
                <td className="py-1 pr-3">
                  {h.realPnl === null ? <span className="text-slate-300">not traded</span> : (
                    <span className={`font-bold ${toneFor(h.realPnl)}`} title={h.realLinkNote || ''}>
                      {money(h.realPnl)}
                      {h.realTicket ? <span className="ml-1 font-medium text-slate-400">#{h.realTicket}</span> : null}
                    </span>
                  )}
                </td>
                <td className="py-1 pr-3 text-slate-500">{h.predictedMinutes ?? '-'}m -&gt; <b>{h.actualMinutes ?? '-'}m</b></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hits.length > 25 && (
        <button onClick={() => setShowAll(!showAll)} className="mt-2 text-[11px] font-bold text-violet-600 hover:underline">
          {showAll ? 'Show top 25' : `Show all ${hits.length}`}
        </button>
      )}
    </div>
  );
}

// `embedded` renders the same report as a tab inside /future-predictions/setups: the reports
// tab-bar and the page title belong to the standalone /reports route and would be duplicate
// chrome there. One component, so the two views can never drift apart.
export default function SetupForecastReport({ embedded = false }: { embedded?: boolean } = {}) {
  const [days, setDays] = useState(14);
  const [data, setData] = useState<SetupForecastReportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (spin = false) => {
    if (spin) setLoading(true);
    try { setData(await fetchSetupForecastReport(days)); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to load report'); }
    finally { setLoading(false); }
  }, [days]);

  useEffect(() => { load(true); }, [load]);

  const t = data?.totals;
  const st = data?.settlement;
  const etaErr = data?.timing?.avgActualMinutes !== null && data?.timing?.avgActualMinutes !== undefined
    && data?.timing?.avgEtaMidMinutes !== null && data?.timing?.avgEtaMidMinutes !== undefined
    ? Math.round(data.timing.avgActualMinutes - data.timing.avgEtaMidMinutes)
    : null;

  return (
    <div className={embedded ? 'space-y-4' : 'mx-auto max-w-[1600px] space-y-4 pb-24'}>
      {embedded ? null : <ReportsTabs />}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          {embedded ? (
            <h2 className="flex items-center gap-2 text-sm font-black uppercase tracking-wider text-slate-600">
              <Crosshair size={14} className="text-violet-400" />Forecast accuracy
            </h2>
          ) : (
            <h1 className="flex items-center gap-2 text-xl font-black text-slate-900">
              <Crosshair size={20} className="text-violet-500" />Setup Forecast Accuracy
            </h1>
          )}
          <p className="text-sm font-semibold text-slate-500">
            How many conditional forecasts were made, how many price actually reached, and how many played out the predicted way.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-lg border border-slate-200 bg-slate-50 p-0.5">
            {DAY_OPTIONS.map((d) => (
              <button key={d} type="button" onClick={() => setDays(d)}
                className={`rounded-md px-2.5 py-1 text-xs font-bold transition ${days === d ? 'bg-violet-600 text-white' : 'text-slate-500 hover:bg-white'}`}>
                {d}d
              </button>
            ))}
          </div>
          <button onClick={() => load(true)} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-bold text-slate-600 hover:bg-slate-50">
            {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCcw size={15} />}Refresh
          </button>
        </div>
      </div>

      <ErrorBanner error={error} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Forecasts made" value={numText(t?.forecasts ?? null)} sub={`${t?.waiting ?? 0} still waiting`} tone="violet" />
        <Stat label="Price arrived" value={numText(t?.resolved ?? null)}
          sub={`${pctText(t?.arrivalRate ?? null)} of those that had a verdict`} />
        <Stat label="Played out as predicted" value={numText(t?.matched ?? null)} tone="emerald"
          sub={`${pctText(t?.matchRate ?? null)} of arrivals`} />
        <Stat label="Never arrived" value={numText(t?.expired ?? null)} tone="amber"
          sub="condition never occurred — not a wrong call" />
        <Stat label="Premise changed" value={numText(t?.superseded ?? null)}
          sub="level swept or setup gone before arrival" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="mb-2 text-sm font-black text-slate-700">Timing accuracy</h3>
          <div className="space-y-1 text-[12px] font-semibold text-slate-600">
            <p>Predicted arrival (avg mid-ETA): <b>{numText(data?.timing?.avgEtaMidMinutes ?? null)} min</b></p>
            <p>Actual arrival (avg): <b>{numText(data?.timing?.avgActualMinutes ?? null)} min</b></p>
            <p className={etaErr === null ? 'text-slate-400' : Math.abs(etaErr) <= 30 ? 'text-emerald-700' : 'text-amber-700'}>
              Error: <b>{etaErr === null ? 'n/a' : `${etaErr > 0 ? '+' : ''}${etaErr} min`}</b>
              {etaErr !== null && Math.abs(etaErr) <= 30 ? ' — the ETA band is holding up' : ''}
            </p>
          </div>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="mb-2 text-sm font-black text-slate-700">Follow-through on matched forecasts</h3>
          <div className="space-y-1 text-[12px] font-semibold text-slate-600">
            <p>Best move in the predicted direction: <b className="text-emerald-700">{numText(data?.followThrough?.matchedAvgMfePips ?? null)} pips</b></p>
            <p>Worst move against it: <b className="text-rose-600">{numText(data?.followThrough?.matchedAvgMaePips ?? null)} pips</b></p>
            <p className="text-[11px] font-medium text-slate-400">
              Measured over the bars after the event. A matched scenario is not the same as a winning trade — this shows whether the move followed.
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <GroupTable title="By scenario" keyLabel="Scenario" rows={data?.byScenario || []} />
        <GroupTable title="By leading strategy" keyLabel="Strategy" rows={data?.byStrategy || []} />
        <GroupTable title="By symbol" keyLabel="Symbol" rows={data?.bySymbol || []} />
        <GroupTable title="By timeframe" keyLabel="Timeframe" rows={data?.byTimeframe || []} />
        <GroupTable title="By level type" keyLabel="Level"
          rows={(data?.byLevelType || []).map((r) => ({ ...r, key: levelName(r.key) }))} />
        <GroupTable title="By level source" keyLabel="Source"
          rows={(data?.byLevelSource || []).map((r) => ({ ...r, key: SOURCE_LABEL[r.key] || r.key }))} />
      </div>

      {/* Which strategy actually pays at which KIND of level. This is the table that answers
          "which strategy works best on retests" — and it deliberately shows the sample size
          beside the rate, because a 100% off two arrivals is noise wearing a winner's badge. */}
      <StrategyBySource rows={data?.strategyByLevelSource || []} />

      {/* Two denominators, shown together on purpose.
          A matched scenario is nearly the same event as the ticket reaching target, so the
          matched-only win rate trends toward 100% and must never be quoted alone. */}
      {([
        {
          k: 'all', d: data?.settlement?.allArrived, title: 'If you traded every forecast price reached',
          blurb: 'Mismatches included — this is the honest denominator.', tone: 'violet' as const,
        },
        {
          k: 'matched', d: data?.settlement?.matchedOnly, title: 'Of those that played out as predicted',
          blurb: 'Conditioned on the scenario matching, so it reads optimistic by construction.', tone: 'emerald' as const,
        },
      ]).map(({ k, d, title, blurb, tone }) => (
        <div key={k}>
          <h3 className="mb-1 text-sm font-black text-slate-700">{title}</h3>
          <p className="mb-2 text-[11px] font-semibold text-slate-400">{blurb}</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <Stat label="Settled" value={numText(d?.settled ?? null)}
              sub={`${d?.open ?? 0} still open · ${d?.ambiguous ?? 0} ambiguous`} tone={tone} />
            <Stat label="Win / loss" value={`${d?.wins ?? 0} / ${d?.losses ?? 0}`}
              sub={d?.winRate === null || d?.winRate === undefined ? 'n/a' : `${d.winRate}% of settled`} tone={tone} />
            <Stat label="Realised pips" value={d?.totalPips === null || d?.totalPips === undefined ? 'n/a' : pipsText(d.totalPips)}
              sub={d?.avgPips === null || d?.avgPips === undefined ? '' : `avg ${pipsText(d.avgPips)} each`} />
            <Stat label="Hypothetical P/L" value={money(d?.hypotheticalProfit ?? null)}
              sub="replay at the forecast's own lot size" tone="amber" />
            <Stat label="Real P/L (traded)" value={money(d?.realProfit ?? null)}
              sub={`${d?.realTrades ?? 0} actually traded`} tone="emerald" />
            <Stat label="Not traded" value={numText((d?.forecasts ?? 0) - (d?.realTrades ?? 0))}
              sub="no position taken on these" />
          </div>
        </div>
      ))}

      <SettledTable
        title="Best combos - strategy x timeframe x symbol x level"
        keyLabel="Combo" rows={data?.byCombo || []}
        note="Ranked by hits. Pips replay the forecast ticket on real candles; Real P/L is broker profit on trades actually placed."
      />

      <div className="grid gap-3 lg:grid-cols-2">
        <SettledTable title="Which level type pays" keyLabel="Level"
          rows={(data?.settledByLevelType || []).map((r) => ({ ...r, key: levelName(r.key) }))} />
        <SettledTable title="Which strategy pays" keyLabel="Strategy" rows={data?.settledByStrategy || []} />
      </div>

      <HitsTable hits={data?.hits || []} />

      {(data?.actualsWhenMismatched?.length || 0) > 0 && (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="mb-2 text-sm font-black text-slate-700">When it missed, what happened instead</h3>
          <div className="flex flex-wrap gap-2">
            {data!.actualsWhenMismatched.map((a) => (
              <span key={a.actual} className="rounded-lg bg-slate-100 px-2.5 py-1 text-[12px] font-bold text-slate-600">
                {a.actual === 'GAPPED' ? 'gapped past the level' : a.actual.replace('_', ' ').toLowerCase()}
                <span className="ml-1.5 text-slate-400">×{a.count}</span>
              </span>
            ))}
          </div>
          <p className="mt-2 flex items-start gap-1.5 text-[11px] font-semibold text-slate-400">
            <Info size={12} className="mt-0.5 shrink-0" />
            A miss names what price actually did, so a wrong scenario is distinguishable from a wrong level.
          </p>
        </div>
      )}

      <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
        {[
          'Pips and R replay the forecast’s own entry/SL/TP against real candles from the arrival bar. It measures whether the plan was good, not whether a fill happened.',
          'A bar touching both the stop and a target settles AMBIGUOUS, never a win — OHLC cannot say which came first.',
          'Hypothetical P/L uses the forecast’s own lot size. Real P/L is broker profit on a trade actually placed, linked only when symbol, direction, timing and fill price all agree.',
          'A matched scenario is not a won trade. Match rate and win rate answer different questions and are never combined.',
        ].map((c) => (
          <p key={c} className="flex items-start gap-1.5 text-[11px] font-semibold text-slate-500">
            <Info size={12} className="mt-0.5 shrink-0 text-slate-400" />{c}
          </p>
        ))}
      </div>
    </div>
  );
}
