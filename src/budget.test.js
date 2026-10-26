import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requestExtras, book, spentToday, dailyCapUsd, chainUnderCap, isFreeModel } from './budget.js';

// 10-23: paid Nemotron Lightning runs the jobs and Nemotron Super-VL reads images. Paid models need REAL cost (OpenRouter's
// usage.cost - the old price table called any unlisted model $0) and a daily cap that falls back to free.

const tmpLedger = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quantess-ledger-')), 'ledger.json');
const day = (iso) => () => new Date(iso);

test('every call asks OpenRouter for the real cost', () => {
  for (const m of ['nvidia/nemotron-3.5-lightning', 'cohere/north-mini-code:free', 'deepseek/deepseek-v4-flash']) {
    assert.deepEqual(requestExtras(m).usage, { include: true });
  }
});

test('Nemotron runs with reasoning OFF (it returns an empty reply otherwise); Ultra keeps it on, hidden', () => {
  assert.deepEqual(requestExtras('nvidia/nemotron-3.5-lightning').reasoning, { enabled: false });
  assert.deepEqual(requestExtras('nvidia/nemotron-3.5-super-vl').reasoning, { enabled: false });
  assert.deepEqual(requestExtras('nvidia/nemotron-3.5-lightning:free').reasoning, { enabled: false });
  assert.deepEqual(requestExtras('nvidia/nemotron-3-ultra-550b-a55b').reasoning, { enabled: true, exclude: true });
  assert.equal(requestExtras('cohere/north-mini-code:free').reasoning, undefined);
});

test('the ledger books real spend per UTC day and adds up', () => {
  const file = tmpLedger();
  const now = day('2026-10-23T20:00:00Z');
  assert.equal(spentToday({ file, now }), 0);
  book(0.0123, { file, now });
  book(0.0004, { file, now });
  book(0, { file, now });
  assert.equal(spentToday({ file, now }), 0.0127);
  assert.equal(spentToday({ file, now: day('2026-10-24T01:00:00Z') }), 0, 'a new day starts at $0');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))), ['2026-10-23']);
});

test('negative: an unreadable ledger never blocks work and never throws', () => {
  const file = tmpLedger();
  fs.writeFileSync(file, '{not json');
  assert.equal(spentToday({ file, now: day('2026-10-23T00:00:00Z') }), 0);
  assert.doesNotThrow(() => book(0.01, { file, now: day('2026-10-23T00:00:00Z') }));
  assert.equal(spentToday({ file, now: day('2026-10-23T00:00:00Z') }), 0.01);
});

test('the daily cap comes from QUANTESS_DAILY_CAP_USD, else the default; junk falls back to the default', () => {
  assert.equal(dailyCapUsd({ QUANTESS_DAILY_CAP_USD: '12.5' }, 5), 12.5);
  assert.equal(dailyCapUsd({}, 5), 5);
  assert.equal(dailyCapUsd({ QUANTESS_DAILY_CAP_USD: 'lots' }, 5), 5);
  assert.equal(dailyCapUsd({ QUANTESS_DAILY_CAP_USD: '-3' }, 5), 5);
});

test('under the cap the chain is untouched; at the cap only free models run, in order', () => {
  const chain = { model: 'nvidia/nemotron-3.5-lightning', fallbacks: ['nvidia/nemotron-3.5-super-vl', 'cohere/north-mini-code:free', 'dots-studio/dots-3-note-preview:free'] };
  assert.deepEqual(chainUnderCap(chain, { spent: 1, cap: 5 }), { ...chain, capped: false });
  assert.deepEqual(chainUnderCap(chain, { spent: 5, cap: 5 }), {
    model: 'cohere/north-mini-code:free',
    fallbacks: ['dots-studio/dots-3-note-preview:free'],
    capped: true
  });
});

test('negative: at the cap with no free model in the chain, the free safety net is used, never a paid one', () => {
  const got = chainUnderCap({ model: 'nvidia/nemotron-3.5-lightning', fallbacks: [] }, { spent: 9, cap: 5, freeNet: ['nvidia/nemotron-3.5-lightning:free'] });
  assert.equal(got.model, 'nvidia/nemotron-3.5-lightning:free');
  assert.ok(isFreeModel(got.model));
  assert.equal(got.capped, true);
});

// Security review of 4d1cc19: a command that sets USERPROFILE for a `quantess login` it runs must not move the key file
test('quantessHome follows QUANTESS_HOME, else the account home - never a USERPROFILE override', async () => {
  const { quantessHome } = await import('./budget.js');
  const os = await import('node:os');
  const path = await import('node:path');
  assert.equal(quantessHome({ QUANTESS_HOME: '/x/q' }), '/x/q');
  const before = process.env.USERPROFILE;
  try {
    process.env.USERPROFILE = path.join(os.tmpdir(), 'fake-profile');
    assert.equal(quantessHome({}), path.join(os.userInfo().homedir, '.quantess'));
    assert.notEqual(quantessHome({}), path.join(process.env.USERPROFILE, '.quantess'));
  } finally {
    if (before === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = before;
  }
});
