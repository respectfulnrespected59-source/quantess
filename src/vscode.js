import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The VS Code view: every file Q23 writes or edits opens in the user's VS Code at the line that
 * changed, so he watches the work as it happens. Ported from quantus-cli src/vscode.js (proven
 * 10-08), keeping only the "show it" half: Q23 does not ask before an edit, so no preview diff.
 */

const { win32 } = path;
const ON = new Set([true, 'true', 'on']);
const OFF = new Set([false, 'false', 'off']);

const isInside = (child, parent, p = path) => {
  const rel = p.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !p.isAbsolute(rel);
};

/** "auto" follows the terminal: on inside VS Code's own terminal, off anywhere else. */
export function wantsVscode(setting, env = process.env) {
  if (ON.has(setting)) return true;
  if (OFF.has(setting)) return false;
  return env.TERM_PROGRAM === 'vscode';
}

/**
 * On Windows `code` is code.cmd, a shim for `Code.exe <hash>\resources\app\out\cli.js`.
 * Spawning that pair directly keeps cmd.exe, and its parsing of odd filenames, out of the path.
 * Both must sit inside the shim's own install folder, or it is not VS Code's shim.
 */
export function launcherFromCmd(cmdText, cmdPath) {
  const dir = win32.dirname(cmdPath);
  const root = win32.dirname(dir);
  const paths = [...cmdText.matchAll(/"%~dp0([^"]+)"/g)].map((m) => win32.resolve(dir, m[1]));
  if (!paths.every((p) => isInside(p, root, win32))) return null;
  const bin = paths.find((p) => /\.exe$/i.test(p));
  const cli = paths.find((p) => /cli\.js$/i.test(p));
  return bin && cli ? { bin, pre: [cli], env: { ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' } } : null;
}

// where.exe by absolute path, searching PATH only ($PATH:) from a neutral folder. A bare `where`
// looks in the current folder first, where a cloned repo could plant its own code.cmd.
function whereCodeCmd() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  return spawnSync(win32.join(root, 'System32', 'where.exe'), ['$PATH:code.cmd'], { cwd: root, encoding: 'utf8', windowsHide: true });
}

export function findLauncher({ platform = process.platform, cwd = process.cwd(), where = whereCodeCmd, read = (p) => readFileSync(p, 'utf8'), exists = existsSync } = {}) {
  if (platform !== 'win32') return { bin: 'code', pre: [], env: {} };
  const found = where();
  const candidates = found.status === 0 ? found.stdout.split(/\r?\n/).map((l) => l.trim()) : [];
  for (const cmdPath of candidates) {
    if (!cmdPath || isInside(cmdPath, cwd, win32)) continue;
    const launcher = launcherFromCmd(read(cmdPath), cmdPath);
    if (launcher && exists(launcher.bin) && exists(launcher.pre[0])) return launcher;
  }
  return null;
}

// VS Code reads a leading "-" as a flag; an absolute path can never start with one.
function absolute(p) {
  if (!path.isAbsolute(p)) throw new Error(`refusing to hand VS Code a relative path: ${p}`);
  return p;
}

export const gotoArgs = (file, line = 1) => ['--reuse-window', '--goto', `${absolute(file)}:${line}`];

/**
 * Never throws: a write that already landed must not come back to the model as an error
 * because the editor could not be reached. The first problem is reported once and the view
 * switches itself off.
 */
export function createVscode({ setting = 'auto', env = process.env, find = findLauncher, spawnFn = spawn, onProblem = () => {} } = {}) {
  let on = wantsVscode(setting, env);
  let found; // undefined = look it up on first use

  const fail = (message) => {
    if (!on) return;
    on = false;
    onProblem(`VS Code view off: ${message}`);
  };

  return {
    get enabled() {
      return on;
    },
    toggle() {
      on = !on;
      if (on && found === null) found = undefined; // look again: VS Code may have been installed since
      return on;
    },
    show(file, line = 1) {
      if (!on) return;
      try {
        if (found === undefined) found = find();
        if (!found) return fail("could not find VS Code's `code` command. Reinstall VS Code or add its bin folder to PATH.");
        const child = spawnFn(found.bin, [...found.pre, ...gotoArgs(file, line)], { env: { ...env, ...found.env }, detached: true, stdio: 'ignore', windowsHide: true });
        child.on('error', (err) => fail(err.message));
        child.unref();
      } catch (err) {
        fail(err.message);
      }
    }
  };
}
