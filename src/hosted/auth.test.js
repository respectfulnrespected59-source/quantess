import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { authFile, clearAuth, hostedSite, isAuthFile, leaksKey, liveAuthToken, maskKey, readAuth, writeAuth } from './auth.js';

// The terminal key (`quantess login`) lives in ~/.quantess/terminal-key.json, shaped and guarded like T-LINK's key: only the
// QUAN-TESS site, only this user, never shown whole.

const KEY = `qtk_${'a'.repeat(43)}`;
const good = { site: 'https://quantus-ai.onrender.com', keyId: 'key_testFixture1', label: 'MY-PC', token: KEY };
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qauth-')), 'auth.json');
const allow = () => true;

test('the key file is ~/.quantess/terminal-key.json, or under QUANTESS_HOME', () => {
  assert.equal(authFile({ QUANTESS_HOME: '/x/home' }), path.join('/x/home', 'terminal-key.json'));
});

test('writes, reads back and clears a sign-in', () => {
  const file = tmp();
  writeAuth(good, { file, restrict: allow });
  assert.deepEqual(readAuth({ file }), good);
  clearAuth({ file });
  assert.equal(readAuth({ file }), null);
});

test('the key goes only to the QUAN-TESS site (or this PC): a rewritten file pointing elsewhere reads as signed out', () => {
  assert.equal(hostedSite('https://quantus-ai.onrender.com'), 'https://quantus-ai.onrender.com');
  // this PC only when the user asked for it (a site under test); never by default
  assert.equal(hostedSite('http://localhost:5799', { allowLocal: true }), 'http://localhost:5799');
  assert.equal(hostedSite('http://127.0.0.1:5799', { allowLocal: false }), null);
  const file0 = tmp();
  fs.writeFileSync(file0, JSON.stringify({ ...good, site: 'http://127.0.0.1:9999' }));
  assert.equal(readAuth({ file: file0 }), null, 'a planted local site is refused without QUANTESS_LOCAL_SITE=1');
  for (const bad of ['https://evil.example', 'http://quantus-ai.onrender.com', 'https://quantus-ai.onrender.com/x', 'https://localhost@evil.example']) {
    assert.equal(hostedSite(bad), null, bad);
  }
  const file = tmp();
  fs.writeFileSync(file, JSON.stringify({ ...good, site: 'https://evil.example' }));
  assert.equal(readAuth({ file }), null);
  assert.throws(() => writeAuth({ ...good, site: 'https://evil.example' }, { file: tmp(), restrict: allow }), /site/);
});

test('a misshapen key, key id or file reads as signed out, and is never written', () => {
  const file = tmp();
  for (const bad of [{ ...good, token: 'qtk_short' }, { ...good, token: `tlk_${'a'.repeat(43)}` }, { ...good, keyId: 'nope' }]) {
    fs.writeFileSync(file, JSON.stringify(bad));
    assert.equal(readAuth({ file }), null);
    assert.throws(() => writeAuth(bad, { file: tmp(), restrict: allow }));
  }
  fs.writeFileSync(file, '{not json');
  assert.equal(readAuth({ file }), null);
});

test('a file that cannot be locked to this user is not saved at all', () => {
  const file = tmp();
  assert.throws(() => writeAuth(good, { file, restrict: () => false }), /lock/);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), []);
});

test('the key is only ever shown masked', () => {
  assert.equal(maskKey(KEY), 'qtk_…aaaa');
  assert.equal(maskKey(undefined), '(none)');
});

test('liveAuthToken hands the scrubber the key on file, re-reading only when the file changes', () => {
  const file = tmp();
  assert.equal(liveAuthToken({ file }), null);
  writeAuth(good, { file, restrict: allow });
  assert.equal(liveAuthToken({ file }), KEY);
  const other = `qtk_${'b'.repeat(43)}`;
  writeAuth({ ...good, token: other }, { file, restrict: allow });
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  assert.equal(liveAuthToken({ file }), other);
});

test('isAuthFile knows the key file under another name (a hard link)', (t) => {
  const file = tmp();
  writeAuth(good, { file, restrict: allow });
  const link = path.join(path.dirname(file), 'innocent.txt');
  try {
    fs.linkSync(file, link);
  } catch {
    t.skip('no hard links here');
    return;
  }
  assert.equal(isAuthFile(link, { file }), true);
  const unrelated = path.join(path.dirname(file), 'other.txt');
  fs.writeFileSync(unrelated, 'x');
  assert.equal(isAuthFile(unrelated, { file }), false);
});

