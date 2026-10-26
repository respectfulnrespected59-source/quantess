import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Sessions are written to <cwd>/sessions, and Q23 reads that folder: keep test runs out of it.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'q23-retry-')));
// The OpenAI client refuses to build without a key; every model call here is scripted.
process.env.OPENROUTER_API_KEY ||= 'sk-or-test-not-a-real-key';
const { Agent } = await import('./agent.js');
const { config } = await import('./config/index.js');
const { RATE_LIMIT_WAITS_MS } = await import('./rateLimit.js');

const CHAIN = [config.agent.defaultModel, ...config.agent.fallbackModels];
const rateLimited = (message) => Object.assign(new Error(message), { status: 429 });
const busyModel = () => rateLimited('429 Rate limit exceeded: x. High demand for cohere/north-mini-code:free on OpenRouter - limited to 15 requests per minute.');
const freeMinute = () => rateLimited('429 Rate limit exceeded: free-models-per-min. ');
const freeDay = () => rateLimited('429 Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day');
const toolStep = { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'no_such_tool', arguments: '{}' } }] };

/** An agent whose model calls play `script` in order: an Error is thrown, a string is the reply, an object is the message. */
function scriptedAgent(script) {
  const calls = [];
  const waits = [];
  const agent = new Agent({ browser: false, sleep: async (ms) => { waits.push(ms); } });
  agent.client = {
    chat: {
      completions: {
        create: async ({ model }) => {
          const next = script[Math.min(calls.length, script.length - 1)];
          calls.push(model);
          if (next instanceof Error) throw next;
          const message = typeof next === 'string' ? { role: 'assistant', content: next } : next;
          return { choices: [{ message }] };
        }
      }
    }
  };
  return { agent, calls, waits };
}

test('a spent free allowance waits and retries the SAME model, keeping the fallbacks', async () => {
  const { agent, calls, waits } = scriptedAgent([freeMinute(), 'done']);
  const result = await agent.run('go');
  assert.equal(result.response, 'done');
  assert.deepEqual(calls, [CHAIN[0], CHAIN[0]]);
  assert.equal(waits.length, 1);
});

test('one busy model still hands off to the next model at once', async () => {
  const { agent, calls, waits } = scriptedAgent([busyModel(), 'done']);
  assert.equal((await agent.run('go')).response, 'done');
  assert.deepEqual(calls, [CHAIN[0], CHAIN[1]]);
  assert.deepEqual(waits, []);
});

test('with the chain used up, a busy model waits instead of quitting', async () => {
  const { agent, calls, waits } = scriptedAgent([...CHAIN.map(busyModel), 'done']);
  assert.equal((await agent.run('go')).response, 'done');
  assert.deepEqual(calls, [...CHAIN, CHAIN.at(-1)]);
  assert.equal(waits.length, 1);
});

test('three waits in a row with no answer and Q23 stops, rather than hanging', async () => {
  const { agent, calls, waits } = scriptedAgent([freeMinute()]);
  await assert.rejects(agent.run('go'), /free-models-per-min/);
  assert.equal(waits.length, 3);
  assert.equal(calls.length, 4);
});

test('the wait count starts over after every answer, so a long job is not cut short', async () => {
  const { agent, waits } = scriptedAgent([freeMinute(), freeMinute(), freeMinute(), toolStep, freeMinute(), 'done']);
  assert.equal((await agent.run('go')).response, 'done');
  // The backoff schedule restarts from its first step after the answer
  assert.deepEqual(waits, [...RATE_LIMIT_WAITS_MS, RATE_LIMIT_WAITS_MS[0]]);
});

test('the daily free cap fails fast: neither waiting nor switching models helps', async () => {
  const { agent, calls, waits } = scriptedAgent([freeDay()]);
  await assert.rejects(agent.run('go'), /free-models-per-day/);
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
});

test('a new message from the user lifts a failed-upload stop and restarts the paid-click count', async () => {
  const { noteToolResult, gatePaidClick, setPaidClickBudget, setPaidClickApprover } = await import('./browser/index.js');
  const counts = [];
  setPaidClickBudget(0);
  setPaidClickApprover(async (label, { count }) => { counts.push(count); return true; });
  await gatePaidClick('Generate Image');
  noteToolResult('browser_file_upload', false, 'browser_file_upload failed: no file chooser open');
  assert.equal((await gatePaidClick('Generate Image')).allowed, false, 'blocked inside the same task');
  await scriptedAgent(['ok']).agent.run('go ahead without the photos');
  assert.equal((await gatePaidClick('Generate Image')).allowed, true);
  assert.deepEqual(counts, [1, 1], 'the new task counts from 1 again');
  setPaidClickApprover(null);
});

test('every turn starts back on the chosen model with the whole chain', async () => {
  const { agent, calls } = scriptedAgent([busyModel(), 'first', 'second']);
  await agent.run('one');
  await agent.run('two');
  assert.deepEqual(calls, [CHAIN[0], CHAIN[1], CHAIN[0]]);
});
