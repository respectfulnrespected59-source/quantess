import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventLog, CAPS } from './events.js';
import { describePrompt, hashText } from './describe.js';
import { forPhone } from './redact.js';

// T-LINK: what the phone sees. Only the summary lines the user already sees in the
// terminal leave the PC - never a tool's data - redacted and capped; the queue is bounded so it can never grow forever.

const HOME = 'C:\\Users\\riley';
const env = { OPENROUTER_API_KEY: 'sk-or-v1-0123456789abcdef0123456789abcdef' };
const redact = (text, opts) => forPhone(text, { ...opts, home: HOME, env });
const log = (over = {}) => createEventLog({ redact, now: () => 1000, ...over });

test('each event gets the next sequence number and a time', () => {
  const l = log();
  const a = l.turnStart('build the site');
  const b = l.step('read_file', { filepath: 'C:\\Users\\riley\\my-site\\brief.md' });
  assert.deepEqual([a.seq, b.seq], [1, 2]);
  assert.equal(b.at, 1000);
  assert.equal(b.line, 'read ~\\my-site\\brief.md');
});

test('negative: a step result carries only its summary line - never the tool data', () => {
  const l = log();
  const ev = l.stepDone('read_file', { status: 'success', summary: 'Read brief.md (59 lines)', data: 'TOP SECRET FILE BODY' });
  assert.equal(ev.line, '✓ Read brief.md (59 lines)');
  assert.doesNotMatch(JSON.stringify(ev), /TOP SECRET/);
  assert.equal(l.stepDone('x', { status: 'error', summary: 'nope' }).ok, false);
});

test('negative: secrets in a step line are scrubbed before they leave', () => {
  const ev = log().step('run_shell', { cmd: 'curl -H "x: sk-or-v1-0123456789abcdef0123456789abcdef" api' });
  assert.doesNotMatch(ev.line, /0123456789abcdef/);
});

test('a notice goes to the phone as a plain step line', () => {
  const ev = log().notice('Steps like this one now run without asking.');
  assert.equal(ev.type, 'step');
  assert.equal(ev.line, 'Steps like this one now run without asking.');
});

test('the checklist and the final answer are capped', () => {
  const l = log();
  const items = Array.from({ length: 40 }, (_, i) => ({ text: `step ${i}`, status: 'pending' }));
  const cl = l.checklist(items);
  assert.equal(cl.lines.length, CAPS.checklistItems);
  assert.equal(cl.more, 10);
  const ans = l.answer('y'.repeat(CAPS.answer + 500));
  assert.ok(ans.text.length < CAPS.answer + 30);
  assert.match(ans.text, /cut/);
});

test('spend is numbers only', () => {
  const ev = log().spend({ today: 0.5927571, cap: 5, turn: 'x' });
  assert.deepEqual({ today: ev.today, cap: ev.cap, turn: ev.turn }, { today: 0.5928, cap: 5, turn: 0 });
});

test('an open question: redacted text for the phone, the hash of the ORIGINAL text, and the policy buttons', () => {
  const l = log();
  const prompt = describePrompt('change', { text: 'edit C:\\Users\\riley\\x.js:\n- a\n+ b', complete: true });
  const { event, exact, textHash } = l.promptOpen({ promptId: 'p1', sessionId: 's1', prompt, ttlMs: 600_000, grantActive: true });
  assert.equal(exact, true);
  assert.equal(textHash, hashText(prompt.text), 'bound to what the terminal shows, before redaction');
  assert.match(event.text, /edit ~\\x\.js/);
  assert.deepEqual(event.choices, ['yes', 'no']);
  assert.equal(event.kind, 'change');
});

test('negative: a question that was cut, scrubbed, or is money/push gets only a No button', () => {
  const l = log();
  const cut = l.promptOpen({ promptId: 'p1', sessionId: 's', prompt: describePrompt('change', { text: 'write big.js', complete: false }),
    ttlMs: 1, grantActive: true });
  assert.deepEqual([cut.exact, cut.event.choices], [false, ['no']]);
  const secret = l.promptOpen({ promptId: 'p2', sessionId: 's', ttlMs: 1, grantActive: true,
    prompt: describePrompt('change', { text: 'run TOKEN=abcdefghijklmnop npm start', complete: true }) });
  assert.deepEqual([secret.exact, secret.event.choices], [false, ['no']]);
  const pay = l.promptOpen({ promptId: 'p3', sessionId: 's', ttlMs: 1, grantActive: true, prompt: describePrompt('pay', { label: 'Upscale', count: 1 }) });
  assert.deepEqual(pay.event.choices, ['no']);
  const noGrant = l.promptOpen({ promptId: 'p4', sessionId: 's', ttlMs: 1, grantActive: false,
    prompt: describePrompt('change', { text: 'run npm test', complete: true }) });
  assert.deepEqual(noGrant.event.choices, ['no']);
});

test('a closed question reports who answered and only yes / no', () => {
  const l = log();
  assert.deepEqual((({ promptId, by, answer }) => ({ promptId, by, answer }))(l.promptClosed('p1', 'phone', 'yes')),
    { promptId: 'p1', by: 'phone', answer: 'yes' });
  assert.equal(l.promptClosed('p1', 'terminal', 'always').answer, 'yes');
  assert.equal(l.promptClosed('p1', 'terminal', false).answer, 'no');
  assert.equal(l.promptClosed('p1', 'timeout', null).answer, 'no');
  assert.equal(l.promptClosed('p1', 'weird', 'x').by, 'terminal');
});

test('negative: the queue is bounded - the oldest go, and the phone is told how many', () => {
  const l = log({ queueCap: 5 });
  for (let i = 0; i < 8; i += 1) l.step('read_file', { filepath: `f${i}` });
  const batch = l.take(50);
  assert.deepEqual(batch[0].type, 'dropped');
  assert.equal(batch[0].count, 3);
  assert.equal(batch[0].seq, undefined, 'the marker has no seq: the server dedupes by seq');
  assert.equal(batch.length, 6);
  assert.equal(l.take(50).length, 0, 'taken events are gone');
});
