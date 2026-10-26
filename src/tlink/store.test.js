import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkOrigin, readPairing, writePairing, clearPairing, maskToken, scrubToken, liveToken, restrictToOwner } from './store.js';

// T-LINK pairing file (security model 2 + 5): the device token lives only here, is sent only to the
// origin it was paired with, and is never shown in full

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tlink-store-'));
const TOKEN = `tlk_${'A'.repeat(43)}`;
const good = (over = {}) => ({ origin: 'https://quantus-ai.onrender.com', deviceId: 'dev_12345678', token: TOKEN,
  expiresAt: Date.now() + 86_400_000, ...over });

test('checkOrigin: https anywhere, http only for this PC, normalized to scheme + host', () => {
  assert.deepEqual(checkOrigin('https://quantus-ai.onrender.com/'), { ok: true, origin: 'https://quantus-ai.onrender.com' });
  assert.deepEqual(checkOrigin('http://localhost:3000'), { ok: true, origin: 'http://localhost:3000' });
  assert.equal(checkOrigin('http://127.0.0.1:5173').ok, true);
});

test('negative: checkOrigin refuses plain http elsewhere, look-alike hosts, credentials, paths and odd schemes', () => {
  for (const bad of ['http://quantus-ai.onrender.com', 'http://localhost.evil.com', 'http://localhost@evil.com',
    'https://user:pw@quantus-ai.onrender.com', 'https://quantus-ai.onrender.com/api', 'https://x.com/?a=1',
    'javascript:alert(1)', 'file:///C:/x', 'not a url', '', null]) {
    assert.equal(checkOrigin(bad).ok, false, String(bad));
  }
});

test('a pairing round-trips, and the file is restricted to the owner when written', () => {
  const file = path.join(dir(), 'tlink.json');
  let restricted = null;
  writePairing(good(), { file, restrict: (f) => { restricted = f; return true; } });
  assert.match(String(restricted), /tlink\.json\.[0-9a-f]+\.tmp$/, 'locked as a temp file, before it takes the real name');
  assert.equal(readPairing({ file }).token, TOKEN);
  clearPairing({ file });
  assert.equal(readPairing({ file }), null);
});

test('negative: a missing, corrupt, expired or misshapen pairing reads as unpaired', () => {
  const d = dir();
  const file = path.join(d, 'tlink.json');
  assert.equal(readPairing({ file }), null, 'missing');
  fs.writeFileSync(file, '{not json');
  assert.equal(readPairing({ file }), null, 'corrupt');
  for (const over of [{ expiresAt: Date.now() - 1 }, { token: 'tlk_short' }, { token: `xyz_${'A'.repeat(43)}` },
    { origin: 'http://evil.com' }, { deviceId: '../../x' }]) {
    fs.writeFileSync(file, JSON.stringify(good(over)));
    assert.equal(readPairing({ file }), null, JSON.stringify(over));
  }
});

test('negative: writing a bad pairing throws and leaves nothing behind', () => {
  const file = path.join(dir(), 'tlink.json');
  assert.throws(() => writePairing(good({ origin: 'http://evil.com' }), { file, restrict: () => true }), /origin/);
  assert.equal(fs.existsSync(file), false);
});

test('maskToken shows only the last 4 characters', () => {
  assert.equal(maskToken(`tlk_${'x'.repeat(39)}ab12`), 'tlk_…ab12');
  assert.equal(maskToken(undefined), '(none)');
});

// Review 10-24 (H1/H4): a rewritten or planted tlink.json must never send the key anywhere but the real site
test('negative: a pairing whose origin is not the QUAN-TESS site (or this PC) reads as unpaired and cannot be written', () => {
  const file = path.join(dir(), 'tlink.json');
  fs.writeFileSync(file, JSON.stringify(good({ origin: 'https://evil.example' })));
  assert.equal(readPairing({ file }), null);
  assert.throws(() => writePairing(good({ origin: 'https://evil.example' }), { file: path.join(dir(), 't.json'), restrict: () => true }), /origin/);
  fs.writeFileSync(file, JSON.stringify(good({ origin: 'http://localhost:3000' })));
  assert.equal(readPairing({ file }).origin, 'http://localhost:3000', 'local testing still works');
});

test('negative: when the file cannot be locked to the owner, nothing is saved (fail closed)', () => {
  const file = path.join(dir(), 'tlink.json');
  assert.throws(() => writePairing(good(), { file, restrict: () => false }), /lock/);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [], 'no temp file left behind');
});

test('the key is locked BEFORE it takes the real name (written to a temp file, restricted, then renamed)', () => {
  const file = path.join(dir(), 'tlink.json');
  let lockedPath = null;
  writePairing(good(), { file, restrict: (f) => { lockedPath = f; assert.equal(fs.existsSync(file), false); return true; } });
  assert.notEqual(lockedPath, file);
  assert.equal(readPairing({ file }).token, TOKEN);
});

test('restrictToOwner runs icacls from System32 with the domain-qualified user', () => {
  const calls = [];
  const ok = restrictToOwner('C:\\x\\tlink.json', { platform: 'win32', run: (cmd, args) => calls.push([cmd, args]),
    user: 'riley', env: { SystemRoot: 'C:\\Windows', USERDOMAIN: 'MY-PC' } });
  assert.equal(ok, true);
  assert.equal(calls[0][0], 'C:\\Windows\\System32\\icacls.exe');
  assert.deepEqual(calls[0][1], ['C:\\x\\tlink.json', '/inheritance:r', '/grant:r', 'MY-PC\\riley:F']);
});

test('liveToken still knows an EXPIRED key (it must keep being scrubbed) and is keyed by file', () => {
  const a = path.join(dir(), 'tlink.json');
  const b = path.join(dir(), 'tlink.json');
  fs.writeFileSync(a, JSON.stringify(good({ expiresAt: Date.now() - 1 })));
  fs.writeFileSync(b, JSON.stringify(good({ token: `tlk_${'B'.repeat(43)}` })));
  const t = new Date();
  fs.utimesSync(a, t, t);
  fs.utimesSync(b, t, t);
  assert.equal(liveToken({ file: a }), TOKEN);
  assert.equal(liveToken({ file: b }), `tlk_${'B'.repeat(43)}`);
});

test('negative: the key is scrubbed in base64 even when it starts mid-byte (offsets 1 and 2)', () => {
  const bytes = Buffer.from(TOKEN);
  for (const pad of [Buffer.from('x'), Buffer.from('xy')]) {
    const b64 = Buffer.concat([pad, bytes]).toString('base64');
    const out = scrubToken(`a ${b64} b`, TOKEN);
    assert.ok(out.length < b64.length - 30, `offset ${pad.length}: ${out}`);
  }
});

test('negative: the key is scrubbed in its base64 and hex spellings too', () => {
  const b64 = Buffer.from(TOKEN).toString('base64');
  const hex = Buffer.from(TOKEN).toString('hex');
  const out = scrubToken(`a ${b64} b ${hex} c`, TOKEN);
  assert.ok(!out.includes(b64) && !out.includes(hex), out);
});

test('scrubToken replaces every copy of the live token, and leaves text alone when unpaired', () => {
  const text = `{"data":"line 1 ${TOKEN} and again ${TOKEN}"}`;
  assert.equal(scrubToken(text, TOKEN), '{"data":"line 1 [tlink token] and again [tlink token]"}');
  assert.equal(scrubToken(text, null), text);
});
