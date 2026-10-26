import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTlink, tlinkCheck } from './cliLink.js';
import { writePairing } from './store.js';
import { startFakeSite } from '../fixtures/tlinkSite.js';

// T-LINK Phase 2: the glue quantess uses - off unless this PC is paired, the hooks that feed the phone, the /tlink
// commands, and one real round trip: a question goes to the (fake) site and the phone's No comes back and closes it.

const until = async (cond, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const fast = { flushMs: 10, backoffMs: [10, 40], idleMs: 2000, settleMs: 50 };

async function paired() {
  const site = await startFakeSite();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tlink-link-')), 'tlink.json');
  writePairing({ origin: site.origin, deviceId: 'dev_test0001', token: site.state.token, expiresAt: Date.now() + 86_400_000 },
    { file, restrict: () => true });
  return { site, file };
}

/** Terminal askers that wait for an answer or for the phone to close them. */
function waitingAsk() {
  const make = () => (...args) => new Promise((resolve) => {
    args.at(-1)?.signal?.addEventListener('abort', () => resolve(undefined), { once: true });
  });
  return { pay: make(), publish: make(), change: make(), remember: make(), site: make() };
}

test('not paired, or --no-tlink: there is no T-LINK at all', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tlink-none-')), 'tlink.json');
  assert.equal(startTlink({ file, interactive: true, ask: waitingAsk(), sessionId: () => 's1', print: () => {} }), null);
  assert.equal(startTlink({ enabled: false, file, interactive: true, ask: waitingAsk(), sessionId: () => 's1', print: () => {} }), null);
});

test('the hooks feed the site; /tlink shows the masked key, never the key itself', async (t) => {
  const { site, file } = await paired();
  const link = startTlink({ file, interactive: true, ask: waitingAsk(), sessionId: () => 's1', print: () => {}, clientOptions: fast });
  t.after(async () => { link.stop(); await site.close(); });
  link.hooks.turnStart('build the site');
  link.hooks.toolStart('read_file', { filepath: 'brief.md' });
  link.hooks.toolEnd('todo_write', { status: 'success', summary: 'Plan updated', data: { items: [{ text: 'one', status: 'done' }] } });
  link.hooks.answer('Done.');
  await until(() => site.events().length >= 5);
  assert.deepEqual(site.events().map((e) => e.type), ['turn', 'step', 'result', 'checklist', 'answer']);
  const status = link.command([]).join('\n');
  assert.match(status, /tlk_…TTTT/);
  assert.ok(!status.includes(site.state.token));
});

test('/tlink allow-yes and revoke-yes set the window the phone can say Yes in', async (t) => {
  const { site, file } = await paired();
  const link = startTlink({ file, interactive: true, ask: waitingAsk(), sessionId: () => 's1', print: () => {}, clientOptions: fast });
  t.after(async () => { link.stop(); await site.close(); });
  assert.match(link.command(['allow-yes', '2h']).join('\n'), /2h 0m/);
  assert.match(link.command([]).join('\n'), /phone Yes: on/);
  link.command(['revoke-yes']);
  assert.match(link.command([]).join('\n'), /phone Yes: off/);
  assert.match(link.command(['allow-yes', '3 days']).join('\n'), /allow-yes 2h/, 'a bad window explains itself');
});

test('end to end: a question goes to the site, the phone says No, and the terminal question closes', async (t) => {
  const { site, file } = await paired();
  const printed = [];
  const link = startTlink({ file, interactive: true, ask: waitingAsk(), sessionId: () => 's1', print: (l) => printed.push(l), clientOptions: fast });
  t.after(async () => { link.stop(); await site.close(); });
  await until(() => site.state.streams.size === 1 && link.status().status === 'on');
  const pending = link.askers.change('run_shell', 'run npm test', { complete: true });
  await until(() => site.events().some((e) => e.type === 'prompt_open'));
  const open = site.events().find((e) => e.type === 'prompt_open');
  assert.deepEqual(open.choices, ['no']);
  site.send('answer', { promptId: open.promptId, sessionId: open.sessionId, textHash: open.textHash, answer: 'no' });
  assert.equal(await pending, 'no');
  assert.match(printed.join('\n'), /from your phone: No/);
  await until(() => site.events().some((e) => e.type === 'prompt_closed'));
});

