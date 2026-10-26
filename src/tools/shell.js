import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

/**
 * Which shell run_shell uses. Most installs are Windows and the models write PowerShell (and some
 * Unix) commands, which cmd.exe rejects: "'ls' is not recognized" ran through the Q23 logs.
 * PowerShell 7 (pwsh) runs those, supports &&, and with -OutputFormat Text prints plain errors.
 * Windows PowerShell 5.1 is skipped on purpose: it wraps every error in CLIXML and has no &&.
 */

/**
 * Find an executable on PATH. lstat, not exists: the Microsoft Store pwsh is an app alias
 * that fs.existsSync reports as missing (EACCES on stat).
 * @returns {string|null} full path, or null
 */
export function findOnPath(exe, envPath = process.env.PATH || '') {
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, exe);
    try {
      fs.lstatSync(candidate);
      return candidate;
    } catch {
      // not in this PATH entry; keep looking
    }
  }
  return null;
}

// Plain text out: no progress records, no ANSI colour codes, UTF-8 so non-ASCII text survives.
const PWSH_PRELUDE = "$ProgressPreference='SilentlyContinue'; if ($PSStyle) { $PSStyle.OutputRendering='PlainText' }; " +
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ';

/**
 * How to launch `cmd`: { exe, args, shell } for child_process.spawn, plus `name` for the model.
 * The command goes to pwsh base64-encoded, so no quote in it can be mangled on the way.
 */
export function shellPlan(cmd, { platform = process.platform, pwsh = null } = {}) {
  if (platform !== 'win32') return { name: 'sh', exe: cmd, args: [], shell: true };
  if (!pwsh) return { name: 'cmd.exe', exe: cmd, args: [], shell: true };
  const encoded = Buffer.from(PWSH_PRELUDE + cmd, 'utf16le').toString('base64');
  return {
    name: 'PowerShell 7 (pwsh)',
    exe: pwsh,
    args: ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', encoded],
    shell: false
  };
}

/** The pwsh this PC has, looked up once. Q23_SHELL=cmd forces cmd.exe (a PC where pwsh misbehaves). */
let resolved;
export function rigPwsh() {
  if (resolved === undefined) {
    resolved = process.platform === 'win32' && process.env.Q23_SHELL !== 'cmd' ? findOnPath('pwsh.exe') : null;
  }
  return resolved;
}

/** The shell name run_shell will use on this PC, for the tool description. */
export function rigShellName() {
  return shellPlan('', { pwsh: rigPwsh() }).name;
}

const TASKKILL_TIMEOUT_MS = 5000;

/**
 * Stop a command and everything it started. Killing only the shell leaves a probe's node and
 * Chromium alive, still holding their port, so the next run fails or "passes" silently.
 */
export function killTree(child) {
  if (process.platform === 'win32' && child.pid) {
    // A hung taskkill must not hang quantess's own exit (stopAllJobs runs in process.on('exit'))
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: TASKKILL_TIMEOUT_MS });
  } else {
    child.kill('SIGKILL');
  }
}
