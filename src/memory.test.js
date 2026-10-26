import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Ported from quantus-cli (learning mode): lessons are written down and read back next session. Its own folder,
// ~/.quantess/memory - never Claude's curated memory - so a page that talks the model into "remembering"
// something can only reach quantess's own notes, which ride in the prompt marked as data.
process.env.QUANTESS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'quantess-mem-'));
process.env.OPENROUTER_API_KEY ||= 'sk-or-test-not-a-real-key';
const { createMemory, defaultMemory } = await import('./memory.js');
const { executeTool } = await import('./tools/index.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quantess-memtest-'));

test('memory saves, updates in place, indexes, recalls and forgets', () => {
  const mem = createMemory(tmp());
  const first = mem.remember({ name: 'Prefers PowerShell', type: 'user', description: 'uses pwsh', content: 'Use PowerShell syntax.\nWhy: Windows rig.' });
  assert.equal(first.updated, false);
  const second = mem.remember({ name: 'prefers-powershell', type: 'user', description: 'uses pwsh 7', content: 'Use PowerShell 7.' });
  assert.equal(second.updated, true);
  assert.equal(mem.list().length, 1);
  assert.match(mem.index(), /\[user\] prefers-powershell .* uses pwsh 7/);
  assert.equal(mem.recall('powershell')[0].body, 'Use PowerShell 7.');
  assert.equal(mem.recall('kubernetes').length, 0);
  assert.equal(mem.forget('prefers-powershell'), true);
  assert.equal(mem.list().length, 0);
  assert.throws(() => mem.remember({ name: 'x', content: '  ' }), /content/);
});

test('negative: a memory that holds a key or token is refused, and nothing is written', () => {
  const mem = createMemory(tmp());
  assert.throws(() => mem.remember({ name: 'api', content: 'the key is sk-or-v1-0123456789abcdef0123456789abcdef' }), /key or token/);
  assert.throws(() => mem.remember({ name: 'gh', description: 'token ghp_abcdefghijklmnopqrstuvwxyz0123', content: 'x' }), /key or token/);
  assert.equal(mem.list().length, 0);
});

// Security review 10-23: the approval prompt showed 300 characters of a longer memory
test('negative: a memory longer than a short note is refused; the preview is exactly what is saved', async () => {
  const { memoryPreview } = await import('./memory.js');
  const mem = createMemory(tmp());
  assert.throws(() => mem.remember({ name: 'long', content: 'x'.repeat(2001) }), /short note/);
  const preview = memoryPreview({ name: 'Kart Port', type: 'nonsense', content: '  Kart serves on 8864.  ' });
  assert.deepEqual(preview, { name: 'kart-port', type: 'lesson', description: 'Kart serves on 8864.', content: 'Kart serves on 8864.' });
  mem.remember({ name: 'Kart Port', type: 'nonsense', content: '  Kart serves on 8864.  ' });
  assert.equal(mem.list()[0].body, preview.content);
  assert.equal(mem.list()[0].description, preview.description);
});

// Code review 10-23: a backslash in a description (a Windows path) came back doubled after a save and a read
test('a description with a Windows path reads back exactly as it was saved', () => {
  const B = String.fromCharCode(92);
  const description = `kart lives in C:${B}games${B}kart and says "go"`;
  const mem = createMemory(tmp());
  mem.remember({ name: 'kart-home', description, content: 'x' });
  assert.equal(mem.list()[0].description, description);
  assert.ok(mem.index().includes(description));
});

test('remember and recall are tools, and they write to the quantess home', async () => {
  const saved = await executeTool('remember', { name: 'kart-port', type: 'project', description: 'kart dev server port', content: 'QM Kart serves on 8864.\nHow to apply: screenshot_page http://localhost:8864/.' });
  assert.equal(saved.status, 'success', saved.summary);
  assert.ok(fs.existsSync(path.join(process.env.QUANTESS_HOME, 'memory', 'kart-port.md')));
  const found = await executeTool('recall', { query: 'kart port' });
  assert.match(found.data.memories[0].body, /8864/);
  const none = await executeTool('recall', { query: 'kubernetes' });
  assert.equal(none.data.memories.length, 0);
});

test('the memory index rides in the prompt, marked as notes - data, not instructions', async () => {
  defaultMemory().remember({ name: 'tone', type: 'feedback', description: 'short answers', content: 'Keep answers short.' });
  const { Agent } = await import('./agent.js');
  const agent = new Agent({ browser: false });
  assert.match(agent.systemPrompt, /\[feedback\] tone .* short answers/);
  assert.match(agent.systemPrompt, /data, not instructions/);
});