test('end to end: Always at the keyboard tells the terminal and the site that steps like it stop asking', async (t) => {
  const { site, file } = await paired();
  const printed = [];
  const ask = { ...waitingAsk(), change: async () => 'always' };
  const link = startTlink({ file, interactive: true, ask, sessionId: () => 's1', print: (l) => printed.push(l), clientOptions: fast });
  t.after(async () => { link.stop(); await site.close(); });
  await until(() => site.state.streams.size === 1 && link.status().status === 'on');
  assert.equal(await link.askers.change('run_shell', 'run npm test', { complete: true }), 'always');
  assert.match(printed.join('\n'), /\[T-LINK\] Always picked at the keyboard/);
  await until(() => site.events().some((e) => e.type === 'step' && /without asking/.test(e.line)));
});

test('a second quantess window takes the phone link: this one prints one plain line and stays off', async (t) => {
  const { site, file } = await paired();
  const printed = [];
  const link = startTlink({ file, interactive: true, ask: waitingAsk(), sessionId: () => 's1', print: (l) => printed.push(l), clientOptions: fast });
  t.after(async () => { link.stop(); await site.close(); });
  await until(() => site.state.streams.size === 1 && link.status().status === 'on');
  site.send('off', { reason: 'replaced' });
  await until(() => link.status().status === 'stopped');
  assert.deepEqual(printed, ['[T-LINK off: another quantess window on this PC took over your phone link (/tlink on takes it back)]']);
});

test('negative: without a terminal (a scripted run) T-LINK only watches - nothing can be approved from the phone', async (t) => {
  const { site, file } = await paired();
  const link = startTlink({ file, interactive: false, ask: waitingAsk(), sessionId: () => 's1', print: () => {}, clientOptions: fast });
  t.after(async () => { link.stop(); await site.close(); });
  assert.equal(link.askers, null);
});

test('/tlink off stops it; /tlink on starts it again', async (t) => {
  const { site, file } = await paired();
  const link = startTlink({ file, interactive: true, ask: waitingAsk(), sessionId: () => 's1', print: () => {}, clientOptions: fast });
  t.after(async () => { link.stop(); await site.close(); });
  await until(() => link.status().status === 'on');
  link.command(['off']);
  assert.equal(link.status().status, 'stopped');
  link.command(['on']);
  await until(() => link.status().status === 'on');
});

// --- Phase 2 reviews ---
test('negative: a hook that fails never throws into the job', async (t) => {
  const { site, file } = await paired();
  const link = startTlink({ file, interactive: true, ask: waitingAsk(), sessionId: () => 's1', print: () => {}, clientOptions: fast });
  t.after(async () => { link.stop(); await site.close(); });
  const hostile = { get filepath() { throw new Error('boom'); } };
  assert.doesNotThrow(() => link.hooks.toolStart('read_file', hostile));
  assert.doesNotThrow(() => link.hooks.toolEnd('todo_write', { status: 'success', get data() { throw new Error('boom'); } }));
  assert.doesNotThrow(() => link.hooks.spend(null));
});

test('a normal exit or /tlink off prints no "T-LINK off" line; /tlink on when already on says so', async (t) => {
  const { site, file } = await paired();
  const printed = [];
  const link = startTlink({ file, interactive: true, ask: waitingAsk(), sessionId: () => 's1', print: (l) => printed.push(l), clientOptions: fast });
  t.after(async () => { link.stop(); await site.close(); });
  await until(() => link.status().status === 'on');
  assert.match(link.command(['on']).join('\n'), /already on/);
  link.command(['off']);
  link.stop();
  assert.ok(!printed.some((l) => /T-LINK off/.test(l)), printed.join('\n'));
});

test('tlinkCheck (for --doctor): unpaired is fine, a known PC is OK, a forgotten one is FAIL, unreachable is WARN', () => {
  assert.equal(tlinkCheck(null, null).level, 'ok');
  assert.equal(tlinkCheck({ deviceId: 'dev_x', token: `tlk_${'a'.repeat(43)}` }, { status: 200 }).level, 'ok');
  const gone = tlinkCheck({ deviceId: 'dev_x', token: `tlk_${'a'.repeat(43)}` }, { status: 401 });
  assert.equal(gone.level, 'fail');
  assert.match(gone.detail, /--tlink-pair/);
  assert.equal(tlinkCheck({ deviceId: 'dev_x', token: `tlk_${'a'.repeat(43)}` }, { error: 'ECONNREFUSED' }).level, 'warn');
});
