import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { readFile, writeFile, editFile, listFiles, grep, runShell, MAX_READ_CHARS, executeTool, toolDefinitions, shellLimitMs } from './index.js';
import { shellPlan } from './shell.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'q23-tools-'));
const CRLF_SRC = ['export function fire(gun) {', '  gun.heat += 1;', '  return gun;', '}', ''].join('\r\n');

test('edit_file: an LF anchor edits a CRLF file and the file stays all-CRLF', async () => {
  const f = path.join(tmp, 'combat.js');
  fs.writeFileSync(f, CRLF_SRC);
  const r = await editFile(f, '  gun.heat += 1;\n  return gun;', '  gun.heat += 1;\n  gun.recoil = 0.2;\n  return gun;');
  assert.equal(r.status, 'success', r.summary);
  const out = fs.readFileSync(f, 'utf8');
  assert.ok(out.includes('  gun.recoil = 0.2;\r\n'), 'new line uses CRLF');
  assert.equal(/[^\r]\n/.test(out), false, 'no bare LF anywhere');
  assert.match(r.data.lines, /3:   gun\.recoil = 0\.2;/, 'returns the numbered edited lines');
  assert.equal(r.data.line, 2, 'and the line the edit starts on, for the VS Code view');
});

test('edit_file refuses an anchor that occurs twice and changes nothing (negative)', async () => {
  const f = path.join(tmp, 'twice.js');
  fs.writeFileSync(f, 'a();\nb();\na();\n');
  const r = await editFile(f, 'a();', 'z();');
  assert.equal(r.error.code, 'NOT_UNIQUE');
  assert.equal(fs.readFileSync(f, 'utf8'), 'a();\nb();\na();\n');
});

test('edit_file still says NOT_FOUND for text that is not there (negative)', async () => {
  const f = path.join(tmp, 'combat.js');
  const r = await editFile(f, 'function reload() {', 'x');
  assert.equal(r.error.code, 'NOT_FOUND');
});

test('write_file keeps a CRLF file CRLF when the model writes LF', async () => {
  const f = path.join(tmp, 'keep.js');
  fs.writeFileSync(f, 'a\r\nb\r\n');
  const r = await writeFile(f, 'a\nb\nc\n');
  assert.equal(r.status, 'success');
  assert.deepEqual(r.data, { line: 3 }, 'content is not echoed back; only where the file first changed');
  assert.equal(fs.readFileSync(f, 'utf8'), 'a\r\nb\r\nc\r\n');
});

test('read_file hands back a big file in whole-line parts and says where to read on', async () => {
  const f = path.join(tmp, 'big.js');
  const lines = Array.from({ length: 3000 }, (_, i) => `const line${i + 1} = ${i + 1}; // padding padding`);
  fs.writeFileSync(f, lines.join('\r\n'));
  const r = await readFile(f);
  assert.ok(r.data.length <= MAX_READ_CHARS);
  assert.match(r.summary, /Read lines 1-\d+ of 3000 .*\(CRLF\)\. More: read_file with startLine \d+/);
  assert.ok(r.data.endsWith('// padding padding'), 'cut on a whole line');
  const part = await readFile(f, { startLine: 2999, endLine: 3000 });
  assert.equal(part.data, '2999: const line2999 = 2999; // padding padding\n3000: const line3000 = 3000; // padding padding');
});

test('list_files and grep skip node_modules', async () => {
  fs.mkdirSync(path.join(tmp, 'proj', 'node_modules', 'three'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'proj', 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'proj', 'node_modules', 'three', 'x.js'), 'MARKER_HIT');
  fs.writeFileSync(path.join(tmp, 'proj', 'src', 'y.js'), 'MARKER_HIT');
  const l = await listFiles('**/*.js', { cwd: path.join(tmp, 'proj') });
  assert.deepEqual(l.data.map((p) => p.replace(/\\/g, '/')), ['src/y.js']);
  const g = await grep('MARKER_HIT', { cwd: path.join(tmp, 'proj') });
  assert.equal(g.data.length, 1);
  assert.equal(g.data[0].file.replace(/\\/g, '/'), 'src/y.js');
});

