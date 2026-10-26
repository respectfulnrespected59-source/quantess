import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pairDevice, unpairDevice } from './pair.js';
import { readPairing } from './store.js';
import { startFakeSite } from '../fixtures/tlinkSite.js';

// T-LINK pairing = device flow, reversed (security review H1): the TERMINAL shows a short code, the user enters it on the
// site he is signed in to and approves this PC there. The key is minted only then, saved locked, never printed.

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tlink-pair-')), 'tlink.json');
const opts = (site, over = {}) => ({ origin: site.origin, label: 'MY-PC', file: tmpFile(), restrict: () => true,
  sleep: () => new Promise((r) => setTimeout(r, 5)), minIntervalMs: 1, ...over });

test('the terminal shows the code + where to enter it; approved on the site, the key is saved locked and never shown', async (t) => {
  const site = await startFakeSite({ pairAfterPolls: 2 });
  t.after(() => site.close());
  const printed = [];
  const o = opts(site, { print: (line) => printed.push(line) });
  const result = await pairDevice(o);
  assert.equal(result.ok, true);
  assert.equal(result.deviceId, 'dev_test0001');
  assert.match(printed.join('\n'), /ABCD-EFGH/);
  assert.ok(printed.join('\n').includes(`${site.origin}/tlink`), 'the address comes from OUR origin, never the reply');
  assert.ok(!printed.join('\n').includes(site.state.token), 'the key is never printed');
  assert.equal(readPairing({ file: o.file }).token, site.state.token);
  assert.equal(JSON.parse(site.state.requests[0].body).label, 'MY-PC');
});

test('negative: a "no" on the site saves nothing', async (t) => {
  const site = await startFakeSite({ pairResult: 'denied' });
  t.after(() => site.close());
  const o = opts(site);
  const result = await pairDevice(o);
  assert.equal(result.ok, false);
  assert.match(result.why, /said no/);
  assert.equal(fs.existsSync(o.file), false);
});

test('negative: pairing with anything but the QUAN-TESS site (or this PC) is refused before any request', async () => {
  let calls = 0;
  const result = await pairDevice({ origin: 'https://evil.example', fetchImpl: () => { calls += 1; }, file: tmpFile(), restrict: () => true });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
});

test('negative: a redirect during pairing is never followed', async (t) => {
  let evilHits = 0;
  const evil = http.createServer((req, res) => { evilHits += 1; res.end('{}'); });
  await new Promise((r) => evil.listen(0, '127.0.0.1', r));
  const site = await startFakeSite();
  t.after(async () => { await site.close(); await new Promise((r) => evil.close(r)); });
  site.state.redirectTo = `http://127.0.0.1:${evil.address().port}`;
  const result = await pairDevice(opts(site));
  assert.equal(result.ok, false);
  assert.equal(evilHits, 0);
});

// --- Phase 2 reviews ---
test('negative: a huge pairing reply is read only up to the cap, never into memory whole', async (t) => {
  const site = await startFakeSite();
  t.after(() => site.close());
  let sent = 0;
  site.state.pairBody = (res) => {
    const chunk = 'x'.repeat(65_536);
    const pump = () => {
      while (sent < 50_000_000) {
        sent += chunk.length;
        if (!res.write(chunk)) return res.once('drain', pump);
      }
      res.end();
    };
    res.on('close', () => { sent = Math.max(sent, 0); });
    pump();
  };
  const result = await pairDevice(opts(site));
  assert.equal(result.ok, false);
  assert.ok(sent < 10_000_000, `${sent} bytes were pulled from the site`);
});

test('negative: a poll never runs after the deadline, and slow_down cannot stretch the wait past a minute', async () => {
  let clock = 0;
  const polls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    const body = path.endsWith('/start')
      ? { deviceCode: 'dc_'.padEnd(30, 'x'), userCode: 'ABCD-EFGH', intervalSec: 1, expiresInSec: 10 }
      : (polls.push(clock), { status: 'slow_down' });
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const waits = [];
  const result = await pairDevice({ origin: 'http://localhost:9', fetchImpl, file: tmpFile(), restrict: () => true, minIntervalMs: 1000,
    now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } });
  assert.equal(result.ok, false);
  assert.ok(polls.every((at) => at < 10_000), `polls at ${polls}`);
  assert.ok(waits.every((ms) => ms <= 60_000));
});

test('unpair when the site had already forgotten this PC still counts as revoked', async (t) => {
  const site = await startFakeSite();
  t.after(() => site.close());
  const o = opts(site);
  await pairDevice(o);
  site.state.revoked = true;
  assert.deepEqual(await unpairDevice({ file: o.file }), { removed: true, revoked: true });
});

test('unpair: the site forgets this PC, and the key file is gone', async (t) => {
  const site = await startFakeSite();
  t.after(() => site.close());
  const o = opts(site);
  await pairDevice(o);
  const result = await unpairDevice({ file: o.file });
  assert.deepEqual(result, { removed: true, revoked: true });
  assert.equal(site.state.revoked, true);
  assert.equal(fs.existsSync(o.file), false);
});

test('negative: a poll the site never answers is given up on when the code expires, not 15 s later', async () => {
  let clock = 0;
  const fetchImpl = (url, init) => {
    if (new URL(url).pathname.endsWith('/start')) {
      return Promise.resolve(new Response(JSON.stringify({ deviceCode: 'dc_'.padEnd(30, 'x'), userCode: 'ABCD-EFGH', intervalSec: 1, expiresInSec: 2 }), { status: 200 }));
    }
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }));
  };
  const t0 = Date.now();
  const result = await pairDevice({ origin: 'http://localhost:9', fetchImpl, file: tmpFile(), restrict: () => true, minIntervalMs: 1000,
    now: () => clock + (Date.now() - t0), sleep: async (ms) => { clock += ms; } });
  assert.equal(result.ok, false);
  assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
});
