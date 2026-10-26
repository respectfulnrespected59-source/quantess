import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startJob, jobOutput, stopJob, stopAllJobs, listJobs } from './jobs.js';

// 10-23: games and apps are built against a local server.
// A dev server never exits, so run_shell timed it out and killed it. A background job keeps it running.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quantess-jobs-'));
const script = (name, body) => {
  fs.writeFileSync(path.join(tmp, name), body);
  return `node ${name}`;
};
const SERVER = script('server.js', "const s = require('http').createServer((q, r) => r.end('hi'));\n" +
  "s.listen(0, '127.0.0.1', () => console.log('  Local: http://localhost:' + s.address().port + '/'));\n");
const BUILD_FAILS = script('build.js', "console.log('built 3 files'); process.exit(3);\n");
const SLEEPER = script('sleep.js', 'setInterval(() => {}, 1000);\n');
// Under a full parallel test run a server can take a while to print its address (startJob answers as soon as it does)
const URL_WAIT_MS = 30_000;

const portOpen = (port) => new Promise((resolve) => {
  const socket = net.connect(port, '127.0.0.1');
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});

after(() => stopAllJobs());

test('a dev server runs in the background, says where it serves, and job_stop frees its port', { timeout: 60000 }, async () => {
  const started = await startJob(SERVER, { cwd: tmp, firstLookMs: URL_WAIT_MS });
  assert.equal(started.status, 'success', started.summary);
  assert.equal(started.data.running, true);
  const [url] = started.data.urls;
  assert.match(url, /^http:\/\/localhost:\d+\/$/);
  const port = Number(new URL(url).port);
  assert.equal(await portOpen(port), true, 'the server is up while the model keeps working');

  const stopped = await stopJob(started.data.id);
  assert.equal(stopped.status, 'success');
  assert.equal(stopped.data.running, false);
  assert.equal(await portOpen(port), false, 'the whole tree was killed, the port is free');
});

test('negative: a job that fails shows as a failure with its exit code and output, and output is not repeated', { timeout: 60000 }, async () => {
  const r = await startJob(BUILD_FAILS, { cwd: tmp });
  assert.equal(r.status, 'error');
  // pwsh reports a failed script as 1, not the program's own code: what matters is that it is not 0
  assert.notEqual(r.data.exitCode, 0);
  assert.match(r.data.output, /built 3 files/);
  const again = await jobOutput(r.data.id);
  assert.equal(again.data.output, '', 'only NEW output comes back');
  assert.equal(again.data.exitCode, r.data.exitCode);
});

test('negative: an unknown job is an error; past the job limit a new one is refused', { timeout: 60000 }, async () => {
  assert.equal((await jobOutput('job999')).error.code, 'NO_SUCH_JOB');
  assert.equal((await stopJob('job999')).error.code, 'NO_SUCH_JOB');
  stopAllJobs();
  for (let i = 0; i < 5; i += 1) await startJob(SLEEPER, { cwd: tmp, firstLookMs: 100 });
  const sixth = await startJob(SLEEPER, { cwd: tmp, firstLookMs: 100 });
  assert.equal(sixth.error.code, 'TOO_MANY_JOBS');
  assert.equal(listJobs().data.jobs.filter((j) => j.running).length, 5);
  stopAllJobs();
  assert.equal(listJobs().data.jobs.filter((j) => j.running).length, 0, 'every job dies with quantess');
});

// Live 10-23: python's http.server held its "Serving on" line in a buffer, and printed [::] where screenshot_page
// needs localhost. Jobs run unbuffered, and an all-interfaces address is reported as localhost.
test('a server that prints [::] or 0.0.0.0 is reported on localhost, and output arrives unbuffered', { timeout: 60000 }, async () => {
  // One line: the job answers at the first URL, and a second console.log could land a moment later
  const cmd = script('anyhost.js', "console.log('Serving HTTP on :: port 8871 (http://[::]:8871/) also http://0.0.0.0:8872/ ... ' + " +
    'process.env.PYTHONUNBUFFERED); setInterval(() => {}, 1000);\n');
  const r = await startJob(cmd, { cwd: tmp, firstLookMs: URL_WAIT_MS });
  assert.deepEqual(r.data.urls, ['http://localhost:8871/', 'http://localhost:8872/']);
  assert.match(r.data.output, /\.\.\. 1/, 'PYTHONUNBUFFERED=1 reaches the job');
  await stopJob(r.data.id);
});

