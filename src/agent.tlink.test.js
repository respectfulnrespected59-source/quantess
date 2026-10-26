import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// T-LINK security model 5: the device token in ~/.quantess/tlink.json must never reach the model.
// read_file / look_at_image / grep refuse the file and quantess's own folder; a shell command naming it is blocked;
// and any tool result that still carries the token is scrubbed before it enters the conversation or the transcript.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'quantess-tlink-agent-')));
process.env.QUANTESS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quantess-home-'));
process.env.OPENROUTER_API_KEY ||= 'sk-or-test-not-a-real-key';
const { Agent } = await import('./agent.js');
const { writePairing, tlinkFile } = await import('./tlink/store.js');

const TOKEN = `tlk_${'Q'.repeat(43)}`;
writePairing({ origin: 'https://quantus-ai.onrender.com', deviceId: 'dev_12345678', token: TOKEN, expiresAt: Date.now() + 86_400_000 },
  { restrict: () => true });

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const step = (...calls) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: calls }, finish_reason: 'tool_calls' }] });
const done = { choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] };

function agentWith(replies) {
  const sent = [];
  const agent = new Agent({ browser: false, sleep: async () => {} });
  agent.client = { chat: { completions: { create: async (body) => { sent.push(body); return replies[Math.min(sent.length - 1, replies.length - 1)]; } } } };
  return { agent, sent };
}
const lastTool = (sent) => sent.at(-1).messages.filter((m) => m.role === 'tool').at(-1).content;

test('negative: read_file and look_at_image refuse the T-LINK key file', async () => {
  for (const name of ['read_file', 'look_at_image']) {
    const { agent, sent } = agentWith([step(call('a', name, { filepath: tlinkFile(), question: 'x' })), done]);
    await agent.run('read it');
    const reply = lastTool(sent);
    assert.match(reply, /TLINK_KEY_BLOCKED/, name);
    assert.ok(!reply.includes(TOKEN), name);
  }
});

test('negative: grep inside quantess\'s own folder is refused', async () => {
  const { agent, sent } = agentWith([step(call('a', 'grep', { pattern: 'tlk_', cwd: process.env.QUANTESS_HOME })), done]);
  await agent.run('search it');
  assert.match(lastTool(sent), /TLINK_KEY_BLOCKED/);
});

test('negative: a shell command naming the key file is blocked', async () => {
  const { agent, sent } = agentWith([step(call('a', 'run_shell', { cmd: 'type %USERPROFILE%\\tlink.json' })), done]);
  await agent.run('show it');
  assert.match(lastTool(sent), /LIMIT_CHANGE_BLOCKED/);
});

test('negative: a tool result that still holds the token reaches the model scrubbed', async () => {
  // a copy elsewhere, read the ordinary way: the scrub is the backstop behind the guards
  fs.writeFileSync('leak.txt', `before ${TOKEN} after`);
  const { agent, sent } = agentWith([step(call('a', 'read_file', { filepath: 'leak.txt' })), done]);
  await agent.run('read leak.txt');
  const reply = lastTool(sent);
  assert.ok(!reply.includes(TOKEN));
  assert.match(reply, /\[tlink token\]/);
});

// Review 10-24 (H1/H2): other spellings of the key file, a hard link to it, and grep patterns that climb out of cwd
test('negative: a network-share (UNC) spelling of the key file is refused', async () => {
  const key = tlinkFile();
  const unc = `\\\\localhost\\${key[0].toLowerCase()}$${key.slice(2)}`;
  const { agent, sent } = agentWith([step(call('a', 'read_file', { filepath: unc })), done]);
  await agent.run('read it');
  assert.match(lastTool(sent), /TLINK_KEY_BLOCKED/);
});

test('negative: a hard link to the key file is refused (same file, different name)', async () => {
  try {
    fs.linkSync(tlinkFile(), 'innocent.txt');
  } catch {
    return; // a file system without hard links: nothing to test
  }
  const { agent, sent } = agentWith([step(call('a', 'read_file', { filepath: 'innocent.txt' })), done]);
  await agent.run('read innocent.txt');
  assert.match(lastTool(sent), /TLINK_KEY_BLOCKED/);
});

