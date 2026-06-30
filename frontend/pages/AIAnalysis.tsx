import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Brain, CheckCircle2, Clock, XCircle, Upload, Image as ImageIcon, AlertTriangle, Sparkles, Cpu, Target, Timer } from 'lucide-react';
import DecisionCard from '../components/DecisionCard';
import { useMt5Stream, fetchChartAnalysis } from '../mt5Api';
import type { ChartAnalysisResponse } from '../types';
import { formatBdDateTime } from '../utils/time';

function outcomeIcon(outcome: string) {
  if (outcome === 'WIN') return <CheckCircle2 size={16} className="text-emerald-400" />;
  if (outcome === 'LOSS') return <XCircle size={16} className="text-red-400" />;
  return <Clock size={16} className="text-slate-500" />;
}

const TF_FALLBACK = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];
const fmt = (v: number | null | undefined) => (v === null || v === undefined ? '—' : String(v));

// Client-side downscale + JPEG compress so the base64 payload stays small.
function compressImage(file: File, maxDim = 1600, quality = 0.85): Promise<{ base64: string; mimeType: string; dataUrl: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.onload = () => {
      const img = new window.Image();
      img.onerror = () => reject(new Error('Could not decode the image.'));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('Canvas not supported.'));
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        resolve({ dataUrl, mimeType: 'image/jpeg', base64: dataUrl.replace(/^data:[^;]+;base64,/, '') });
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

function Badge({ children, tone = 'slate' }: { children: React.ReactNode; tone?: 'slate' | 'green' | 'red' | 'amber' | 'indigo' }) {
  const tones: Record<string, string> = {
    slate: 'bg-slate-100 text-slate-700 border-slate-200',
    green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    red: 'bg-red-50 text-red-700 border-red-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    indigo: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  };
  return <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-bold ${tones[tone]}`}>{children}</span>;
}

function dirTone(d?: string | null): 'green' | 'red' | 'slate' {
  const v = String(d || '').toUpperCase();
  if (['BUY', 'UP', 'STRONG_BUY'].includes(v)) return 'green';
  if (['SELL', 'DOWN', 'STRONG_SELL'].includes(v)) return 'red';
  return 'slate';
}

function ChartResult({ r }: { r: ChartAnalysisResponse }) {
  const fx = r.forexPlan;
  const ftt = r.fttPlan;
  const trig = ftt?.timeTrigger;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {r.source === 'gemini-vision'
          ? <Badge tone="green"><Sparkles size={12} /> AI Vision (Gemini)</Badge>
          : <Badge tone="amber"><Cpu size={12} /> System Fallback (deterministic)</Badge>}
        <Badge tone="slate">{r.symbol} {r.timeframe}</Badge>
        {r.verdict && <Badge tone="indigo">{r.verdict.replace(/_/g, ' ')}</Badge>}
        {r.confidence != null && <Badge tone="slate">Confidence {r.confidence}</Badge>}
        {r.detection?.trend && <Badge tone={dirTone(r.detection.trend)}>Trend: {r.detection.trend}</Badge>}
        {r.detection?.regime && <Badge tone="slate">{r.detection.regime}</Badge>}
      </div>
      {r.note && <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800"><AlertTriangle size={13} className="mr-1 inline" />{r.note}</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Forex ticket */}
        {fx && (
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="mb-2 flex items-center gap-2"><Target size={16} className="text-amber-500" /><h3 className="text-sm font-black text-slate-900">Forex Plan</h3><Badge tone={dirTone(fx.decision)}>{fx.decision}</Badge>{fx.grade && <Badge tone="slate">{fx.grade}</Badge>}</div>
            {fx.decision === 'HOLD' ? (
              <p className="text-sm font-semibold text-slate-500">No forex setup — WAIT. {fx.invalidation || ''}</p>
            ) : (
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-sm">
                <div className="text-slate-500">Entry</div><div className="text-right font-bold text-slate-900">{fmt(fx.entry)}</div>
                <div className="text-slate-500">Stop loss</div><div className="text-right font-bold text-red-600">{fmt(fx.stopLoss)}</div>
                <div className="text-slate-500">TP1 / TP2 / TP3</div><div className="text-right font-bold text-emerald-600">{fmt(fx.takeProfit1)} / {fmt(fx.takeProfit2)} / {fmt(fx.takeProfit3)}</div>
                <div className="text-slate-500">Volume (lots)</div><div className="text-right font-bold text-slate-900">{fmt(fx.lots)}</div>
                <div className="text-slate-500">Risk : Reward</div><div className="text-right font-bold text-slate-900">{fmt(fx.riskReward)}</div>
                {fx.lossAtStop != null && (<><div className="text-slate-500">Risk if stopped</div><div className="text-right font-bold text-slate-900">{fmt(fx.lossAtStop)}</div></>)}
              </div>
            )}
            {fx.invalidation && fx.decision !== 'HOLD' && <p className="mt-2 text-xs text-slate-500">Invalidation: {fx.invalidation}</p>}
          </div>
        )}

        {/* Fixed-Time ticket */}
        {ftt && (
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="mb-2 flex items-center gap-2"><Timer size={16} className="text-indigo-500" /><h3 className="text-sm font-black text-slate-900">Fixed-Time Plan</h3><Badge tone={dirTone(ftt.direction)}>{ftt.direction}</Badge></div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-sm">
              <div className="text-slate-500">Suggested TF</div><div className="text-right font-bold text-slate-900">{fmt(ftt.suggestedTimeframe)}{ftt.expiry ? ` · ${ftt.expiry}` : ''}</div>
              <div className="text-slate-500">Stays in direction</div><div className="text-right font-bold text-slate-900">{ftt.expectedCandlesInDirection != null ? `~${ftt.expectedCandlesInDirection} candles` : '—'}{ftt.persistenceRange ? ` (${fmt(ftt.persistenceRange.low)}–${fmt(ftt.persistenceRange.high)})` : ''}</div>
              {ftt.confidence != null && (<><div className="text-slate-500">Confidence</div><div className="text-right font-bold text-slate-900">{ftt.confidence}</div></>)}
            </div>
            {trig && trig.atLabel && trig.condition && (
              <div className="mt-3 rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm font-bold text-indigo-900">
                ⏰ At {trig.atLabel} — trade {ftt.direction} only if price is {trig.condition} {fmt(trig.level)}, else IGNORE.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Breakout + strategies */}
      <div className="flex flex-wrap items-center gap-2">
        {r.breakout && r.breakout.phase
          ? <Badge tone={dirTone(r.breakout.direction)}>Breakout: {r.breakout.phase} {r.breakout.direction} ({r.breakout.grade})</Badge>
          : <Badge tone="slate">No breakout detected</Badge>}
        {(r.strategies || []).map((s) => (
          <Badge key={s.id} tone={dirTone(s.decision)}>{s.name}: {s.decision}{s.score != null ? ` ${s.score}` : ''}</Badge>
        ))}
      </div>

      {r.reasoning && <p className="rounded-2xl border border-slate-200 bg-white p-4 text-sm leading-6 text-slate-600 whitespace-pre-line">{r.reasoning}</p>}
      {(r.honesty || []).map((h, i) => <p key={i} className="text-xs font-semibold text-slate-400">⚠ {h}</p>)}
    </div>
  );
}

export default function AIAnalysis() {
  const { aiDecisions, status } = useMt5Stream();
  const latest = aiDecisions[0] || status.latestAiDecision || null;
  const wins = aiDecisions.filter((decision) => decision.outcome === 'WIN').length;
  const scored = aiDecisions.filter((decision) => ['WIN', 'LOSS', 'BREAKEVEN'].includes(decision.outcome));
  const winRate = scored.length ? Math.round((wins / scored.length) * 100) : 0;

  const symbols = useMemo(() => (status.symbols || []).slice().sort(), [status.symbols]);
  const timeframes = useMemo(() => (status.timeframes && status.timeframes.length ? status.timeframes : TF_FALLBACK), [status.timeframes]);

  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [base64, setBase64] = useState<string | null>(null);
  const [mimeType, setMimeType] = useState('image/jpeg');
  const [symbol, setSymbol] = useState('');
  const [timeframe, setTimeframe] = useState('M15');
  const [mode, setMode] = useState<'FOREX' | 'FTT' | 'BOTH'>('BOTH');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ChartAnalysisResponse | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (!symbol && symbols.length) setSymbol(symbols[0]); }, [symbols, symbol]);

  const ingestFile = useCallback(async (file: File | null | undefined) => {
    if (!file || !file.type.startsWith('image/')) { setError('Please choose an image file (PNG/JPEG).'); return; }
    setError(null);
    try {
      const { dataUrl: url, base64: b64, mimeType: mt } = await compressImage(file);
      setDataUrl(url); setBase64(b64); setMimeType(mt); setResult(null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not process the image.'); }
  }, []);

  const onPaste = useCallback((e: React.ClipboardEvent) => {
    const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith('image/'));
    if (item) void ingestFile(item.getAsFile());
  }, [ingestFile]);

  const analyze = useCallback(async () => {
    if (!base64 || !symbol) { setError('Upload a chart image and select a symbol first.'); return; }
    setLoading(true); setError(null);
    try {
      const r = await fetchChartAnalysis({ imageBase64: base64, mimeType, symbol, timeframe, tradeMode: mode });
      setResult(r);
    } catch (e) { setError(e instanceof Error ? e.message : 'Analysis failed.'); }
    finally { setLoading(false); }
  }, [base64, symbol, timeframe, mode, mimeType]);

  return (
    <div className="terminal-page -m-6 min-h-screen space-y-6 p-6 lg:-m-10 lg:p-10">
      <div>
        <p className="text-xs font-black uppercase tracking-[0.32em] text-amber-600">Gemini</p>
        <h1 className="mt-2 text-4xl font-black tracking-tight text-slate-900">AI Analysis</h1>
      </div>

      {/* ── Chart image analysis ── */}
      <section className="light-card rounded-3xl p-6" onPaste={onPaste}>
        <div className="mb-4 flex items-center gap-3 text-slate-900"><ImageIcon className="text-amber-500" size={20} /><h2 className="text-xl font-black">Analyze a Chart Image</h2></div>
        <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
          {/* Upload + controls */}
          <div className="space-y-3">
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); void ingestFile(e.dataTransfer.files?.[0]); }}
              onClick={() => fileRef.current?.click()}
              className="flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50 p-4 text-center hover:border-amber-400"
            >
              {dataUrl
                ? <img src={dataUrl} alt="chart" className="max-h-44 w-full rounded-lg object-contain" />
                : <><Upload size={22} className="mb-2 text-slate-400" /><p className="text-sm font-bold text-slate-600">Drop, paste, or click to upload</p><p className="text-xs text-slate-400">PNG / JPEG chart screenshot</p></>}
            </div>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => void ingestFile(e.target.files?.[0])} />

            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs font-bold text-slate-500">Symbol
                <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm font-semibold text-slate-800">
                  {!symbols.length && <option value="">No streamed symbols</option>}
                  {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label className="text-xs font-bold text-slate-500">Timeframe
                <select value={timeframe} onChange={(e) => setTimeframe(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm font-semibold text-slate-800">
                  {timeframes.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
            </div>
            <p className="text-[11px] font-semibold text-slate-400">Symbol + timeframe ground the AI and power the system fallback.</p>

            <div className="flex gap-1.5">
              {(['FOREX', 'FTT', 'BOTH'] as const).map((m) => (
                <button key={m} type="button" onClick={() => setMode(m)} className={`flex-1 rounded-lg border px-2 py-1.5 text-xs font-bold ${mode === m ? 'border-amber-400 bg-amber-50 text-amber-700' : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'}`}>{m === 'FTT' ? 'Fixed-Time' : m === 'FOREX' ? 'Forex' : 'Both'}</button>
              ))}
            </div>

            <button type="button" onClick={() => void analyze()} disabled={loading || !base64 || !symbol}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-black text-white shadow-sm hover:bg-amber-600 disabled:cursor-not-allowed disabled:bg-slate-300">
              {loading ? <><Clock size={16} className="animate-spin" /> Analyzing…</> : <><Brain size={16} /> Analyze Chart</>}
            </button>
            {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{error}</p>}
          </div>

          {/* Result */}
          <div>
            {result ? <ChartResult r={result} />
              : <div className="flex h-full min-h-[220px] items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm font-semibold text-slate-400">Upload a chart, pick the symbol + timeframe, then Analyze. You'll get a forex ticket (entry/SL/TP/lots) and a fixed-time call with timing — or a deterministic system read if AI vision is unavailable.</div>}
          </div>
        </div>
      </section>

      <DecisionCard decision={latest} />
      <div className="grid gap-4 md:grid-cols-4">
        <div className="light-card rounded-3xl p-5"><p className="text-slate-500">Decisions</p><p className="font-mono text-3xl font-black text-slate-900">{aiDecisions.length}</p></div>
        <div className="light-card rounded-3xl p-5"><p className="text-slate-500">Win Rate</p><p className="font-mono text-3xl font-black text-slate-900">{winRate}%</p></div>
        <div className="light-card rounded-3xl p-5"><p className="text-slate-500">Pending</p><p className="font-mono text-3xl font-black text-slate-900">{aiDecisions.filter((d) => d.outcome === 'PENDING').length}</p></div>
        <div className="light-card rounded-3xl p-5"><p className="text-slate-500">Model</p><p className="font-mono text-lg font-black text-slate-900">{status.geminiModel || 'n/a'}</p></div>
      </div>
      <section className="light-card rounded-3xl p-6">
        <div className="mb-5 flex items-center gap-3 text-slate-900"><Brain className="text-amber-500" size={20} /><h2 className="text-xl font-black">Decision History</h2></div>
        <div className="space-y-3">
          {aiDecisions.map((decision) => (
            <div key={decision.id} className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">{outcomeIcon(decision.outcome)}<span className="font-bold text-slate-900">{decision.symbol} {decision.timeframe}</span><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-700">{decision.decision}</span></div>
                <span className="font-mono text-sm text-slate-400">{formatBdDateTime(decision.created_at)}</span>
              </div>
              <p className="mt-3 text-sm leading-6 text-slate-600">{decision.reasoning}</p>
            </div>
          ))}
          {!aiDecisions.length && <p className="rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm font-semibold text-slate-500">No AI decisions yet. Run analysis from the Trading Terminal.</p>}
        </div>
      </section>
    </div>
  );
}
