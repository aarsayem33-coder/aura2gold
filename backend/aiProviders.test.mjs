import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Point the module at a scratch LOCALAPPDATA so the real key file is never touched.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-ai-cfg-'));
process.env.LOCALAPPDATA = TMP;
process.env.XDG_CONFIG_HOME = TMP;

const {
  maskKey, publicConfig, applyUpdate, loadAiConfig, saveAiConfig, resolveKey, resolveModel,
  testProvider, recordTest, PROVIDERS, SUGGESTED_MODELS, KEEP_SENTINEL, AI_CONFIG_FILE, _resetCache,
} = await import('./aiProviders.js');

const reset = () => {
  try { fs.rmSync(AI_CONFIG_FILE, { force: true }); } catch { /* nothing to remove */ }
  _resetCache();
};

// ── the keys never leave ─────────────────────────────────────────────────────

test('a key is masked to something recognisable but unusable', () => {
  assert.equal(maskKey('sk-proj-abcdefghijklmnop1234'), 'sk-pr…1234');
  assert.equal(maskKey('short'), 'sh…rt');
  assert.equal(maskKey(''), '');
  assert.equal(maskKey(null), '');
});

test('publicConfig NEVER contains a full key', () => {
  reset();
  const secret = 'sk-ant-supersecretvalue-0987654321';
  applyUpdate({ providers: { anthropic: { apiKey: secret, model: 'claude-opus-5' } } });
  const pub = JSON.stringify(publicConfig({}));
  assert.ok(!pub.includes(secret), 'the raw key reached the public payload');
  assert.ok(!pub.includes('supersecret'), 'part of the key reached the public payload');
  assert.ok(pub.includes('sk-an…4321'), 'the masked stub should still be shown');
});

test('the key file is written outside the project tree', () => {
  reset();
  applyUpdate({ providers: { openai: { apiKey: 'sk-test-123456789' } } });
  assert.ok(fs.existsSync(AI_CONFIG_FILE));
  // The project lives inside OneDrive; anything written there is uploaded and version-kept.
  assert.ok(!/aura-gold-alerts/i.test(AI_CONFIG_FILE), `key file is inside the project: ${AI_CONFIG_FILE}`);
  assert.ok(!/OneDrive/i.test(AI_CONFIG_FILE), `key file is inside a sync root: ${AI_CONFIG_FILE}`);
});

// ── saving ───────────────────────────────────────────────────────────────────

test('the KEEP sentinel preserves a secret the browser was never given', () => {
  reset();
  applyUpdate({ providers: { openai: { apiKey: 'sk-original-key-value' } } });
  applyUpdate({ providers: { openai: { apiKey: KEEP_SENTINEL, model: 'gpt-4o' } } });
  assert.equal(resolveKey('openai', {}), 'sk-original-key-value');
  assert.equal(resolveModel('openai', {}), 'gpt-4o');
});

test('an omitted key also preserves the secret', () => {
  reset();
  applyUpdate({ providers: { deepseek: { apiKey: 'ds-key-1' } } });
  applyUpdate({ providers: { deepseek: { model: 'deepseek-reasoner' } } });
  assert.equal(resolveKey('deepseek', {}), 'ds-key-1');
});

test('an empty string is an explicit clear — the only way to remove a key', () => {
  reset();
  applyUpdate({ providers: { deepseek: { apiKey: 'ds-key-1' } } });
  applyUpdate({ providers: { deepseek: { apiKey: '' } } });
  assert.equal(resolveKey('deepseek', {}), '');
});

test('changing a key invalidates what the previous one proved', () => {
  reset();
  applyUpdate({ providers: { openai: { apiKey: 'sk-a' } } });
  recordTest('openai', { ok: true, note: 'key works', models: ['gpt-4o'] });
  assert.equal(loadAiConfig().providers.openai.lastTestOk, true);
  applyUpdate({ providers: { openai: { apiKey: 'sk-b' } } });
  assert.equal(loadAiConfig().providers.openai.lastTestOk, null, 'a new key must not inherit the old key\'s pass');
});

