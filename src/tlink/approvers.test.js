import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPhoneApprovals } from './approvers.js';
import { createEventLog } from './events.js';
import { createGrant } from './policy.js';

// T-LINK Phase 2: each y/n question races the terminal, the phone and (with T-LINK on) a timeout, under the CLI's own
// policy. The terminal's answer is taken as-is; the phone's only within policy; money and push never from the phone.

const H = 3_600_000;
const quiet = (text, { cap }) => ({ text: String(text).slice(0, cap), exact: true });

/** A stand-in for the T-LINK client: connected or not, and a way to deliver a phone answer. */
function fakeClient(connected = true) {
  const subs = new Set();
  return {
    connected: () => connected,
    subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); },
    flush: () => {},
    deliver: (frame) => [...subs].forEach((fn) => fn(frame)),
    subs
  };
}

/** Terminal askers that wait until told to answer, or until the phone's answer closes them. */
function fakeAsk() {
  const pending = [];
  const make = () => (...args) => new Promise((resolve) => {
    const signal = args.at(-1)?.signal;
    const entry = { args, resolve, closed: false };
    signal?.addEventListener('abort', () => { entry.closed = true; resolve(undefined); }, { once: true });
    pending.push(entry);
  });
  return { ask: { pay: make(), publish: make(), change: make(), remember: make(), site: make() }, pending };
}

function setup({ connected = true, ttlMs = 600_000, grantMs = 0 } = {}) {
  const events = createEventLog({ redact: quiet });
  const grant = createGrant();
  if (grantMs) grant.allow(grantMs);
  const client = fakeClient(connected);
  const audits = [];
  const notices = [];
  const ids = ['p1', 'p2', 'p3'];
  const phone = createPhoneApprovals({ client, events, grant, sessionId: () => 's1', ttlMs, randomId: () => ids.shift(),
    onAudit: (a) => audits.push(a), onNotice: (line) => notices.push(line) });
  const { ask, pending } = fakeAsk();
  return { phone, wrapped: phone.wrap(ask), events, client, pending, audits, notices };
}

const tick = () => new Promise((r) => setImmediate(r));
const openEvent = (events) => events.take(50).find((e) => e.type === 'prompt_open');
const answerFor = (e, answer) => ({ promptId: e.promptId, sessionId: e.sessionId, textHash: e.textHash, answer });

test('T-LINK off: the terminal alone asks, exactly as before - nothing goes to the phone', async () => {
  const { wrapped, events, pending } = setup({ connected: false });
  const result = wrapped.change('run_shell', 'run npm test', { complete: true });
  await tick();
  pending[0].resolve('always');
  assert.equal(await result, 'always');
  assert.equal(events.pending(), 0);
});

test('the phone says No: the terminal question closes and the answer is no', async () => {
  const { wrapped, events, client, pending, audits } = setup();
  const result = wrapped.change('run_shell', 'run npm test', { complete: true });
  await tick();
  const open = openEvent(events);
  assert.deepEqual(open.choices, ['no'], 'no grant: the phone gets only No');
  client.deliver(answerFor(open, 'no'));
  assert.equal(await result, 'no');
  assert.equal(pending[0].closed, true);
  assert.deepEqual(audits.map((a) => [a.by, a.answer]), [['phone', 'no']]);
});

test('inside a grant the phone can say Yes to a change, a site and a memory - never "always"', async () => {
  const { wrapped, events, client } = setup({ grantMs: H });
  const change = wrapped.change('run_shell', 'run npm test', { complete: true });
  await tick();
  client.deliver(answerFor(openEvent(events), 'yes'));
  assert.equal(await change, 'yes');
  const site = wrapped.site('example.com', 'https://example.com');
  await tick();
  client.deliver(answerFor(openEvent(events), 'yes'));
  assert.equal(await site, 'yes');
  const memory = wrapped.remember({ name: 'note-one', type: 'lesson', description: 'd', content: 'c' });
  await tick();
  client.deliver(answerFor(openEvent(events), 'yes'));
  assert.equal(await memory, true);
});

test('negative: a phone Yes without a grant is ignored - the question waits for the terminal', async () => {
  const { wrapped, events, client, pending } = setup();
  const result = wrapped.change('run_shell', 'run npm test', { complete: true });
  await tick();
  client.deliver(answerFor(openEvent(events), 'yes'));
  await tick();
  assert.equal(pending[0].closed, false);
  pending[0].resolve('no');
  assert.equal(await result, 'no');
});

test('negative: money and push - a phone Yes is ignored even inside a grant; a phone No counts', async () => {
  const { wrapped, events, client, pending } = setup({ grantMs: H });
  const pay = wrapped.pay('Upscale', { count: 1 });
  await tick();
  const open = openEvent(events);
  assert.deepEqual(open.choices, ['no']);
  client.deliver(answerFor(open, 'yes'));
  await tick();
  assert.equal(pending[0].closed, false, 'still waiting for the terminal');
  client.deliver(answerFor(open, 'no'));
  assert.equal(await pay, false);
  const publish = wrapped.publish('git push');
  await tick();
  client.deliver(answerFor(openEvent(events), 'yes'));
  await tick();
  pending[1].resolve(true);
  assert.equal(await publish, true, 'only the terminal said yes');
});

