import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Ported from quantus-cli: delegate to a specialist, personas, teach mode, and the end-of-session learning pass
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'quantess-delegate-')));
process.env.QUANTESS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quantess-home-'));
process.env.OPENROUTER_API_KEY ||= 'sk-or-test-not-a-real-key';
const { Agent } = await import('./agent.js');
const { findSkill } = await import('./skills/index.js');
const { setMemoryApprover } = await import('./memory.js');

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const step = (...calls) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: calls }, finish_reason: 'tool_calls' }] });
const say = (content) => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });

function agentWith(replies, options = {}) {
  const sent = [];
  const agent = new Agent({ browser: false, sleep: async () => {}, ...options });
  agent.client = { chat: { completions: { create: async (body) => { sent.push(body); return replies[Math.min(sent.length - 1, replies.length - 1)]; } } } };
  return { agent, sent };
}
const toolMessages = (body) => body.messages.filter((m) => m.role === 'tool').map((m) => m.content);

beforeEach(() => setMemoryApprover(null));

test('quantus\'s four personas ship with quantess', () => {
  for (const name of ['quantus', 'quanti-code', 'quanta-clause', 'quant-ology']) assert.ok(findSkill(`agent:${name}`), name);
});

test('delegate runs the specialist on its own prompt and hands its report back', async () => {
  const { agent, sent } = agentWith([step(call('d', 'delegate', { agent: 'quanti-code', task: 'Review add.js for bugs. Report as a list.' })), say('No bugs: add.js is fine.'), say('done')]);
  const r = await agent.run('get the code checked');
  assert.equal(r.response, 'done');
  assert.match(sent[1].messages[0].content, /Persona: quanti-code/, 'the specialist ran on its own persona');
  // The request holds the live message list, so read the brief, not whatever came after it
  assert.equal(sent[1].messages.find((m) => m.role === 'user').content, 'Review add.js for bugs. Report as a list.');
  assert.ok(!sent[1].tools.some((t) => t.function.name === 'delegate'), 'a specialist cannot delegate again');
  // Security review 10-23: its brief may carry a page's words, so only the main session saves memories
  assert.ok(!sent[1].tools.some((t) => t.function.name === 'remember'), 'a specialist cannot remember');
  assert.match(toolMessages(sent[2]).at(-1), /No bugs: add\.js is fine\./);
});

// Security review 10-23 (MEDIUM): a specialist's run reset the main turn's money-button state, clearing the
// "an upload failed: no money buttons" lock
test('negative: a specialist\'s run never clears the main turn\'s failed-upload lock on money buttons', async () => {
  const { noteToolResult, gatePaidClick, setPaidClickApprover } = await import('./browser/paidClicks.js');
  const replies = [step(call('d', 'delegate', { agent: 'quanti-code', task: 'check it' })), say('report'), say('done')];
  const sent = [];
  const agent = new Agent({ browser: false, sleep: async () => {} });
  agent.client = { chat: { completions: { create: async (body) => {
    sent.push(body);
    // The main turn's upload fails before it delegates
    if (sent.length === 1) noteToolResult('browser_file_upload', false, 'no file chooser');
    return replies[Math.min(sent.length - 1, replies.length - 1)];
  } } } };
  setPaidClickApprover(async () => true);
  try {
    await agent.run('upload the photo, get it checked, then generate');
    const gate = await gatePaidClick('Generate Image');
    assert.equal(gate.allowed, false);
    assert.match(gate.how, /upload/);
  } finally {
    setPaidClickApprover(null);
  }
});

test('negative: an unknown specialist, or a delegate from inside a delegate, is refused', async () => {
  const unknown = agentWith([step(call('d', 'delegate', { agent: 'no-such-agent-xyz', task: 'x' })), say('done')]);
  await unknown.agent.run('go');
  assert.match(toolMessages(unknown.sent[1]).at(-1), /NO_SUCH_AGENT/);
  const deep = agentWith([step(call('d', 'delegate', { agent: 'quanti-code', task: 'x' })), say('done')], { depth: 1 });
  await deep.agent.run('go');
  assert.match(toolMessages(deep.sent[1]).at(-1), /NOT_AVAILABLE|DELEGATION_DEPTH/);
});

