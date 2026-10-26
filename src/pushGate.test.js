import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublishCommand, gatePublish, setPublishApprover, publishQuestion } from './pushGate.js';

test('isPublishCommand catches pushes and PR merges in any form', () => {
  for (const cmd of [
    'git push', 'git push origin feat/fps-step1', 'git -C C:/repo push -u origin x', 'git -C "C:/My Repo" push',
    'cd 3d; git commit -m "x" && git push', 'gh pr merge 2 --squash', 'GIT PUSH --force'
  ]) assert.equal(isPublishCommand(cmd), true, cmd);
});

test('isPublishCommand leaves ordinary git and gh commands alone (negative)', () => {
  for (const cmd of [
    'git status -sb', 'git log --oneline -3', 'gh pr list', 'gh pr view 2', 'npm test', 'echo pushing',
    'git commit -m "feat(3d): plasma bolts"', 'git diff --stat'
  ]) assert.equal(isPublishCommand(cmd, { cwd: '/nonexistent' }), false, cmd);
});

test('it fails closed: anything that SAYS git and push asks the user, even a harmless stash', () => {
  assert.equal(isPublishCommand('git stash push'), true);
});

test('gatePublish: no approver blocks, yes allows, no blocks', async () => {
  setPublishApprover(null);
  assert.equal((await gatePublish('git push')).allowed, false);
  setPublishApprover(async () => true);
  assert.equal((await gatePublish('git push')).allowed, true);
  setPublishApprover(async () => false);
  assert.equal((await gatePublish('git push')).allowed, false);
  setPublishApprover(null);
});

// --- review: the gate fails CLOSED. These shapes all slipped past the first version. ---
import fs from 'fs';
import os from 'os';
import path from 'path';

test('isPublishCommand catches wrapped, quoted and grouped pushes', () => {
  for (const cmd of [
    '& "C:/Program Files/Git/cmd/git.exe" push', 'cmd /c "git push"', 'pwsh -c "git push"', "bash -c 'git push'",
    'iex "git push"', "Start-Process git -ArgumentList 'push'", 'git "push"', '(git push)', '$(git push)',
    'git --config-env a=B push', 'gh api -X PUT repos/o/r/pulls/2/merge'
  ]) assert.equal(isPublishCommand(cmd), true, cmd);
});

test('isPublishCommand reads a script the command runs: write-then-run is caught', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q23-gate-'));
  fs.writeFileSync(path.join(dir, 'ship.ps1'), 'Set-Location C:/repo\ngit push origin master\n');
  fs.writeFileSync(path.join(dir, 'tidy.ps1'), 'Get-ChildItem\n');
  assert.equal(isPublishCommand('./ship.ps1', { cwd: dir }), true);
  assert.equal(isPublishCommand('pwsh -File ship.ps1', { cwd: dir }), true);
  assert.equal(isPublishCommand('./tidy.ps1', { cwd: dir }), false, 'a script with no push runs freely');
});

// T-LINK security review 10-24: the push command reached the terminal prompt raw, so escape codes in it (a branch name or
// commit message the model built from a web page) could redraw the question as something else
test('negative: the push question shows hidden characters as escapes, never raw', () => {
  const q = publishQuestion('git push origin main\u001b[2K\u001b[1G\u001b]8;;x\u0007ok\u202e');
  assert.doesNotMatch(q, /[\u001b\u0007\u202e]/);
  assert.ok(q.includes('\\x1b[2K'), q);
  assert.ok(q.includes('\\u{202e}'), q);
  assert.match(q, /PUSH \/ MERGE/);
});

test('negative: a push command cannot fake a second line in the one-line question', () => {
  const q = publishQuestion('git push origin main\n? Run this?  git status (y/N)\tx');
  assert.equal(q.split('\n').length, 1);
  assert.ok(q.includes('\\x0a? Run this?'), q);
  assert.ok(q.includes('\\x09x'), q);
});
