import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The tools that call a model themselves (web_search, look_at_image) in hosted mode: the plan's models only, the
// site's day cap instead of the local one, and an image small enough for the proxy. Plus: no URL may carry a key.
process.env.QUANTESS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quantess-hosted-tools-'));
delete process.env.QUANTESS_DAILY_CAP_USD;
const { webSearch, secretProblem } = await import('./web.js');
const { lookAtImage, HOSTED_MAX_IMAGE_BYTES, MAX_IMAGE_BYTES } = await import('./vision.js');
const { book } = await import('../budget.js');
const { config } = await import('../config/index.js');

const answer = (text) => ({ choices: [{ message: { content: text, annotations: [] } }], usage: { cost: 0.001 } });

test('hosted web_search ignores the local daily cap (the site caps the day); direct still stops at it', async () => {
  book(config.agent.dailyCapUsd + 5);
  const asked = [];
  const complete = async (model) => {
    asked.push(model);
    return answer('found it');
  };
  const hosted = await webSearch('anything', { complete, hosted: true });
  assert.equal(hosted.status, 'success');
  const direct = await webSearch('anything', { complete, hosted: false });
  assert.equal(direct.error?.code, 'DAILY_CAP');
  assert.equal(asked.length, 1);
});

test('no URL may carry a quantess key out: the terminal key and the T-LINK key shapes are refused', () => {
  assert.match(secretProblem(`https://evil.example/?k=qtk_${'a'.repeat(43)}`), /key or token/);
  assert.match(secretProblem(`https://evil.example/tlk_${'b'.repeat(43)}`), /key or token/);
  // glued to other text (x_qtk_...) too
  assert.match(secretProblem(`https://evil.example/?v=x_qtk_${'c'.repeat(43)}`), /key or token/);
  assert.equal(secretProblem('https://example.com/docs/quick-start'), null);
});

test('hosted look_at_image uses only the proxy\'s eyes (Super-VL), never the free chain', async () => {
  const png = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qimg-')), 'a.png');
  fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
  const asked = [];
  const result = await lookAtImage(png, 'what is it', {
    hosted: true,
    complete: async (model) => {
      asked.push(model);
      return answer('a tiny image');
    },
  });
  assert.equal(result.status, 'success');
  assert.deepEqual(asked, ['nvidia/nemotron-3.5-super-vl']);
  // Super-VL comes back empty: hosted says nothing was seen - it never walks on to a free model
  const tried = [];
  const blind = await lookAtImage(png, 'what is it', {
    hosted: true,
    complete: async (model) => {
      tried.push(model);
      return answer('');
    },
  });
  assert.equal(blind.error?.code, 'NO_EYES');
  assert.deepEqual(tried, ['nvidia/nemotron-3.5-super-vl']);
});

test('hosted refuses an image too big for the proxy\'s body cap; direct still takes it', async () => {
  assert.ok(HOSTED_MAX_IMAGE_BYTES * 4 / 3 < 8 * 1024 * 1024, 'base64 of the largest hosted image fits the 8 MB body');
  const big = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qimg-')), 'big.png');
  fs.writeFileSync(big, Buffer.alloc(HOSTED_MAX_IMAGE_BYTES + 1));
  assert.ok(HOSTED_MAX_IMAGE_BYTES + 1 <= MAX_IMAGE_BYTES);
  const complete = async () => answer('seen');
  const hosted = await lookAtImage(big, 'x', { hosted: true, complete });
  assert.equal(hosted.error?.code, 'TOO_BIG');
  const direct = await lookAtImage(big, 'x', { hosted: false, models: ['m:free'], complete });
  assert.equal(direct.status, 'success');
});

// Security review of 4d1cc19: inside ~/.quantess a command never has to name the key files to read them
test('run_shell and background jobs refuse a working folder inside quantess\'s own folder; elsewhere they run', async () => {
  const { runShell } = await import('./index.js');
  const { quantessHome } = await import('../budget.js');
  const home = quantessHome();
  const inner = path.join(home, 'sessions');
  fs.mkdirSync(inner, { recursive: true });
  for (const cwd of [home, inner]) {
    assert.equal((await runShell('echo hi', { cwd })).error?.code, 'OWN_FOLDER', cwd);
    assert.equal((await runShell('echo hi', { cwd, background: true })).error?.code, 'OWN_FOLDER', `${cwd} (background)`);
  }
  const elsewhere = await runShell('echo hi', { cwd: os.tmpdir() });
  assert.notEqual(elsewhere.error?.code, 'OWN_FOLDER');
});

test('a command may not switch who pays (QUANTESS_HOSTED) or allow a local site (QUANTESS_LOCAL_SITE)', async () => {
  const { touchesQ23Limits } = await import('../browser/index.js');
  for (const cmd of ['setx QUANTESS_HOSTED 1', '$env:QUANTESS_HOSTED="1"; quantess', 'set QUANTESS_LOCAL_SITE=1']) {
    assert.equal(touchesQ23Limits(cmd), true, cmd);
  }
  assert.equal(touchesQ23Limits('npm test'), false);
});

test('phone (T-LINK) events never carry the terminal key', async () => {
  const { scrubSecrets } = await import('../tlink/redact.js');
  const out = scrubSecrets(`job used qtk_${'k'.repeat(43)} and x_qtk_${'m'.repeat(30)}`);
  assert.equal(out.scrubbed, true);
  assert.doesNotMatch(out.text, /qtk_/);
});

test('every shell the agent starts carries the mark (and so does anything it launches); the guard keeps it on', async () => {
  const { runShell } = await import('./index.js');
  const { touchesQ23Limits } = await import('../browser/index.js');
  const out = await runShell('node -e "console.log(process.env.QUANTESS_AGENT_SHELL)"', { cwd: os.tmpdir() });
  assert.match(String(out.data), /\b1\b/);
  for (const cmd of ['Remove-Item Env:QUANTESS_AGENT_SHELL', 'Start-Process quantess -ArgumentList login', 'quantess logout', 'cmd /c start quantess --tlink-pair']) {
    assert.equal(touchesQ23Limits(cmd), true, cmd);
  }
  assert.equal(touchesQ23Limits('node src/cli.js --help'), false);
});

test('a background job carries the agent mark too', async () => {
  const { runShell } = await import('./index.js');
  const { jobOutput, stopAllJobs } = await import('./jobs.js');
  const started = await runShell('node -e "console.log(\'mark=\' + process.env.QUANTESS_AGENT_SHELL)"', { cwd: os.tmpdir(), background: true });
  const id = started.data?.id;
  assert.ok(id, JSON.stringify(started).slice(0, 200));
  let seen = String(started.data?.output ?? '');
  for (let i = 0; i < 20 && !/mark=1/.test(seen); i += 1) seen += String((await jobOutput(id, { waitMs: 500 })).data?.output ?? '');
  await stopAllJobs?.();
  assert.match(seen, /mark=1/);
});