test('a specialist that read the web makes the whole session count as having read outside text', async () => {
  const { agent } = agentWith([step(call('d', 'delegate', { agent: 'quanti-code', task: 'read the docs page' })),
    step(call('w', 'web_fetch', { url: 'http://localhost/' })), say('read it'), say('done')]);
  await agent.run('go');
  assert.equal(agent.readOutside, true);
});

test('persona and teach mode change the prompt, and /persona /teach rebuild it in place', () => {
  const { agent } = agentWith([say('x')], { persona: findSkill('agent:quanti-code'), teach: true });
  assert.match(agent.systemPrompt, /Persona: quanti-code/);
  assert.match(agent.systemPrompt, /Teach mode is ON/);
  agent.messages = [{ role: 'system', content: agent.systemPrompt }, { role: 'user', content: 'hi' }];
  agent.setTeach(false);
  agent.setPersona(findSkill('agent:quanta-clause'));
  assert.doesNotMatch(agent.systemPrompt, /Teach mode is ON/);
  assert.match(agent.messages[0].content, /Persona: quanta-clause/);
  assert.equal(agent.messages[1].content, 'hi');
});

test('the learning pass saves memories, and can touch nothing but the memory tools', async () => {
  // The session read a file (outside text, fail closed), so the memory waits for the user's yes
  const asked = [];
  setMemoryApprover(async (m) => { asked.push(m.name); return true; });
  const { agent, sent } = agentWith([
    step(call('r', 'read_file', { filepath: 'nope.txt' })), say('done'),
    step(call('x', 'run_shell', { cmd: 'echo hacked > hacked.txt' }), call('m', 'remember', { name: 'kart-port', type: 'project', description: 'kart port', content: 'Kart serves on 8864.' })),
    say('Saved kart-port.')
  ]);
  await agent.run('look at nope.txt');
  const learned = await agent.reflect();
  assert.match(learned, /kart-port/);
  assert.ok(fs.existsSync(path.join(process.env.QUANTESS_HOME, 'memory', 'kart-port.md')));
  assert.equal(fs.existsSync('hacked.txt'), false, 'run_shell was not available to the learning pass');
  assert.match(toolMessages(sent.at(-1)).join('\n'), /NOT_AVAILABLE/);
  assert.deepEqual(sent[2].tools.map((t) => t.function.name).sort(), ['recall', 'remember']);
  assert.deepEqual(asked, ['kart-port']);
});

test('negative: a session that ran no tools has nothing to learn, and costs nothing', async () => {
  const { agent, sent } = agentWith([say('hi')]);
  await agent.run('hello');
  assert.equal(await agent.reflect(), null);
  assert.equal(sent.length, 1);
});

// Code review 10-23: a specialist that threw escaped as a model failure, burned a fallback and left a tool call unanswered
test('negative: a specialist that crashes comes back as an error result, and the main job carries on', async () => {
  const realRun = Agent.prototype.run;
  Agent.prototype.run = async function (...args) {
    if (this.depth === 1) {
      this.readOutside = true;
      throw new Error('every model refused');
    }
    return realRun.apply(this, args);
  };
  try {
    const { agent, sent } = agentWith([step(call('d', 'delegate', { agent: 'quanti-code', task: 'x' })), say('done anyway')]);
    const r = await agent.run('go');
    assert.equal(r.response, 'done anyway');
    assert.match(toolMessages(sent.at(-1)).at(-1), /DELEGATE_FAILED/);
    assert.equal(agent.readOutside, true, 'what the specialist read still counts');
  } finally {
    Agent.prototype.run = realRun;
  }
});

// Code review 10-23: /learn mid-session left "This session is ending..." in the conversation
test('the learning pass leaves the conversation as it was', async () => {
  setMemoryApprover(async () => true);
  const { agent } = agentWith([step(call('r', 'read_file', { filepath: 'nope.txt' })), say('done'), say('nothing to save')]);
  await agent.run('look at nope.txt');
  const before = agent.messages.length;
  await agent.reflect();
  assert.equal(agent.messages.length, before);
  assert.ok(!agent.messages.some((m) => String(m.content ?? '').includes('This session is ending')));
});