test('negative: an answer for another question, or a replay of an old one, is ignored', async () => {
  const { wrapped, events, client, pending } = setup({ grantMs: H });
  const first = wrapped.change('run_shell', 'run a', { complete: true });
  await tick();
  const open1 = openEvent(events);
  client.deliver(answerFor(open1, 'no'));
  assert.equal(await first, 'no');
  const second = wrapped.change('run_shell', 'run b', { complete: true });
  await tick();
  client.deliver(answerFor(open1, 'yes'));
  client.deliver({ ...answerFor(openEvent(events) ?? open1, 'yes'), textHash: 'f'.repeat(64) });
  await tick();
  assert.equal(pending[1].closed, false);
  pending[1].resolve('no');
  assert.equal(await second, 'no');
});

test('nobody answers while T-LINK is on: the question becomes "no" at its deadline', async () => {
  const { wrapped, events, audits } = setup({ ttlMs: 30 });
  assert.equal(await wrapped.publish('git push'), false);
  const closed = events.take(50).find((e) => e.type === 'prompt_closed');
  assert.deepEqual([closed.by, closed.answer], ['timeout', 'no']);
  assert.equal(audits[0].by, 'timeout');
});

test('while questions are open, openEvents() gives each with its time left; none after', async () => {
  const { phone, wrapped, client, events } = setup({ ttlMs: 60_000 });
  const a = wrapped.change('run_shell', 'run x', { complete: true });
  const b = wrapped.site('example.com', 'https://example.com');
  await tick();
  const snaps = phone.openEvents();
  assert.equal(snaps.length, 2, 'two open questions are both kept');
  assert.ok(snaps.every((s) => s.type === 'prompt_open' && s.ttlMs > 0 && s.ttlMs <= 60_000));
  const opens = events.take(50).filter((e) => e.type === 'prompt_open');
  client.deliver(answerFor(opens[0], 'no'));
  await a;
  assert.equal(phone.openEvents().length, 1);
  client.deliver(answerFor(opens[1], 'no'));
  await b;
  assert.deepEqual(phone.openEvents(), []);
});

// --- Phase 2 reviews ---
test('negative: if setting up the phone side fails, the question still goes to the terminal', async () => {
  const { pending, client } = setup();
  const broken = createPhoneApprovals({ client, grant: createGrant(), sessionId: () => 's1',
    events: { promptOpen: () => { throw new Error('boom'); }, promptClosed: () => {} } });
  const { ask } = fakeAsk();
  const result = broken.wrap(ask).publish('git push');
  await tick();
  assert.equal(pending.length, 0);
  // the wrapped terminal asker is waiting: answer it through its own pending list
  const { ask: ask2, pending: p2 } = fakeAsk();
  const result2 = broken.wrap(ask2).change('run_shell', 'run x', { complete: true });
  await tick();
  p2[0].resolve('yes');
  assert.equal(await result2, 'yes');
  result.catch(() => {});
});

test('negative: a terminal question that fails still closes the question on the phone', async () => {
  const events = createEventLog({ redact: quiet });
  const phone = createPhoneApprovals({ client: fakeClient(), events, grant: createGrant(), sessionId: () => 's1' });
  const failing = { change: () => Promise.reject(new Error('stdin closed')) };
  await assert.rejects(phone.wrap(failing).change('run_shell', 'run x', { complete: true }), /stdin closed/);
  const closed = events.take(50).find((e) => e.type === 'prompt_closed');
  assert.ok(closed, 'the phone is told the question is gone');
});

// 10-24 live: the user picked Always on the first render, so the next ones never asked - and the phone just went quiet
test('Always at the keyboard: the phone and the terminal are told steps like it stop asking', async () => {
  const { wrapped, events, pending, notices } = setup({ grantMs: H });
  const result = wrapped.change('run_shell', 'run npm test', { complete: true });
  await tick();
  pending[0].resolve('always');
  assert.equal(await result, 'always');
  const lines = events.take(50).filter((e) => e.type === 'step').map((e) => e.line);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /without asking/);
  assert.deepEqual(notices, lines);
});

test('negative: Yes at the keyboard, or Always for a site, adds no such line', async () => {
  const { wrapped, events, pending, notices } = setup({ grantMs: H });
  const change = wrapped.change('run_shell', 'run npm test', { complete: true });
  await tick();
  pending[0].resolve('yes');
  assert.equal(await change, 'yes');
  const site = wrapped.site('example.com', 'https://example.com/');
  await tick();
  pending[1].resolve('always');
  assert.equal(await site, 'always');
  assert.equal(events.take(50).filter((e) => e.type === 'step').length, 0);
  assert.deepEqual(notices, []);
});
