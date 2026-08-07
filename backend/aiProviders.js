/**
 * aiProviders.js — model + API-key configuration for every LLM this system can talk to.
 *
 * WHERE THE KEYS LIVE, AND WHY NOT IN .cache/
 * Every other user-editable setting sits in backend/.cache/*.json, and API keys must not join
 * them: the whole project tree is inside OneDrive, so anything written there is uploaded to a
 * cloud account and kept in version history. Keys go to %LOCALAPPDATA% (or ~/.config on unix)
 * instead — the same place the local MySQL credentials went, and outside any sync root.
 *
 * WHAT LEAVES THIS MODULE
 * Never a key. `publicConfig()` masks every secret to a recognisable stub, and the write path
 * accepts a KEEP sentinel so the UI can save a form it was never given the secret for. A key
 * that the browser never receives cannot leak from the browser.
 *
 * MODEL LISTS ARE FETCHED, NOT HARDCODED
 * Provider catalogues change constantly and a hardcoded list is wrong within months. Testing a
 * provider asks it what models it has and stores the answer, so the dropdown reflects the
 * account's real access. The SUGGESTED_MODELS below are only a starting point for a provider
 * that has never been tested, and any model id can be typed in by hand.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function configDir() {
  const base = process.platform === 'win32'
    ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
    : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  return path.join(base, 'AuraGoldAlerts');
}
export const AI_CONFIG_FILE = path.join(configDir(), 'ai-providers.json');

/** The providers this system knows how to talk to. */
export const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    keyLabel: 'GEMINI_API_KEY',
    envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    docs: 'https://aistudio.google.com/apikey',
    vision: true,
  },
  openai: {
    label: 'OpenAI (ChatGPT)',
    keyLabel: 'OPENAI_API_KEY',
    envKeys: ['OPENAI_API_KEY'],
    docs: 'https://platform.openai.com/api-keys',
    vision: true,
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    keyLabel: 'ANTHROPIC_API_KEY',
    envKeys: ['ANTHROPIC_API_KEY'],
    docs: 'https://console.anthropic.com/settings/keys',
    vision: true,
  },
  deepseek: {
    label: 'DeepSeek',
    keyLabel: 'DEEPSEEK_API_KEY',
    envKeys: ['DEEPSEEK_API_KEY'],
    docs: 'https://platform.deepseek.com/api_keys',
    vision: false,
  },
};

/** Starting suggestions only — replaced by the live list the moment a provider is tested. */
export const SUGGESTED_MODELS = {
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  openai: ['gpt-4o', 'gpt-4o-mini'],
  anthropic: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
};

/** Sent by the UI in place of a secret it was never given. */
export const KEEP_SENTINEL = '__KEEP__';

const EMPTY = () => ({
  activeProvider: 'gemini',
  providers: Object.fromEntries(Object.keys(PROVIDERS).map((id) => [id, {
    apiKey: '', model: '', models: [], lastTestedAt: null, lastTestOk: null, lastTestNote: null,
  }])),
});

let cache = null;

export function loadAiConfig() {
  if (cache) return cache;
  const base = EMPTY();
  try {
    if (fs.existsSync(AI_CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(AI_CONFIG_FILE, 'utf8')) || {};
      base.activeProvider = saved.activeProvider || base.activeProvider;
      for (const id of Object.keys(PROVIDERS)) {
        base.providers[id] = { ...base.providers[id], ...(saved.providers?.[id] || {}) };
      }
    }
  } catch (err) {
    // A corrupt config must not take the backend down — fall back to env-only operation.
    console.warn('[AiProviders] config unreadable, using environment only:', err.message);
  }
  cache = base;
  return cache;
}

