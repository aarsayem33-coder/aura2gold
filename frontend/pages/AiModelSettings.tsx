import React, { useCallback, useEffect, useState } from 'react';
import { Cpu, Loader2, RefreshCw, Check, X, ExternalLink, ShieldCheck, Eye, EyeOff, Save } from 'lucide-react';
import { fetchAiConfig, saveAiConfig, testAiProvider, AI_KEY_KEEP } from '../mt5Api';
import type { AiConfigResponse, AiProviderConfig } from '../mt5Api';

/**
 * AI models and API keys.
 *
 * The page never receives a key. Reads come back masked, and saving sends a sentinel meaning
 * "keep the one you already have" unless the field was actually typed into — so a secret the
 * browser never holds cannot leak from the browser.
 *
 * Model lists are fetched from each provider rather than hardcoded: testing a key asks the
 * account what it can actually run, which is both a real credential check and a dropdown that
 * cannot go stale.
 */
export default function AiModelSettings() {
  const [cfg, setCfg] = useState<AiConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Only providers the user actually typed a key for appear here.
  const [keyEdits, setKeyEdits] = useState<Record<string, string>>({});
  const [modelEdits, setModelEdits] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try { setCfg(await fetchAiConfig()); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'could not load AI settings'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const modelFor = (p: AiProviderConfig) => modelEdits[p.id] ?? p.model ?? '';

  const save = async (id?: string) => {
    setBusy(id || 'all'); setError(null); setSaved(null);
    try {
      const ids = id ? [id] : Object.keys({ ...keyEdits, ...modelEdits });
      const providers: Record<string, { apiKey?: string; model?: string }> = {};
      for (const pid of ids) {
        providers[pid] = {
          // Untouched fields send the sentinel, never a blank that would clear the key.
          apiKey: keyEdits[pid] !== undefined ? keyEdits[pid] : AI_KEY_KEEP,
          model: modelEdits[pid] !== undefined ? modelEdits[pid] : undefined,
        };
      }
      const next = await saveAiConfig({ providers });
      setCfg(next);
      setKeyEdits((k) => { const c = { ...k }; ids.forEach((i) => delete c[i]); return c; });
      setModelEdits((m) => { const c = { ...m }; ids.forEach((i) => delete c[i]); return c; });
      setSaved(id ? `${id} saved` : 'settings saved');
    } catch (e) { setError(e instanceof Error ? e.message : 'save failed'); }
    finally { setBusy(null); }
  };

  const test = async (p: AiProviderConfig) => {
    setBusy(p.id); setError(null); setSaved(null);
    try {
      const r = await testAiProvider(p.id, keyEdits[p.id]);
      setCfg(r);
      setSaved(`${p.label}: ${r.note}`);
    } catch (e) { setError(e instanceof Error ? e.message : 'test failed'); }
    finally { setBusy(null); }
  };

  const setActive = async (id: string) => {
    setBusy(id); setError(null);
    try { setCfg(await saveAiConfig({ activeProvider: id })); setSaved(`${id} is now the preferred provider`); }
    catch (e) { setError(e instanceof Error ? e.message : 'could not switch provider'); }
    finally { setBusy(null); }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-violet-100 p-2"><Cpu className="text-violet-600" size={22} /></div>
          <div>
            <h1 className="text-xl font-black text-slate-900">AI Models &amp; API Keys</h1>
            <p className="text-xs font-medium text-slate-400">
              Change the model the analysis runs on, and manage the key for each provider.
            </p>
          </div>
        </div>
        <button type="button" onClick={() => void load()}
          className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[12px] font-bold text-slate-600 hover:bg-slate-50">
          {loading ? <Loader2 className="animate-spin" size={13} /> : <RefreshCw size={13} />} Refresh
        </button>
      </div>

      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] font-bold text-rose-700">{error}</div>}
      {saved && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] font-bold text-emerald-700">{saved}</div>}

      <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
        <p className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-slate-500">
          <ShieldCheck size={12} /> Where your keys are stored
        </p>
        <p className="mt-0.5 font-mono text-[11px] text-slate-500">{cfg?.configFile || '—'}</p>
        <p className="mt-0.5 text-[11px] font-medium leading-snug text-slate-500">
          Deliberately outside the project folder, which is inside OneDrive — anything written there would be
          uploaded and kept in version history. Keys are never sent back to this page; you only ever see the
          masked stub, and leaving a field untouched keeps the existing key.
        </p>
      </div>

      {(cfg?.providers || []).map((p) => {
        const isActive = cfg?.activeProvider === p.id;
        const dirty = keyEdits[p.id] !== undefined || (modelEdits[p.id] !== undefined && modelEdits[p.id] !== p.model);
        return (
          <div key={p.id} className={`rounded-2xl border bg-white p-3 ${isActive ? 'border-violet-300 ring-1 ring-violet-200' : 'border-slate-200'}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-black text-slate-900">{p.label}</span>
              {isActive && <span className="rounded bg-violet-600 px-1.5 py-0.5 text-[9px] font-black text-white">PREFERRED</span>}
              {p.vision
                ? <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-black text-slate-600">reads charts</span>
                : <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[9px] font-black text-amber-700">text only</span>}
              {p.hasKey
                ? <span className="flex items-center gap-1 text-[10px] font-black text-emerald-700"><Check size={11} /> key set ({p.keySource})</span>
                : <span className="flex items-center gap-1 text-[10px] font-black text-slate-400"><X size={11} /> no key</span>}
              {p.lastTestOk === true && <span className="text-[10px] font-bold text-emerald-600">✓ {p.lastTestNote}</span>}
              {p.lastTestOk === false && <span className="text-[10px] font-bold text-rose-600">✗ {p.lastTestNote}</span>}
              <a href={p.docs} target="_blank" rel="noreferrer"
                className="ml-auto flex items-center gap-1 text-[10px] font-bold text-slate-400 hover:text-violet-600">
                get a key <ExternalLink size={10} />
              </a>
            </div>

            <div className="mt-2 grid gap-2 md:grid-cols-2">
              <div>
                <label className="text-[10px] font-black uppercase tracking-wider text-slate-400">{p.keyLabel}</label>
                <div className="mt-0.5 flex gap-1">
                  <input
                    type={reveal[p.id] ? 'text' : 'password'}
                    value={keyEdits[p.id] ?? ''}
                    placeholder={p.hasKey ? `${p.keyMasked} — leave blank to keep` : 'paste the API key'}
                    onChange={(e) => setKeyEdits((k) => ({ ...k, [p.id]: e.target.value }))}
                    autoComplete="off" spellCheck={false}
                    className="w-full rounded-lg border border-slate-200 px-2 py-1.5 font-mono text-[11px] text-slate-700 focus:border-violet-400 focus:outline-none"
                  />
                  <button type="button" onClick={() => setReveal((r) => ({ ...r, [p.id]: !r[p.id] }))}
                    title={reveal[p.id] ? 'hide' : 'show what you typed'}
                    className="rounded-lg border border-slate-200 px-2 text-slate-400 hover:text-slate-600">
                    {reveal[p.id] ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </div>
                {keyEdits[p.id] === '' && p.hasKey && (
                  <p className="mt-0.5 text-[10px] font-bold text-amber-700">Saving now would CLEAR the stored key.</p>
                )}
              </div>

              <div>
                <label className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                  Model {p.modelsAreLive ? <span className="text-emerald-600">(live from your account)</span> : <span className="text-slate-300">(suggested — test to load yours)</span>}
                </label>
                <div className="mt-0.5 flex gap-1">
                  <input
                    list={`models-${p.id}`} value={modelFor(p)}
                    placeholder="default"
                    onChange={(e) => setModelEdits((m) => ({ ...m, [p.id]: e.target.value }))}
                    className="w-full rounded-lg border border-slate-200 px-2 py-1.5 font-mono text-[11px] text-slate-700 focus:border-violet-400 focus:outline-none"
                  />
                  {/* A datalist, not a select: provider catalogues change, and a model id you
                      know exists should never be un-typeable because our list is behind. */}
                  <datalist id={`models-${p.id}`}>
                    {p.models.map((m) => <option key={m} value={m} />)}
                  </datalist>
                </div>
              </div>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <button type="button" disabled={busy === p.id || !dirty} onClick={() => void save(p.id)}
                className="flex items-center gap-1 rounded-lg bg-violet-600 px-2.5 py-1.5 text-[11px] font-black text-white transition hover:bg-violet-700 disabled:bg-slate-200 disabled:text-slate-400">
                {busy === p.id ? <Loader2 className="animate-spin" size={12} /> : <Save size={12} />} Save
              </button>
              <button type="button" disabled={busy === p.id} onClick={() => void test(p)}
                className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 transition hover:bg-slate-50 disabled:text-slate-300">
                Test key &amp; load models
              </button>
              {!isActive && (
                <button type="button" disabled={busy === p.id || !p.hasKey} onClick={() => void setActive(p.id)}
                  className="rounded-lg border border-violet-200 px-2.5 py-1.5 text-[11px] font-bold text-violet-700 transition hover:bg-violet-50 disabled:border-slate-200 disabled:text-slate-300">
                  Prefer this provider
                </button>
              )}
            </div>
          </div>
        );
      })}

      <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
        <p className="text-[10px] font-black uppercase tracking-wider text-amber-700">What is wired today</p>
        <p className="mt-0.5 text-[11px] font-medium leading-snug text-amber-900">
          Changing the <strong>Gemini model</strong> takes effect on the next analysis — no restart. Keys for OpenAI,
          Anthropic and DeepSeek are stored and their connection tests are real, but the chart and forecast
          reviewers still run on Gemini; routing them to another provider is a separate change. The page tells
          you the truth about this rather than implying a switch that has not been built.
        </p>
      </div>
    </div>
  );
}
