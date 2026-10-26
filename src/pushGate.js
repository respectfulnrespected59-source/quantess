import fs from 'fs';
import path from 'path';
import { visibleLine } from './activity.js';

/**
 * Publishing gate: anything that could push commits or merge a PR waits for the user's y/n at the
 * terminal. "Never push" is written into the skills, but a free model once clicked a money button
 * the written rule forbade (10-13), and QUAN-TESS and QM85 deploy on push.
 *
 * It FAILS CLOSED: a command that mentions git and push anywhere (or gh and merge) is asked about,
 * however it is wrapped (cmd /c, pwsh -c, quotes, a full path to git.exe). A false alarm costs
 * the user one keypress. Scripts the command runs are read too, so write-a-script-then-run-it is
 * caught. It is still a speed bump, not a sandbox: a model set on getting round it could.
 */

let approver = null;

/** How the CLI asks the user y/n; null when nobody is at a terminal (then every publish is blocked). */
export function setPublishApprover(fn) {
  approver = fn;
}

const PUSH = [/\bgit(?:\.exe)?\b/i, /\bpush\b/i];
const MERGE = [/\bgh(?:\.exe)?\b/i, /\bmerge\b/i];
const SCRIPT = /[^\s"'`]+\.(?:ps1|bat|cmd|sh|js|mjs|cjs|py)\b/gi;
const MAX_SCRIPT_BYTES = 1_000_000;

const mentions = (text, [a, b]) => a.test(text) && b.test(text);

/** The text of any script file the command names, plus package.json scripts for npm/yarn/pnpm runs. */
function scriptsNamedIn(cmd, cwd) {
  const texts = [];
  const read = (file) => {
    try {
      const full = path.resolve(cwd, file);
      if (fs.statSync(full).size <= MAX_SCRIPT_BYTES) texts.push(fs.readFileSync(full, 'utf8'));
    } catch {
      // not a file here: nothing to read
    }
  };
  for (const file of cmd.match(SCRIPT) || []) read(file);
  if (/\b(?:npm|yarn|pnpm)(?:\.cmd)?\b/i.test(cmd)) read('package.json');
  return texts;
}

/** True when the command, or a script it runs, could push or merge. */
export function isPublishCommand(cmd, { cwd = process.cwd() } = {}) {
  const text = String(cmd ?? '');
  return [text, ...scriptsNamedIn(text, cwd)].some((t) => mentions(t, PUSH) || mentions(t, MERGE));
}

/** The terminal question for a push / merge: the exact command, every hidden character shown (security review 10-24). */
export function publishQuestion(cmd) {
  // Whole, never cut: this exact command runs. One line: a line break in it is shown, so it cannot fake a question.
  return `quantess wants to PUSH / MERGE. Run this?  ${visibleLine(cmd)}`;
}

/** Ask the user. @returns {Promise<{ allowed: boolean, how: string }>} */
export async function gatePublish(cmd) {
  if (!approver) return { allowed: false, how: 'nobody at the terminal to approve it' };
  return (await approver(cmd)) ? { allowed: true, how: 'the user said yes' } : { allowed: false, how: 'the user said no' };
}
