import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 10-23: one call name, plain 'quantess'. One command; the old names still work and say so once.
const SRC = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(SRC);

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return e.name.endsWith('.js') && !e.name.endsWith('.test.js') ? [full] : [];
  });
}

test('negative: nothing the user or the model reads calls the tool "Q23" any more', () => {
  const offenders = [];
  for (const file of sourceFiles(SRC)) {
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (/^\s*(\/\/|\/?\*)/.test(line)) return;
      // Q23_* setting names stay as they are, so nothing the user already set breaks
      // "\nQ23" in source has no word boundary before the Q (the n of \n is a letter): check it too
      if (/(\bQ23|\\nQ23)\b(?!_)/.test(line)) offenders.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(offenders, []);
});

// The old names live only in copies that carry bin/ (the public copy has neither the files nor the entries)
const LEGACY = fs.existsSync(path.join(ROOT, 'bin'));
const OLD_NAMES = ['quantus', 'quantessq23', 'q23'];

test('quantess is the command; quantus, quantessq23 and q23 are aliases of it where bin/ exists', () => {
  const { bin } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(bin.quantess, 'src/cli.js');
  for (const old of OLD_NAMES) assert.equal(bin[old], LEGACY ? `bin/${old}.js` : undefined, old);
});

const run = (script) => spawnSync(process.execPath, [script, '--version'], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });

test('an old name runs quantess and says so once, on stderr', { skip: !LEGACY && 'no old names in this copy' }, () => {
  for (const old of OLD_NAMES) {
    const r = run(path.join(ROOT, 'bin', `${old}.js`));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^quantess \d+\.\d+\.\d+/);
    assert.match(r.stderr, new RegExp(`${old} is now quantess`));
    assert.equal(r.stderr.trim().split(/\r?\n/).length, 1, 'one line, never a wall of text');
  }
});

test('negative: quantess itself prints no alias notice', () => {
  const r = run(path.join(SRC, 'cli.js'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^quantess \d+\.\d+\.\d+/);
  assert.equal(r.stderr, '');
});
