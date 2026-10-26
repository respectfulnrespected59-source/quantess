import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstAnswer } from './race.js';

// T-LINK approval protocol: the terminal and the phone race; the first ACCEPTED answer wins and the other is
// cancelled; the terminal can always answer; with T-LINK on, nobody answering means "no" at the deadline.

function fakeTimers() {
  const timers = [];
  return {
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.cleared = true; },
    fire: () => timers.filter((t) => !t.cleared).forEach((t) => { t.cleared = true; t.fn(); })
  };
}

/** A terminal question that resolves when told to, or settles as "aborted" when its signal fires. */
function terminalQuestion() {
  const q = { aborted: false };
  q.ask = (signal) => new Promise((resolve) => {
    q.answer = resolve;
    signal.addEventListener('abort', () => { q.aborted = true; resolve(undefined); }, { once: true });
  });
  return q;
}

function phoneChannel() {
  const ch = { listeners: new Set() };
  ch.subscribe = (fn) => { ch.listeners.add(fn); return () => ch.listeners.delete(fn); };
  ch.send = (msg) => [...ch.listeners].forEach((fn) => fn(msg));
  return ch;
}

// The terminal question is opened on the next tick; let it start before answering it
const tick = () => new Promise((r) => setImmediate(r));

test('the terminal answers first: its answer wins and the phone is unsubscribed', async () => {
  const term = terminalQuestion();
  const phone = phoneChannel();
  const result = firstAnswer({ terminal: term.ask, subscribe: phone.subscribe, judge: () => ({ ok: true, answer: 'yes' }) });
  await tick();
  term.answer('always');
  assert.deepEqual(await result, { answer: 'always', by: 'terminal' });
  assert.equal(phone.listeners.size, 0);
});

test('the phone answers first: the terminal question is cancelled and the phone answer wins', async () => {
  const term = terminalQuestion();
  const phone = phoneChannel();
  const result = firstAnswer({ terminal: term.ask, subscribe: phone.subscribe, judge: (m) => ({ ok: true, answer: m.answer }) });
  await tick();
  phone.send({ answer: 'no' });
  assert.deepEqual(await result, { answer: 'no', by: 'phone' });
  assert.equal(term.aborted, true);
});

test('negative: a phone answer the policy refuses is ignored; the question stays open for the terminal', async () => {
  const term = terminalQuestion();
  const phone = phoneChannel();
  const result = firstAnswer({ terminal: term.ask, subscribe: phone.subscribe, judge: () => ({ ok: false, why: 'pay is No-only' }) });
  await tick();
  phone.send({ answer: 'yes' });
  await tick();
  assert.equal(term.aborted, false);
  term.answer(false);
  assert.deepEqual(await result, { answer: false, by: 'terminal' });
});

test('negative: a second answer after the first is ignored', async () => {
  const term = terminalQuestion();
  const phone = phoneChannel();
  let judged = 0;
  const result = firstAnswer({ terminal: term.ask, subscribe: phone.subscribe, judge: (m) => { judged += 1; return { ok: true, answer: m.answer }; } });
  await tick();
  phone.send({ answer: 'no' });
  phone.send({ answer: 'yes' });
  assert.deepEqual(await result, { answer: 'no', by: 'phone' });
  assert.equal(judged, 1);
});

test('with a timeout, nobody answering settles as a timeout and cancels the terminal question', async () => {
  const term = terminalQuestion();
  const t = fakeTimers();
  const result = firstAnswer({ terminal: term.ask, timeoutMs: 600_000, setTimer: t.setTimer, clearTimer: t.clearTimer });
  await tick();
  t.fire();
  assert.deepEqual(await result, { answer: null, by: 'timeout' });
  assert.equal(term.aborted, true);
});

test('without T-LINK there is no phone and no timeout: the terminal alone answers', async () => {
  const term = terminalQuestion();
  const result = firstAnswer({ terminal: term.ask });
  await tick();
  term.answer(true);
  assert.deepEqual(await result, { answer: true, by: 'terminal' });
});

// Review 10-24: an answer delivered DURING subscribe() (a buffered replay) must not leak the timer or the subscription
test('negative: an answer delivered while subscribing still unsubscribes and clears the timer', async () => {
  const term = terminalQuestion();
  const t = fakeTimers();
  let unsubscribed = 0;
  const subscribe = (fn) => { fn({ answer: 'no' }); return () => { unsubscribed += 1; }; };
  const result = await firstAnswer({ terminal: term.ask, subscribe, judge: (m) => ({ ok: true, answer: m.answer }), timeoutMs: 600_000,
    setTimer: t.setTimer, clearTimer: t.clearTimer });
  assert.deepEqual(result, { answer: 'no', by: 'phone' });
  assert.equal(unsubscribed, 1);
  t.fire();
  assert.deepEqual(result, { answer: 'no', by: 'phone' }, 'a leftover timer changes nothing');
});

test('negative: a message that makes judge() throw is ignored, never crashes the reader', async () => {
  const term = terminalQuestion();
  const phone = phoneChannel();
  const result = firstAnswer({ terminal: term.ask, subscribe: phone.subscribe, judge: () => { throw new Error('bad frame'); } });
  await tick();
  assert.doesNotThrow(() => phone.send({ answer: 'yes' }));
  term.answer('no');
  assert.deepEqual(await result, { answer: 'no', by: 'terminal' });
});

test('negative: a terminal question that fails rejects the race (it is never taken as an answer)', async () => {
  const result = firstAnswer({ terminal: () => Promise.reject(new Error('stdin closed')) });
  await assert.rejects(result, /stdin closed/);
});
