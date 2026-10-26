import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Who the agent is and who is typing. 10-19: the agent sent the person at the keyboard to "reach out to" someone
// else, because its tool messages spoke of the owner in the third person. Pins: the prompt says who is typing, and
// the public brief names the agent and talks to the user as "you". (The owner's own brief: src/ownerBrief.test.js.)
const SRC = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(SRC);
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'q23-identity-')));
process.env.OPENROUTER_API_KEY ||= 'sk-or-test-not-a-real-key';
const publicBrief = () => fs.readFileSync(path.join(ROOT, 'BRIEF.md'), 'utf8');

test('the public brief names the agent QUANTESS and talks to the user as "you", naming nobody else', () => {
  assert.match(publicBrief(), /You are \*\*QUANTESS\*\*/);
  assert.match(publicBrief(), /Talk to them as "you"/);
  assert.doesNotMatch(publicBrief(), /\bQ23\b|QMM|Quantum Melanin/);
});

test('the base prompt names who is typing: QUANTESS_USER_NAME when set, a neutral default otherwise', async () => {
  const { Agent } = await import('./agent.js');
  delete process.env.QUANTESS_USER_NAME;
  assert.match(new Agent({ browser: false }).getDefaultSystemPrompt(), /The person typing to you is the person who runs this terminal/);
  process.env.QUANTESS_USER_NAME = 'Jordan';
  try {
    assert.match(new Agent({ browser: false }).getDefaultSystemPrompt(), /The person typing to you is Jordan: talk to them as "you"/);
  } finally {
    delete process.env.QUANTESS_USER_NAME;
  }
});

test('loadBrief: the owner brief when it is there, else the public brief; neither is a warning, not a crash', async () => {
  const { loadBrief } = await import('./brief.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q23-brief-'));
  const owner = path.join(dir, 'owner.md');
  const pub = path.join(dir, 'public.md');
  fs.writeFileSync(pub, 'public brief');
  const warnings = [];
  const warn = (w) => warnings.push(w);
  assert.equal(loadBrief({ owner, pub, warn, ownerInstall: false }), 'public brief', 'no owner brief: the public one');
  assert.deepEqual(warnings, [], 'on a public install a missing owner brief is normal');
  assert.equal(loadBrief({ owner, pub, warn, ownerInstall: true }), 'public brief');
  assert.match(warnings.join('\n'), /brief not loaded: ENOENT/, 'on the owner install it is said out loud');
  warnings.length = 0;
  fs.writeFileSync(owner, 'owner brief');
  assert.equal(loadBrief({ owner, pub, warn, ownerInstall: true }), 'owner brief', 'the owner brief wins');
  assert.deepEqual(warnings, []);
  assert.equal(loadBrief({ owner: path.join(dir, 'none1'), pub: path.join(dir, 'none2'), warn, ownerInstall: false }), '');
  assert.match(warnings.join('\n'), /BRIEF\.md is missing/);
});

test('isOwnerInstall: the owner brief or the takeover routine marks it; neither is a public install', async () => {
  const { isOwnerInstall } = await import('./brief.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q23-owner-'));
  const brief = path.join(dir, 'QMM.md');
  const mark = path.join(dir, 'SKILL.md');
  assert.equal(isOwnerInstall({ brief, mark }), false);
  fs.writeFileSync(mark, 'x');
  assert.equal(isOwnerInstall({ brief, mark }), true, 'the brief lost, the routine still there: still the owner');
});
