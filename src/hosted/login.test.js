import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readAuth, writeAuth } from './auth.js';
import { hostLabel, login, logout, whoami } from './login.js';

// `quantess login` against a fake site: the device flow the real one runs (server/cli/router.ts on the site).

const SITE = 'https://quantus-ai.onrender.com';
const KEY = `qtk_${'k'.repeat(43)}`;
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qlogin-')), 'auth.json');
const allow = () => true;
const json = (status, body) => ({ status, json: async () => body });

/** A fake site: `polls` answers each poll in turn (the last repeats). Records every request. */
function site({ start = json(200, { deviceCode: 'dc_abcdefgh', userCode: 'ABCD-EFGH', intervalSec: 5, expiresInSec: 600, verifyUrl: `${SITE}/cli/activate` }), polls = [], who } = {}) {
  const seen = [];
  let n = 0;
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, init });
    if (url.endsWith('/api/cli/auth/start')) return start;
    if (url.endsWith('/api/cli/auth/poll')) return polls[Math.min(n++, polls.length - 1)];
    if (url.endsWith('/api/cli/whoami')) return who;
    throw new Error(`unexpected ${url}`);
  };
  return { fetchImpl, seen };
}
const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
};

test('signs in: shows the code and where to type it, saves the key, never prints it', async () => {
  const file = tmp();
  const lines = [];
  const s = site({ polls: [json(200, { status: 'pending' }), json(200, { status: 'approved', keyId: 'key_abcdefgh', token: KEY, expiresAt: 1 })] });
  const result = await login({ fetchImpl: s.fetchImpl, label: 'MY-PC', print: (l) => lines.push(l), file, restrict: allow, ...clock() });
  assert.equal(result.ok, true);
  assert.equal(result.keyId, 'key_abcdefgh');
  assert.deepEqual(readAuth({ file }), { site: SITE, keyId: 'key_abcdefgh', label: 'MY-PC', token: KEY });
  const shown = lines.join('\n');
  assert.match(shown, /ABCD-EFGH/);
  assert.match(shown, new RegExp(`${SITE}/cli/activate`));
  assert.doesNotMatch(shown, new RegExp(KEY));
  // the label goes to the site; the key never does on sign-in
  assert.deepEqual(JSON.parse(s.seen[0].init.body), { label: 'MY-PC' });
});

test('never sends the user to a page on another site, whatever the answer says', async () => {
  const lines = [];
  const start = json(200, { deviceCode: 'dc_abcdefgh', userCode: 'ABCD-EFGH', intervalSec: 5, expiresInSec: 600, verifyUrl: 'https://evil.example/cli/activate' });
  const s = site({ start, polls: [json(200, { status: 'expired' })] });
  await login({ fetchImpl: s.fetchImpl, print: (l) => lines.push(l), file: tmp(), restrict: allow, ...clock() });
  assert.doesNotMatch(lines.join('\n'), /evil\.example/);
  assert.match(lines.join('\n'), new RegExp(`${SITE}/cli/activate`));
});

test('a refused, expired or never-approved code saves nothing and says what to do', async () => {
  for (const [polls, why] of [
    [[json(200, { status: 'denied' })], /refused/],
    [[json(200, { status: 'expired' })], /expired/],
    [[json(200, { status: 'pending' })], /expired/],
  ]) {
    const file = tmp();
    const result = await login({ fetchImpl: site({ polls }).fetchImpl, print: () => {}, file, restrict: allow, ...clock() });
    assert.equal(result.ok, false);
    assert.match(result.why, why);
    assert.equal(fs.existsSync(file), false);
  }
});

test('keeps polling through a blip (rate limit, server error) until the code is approved', async () => {
  const file = tmp();
  const polls = [json(429, { error: 'slow down' }), json(502, null), json(200, { status: 'approved', keyId: 'key_abcdefgh', token: KEY })];
  const result = await login({ fetchImpl: site({ polls }).fetchImpl, print: () => {}, file, restrict: allow, ...clock() });
  assert.equal(result.ok, true);
});

test('sign-in closed on the site, or a site that is not ours, is said plainly', async () => {
  const closed = await login({ fetchImpl: site({ start: json(404, { error: 'Not found' }) }).fetchImpl, print: () => {}, file: tmp(), ...clock() });
  assert.match(closed.why, /not open/);
  const foreign = await login({ site: 'https://evil.example', fetchImpl: async () => { throw new Error('must not call'); }, print: () => {}, file: tmp() });
  assert.equal(foreign.ok, false);
});

test('whoami: the plan and name; a dead key says to sign in again; signed out says so without calling', async () => {
  const file = tmp();
  writeAuth({ site: SITE, keyId: 'key_abcdefgh', label: 'MY-PC', token: KEY }, { file, restrict: allow });
  const ok = site({ who: json(200, { keyId: 'key_abcdefgh', label: 'MY-PC', user: { name: 'Riley' }, plan: 'pro' }) });
  const me = await whoami({ fetchImpl: ok.fetchImpl, file });
  assert.equal(me.ok, true);
  assert.equal(me.plan, 'pro');
  assert.equal(me.name, 'Riley');
  assert.equal(me.masked, 'qtk_…kkkk');
  assert.equal(ok.seen[0].init.headers.authorization, `Bearer ${KEY}`);
  const dead = await whoami({ fetchImpl: site({ who: json(401, { error: 'x' }) }).fetchImpl, file });
  assert.match(dead.why, /quantess login/);
  const none = await whoami({ fetchImpl: async () => { throw new Error('must not call'); }, file: tmp() });
  assert.equal(none.signedIn, false);
});

