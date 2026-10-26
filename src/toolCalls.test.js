import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToolArgs, stubStaleBrowserResults } from './toolCalls.js';

test('parseToolArgs reads valid JSON and treats empty as no arguments', () => {
  assert.deepEqual(parseToolArgs('{"url":"https://x"}'), { args: { url: 'https://x' } });
  assert.deepEqual(parseToolArgs(''), { args: {} });
  assert.deepEqual(parseToolArgs(undefined), { args: {} });
});

test('parseToolArgs returns an error instead of throwing on broken JSON', () => {
  const got = parseToolArgs('{"url": "https://x"');
  assert.equal(got.args, undefined);
  assert.match(got.error, /not valid JSON/);
});

const page = (id, url) => ({
  role: 'tool',
  tool_call_id: id,
  content: JSON.stringify({ status: 'ok', summary: 'browser_snapshot', data: { page: `### Page\n- Page URL: ${url}\n### Snapshot\n- button "Go" [ref=e1]` } })
});

test('stubStaleBrowserResults keeps the newest page and shrinks older ones', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    page('b1', 'https://one'),
    { role: 'tool', tool_call_id: 's1', content: 'shell output' },
    page('b2', 'https://two')
  ];
  const browser = new WeakSet([messages[1], messages[3]]);
  const got = stubStaleBrowserResults(messages, browser, messages[3]);

  assert.equal(got[3], messages[3], 'newest page untouched');
  assert.equal(got[2], messages[2], 'non-browser tool untouched');
  assert.match(got[1].content, /https:\/\/one/, 'old stub keeps the URL');
  assert.doesNotMatch(got[1].content, /ref=e1/, 'old stub drops the snapshot refs');
  assert.match(messages[1].content, /ref=e1/, 'input must not be mutated');
});

test('stubStaleBrowserResults is not fooled by providers that reuse tool-call ids', () => {
  // Some free providers send call_0 every turn; ids cannot tell results apart.
  const oldPage = page('call_0', 'https://one');
  const shell = { role: 'tool', tool_call_id: 'call_0', content: 'x'.repeat(5000) };
  const newPage = page('call_0', 'https://two');
  const got = stubStaleBrowserResults([oldPage, shell, newPage], new WeakSet([oldPage, newPage]), newPage);

  assert.doesNotMatch(got[0].content, /ref=e1/, 'old page shrunk even though its id matches the newest');
  assert.equal(got[1], shell, 'shell output with a reused id is never cut');
  assert.equal(got[2], newPage);
});

test('stubStaleBrowserResults leaves results without a snapshot alone (find, tabs, errors)', () => {
  const found = { role: 'tool', tool_call_id: 'f', content: JSON.stringify({ data: { page: 'match list '.repeat(200) } }) };
  const newPage = page('n', 'https://two');
  const got = stubStaleBrowserResults([found, newPage], new WeakSet([found, newPage]), newPage);
  assert.equal(got[0], found);
});

// --- trimOldToolResults: a day of game work must not outgrow the model's context ---
import { trimOldToolResults, TRIM_NOTE } from './toolCalls.js';

const toolMsg = (n, size) => ({ role: 'tool', tool_call_id: `c${n}`, content: `result ${n} ` + 'x'.repeat(size) });

test('trimOldToolResults leaves a history under budget untouched', () => {
  const msgs = [{ role: 'system', content: 'sys' }, toolMsg(1, 100), toolMsg(2, 100)];
  assert.equal(trimOldToolResults(msgs, { budget: 10_000, keepWhole: 1 }), msgs);
});

test('trimOldToolResults shrinks the oldest tool results first and keeps the newest whole', () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'build the rifle' },
    toolMsg(1, 5000), toolMsg(2, 5000), toolMsg(3, 5000), toolMsg(4, 5000)
  ];
  const out = trimOldToolResults(msgs, { budget: 12_000, keepWhole: 2 });
  assert.notEqual(out, msgs, 'returns a new array');
  assert.ok(out[2].content.includes(TRIM_NOTE), 'oldest result is trimmed');
  assert.ok(out[2].content.startsWith('result 1 '), 'trimmed result keeps its head');
  assert.equal(out[5].content, msgs[5].content, 'newest result stays whole');
  assert.equal(out[4].content, msgs[4].content, 'second newest stays whole');
  assert.equal(out[1], msgs[1], 'user messages are never trimmed');
  assert.equal(msgs[2].content.includes(TRIM_NOTE), false, 'input is not mutated');
  const total = out.reduce((n, m) => n + String(m.content).length, 0);
  assert.ok(total <= 12_000, `history fits the budget (${total})`);
});

test('trimOldToolResults never trims the kept tail even when still over budget (negative)', () => {
  const msgs = [toolMsg(1, 9000), toolMsg(2, 9000)];
  const out = trimOldToolResults(msgs, { budget: 1000, keepWhole: 2 });
  assert.equal(out[0].content, msgs[0].content);
  assert.equal(out[1].content, msgs[1].content);
});

test('trimOldToolResults never trims a protected (browser) result', () => {
  const big = toolMsg(1, 9000);
  const msgs = [big, toolMsg(2, 9000), toolMsg(3, 10)];
  const out = trimOldToolResults(msgs, { budget: 1000, keepWhole: 1, protect: (m) => m === big });
  assert.equal(out[0], big);
  assert.ok(out[1].content.includes(TRIM_NOTE));
});

test('trimOldToolResults counts and trims big old tool-call arguments (a write_file payload)', () => {
  const call = { role: 'assistant', content: null, tool_calls: [{ id: 'w', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ filepath: 'a.js', content: 'y'.repeat(20000) }) } }] };
  const msgs = [call, { role: 'tool', tool_call_id: 'w', content: 'ok' }, toolMsg(2, 10)];
  const out = trimOldToolResults(msgs, { budget: 5000, keepWhole: 1 });
  const args = out[0].tool_calls[0].function.arguments;
  assert.ok(args.length < 500, 'old payload dropped');
  assert.doesNotThrow(() => JSON.parse(args), 'still valid JSON for the API');
  assert.equal(out[0].tool_calls[0].id, 'w', 'tool call id kept so the reply still pairs');
  assert.equal(call.tool_calls[0].function.arguments.length > 20000, true, 'input not mutated');
});
