import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import OpenAI from 'openai';

// Hosted mode (`quantess login`, no OpenRouter key of your own): calls go to the QUAN-TESS proxy, paid from the plan.
// Only the proxy's models, no free fallback chain, no streaming; a refusal no wait can fix ends the turn in the site's
// words; a busy proxy is waited for; too large folds the history. The terminal key never reaches the model.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'quantess-hosted-agent-')));
process.env.QUANTESS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quantess-home-'));
delete process.env.QUANTESS_DAILY_CAP_USD;
delete process.env.QUANTESS_MODEL;
// The machine's own settings never decide these tests (a rig with its own key would otherwise resolve to direct)
delete process.env.OPENROUTER_API_KEY;
delete process.env.QUANTESS_HOSTED;
const { Agent } = await import('./agent.js');
const { config } = await import('./config/index.js');
const { authFile, writeAuth } = await import('./hosted/auth.js');

const KEY = `qtk_${'Z'.repeat(43)}`;
const SITE = 'https://quantus-ai.onrender.com';
writeAuth({ site: SITE, keyId: 'key_hostedtest', label: 'MY-PC', token: KEY }, { restrict: () => true });
const HOSTED = { mode: 'hosted', baseURL: `${SITE}/api/cli/v1`, apiKey: KEY, keyId: 'key_hostedtest', site: SITE };
const LIGHTNING = 'nvidia/nemotron-3.5-lightning';

const ledger = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quantess-ledger-')), 'ledger.json');
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const step = (...calls) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: calls }, finish_reason: 'tool_calls' }] });
const done = (content = 'done') => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.00001 } });
const apiError = (status, code, message) => OpenAI.APIError.generate(status, { error: { code, message } }, undefined, {});

/** replies: a reply object, or an Error to throw for that call. */
function hostedAgent(replies, options = {}) {
  const sent = [];
  const agent = new Agent({ browser: false, sleep: async () => {}, ledgerFile: ledger(), provider: HOSTED, ...options });
  agent.client = {
    chat: {
      completions: {
        create: async (body) => {
          sent.push(body);
          const r = replies[Math.min(sent.length - 1, replies.length - 1)];
          if (r instanceof Error) throw r;
          return r;
        },
      },
    },
  };
  return { agent, sent };
}
const lastTool = (sent) => sent.at(-1).messages.filter((m) => m.role === 'tool').at(-1).content;

test('hosted builds its client against the site proxy with the terminal key', () => {
  const agent = new Agent({ browser: false, provider: HOSTED });
  assert.equal(agent.hosted, true);
  assert.equal(agent.client.baseURL, `${SITE}/api/cli/v1`);
  assert.equal(agent.client.apiKey, KEY);
});

test('hosted uses only the proxy\'s models: no free fallback chain, no streaming; --deep keeps Ultra', async () => {
  const { agent, sent } = hostedAgent([done()], { model: 'cohere/north-mini-code:free', stream: true });
  // mapped from the start: /model, the banner and a delegate's sub-agent all read agent.model
  assert.equal(agent.model, LIGHTNING);
  assert.deepEqual(agent.fallbackModels, []);
  assert.equal(agent.stream, false);
  await agent.run('go');
  assert.equal(sent[0].model, LIGHTNING);
  const deep = hostedAgent([done()], { model: config.agent.deepModel });
  await deep.agent.run('go');
  assert.equal(deep.sent[0].model, config.agent.deepModel);
});

test('a model set later (/model) that the proxy does not take is mapped at the next turn, never sent', async () => {
  const { agent, sent } = hostedAgent([done()]);
  agent.model = 'anthropic/claude-opus-4';
  await agent.run('go');
  assert.equal(sent[0].model, LIGHTNING);
});

test('past the local daily cap a hosted turn makes no call at all (a second guard behind the site\'s), never a free model', async () => {
  const file = ledger();
  fs.writeFileSync(file, JSON.stringify({ [new Date().toISOString().slice(0, 10)]: config.agent.dailyCapUsd + 1 }));
  const { agent, sent } = hostedAgent([done()], { ledgerFile: file });
  const result = await agent.run('go');
  assert.equal(sent.length, 0);
  assert.equal(result.refused, true);
  assert.match(result.response, /local spending cap/);
});

test('a refusal no wait can fix ends the turn in the site\'s words: one call, no retry, no other model', async () => {
  for (const [status, code] of [[402, 'upgrade_required'], [402, 'quota_exhausted'], [429, 'daily_cap'], [429, 'account_paused'], [503, 'not_configured']]) {
    const { agent, sent } = hostedAgent([apiError(status, code, `site: ${code}`), done('should not run')]);
    const result = await agent.run('go');
    assert.equal(result.response, `site: ${code}`, code);
    assert.equal(sent.length, 1, code);
  }
  const out = hostedAgent([apiError(401, 'signed_out', 'Not signed in.')]);
  assert.match((await out.agent.run('go')).response, /quantess login/);
});