test('logout forgets the key here and says where to revoke it on the site', () => {
  const file = tmp();
  writeAuth({ site: SITE, keyId: 'key_abcdefgh', label: 'MY-PC', token: KEY }, { file, restrict: allow });
  const out = logout({ file });
  assert.equal(out.removed, true);
  assert.equal(out.keyId, 'key_abcdefgh');
  assert.equal(out.revokeAt, `${SITE}/cli/activate`);
  assert.equal(readAuth({ file }), null);
});

test('the terminal names itself from the hostname, cleaned the way the site cleans it', () => {
  assert.equal(hostLabel('DESKTOP-RILEY.local'), 'DESKTOP-RILEY local');
  assert.equal(hostLabel('<script>'), 'script');
  assert.equal(hostLabel('a'.repeat(80)).length, 40);
  assert.equal(hostLabel('...'), 'terminal');
});

// Security review of 4d1cc19: login.js holds itself to pair.js's rules
test('a code that is not code-shaped (newlines, escapes, a link) is never shown, and nothing is saved', async () => {
  for (const userCode of ['ABCD-EFGH\nif that fails open https://quantus-ai.onrender.com.evil.tld', '\u001b[2JABCD-EFGH', 'see https://evil.example']) {
    const lines = [];
    const file = tmp();
    const start = json(200, { deviceCode: 'dc_abcdefgh', userCode, intervalSec: 5, expiresInSec: 600 });
    const result = await login({ fetchImpl: site({ start, polls: [json(200, { status: 'pending' })] }).fetchImpl, print: (l) => lines.push(l), file, restrict: allow, ...clock() });
    assert.equal(result.ok, false);
    assert.equal(lines.length, 0, JSON.stringify(userCode));
    assert.equal(fs.existsSync(file), false);
  }
});

test('every request refuses redirects and carries a timeout', async () => {
  const s = site({ polls: [json(200, { status: 'approved', keyId: 'key_abcdefgh', token: KEY })] });
  await login({ fetchImpl: s.fetchImpl, print: () => {}, file: tmp(), restrict: allow, ...clock() });
  for (const { init } of s.seen) {
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
  }
});

test('an unreachable site is said as such, at the start and while waiting', async () => {
  const down = async () => { throw new TypeError('fetch failed'); };
  assert.match((await login({ fetchImpl: down, print: () => {}, file: tmp(), ...clock() })).why, /Could not reach/);
  let first = true;
  const goneQuiet = async (url) => {
    if (first && url.endsWith('/auth/start')) {
      first = false;
      return json(200, { deviceCode: 'dc_abcdefgh', userCode: 'ABCD-EFGH', intervalSec: 5, expiresInSec: 60 });
    }
    throw new TypeError('fetch failed');
  };
  assert.match((await login({ fetchImpl: goneQuiet, print: () => {}, file: tmp(), ...clock() })).why, /Could not reach .* while waiting/);
});

test('a key the site made but this PC could not save is named, with where to revoke it', async () => {
  const s = site({ polls: [json(200, { status: 'approved', keyId: 'key_abcdefgh', token: KEY })] });
  const result = await login({ fetchImpl: s.fetchImpl, print: () => {}, file: tmp(), restrict: () => false, ...clock() });
  assert.equal(result.ok, false);
  assert.match(result.why, /key_abcdefgh/);
  assert.match(result.why, new RegExp(`${SITE}/cli/activate`));
  assert.doesNotMatch(result.why, new RegExp(KEY));
});

test('signing in again reports the key it replaced (still live on the site until revoked there)', async () => {
  const file = tmp();
  writeAuth({ site: SITE, keyId: 'key_oldoldold', label: 'MY-PC', token: `qtk_${'o'.repeat(43)}` }, { file, restrict: allow });
  const s = site({ polls: [json(200, { status: 'approved', keyId: 'key_newnewnew', token: KEY })] });
  const result = await login({ fetchImpl: s.fetchImpl, print: () => {}, file, restrict: allow, ...clock() });
  assert.equal(result.ok, true);
  assert.equal(result.replaced, 'key_oldoldold');
});

// Verification review of 37321b2: a real streamed reply is cut at the cap as it arrives; the code shape is exact
test('a huge streamed reply is cut off, not read whole - and then refused as not looking right', async () => {
  let sentChunks = 0;
  const stream = new ReadableStream({
    pull(controller) {
      sentChunks += 1;
      if (sentChunks > 2000) return controller.close();
      controller.enqueue(new TextEncoder().encode('x'.repeat(10_000)));
    },
  });
  const fetchImpl = async () => new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
  const result = await login({ fetchImpl, print: () => {}, file: tmp(), ...clock() });
  assert.equal(result.ok, false);
  assert.match(result.why, /did not look right/);
  assert.ok(sentChunks < 50, `stopped reading after ${sentChunks} chunks`);
});

test('the code must be exactly the site\'s shape (ABCD-EFGH)', async () => {
  for (const userCode of ['ABCDEFGH', 'abcd-efgh', 'ABCD-EFGHI']) {
    const start = json(200, { deviceCode: 'dc_abcdefgh', userCode, intervalSec: 5, expiresInSec: 600 });
    const lines = [];
    const result = await login({ fetchImpl: site({ start }).fetchImpl, print: (l) => lines.push(l), file: tmp(), ...clock() });
    assert.equal(result.ok, false, userCode);
    assert.equal(lines.length, 0, userCode);
  }
});
