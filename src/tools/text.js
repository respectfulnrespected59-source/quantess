/**
 * Pure text helpers for the file tools, kept apart so they can be tested without a disk.
 */

/** Folders no search should walk: a game repo's node_modules alone is tens of thousands of files. */
export const SKIP_DIRS = ['node_modules', '.git', 'dist', 'sessions'];

/** Glob ignore patterns for SKIP_DIRS at any depth. */
export const SKIP_GLOBS = SKIP_DIRS.map((d) => `**/${d}/**`);

/**
 * 'CRLF' when most line endings are Windows ones, else 'LF'. By majority, so one stray CRLF
 * does not turn a rewrite of an LF file into a whole-file diff. No newline at all counts as LF.
 */
export function eolOf(text) {
  const crlf = (String(text).match(/\r\n/g) || []).length;
  const lf = (String(text).match(/\n/g) || []).length - crlf;
  return crlf > lf ? 'CRLF' : 'LF';
}

/** Rewrite every line ending in `text` to `eol` ('CRLF' or 'LF'). */
export function withEol(text, eol) {
  const lf = String(text).replace(/\r\n/g, '\n');
  return eol === 'CRLF' ? lf.replace(/\n/g, '\r\n') : lf;
}

/** How many times `needle` occurs in `text` (non-overlapping). */
export function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) count++;
  return count;
}

/** 1-based line number of a character index. */
export function lineAt(text, index) {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) line++;
  return line;
}

/**
 * Lines `start`..`end` (1-based, inclusive) of `text`, without their line endings.
 * A final newline does not make an extra empty line. Out-of-range bounds are clamped.
 */
export function sliceLines(text, start = 1, end = Infinity) {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const from = Math.max(1, Math.trunc(start) || 1);
  const to = Math.min(lines.length, Math.trunc(end) || lines.length);
  return { lines: lines.slice(from - 1, to), from, to, total: lines.length };
}

/** Lines as read_file shows them: `143: text`, numbered from `from`. */
export function numberLines(lines, from = 1) {
  return lines.map((l, i) => `${from + i}: ${l}`).join('\n');
}

const LINE_PREFIX = /^\d+: ?/;

/**
 * A model often copies read_file's `143: ` prefixes into an edit. Strip them, but only when
 * EVERY line carries one; otherwise it is real code (`12: 1 };` in an object) and stays.
 * @returns {string|null} the text without prefixes, or null when it is not a numbered copy
 */
export function stripLineNumbers(text) {
  const lines = String(text).split(/\r?\n/);
  if (!lines.every((l) => LINE_PREFIX.test(l))) return null;
  return lines.map((l) => l.replace(LINE_PREFIX, '')).join('\n');
}

/** The line ending in force where a span sits: inside it if it spans lines, else at its line's end. */
function eolAround(content, index, length) {
  const span = content.slice(index, index + length);
  if (span.includes('\r\n')) return 'CRLF';
  if (span.includes('\n')) return 'LF';
  const nl = content.indexOf('\n', index + length);
  if (nl === -1) return eolOf(content);
  return content[nl - 1] === '\r' ? 'CRLF' : 'LF';
}

/** The forms an anchor can take in a file: as written, with CRLF, with LF. */
export function anchorVariants(oldString) {
  return [...new Set([oldString, withEol(oldString, 'CRLF'), withEol(oldString, 'LF')])];
}

/**
 * Find `oldString` in `content` the way a model means it: exactly, or with the line endings
 * the file actually uses (free models always write LF; many Windows files are CRLF). The replacement
 * takes the line endings of the place it lands, so even a mixed file never gets them mixed further.
 * @returns {{ old: string, new: string } | null} the strings to splice with, or null if absent
 */
export function matchForEdit(content, oldString, newString) {
  for (const old of anchorVariants(oldString)) {
    const at = content.indexOf(old);
    if (at !== -1) return { old, new: withEol(newString, eolAround(content, at, old.length)) };
  }
  return null;
}

/** Lines around a span of text, numbered, so the model can see what an edit produced. */
export function excerptAround(text, index, length, context = 3) {
  const first = lineAt(text, index);
  const last = lineAt(text, index + Math.max(0, length - 1));
  const { lines, from } = sliceLines(text, first - context, last + context);
  return numberLines(lines, from);
}

/** The first line that differs (1-based); line endings don't count. Lines cut from the end: the last survivor. */
export function firstChangedLine(before, after) {
  const was = String(before).split(/\r?\n/);
  const now = String(after).split(/\r?\n/);
  const i = now.findIndex((line, n) => line !== was[n]);
  return i === -1 ? Math.max(1, now.length) : i + 1;
}

/** Cut a long string to `max` chars with a note saying how much was dropped and how to narrow it. */
export function capText(text, max, hint) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n[... cut: showed ${max} of ${s.length} chars. ${hint}]`;
}
