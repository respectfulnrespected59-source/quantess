import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// An MCP server the user listed in ~/.quantess/mcp.json: its tools reach the model, calls route to the server,
// and --ask asks before each one (an MCP tool can do anything)
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'quantess-agentmcp-')));
process.env.QUANTESS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quantess-home-'));
process.env.OPENROUTER_API_KEY ||= 'sk-or-test-not-a-real-key';
const ECHO = fileURLToPath(new URL('./fixtures/echo-mcp-server.mjs', import.meta.url));
fs.writeFileSync(path.join(process.env.QUANTESS_HOME, 'mcp.json'), JSON.stringify({ servers: { echo: { command: process.execPath, args: [ECHO] } } }));
const { Agent } = await import('./agent.js');
const { closeMcpServers } = await import('./mcp.js');

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const step = (...calls) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: calls }, finish_reason: 'tool_calls' }] });
const done = { choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] };

function agentWith(replies, options = {}) {
  const sent = [];
  const agent = new Agent({ browser: false, mcp: true, sleep: async () => {}, ...options });
  agent.client = { chat: { completions: { create: async (body) => { sent.push(body); return replies[Math.min(sent.length - 1, replies.length - 1)]; } } } };
  return { agent, sent };
}
const toolMessages = (body) => body.messages.filter((m) => m.role === 'tool').map((m) => m.content);

after(() => closeMcpServers());

test('a configured MCP server\'s tools reach the model and a call goes to the server', { timeout: 60000 }, async () => {
  const { agent, sent } = agentWith([step(call('m', 'mcp__echo__echo', { text: 'hello' })), done]);
  await agent.run('echo hello');
  assert.ok(sent[0].tools.some((t) => t.function.name === 'mcp__echo__echo'));
  assert.match(toolMessages(sent[1]).at(-1), /echo: hello/);
  assert.equal(agent.readOutside, true, 'a server\'s output is outside text');
});

test('negative: under --ask an MCP call waits for the user, who sees its arguments', { timeout: 60000 }, async () => {
  const asked = [];
  const { agent, sent } = agentWith([step(call('m', 'mcp__echo__echo', { text: 'secret plan' })), done],
    { askBeforeChanges: true, approveChange: async (name, text) => { asked.push(text); return 'no'; } });
  await agent.run('echo it');
  assert.match(asked[0], /mcp__echo__echo/);
  assert.match(asked[0], /secret plan/);
  assert.match(toolMessages(sent[1]).at(-1), /CHANGE_DECLINED/);
});

test('negative: an agent without MCP (tests, specialists) never starts the user\'s servers', async () => {
  const { agent, sent } = agentWith([done], { mcp: false });
  await agent.run('hi');
  assert.ok(!sent[0].tools.some((t) => t.function.name.startsWith('mcp__')));
});
