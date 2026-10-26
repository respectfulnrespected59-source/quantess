import test from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { hostedStop, isTooLarge } from './errors.js';

// The proxy's refusals arrive as OpenAI SDK errors carrying the site's code (server/cli/proxy.ts on the site).
const apiError = (status, code, message) => OpenAI.APIError.generate(status, { error: { code, message } }, undefined, {});

test('refusals waiting cannot fix end the turn with the site\'s own words', () => {
  for (const [status, code] of [
    [402, 'upgrade_required'],
    [402, 'quota_exhausted'],
    [429, 'daily_cap'],
    [429, 'account_paused'],
    [503, 'not_configured'],
    [503, 'wallet_unavailable'],
    [400, 'model_not_allowed'],
  ]) {
    const said = hostedStop(apiError(status, code, `the site says ${code}`));
    assert.equal(said, `the site says ${code}`, code);
  }
});

test('the site\'s words only: a status number in front of the message is dropped', () => {
  // an error that carries the code but not the body (another client, a re-thrown copy): the SDK-style message
  const bare = Object.assign(new Error('402 Using QUANTESS in the terminal needs a paid plan.'), { status: 402, code: 'upgrade_required' });
  assert.equal(hostedStop(bare), 'Using QUANTESS in the terminal needs a paid plan.');
});

test('signed out says how to sign in; a closed service says so', () => {
  assert.match(hostedStop(apiError(401, 'signed_out', 'Not signed in. Run quantess login.')), /quantess login/);
  assert.match(hostedStop(apiError(404, 'not_found', 'Not found')), /not open/);
});

test('what a wait or a fold can fix is NOT a stop: busy, rate limited, in flight, too large, a provider error', () => {
  for (const [status, code] of [
    [429, 'upstream_busy'],
    [429, 'too_many_in_flight'],
    [429, 'quantess_rate_limited'],
    [413, 'too_large'],
    [502, 'upstream_error'],
    [504, 'timeout'],
  ]) {
    assert.equal(hostedStop(apiError(status, code, 'x')), null, code);
  }
  assert.equal(hostedStop(new Error('network down')), null);
  assert.equal(hostedStop(undefined), null);
});

test('too_large is recognised by its code, whatever the words say', () => {
  assert.equal(isTooLarge(apiError(413, 'too_large', 'That request is too large for one terminal call.')), true);
  assert.equal(isTooLarge(apiError(413, 'something_else', 'x')), false);
});

test('a refusal with no words still says something (never an empty "reply")', () => {
  const said = hostedStop(apiError(429, 'daily_cap', ''));
  assert.ok(said && said.length > 10);
  assert.match(said, /refused/);
});

// Verification review of 37321b2: with the SDK's retries off, retry once ONLY what never reached the proxy
test('neverReachedSite: Render\'s edge page and a connection never made - not anything the proxy answered', async () => {
  const { neverReachedSite } = await import('./errors.js');
  const edge = OpenAI.APIError.generate(502, undefined, '<html>Bad gateway</html>', {});
  assert.equal(neverReachedSite(edge), true);
  assert.equal(neverReachedSite(OpenAI.APIError.generate(503, undefined, 'Service Unavailable', {})), true);
  const refused = new OpenAI.APIConnectionError({ cause: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) });
  assert.equal(neverReachedSite(refused), true);
  assert.equal(neverReachedSite(new OpenAI.APIConnectionError({ cause: { code: 'ENOTFOUND' } })), true);
  // the proxy answered: it may have charged the hold
  assert.equal(neverReachedSite(apiError(502, 'upstream_error', 'x')), false);
  assert.equal(neverReachedSite(apiError(504, 'timeout', 'x')), false);
  assert.equal(neverReachedSite(apiError(503, 'not_configured', 'x')), false);
  assert.equal(neverReachedSite(apiError(429, 'upstream_busy', 'x')), false);
  // dropped mid-way: it may have run
  assert.equal(neverReachedSite(new OpenAI.APIConnectionError({ cause: { code: 'ECONNRESET' } })), false);
  assert.equal(neverReachedSite(undefined), false);
});
