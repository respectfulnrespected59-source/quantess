import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Phase 6: pick up where you left off. Each turn saves the conversation (and whether it took in outside text) next
// to its transcript; quantess --continue loads the newest, /session <id> a chosen one.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'quantess-resume-')));
process.env.QUANTESS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quantess-home-'));
process.env.OPENROUTER_API_KEY ||= 'sk-or-test-not-a-real-key';
const { Agent } = await import('./agent.js');
const { latestStateId, loadState, sessionDir } = await import('./session/index.js');

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const step = (...calls) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: calls }, finish_reason: 'tool_calls' }] });
const say = (content) => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });

function agentWith(replies) {
  const sent = [];
  const agent = new Agent({ browser: false, sleep: async () => {} });
  agent.client = { chat: { completions: { create: async (body) => { sent.push(body); return replies[Math.min(sent.length - 1, replies.length - 1)]; } } } };
  return { agent, sent };
}

test('a turn saves the conversation, and a new quantess resumes it with the model seeing all of it', async () => {
  const first = agentWith([step(call('r', 'read_file', { filepath: 'nope.txt' })), say('the kart boost is 1.4x')]);
  await first.agent.run('what is the kart boost?');
  const id = first.agent.sessionId;
  assert.equal(latestStateId(), id);
  assert.equal(loadState(id).readOutside, true, 'it read a file: the memory gate stays closed after a resume');

  const second = agentWith([say('still 1.4x')]);
  assert.equal(second.agent.resume(id), true);
  await second.agent.run('and now?');
  const seen = second.sent[0].messages.map((m) => m.content);
  assert.ok(seen.includes('what is the kart boost?'), 'the earlier question');
  assert.ok(seen.includes('the kart boost is 1.4x'), 'the earlier answer');
  assert.equal(second.sent[0].messages[0].role, 'system', 'a fresh system prompt leads');
  assert.equal(second.agent.readOutside, true);
});

test('negative: an unknown, malformed or path-like session id is refused and nothing loads', () => {
  const { agent } = agentWith([say('x')]);
  assert.equal(agent.resume('00000000-0000-4000-8000-000000000000'), false);
  assert.equal(agent.resume('../../etc/passwd'), false);
  const bad = '11111111-1111-4111-8111-111111111111';
  fs.mkdirSync(sessionDir(), { recursive: true });
  fs.writeFileSync(path.join(sessionDir(), `${bad}.json`), '{ not json');
  assert.equal(agent.resume(bad), false);
  assert.equal(agent.messages.length, 0);
});

test('negative: a saved state with no outside-text flag resumes with the gate closed (fail closed)', () => {
  const id = '22222222-2222-4222-8222-222222222222';
  fs.writeFileSync(path.join(sessionDir(), `${id}.json`), JSON.stringify({ v: 1, messages: [{ role: 'user', content: 'hi' }] }));
  const { agent } = agentWith([say('x')]);
  assert.equal(agent.resume(id), true);
  assert.equal(agent.readOutside, true);
});

// Code review 10-23 (LOW): a saved state whose transcript was gone threw "not found" on the next turn
test('a session with a saved state but no transcript file resumes and keeps going', async () => {
  const id = '33333333-3333-4333-8333-333333333333';
  fs.writeFileSync(path.join(sessionDir(), `${id}.json`), JSON.stringify({ v: 1, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }], readOutside: false }));
  const { agent } = agentWith([say('still here')]);
  assert.equal(agent.resume(id), true);
  assert.equal((await agent.run('and now?')).response, 'still here');
});
