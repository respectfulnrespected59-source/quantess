import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createTlinkClient } from './client.js';
import { createEventLog } from './events.js';
import { startFakeSite } from '../fixtures/tlinkSite.js';

// T-LINK Phase 2: the CLI's side of the wire, against a fake site on this PC. The client only connects OUT, never
// follows a redirect with the key, stops on 401 ("re-pair"), resyncs after a site restart, keeps every line through an
// outage, and never throws into the job.

const fast = { flushMs: 10, backoffMs: [10, 40], idleMs: 60_000, settleMs: 50 };   // no idle reconnect can rescue a test
const until = async (cond, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const quiet = (text, { cap }) => ({ text: String(text).slice(0, cap), exact: true });

async function setup(over = {}) {
  const site = await startFakeSite();
  const events = createEventLog({ redact: quiet });
  const statuses = [];
  const client = createTlinkClient({
    pairing: { origin: site.origin, token: site.state.token, deviceId: 'dev_test0001' },
    sessionId: 's1', events, onStatus: (s, why) => statuses.push([s, why]), ...fast, ...over
  });
  return { site, events, client, statuses };
}

test('events reach the site in order, with the key, and the client reports itself connected', async (t) => {
  const { site, events, client } = await setup();
  t.after(async () => { client.stop(); await site.close(); });
  client.start();
  events.step('read_file', { filepath: 'a.txt' });
  events.step('read_file', { filepath: 'b.txt' });
  await until(() => site.events().length === 2);
  assert.deepEqual(site.events().map((e) => e.line), ['read a.txt', 'read b.txt']);
  assert.equal(site.state.batches[0].sessionId, 's1');
  assert.ok(site.state.requests.every((r) => r.auth === `Bearer ${site.state.token}`));
  await until(() => client.connected());
});

test('an answer on the stream reaches subscribers; junk and "always" never do', async (t) => {
  const { site, client } = await setup();
  t.after(async () => { client.stop(); await site.close(); });
  const got = [];
  client.subscribe((frame) => got.push(frame));
  client.start();
  await until(() => client.connected() && site.state.streams.size === 1);
  site.send('answer', 'not json');
  site.send('answer', { promptId: 'p1', sessionId: 's1', textHash: 'h1', answer: 'always' });
  site.send('answer', { promptId: 'p1', sessionId: 's1', textHash: 'h1', answer: 'no', evil: 'x' });
  await until(() => got.length === 1);
  assert.deepEqual(got, [{ promptId: 'p1', sessionId: 's1', textHash: 'h1', answer: 'no' }]);
});

test('negative: a 401 stops T-LINK with a re-pair message, and nothing throws into the job', async (t) => {
  const { site, events, client, statuses } = await setup();
  t.after(async () => { client.stop(); await site.close(); });
  site.state.refuseEvents = 1;
  client.start();
  events.step('read_file', { filepath: 'a.txt' });
  await until(() => client.status().status === 'stopped');
  assert.match(client.status().reason, /tlink-pair/);
  assert.ok(statuses.some(([s]) => s === 'stopped'));
  assert.equal(client.connected(), false);
});

test('after a site restart (409) the client re-posts its recent history + the open question, then the new lines', async (t) => {
  const open = { type: 'prompt_open', promptId: 'p9', ttlMs: 12_345 };
  const { site, events, client } = await setup({ snapshotPrompts: () => [open] });
  t.after(async () => { client.stop(); await site.close(); });
  client.start();
  events.step('read_file', { filepath: 'first.txt' });
  await until(() => site.events().length === 1);
  site.state.resyncOnce = true;
  events.step('read_file', { filepath: 'second.txt' });
  await until(() => site.state.batches.some((b) => b.resync) && site.events().some((e) => e.line === 'read second.txt'));
  const resync = site.state.batches.find((b) => b.resync);
  assert.deepEqual(resync.events.map((e) => e.line ?? e.type), ['read first.txt', 'prompt_open']);
  assert.equal(resync.events.at(-1).ttlMs, 12_345);
});

test('negative: an outage loses nothing - lines queue and arrive in order when the site answers again', async (t) => {
  let failures = 3;
  const flaky = (url, opts) => (String(url).endsWith('/cli/events') && failures-- > 0 ? Promise.reject(new Error('ECONNREFUSED')) : fetch(url, opts));
  const { site, events, client } = await setup({ fetchImpl: flaky });
  t.after(async () => { client.stop(); await site.close(); });
  client.start();
  for (const f of ['a', 'b', 'c']) events.step('read_file', { filepath: f });
  await until(() => site.events().length === 3);
  assert.deepEqual(site.events().map((e) => e.line), ['read a', 'read b', 'read c']);
});

test('negative: a redirect is never followed - the key never reaches another host', async (t) => {
  let evilHits = 0;
  const evil = http.createServer((req, res) => { evilHits += 1; res.end('{}'); });
  await new Promise((r) => evil.listen(0, '127.0.0.1', r));
  const { site, events, client } = await setup();
  t.after(async () => { client.stop(); await site.close(); await new Promise((r) => evil.close(r)); });
  site.state.redirectTo = `http://127.0.0.1:${evil.address().port}`;
  client.start();
  events.step('read_file', { filepath: 'a.txt' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(evilHits, 0);
});

test('an "off" frame from the site turns T-LINK off', async (t) => {
  const { site, client } = await setup();
  t.after(async () => { client.stop(); await site.close(); });
  client.start();
  await until(() => site.state.streams.size === 1);
  site.send('off', { reason: 'revoked' });
  await until(() => client.status().status === 'stopped');
  assert.match(client.status().reason, /turned off/);
});

// 10-24 live: two quantess windows on one PC kicked each other off forever - the site now says "replaced"
test('a "replaced" frame: another quantess window took the phone link - this one says so and stops for good', async (t) => {
  const { site, client } = await setup();
  t.after(async () => { client.stop(); await site.close(); });
  client.start();
  await until(() => site.state.streams.size === 1);
  site.send('off', { reason: 'replaced' });
  await until(() => client.status().status === 'stopped');
  assert.match(client.status().reason, /another quantess window/);
  const connects = site.state.streamConnects;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(site.state.streamConnects, connects, 'it never reconnects to kick the other window off');
});

test('negative: a reason the CLI does not know is never printed - only its own plain words', async (t) => {
  const { site, client } = await setup();
  t.after(async () => { client.stop(); await site.close(); });
  client.start();
  await until(() => site.state.streams.size === 1);
  site.send('off', { reason: '\u001b[2J wipe the screen' });
  await until(() => client.status().status === 'stopped');
  assert.equal(client.status().reason, 'turned off from the site');
});

test('negative: an oversized frame drops that stream and the client reconnects - it never buffers it or crashes', async (t) => {
  const { site, client } = await setup();
  t.after(async () => { client.stop(); await site.close(); });
  client.start();
  await until(() => site.state.streamConnects === 1 && site.state.streams.size === 1);
  site.raw(`data: ${'x'.repeat(70_000)}`);
  await until(() => site.state.streamConnects >= 2);
});

test('the session id can be read live (a /new session is picked up without restarting T-LINK)', async (t) => {
  let id = 's1';
  const { site, events, client } = await setup({ sessionId: () => id });
  t.after(async () => { client.stop(); await site.close(); });
  client.start();
  events.step('read_file', { filepath: 'a' });
  await until(() => site.state.batches.length === 1);
  id = 's2';
  events.step('read_file', { filepath: 'b' });
  await until(() => site.state.batches.length === 2);
  assert.deepEqual(site.state.batches.map((b) => b.sessionId), ['s1', 's2']);
});

// --- Phase 2 reviews: recovery, back-off, poison batches, size caps, draining on end ---

test('after sends fail and recover, the client is connected again (phone answers come back)', async (t) => {
  let failures = 2;
  const flaky = (url, opts) => (String(url).endsWith('/cli/events') && failures-- > 0 ? Promise.reject(new Error('timeout')) : fetch(url, opts));
  const { site, events, client } = await setup({ fetchImpl: flaky });
  t.after(async () => { client.stop(); await site.close(); });
  client.start();
  await until(() => client.connected());
  events.step('read_file', { filepath: 'a' });
  await until(() => client.status().status === 'offline');
  await until(() => site.events().length === 1);
  await until(() => client.connected(), 1500);
});

test('negative: a site that keeps asking to resync is backed off from, then T-LINK turns off - never a hot loop', async (t) => {
  const { site, events, client } = await setup();
  t.after(async () => { client.stop(); await site.close(); });
  site.state.alwaysResync = true;
  client.start();
  events.step('read_file', { filepath: 'a' });
  await until(() => client.status().status === 'stopped', 4000);
  assert.match(client.status().reason, /resync/);
  assert.ok(site.state.requests.filter((r) => r.path.endsWith('/cli/events')).length < 30, 'bounded requests');
});

test('negative: a batch the site rejects as malformed (400) is dropped - later lines still go through', async (t) => {
  const { site, events, client } = await setup();
  t.after(async () => { client.stop(); await site.close(); });
  site.state.rejectWhen = (batch) => (batch.events.some((e) => e.line === 'read poison') ? 400 : 0);
  client.start();
  events.step('read_file', { filepath: 'poison' });
  await until(() => site.state.requests.some((r) => r.path.endsWith('/cli/events')));
  events.step('read_file', { filepath: 'after' });
  await until(() => site.events().some((e) => e.line === 'read after'));
});

test('negative: batches and the resync snapshot stay under the site\'s 64 KB limit, whatever the lines', async (t) => {
  const big = (text, { cap }) => ({ text: String(text).slice(0, cap), exact: true });
  const site = await startFakeSite();
  const events = createEventLog({ redact: big });
  const client = createTlinkClient({ pairing: { origin: site.origin, token: site.state.token, deviceId: 'dev_test0001' },
    sessionId: 's1', events, ...fast });
  t.after(async () => { client.stop(); await site.close(); });
  client.start();
  for (let i = 0; i < 30; i += 1) events.answer(`${i}`.padEnd(8000, 'x'));
  await until(() => site.events().length === 30);
  site.state.resyncOnce = true;
  events.answer('last');
  await until(() => site.state.batches.some((b) => b.resync) && site.events().some((e) => e.text === 'last'));
  for (const r of site.state.requests.filter((q) => q.path.endsWith('/cli/events'))) assert.ok(r.body.length < 64_000, `${r.body.length}`);
});

test('negative: a flooding stream is cut off and reconnected, never read without limit', async (t) => {
  const { site, client } = await setup();
  t.after(async () => { client.stop(); await site.close(); });
  client.start();
  await until(() => site.state.streams.size === 1);
  for (let i = 0; i < 40; i += 1) site.raw(`${': ping\n'.repeat(5000)}`);
  await until(() => site.state.streamConnects >= 2);
});

test('negative: a stream that drops at once is reconnected with growing waits, not a storm', async (t) => {
  const { site, client } = await setup({ backoffMs: [10, 200] });
  t.after(async () => { client.stop(); await site.close(); });
  site.state.closeStreamsAtOnce = true;
  client.start();
  await new Promise((r) => setTimeout(r, 600));
  assert.ok(site.state.streamConnects < 20, `${site.state.streamConnects} connects in 600 ms`);
});

test('end() delivers what is queued, then says goodbye; after /tlink off it says nothing', async (t) => {
  const { site, events, client } = await setup();
  t.after(() => site.close());
  client.start();
  await until(() => client.connected());
  events.answer('final answer');
  await client.end();
  const paths = site.state.requests.map((r) => r.path);
  const lastEvents = paths.lastIndexOf('/api/tlink/cli/events');
  assert.ok(site.events().some((e) => e.text === 'final answer'), 'the last line got there');
  assert.ok(paths.indexOf('/api/tlink/cli/end') > lastEvents, 'goodbye after the last batch');

  const second = await setup();
  t.after(() => second.site.close());
  second.client.start();
  second.client.stop('turned off at the terminal');
  await second.client.end();
  assert.ok(!second.site.state.requests.some((r) => r.path.endsWith('/cli/end')));
});

test('negative: after stop() neither loop sends anything more', async (t) => {
  const { site, events, client } = await setup();
  t.after(() => site.close());
  client.start();
  await until(() => client.connected());
  client.stop('test');
  const before = site.state.requests.length;
  events.step('read_file', { filepath: 'late' });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(site.state.requests.length, before);
});

test('stop() closes the stream and ends the loops', async (t) => {
  const { site, client } = await setup();
  t.after(() => site.close());
  client.start();
  await until(() => site.state.streams.size === 1);
  client.stop('test');
  await until(() => site.state.streams.size === 0);
  assert.equal(client.status().status, 'stopped');
});

// --- Phase 2 fix review (10-24) ---

test('negative: the 64 KB limit is counted in BYTES - text that is 3 bytes a character still fits', async (t) => {
  const site = await startFakeSite();
  const events = createEventLog({ redact: quiet });
  const client = createTlinkClient({ pairing: { origin: site.origin, token: site.state.token, deviceId: 'dev_test0001' },
    sessionId: 's1', events, ...fast });
  t.after(async () => { client.stop(); await site.close(); });
  client.start();
  for (let i = 0; i < 30; i += 1) events.answer(`${i}`.padEnd(8000, '日'));
  await until(() => site.events().length === 30, 5000);
  site.state.resyncOnce = true;
  events.answer('last');
  await until(() => site.state.batches.some((b) => b.resync) && site.events().some((e) => e.text === 'last'), 5000);
  for (const r of site.state.requests.filter((q) => q.path.endsWith('/cli/events'))) {
    assert.ok(Buffer.byteLength(r.body) < 64_000, `${Buffer.byteLength(r.body)} bytes`);
  }
});

test('a site that is reachable again (it answers, even with a 400) brings T-LINK back on', async (t) => {
  let failures = 1;
  const flaky = (url, opts) => (String(url).endsWith('/cli/events') && failures-- > 0 ? Promise.reject(new Error('timeout')) : fetch(url, opts));
  const { site, events, client } = await setup({ fetchImpl: flaky });
  t.after(async () => { client.stop(); await site.close(); });
  site.state.rejectWhen = () => 400;
  client.start();
  await until(() => client.connected());
  events.step('read_file', { filepath: 'a' });
  await until(() => client.status().status === 'offline');
  await until(() => client.connected(), 1500);
});

test('negative: one bad line is found and dropped on its own - the lines around it arrive, in order, with a marker', async (t) => {
  const { site, events, client } = await setup();
  t.after(async () => { client.stop(); await site.close(); });
  site.state.rejectWhen = (batch) => (batch.events.some((e) => e.line === 'read poison') ? 400 : 0);
  for (const f of ['a', 'b', 'poison', 'd', 'e']) events.step('read_file', { filepath: f });
  client.start();
  await until(() => site.events().some((e) => e.line === 'read e'));
  const got = site.events();
  assert.deepEqual(got.filter((e) => e.line).map((e) => e.line), ['read a', 'read b', 'read d', 'read e']);
  assert.ok(got.some((e) => e.type === 'dropped' && e.count === 1), 'the phone is told a line is missing');
});

test('negative: a 404 (a route missing mid-deploy) is retried, never treated as a bad batch', async (t) => {
  let missing = 2;
  const deploying = (url, opts) => (String(url).endsWith('/cli/events') && missing-- > 0
    ? Promise.resolve(new Response('{}', { status: 404 })) : fetch(url, opts));
  const { site, events, client } = await setup({ fetchImpl: deploying });
  t.after(async () => { client.stop(); await site.close(); });
  client.start();
  events.step('read_file', { filepath: 'kept' });
  await until(() => site.events().some((e) => e.line === 'read kept'));
});

test('negative: once a flood trips the guard, the rest of that chunk is never handed on', async (t) => {
  const { site, client } = await setup();
  t.after(async () => { client.stop(); await site.close(); });
  let got = 0;
  client.subscribe(() => { got += 1; });
  client.start();
  await until(() => site.state.streams.size === 1);
  const frame = `event: answer\ndata: ${JSON.stringify({ promptId: 'p1', sessionId: 's1', textHash: 'h1', answer: 'no' })}\n\n`;
  site.raw(frame.repeat(1000));
  await until(() => site.state.streamConnects >= 2);
  assert.ok(got <= 201, `${got} frames got through`);
});

test('negative: flush() during an outage does not cut the back-off short', async (t) => {
  let attempts = 0;
  const down = (url, opts) => {
    if (String(url).endsWith('/cli/events')) {
      attempts += 1;
      return Promise.reject(new Error('ECONNREFUSED'));
    }
    return fetch(url, opts);
  };
  const { site, events, client } = await setup({ fetchImpl: down, backoffMs: [150, 600] });
  t.after(async () => { client.stop(); await site.close(); });
  client.start();
  events.step('read_file', { filepath: 'a' });
  for (let i = 0; i < 30; i += 1) {
    client.flush();
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(attempts < 8, `${attempts} attempts in 300 ms`);
});

test('negative: stop() cancels a request still waiting on the site', async (t) => {
  let hung = null;
  const hang = (url, opts) => {
    if (!String(url).endsWith('/cli/events')) return fetch(url, opts);
    hung = opts.signal;
    return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  };
  const { site, events, client } = await setup({ fetchImpl: hang });
  t.after(async () => { client.stop(); await site.close(); });
  client.start();
  events.step('read_file', { filepath: 'a' });
  await until(() => hung !== null);
  client.stop('test');
  assert.equal(hung.aborted, true);
});

test('negative: a stream that is accepted and then hung up at once never counts as "on"', async (t) => {
  const { site, client, statuses } = await setup({ backoffMs: [10, 40] });
  t.after(async () => { client.stop(); await site.close(); });
  site.state.closeStreamsAtOnce = true;
  client.start();
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(site.state.streamConnects >= 2, 'it did reconnect');
  assert.ok(!statuses.some(([s]) => s === 'on'), JSON.stringify(statuses));
});
