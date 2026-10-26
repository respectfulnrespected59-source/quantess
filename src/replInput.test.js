import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReplInput } from './replInput.js';

// Live 10-24: " /tlink allow-yes 1h" (a leading space) missed the command check and went to the model as a task; the
// model then CLAIMED the window was granted. A line that is a command must never reach the model.

test('a command is a command whatever the spacing around it', () => {
  assert.deepEqual(parseReplInput(' /tlink allow-yes 1h'), { kind: 'command', cmd: 'tlink', args: ['allow-yes', '1h'] });
  assert.deepEqual(parseReplInput('/tlink   allow-yes\t 1h  '), { kind: 'command', cmd: 'tlink', args: ['allow-yes', '1h'] });
  assert.deepEqual(parseReplInput('\t/help'), { kind: 'command', cmd: 'help', args: [] });
});

test('a task is a task, trimmed', () => {
  assert.deepEqual(parseReplInput('  build the landing page  '), { kind: 'task', text: 'build the landing page' });
  assert.deepEqual(parseReplInput('run echo hello / world'), { kind: 'task', text: 'run echo hello / world' });
});

test('negative: blank input is nothing - never an empty task for the model', () => {
  assert.deepEqual(parseReplInput('   '), { kind: 'empty' });
  assert.deepEqual(parseReplInput(''), { kind: 'empty' });
  assert.deepEqual(parseReplInput(undefined), { kind: 'empty' });
});

test('negative: a bare slash is a command with no name, not a task', () => {
  assert.deepEqual(parseReplInput(' / '), { kind: 'command', cmd: '', args: [] });
});
