import test from 'node:test';
import assert from 'node:assert/strict';
import { HOSTED_MODELS, hostedModel, resolveProvider } from './provider.js';

// Where model calls go: your own OpenRouter key straight to OpenRouter (as before), else the QUAN-TESS proxy on your
// plan after `quantess login`, else nowhere (sign in first).

const auth = { site: 'https://quantus-ai.onrender.com', keyId: 'key_abcdefgh', label: 'MY-PC', token: `qtk_${'a'.repeat(43)}` };

test('your own OpenRouter key: direct, exactly as before (the rig that has one keeps it)', () => {
  const p = resolveProvider({ env: { OPENROUTER_API_KEY: 'sk-or-v1-x' }, auth });
  assert.equal(p.mode, 'direct');
  assert.equal(p.baseURL, 'https://openrouter.ai/api/v1');
  assert.equal(p.apiKey, 'sk-or-v1-x');
});

test('no key of your own but signed in: hosted - the site proxy, with the terminal key', () => {
  const p = resolveProvider({ env: {}, auth });
  assert.equal(p.mode, 'hosted');
  assert.equal(p.baseURL, 'https://quantus-ai.onrender.com/api/cli/v1');
  assert.equal(p.apiKey, auth.token);
  assert.equal(p.keyId, 'key_abcdefgh');
});

test('QUANTESS_HOSTED=1 picks the proxy even with your own key; without a sign-in it is "none", never your key', () => {
  assert.equal(resolveProvider({ env: { OPENROUTER_API_KEY: 'sk-or-v1-x', QUANTESS_HOSTED: '1' }, auth }).mode, 'hosted');
  const p = resolveProvider({ env: { OPENROUTER_API_KEY: 'sk-or-v1-x', QUANTESS_HOSTED: '1' }, auth: null });
  assert.equal(p.mode, 'none');
  assert.equal(p.apiKey, undefined);
});

test('neither: none (the terminal says to sign in)', () => {
  assert.equal(resolveProvider({ env: {}, auth: null }).mode, 'none');
});

test('hosted calls use only the models the proxy takes; anything else becomes the right default', () => {
  assert.equal(hostedModel('nvidia/nemotron-3-ultra-550b-a55b'), HOSTED_MODELS.deep);
  assert.equal(hostedModel('nvidia/nemotron-3.5-super-vl'), HOSTED_MODELS.vision);
  assert.equal(hostedModel('cohere/north-mini-code:free'), HOSTED_MODELS.default);
  assert.equal(hostedModel('nvidia/nemotron-3.5-lightning:free'), HOSTED_MODELS.default);
  assert.equal(hostedModel(undefined, 'vision'), HOSTED_MODELS.vision);
});

// Security review of 4d1cc19: a cloned repo's .env must not move a signed-in user onto its own OpenRouter account
test('a placeholder key is not a key: signed in stays on the plan, signed out has nothing', () => {
  assert.equal(resolveProvider({ env: { OPENROUTER_API_KEY: 'your_key_here' }, auth, fromProject: new Set() }).mode, 'hosted');
  assert.equal(resolveProvider({ env: { OPENROUTER_API_KEY: 'your_key_here' }, auth: null, fromProject: new Set() }).mode, 'none');
});

test('a project .env key never takes a signed-in user off the plan; your own (real) key still does', () => {
  const env = { OPENROUTER_API_KEY: 'sk-or-v1-fake-from-the-repo' };
  assert.equal(resolveProvider({ env, auth, fromProject: new Set(['OPENROUTER_API_KEY']) }).mode, 'hosted');
  assert.equal(resolveProvider({ env, auth, fromProject: new Set() }).mode, 'direct', 'set by the user: direct');
  assert.equal(resolveProvider({ env, auth: null, fromProject: new Set(['OPENROUTER_API_KEY']) }).mode, 'direct', 'not signed in: as before');
});

test('hosted clients make no hidden retries (a proxy timeout charges the hold); direct keeps the SDK default', async () => {
  const { providerClient } = await import('./provider.js');
  assert.equal(providerClient({ mode: 'hosted', baseURL: 'https://quantus-ai.onrender.com/api/cli/v1', apiKey: auth.token }).maxRetries, 0);
  assert.equal(providerClient({ mode: 'direct', baseURL: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-v1-x' }).maxRetries, 2);
});

// Verification review of 37321b2: Windows variables ignore case; a key with stray spaces is still the key
test('a project .env key written in lower case is still the project\'s (Windows ignores case)', async () => {
  const { loadProjectEnv, PROJECT_ENV_KEYS } = await import('./config/index.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qenv-'));
  fs.writeFileSync(path.join(dir, '.env'), 'openrouter_api_key=sk-or-v1-fake-from-the-repo\n');
  loadProjectEnv(dir, {});
  assert.ok(PROJECT_ENV_KEYS.has('OPENROUTER_API_KEY'));
  assert.equal(resolveProvider({ env: { OPENROUTER_API_KEY: 'sk-or-v1-fake-from-the-repo' }, auth, fromProject: PROJECT_ENV_KEYS }).mode, 'hosted');
});

test('a key with stray spaces around it still picks direct, and is sent trimmed', () => {
  const p = resolveProvider({ env: { OPENROUTER_API_KEY: '  sk-or-v1-x \n' }, auth: null, fromProject: new Set() });
  assert.equal(p.mode, 'direct');
  assert.equal(p.apiKey, 'sk-or-v1-x');
});

test('useProvider: a sign-in picked up mid-session is what provider() hands web_search and look_at_image', async () => {
  const { provider, useProvider } = await import('./provider.js');
  const fresh = { mode: 'hosted', baseURL: 'https://quantus-ai.onrender.com/api/cli/v1', apiKey: auth.token, keyId: 'key_new' };
  useProvider(fresh);
  assert.equal(provider(), fresh);
});
