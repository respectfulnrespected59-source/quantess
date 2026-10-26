import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describePrompt, hashText } from './describe.js';

// T-LINK security model 4: ONE description per question, used by the terminal AND the phone, every hidden character
// shown - so what is approved anywhere is exactly what runs

test('each kind says what will happen, with the terminal choices it offers', () => {
  const change = describePrompt('change', { text: 'run this command:\nnpm test', complete: true });
  assert.equal(change.type, 'select');
  assert.match(change.text, /^quantess wants to run this command:\nnpm test$/);
  assert.deepEqual(change.choices.map((c) => c.value), ['yes', 'always', 'no']);

  const partial = describePrompt('change', { text: 'write big.js (900 lines):', complete: false });
  assert.deepEqual(partial.choices.map((c) => c.value), ['yes', 'no'], 'no "always" for a step shown in part');
  assert.equal(partial.complete, false);

  const site = describePrompt('site', { site: 'example.com', url: 'https://www.example.com/a?b=1' });
  assert.match(site.text, /open a new site: example\.com/);
  assert.match(site.text, /www\.example\.com/);
  assert.deepEqual(site.choices.map((c) => c.value), ['yes', 'always', 'no']);

  const memory = describePrompt('memory', { type: 'feedback', name: 'push-policy', description: 'pushing', content: 'line 1\nline 2' });
  assert.equal(memory.type, 'confirm');
  assert.match(memory.text, /\[feedback\] push-policy - pushing\nline 1\nline 2\nKeep it\?$/);

  assert.match(describePrompt('pay', { label: 'Upscale 2x', count: 1 }).text, /click "Upscale 2x".*spend money/);
  assert.match(describePrompt('publish', { cmd: 'git push origin main' }).text, /PUSH \/ MERGE.*git push origin main/);
});

test('negative: hidden characters in a site, memory or url are shown, never raw; a lookalike host shows as punycode', () => {
  const site = describePrompt('site', { site: 'evil.com‮', url: 'https://xn--pple-43d.com/\u001b[2K' });
  assert.doesNotMatch(site.text, /[‮\u001b]/);
  assert.ok(site.text.includes('xn--pple-43d.com'));
  const memory = describePrompt('memory', { type: 'lesson', name: 'n​', description: 'd\nfake line', content: 'c\u001b[31m' });
  assert.doesNotMatch(memory.text, /[​\u001b]/);
  assert.ok(memory.text.includes('d\\x0afake line'), 'a line break in the one-line description is shown');
});

test('negative: a cut paid label marks the question incomplete; an unknown kind throws', () => {
  assert.equal(describePrompt('pay', { label: 'Buy '.repeat(200), count: 1 }).complete, false);
  assert.throws(() => describePrompt('shell', {}), /unknown/);
});

test('hashText is stable and changes with any character', () => {
  assert.equal(hashText('a'), hashText('a'));
  assert.notEqual(hashText('run npm test'), hashText('run npm test '));
  assert.match(hashText('x'), /^[0-9a-f]{64}$/);
});
