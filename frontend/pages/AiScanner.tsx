import React, { useCallback, useEffect, useState } from 'react';
import { Radar, Loader2, RefreshCw, Mail, MailX, Info, Clock } from 'lucide-react';
import { fetchAiScanner, runAiScannerNow, placeScannerItem } from '../mt5Api';
import type { AiScannerResponse, AiScannerItem } from '../mt5Api';

/**
 * The hourly AI sweep.
 *
 * Three engines answer the same question about the same six symbols, once an hour, and every
 * run is kept — including the quiet ones. A run with zero opportunities is evidence the scanner
 * ran and found nothing, which is a different fact from the scanner being broken, and the page
 * has to be able to tell you which one you are looking at.
 */
const fmt = (v: number | null | undefined, dp = 5) => (v === null || v === undefined ? '—' : v.toFixed(dp));
const money = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(2)}`;

const SOURCE_STYLE: Record<string, string> = {
  CHART_AI: 'bg-violet-100 text-violet-800',
  SETUP_FORECAST: 'bg-sky-100 text-sky-800',
  ICT_PREDICT: 'bg-amber-100 text-amber-800',
};
const SOURCE_LABEL: Record<string, string> = {
  CHART_AI: 'Chart AI', SETUP_FORECAST: 'Setup forecast', ICT_PREDICT: 'ICT predict',
};
const ORDER_STYLE: Record<string, string> = {
  CLOSED: 'bg-slate-800 text-white', FILLED: 'bg-emerald-600 text-white',
  PLACED: 'bg-sky-100 text-sky-800', SENT: 'bg-sky-50 text-sky-700',
  QUEUED: 'bg-amber-100 text-amber-800', REJECTED: 'bg-slate-100 text-slate-400',
  CANCELLED: 'bg-slate-100 text-slate-400', EXPIRED: 'bg-slate-100 text-slate-400',
  ERROR: 'bg-rose-600 text-white',
};

export default function AiScanner() {
  const [data, setData] = useState<AiScannerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placing, setPlacing] = useState<string | null>(null);
  const [placed, setPlaced] = useState<Record<string, string>>({});
  const [openRun, setOpenRun] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { const d = await fetchAiScanner(12); setData(d); setError(null); if (!openRun && d.runs[0]) setOpenRun(d.runs[0].id); }
    catch (e) { setError(e instanceof Error ? e.message : 'could not load scanner records'); }
    finally { setLoading(false); }
  }, [openRun]);

  useEffect(() => { void load(); const t = setInterval(() => void load(), 60000); return () => clearInterval(t); }, [load]);

  const scanNow = async () => {
    setScanning(true); setError(null);
    try {
      const r = await runAiScannerNow();
      if (!r.ok) setError(r.error || 'scan failed');
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'scan failed'); }
    finally { setScanning(false); }
  };

  const place = async (item: AiScannerItem) => {
    if (!item.placeUrl) return;
    setPlacing(item.id); setError(null);
    try {
      const r = await placeScannerItem(item.placeUrl);
      setPlaced((p) => ({ ...p, [item.id]: `${r.orderType || 'order'} queued · ${r.lots ?? '?'} lots` }));
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'could not place this order'); }
    finally { setPlacing(null); }
  };

  const runs = data?.runs || [];
  const latest = runs[0];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-violet-100 p-2"><Radar className="text-violet-600" size={22} /></div>
          <div>
            <h1 className="text-xl font-black text-slate-900">AI Scanner</h1>
            <p className="text-xs font-medium text-slate-400">
              Three engines, {data?.symbols.length ?? 6} symbols on {data?.timeframe || 'H1'}, once an hour — one email, every run kept.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-lg px-2 py-1 text-[11px] font-black ${data?.enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-400'}`}>
            {data?.enabled ? `every ${data.intervalMinutes}m` : 'disabled'}
          </span>
          <span className={`rounded-lg px-2 py-1 text-[11px] font-black ${data?.bridgeReady && data?.armedMatch ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
            MT5 {data?.mode || '—'}
          </span>
          <button type="button" onClick={() => void scanNow()} disabled={scanning}
            className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-2.5 py-1.5 text-[12px] font-black text-white transition hover:bg-violet-700 disabled:bg-slate-300">
            {scanning ? <Loader2 className="animate-spin" size={13} /> : <Radar size={13} />} Scan now
          </button>
          <button type="button" onClick={() => void load()}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[12px] font-bold text-slate-600 hover:bg-slate-50">
            {loading ? <Loader2 className="animate-spin" size={13} /> : <RefreshCw size={13} />} Refresh
          </button>
        </div>
      </div>

      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] font-bold text-rose-700">{error}</div>}

      {latest && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-3">
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Last sweep</p>
            <p className="mt-0.5 text-lg font-black text-slate-900">
              {latest.ranAt ? new Date(latest.ranAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
            </p>
            <p className="text-[10px] font-bold text-slate-400">{latest.ranAt ? new Date(latest.ranAt).toLocaleDateString() : ''}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-3">
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Opportunities</p>
            <p className={`mt-0.5 text-lg font-black ${latest.opportunities ? 'text-emerald-700' : 'text-slate-400'}`}>{latest.opportunities}</p>
            <p className="text-[10px] font-bold text-slate-400">from {latest.reads} engine reads</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-3">
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Email</p>
            <p className="mt-0.5 flex items-center gap-1 text-lg font-black text-slate-900">
              {latest.emailed ? <><Mail size={16} className="text-emerald-600" /> sent</> : <><MailX size={16} className="text-slate-300" /> no</>}
            </p>
            <p className="truncate text-[10px] font-bold text-slate-400">{latest.emailTo || 'no recipient set'}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-3">
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Watchlist</p>
            <p className="mt-0.5 text-lg font-black text-slate-900">{latest.symbols.length}</p>
            <p className="truncate text-[10px] font-bold text-slate-400">{latest.symbols.join(' · ')}</p>
          </div>
        </div>
      )}

      {runs.map((run) => (
        <div key={run.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <button type="button" onClick={() => setOpenRun(openRun === run.id ? null : run.id)}
            className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left hover:bg-slate-50">
            <Clock size={13} className="text-slate-400" />
            <span className="text-[12px] font-black text-slate-800">
              {run.ranAt ? new Date(run.ranAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
            </span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${run.opportunities ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-400'}`}>
              {run.opportunities} setup{run.opportunities === 1 ? '' : 's'}
            </span>
            <span className="text-[11px] font-bold text-slate-400">{run.reads} reads</span>
            {run.emailed && <Mail size={12} className="text-emerald-500" />}
            <span className="ml-auto text-[10px] font-black uppercase tracking-wider text-violet-600">{openRun === run.id ? 'hide' : 'show'}</span>
          </button>

          {openRun === run.id && (
            run.items.length ? (
              <div className="overflow-x-auto border-t border-slate-100">
                <table className="w-full min-w-[1080px] text-left text-[12px]">
                  <thead className="bg-slate-50 text-[10px] font-black uppercase tracking-wider text-slate-400">
                    <tr>
                      <th className="px-3 py-2">Symbol</th>
                      <th className="px-3 py-2">Dir</th>
                      <th className="px-3 py-2">Source</th>
                      <th className="px-3 py-2 text-right">Entry</th>
                      <th className="px-3 py-2 text-right">Stop</th>
                      <th className="px-3 py-2 text-right">TP 1 / 2 / 3</th>
                      <th className="px-3 py-2 text-right">Lots</th>
                      <th className="px-3 py-2 text-right">Score</th>
                      <th className="px-3 py-2">Enter</th>
                      <th className="px-3 py-2 text-right">Order</th>
                    </tr>
                  </thead>
                  <tbody>
                    {run.items.map((i) => (
                      <tr key={i.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                        <td className="whitespace-nowrap px-3 py-2 font-black text-slate-800">
                          {i.symbol} <span className="font-bold text-slate-400">{i.timeframe}</span>
                        </td>
                        <td className="px-3 py-2">
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${
                            i.direction === 'BUY' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}`}>{i.direction}</span>
                        </td>
                        <td className="px-3 py-2">
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${SOURCE_STYLE[i.source] || 'bg-slate-100 text-slate-600'}`}>
                            {SOURCE_LABEL[i.source] || i.source}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right font-mono font-black text-slate-800">{fmt(i.entry)}</td>
                        <td className="px-3 py-2 text-right font-mono text-rose-600">{fmt(i.stopLoss)}</td>
                        <td className="px-3 py-2 text-right font-mono text-[10px] leading-tight text-emerald-700">
                          {fmt(i.takeProfit1)}<br />{fmt(i.takeProfit2)}<br />{fmt(i.takeProfit3)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <span className="font-black text-slate-800">{i.lots ?? '—'}</span>
                          <div className="text-[10px] font-bold text-slate-400">{i.riskUsd === null ? '' : `${money(i.riskUsd)} risk`}</div>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <span className="font-black text-slate-800">{i.score ?? '—'}</span>
                          {i.grade && <span className="ml-1 text-slate-400">{i.grade}</span>}
                          {(i.confidence !== null || i.rr !== null) && (
                            <div className="text-[10px] font-bold text-slate-400">
                              {[i.confidence !== null ? `conf ${i.confidence}` : null,
                                i.rr !== null ? `RR ${i.rr}` : null].filter(Boolean).join(' · ')}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-[11px] font-bold text-slate-600">{i.entryTiming || '—'}</td>
                        <td className="px-3 py-2 text-right">
                          {i.order ? (
                            <span className={`rounded px-1.5 py-0.5 text-[10px] font-black ${ORDER_STYLE[i.order.status] || 'bg-slate-100 text-slate-500'}`}>
                              {i.order.status}{i.order.profit !== null ? ` ${money(i.order.profit)}` : ''}
                            </span>
                          ) : placed[i.id] ? (
                            <span className="text-[10px] font-black text-emerald-700">{placed[i.id]}</span>
                          ) : i.placeUrl ? (
                            <button type="button" disabled={placing === i.id} onClick={() => void place(i)}
                              className="rounded-lg border border-violet-300 px-2 py-1 text-[10px] font-black text-violet-700 transition hover:border-violet-500 hover:bg-violet-50 disabled:text-slate-300">
                              {placing === i.id ? 'sending…' : 'Place limit'}
                            </button>
                          ) : <span className="text-[10px] font-bold text-slate-300">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="border-t border-slate-100 px-3 py-4 text-[12px] font-bold text-slate-400">
                Nothing tradeable this hour — {run.reads} engine reads produced no entry worth resting an order on.
                Most hours do not contain a trade.
              </p>
            )
          )}
        </div>
      ))}

      {!runs.length && !loading && (
        <div className="rounded-2xl border border-slate-200 bg-white px-3 py-6 text-center">
          <p className="text-[12px] font-bold text-slate-400">No sweeps recorded yet. The first runs a few minutes after the backend starts.</p>
        </div>
      )}

      {data?.note && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-slate-400"><Info size={11} /> How this works</p>
          <p className="mt-0.5 text-[11px] font-medium leading-snug text-slate-500">{data.note}</p>
          <p className="mt-0.5 text-[11px] font-medium leading-snug text-slate-500">
            Placing sends the order through the engine that produced it, with that engine's own guard stack —
            armed-account match, correct side of market, broker minimum stop, concurrency cap and the challenge breach guard.
          </p>
        </div>
      )}
    </div>
  );
}
