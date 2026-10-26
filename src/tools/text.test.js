import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  eolOf, withEol, countOccurrences, lineAt, sliceLines, matchForEdit, excerptAround, capText, SKIP_GLOBS
} from './text.js';

const CRLF_FILE = 'const a = 1;\r\nfunction fire() {\r\n  shoot();\r\n}\r\n';

test('eolOf tells CRLF files from LF files', () => {
  assert.equal(eolOf(CRLF_FILE), 'CRLF');
  assert.equal(eolOf('a\nb\n'), 'LF');
  assert.equal(eolOf('one line'), 'LF');
});

test('withEol converts both ways without doubling carriage returns', () => {
  assert.equal(withEol('a\nb', 'CRLF'), 'a\r\nb');
  assert.equal(withEol('a\r\nb', 'CRLF'), 'a\r\nb');
  assert.equal(withEol('a\r\nb', 'LF'), 'a\nb');
});

test('matchForEdit finds an LF anchor in a CRLF file and returns CRLF strings', () => {
  const m = matchForEdit(CRLF_FILE, 'function fire() {\n  shoot();', 'function fire() {\n  shoot();\n  recoil();');
  assert.ok(m, 'an LF anchor must match the CRLF file');
  assert.equal(m.old, 'function fire() {\r\n  shoot();');
  assert.equal(m.new, 'function fire() {\r\n  shoot();\r\n  recoil();');
});

test('matchForEdit gives an exact one-line match the file line endings in the replacement', () => {
  const m = matchForEdit(CRLF_FILE, 'shoot();', 'shoot();\nrecoil();');
  assert.equal(m.old, 'shoot();');
  assert.equal(m.new, 'shoot();\r\nrecoil();');
});

test('matchForEdit leaves LF files alone', () => {
  const m = matchForEdit('a\nb\n', 'a\nb', 'a\nc');
  assert.deepEqual(m, { old: 'a\nb', new: 'a\nc' });
});

test('matchForEdit returns null when the text is not there at all (negative)', () => {
  assert.equal(matchForEdit(CRLF_FILE, 'function reload() {', 'x'), null);
});

test('countOccurrences counts non-overlapping hits', () => {
  assert.equal(countOccurrences('aaaa', 'aa'), 2);
  assert.equal(countOccurrences('abc', 'z'), 0);
  assert.equal(countOccurrences('abc', ''), 0);
});

test('lineAt and sliceLines are 1-based and clamp', () => {
  assert.equal(lineAt(CRLF_FILE, CRLF_FILE.indexOf('shoot')), 3);
  const s = sliceLines(CRLF_FILE, 2, 3);
  assert.deepEqual(s.lines, ['function fire() {', '  shoot();']);
  assert.equal(s.total, 4, 'four lines; the final newline is not a fifth');
  assert.deepEqual(sliceLines('a\nb', -4, 99).lines, ['a', 'b']);
});

test('excerptAround numbers the lines around an edit', () => {
  const out = excerptAround(CRLF_FILE, CRLF_FILE.indexOf('shoot'), 'shoot();'.length, 1);
  assert.equal(out, '2: function fire() {\n3:   shoot();\n4: }');
});

test('capText keeps short text and cuts long text with a hint', () => {
  assert.equal(capText('short', 10, 'h'), 'short');
  const cut = capText('x'.repeat(50), 10, 'narrow it');
  assert.ok(cut.startsWith('x'.repeat(10) + '\n[... cut: showed 10 of 50 chars. narrow it]'));
});

test('SKIP_GLOBS covers node_modules at any depth', () => {
  assert.ok(SKIP_GLOBS.includes('**/node_modules/**'));
});

import { numberLines, stripLineNumbers } from './text.js';

test('numberLines prefixes each line with its 1-based number', () => {
  assert.equal(numberLines(['a', '  b'], 143), '143: a\n144:   b');
});

test('stripLineNumbers removes read_file prefixes only when EVERY line has one', () => {
  assert.equal(stripLineNumbers('143: export function setScheme(next) {\n144:   scheme = next;'),
    'export function setScheme(next) {\n  scheme = next;');
  assert.equal(stripLineNumbers('const map = {\n12: 1 };'), null, 'mixed lines are real code: leave them');
  assert.equal(stripLineNumbers('plain text'), null);
});

// --- review fixes: mixed line endings, phantom last line ---
test('eolOf goes by majority: one stray CRLF does not make an LF file CRLF', () => {
  assert.equal(eolOf('a\nb\nc\r\nd\n'), 'LF');
  assert.equal(eolOf('a\r\nb\r\nc\n'), 'CRLF');
});

test('matchForEdit in a MIXED file uses the line endings where the match is', () => {
  const mixed = 'a\nb\nc\r\nd\r\n';
  assert.deepEqual(matchForEdit(mixed, 'a\nb', 'X\nY'), { old: 'a\nb', new: 'X\nY' }, 'LF region stays LF');
  assert.deepEqual(matchForEdit(mixed, 'c\nd', 'X\nY'), { old: 'c\r\nd', new: 'X\r\nY' }, 'CRLF region stays CRLF');
  assert.deepEqual(matchForEdit(mixed, 'c', 'X\nY'), { old: 'c', new: 'X\r\nY' }, 'one-line anchor takes its own line ending');
});

test('sliceLines does not count the empty "line" after a final newline', () => {
  assert.equal(sliceLines('a\r\nb\r\n').total, 2);
  assert.equal(sliceLines('a\nb').total, 2);
});

import { firstChangedLine } from './text.js';

test('firstChangedLine points at the first line that differs (ported from quantus-cli)', () => {
  assert.equal(firstChangedLine('a\nb\nc', 'a\nB\nc'), 2);
  assert.equal(firstChangedLine('', 'new file'), 1);
  assert.equal(firstChangedLine('a\r\nb', 'a\nb\nc'), 3, 'CRLF vs LF is not a change; the added line is');
  assert.equal(firstChangedLine('a\nb\nc', 'a\nb'), 2, 'lines cut from the end: land on the last survivor');
});
