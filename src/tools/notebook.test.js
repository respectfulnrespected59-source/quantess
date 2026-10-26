import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { notebookToText, writeNotebookLmPack } from './notebook.js';
import { executeTool, readFile } from './index.js';

// Ported from quantus-cli: Jupyter notebooks read as cells, NotebookLM source packs, and the live checklist
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quantess-nb-'));

test('jupyter notebooks read as cells with outputs', () => {
  const nb = { metadata: { kernelspec: { language: 'python' } }, cells: [{ cell_type: 'markdown', source: ['# Title'] }, { cell_type: 'code', source: 'print(1)', outputs: [{ text: ['1\n'] }] }] };
  const text = notebookToText(nb);
  assert.match(text, /Cell 1 · markdown\n# Title/);
  assert.match(text, /```python\nprint\(1\)\n```\nOutput:\n1/);
  assert.throws(() => notebookToText({}), /Not a Jupyter notebook/);
});

test('read_file reads a .ipynb as cells, not raw JSON', async () => {
  const file = path.join(tmp(), 'lesson.ipynb');
  fs.writeFileSync(file, JSON.stringify({ cells: [{ cell_type: 'code', source: 'x = 2', outputs: [] }] }));
  const r = await readFile(file);
  assert.equal(r.status, 'success', r.summary);
  assert.match(r.data, /Cell 1 · code/);
  assert.doesNotMatch(r.data, /"cell_type"/);
});

test('NotebookLM pack writes files, links and the upload steps', () => {
  const dir = tmp();
  const r = writeNotebookLmPack(dir, { title: 'Truth Tables', sources: [{ title: 'EP04 transcript', content: 'words here' }, { title: 'EP04', url: 'https://youtu.be/DNqg7mrxiHg' }] });
  assert.deepEqual(r.files, ['01-ep04-transcript.md']);
  assert.equal(r.links.length, 1);
  const readme = fs.readFileSync(path.join(r.dir, 'README.md'), 'utf8');
  assert.match(readme, /notebooklm\.google\.com/);
  assert.match(readme, /youtu\.be\/DNqg7mrxiHg/);
  assert.throws(() => writeNotebookLmPack(dir, { title: 'x', sources: [] }), /at least one/);
});

test('notebooklm_pack is a tool; a pack with no sources is an error, not a crash', async () => {
  const dir = tmp();
  const ok = await executeTool('notebooklm_pack', { title: 'Class 1', dir, sources: [{ title: 'Notes', content: 'hello' }] });
  assert.equal(ok.status, 'success', ok.summary);
  assert.ok(fs.existsSync(path.join(dir, 'notebooklm-class-1', 'README.md')));
  const bad = await executeTool('notebooklm_pack', { title: 'Empty', dir, sources: [] });
  assert.equal(bad.status, 'error');
});

test('todo_write shows the plan and counts what is done', async () => {
  const items = [{ text: 'read the code', status: 'done' }, { text: 'fix the bug', status: 'in_progress' }, { text: 'run tests', status: 'pending' }];
  const r = await executeTool('todo_write', { items });
  assert.equal(r.status, 'success');
  assert.match(r.summary, /1\/3 done/);
  assert.deepEqual(r.data.items, items);
  assert.equal((await executeTool('todo_write', { items: 'not a list' })).status, 'error');
});
