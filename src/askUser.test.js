import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import prompts from 'prompts';
import { createAskers } from './askUser.js';

// T-LINK Phase 1: the five y/n questions moved out of cli.js. Today's behavior is pinned first (default no, Ctrl-C at
// a question stops the whole job), then the new part: a question the PHONE answered is closed without quitting.

const plain = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, '');

/** A stand-in for prompts(): answers with `answer`, or cancels like Ctrl-C when answer === 'CTRL_C'. */
function fakePrompts(answer) {
  const seen = [];
  const fn = async (question, { onCancel } = {}) => {
    seen.push(question);
    if (answer === 'CTRL_C') {
      onCancel?.();
      return {};
    }
    return { [question.name]: answer };
  };
  fn.seen = seen;
  return fn;
}

function harness(answer) {
  const calls = { quit: [], spin: [] };
  const spinner = { stop: () => calls.spin.push('stop'), start: () => calls.spin.push('start') };
  const p = fakePrompts(answer);
  const ask = createAskers({ prompts: p, quit: async (code) => { calls.quit.push(code); }, spinner: () => spinner });
  return { ask, calls, seen: p.seen };
}

test('pay and publish: a yes is true, anything else false; the question says what will happen', async () => {
  let h = harness(true);
  assert.equal(await h.ask.pay('Upscale 2x', { count: 2 }), true);
  assert.match(plain(h.seen[0].message), /click "Upscale 2x" AGAIN.*#2/);
  assert.equal(h.seen[0].initial, false, 'default no');
  h = harness(undefined);
  assert.equal(await h.ask.publish('git push origin main'), false);
  assert.match(plain(h.seen[0].message), /PUSH \/ MERGE.*git push origin main/);
});

test('change and site: the chosen value comes back; no answer is "no"; "always" only for a step shown whole', async () => {
  let h = harness('always');
  assert.equal(await h.ask.change('run_shell', 'run this command:\nnpm test', { complete: true }), 'always');
  assert.deepEqual(h.seen[0].choices.map((c) => c.value), ['yes', 'always', 'no']);
  h = harness(undefined);
  assert.equal(await h.ask.change('write_file', 'write big.js', { complete: false }), 'no');
  assert.deepEqual(h.seen[0].choices.map((c) => c.value), ['yes', 'no']);
  h = harness('yes');
  assert.equal(await h.ask.site('example.com', 'https://example.com/x'), 'yes');
  assert.match(plain(h.seen[0].message), /new site: example\.com/);
});

test('remember: shows the whole memory; a memory that cannot be previewed is refused without asking', async () => {
  let h = harness(true);
  assert.equal(await h.ask.remember({ name: 'push-policy', type: 'feedback', description: 'pushing', content: 'Never push.' }), true);
  assert.match(plain(h.seen[0].message), /\[feedback\] push-policy - pushing\n  Never push\./);
  h = harness(true);
  assert.equal(await h.ask.remember({ name: '../bad name', type: 'nope' }), false);
  assert.equal(h.seen.length, 0);
});

test('the spinner stops for the question and starts again after', async () => {
  const h = harness(true);
  await h.ask.pay('x');
  assert.deepEqual(h.calls.spin, ['stop', 'start']);
});

test('negative: Ctrl-C at any question stops the whole job (quit 130), as today', async () => {
  for (const kind of ['pay', 'publish', 'site']) {
    const h = harness('CTRL_C');
    await (kind === 'site' ? h.ask.site('a.com', 'https://a.com') : h.ask[kind]('x'));
    assert.deepEqual(h.calls.quit, [130], kind);
  }
  const h = harness('CTRL_C');
  await h.ask.change('run_shell', 'run x');
  assert.deepEqual(h.calls.quit, [130]);
});

test('negative: a question the phone answered is closed - it never quits quantess', async () => {
  const calls = { quit: [] };
  // prompts() as it really behaves: the element renders (onRender, this = the element), and abort() rejects -> onCancel
  const p = (question, { onCancel }) => new Promise((resolve) => {
    const element = { abort() { onCancel(); resolve({}); } };
    question.onRender.call(element);
  });
  const ask = createAskers({ prompts: p, quit: async (code) => { calls.quit.push(code); }, spinner: () => null });
  const stop = new AbortController();
  const pending = ask.change('run_shell', 'run npm test', { signal: stop.signal });
  stop.abort();
  assert.equal(await pending, 'no');
  assert.deepEqual(calls.quit, []);
});

test('negative: the phone answering before the question even rendered still closes it, never quits', async () => {
  const calls = { quit: [] };
  const p = (question, { onCancel }) => new Promise((resolve) => {
    // the element appears only after the abort already happened
    setImmediate(() => question.onRender.call({ abort() { onCancel(); resolve({}); } }));
  });
  const ask = createAskers({ prompts: p, quit: async (code) => { calls.quit.push(code); }, spinner: () => null });
  const stop = new AbortController();
  const pending = ask.pay('Upscale', { signal: stop.signal });
  stop.abort();
  assert.equal(await pending, false);
  assert.deepEqual(calls.quit, []);
});

test('the real prompts library: an aborted question settles and does not quit (pins prompts 2.4.2 internals)', async () => {
  const stdin = new PassThrough();
  const out = [];
  const stdout = new Writable({ write(chunk, _e, cb) { out.push(String(chunk)); cb(); } });
  const quits = [];
  const real = (question, opts) => prompts({ ...question, stdin, stdout }, opts);
  const ask = createAskers({ prompts: real, quit: async (code) => { quits.push(code); }, spinner: () => null });
  const stop = new AbortController();
  const pending = ask.publish('git push origin main', { signal: stop.signal });
  await new Promise((r) => setTimeout(r, 30));
  stop.abort();
  assert.equal(await pending, false);
  assert.deepEqual(quits, []);
  assert.match(plain(out.join('')), /PUSH \/ MERGE/);
});