test('grep reports a bad regex instead of throwing (negative)', async () => {
  const g = await grep('fire(', { cwd: tmp });
  assert.equal(g.error.code, 'BAD_REGEX');
});

test('shellPlan: pwsh gets the command base64-encoded; no pwsh falls back to cmd.exe', () => {
  const p = shellPlan('echo "hi" && ls', { platform: 'win32', pwsh: 'C:/pwsh.exe' });
  assert.equal(p.shell, false);
  const decoded = Buffer.from(p.args.at(-1), 'base64').toString('utf16le');
  assert.ok(decoded.endsWith('echo "hi" && ls'));
  assert.equal(shellPlan('dir', { platform: 'win32', pwsh: null }).name, 'cmd.exe');
  assert.equal(shellPlan('ls', { platform: 'linux' }).name, 'sh');
});

const isWin = process.platform === 'win32';

test('run_shell runs PowerShell commands and reports failures as errors', { skip: !isWin }, async () => {
  const ok = await runShell('Get-ChildItem | Select-Object -First 1 | ForEach-Object Name', { cwd: tmp });
  assert.equal(ok.status, 'success', ok.data);
  const bad = await runShell('node -e "process.exit(3)"', { cwd: tmp });
  assert.equal(bad.status, 'error');
});

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

// Killing only the shell leaves the server holding the output pipe, so the call never returns:
// the test-level timeout turns that hang into a failure.
test('run_shell timeout kills the whole tree: a server the command started lets go of its port', { skip: !isWin, timeout: 30000 }, async () => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const r = await runShell(`node -e "require('http').createServer().listen(${port}, '127.0.0.1'); setInterval(() => {}, 1000)"`,
    { cwd: tmp, timeout: 4000 });
  assert.equal(r.error.code, 'TIMEOUT');
  let free = false;
  for (let i = 0; i < 20 && !free; i++) {
    free = await portFree(port);
    if (!free) await new Promise((res) => setTimeout(res, 250));
  }
  assert.ok(free, `port ${port} is free after the timeout`);
});

