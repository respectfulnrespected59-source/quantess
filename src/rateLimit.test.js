import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimitKind, rateLimitWaitMs, RATE_LIMIT_WAITS_MS, MAX_RATE_LIMIT_WAIT_MS } from './rateLimit.js';

// The real messages OpenRouter sent on 10-14, as the OpenAI SDK words them
const BUSY_MODEL = '429 Rate limit exceeded: cohere/north-mini-code-20260617/d3a1. High demand for cohere/north-mini-code:free on OpenRouter - limited to 15 requests per minute. Please retry shortly.';
const FREE_MINUTE = '429 Rate limit exceeded: free-models-per-min. ';
const FREE_DAY = '429 Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day';
const NOW = 1_800_000_000_000;

const rateLimited = (message, extra = {}) => Object.assign(new Error(message), { status: 429, ...extra });

test('rateLimitKind tells one busy model from a spent free allowance', () => {
  assert.equal(rateLimitKind(rateLimited(BUSY_MODEL)), 'model');
  assert.equal(rateLimitKind(rateLimited(FREE_MINUTE)), 'free-minute');
  assert.equal(rateLimitKind(rateLimited(FREE_DAY)), 'free-daily');
});

test('rateLimitKind ignores errors that are not rate limits', () => {
  assert.equal(rateLimitKind(Object.assign(new Error('503 overloaded'), { status: 503 })), null);
  // No status means it never came from the API, whatever the text says
  assert.equal(rateLimitKind(new Error(FREE_MINUTE)), null);
  assert.equal(rateLimitKind(undefined), null);
});

test('rateLimitWaitMs waits until OpenRouter says the minute resets', () => {
  const err = rateLimited(FREE_MINUTE, { error: { metadata: { headers: { 'X-RateLimit-Reset': String(NOW + 17_000) } } } });
  assert.equal(rateLimitWaitMs(err, 0, NOW), 18_000);
});

test('rateLimitWaitMs reads a reset given in seconds, and retry-after', () => {
  const inSeconds = rateLimited(FREE_MINUTE, { headers: { 'x-ratelimit-reset': String(NOW / 1000 + 9) } });
  assert.equal(rateLimitWaitMs(inSeconds, 0, NOW), 10_000);
  assert.equal(rateLimitWaitMs(rateLimited(FREE_MINUTE, { headers: { 'retry-after': '12' } }), 0, NOW), 12_000);
});

test('rateLimitWaitMs backs off on a schedule when the server names no time', () => {
  const waits = RATE_LIMIT_WAITS_MS.map((_, attempt) => rateLimitWaitMs(rateLimited(FREE_MINUTE), attempt, NOW));
  assert.deepEqual(waits, [...RATE_LIMIT_WAITS_MS]);
  const stale = rateLimited(FREE_MINUTE, { headers: { 'x-ratelimit-reset': String(NOW - 5_000) } });
  assert.equal(rateLimitWaitMs(stale, 0, NOW), RATE_LIMIT_WAITS_MS[0]);
});

test('rateLimitWaitMs never parks Q23 for longer than a minute and change', () => {
  const farOff = rateLimited(FREE_MINUTE, { headers: { 'retry-after': '3600' } });
  assert.equal(rateLimitWaitMs(farOff, 0, NOW), MAX_RATE_LIMIT_WAIT_MS);
  assert.ok(MAX_RATE_LIMIT_WAIT_MS <= 65_000);
});
