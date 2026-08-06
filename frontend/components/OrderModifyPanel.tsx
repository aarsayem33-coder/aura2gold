import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Pencil, Save, RefreshCw, AlertTriangle } from 'lucide-react';
import { fetchOrderModify, previewOrderModify, commitOrderModify } from '../mt5Api';
import type { OrderModifyRead, OrderModifyPreview, OrderModifyChanges } from '../mt5Api';

/**
 * Modify a resting limit order, showing every unit at once.
 *
 * A pending order means four different things to four different questions — where the levels sit
 * (price), how far they are (pips), what it costs and pays (USD), and the size tying them
 * together (lots). Editing any one of them moves the other three, so all four are always on
 * screen. Showing only prices makes a 2-pip stop look like a 40-pip one; showing only dollars
 * hides that $80 of risk became 3.2 lots. Both mistakes have already happened on this account.
 *
 * Preview is a separate round trip from committing: the whole point is to see the consequences,
 * including a lot change forcing a cancel-and-replace, before anything reaches the broker.
 */
export default function OrderModifyPanel({ orderId, onDone }: {
  orderId: string;
  onDone?: () => void;
}) {
  const [read, setRead] = useState<OrderModifyRead | null>(null);
  const [preview, setPreview] = useState<OrderModifyPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Each leg is edited in ONE unit at a time; the server recomputes the other three from the
  // result, so the views can never drift apart.
  const [unit, setUnit] = useState<'price' | 'pips' | 'usd'>('pips');
  const [lots, setLots] = useState('');
  const [sl, setSl] = useState('');
  const [tp1, setTp1] = useState('');
  const [tp3, setTp3] = useState('');

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetchOrderModify(orderId);
      setRead(r);
      setLots(String(r.order.lots ?? ''));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not read this order');
    } finally {
      setBusy(false);
    }
  }, [orderId]);

  useEffect(() => { void load(); }, [load]);

  const buildChanges = (): OrderModifyChanges => {
    const c: OrderModifyChanges = {};
    const key = (base: string) => `${base}${unit === 'price' ? 'Price' : unit === 'pips' ? 'Pips' : 'Usd'}`;
    if (lots && Number(lots) > 0) c.lots = Number(lots);
    if (sl) (c as Record<string, unknown>)[key('sl')] = Number(sl);
    if (tp1) (c as Record<string, unknown>)[key('tp1')] = Number(tp1);
    if (tp3) (c as Record<string, unknown>)[key('tp3')] = Number(tp3);
    return c;
  };

  const run = async () => {
    setBusy(true); setError(null); setNotice(null);
    try {
      setPreview(await previewOrderModify(orderId, buildChanges()));
    } catch (e) {
      setPreview(null);
      setError(e instanceof Error ? e.message : 'could not price this change');
    } finally { setBusy(false); }
  };

  const commit = async () => {
    setSaving(true); setError(null);
    try {
      const r = await commitOrderModify(orderId, buildChanges());
      setNotice(r.replaced
        ? `Lot size changed, so the order is being cancelled and re-placed (${r.newId}). ${r.note}`
        : r.note);
      setPreview(null);
      await load();
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'the broker refused this change');
    } finally { setSaving(false); }
  };

  const o = read?.order;
  const p = preview?.plan;
  const v = preview?.validation;
  const field = 'mt-0.5 w-full rounded border border-slate-200 px-2 py-1 text-sm font-semibold text-slate-800';
  const label = 'text-[10px] font-bold uppercase text-slate-400';
  const money = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `$${x.toFixed(2)}`);

  /** One leg, in all four units, before and after. */
  const Leg = ({ name, before, after }: {
    name: string;
    before?: { price: number; pips: number | null; usd: number | null; correctSide: boolean } | null;
    after?: { price: number; pips: number | null; usd: number | null; correctSide: boolean } | null;
  }) => {
    if (!before && !after) return null;
    const shown = after || before;
    const moved = before && after && Math.abs(before.price - after.price) > 1e-12;
    return (
      <tr className={moved ? 'bg-amber-50' : ''}>
        <td className="px-2 py-1.5 font-bold text-slate-700">{name}</td>
        <td className="px-2 py-1.5 text-right tabular-nums">{shown?.price}</td>
        <td className="px-2 py-1.5 text-right tabular-nums">{shown?.pips ?? '—'}</td>
        <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{money(shown?.usd)}</td>
        <td className="px-2 py-1.5 text-right text-[11px] text-slate-400">
          {moved ? `was ${before?.price} · ${before?.pips}p · ${money(before?.usd)}` : ''}
          {shown && !shown.correctSide ? <span className="font-bold text-rose-600"> wrong side</span> : null}
        </td>
      </tr>
    );
  };

  return (
    <div className="mt-2 rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 text-[11px] font-black uppercase tracking-wider text-slate-500">
          <Pencil size={12} />Modify resting order
        </span>
        <button type="button" onClick={load} disabled={busy}
          className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-400 hover:text-slate-600">
          <RefreshCw size={11} className={busy ? 'animate-spin' : ''} />reload
        </button>
      </div>

      {error && <p className="mb-2 rounded border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] font-semibold text-rose-700">{error}</p>}
      {notice && <p className="mb-2 rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-800">{notice}</p>}

      {o && (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
            <span className="font-bold text-slate-700">{o.symbol} {o.timeframe} {o.direction}</span>
            <span>{o.orderType} · {o.status}{o.ticket ? ` · #${o.ticket}` : ''}</span>
            <span>entry {o.entry}</span>
            <span className="font-semibold">{o.lots} lots</span>
            <span>risk {money(o.riskUsd)} · reward {money(o.rewardUsd)} · RR {o.rr ?? '—'}</span>
            {o.notionalMultiple !== null && (
              <span className={o.notionalMultiple > 20 ? 'font-bold text-amber-700' : ''}>
                {o.notionalMultiple}x account notional
              </span>
            )}
          </div>

          {!o.modifiable && (
            <p className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-800">
              This order is {String(o.status).toLowerCase()} — only a resting order can be modified.
            </p>
          )}

          {o.modifiable && (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-1">
                <span className={label}>Edit levels in</span>
                {(['pips', 'price', 'usd'] as const).map((u) => (
                  <button key={u} type="button" onClick={() => setUnit(u)}
                    className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${unit === u ? 'bg-slate-900 text-white' : 'border border-slate-200 text-slate-500'}`}>
                    {u === 'usd' ? 'USD' : u}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <label className={label}>Lots
                  <input value={lots} onChange={(e) => setLots(e.target.value)} inputMode="decimal" className={field} />
                </label>
                <label className={label}>Stop ({unit})
                  <input value={sl} onChange={(e) => setSl(e.target.value)} inputMode="decimal"
                    placeholder={String(unit === 'price' ? o.stop?.price ?? '' : unit === 'pips' ? o.stop?.pips ?? '' : o.stop?.usd ?? '')} className={field} />
                </label>
                <label className={label}>TP1 ({unit})
                  <input value={tp1} onChange={(e) => setTp1(e.target.value)} inputMode="decimal"
                    placeholder={String(unit === 'price' ? o.tp1?.price ?? '' : unit === 'pips' ? o.tp1?.pips ?? '' : o.tp1?.usd ?? '')} className={field} />
                </label>
                <label className={label}>TP3 ({unit})
                  <input value={tp3} onChange={(e) => setTp3(e.target.value)} inputMode="decimal"
                    placeholder={String(unit === 'price' ? o.tp3?.price ?? '' : unit === 'pips' ? o.tp3?.pips ?? '' : o.tp3?.usd ?? '')} className={field} />
                </label>
              </div>

              <button type="button" onClick={run} disabled={busy}
                className="mt-2 inline-flex items-center gap-1 rounded-lg border border-sky-200 px-2.5 py-1 text-[11px] font-bold text-sky-700 hover:bg-sky-50 disabled:opacity-40">
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Pencil size={12} />}Preview change
              </button>
            </>
          )}
        </>
      )}

      {p && v && (
        <div className={`mt-3 rounded-lg border p-2.5 ${v.verdict === 'OK' ? 'border-emerald-300 bg-emerald-50' : v.verdict === 'RISKY' ? 'border-amber-300 bg-amber-50' : 'border-rose-300 bg-rose-50'}`}>
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] font-black uppercase tracking-wide text-slate-700">
              {v.verdict === 'OK' ? 'Ready to send' : v.verdict === 'RISKY' ? 'Will send, but check this' : 'Broker would refuse'}
            </span>
            <span className="text-[11px] font-bold text-slate-600">
              {p.after.lots} lots · risk {money(p.after.riskUsd)} · RR {p.after.rr ?? '—'}
            </span>
          </div>

          <div className="overflow-x-auto rounded border border-white/60 bg-white/70">
            <table className="w-full min-w-[420px] text-[11px]">
              <thead className="text-[10px] uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="px-2 py-1 text-left font-black">Leg</th>
                  <th className="px-2 py-1 text-right font-black">Price</th>
                  <th className="px-2 py-1 text-right font-black">Pips</th>
                  <th className="px-2 py-1 text-right font-black">USD</th>
                  <th className="px-2 py-1 text-right font-black">Change</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                <Leg name="Stop" before={p.before.stop} after={p.after.stop} />
                <Leg name="TP1" before={p.before.tp1} after={p.after.tp1} />
                <Leg name="TP2" before={p.before.tp2} after={p.after.tp2} />
                <Leg name="TP3" before={p.before.tp3} after={p.after.tp3} />
              </tbody>
            </table>
          </div>

          {p.requiresReplace && (
            <p className="mt-1.5 flex gap-1.5 rounded border border-amber-300 bg-amber-100 px-2 py-1 text-[11px] font-semibold text-amber-900">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />{p.replaceWarning}
            </p>
          )}

          <ul className="mt-1.5 space-y-1 text-[11px]">
            {v.errors.map((e) => <li key={e} className="font-semibold text-rose-700">✕ {e}</li>)}
            {v.warnings.filter((w) => w !== p.replaceWarning).map((w) => <li key={w} className="text-amber-800">⚠ {w}</li>)}
          </ul>

          {/* REJECT is the broker refusing. Everything else is the user's call. */}
          {v.verdict !== 'REJECT' && !p.unchanged && (
            <button type="button" onClick={commit} disabled={saving}
              className="mt-2 inline-flex items-center gap-1 rounded-lg bg-sky-600 px-2.5 py-1 text-[11px] font-bold text-white disabled:opacity-40">
              {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              {p.requiresReplace ? 'Cancel and re-place' : 'Send to MT5'}
            </button>
          )}
          {p.unchanged && <p className="mt-1.5 text-[11px] text-slate-500">Nothing changed.</p>}
        </div>
      )}
    </div>
  );
}