// Security review of 4d1cc19: a key printed in a form the scrub cannot see is still caught, and the result withheld
test('leaksKey finds a key fragment however it is printed; ordinary text never trips it', () => {
  const key = `qtk_${'Ab3Xy9Qm'.repeat(5)}Zk7`;
  const b64 = (buf) => buf.toString('base64');
  const forms = {
    spaced: key.split('').join(' '),
    dashed: key.match(/.{1,4}/g).join('-'),
    reversed: [...key].reverse().join(''),
    wrapped: b64(Buffer.from(`secret=${key}`)).match(/.{1,10}/g).join('\n'),
    utf16: b64(Buffer.from(`x${key}y`, 'utf16le')),
    hexdump: Buffer.from(key).toString('hex').match(/.{2}/g).join(' ').toUpperCase(),
    fragment: `part two: ${key.slice(20, 33)}`,
  };
  for (const [name, text] of Object.entries(forms)) assert.equal(leaksKey(text, key), true, name);
  assert.equal(leaksKey('npm install && npm test -- --watch=false # build 1234567890', key), false);
  assert.equal(leaksKey(`the key ends in ${key.slice(-4)}`, key), false, 'the masked last four are not a leak');
  assert.equal(leaksKey('anything', null, undefined), false);
});

// Verification review of 37321b2: the check runs on JSON text (a newline is the two characters \n), and the UTF-16 hex
// windows were too narrow (false positives)
test('a key wrapped at any width, one character a line, tabbed or CRLF is caught through JSON, as the agent sees it', async () => {
  const { randomBytes } = await import('node:crypto');
  const key = `qtk_${randomBytes(32).toString('base64url')}`;
  const wrap = (s, n, sep = '\n') => s.match(new RegExp(`.{1,${n}}`, 'g')).join(sep);
  const b64 = Buffer.from(`k=${key}`).toString('base64');
  const forms = {
    wrap8: wrap(key, 8), wrap10: wrap(key, 10), wrap11: wrap(key, 11), oneEach: wrap(key, 1),
    crlf: wrap(key, 9, '\r\n'), tabs: wrap(key, 7, '\t'), base64wrap10: wrap(b64, 10),
    // xxd's own layout (16 bytes a line). A dump made deliberately in 4-byte lines interleaves the offsets with the key
    // and is NOT caught - the documented limit; the site bounds what a copied key can spend
    xxd: Buffer.from(key).toString('hex').match(/.{1,32}/g).map((h, i) => `${(i * 16).toString(16).padStart(8, '0')}: ${h.match(/.{1,4}/g).join(' ')}`).join('\n'),
  };
  for (const [name, text] of Object.entries(forms)) {
    assert.equal(leaksKey(JSON.stringify({ status: 'success', data: text }), key), true, name);
  }
});

test('no false alarms: hex dumps and base64 of ordinary UTF-16 / UTF-8 text never trip a random key', async () => {
  const { randomBytes } = await import('node:crypto');
  const prose = 'The quick brown fox jumps over the lazy dog while quantess builds the QUAN-TESS terminal. '.repeat(400);
  const dumps = [
    Buffer.from(prose, 'utf16le').toString('hex'),
    Buffer.from(prose, 'utf8').toString('hex'),
    Buffer.from(prose, 'utf16le').toString('base64'),
    `the prefix alone: qtk_ and tlk_ ${prose.slice(0, 500)}`,
  ];
  for (let i = 0; i < 60; i += 1) {
    const key = `qtk_${randomBytes(32).toString('base64url')}`;
    for (const dump of dumps) assert.equal(leaksKey(dump, key), false, `key ${i}`);
  }
});

test('a hex dump of the key as UTF-16 text is caught too (the 00s taken out), without alarms on ordinary UTF-16 dumps', async () => {
  const { randomBytes } = await import('node:crypto');
  const key = `qtk_${randomBytes(32).toString('base64url')}`;
  const utf16hex = Buffer.from(`token=${key}`, 'utf16le').toString('hex');
  assert.equal(leaksKey(utf16hex, key), true, 'plain UTF-16 hex');
  assert.equal(leaksKey(utf16hex.match(/.{1,32}/g).join('\n'), key), true, 'Format-Hex style lines');
  const prose = Buffer.from('Ordinary words in a UTF-16 file, nothing secret here at all. '.repeat(200), 'utf16le').toString('hex');
  for (let i = 0; i < 40; i += 1) assert.equal(leaksKey(prose, `qtk_${randomBytes(32).toString('base64url')}`), false);
});