test('read_file numbers its lines so the model never has to count them', async () => {
  const f = path.join(tmp, 'input.js');
  fs.writeFileSync(f, ['// input', 'let scheme = 1;', 'export function setScheme(next) {', '  scheme = next;', '}'].join('\r\n'));
  const r = await readFile(f);
  assert.match(r.data, /^3: export function setScheme\(next\) \{$/m);
});

test('read_file past the end says how long the file is (negative)', async () => {
  const f = path.join(tmp, 'input.js');
  const r = await readFile(f, { startLine: 1600 });
  assert.equal(r.status, 'error');
  assert.match(r.summary, /has 5 lines/);
});

test('edit_file accepts an anchor copied WITH the line-number prefixes', async () => {
  const f = path.join(tmp, 'input.js');
  const r = await editFile(f, '3: export function setScheme(next) {\n4:   scheme = next;',
    '3: export function setScheme(next) {\n4:   scheme = next;\n5:   save(next);');
  assert.equal(r.status, 'success', r.summary);
  const out = fs.readFileSync(f, 'utf8');
  assert.ok(out.includes('  scheme = next;\r\n  save(next);\r\n}'), 'prefixes stripped from both strings');
  assert.equal(/\d+: /.test(out), false, 'no prefix written into the code');
});

test('grep says which folder it searched when it finds nothing', async () => {
  const g = await grep('NOTHING_HERE_XYZ', { cwd: path.join(tmp, 'proj') });
  assert.ok(g.summary.includes(path.join(tmp, 'proj')), g.summary);
});

test('run_shell refuses a command too long for one Windows command line, and says what to do', { skip: !isWin }, async () => {
  const r = await runShell('Write-Output "' + 'x'.repeat(20000) + '"', { cwd: tmp });
  assert.equal(r.error.code, 'TOO_LONG');
  assert.match(r.summary, /write_file/);
});

test('edit_file counts LF and CRLF copies of an anchor together in a mixed file (negative)', async () => {
  const f = path.join(tmp, 'mixed.js');
  fs.writeFileSync(f, 'a();\nb();\r\na();\r\nb();\n');
  const r = await editFile(f, 'a();\nb();', 'z();');
  assert.equal(r.error.code, 'NOT_UNIQUE');
});

// 10-23: long builds died at 2 minutes, and a dev server could never be left running
test('run_shell waits 10 minutes by default and up to an hour when asked', () => {
  assert.equal(shellLimitMs(undefined), 600_000);
  assert.equal(shellLimitMs(1_800_000), 1_800_000);
  assert.equal(shellLimitMs(99_000_000), 3_600_000);
  assert.equal(shellLimitMs(5), 1000);
});

test('run_shell with background:true starts a job the model can read and stop', { timeout: 30000 }, async () => {
  const names = toolDefinitions.map((t) => t.function.name);
  assert.ok(names.includes('job_output') && names.includes('job_stop'));
  assert.ok(toolDefinitions.find((t) => t.function.name === 'run_shell').function.parameters.properties.background);
  fs.writeFileSync(path.join(tmp, 'dev.js'), "setInterval(() => {}, 1000); console.log('ready on http://localhost:5999/');\n");
  const started = await executeTool('run_shell', { cmd: 'node dev.js', cwd: tmp, background: true });
  assert.equal(started.data.running, true, started.summary);
  assert.deepEqual(started.data.urls, ['http://localhost:5999/']);
  const stopped = await executeTool('job_stop', { id: started.data.id });
  assert.equal(stopped.data.running, false);
  assert.equal((await executeTool('job_output', {})).data.jobs.find((j) => j.id === started.data.id).running, false);
});

test('negative: run_shell refuses "job_stop job1" typed as a command and points at the tool', async () => {
  const r = await runShell('job_stop job1', { cwd: tmp });
  assert.equal(r.error.code, 'IS_A_TOOL');
  assert.match(r.summary, /job_stop tool/);
  assert.equal((await runShell('  job_output', { cwd: tmp })).error.code, 'IS_A_TOOL');
});

// Live 10-24: quantess ran "Stop-Process -Id 2640 -Force" on a python it had not started (another program's encode).
// The PID is odd on purpose: Windows PIDs are multiples of 4, so if the guard ever breaks, this test still can't kill
// a real process (its first RED run executed the kill before the guard existed).
const NO_SUCH_PID = 999999999;
test('negative: run_shell refuses to stop a process, and nothing in the command runs', async () => {
  const marker = path.join(tmp, 'ran-anyway.txt');
  const r = await runShell(`Stop-Process -Id ${NO_SUCH_PID} -Force; Set-Content -LiteralPath '${marker}' x`, { cwd: tmp });
  assert.equal(r.status, 'error');
  assert.equal(r.error.code, 'KILL_REFUSED');
  assert.match(r.summary, /job_stop/);
  assert.equal(fs.existsSync(marker), false, 'the refused command never ran');
  assert.equal((await runShell(`taskkill /PID ${NO_SUCH_PID} /F`, { cwd: tmp })).error.code, 'KILL_REFUSED');
});

// Code review 10-24: the tool handed the model's raw args to screenshotPage, so a model could widen its own walls
test('negative: screenshot_page ignores a roots list from the model', { skip: process.platform !== 'win32' }, async () => {
  const r = await executeTool('screenshot_page', { url: 'file:///C:/Windows/win.ini', roots: ['C:\\Windows'] });
  assert.equal(r.status, 'error');
  assert.equal(r.error.code, 'LOCAL_ONLY');
});

// Live 10-24: "python -m http.server 8080 &" never stayed up in pwsh; three rounds lost steps to it.
test('negative: run_shell refuses a trailing & and points at background:true', async () => {
  const r = await runShell('python -m http.server 8080 &', { cwd: tmp });
  assert.equal(r.error.code, 'USE_BACKGROUND');
  assert.match(r.summary, /background:true/);
});
