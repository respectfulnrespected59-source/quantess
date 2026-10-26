import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wantsVscode, launcherFromCmd, findLauncher, gotoArgs, createVscode } from './vscode.js';

// Ported from quantus-cli test/vscode.test.js (proven 10-08), trimmed to the "show the change" half:
// Q23 does not ask before an edit, so there is no diff-before-approval preview.

// The shim VS Code installs on Windows. The hash folder changes with every release.
const shim = (exe, cli) => ['@echo off', 'setlocal', 'set VSCODE_DEV=', 'set ELECTRON_RUN_AS_NODE=1', `"%~dp0${exe}" "%~dp0${cli}" %*`, 'endlocal'].join('\r\n');
const CODE_CMD = shim('..\\Code.exe', '..\\2a59476c9b\\resources\\app\\out\\cli.js');
const INSTALL = 'C:\\Apps\\VS Code';
const LAUNCHER = { bin: 'C:\\VS\\Code.exe', pre: ['C:\\VS\\cli.js'], env: { ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' } };

function fakeSpawn(calls, { fail = false } = {}) {
  return (bin, args, opts) => {
    calls.push({ bin, args, opts });
    const child = new EventEmitter();
    child.unref = () => {};
    if (fail) queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')));
    return child;
  };
}

test("auto turns the VS Code view on only inside VS Code's own terminal", () => {
  assert.equal(wantsVscode('auto', { TERM_PROGRAM: 'vscode' }), true);
  assert.equal(wantsVscode('auto', { TERM_PROGRAM: 'WindowsTerminal' }), false);
  assert.equal(wantsVscode('auto', {}), false);
  assert.equal(wantsVscode(true, {}), true);
  assert.equal(wantsVscode(false, { TERM_PROGRAM: 'vscode' }), false);
});

test('the code.cmd shim resolves to Code.exe + cli.js, so no shell is ever involved', () => {
  const l = launcherFromCmd(CODE_CMD, `${INSTALL}\\bin\\code.cmd`);
  assert.equal(l.bin, `${INSTALL}\\Code.exe`);
  assert.deepEqual(l.pre, [`${INSTALL}\\2a59476c9b\\resources\\app\\out\\cli.js`]);
});

test('negative case: a shim pointing outside its own install folder is not trusted', () => {
  const cmd = `${INSTALL}\\bin\\code.cmd`;
  assert.equal(launcherFromCmd(shim('..\\..\\..\\evil\\Code.exe', '..\\x\\cli.js'), cmd), null);
  assert.equal(launcherFromCmd(shim('C:\\evil\\Code.exe', '..\\x\\cli.js'), cmd), null);
  assert.equal(launcherFromCmd('@echo off\r\nnode something.js %*', cmd), null);
});

const lookup = (stdout, extra = {}) =>
  findLauncher({ platform: 'win32', cwd: 'C:\\work\\repo', where: () => ({ status: 0, stdout }), read: () => CODE_CMD, exists: () => true, ...extra });

test('findLauncher uses the code.cmd that PATH finds', () => {
  assert.equal(lookup(`${INSTALL}\\bin\\code.cmd\r\n`).bin, `${INSTALL}\\Code.exe`);
});

test('negative case: a code.cmd planted in the project folder is skipped, never run', () => {
  assert.equal(lookup(`C:\\work\\repo\\code.cmd\r\n${INSTALL}\\bin\\code.cmd\r\n`).bin, `${INSTALL}\\Code.exe`);
  assert.equal(lookup('C:\\work\\repo\\tools\\code.cmd\r\n'), null);
});

test('VS Code only ever gets absolute paths, so a file named like a flag cannot become one', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'q23-vscode-')), '--install-extension');
  assert.deepEqual(gotoArgs(f, 7), ['--reuse-window', '--goto', `${f}:7`]);
  assert.throws(() => gotoArgs('--install-extension', 1), /relative/);
});

test('show() opens the file at the line in the reused window, through Code.exe directly', () => {
  const calls = [];
  const view = createVscode({ setting: true, find: () => LAUNCHER, spawnFn: fakeSpawn(calls) });
  view.show('C:\\game\\src\\gunfeel.js', 42);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, LAUNCHER.bin);
  assert.deepEqual(calls[0].args, ['C:\\VS\\cli.js', '--reuse-window', '--goto', 'C:\\game\\src\\gunfeel.js:42']);
  assert.equal(calls[0].opts.env.ELECTRON_RUN_AS_NODE, '1');
});

test('negative case: the view off (outside VS Code, or toggled off) opens nothing', () => {
  const calls = [];
  const view = createVscode({ setting: 'auto', env: {}, find: () => LAUNCHER, spawnFn: fakeSpawn(calls) });
  view.show('C:\\game\\a.js', 1);
  assert.equal(calls.length, 0);
  assert.equal(view.toggle(), true);
  view.show('C:\\game\\a.js', 1);
  assert.equal(calls.length, 1);
});

test('no VS Code found: the view says so ONCE and switches itself off, never throws', async () => {
  const problems = [];
  const view = createVscode({ setting: true, find: () => null, spawnFn: fakeSpawn([]), onProblem: (m) => problems.push(m) });
  view.show('C:\\game\\a.js', 1);
  view.show('C:\\game\\b.js', 1);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /could not find VS Code/);
  assert.equal(view.enabled, false);
});

test('a launch that fails at spawn time also turns the view off once', async () => {
  const problems = [];
  const view = createVscode({ setting: true, find: () => LAUNCHER, spawnFn: fakeSpawn([], { fail: true }), onProblem: (m) => problems.push(m) });
  view.show('C:\\game\\a.js', 1);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(view.enabled, false);
  assert.equal(problems.length, 1);
});
