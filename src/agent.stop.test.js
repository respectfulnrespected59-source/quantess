import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Phase 6: Ctrl+C stops the job, not quantess. The model call in flight is cancelled, a running command is killed,
// steps not yet run are skipped, and the conversation stays usable for the next message.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'quantess-stop-')));
process.env.QUANTESS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quantess-home-'));
process.env.OPENROUTER_API_KEY ||= 'sk-or-test-not-a-real-key';
const { Agent } = await import('./agent.js');
const { runShell } = await import('./tools/index.js');

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const step = (...calls) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: calls }, finish_reason: 'tool_calls' }] });
const say = (content) => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const abortError = () => Object.assign(new Error('Request was aborted.'), { name: 'AbortError' });

test('a stop during the model call ends the job at once: no retry, no fallback model', async () => {
  let calls = 0;
  const agent = new Agent({ browser: false, sleep: async () => {} });
  agent.client = { chat: { completions: { create: (body, options) => {
    calls += 1;
    return new Promise((resolve, reject) => options?.signal?.addEventListener('abort', () => reject(abortError())));
  } } } };
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 50);
  const r = await agent.run('write a long story', { signal: stop.signal });
  assert.equal(r.stopped, true);
  assert.match(r.response, /stopped/i);
  assert.equal(calls, 1, 'the provider was asked once');
});

test('a stop while a command runs kills it, skips the next step, and the conversation still works', { timeout: 30000 }, async () => {
  const replies = [step(call('a', 'run_shell', { cmd: 'node -e "setTimeout(() => {}, 60000)"' }), call('b', 'write_file', { filepath: 'after.txt', content: 'x' })), say('next turn works')];
  const sent = [];
  const agent = new Agent({ browser: false, sleep: async () => {} });
  agent.client = { chat: { completions: { create: async (body) => { sent.push(body); return replies[Math.min(sent.length - 1, replies.length - 1)]; } } } };
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 1500);
  const started = Date.now();
  const r = await agent.run('run the long thing then write after.txt', { signal: stop.signal });
  assert.ok(Date.now() - started < 15000, `took ${Date.now() - started} ms`);
  assert.equal(r.stopped, true);
  assert.equal(fs.existsSync('after.txt'), false, 'the step after the stop never ran');
  const toolReplies = agent.messages.filter((m) => m.role === 'tool');
  assert.equal(toolReplies.length, 2, 'every tool call still has a reply, so the next request is valid');
  assert.ok(toolReplies.every((m) => /STOPPED/.test(m.content)));
  const next = await agent.run('carry on');
  assert.equal(next.response, 'next turn works');
});

test('negative: a stop signal that never fires changes nothing', async () => {
  const agent = new Agent({ browser: false, sleep: async () => {} });
  agent.client = { chat: { completions: { create: async () => say('done') } } };
  const r = await agent.run('hi', { signal: new AbortController().signal });
  assert.equal(r.response, 'done');
  assert.ok(!r.stopped);
});

test('run_shell stops a running command when told to', { timeout: 30000 }, async () => {
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 1000);
  const started = Date.now();
  const r = await runShell('node -e "setTimeout(() => {}, 60000)"', { signal: stop.signal });
  assert.ok(Date.now() - started < 15000, `took ${Date.now() - started} ms`);
  assert.equal(r.error.code, 'STOPPED');
});

// Code review 10-23 (HIGH): the stop signal stayed set after a stopped turn, so a later /compact failed at once
test('after a stopped turn the stop signal is cleared', async () => {
  const agent = new Agent({ browser: false, sleep: async () => {} });
  agent.client = { chat: { completions: { create: (body, options) => new Promise((resolve, reject) => options?.signal?.addEventListener('abort', () => reject(abortError()))) } } };
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 30);
  await agent.run('go', { signal: stop.signal });
  assert.equal(agent.signal, null);
});

// Code review 10-23 (HIGH): Ctrl+C never reached a delegated specialist
test('a delegated specialist runs under the same stop signal', async () => {
  const seen = [];
  const realRun = Agent.prototype.run;
  Agent.prototype.run = async function (task, options) {
    if (this.depth === 1) {
      seen.push(options?.signal);
      return { response: 'report', iterations: 1, cost: { totalCost: 0 } };
    }
    return realRun.call(this, task, options);
  };
  try {
    const agent = new Agent({ browser: false, sleep: async () => {} });
    const replies = [step(call('d', 'delegate', { agent: 'quanti-code', task: 'check' })), say('done')];
    let n = 0;
    agent.client = { chat: { completions: { create: async () => replies[Math.min(n++, replies.length - 1)] } } };
    const stop = new AbortController();
    await agent.run('get it checked', { signal: stop.signal });
    assert.equal(seen[0], stop.signal);
  } finally {
    Agent.prototype.run = realRun;
  }
});

// Code review 10-23 (MEDIUM): a rate-limit wait (tens of seconds) ignored Ctrl+C
test('a stop during a rate-limit wait ends the job without waiting it out', async () => {
  const agent = new Agent({ browser: false, sleep: () => new Promise(() => {}) });
  agent.client = { chat: { completions: { create: async () => { throw Object.assign(new Error('429 free-models-per-min'), { status: 429 }); } } } };
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 100);
  const r = await agent.run('go', { signal: stop.signal });
  assert.equal(r.stopped, true);
});