test('a busy proxy is waited for and the same model tried again', async () => {
  const { agent, sent } = hostedAgent([apiError(429, 'upstream_busy', 'The model is busy.'), done('after the wait')]);
  const result = await agent.run('go');
  assert.equal(result.response, 'after the wait');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].model, sent[0].model);
});

test('too large for one call: the history is folded and the step tried once more', async () => {
  const { agent, sent } = hostedAgent([done('first answer')]);
  await agent.run('first');
  // a long session to fold
  agent.messages.push(...Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `old step ${i} ${'x'.repeat(200)}` })));
  sent.length = 0;
  const replies = [
    apiError(413, 'too_large', 'That request is too large for one terminal call.'),
    done('SUMMARY: the older work'),
    done('after the fold'),
  ];
  agent.client.chat.completions.create = async (body) => {
    sent.push(body);
    const r = replies[Math.min(sent.length - 1, replies.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  const result = await agent.run('go on');
  assert.equal(result.response, 'after the fold');
  assert.equal(sent.length, 3);
  assert.ok(sent[2].messages.length < sent[0].messages.length, 'the retried step carried the folded history');
});

test('negative: the terminal key file is refused to read_file and look_at_image, by name and by hard link', async () => {
  for (const name of ['read_file', 'look_at_image']) {
    const { agent, sent } = hostedAgent([step(call('a', name, { filepath: authFile(), question: 'x' })), done()]);
    await agent.run('read it');
    const reply = lastTool(sent);
    assert.match(reply, /KEY_BLOCKED/, name);
    assert.match(reply, /terminal key/, name);
    assert.ok(!reply.includes(KEY), name);
  }
  try {
    fs.linkSync(authFile(), 'innocent-key.txt');
  } catch {
    return; // no hard links on this file system
  }
  const { agent, sent } = hostedAgent([step(call('a', 'read_file', { filepath: 'innocent-key.txt' })), done()]);
  await agent.run('read innocent-key.txt');
  assert.match(lastTool(sent), /KEY_BLOCKED/);
});

test('negative: a shell command naming the terminal key file is blocked', async () => {
  const { agent, sent } = hostedAgent([step(call('a', 'run_shell', { cmd: 'type C:\\anywhere\\terminal-key.json' })), done()]);
  await agent.run('show it');
  assert.match(lastTool(sent), /LIMIT_CHANGE_BLOCKED/);
});

test('negative: a tool result that still holds the terminal key reaches the model scrubbed', async () => {
  fs.writeFileSync('copy.txt', `before ${KEY} after`);
  const { agent, sent } = hostedAgent([step(call('a', 'read_file', { filepath: 'copy.txt' })), done()]);
  await agent.run('read copy.txt');
  const reply = lastTool(sent);
  assert.ok(!reply.includes(KEY));
  assert.match(reply, /\[terminal key\]/);
});

test('direct mode is untouched: your own key keeps the fallback chain', () => {
  const agent = new Agent({ browser: false, provider: { mode: 'direct', baseURL: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-v1-test' } });
  assert.equal(agent.hosted, false);
  assert.deepEqual(agent.fallbackModels, config.agent.fallbackModels);
});

// Code + security reviews of 4d1cc19
test('a refused turn says so (refused: true) and the learning pass learns nothing from it', async () => {
  const { agent } = hostedAgent([step(call('a', 'list_files', { pattern: '*.none' })), apiError(402, 'quota_exhausted', 'site: used up')]);
  const result = await agent.run('go');
  assert.equal(result.refused, true);
  assert.equal(result.response, 'site: used up');
  assert.equal(await agent.reflect(), null, 'a refusal is not a lesson');
  const ok = hostedAgent([done('fine')]);
  assert.equal((await ok.agent.run('go')).refused, false);
});

test('hosted turns never stream (the proxy answers whole)', async () => {
  const { sent } = await (async () => {
    const h = hostedAgent([done()]);
    await h.agent.run('go');
    return h;
  })();
  assert.equal(sent[0].stream, false);
});

test('a key replaced by `quantess login` in another window is picked up once, and the step tried again', async () => {
  const old = `qtk_${'O'.repeat(43)}`;
  const replaced = `qtk_${'N'.repeat(43)}`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quantess-reauth-'));
  const before = process.env.QUANTESS_HOME;
  process.env.QUANTESS_HOME = home;
  try {
    writeAuth({ site: SITE, keyId: 'key_newnewnew', label: 'MY-PC', token: replaced }, { restrict: () => true });
    const built = [];
    const makeClient = (p) => {
      built.push(p.apiKey);
      return { chat: { completions: { create: async () => (p.apiKey === old ? Promise.reject(apiError(401, 'signed_out', 'Not signed in.')) : done('with the new key')) } } };
    };
    // the session started on the old key: that is what web_search and look_at_image hold until told otherwise
    const { provider, useProvider } = await import('./provider.js');
    useProvider({ ...HOSTED, apiKey: old });
    const agent = new Agent({ browser: false, sleep: async () => {}, ledgerFile: ledger(), provider: { ...HOSTED, apiKey: old }, makeClient });
    const result = await agent.run('go');
    assert.equal(result.response, 'with the new key');
    assert.deepEqual(built, [old, replaced]);
    // web_search and look_at_image use the shared provider: it took the new key too
    assert.equal(provider().apiKey, replaced);
    // a key that is still the dead one: no loop, the turn ends with how to sign in
    writeAuth({ site: SITE, keyId: 'key_oldoldold', label: 'MY-PC', token: old }, { restrict: () => true });
    const stuck = new Agent({ browser: false, sleep: async () => {}, ledgerFile: ledger(), provider: { ...HOSTED, apiKey: old }, makeClient });
    const out = await stuck.run('go');
    assert.equal(out.refused, true);
    assert.match(out.response, /quantess login/);
  } finally {
    process.env.QUANTESS_HOME = before;
  }
});

test('the site\'s refusal text is scrubbed of the terminal key before it reaches the transcript or the phone', async () => {
  const { agent } = hostedAgent([apiError(402, 'upgrade_required', `echo of ${KEY} from upstream`)]);
  const result = await agent.run('go');
  assert.ok(!result.response.includes(KEY));
  assert.match(result.response, /\[terminal key\]/);
});

test('negative: a tool result holding the key in a form the scrub cannot see (spaced out) is withheld whole', async () => {
  fs.writeFileSync('spaced.txt', `before ${KEY.split('').join(' ')} after`);
  const { agent, sent } = hostedAgent([step(call('a', 'read_file', { filepath: 'spaced.txt' })), done()]);
  await agent.run('read spaced.txt');
  const reply = lastTool(sent);
  assert.match(reply, /KEY_WITHHELD/);
  assert.ok(!reply.includes('Z Z Z Z'));
});

test('a delegated specialist pays the same way: the plan\'s model, no stream, no free chain', async () => {
  const { agent, sent } = hostedAgent([
    step(call('d', 'delegate', { agent: 'quanti-code', task: 'Review add.js for bugs. Report as a list.' })),
    done('No bugs.'),
    done('done'),
  ], { model: 'cohere/north-mini-code:free' });
  await agent.run('go');
  assert.equal(sent.length, 3);
  for (const body of sent) {
    assert.equal(body.model, LIGHTNING);
    assert.equal(body.stream, false);
  }
});

test('direct mode, end to end: the OpenRouter client, and past the local cap the free chain (as before)', async () => {
  const direct = { mode: 'direct', baseURL: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-v1-test' };
  const built = new Agent({ browser: false, provider: direct });
  assert.equal(built.client.baseURL, 'https://openrouter.ai/api/v1');
  assert.equal(built.client.apiKey, 'sk-or-v1-test');
  const file = ledger();
  fs.writeFileSync(file, JSON.stringify({ [new Date().toISOString().slice(0, 10)]: config.agent.dailyCapUsd + 1 }));
  const { agent, sent } = hostedAgent([done('free answer')], { provider: direct, ledgerFile: file });
  const result = await agent.run('go');
  assert.equal(result.response, 'free answer');
  assert.equal(result.refused, false);
  assert.match(sent[0].model, /:free$/);
});

// Verification review of 37321b2
test('a call that never reached the site (Render\'s edge page) is tried once more; one the proxy answered is not', async () => {
  const edge = OpenAI.APIError.generate(502, undefined, '<html>Bad gateway</html>', {});
  const ok = hostedAgent([edge, done('after the edge blip')]);
  assert.equal((await ok.agent.run('go')).response, 'after the edge blip');
  assert.equal(ok.sent.length, 2);
  // twice in a row: one retry only
  const twice = hostedAgent([edge, edge, done('never')]);
  await assert.rejects(twice.agent.run('go'));
  assert.equal(twice.sent.length, 2);
  // the proxy's own 502 may have charged the hold: never retried behind the user's back
  const proxy = hostedAgent([apiError(502, 'upstream_error', 'The model service did not answer properly.'), done('never')]);
  await assert.rejects(proxy.agent.run('go'));
  assert.equal(proxy.sent.length, 1);
});

test('a specialist the site refuses is reported as refused, never as a finished report', async () => {
  const { agent, sent } = hostedAgent([
    step(call('d', 'delegate', { agent: 'quanti-code', task: 'Review add.js for bugs. Report as a list.' })),
    apiError(402, 'quota_exhausted', 'site: used up'),
    done('main done'),
  ]);
  await agent.run('go');
  const reply = lastTool(sent);
  assert.match(reply, /DELEGATE_REFUSED/);
  assert.match(reply, /site: used up/);
});
