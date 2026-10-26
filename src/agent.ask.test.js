import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Ported from quantus-cli: --ask. Every file change and command waits for the user's y / n / always; reading never asks.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'quantess-ask-')));
process.env.QUANTESS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quantess-home-'));
process.env.OPENROUTER_API_KEY ||= 'sk-or-test-not-a-real-key';
const { Agent } = await import('./agent.js');

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const step = (...calls) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: calls }, finish_reason: 'tool_calls' }] });
const done = { choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] };

function agentWith(replies, options) {
  const sent = [];
  const agent = new Agent({ browser: false, sleep: async () => {}, ...options });
  agent.client = { chat: { completions: { create: async (body) => { sent.push(body); return replies[Math.min(sent.length - 1, replies.length - 1)]; } } } };
  return { agent, sent };
}
const toolMessages = (body) => body.messages.filter((m) => m.role === 'tool').map((m) => m.content);

test('negative: with --ask, a declined write is never written and the model is told why', async () => {
  const asked = [];
  const { agent, sent } = agentWith([step(call('w', 'write_file', { filepath: 'a.txt', content: 'hi' })), done],
    { askBeforeChanges: true, approveChange: async (name, line) => { asked.push(line); return 'no'; } });
  await agent.run('make a.txt');
  assert.equal(fs.existsSync('a.txt'), false);
  assert.match(asked[0], /write a\.txt/);
  assert.match(toolMessages(sent.at(-1)).at(-1), /CHANGE_DECLINED/);
});

test('always covers that kind of step for the rest of the session; reading never asks', async () => {
  let asked = 0;
  const { agent } = agentWith([
    step(call('r', 'read_file', { filepath: 'nope.txt' }), call('w1', 'write_file', { filepath: 'b.txt', content: '1' }), call('w2', 'write_file', { filepath: 'c.txt', content: '2' })),
    done
  ], { askBeforeChanges: true, approveChange: async () => { asked += 1; return 'always'; } });
  await agent.run('make two files');
  assert.equal(asked, 1, 'asked once for writes, never for the read');
  assert.ok(fs.existsSync('b.txt') && fs.existsSync('c.txt'));
});

test('negative: --ask with nobody at the terminal changes nothing', async () => {
  const { agent, sent } = agentWith([step(call('s', 'run_shell', { cmd: 'echo x > d.txt' })), done], { askBeforeChanges: true });
  await agent.run('run it');
  assert.equal(fs.existsSync('d.txt'), false);
  assert.match(toolMessages(sent.at(-1)).at(-1), /nobody at the terminal/);
});

test('without --ask, quantess works hands-free as before', async () => {
  const { agent } = agentWith([step(call('w', 'write_file', { filepath: 'e.txt', content: 'ok' })), done], {});
  await agent.run('make e.txt');
  assert.equal(fs.readFileSync('e.txt', 'utf8'), 'ok');
});

// Security review 10-23 (HIGH): a delegated specialist ran with no --ask at all
test('negative: under --ask, a delegated specialist\'s change waits for the user too', async () => {
  const asked = [];
  const { agent } = agentWith([
    step(call('d', 'delegate', { agent: 'quanti-code', task: 'write f.txt' })),
    step(call('w', 'write_file', { filepath: 'f.txt', content: 'x' })), { choices: [{ message: { role: 'assistant', content: 'tried' }, finish_reason: 'stop' }] },
    done
  ], { askBeforeChanges: true, approveChange: async (name, text) => { asked.push(text); return 'no'; } });
  await agent.run('get it written');
  assert.equal(fs.existsSync('f.txt'), false);
  assert.match(asked[0], /write f\.txt/);
});

// Security review 10-23: "always" for a write the user could not see whole would wave through the next one unseen
test('negative: always on a write shown only in part does not cover the next write', async () => {
  let asked = 0;
  const big = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n');
  const { agent } = agentWith([
    step(call('w1', 'write_file', { filepath: 'g.txt', content: big }), call('w2', 'write_file', { filepath: 'h.txt', content: big })),
    done
  ], { askBeforeChanges: true, approveChange: async (name, text, { complete }) => { asked += 1; return complete ? 'always' : 'always'; } });
  await agent.run('write two big files');
  assert.equal(asked, 2, 'asked for each');
});