test('negative: grep cannot reach the key with ../, absolute, or parent-folder glob patterns', async () => {
  const home = process.env.QUANTESS_HOME;
  const parent = path.dirname(home);
  for (const args of [{ cwd: parent, globPattern: `${path.basename(home)}/*` },
    { cwd: process.cwd(), globPattern: path.relative(process.cwd(), home).split(path.sep).join('/') + '/*' },
    { cwd: process.cwd(), globPattern: `${home.split(path.sep).join('/')}/*` }]) {
    const { agent, sent } = agentWith([step(call('a', 'grep', { pattern: 'tlk_', ...args })), done]);
    await agent.run('search');
    const reply = lastTool(sent);
    assert.ok(!reply.includes('Q'.repeat(20)), JSON.stringify(args));
    assert.doesNotMatch(reply, /tlink\.json/, JSON.stringify(args));
  }
});

test('negative: the terminal step line never shows the key either (scrubbed before onToolEnd)', async () => {
  fs.writeFileSync('plain.txt', 'nothing here');
  const seen = [];
  const sent = [];
  const agent = new Agent({ browser: false, sleep: async () => {}, onToolEnd: (_n, r) => seen.push(JSON.stringify(r)) });
  const replies = [step(call('a', 'grep', { pattern: TOKEN, globPattern: 'plain.txt' })), done];
  agent.client = { chat: { completions: { create: async (body) => { sent.push(body); return replies[Math.min(sent.length - 1, 1)]; } } } };
  await agent.run('grep');
  assert.ok(seen.length && seen.every((s) => !s.includes(TOKEN)), seen.join('\n'));
});

test('negative: the key in base64 is scrubbed from a tool result too', async () => {
  const b64 = Buffer.from(TOKEN).toString('base64');
  fs.writeFileSync('leak64.txt', `x ${b64} y`);
  const { agent, sent } = agentWith([step(call('a', 'read_file', { filepath: 'leak64.txt' })), done]);
  await agent.run('read');
  assert.ok(!lastTool(sent).includes(b64));
});

// Automated review of 22b35f5: a non-utf-8 read shifts the bytes past the scrub, and a hard link can be grepped
test('negative: read_file reads text as utf-8 only (base64 / hex / utf16 would carry a key past the scrub)', async () => {
  fs.writeFileSync('text.txt', 'hello');
  for (const encoding of ['base64', 'hex', 'utf16le', 'latin1', 'binary']) {
    const { agent, sent } = agentWith([step(call('a', 'read_file', { filepath: 'text.txt', encoding })), done]);
    await agent.run('read');
    assert.match(lastTool(sent), /BAD_ENCODING/, encoding);
  }
});

test('negative: grep through a hard link to the key, anywhere, finds nothing', async () => {
  try {
    fs.linkSync(tlinkFile(), 'innocent2.txt');
  } catch {
    return;
  }
  const { agent, sent } = agentWith([step(call('a', 'grep', { pattern: 'tlk_', globPattern: 'innocent2.txt' })), done]);
  await agent.run('grep');
  // Not even a match count: a yes/no answer per guessed character would spell the key out
  assert.match(lastTool(sent), /Found 0 matches/);
});

// Automated review of c27a076: edit_file's found / not-found answer on a hard link would spell the key out too
test('negative: write_file and edit_file refuse the key under any name (a hard link)', async () => {
  try {
    fs.linkSync(tlinkFile(), 'innocent3.txt');
  } catch {
    return;
  }
  for (const [name, args] of [['edit_file', { filepath: 'innocent3.txt', oldString: 'tlk_', newString: 'x' }],
    ['write_file', { filepath: 'innocent3.txt', content: '{}' }]]) {
    const { agent, sent } = agentWith([step(call('a', name, args)), done]);
    await agent.run('change it');
    assert.match(lastTool(sent), /LIMIT_CHANGE_BLOCKED/, name);
  }
});

test('reading an ordinary file is unaffected', async () => {
  fs.writeFileSync('notes.txt', 'hello tlink world');
  const { agent, sent } = agentWith([step(call('a', 'read_file', { filepath: 'notes.txt' })), done]);
  await agent.run('read notes.txt');
  assert.match(lastTool(sent), /hello tlink world/);
});