export function saveAiConfig(next) {
  fs.mkdirSync(path.dirname(AI_CONFIG_FILE), { recursive: true });
  // 0600: the key file is readable by this user and nobody else on the machine.
  fs.writeFileSync(AI_CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  try { fs.chmodSync(AI_CONFIG_FILE, 0o600); } catch { /* best effort on Windows */ }
  cache = next;
  return cache;
}

/**
 * The key actually in force for a provider.
 *
 * The saved key wins over the environment so a change made in the UI takes effect without
 * editing .env.local, but the environment still works on a machine that has never opened the
 * settings page.
 */
export function resolveKey(providerId, env = process.env) {
  const saved = String(loadAiConfig().providers?.[providerId]?.apiKey || '').trim();
  if (saved) return saved;
  for (const k of PROVIDERS[providerId]?.envKeys || []) {
    if (env[k]) return String(env[k]).trim();
  }
  return '';
}

/** The model in force, or '' to let the caller keep its own default. */
export function resolveModel(providerId, env = process.env) {
  const saved = String(loadAiConfig().providers?.[providerId]?.model || '').trim();
  if (saved) return saved;
  if (providerId === 'gemini' && env.GEMINI_MODEL) return String(env.GEMINI_MODEL).trim();
  return '';
}

/** Recognisable without being usable: enough to tell two keys apart, not enough to spend. */
export function maskKey(key) {
  const s = String(key || '');
  if (!s) return '';
  if (s.length <= 10) return `${s.slice(0, 2)}…${s.slice(-2)}`;
  return `${s.slice(0, 5)}…${s.slice(-4)}`;
}

/** Everything the settings page needs, and no secrets. */
export function publicConfig(env = process.env) {
  const cfg = loadAiConfig();
  return {
    activeProvider: cfg.activeProvider,
    configFile: AI_CONFIG_FILE,
    providers: Object.entries(PROVIDERS).map(([id, meta]) => {
      const p = cfg.providers[id] || {};
      const savedKey = String(p.apiKey || '').trim();
      const envKey = (meta.envKeys || []).find((k) => env[k]);
      return {
        id, label: meta.label, docs: meta.docs, vision: meta.vision, keyLabel: meta.keyLabel,
        hasKey: Boolean(savedKey || envKey),
        keySource: savedKey ? 'saved' : envKey ? 'environment' : 'none',
        keyMasked: maskKey(savedKey || (envKey ? env[envKey] : '')),
        model: resolveModel(id, env),
        models: Array.isArray(p.models) && p.models.length ? p.models : SUGGESTED_MODELS[id] || [],
        modelsAreLive: Array.isArray(p.models) && p.models.length > 0,
        lastTestedAt: p.lastTestedAt || null,
        lastTestOk: p.lastTestOk ?? null,
        lastTestNote: p.lastTestNote || null,
      };
    }),
  };
}

/**
 * Merge an update, treating the KEEP sentinel and an omitted key as "leave the secret alone".
 * An empty string is an explicit clear — the only way to remove a key deliberately.
 */
export function applyUpdate(update = {}) {
  const cfg = loadAiConfig();
  const next = { activeProvider: cfg.activeProvider, providers: { ...cfg.providers } };
  if (update.activeProvider && PROVIDERS[update.activeProvider]) next.activeProvider = update.activeProvider;

  for (const [id, patch] of Object.entries(update.providers || {})) {
    if (!PROVIDERS[id]) continue;
    const cur = { ...(cfg.providers[id] || {}) };
    if (patch.model !== undefined) cur.model = String(patch.model || '').trim();
    if (patch.apiKey !== undefined && patch.apiKey !== KEEP_SENTINEL) {
      cur.apiKey = String(patch.apiKey || '').trim();
      // A changed key invalidates what the old one proved.
      cur.lastTestOk = null; cur.lastTestNote = null; cur.lastTestedAt = null;
    }
    next.providers[id] = cur;
  }
  return saveAiConfig(next);
}

export function recordTest(providerId, { ok, note, models }) {
  const cfg = loadAiConfig();
  const next = { activeProvider: cfg.activeProvider, providers: { ...cfg.providers } };
  next.providers[providerId] = {
    ...(cfg.providers[providerId] || {}),
    lastTestedAt: new Date().toISOString(),
    lastTestOk: Boolean(ok),
    lastTestNote: String(note || '').slice(0, 200),
    ...(Array.isArray(models) && models.length ? { models: models.slice(0, 60) } : {}),
  };
  return saveAiConfig(next);
}

/**
 * Prove a key works by asking the provider what models it has.
 *
 * A list call rather than a completion: it costs no tokens, it validates the credential for
 * real, and the answer populates the model dropdown with this account's actual access instead
 * of a catalogue that goes stale.
 */
export async function testProvider(providerId, key, { timeoutMs = 15000, fetchImpl = fetch } = {}) {
  if (!PROVIDERS[providerId]) return { ok: false, note: 'unknown provider' };
  if (!key) return { ok: false, note: 'no API key set' };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let url, headers;
    if (providerId === 'gemini') {
      url = 'https://generativelanguage.googleapis.com/v1beta/models';
      headers = { 'x-goog-api-key': key };
    } else if (providerId === 'anthropic') {
      url = 'https://api.anthropic.com/v1/models';
      headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    } else if (providerId === 'deepseek') {
      url = 'https://api.deepseek.com/models';
      headers = { Authorization: `Bearer ${key}` };
    } else {
      url = 'https://api.openai.com/v1/models';
      headers = { Authorization: `Bearer ${key}` };
    }

    const res = await fetchImpl(url, { headers, signal: ctl.signal });
    if (!res.ok) {
      // Report the status, never the body — an error body can echo the key back.
      const note = res.status === 401 || res.status === 403
        ? 'the API rejected this key (401/403)'
        : `provider returned ${res.status}`;
      return { ok: false, note };
    }
    const body = await res.json().catch(() => ({}));
    const models = extractModels(providerId, body);
    return { ok: true, note: `key works — ${models.length} models available`, models };
  } catch (err) {
    return { ok: false, note: err.name === 'AbortError' ? 'timed out reaching the provider' : `could not reach the provider: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

function extractModels(providerId, body) {
  const raw = providerId === 'gemini' ? (body.models || []) : (body.data || []);
  const ids = raw.map((m) => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean);
  if (providerId === 'gemini') {
    // The list includes embedding and tuning endpoints; only generative ones can run an analysis.
    return ids.filter((id) => /gemini/i.test(id) && !/embedding|aqa|imagen/i.test(id)).sort();
  }
  if (providerId === 'openai') return ids.filter((id) => /^(gpt|o\d)/i.test(id)).sort();
  return ids.sort();
}

/** Test-only: drop the memoised config so a fresh file is read. */
export function _resetCache() { cache = null; }
