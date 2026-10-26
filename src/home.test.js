import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateHome } from './home.js';

// One home: quantessq23 kept sessions in ~/.q23, quantus kept memories and a spend ledger in ~/.quantus. quantess
// copies them into ~/.quantess once, never overwrites what it has, and never touches the old folders.

function rig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quantess-home-mig-'));
  const dirs = { home: path.join(root, '.quantess'), q23: path.join(root, '.q23'), quantus: path.join(root, '.quantus') };
  fs.mkdirSync(path.join(dirs.q23, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dirs.q23, 'sessions', 'abc.md'), '# session abc');
  fs.mkdirSync(path.join(dirs.quantus, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dirs.quantus, 'memory', 'grill-me.md'), '---\nname: grill-me\ndescription: "ask first"\ntype: lesson\n---\n\nAsk 3-7 questions first.\n');
  fs.writeFileSync(path.join(dirs.quantus, 'memory', 'MEMORY.md'), '# QUANTUS memory\n');
  fs.writeFileSync(path.join(dirs.quantus, 'ledger.json'), JSON.stringify({ '2026-09-15': 13.5, '2026-10-23': 0.5 }));
  fs.mkdirSync(path.join(dirs.home, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dirs.home, 'ledger.json'), JSON.stringify({ '2026-10-23': 0.25 }));
  return dirs;
}

test('sessions, memories and spend come over once into the quantess home', () => {
  const dirs = rig();
  const r = migrateHome(dirs);
  assert.deepEqual({ sessions: r.sessions, memories: r.memories, ledgerDays: r.ledgerDays }, { sessions: 1, memories: 1, ledgerDays: 2 });
  assert.equal(fs.readFileSync(path.join(dirs.home, 'sessions', 'abc.md'), 'utf8'), '# session abc');
  assert.ok(fs.existsSync(path.join(dirs.home, 'memory', 'grill-me.md')));
  assert.match(fs.readFileSync(path.join(dirs.home, 'memory', 'MEMORY.md'), 'utf8'), /grill-me/, 'the index is rebuilt for quantess');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dirs.home, 'ledger.json'), 'utf8')), { '2026-09-15': 13.5, '2026-10-23': 0.75 }, 'same-day spend adds up');
  assert.equal(migrateHome(dirs), null, 'the second run does nothing');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dirs.home, 'ledger.json'), 'utf8'))['2026-10-23'], 0.75, 'never counted twice');
});

test('negative: what quantess already has is never overwritten, and the old folders are left as they were', () => {
  const dirs = rig();
  fs.writeFileSync(path.join(dirs.home, 'memory', 'grill-me.md'), '---\nname: grill-me\ntype: lesson\n---\n\nquantess own version\n');
  migrateHome(dirs);
  assert.match(fs.readFileSync(path.join(dirs.home, 'memory', 'grill-me.md'), 'utf8'), /quantess own version/);
  assert.ok(fs.existsSync(path.join(dirs.q23, 'sessions', 'abc.md')));
  assert.ok(fs.existsSync(path.join(dirs.quantus, 'memory', 'grill-me.md')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dirs.quantus, 'ledger.json'), 'utf8')), { '2026-09-15': 13.5, '2026-10-23': 0.5 });
});

test('negative: with no old folders there is nothing to do and nothing breaks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quantess-home-empty-'));
  const r = migrateHome({ home: path.join(root, '.quantess'), q23: path.join(root, '.q23'), quantus: path.join(root, '.quantus') });
  assert.deepEqual({ sessions: r.sessions, memories: r.memories, ledgerDays: r.ledgerDays }, { sessions: 0, memories: 0, ledgerDays: 0 });
});

test('quantess keeps its sessions in its own home now', async () => {
  const { sessionDir } = await import('./session/index.js');
  assert.equal(sessionDir({ QUANTESS_HOME: path.join('X:', 'h') }), path.join('X:', 'h', 'sessions'));
  assert.equal(sessionDir({ Q23_SESSION_DIR: path.join('X:', 'old') }), path.join('X:', 'old'), 'an explicit folder still wins');
});

// Code review 10-23: the marker was written last, so a crash after the spend merge re-added it on the next start
test('negative: a migration that dies part way never adds the old spend twice', () => {
  const dirs = rig();
  fs.rmSync(path.join(dirs.home, 'ledger.json'));
  fs.mkdirSync(path.join(dirs.home, 'ledger.json'));
  assert.throws(() => migrateHome(dirs));
  assert.equal(migrateHome(dirs), null, 'the marker was already claimed: nothing runs twice');
});
