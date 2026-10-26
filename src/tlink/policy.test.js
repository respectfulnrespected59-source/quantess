import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWindow, createGrant, phoneChoices, judgeRemote, MAX_GRANT_MS } from './policy.js';

// T-LINK owner decisions 10-24: the phone can always say No; it can say Yes only to a change,
// site or memory, only when the prompt was shown exactly, and only inside a window the user granted AT THE TERMINAL.
// Money (pay) and git push (publish) are No-only on the phone, always. This is enforced HERE, in the CLI, so even a
// hacked site cannot go past it.

const H = 3_600_000;
const clock = (t = 0) => { const c = { t, now: () => c.t }; return c; };

test('parseWindow reads 2h, 30m, 90 (minutes) and 1h30m; up to 12 hours', () => {
  assert.equal(parseWindow('2h'), 2 * H);
  assert.equal(parseWindow('30m'), 30 * 60_000);
  assert.equal(parseWindow('90'), 90 * 60_000);
  assert.equal(parseWindow('1h30m'), 90 * 60_000);
  assert.equal(parseWindow('12h'), MAX_GRANT_MS);
});

test('negative: parseWindow refuses zero, negative, over 12 hours and junk', () => {
  for (const bad of ['0', '0m', '-5m', '13h', '721', 'forever', '', '2d', '1.5h', undefined]) {
    assert.equal(parseWindow(bad), null, String(bad));
  }
});

test('a grant is off until allowed, runs out on its own, and can be revoked', () => {
  const c = clock();
  const grant = createGrant({ now: c.now });
  assert.equal(grant.active(), false);
  grant.allow(2 * H);
  assert.equal(grant.active(), true);
  c.t += 2 * H - 1;
  assert.equal(grant.active(), true);
  c.t += 1;
  assert.equal(grant.active(), false, 'expired');
  grant.allow(H);
  grant.revoke();
  assert.equal(grant.active(), false, 'revoked');
});

test('negative: a grant can never be longer than 12 hours', () => {
  const c = clock();
  const grant = createGrant({ now: c.now });
  grant.allow(100 * H);
  c.t += MAX_GRANT_MS;
  assert.equal(grant.active(), false);
});

test('phoneChoices: Yes only for change/site/memory, shown exactly, inside a grant', () => {
  assert.deepEqual(phoneChoices('change', { exact: true, grantActive: true }), ['yes', 'no']);
  assert.deepEqual(phoneChoices('site', { exact: true, grantActive: true }), ['yes', 'no']);
  assert.deepEqual(phoneChoices('memory', { exact: true, grantActive: true }), ['yes', 'no']);
  assert.deepEqual(phoneChoices('change', { exact: true, grantActive: false }), ['no']);
  assert.deepEqual(phoneChoices('change', { exact: false, grantActive: true }), ['no']);
  assert.deepEqual(phoneChoices('pay', { exact: true, grantActive: true }), ['no']);
  assert.deepEqual(phoneChoices('publish', { exact: true, grantActive: true }), ['no']);
  assert.deepEqual(phoneChoices('anything', { exact: true, grantActive: true }), ['no']);
});

function open(over = {}) {
  return { promptId: 'p1', sessionId: 's1', textHash: 'h1', kind: 'change', exact: true, deadline: 10_000, consumed: new Set(), ...over };
}
const msg = (over = {}) => ({ promptId: 'p1', sessionId: 's1', textHash: 'h1', answer: 'yes', ...over });

test('judgeRemote accepts a matching No any time before the deadline, and a Yes inside a grant', () => {
  const c = clock(1000);
  const grant = createGrant({ now: c.now });
  assert.deepEqual(judgeRemote(msg({ answer: 'no' }), open(), { grant, now: c.now }), { ok: true, answer: 'no' });
  grant.allow(H);
  assert.deepEqual(judgeRemote(msg(), open(), { grant, now: c.now }), { ok: true, answer: 'yes' });
});

test('negative: judgeRemote refuses Yes without a grant, on pay or publish, or on an inexact prompt', () => {
  const c = clock(1000);
  const grant = createGrant({ now: c.now });
  assert.equal(judgeRemote(msg(), open(), { grant, now: c.now }).ok, false, 'no grant');
  grant.allow(H);
  assert.equal(judgeRemote(msg(), open({ kind: 'pay' }), { grant, now: c.now }).ok, false, 'pay');
  assert.equal(judgeRemote(msg(), open({ kind: 'publish' }), { grant, now: c.now }).ok, false, 'publish');
  assert.equal(judgeRemote(msg(), open({ exact: false }), { grant, now: c.now }).ok, false, 'inexact');
});

// Review 10-24 (M1): a malformed open question must fail CLOSED, and an accepted answer is used up
test('negative: judgeRemote fails closed on a missing deadline, missing ids, or no consumed set', () => {
  const c = clock(1000);
  const grant = createGrant({ now: c.now });
  grant.allow(H);
  assert.equal(judgeRemote(msg({ answer: 'no' }), open({ deadline: undefined }), { grant, now: c.now }).ok, false, 'no deadline');
  assert.equal(judgeRemote(msg({ answer: 'no' }), open({ deadline: NaN }), { grant, now: c.now }).ok, false, 'NaN deadline');
  const blank = { answer: 'no' };
  assert.equal(judgeRemote(blank, open({ promptId: undefined, sessionId: undefined, textHash: undefined }), { grant, now: c.now }).ok,
    false, 'undefined ids on both sides do not match');
  assert.equal(judgeRemote(msg({ answer: 'no' }), open({ consumed: undefined }), { grant, now: c.now }).ok, false, 'no consumed set');
});

test('an accepted answer is used up: the same answer again is refused', () => {
  const c = clock(1000);
  const grant = createGrant({ now: c.now });
  const o = open();
  assert.equal(judgeRemote(msg({ answer: 'no' }), o, { grant, now: c.now }).ok, true);
  assert.equal(judgeRemote(msg({ answer: 'no' }), o, { grant, now: c.now }).ok, false);
});

test('negative: judgeRemote refuses "always", junk, a wrong id/session/hash, a replay, and anything after the deadline', () => {
  const c = clock(1000);
  const grant = createGrant({ now: c.now });
  grant.allow(H);
  const o = open();
  for (const bad of [msg({ answer: 'always' }), msg({ answer: 'YES' }), msg({ answer: true }), null, 'yes', {},
    msg({ promptId: 'p2' }), msg({ sessionId: 's2' }), msg({ textHash: 'h2' })]) {
    assert.equal(judgeRemote(bad, o, { grant, now: c.now }).ok, false, JSON.stringify(bad));
  }
  o.consumed.add('p1');
  assert.equal(judgeRemote(msg({ answer: 'no' }), o, { grant, now: c.now }).ok, false, 'replay');
  c.t = 10_000;
  assert.equal(judgeRemote(msg({ answer: 'no' }), open(), { grant, now: c.now }).ok, false, 'at the deadline');
});
