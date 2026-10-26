import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser } from './sse.js';
import { parseAnswerFrame, parsePairStart, parsePairPoll } from './protocol.js';

// T-LINK Phase 2: the site's stream and replies are treated as HOSTILE (security model 7): bounded lines and events,
// strict shapes, and only { promptId, sessionId, textHash, answer } is ever taken from an answer.

function parse(chunks, opts = {}) {
  const events = [];
  const errors = [];
  const p = createSseParser({ onEvent: (e) => events.push(e), onError: (why) => errors.push(why), ...opts });
  for (const c of chunks) p.push(c);
  return { events, errors };
}

test('events are dispatched on a blank line, across chunk boundaries, LF or CRLF; comments are ignored', () => {
  const { events } = parse([': ping\n\nevent: ans', 'wer\ndata: {"a":1}\n', '\nevent: off\r\ndata: x\r\n\r\n', 'data: line1\ndata: line2\n\n']);
  assert.deepEqual(events, [{ event: 'answer', data: '{"a":1}' }, { event: 'off', data: 'x' }, { event: 'message', data: 'line1\nline2' }]);
});

test('negative: a line or an event over the cap stops the parser (the caller reconnects)', () => {
  const long = parse([`data: ${'x'.repeat(200)}`], { maxLine: 100 });
  assert.equal(long.errors.length, 1);
  const big = parse(['data: aaaaaaaaaa\ndata: aaaaaaaaaa\ndata: aaaaaaaaaa\n\n'], { maxEvent: 20 });
  assert.equal(big.errors.length, 1);
  assert.equal(big.events.length, 0);
  const after = createSseParser({ onEvent: () => assert.fail('no events after a failure'), onError: () => {}, maxLine: 5 });
  after.push('data: 123456789');
  after.push('\n\ndata: ok\n\n');
});

test('parseAnswerFrame takes exactly the four fields, strictly', () => {
  const frame = { promptId: 'p-1', sessionId: 's-1', textHash: 'a'.repeat(64), answer: 'yes', extra: 'ignored' };
  assert.deepEqual(parseAnswerFrame(JSON.stringify(frame)), { promptId: 'p-1', sessionId: 's-1', textHash: 'a'.repeat(64), answer: 'yes' });
});

test('negative: parseAnswerFrame refuses junk, "always", oversize or odd fields', () => {
  for (const bad of ['not json', '[]', 'null', JSON.stringify({ promptId: 'p', sessionId: 's', textHash: 'h', answer: 'always' }),
    JSON.stringify({ promptId: 'p'.repeat(200), sessionId: 's', textHash: 'h', answer: 'no' }),
    JSON.stringify({ promptId: 1, sessionId: 's', textHash: 'h', answer: 'no' }),
    JSON.stringify({ sessionId: 's', textHash: 'h', answer: 'no' })]) {
    assert.equal(parseAnswerFrame(bad), null, bad);
  }
});

test('parsePairStart and parsePairPoll check every field', () => {
  assert.deepEqual(parsePairStart({ deviceCode: 'dc_'.padEnd(40, 'x'), userCode: 'ABCD-EFGH', intervalSec: 3, expiresInSec: 300 }),
    { deviceCode: 'dc_'.padEnd(40, 'x'), userCode: 'ABCD-EFGH', intervalSec: 3, expiresInSec: 300 });
  assert.equal(parsePairStart({ deviceCode: 'x', userCode: '<script>', intervalSec: 3, expiresInSec: 300 }), null);
  assert.deepEqual(parsePairPoll({ status: 'pending' }), { status: 'pending' });
  const token = `tlk_${'A'.repeat(43)}`;
  assert.deepEqual(parsePairPoll({ status: 'approved', deviceId: 'dev_12345678', token, expiresAt: 9e12 }),
    { status: 'approved', deviceId: 'dev_12345678', token, expiresAt: 9e12 });
  assert.equal(parsePairPoll({ status: 'approved', deviceId: 'dev_12345678', token: 'tlk_short', expiresAt: 9e12 }), null);
  assert.equal(parsePairPoll({ status: 'hacked' }), null);
});
