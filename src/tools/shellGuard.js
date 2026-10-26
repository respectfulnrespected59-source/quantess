/**
 * What run_shell refuses before a command runs.
 *
 * Live 10-24 (the Bowl & Bloom rebuild, recorded for an ad): a preview server would not come up, so quantess listed every
 * python on the PC and ran "Stop-Process -Id 2640 -Force" - a python it had NOT started (another program's encode
 * controller). Killing by NAME was already forbidden in the prompt; it killed by PID instead. A prompt rule did not hold,
 * so the shell refuses: quantess stops only its own background jobs, with the job_stop tool.
 */

// Each pattern is one way a shell command stops a process. \b keeps "skill" and "killTree" out. This catches what a model
// writes by ACCIDENT; it is defense-in-depth, not a sandbox (run_shell is a full shell: "iex" or a built-up string gets
// past any list). It may also refuse a harmless mention (grep Stop-Process); the refusal says why, so that is tolerable.
const KILL_PATTERNS = [
  /\|\s*kill\b/i,
  /(^|[\s;|&(])kill\s+\$/i,
  /\bprocess\.kill\s*\(/i,
  /\bos\.kill\s*\(/i,
  /\.terminate\s*\(/i,
  /\bfkill\b/i,
  /\bnet\s+stop\b/i,
  /\bsc(\.exe)?\s+stop\b/i,
  /\bStop-Process\b/i,
  /\bspps\b/i,
  /\btaskkill(\.exe)?\b/i,
  /\btskill\b/i,
  /\bpkill\b/i,
  /\bkillall\b/i,
  /\bkill-port\b/i,
  /\bfuser\s+(-\w+\s+)*-k\b/i,
  /\bStop-Service\b/i,
  /\bwmic\b.*\bprocess\b.*\b(delete|terminate)\b/i,
  /\bInvoke-CimMethod\b.*\bTerminate\b/i,
  /\.Kill\s*\(/i,
  // pwsh's kill alias / unix kill: a pid, a signal, or -Id / -Name after it
  /(^|[\s;|&(])kill\s+(-\w+\s+)*(-?\d+|-Id\b|-Name\b|-InputObject\b)/i
];

/**
 * @param {string} cmd
 * @returns {string|null} the part of the command that stops a process, or null
 */
export function processKill(cmd) {
  const text = String(cmd ?? '');
  for (const re of KILL_PATTERNS) {
    const m = re.exec(text);
    if (m) return m[0].trim().slice(0, 80);   // a .* pattern can span a long command; the refusal quotes a short piece
  }
  return null;
}

/**
 * A bash-style trailing & ("python -m http.server 8080 &"). In pwsh it starts a PowerShell job that dies the moment
 * run_shell's pwsh exits, so the server never stays up (live 10-24: every round lost steps to it). Not &&, and the
 * pwsh call operator only ever starts a line.
 * @param {string} cmd
 * @returns {boolean}
 */
export function backgroundAmpersand(cmd) {
  const text = String(cmd ?? '').trimEnd();
  return text.endsWith('&') && !text.endsWith('&&');
}
