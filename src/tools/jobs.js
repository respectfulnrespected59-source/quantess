// Background jobs: a dev server, a watcher or a long build keeps running while the model works on (10-23:
// games and apps are built against a local server). A server never
// exits, so plain run_shell timed it out and killed it. Every job dies with quantess (stopAllJobs on exit).
import { spawn, spawnSync } from 'child_process';
import { shellPlan, rigPwsh, killTree } from './shell.js';
import { toolResult } from './result.js';
import { AGENT_SHELL_MARK } from '../flags.js';
import { capText } from './text.js';

const MAX_JOBS = 5;
// Newest output kept per job; older output scrolls away like a terminal's
const KEEP_CHARS = 64_000;
const MAX_REPORT_CHARS = 12_000;
// Long enough for a dev server to print its address on a busy PC (it answers the moment one appears), short
// enough not to stall the turn when a job prints nothing
const FIRST_LOOK_MS = 10_000;
const MAX_WAIT_MS = 60_000;
const STOP_GRACE_MS = 3000;
const SWEEP_TIMEOUT_MS = 15_000;
// Processes started this long before the job are never the job's own
const START_SLACK_MS = 1000;
const POLL_MS = 100;
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1?\]|0\.0\.0\.0):\d+[^\s'"<>)]*/g;
// "Listening on all interfaces" - reachable here as localhost, which is what screenshot_page takes
const ANY_HOST = /\/\/(?:0\.0\.0\.0|\[::\])(?=:)/;
// A URL split across two output chunks is still found
const URL_OVERLAP = 200;

const jobs = new Map();
let nextId = 1;

const isRunning = (job) => !job.exit && !job.stopped;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function append(job, text) {
  // Code review 10-23: a chatty server scrolled its "Listening on" line out of the kept output, URL and all
  for (const url of `${job.out.slice(-URL_OVERLAP)}${text}`.match(LOCAL_URL) ?? []) {
    const local = url.replace(ANY_HOST, '//localhost');
    if (!job.urls.includes(local)) job.urls.push(local);
  }
  job.out = (job.out + text).slice(-KEEP_CHARS);
  job.total += text.length;
}

/** Output since the last report (as much as is still kept), and how much of it scrolled away unread. */
function takeUnread(job) {
  const unread = job.total - job.read;
  const fresh = Math.min(unread, job.out.length);
  job.read = job.total;
  return { text: fresh > 0 ? job.out.slice(-fresh) : '', lost: unread - Math.max(fresh, 0) };
}

async function waitFor(job, ms, done) {
  const deadline = Date.now() + Math.min(Math.max(0, Number(ms) || 0), MAX_WAIT_MS);
  while (isRunning(job) && !done(job) && Date.now() < deadline) await sleep(POLL_MS);
}

function stateOf(job) {
  if (job.stopped) return 'stopped';
  if (!job.exit) return 'running';
  if (job.exit.code === null) return `was killed${job.exit.signal ? ` (${job.exit.signal})` : ''}`;
  return `exited with code ${job.exit.code}`;
}

function report(job, lead) {
  const { text, lost } = takeUnread(job);
  const scrolled = lost > 0 ? `[${lost} earlier characters scrolled away unread]\n` : '';
  const output = capText(scrolled + text, MAX_REPORT_CHARS, 'Only the newest output is kept; job_output again for more.');
  const urls = [...job.urls];
  const failed = Boolean(job.exit) && job.exit.code !== 0 && !job.stopped;
  return toolResult({
    status: failed ? 'error' : 'success',
    summary: `${lead} ${job.id} (${stateOf(job)})${urls.length ? `, serving ${urls.join(' ')}` : ''}: ${job.cmd}`,
    // Worded as TOOLS: live 10-23 the model ran "job_stop job1" in the shell, then killed every python by name
    nextActions: isRunning(job)
      ? [`keep working; call the job_output tool (id "${job.id}") to read new output`,
        urls.length ? `screenshot_page ${urls[0]}` : `call the job_output tool (id "${job.id}") to see when it is ready`,
        `call the job_stop tool (id "${job.id}") when done - a tool, not a shell command`]
      : ['read the output'],
    artifacts: urls,
    data: { id: job.id, pid: job.child.pid, running: isRunning(job), exitCode: job.exit?.code ?? null, urls, output },
    ...(failed ? { error: { code: job.exit.code ?? 'KILLED' } } : {})
  });
}

const noSuchJob = (id) => toolResult({
  status: 'error',
  summary: `No job ${JSON.stringify(id)}. job_output with no id lists the jobs.`,
  nextActions: ['job_output with no id'],
  error: { code: 'NO_SUCH_JOB' }
});

/**
 * Kill what a stopped job left behind. taskkill /T cannot walk a tree whose root already exited (a launcher
 * that detached its server, or a shell killed as it started its child), but orphans keep their parent's id, and
 * a server keeps its port. Only processes started after the job began are touched, so nothing of the user's.
 * Synchronous, so it also works at exit.
 */
function sweepOrphans(stopped) {
  if (process.platform !== 'win32' || stopped.length === 0) return;
  const list = stopped.map((job) => ({
    pid: job.child.pid ?? 0,
    since: job.started - START_SLACK_MS,
    ports: job.urls.map((url) => Number(new URL(url).port)).filter(Boolean)
  }));
  // Only numbers go into the script, so the JSON cannot break out of its quotes
  const script = `$jobs = ConvertFrom-Json '${JSON.stringify(list)}'; $all = Get-CimInstance Win32_Process; ` +
    '$kill = [System.Collections.Generic.HashSet[int]]::new(); ' +
    'foreach ($j in @($jobs)) { $since = [DateTimeOffset]::FromUnixTimeMilliseconds($j.since).LocalDateTime; ' +
    '$queue = [System.Collections.Generic.Queue[int]]::new(); $queue.Enqueue([int]$j.pid); ' +
    'while ($queue.Count) { $p = $queue.Dequeue(); foreach ($c in $all) { ' +
    'if ($c.ParentProcessId -eq $p -and $c.CreationDate -ge $since -and $kill.Add([int]$c.ProcessId)) { $queue.Enqueue([int]$c.ProcessId) } } }; ' +
    // A port owner outside the job's tree is killed only as a true orphan (its parent is gone): a URL the job
    // PRINTED is not proof the program on that port is the job's (push security review 10-23)
    'foreach ($port in @($j.ports)) { Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | ForEach-Object { ' +
    '$ownerId = [int]$_.OwningProcess; $owner = $all | Where-Object { $_.ProcessId -eq $ownerId } | Select-Object -First 1; ' +
    '$parentAlive = $owner -and @($all | Where-Object { $_.ProcessId -eq $owner.ParentProcessId }).Count -gt 0; ' +
    'if ($owner -and $owner.CreationDate -ge $since -and -not $parentAlive) { [void]$kill.Add($ownerId) } } } }; ' +
    'foreach ($id in $kill) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }';
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { stdio: 'ignore', timeout: SWEEP_TIMEOUT_MS, windowsHide: true });
}

