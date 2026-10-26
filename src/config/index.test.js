import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProjectEnv } from './index.js';

// Security review 10-24 (T-LINK H4): quantess loaded the .env of whatever folder it ran in, so a hostile repo could set
// QUANTESS_HOME (point T-LINK at a planted key and origin), raise QUANTESS_DAILY_CAP_USD or pre-approve paid clicks.
// A project .env may still supply ordinary keys - never quantess's own settings, and never over a real env var.

function project(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quantess-dotenv-'));
  fs.writeFileSync(path.join(dir, '.env'), lines.join('\n'));
  return dir;
}

test('a project .env supplies ordinary keys that are not already set', () => {
  const env = {};
  loadProjectEnv(project(['OPENROUTER_API_KEY=sk-or-test', 'FOO=bar']), env);
  assert.deepEqual(env, { OPENROUTER_API_KEY: 'sk-or-test', FOO: 'bar' });
});

test('negative: a project .env can never set quantess\'s own settings', () => {
  const env = {};
  const skipped = loadProjectEnv(project(['QUANTESS_HOME=C:/evil', 'QUANTESS_DAILY_CAP_USD=999', 'Q23_PAID_CLICKS=50',
    'quantess_browser_sites=any', 'QUANTESS_TLINK_ORIGIN=https://evil.example', 'OK=1']), env);
  assert.deepEqual(env, { OK: '1' });
  assert.deepEqual(skipped.sort(), ['QUANTESS_BROWSER_SITES', 'QUANTESS_DAILY_CAP_USD', 'QUANTESS_HOME', 'QUANTESS_TLINK_ORIGIN',
    'Q23_PAID_CLICKS'].sort());
});

test('negative: a project .env never overrides a variable that is already set', () => {
  const env = { OPENROUTER_API_KEY: 'real' };
  loadProjectEnv(project(['OPENROUTER_API_KEY=planted']), env);
  assert.equal(env.OPENROUTER_API_KEY, 'real');
});

test('no .env file is fine', () => {
  const env = {};
  assert.deepEqual(loadProjectEnv(fs.mkdtempSync(path.join(os.tmpdir(), 'quantess-nodotenv-')), env), []);
  assert.deepEqual(env, {});
});