// Live 10-23: the hint "job_stop job1 when done" was run as a SHELL command, and when that failed the model
// killed every python on the PC by name. The hints now say these are tools.
test('negative: the next-step hints name job_output and job_stop as tools, never as commands to run', { timeout: 60000 }, async () => {
  const r = await startJob(SLEEPER, { cwd: tmp, firstLookMs: 100 });
  const hints = r.nextActions.join(' | ');
  assert.match(hints, /job_stop tool/);
  assert.doesNotMatch(hints, /^job_stop /m);
  await stopJob(r.data.id);
});

// Code review 10-23 (MEDIUM): a server that detaches from its launcher outlived job_stop - taskkill cannot walk
// a tree whose root has exited. The job then frees its own ports (only processes started after the job began).
test('negative: a server that detached from its launcher still dies on job_stop, and its port is freed', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const cmd = script('launcher.js', "const { spawn } = require('child_process');\n" +
    "spawn(process.execPath, ['server.js'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }).unref();\n");
  const r = await startJob(cmd, { cwd: tmp, firstLookMs: URL_WAIT_MS });
  const [url] = r.data.urls;
  assert.ok(url, r.summary);
  const port = Number(new URL(url).port);
  assert.equal(await portOpen(port), true);
  await stopJob(r.data.id);
  assert.equal(await portOpen(port), false, 'the orphaned server was stopped by its port');
});

// Push security review 10-23: the port sweep trusted the URL a job PRINTED, so it could kill another program that
// later took that port. Only the job's own tree, or a true orphan (its parent gone), is ever killed by port
test('negative: a user\'s own program on the port a job printed, with a live parent, survives job_stop', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const job = await startJob(script('liar.js', `console.log('ready on http://localhost:${port}/'); setInterval(() => {}, 1000);`), { cwd: tmp, firstLookMs: URL_WAIT_MS });
  assert.deepEqual(job.data.urls, [`http://localhost:${port}/`]);
  // Started after the job, by this test process (which stays alive): not the job's, not an orphan
  const { spawn } = await import('node:child_process');
  const theirs = spawn(process.execPath, ['-e', `require('http').createServer((q, r) => r.end('mine')).listen(${port}, '127.0.0.1')`], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 50 && !(await portOpen(port)); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await portOpen(port), true, 'the user program is up');
    await stopJob(job.data.id);
    assert.equal(await portOpen(port), true, 'the user program survived job_stop');
  } finally {
    theirs.kill();
  }
});

// Code review 10-23 (LOW): the URL scrolled out of the kept output and vanished; lost output went unmentioned
test('a chatty server keeps its URL, and the report says how much output scrolled away', { timeout: 60000 }, async () => {
  const cmd = script('chatty.js', "console.log('ready on http://localhost:5998/');\n" +
    "process.stdout.write('x'.repeat(100000) + '\\n'); setInterval(() => {}, 1000);\n");
  const r = await startJob(cmd, { cwd: tmp, firstLookMs: URL_WAIT_MS });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const later = await jobOutput(r.data.id);
  assert.deepEqual(later.data.urls, ['http://localhost:5998/']);
  // The noise can land before the first report or after it: one of the two says what scrolled away
  assert.match(`${r.data.output}${later.data.output}`, /\[\d+ earlier characters scrolled away unread\]/);
  await stopJob(r.data.id);
});

test('negative: a job killed from outside reads "killed", never "exited with code null"', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const r = await startJob(SLEEPER, { cwd: tmp, firstLookMs: 100 });
  const { spawnSync } = await import('node:child_process');
  spawnSync('taskkill', ['/PID', String(r.data.pid), '/T', '/F'], { stdio: 'ignore' });
  const later = await jobOutput(r.data.id, { waitMs: 3000 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const after = await jobOutput(r.data.id);
  assert.equal(after.data.running, false);
  assert.doesNotMatch(`${later.summary} ${after.summary}`, /code null/);
});