/** An orphan holding the job's pipes would keep quantess itself from exiting: let go of them. */
function releasePipes(job) {
  job.child.stdout?.destroy();
  job.child.stderr?.destroy();
}

/**
 * Start a command in the background and answer once it prints a local URL, exits, or firstLookMs passes.
 * @param {string} cmd
 * @param {{ cwd?: string, firstLookMs?: number }} [options]
 */
export async function startJob(cmd, { cwd = process.cwd(), firstLookMs = FIRST_LOOK_MS } = {}) {
  const running = [...jobs.values()].filter(isRunning);
  if (running.length >= MAX_JOBS) {
    return toolResult({
      status: 'error',
      summary: `${MAX_JOBS} jobs are already running (${running.map((j) => j.id).join(', ')}). Stop one first.`,
      nextActions: ['job_stop a job you no longer need'],
      error: { code: 'TOO_MANY_JOBS' }
    });
  }
  const plan = shellPlan(cmd, { pwsh: rigPwsh() });
  const started = Date.now();
  let child;
  try {
    // Unbuffered: python's http.server otherwise holds its "Serving on" line until the buffer fills
    // The agent's mark rides along: whatever this job starts can never run `quantess login` (src/flags.js)
    child = spawn(plan.exe, plan.args, { cwd, shell: plan.shell, windowsHide: true, env: { ...process.env, PYTHONUNBUFFERED: '1', [AGENT_SHELL_MARK]: '1' } });
  } catch (err) {
    return toolResult({ status: 'error', summary: `Failed to start: ${err.message}`, nextActions: ['check the cwd exists'], error: { code: err.code } });
  }
  const job = { id: `job${nextId++}`, cmd: String(cmd), cwd, child, started, out: '', urls: [], total: 0, read: 0, exit: null, stopped: false };
  jobs.set(job.id, job);
  // Decoded as a stream: a character split across two chunks stays whole
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (data) => append(job, data));
  child.stderr.on('data', (data) => append(job, data));
  child.on('close', (code, signal) => { job.exit ??= { code, signal }; });
  child.on('error', (err) => {
    append(job, `[failed to start: ${err.message}]\n`);
    job.exit ??= { code: err.code ?? -1, signal: null };
  });
  await waitFor(job, firstLookMs, (j) => j.urls.length > 0);
  return report(job, 'Started');
}

/**
 * New output from a job (waiting up to waitMs for some), or the list of jobs when no id is given.
 * @param {string} [id]
 * @param {{ waitMs?: number }} [options]
 */
export async function jobOutput(id, { waitMs = 0 } = {}) {
  if (!id) return listJobs();
  const job = jobs.get(id);
  if (!job) return noSuchJob(id);
  await waitFor(job, waitMs, (j) => j.total > j.read);
  return report(job, 'Job');
}

/** Stop a job, everything it started, and anything it left holding its port. */
export async function stopJob(id) {
  const job = jobs.get(id);
  if (!job) return noSuchJob(id);
  if (isRunning(job)) {
    killTree(job.child);
    job.stopped = true;
    const deadline = Date.now() + STOP_GRACE_MS;
    while (!job.exit && Date.now() < deadline) await sleep(POLL_MS);
    if (!job.exit || job.urls.length > 0) sweepOrphans([job]);
    releasePipes(job);
  }
  return report(job, 'Stopped');
}

/** Every job, running or not. */
export function listJobs() {
  const list = [...jobs.values()].map((job) => ({ id: job.id, cmd: job.cmd, running: isRunning(job), exitCode: job.exit?.code ?? null, urls: [...job.urls] }));
  return toolResult({
    status: 'success',
    summary: list.length ? `${list.filter((j) => j.running).length} of ${list.length} job(s) running` : 'No background jobs',
    nextActions: ['job_output <id> to read one'],
    data: { jobs: list }
  });
}

/** Synchronous, so it works in process.on('exit'): kill every running job's whole tree and what it left behind. */
export function stopAllJobs() {
  const stopping = [...jobs.values()].filter(isRunning);
  for (const job of stopping) {
    killTree(job.child);
    job.stopped = true;
  }
  sweepOrphans(stopping);
  stopping.forEach(releasePipes);
}
