import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

// Transcripts used to land in ./sessions of whatever folder Q23 ran in. Inside a game repo that is a
// folder `git add -A` commits, and on 09-28 Q23 read a previous run's transcript there as if it were a fact.
const STORE = mkdtempSync(join(tmpdir(), 'q23-sessions-'));
process.env.Q23_SESSION_DIR = STORE;
// Load the module the way the user starts Q23: from inside a game repo
const GAME = mkdtempSync(join(tmpdir(), 'q23-game-'));
const startedIn = process.cwd();
process.chdir(GAME);
const { sessionDir, createSession, appendToSession, listSessions } = await import('./index.js');
process.chdir(startedIn);

// 10-23: one home - the old ~/.q23/sessions are copied into ~/.quantess/sessions once (home.js)
test('transcripts live in ~/.quantess/sessions by default, wherever quantess is started', () => {
  assert.equal(sessionDir({}), join(homedir(), '.quantess', 'sessions'));
  assert.equal(sessionDir({ Q23_SESSION_DIR: 'D:\\q23\\sessions' }), 'D:\\q23\\sessions');
});

test('a new session is written to the store and listed from it', () => {
  const { sessionId, filePath } = createSession();
  appendToSession(sessionId, 'user', 'make the boost last longer');
  assert.ok(filePath.startsWith(STORE), filePath);
  assert.ok(listSessions().includes(sessionId));
});

test('negative case: starting Q23 in a game folder creates no ./sessions there', () => {
  createSession();
  assert.equal(existsSync(join(GAME, 'sessions')), false);
  assert.deepEqual(readdirSync(GAME), []);
});