test('an unknown provider is ignored rather than stored', () => {
  reset();
  applyUpdate({ activeProvider: 'not-a-provider', providers: { bogus: { apiKey: 'x' } } });
  const cfg = loadAiConfig();
  assert.equal(cfg.activeProvider, 'gemini');
  assert.equal(cfg.providers.bogus, undefined);
});

// ── precedence ───────────────────────────────────────────────────────────────

test('a saved key overrides the environment, so the UI works without editing .env', () => {
  reset();
  assert.equal(resolveKey('gemini', { GEMINI_API_KEY: 'from-env' }), 'from-env');
  applyUpdate({ providers: { gemini: { apiKey: 'from-ui' } } });
  assert.equal(resolveKey('gemini', { GEMINI_API_KEY: 'from-env' }), 'from-ui');
});

test('the environment still works on a machine that never opened settings', () => {
  reset();
  assert.equal(resolveKey('openai', { OPENAI_API_KEY: 'sk-env' }), 'sk-env');
  assert.equal(resolveModel('gemini', { GEMINI_MODEL: 'gemini-2.5-pro' }), 'gemini-2.5-pro');
  const pub = publicConfig({ OPENAI_API_KEY: 'sk-env-abcdefgh' });
  const openai = pub.providers.find((p) => p.id === 'openai');
  assert.equal(openai.hasKey, true);
  assert.equal(openai.keySource, 'environment');
});

test('every provider is listed even before it is configured', () => {
  reset();
  const pub = publicConfig({});
  assert.deepEqual(pub.providers.map((p) => p.id).sort(), Object.keys(PROVIDERS).sort());
  for (const p of pub.providers) {
    assert.ok(p.models.length > 0, `${p.id} should offer starting suggestions`);
    assert.equal(p.modelsAreLive, false);
  }
});

// ── the connection test ──────────────────────────────────────────────────────

const fakeFetch = (status, body) => async () => ({
  ok: status >= 200 && status < 300, status, json: async () => body,
});

test('a working key returns the live model list', async () => {
  const r = await testProvider('openai', 'sk-x', {
    fetchImpl: fakeFetch(200, { data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }, { id: 'text-embedding-3' }] }),
  });
  assert.equal(r.ok, true);
  // Only models that could actually run an analysis.
  assert.deepEqual(r.models, ['gpt-4o', 'gpt-4o-mini']);
});

test('gemini list output is unwrapped and filtered to generative models', async () => {
  const r = await testProvider('gemini', 'k', {
    fetchImpl: fakeFetch(200, { models: [{ name: 'models/gemini-2.5-pro' }, { name: 'models/text-embedding-004' }] }),
  });
  assert.deepEqual(r.models, ['gemini-2.5-pro']);
});

test('a rejected key says so plainly', async () => {
  const r = await testProvider('anthropic', 'bad', { fetchImpl: fakeFetch(401, {}) });
  assert.equal(r.ok, false);
  assert.match(r.note, /rejected this key/);
});

test('a test failure never echoes the key back', async () => {
  // Provider error bodies have been known to quote the offending credential.
  const key = 'sk-leaky-secret-value';
  const r = await testProvider('openai', key, {
    fetchImpl: fakeFetch(400, { error: { message: `invalid key ${key}` } }),
  });
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes(key), 'the key was echoed in the test result');
});

test('no key is refused before any network call is attempted', async () => {
  let called = false;
  const r = await testProvider('openai', '', { fetchImpl: async () => { called = true; return {}; } });
  assert.equal(r.ok, false);
  assert.equal(called, false);
});

test('an unreachable provider fails closed with a readable reason', async () => {
  const r = await testProvider('deepseek', 'k', {
    fetchImpl: async () => { throw new Error('ENOTFOUND'); },
  });
  assert.equal(r.ok, false);
  assert.match(r.note, /could not reach/);
});

test('a corrupt config file does not take the backend down', () => {
  reset();
  fs.mkdirSync(path.dirname(AI_CONFIG_FILE), { recursive: true });
  fs.writeFileSync(AI_CONFIG_FILE, '{ not json');
  _resetCache();
  const cfg = loadAiConfig();
  assert.equal(cfg.activeProvider, 'gemini');
  assert.ok(cfg.providers.gemini);
});
