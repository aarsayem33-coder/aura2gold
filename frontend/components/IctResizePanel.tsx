import React, { useState } from 'react';
import { Loader2, Scale, Send, SlidersHorizontal } from 'lucide-react';
import { previewIctOrder } from '../mt5Api';
import type { IctResizeInput, IctResizePreview } from '../mt5Api';

/**
 * Resize a resting ICT order in MONEY before it is placed.
 *
 * The user types dollars — risk and target — and this shows the price levels those produce plus
 * a verdict on whether the resulting ticket is sound. Preview is a separate round trip from
 * placing on purpose: the whole point is to see the consequences, including the refusals,
 * before committing to them.
 *
 * The verdict matters more than the arithmetic. Converting money to prices always succeeds — it
 * succeeded for the live tickets that came out at 5 lots on a 1.7-pip stop, where the dollar
 * risk was correct and the position was 65x the account.
 */
export default function IctResizePanel({ id, symbol, onPlace, placing }: {
  id: string;
  symbol: string;
  onPlace: (id: string, override: IctResizeInput) => void;
  placing: boolean;
}) {
  const [mode, setMode] = useState<'lots' | 'stop'>('lots');
  const [lots, setLots] = useState('0.05');
  const [stopPips, setStopPips] = useState('20');
  const [slUsd, setSlUsd] = useState('');
  const [tpUsd, setTpUsd] = useState('');
  const [tp3Usd, setTp3Usd] = useState('');
  const [preview, setPreview] = useState<IctResizePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buildInput = (): IctResizeInput => ({
    ...(mode === 'lots' ? { lots: Number(lots) } : { stopPips: Number(stopPips) }),
    slUsd: Number(slUsd),
    tpUsd: tpUsd ? Number(tpUsd) : null,
    tp3Usd: tp3Usd ? Number(tp3Usd) : null,
  });

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await previewIctOrder(id, buildInput()));
    } catch (e) {
      setPreview(null);
      setError(e instanceof Error ? e.message : 'could not price this ticket');
    } finally {
      setBusy(false);
    }
  };

  const v = preview?.validation;
  const t = preview?.ticket;
  const ctx = preview?.context;
  const tone = v?.verdict === 'OK'
    ? 'border-emerald-300 bg-emerald-50'
    : v?.verdict === 'RISKY' ? 'border-amber-300 bg-amber-50' : 'border-rose-300 bg-rose-50';
  const field = 'mt-0.5 w-full rounded border border-slate-200 px-2 py-1 text-sm font-semibold text-slate-800';
  const label = 'text-[10px] font-bold uppercase text-slate-400';

  return (
    <div className="mt-2 rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center gap-2 text-[11px] font-black uppercase tracking-wider text-slate-500">
        <SlidersHorizontal size={12} />
        Resize before placing
      </div>

      <div className="mb-2 flex gap-1">
        {(['lots', 'stop'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`rounded-md px-2 py-1 text-[11px] font-bold ${mode === m ? 'bg-slate-900 text-white' : 'border border-slate-200 text-slate-500'}`}
          >
            {m === 'lots' ? 'I choose lots' : 'I choose stop distance'}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {mode === 'lots' ? (
          <label className={label}>
            Lots
            <input value={lots} onChange={(e) => setLots(e.target.value)} inputMode="decimal" className={field} />
          </label>
        ) : (
          <label className={label}>
            Stop (pips)
            <input value={stopPips} onChange={(e) => setStopPips(e.target.value)} inputMode="decimal" className={field} />
          </label>
        )}
        <label className={label}>
          Risk $
          <input value={slUsd} onChange={(e) => setSlUsd(e.target.value)} inputMode="decimal" placeholder="50" className={field} />
        </label>
        <label className={label}>
          TP1 $
          <input value={tpUsd} onChange={(e) => setTpUsd(e.target.value)} inputMode="decimal" placeholder="50" className={field} />
        </label>
        <label className={label}>
          TP3 $
          <input value={tp3Usd} onChange={(e) => setTp3Usd(e.target.value)} inputMode="decimal" placeholder="150" className={field} />
        </label>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={run}
          disabled={busy || !slUsd}
          className="inline-flex items-center gap-1 rounded-lg border border-sky-200 px-2.5 py-1 text-[11px] font-bold text-sky-700 hover:bg-sky-50 disabled:opacity-40"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Scale size={12} />}
          Check it
        </button>
        {ctx && (
          <span className="text-[10px] font-semibold text-slate-400">
            budget ${ctx.riskBudget ?? '—'}{ctx.riskPct ? ` (${ctx.riskPct}%)` : ''} · ATR {ctx.atrPips ?? '—'}p · spread {ctx.spreadPips ?? '—'}p
            {ctx.originalLots ? ` · auto-sized ${ctx.originalLots} lots` : ''}
          </span>
        )}
      </div>

      {/* Remaining challenge room, when the configured budget is larger than it. Shown rather
          than silently shrinking the budget — that silent shrink is what turned 0.8% into
          $3.07 and produced 0.01-lot tickets. */}
      {ctx?.roomWarning && (
        <p className="mt-2 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-800">
          Room check: {ctx.roomWarning}
        </p>
      )}

      {error && (
        <p className="mt-2 rounded border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] font-semibold text-rose-700">{error}</p>
      )}

      {preview && t && v && (
        <div className={`mt-2 rounded-lg border p-2.5 ${tone}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] font-black uppercase tracking-wide text-slate-700">
              {v.verdict === 'OK' ? 'Looks sound' : v.verdict === 'RISKY' ? 'Will place, but risky' : 'Cannot place'}
            </span>
            <span className="text-[11px] font-bold text-slate-600">
              {t.lots} lots · SL {t.stopLoss} ({t.stopPips}p) · TP3 {t.takeProfit3 ?? '—'} · RR {t.rr ?? '—'}
            </span>
          </div>
          <ul className="mt-1.5 space-y-1 text-[11px]">
            {v.errors.map((e) => <li key={e} className="font-semibold text-rose-700">✕ {e}</li>)}
            {v.warnings.map((w) => <li key={w} className="text-amber-800">⚠ {w}</li>)}
            {v.notes.map((note) => <li key={note} className="text-slate-500">· {note}</li>)}
          </ul>

          {preview.suggestion?.suggestedLots ? (
            <p className="mt-1.5 rounded border border-sky-200 bg-white/70 px-2 py-1 text-[11px] text-sky-800">
              Better:{' '}
              <button
                type="button"
                onClick={() => { setMode('lots'); setLots(String(preview.suggestion?.suggestedLots)); }}
                className="font-black underline"
              >
                {preview.suggestion.suggestedLots} lots
              </button>
              {' '}at {preview.suggestion.suggestedStopPips} pips — {preview.suggestion.why}
            </p>
          ) : null}

          {/* REJECT is binding — those are broker or budget refusals. RISKY still places: the
              user has seen the warnings and it is their decision to make. */}
          {v.verdict !== 'REJECT' && v.verdict !== 'INVALID' && (
            <button
              type="button"
              onClick={() => onPlace(id, buildInput())}
              disabled={placing}
              className="mt-2 inline-flex items-center gap-1 rounded-lg bg-sky-600 px-2.5 py-1 text-[11px] font-bold text-white disabled:opacity-40"
            >
              {placing ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
              Place this resized order on {symbol}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
