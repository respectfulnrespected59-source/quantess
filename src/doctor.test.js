import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkKey, checkLibrary, checkProfile, checkProvider, exitCode, isSignedIn } from './doctor.js';

test('isSignedIn reads the live page: a Sign out button means signed in', () => {
  assert.equal(isSignedIn('- link "Profile" [ref=e1]\n- button "Sign out" [ref=e2] [cursor=pointer]'), true);
  assert.equal(isSignedIn('- button "Sign in" [ref=e2]\n- link "Sign out of the newsletter"'), false);
  assert.equal(isSignedIn(undefined), false);
});

test('checkKey fails without a key and never echoes the key back', () => {
  assert.equal(checkKey(undefined).level, 'fail');
  assert.equal(checkKey('not-a-key').level, 'fail');
  const ok = checkKey('sk-or-v1-secret123');
  assert.equal(ok.level, 'ok');
  assert.ok(!JSON.stringify(ok).includes('secret123'));
});

test('checkLibrary goes red on an empty library: no skills, no memory, no takeover routine', () => {
  const levels = Object.fromEntries(checkLibrary([], '/empty/memory', { owner: true }).map((c) => [c.label, c.level]));
  assert.equal(levels.skills, 'fail');
  assert.equal(levels.memory, 'fail');
  assert.equal(levels['q23-takeover'], 'fail');
});

test('checkLibrary passes a library that has skills, memory and the takeover routine', () => {
  const library = [
    { kind: 'skill', name: 'q23-takeover' },
    { kind: 'skill', name: 'glossy-pdf' },
    { kind: 'memory', name: 'MEMORY' },
    { kind: 'agent', name: 'planner' },
    { kind: 'rule', name: 'rules/common/testing' }
  ];
  assert.ok(checkLibrary(library, '/m', { owner: true }).every((c) => c.level === 'ok'));
});

// A public install has no owner brief and may have no Claude Code library at all: that is normal, never a FAIL
test('checkLibrary on a public install: an empty library is fine (optional), and there is no takeover check', () => {
  const checks = checkLibrary([], '/empty/memory', { owner: false });
  assert.ok(checks.every((c) => c.level === 'ok'), JSON.stringify(checks));
  assert.ok(!checks.some((c) => c.label === 'q23-takeover'));
  assert.match(checks.find((c) => c.label === 'skills').detail, /none \(optional/);
  const found = checkLibrary([{ kind: 'skill', name: 'x' }], '/m', { owner: false }).find((c) => c.label === 'skills');
  assert.equal(found.detail, '1 found');
});

test('checkProfile warns until the user has signed in to Q23\'s own profile, and names the fix', () => {
  const empty = checkProfile({ dir: 'C:\\p\\q23-chrome', source: 'q23' }, false);
  assert.equal(empty.level, 'warn');
  assert.match(empty.detail, /--signin/);
  assert.equal(checkProfile({ dir: 'C:\\p\\q23-chrome', source: 'q23' }, true).level, 'ok');
  assert.equal(checkProfile({ dir: 'C:\\p\\mcp-chrome-abc', source: 'claude' }, true).level, 'ok');
});

test('exitCode is 1 when any check fails, 0 for warnings only', () => {
  assert.equal(exitCode([{ level: 'ok' }, { level: 'warn' }]), 0);
  assert.equal(exitCode([{ level: 'ok' }, { level: 'fail' }]), 1);
});

import { checkShell } from './doctor.js';

test('checkShell: pwsh that answers = OK with its version', () => {
  const c = checkShell('C:/pwsh.exe', { status: 'success', data: '7.5.4\r\n' });
  assert.equal(c.level, 'ok');
  assert.match(c.detail, /7\.5\.4/);
});

test('checkShell: no pwsh = WARN with the install command (Q23 falls back to cmd.exe)', () => {
  const c = checkShell(null, null);
  assert.equal(c.level, 'warn');
  assert.match(c.detail, /winget install Microsoft\.PowerShell/);
});

test('checkShell: pwsh found but a command fails = FAIL (negative)', () => {
  const c = checkShell('C:/pwsh.exe', { status: 'error', summary: 'Failed to spawn: ENOENT' });
  assert.equal(c.level, 'fail');
});

// Plug-in tool servers: the doctor starts each one and counts its tools, like it opens Chrome for real
test('checkMcp: none set up is fine; a broken entry or server warns; a working one counts its tools', async () => {
  const { checkMcp } = await import('./doctor.js');
  assert.equal(checkMcp({ servers: [], problems: [] }, null).level, 'ok');
  assert.match(checkMcp({ servers: [], problems: [] }, null).detail, /none set up/);
  const broken = checkMcp({ servers: [], problems: ['server "x": needs a command'] }, null);
  assert.equal(broken.level, 'warn');
  assert.match(broken.detail, /needs a command/);
  const working = checkMcp({ servers: [{ name: 'echo' }], problems: [] }, { tools: [{}, {}], problems: [] });
  assert.equal(working.level, 'ok');
  assert.match(working.detail, /2 tools from echo/);
});

// Hosted mode: the doctor asks the site who this terminal is; a free plan or a dead key is a FAIL, with the reason
test('checkProvider: direct is the key check; hosted is what the site answers; neither says to sign in', () => {
  assert.equal(checkProvider({ mode: 'direct', apiKey: 'sk-or-v1-x' }).level, 'ok');
  assert.equal(checkProvider({ mode: 'direct', apiKey: undefined }).level, 'fail');
  const paid = checkProvider({ mode: 'hosted' }, { ok: true, name: 'Riley', plan: 'pro', masked: 'qtk_…abcd' });
  assert.equal(paid.level, 'ok');
  assert.match(paid.detail, /pro plan/);
  assert.ok(!paid.detail.includes('qtk_' + 'a'.repeat(43)));
  const free = checkProvider({ mode: 'hosted' }, { ok: true, name: 'Bo', plan: 'free', masked: 'qtk_…abcd' });
  assert.equal(free.level, 'fail');
  assert.match(free.detail, /Creator, Pro or Studio/);
  const dead = checkProvider({ mode: 'hosted' }, { ok: false, signedIn: true, why: 'This terminal key no longer works.' });
  assert.equal(dead.level, 'fail');
  assert.match(dead.detail, /no longer works/);
  const none = checkProvider({ mode: 'none' });
  assert.equal(none.level, 'fail');
  assert.match(none.detail, /quantess login/);
});
