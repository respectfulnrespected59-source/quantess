import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 10-19: a session would "do SOMETHING but then go red and stay that way". The cause, from a game-build
// transcript: one tool call with a single-backslash Windows path, then "400 Provider returned error" on
// every later request, because the broken call stayed in the history. The fake provider below rejects a
// history exactly the way OpenRouter did: any tool call whose arguments are not valid JSON -> 400.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'q23-poison-')));
process.env.OPENROUTER_API_KEY ||= 'sk-or-test-not-a-real-key';
const { Agent } = await import('./agent.js');
const { config } = await import('./config/index.js');
const FALLBACKS = config.agent.fallbackModels.length;

const BS = String.fromCharCode(92);
const badRequest = () => Object.assign(new Error('400 Provider returned error'), { status: 400 });
const toolCall = (name, rawArgs, extra = {}) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id: 'call_0', type: 'function', function: { name, arguments: rawArgs } }],
  ...extra
});

/** Every request is checked like the real provider does; `script` plays out on the ACCEPTED requests. */
function strictAgent(script, options = {}) {
  const seen = { requests: 0, rejected: 0, toolArgs: [] };
  const agent = new Agent({
    browser: false,
    sleep: async () => {},
    onToolStart: (name, args) => seen.toolArgs.push({ name, args }),
    ...options
  });
  agent.client = {
    chat: {
      completions: {
        create: async ({ messages }) => {
          seen.requests++;
          const poisoned = messages.some((m) =>
            (m.tool_calls ?? []).some((tc) => {
              try {
                JSON.parse(tc.function.arguments);
                return false;
              } catch {
                return true;
              }
            })
          );
          if (poisoned) {
            seen.rejected++;
            throw badRequest();
          }
          const next = script.shift();
          if (next === undefined) throw new Error('script ran out');
          if (next instanceof Error) throw next;
          const message = typeof next === 'string' ? { role: 'assistant', content: next } : { ...next };
          const finish = message.finish;
          delete message.finish;
          return { choices: [{ message, finish_reason: finish ?? 'stop' }] };
        }
      }
    }
  };
  return { agent, seen };
}

test("A game-build failure: a lone-backslash Windows path is repaired, nothing is rejected, the NEXT turn works too", async () => {
  const raw = `{"filepath":"C:${BS}Users${BS}x.txt"}`;
  const { agent, seen } = strictAgent([toolCall('read_file', raw), 'done', 'done again']);
  const first = await agent.run('read it');
  assert.equal(first.response, 'done');
  assert.equal(seen.rejected, 0, 'no request was rejected');
  assert.equal(seen.toolArgs[0].args.filepath, `C:${BS}Users${BS}x.txt`, 'the tool ran on the repaired path');
  const second = await agent.run('again');
  assert.equal(second.response, 'done again', 'the session is still alive');
});

test('control: with the repair switched off, the same script goes red and STAYS red (proves the fake rejects)', async () => {
  const raw = `{"filepath":"C:${BS}Users${BS}x.txt"}`;
  const { agent, seen } = strictAgent([toolCall('read_file', raw), 'done', 'done again'], { repairToolCalls: false });
  await assert.rejects(agent.run('read it'), /400/);
  await assert.rejects(agent.run('again'), /400/);
  assert.ok(seen.rejected >= 2);
});

test('negative: garbage arguments become a BAD_ARGUMENTS reply and "{}" in the history, never a guess', async () => {
  const { agent, seen } = strictAgent([toolCall('list_files', '{"path": '), 'done']);
  assert.equal((await agent.run('list')).response, 'done');
  assert.equal(seen.rejected, 0);
  assert.equal(seen.toolArgs.length, 1);
  const step = agent.messages.find((m) => m.tool_calls?.length);
  assert.equal(step.tool_calls[0].function.arguments, '{}');
  const reply = agent.messages.find((m) => m.role === 'tool');
  assert.match(reply.content, /BAD_ARGUMENTS/);
});

test('negative: a write_file cut off at the token limit is refused, no half file lands on disk', async () => {
  const cut = toolCall('write_file', '{"filepath":"half.js","content":"function x() {', { finish: 'length' });
  const { agent, seen } = strictAgent([cut, 'done']);
  assert.equal((await agent.run('write it')).response, 'done');
  assert.equal(fs.existsSync(path.join(process.cwd(), 'half.js')), false);
  assert.equal(seen.rejected, 0);
  const reply = agent.messages.find((m) => m.role === 'tool');
  assert.match(reply.content, /cut off/i);
});

test('an unexplained 400 is retried once on a cleaned-up history and the job carries on', async () => {
  const { agent, seen } = strictAgent([badRequest(), 'done']);
  assert.equal((await agent.run('go')).response, 'done');
  assert.ok(seen.requests <= 2, `used ${seen.requests} requests`);
});

test('negative: a 400 that keeps coming ends the turn with a plain message - no throw - and the next turn works', async () => {
  const { agent, seen } = strictAgent([...Array(2 + FALLBACKS).fill(0).map(badRequest), 'back to normal']);
  const first = await agent.run('go');
  assert.match(first.response, /rejected/i);
  assert.ok(seen.requests <= 2 + FALLBACKS, `used ${seen.requests} requests`);
  assert.equal((await agent.run('try again')).response, 'back to normal');
});

// Review 10-23 (MEDIUM): after one clean-up, a 400 must still reach the fallback models before giving up
test('a 400 from the main model, even after the clean-up, hands the step to a fallback model', async () => {
  const { agent, seen } = strictAgent([badRequest(), badRequest(), 'done on the fallback']);
  assert.equal((await agent.run('go')).response, 'done on the fallback');
  assert.equal(seen.requests, 3);
});

test('negative: a 400 about the context length or the key is not "cleaned up" - it surfaces', async () => {
  const tooLong = Object.assign(new Error('400 This endpoint maximum context length is 262144 tokens'), { status: 400 });
  const { agent } = strictAgent(Array(2 + FALLBACKS).fill(tooLong));
  await assert.rejects(agent.run('go'), /context length/);
});

// Review 10-23 (MEDIUM): with streaming, the usage arrives in a LAST chunk with no choices - the cut-off
// flag must come from whichever chunk carried finish_reason, or a half write_file could be written.
test('negative: streaming - a write_file cut off at the token limit is refused even when a usage chunk comes last', async () => {
  let calls = 0;
  const agent = new Agent({ browser: false, sleep: async () => {}, stream: true });
  const chunks = (list) => ({ async *[Symbol.asyncIterator]() { yield* list; } });
  agent.client = {
    chat: {
      completions: {
        create: async () => {
          calls++;
          if (calls === 1) {
            return chunks([
              { choices: [{ delta: { tool_calls: [{ index: 0, id: 'w1', function: { name: 'write_file', arguments: '{"filepath":"half2.js",' } }] } }] },
              { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"function x() {' } }] }, finish_reason: 'length' }] },
              { choices: [], usage: { prompt_tokens: 10, completion_tokens: 8192 } }
            ]);
          }
          return chunks([{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }]);
        }
      }
    }
  };
  assert.equal((await agent.run('write it')).response, 'done');
  assert.equal(fs.existsSync(path.join(process.cwd(), 'half2.js')), false);
  assert.match(agent.messages.find((m) => m.role === 'tool').content, /cut off/i);
});
