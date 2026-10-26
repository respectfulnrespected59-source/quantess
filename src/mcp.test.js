import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMcpConfig, startMcpServers, callMcpTool, isMcpTool, closeMcpServers, serverParams } from './mcp.js';

// Plug-in tool servers (MCP), like Claude Code's: the user lists them in ~/.quantess/mcp.json and their tools join
// quantess's as mcp__<server>__<tool>
const ECHO = fileURLToPath(new URL('./fixtures/echo-mcp-server.mjs', import.meta.url));
const configFile = (servers) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quantess-mcp-')), 'mcp.json');
  fs.writeFileSync(file, typeof servers === 'string' ? servers : JSON.stringify({ servers }));
  return file;
};

after(() => closeMcpServers());

test('the config lists servers; a missing file means none, and a bad entry is reported, never run', () => {
  assert.deepEqual(readMcpConfig(path.join(os.tmpdir(), 'no-such-dir-xyz', 'mcp.json')), { servers: [], problems: [] });
  const r = readMcpConfig(configFile({
    echo: { command: 'node', args: ['echo.mjs'], env: { ECHO_EXTRA: '1' } },
    'bad name!': { command: 'node' },
    noCommand: { args: [] },
    badArgs: { command: 'node', args: 'not a list' }
  }));
  assert.deepEqual(r.servers.map((s) => s.name), ['echo']);
  assert.equal(r.problems.length, 3);
  assert.match(readMcpConfig(configFile('{ not json')).problems[0], /not valid JSON/);
});

test('negative: a server never sees quantess\'s own environment (the OpenRouter key), only what its entry lists', () => {
  const before = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-test-should-not-leak';
  try {
    const p = serverParams({ name: 'x', command: 'node', args: ['a.mjs'], env: { ECHO_EXTRA: 'yes' } });
    assert.equal(p.env.OPENROUTER_API_KEY, undefined);
    assert.equal(p.env.ECHO_EXTRA, 'yes');
    assert.ok(p.env.PATH || p.env.Path, 'the basics a program needs to start are there');
  } finally {
    if (before === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = before;
  }
});

test('a real MCP server starts, its tools join as mcp__<server>__<tool>, and a call comes back as text', { timeout: 60000 }, async () => {
  process.env.OPENROUTER_API_KEY ||= 'sk-or-test-not-a-real-key';
  const config = readMcpConfig(configFile({ echo: { command: process.execPath, args: [ECHO], env: { ECHO_EXTRA: 'hi' } } }));
  const { tools, problems } = await startMcpServers(config);
  assert.deepEqual(problems, []);
  const names = tools.map((t) => t.function.name).sort();
  assert.deepEqual(names, ['mcp__echo__echo', 'mcp__echo__fail']);
  assert.equal(isMcpTool('mcp__echo__echo'), true);
  assert.equal(isMcpTool('read_file'), false);
  const r = await callMcpTool('mcp__echo__echo', { text: 'quantess' });
  assert.equal(r.status, 'success', r.summary);
  assert.match(r.data, /echo: quantess \| key visible: false \| extra: hi/);
  const failed = await callMcpTool('mcp__echo__fail', {});
  assert.equal(failed.status, 'error');
  assert.match(failed.summary, /broke on purpose/);
});

test('negative: a server that will not start is reported, and the others still work', { timeout: 60000 }, async () => {
  const config = readMcpConfig(configFile({ broken: { command: 'no-such-program-xyz-123' }, echo2: { command: process.execPath, args: [ECHO] } }));
  const { tools, problems } = await startMcpServers(config);
  assert.ok(tools.some((t) => t.function.name === 'mcp__echo2__echo'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /broken/);
});

// Security review 10-23: a thrown error went back to the model unmasked, unlike a normal result
test('negative: a key in a server\'s error message is masked before the model sees it', async () => {
  const key = ['sk', 'or', 'v1', '0123456789abcdef0123456789abcdef0123456789abcdef'].join('-');
  const fakeClient = { callTool: async () => { throw new Error(`upstream said: bad auth ${key}`); }, close: async () => {} };
  const { tools, problems } = await startMcpServers({ servers: [{ name: 'leaky', command: 'x', args: [], env: {} }], problems: [] },
    { connect: async () => ({ client: fakeClient, tools: [{ name: 'go', inputSchema: { type: 'object', properties: {} } }] }) });
  assert.deepEqual(problems, []);
  assert.ok(tools.some((t) => t.function.name === 'mcp__leaky__go'));
  const r = await callMcpTool('mcp__leaky__go', {});
  assert.equal(r.status, 'error');
  assert.ok(!r.summary.includes(key), r.summary);
});

// Code review 10-23 (HIGH): a server's stderr was piped but never read; ~16 KB later the server froze mid-call
test('negative: a server that floods its error output still answers', { timeout: 30000 }, async () => {
  const config = readMcpConfig(configFile({ noisy: { command: process.execPath, args: [ECHO], env: { ECHO_NOISY: '1' } } }));
  const { problems } = await startMcpServers(config);
  assert.deepEqual(problems, []);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const started = Date.now();
  const r = await callMcpTool('mcp__noisy__echo', { text: 'still here' });
  assert.equal(r.status, 'success', r.summary);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
});

test('two tools whose names clean up the same both stay callable, and every page of tools is read', async () => {
  const { listAllTools } = await import('./mcp.js');
  const pages = { undefined: { tools: [{ name: 'a' }], nextCursor: 'p2' }, p2: { tools: [{ name: 'b' }] } };
  const all = await listAllTools({ listTools: async (params) => pages[params?.cursor] });
  assert.deepEqual(all.map((t) => t.name), ['a', 'b']);
  const client = { callTool: async ({ name }) => ({ content: [{ type: 'text', text: `called ${name}` }] }), close: async () => {} };
  const { tools } = await startMcpServers({ servers: [{ name: 'dupes', command: 'x', args: [], env: {} }], problems: [] },
    { connect: async () => ({ client, tools: [{ name: 'get.item' }, { name: 'get_item' }] }) });
  const names = tools.map((t) => t.function.name);
  assert.equal(new Set(names).size, names.length, 'no duplicate function names (the provider would refuse every request)');
  assert.match((await callMcpTool(names[0], {})).data, /called get\.item/);
  assert.match((await callMcpTool(names[1], {})).data, /called get_item/);
});

test('negative: a server that stopped says so instead of failing every call the same way', async () => {
  const client = { callTool: async () => ({ content: [] }), close: async () => {} };
  await startMcpServers({ servers: [{ name: 'gone', command: 'x', args: [], env: {} }], problems: [] },
    { connect: async () => ({ client, tools: [{ name: 'ping' }] }) });
  client.onclose();
  const r = await callMcpTool('mcp__gone__ping', {});
  assert.equal(r.error.code, 'MCP_OFF');
  assert.match(r.summary, /stopped/);
});
