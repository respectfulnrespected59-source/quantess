import { test } from 'node:test';
import assert from 'node:assert/strict';

// The OpenAI client refuses to build without a key; no request is ever sent in these tests.
process.env.OPENROUTER_API_KEY ||= 'sk-or-test-not-a-real-key';
const { Agent } = await import('./agent.js');

function freshAgent() {
  const agent = new Agent({ browser: false });
  agent.messages = [{ role: 'system', content: 'test' }];
  return agent;
}

const lastResult = (agent) => JSON.parse(agent.messages.at(-1).content);

test('broken tool arguments go back to the model as an error, not a crash', async () => {
  const agent = freshAgent();
  await agent.runToolCalls([{ id: 'a', function: { name: 'read_file', arguments: '{"filepath": "x"' } }]);
  assert.equal(agent.messages.at(-1).tool_call_id, 'a');
  assert.equal(lastResult(agent).error.code, 'BAD_ARGUMENTS');
});

test('a tool call with no name still gets a reply, so the next request is not rejected', async () => {
  const agent = freshAgent();
  await agent.runToolCalls([{ id: 'b', function: { name: '', arguments: '{}' } }]);
  assert.equal(agent.messages.at(-1).tool_call_id, 'b');
  assert.equal(lastResult(agent).status, 'error');
});

test('Q23 cannot raise its own money or browser limits from the shell', async () => {
  const agent = freshAgent();
  await agent.runToolCalls([{ id: 'd', function: { name: 'run_shell', arguments: JSON.stringify({ cmd: 'quantessq23 --paid 5 "upscale it"' }) } }]);
  assert.equal(lastResult(agent).error.code, 'LIMIT_CHANGE_BLOCKED');
});

test('a browser call with the browser server down says so and how to fix it', async () => {
  const agent = freshAgent();
  await agent.runToolCalls([{ id: 'c', function: { name: 'browser_navigate', arguments: '{"url":"about:blank"}' } }]);
  assert.equal(lastResult(agent).error.code, 'BROWSER_OFF');
  assert.match(lastResult(agent).nextActions[0], /--doctor/);
});

// --- push gate: "never push" is written in the skills, and free models have ignored written rules ---
import { setPublishApprover } from './pushGate.js';

test('a git push with nobody at the terminal is blocked before it runs', async () => {
  setPublishApprover(null);
  const agent = freshAgent();
  await agent.runToolCalls([{ id: 'p', function: { name: 'run_shell', arguments: JSON.stringify({ cmd: 'git -C C:/x push origin master' }) } }]);
  assert.equal(lastResult(agent).error.code, 'PUBLISH_BLOCKED');
});

test('a git push the user says no to is blocked; the command never runs', async () => {
  const asked = [];
  setPublishApprover(async (cmd) => { asked.push(cmd); return false; });
  const agent = freshAgent();
  await agent.runToolCalls([{ id: 'q', function: { name: 'run_shell', arguments: JSON.stringify({ cmd: 'gh pr merge 3 --squash' }) } }]);
  assert.deepEqual(asked, ['gh pr merge 3 --squash'], 'the user is shown the exact command');
  assert.equal(lastResult(agent).error.code, 'PUBLISH_BLOCKED');
  setPublishApprover(null);
});

// --- VS Code view: a successful write or edit is reported with its line; a failed one is not ---
import fsTest from 'fs';
import osTest from 'os';
import pathTest from 'path';

test('a successful edit_file tells onFileChanged the file and line; a failed one tells nothing', async () => {
  const seen = [];
  const agent = new Agent({ browser: false, onFileChanged: (file, line) => seen.push({ file, line }) });
  agent.messages = [{ role: 'system', content: 'test' }];
  const f = pathTest.join(fsTest.mkdtempSync(pathTest.join(osTest.tmpdir(), 'q23-view-')), 'gun.js');
  fsTest.writeFileSync(f, 'a\nb\nc\n');
  await agent.runToolCalls([{ id: 'e1', function: { name: 'edit_file', arguments: JSON.stringify({ filepath: f, oldString: 'c', newString: 'C' }) } }]);
  await agent.runToolCalls([{ id: 'e2', function: { name: 'edit_file', arguments: JSON.stringify({ filepath: f, oldString: 'zzz', newString: 'y' }) } }]);
  assert.deepEqual(seen, [{ file: f, line: 3 }]);
});
