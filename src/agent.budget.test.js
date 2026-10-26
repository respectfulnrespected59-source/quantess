import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Paid Nemotron (10-23): every turn books OpenRouter's REAL cost, and past the day's cap the job keeps
// going on free models. Before this, q23 priced any model missing from its table at $0.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'q23-budget-')));
process.env.OPENROUTER_API_KEY ||= 'sk-or-test-not-a-real-key';
delete process.env.QUANTESS_DAILY_CAP_USD;
const { Agent } = await import('./agent.js');
const { config } = await import('./config/index.js');

const ledger = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'q23-ledger-')), 'ledger.json');

function agentWith(replies, ledgerFile) {
  const sent = [];
  const agent = new Agent({ browser: false, sleep: async () => {}, ledgerFile });
  agent.client = {
    chat: {
      completions: {
        create: async (body) => {
          sent.push(body);
          return replies[Math.min(sent.length - 1, replies.length - 1)];
        }
      }
    }
  };
  return { agent, sent };
}

const reply = (content, cost) => ({
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1200, completion_tokens: 300, cost }
});

test('a turn shows and books the REAL cost OpenRouter reports, not a price-table guess', async () => {
  const file = ledger();
  const { agent, sent } = agentWith([reply('done', 0.00042)], file);
  const result = await agent.run('go');
  assert.equal(result.response, 'done');
  assert.equal(Number(result.cost.totalCost), 0.00042);
  assert.deepEqual(Object.values(JSON.parse(fs.readFileSync(file, 'utf8'))), [0.00042]);
  assert.deepEqual(sent[0].usage, { include: true }, 'the real cost was asked for');
  assert.equal(sent[0].model, config.agent.defaultModel);
});

test('the default lane is paid Nemotron Lightning with reasoning off (an empty reply otherwise)', async () => {
  const { agent, sent } = agentWith([reply('done', 0)], ledger());
  await agent.run('go');
  assert.equal(sent[0].model, 'nvidia/nemotron-3.5-lightning');
  assert.deepEqual(sent[0].reasoning, { enabled: false });
});

test('negative: with the day\'s cap already spent, the turn runs on a FREE model and books nothing', async () => {
  const file = ledger();
  fs.writeFileSync(file, JSON.stringify({ [new Date().toISOString().slice(0, 10)]: config.agent.dailyCapUsd + 1 }));
  const before = fs.readFileSync(file, 'utf8');
  const { agent, sent } = agentWith([reply('done on free', undefined)], file);
  assert.equal((await agent.run('go')).response, 'done on free');
  assert.match(sent[0].model, /:free$/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('a tool that spent money (a web search) counts in the session total', async () => {
  const { CostTracker } = await import('./agent.js');
  const t = new CostTracker();
  t.addUsage('nvidia/nemotron-3.5-lightning', 100, 50, 0.0004);
  t.addToolCost('web_search', 0.0071);
  t.addToolCost('web_search', undefined);
  t.addToolCost('look_at_image', -1);
  assert.equal(Number(t.getSummary().totalCost), 0.0075);
  assert.equal(t.getSummary().byModel['tool:web_search'].cost, 0.0071);
});

// 10-23: the cap is only real if the model cannot rewrite the ledger that counts toward it
test('negative: write_file / edit_file into the quantess home (the spend ledger) is blocked', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quantess-home-'));
  const file = path.join(home, 'ledger.json');
  fs.writeFileSync(file, '{"2026-10-23": 4.9}');
  const before = process.env.QUANTESS_HOME;
  process.env.QUANTESS_HOME = home;
  try {
    const write = { role: 'assistant', content: null, tool_calls: [{ id: 'w1', type: 'function',
      function: { name: 'write_file', arguments: JSON.stringify({ filepath: file, content: '{}' }) } }] };
    const { agent, sent } = agentWith([{ choices: [{ message: write, finish_reason: 'tool_calls' }] }, reply('ok', 0)], ledger());
    await agent.run('reset my spend');
    const toolMsg = sent[1].messages.find((m) => m.role === 'tool');
    assert.match(toolMsg.content, /LIMIT_CHANGE_BLOCKED/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{"2026-10-23": 4.9}');
  } finally {
    if (before === undefined) delete process.env.QUANTESS_HOME; else process.env.QUANTESS_HOME = before;
  }
});

/** The tool message the model gets back after one write_file / edit_file call. */
async function toolReplyFor(name, args) {
  const call = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
  const { agent, sent } = agentWith([{ choices: [{ message: call, finish_reason: 'tool_calls' }] }, reply('ok', 0)], ledger());
  await agent.run('go');
  return sent[1].messages.find((m) => m.role === 'tool').content;
}

// Security review 10-23 (MEDIUM): a junction to the home, or a \\?\ path, walked past a check that only read the text
test('negative: a junction into the quantess home, or a \\\\?\\ path, is still the quantess home', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quantess-home-'));
  const file = path.join(home, 'ledger.json');
  fs.writeFileSync(file, '{"2026-10-23": 4.9}');
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quantess-link-')), 'q');
  fs.symlinkSync(home, link, 'junction');
  const before = process.env.QUANTESS_HOME;
  process.env.QUANTESS_HOME = home;
  try {
    assert.match(await toolReplyFor('write_file', { filepath: path.join(link, 'ledger.json'), content: '{}' }), /LIMIT_CHANGE_BLOCKED/);
    assert.match(await toolReplyFor('write_file', { filepath: `\\\\?\\${file}`, content: '{}' }), /LIMIT_CHANGE_BLOCKED/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{"2026-10-23": 4.9}');
  } finally {
    if (before === undefined) delete process.env.QUANTESS_HOME; else process.env.QUANTESS_HOME = before;
  }
});

// Security review 10-23 (MEDIUM): the model could rewrite the very code that enforces its cap and gates
test('negative: quantess cannot edit its own budget and safety code', async () => {
  const own = fileURLToPath(new URL('./budget.js', import.meta.url));
  const original = fs.readFileSync(own, 'utf8');
  // An anchor that is not there: even if the gate failed, the file could not change
  const content = await toolReplyFor('edit_file', { filepath: own, oldString: '@@no-such-anchor@@', newString: 'x' });
  assert.match(content, /LIMIT_CHANGE_BLOCKED/);
  assert.equal(fs.readFileSync(own, 'utf8'), original);
});

// Security review 10-23 (MEDIUM): a hand-picked list missed files (package.json, other modules). The whole install
// folder is quantess's own code now: it never rewrites itself; the user (or Claude) does
test('negative: quantess cannot edit anything in its own install folder, package.json included', async () => {
  const pkg = fileURLToPath(new URL('../package.json', import.meta.url));
  const original = fs.readFileSync(pkg, 'utf8');
  const content = await toolReplyFor('edit_file', { filepath: pkg, oldString: '@@no-such-anchor@@', newString: 'x' });
  assert.match(content, /LIMIT_CHANGE_BLOCKED/);
  assert.equal(fs.readFileSync(pkg, 'utf8'), original);
});
