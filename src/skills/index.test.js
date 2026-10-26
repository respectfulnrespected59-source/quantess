import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildLibrary,
  fileEntries,
  findSkill,
  folderEntries,
  memorySlug,
  parseFrontmatter,
  queryWords,
  redact,
  searchSkills,
  skillCatalog,
  treeEntries
} from './index.js';

function tmpTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'q23-lib-'));
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return root;
}

const fm = (name, description, body = 'Do the thing.') =>
  `---\r\nname: ${name}\r\ndescription: "${description}"\r\nmetadata:\r\n  type: project\r\n---\r\n\r\n${body}\r\n`;

test('folderEntries reads <dir>/<name>/SKILL.md and skips folders without one', () => {
  const root = tmpTree({
    '01-cinematic/SKILL.md': fm('seedance-cinematic', 'film look'),
    'empty-folder/notes.txt': 'not a skill'
  });
  const got = folderEntries('skill', root);
  assert.equal(got.length, 1);
  assert.equal(got[0].name, 'seedance-cinematic');
  assert.equal(got[0].dir, '01-cinematic');
  assert.equal(got[0].kind, 'skill');
});

test('fileEntries reads memory notes; nested frontmatter keys are ignored', () => {
  const root = tmpTree({
    'feedback_voice.md': fm('feedback-voice', 'Use the narrator voice only'),
    'MEMORY.md': '# Memory Index\n- [Voice](feedback_voice.md)\n',
    'ignore.txt': 'x'
  });
  const got = fileEntries('memory', root);
  assert.deepEqual(new Set(got.map((e) => e.name)), new Set(['feedback-voice', 'MEMORY']));
  const note = got.find((e) => e.name === 'feedback-voice');
  assert.equal(note.description, 'Use the narrator voice only');
  assert.equal(note.dir, 'feedback_voice');
  assert.ok(!('type' in note), 'nested metadata.type must not leak to the top level');
});

test('treeEntries names rules by relative path', () => {
  const root = tmpTree({ 'common/testing.md': '# Testing\n80% coverage', 'python/hooks.md': '# Hooks' });
  const names = treeEntries('rule', root, 'rules').map((e) => e.name).sort();
  assert.deepEqual(names, ['rules/common/testing', 'rules/python/hooks']);
});

test('a missing source directory yields nothing instead of throwing', () => {
  const nowhere = path.join(os.tmpdir(), 'q23-does-not-exist-' + Date.now());
  assert.deepEqual(folderEntries('skill', nowhere), []);
  assert.deepEqual(fileEntries('agent', nowhere), []);
  assert.deepEqual(treeEntries('rule', nowhere, 'rules'), []);
});

test('buildLibrary: within a kind the first source wins; across kinds both are kept', () => {
  const lib = buildLibrary([
    () => [{ kind: 'skill', name: 'planner', dir: 'a', description: 'mine', path: 'a', body: 'x' }],
    () => [{ kind: 'skill', name: 'Planner', dir: 'b', description: 'plugin copy', path: 'b', body: 'y' }],
    () => [{ kind: 'agent', name: 'planner', dir: 'c', description: 'role', path: 'c', body: 'z' }]
  ]);
  assert.deepEqual(lib.map((e) => `${e.kind}:${e.description}`).sort(), ['agent:role', 'skill:mine']);
  assert.equal(findSkill('planner', lib).kind, 'skill', 'a bare name prefers the skill');
  assert.equal(findSkill('agent:planner', lib).description, 'role');
});

test('parseFrontmatter strips a BOM and reads folded block descriptions', () => {
  const { data, body } = parseFrontmatter('\uFEFF---\r\nname: x\r\ndescription: >-\r\n  first line\r\n  second line\r\nother: y\r\n---\r\nBody');
  assert.equal(data.name, 'x');
  assert.equal(data.description, 'first line second line');
  assert.equal(data.other, 'y');
  assert.equal(body, 'Body');
});

test('redact masks key-shaped strings and leaves normal text alone', () => {
  const fake = 'sk-or-v1-' + 'a1b2c3d4'.repeat(4);
  const out = redact(`key ${fake} and API_KEY=${'z'.repeat(20)} and ghp_${'Q'.repeat(30)}`);
  assert.ok(!out.includes(fake));
  assert.ok(!out.includes('z'.repeat(20)));
  assert.ok(!out.includes('Q'.repeat(30)));
  assert.equal(redact('the live key file is ~/quantess8 api.txt'), 'the live key file is ~/quantess8 api.txt');
});

test('private memory notes are never loaded', () => {
  const root = tmpTree({ 'user_contact_info.md': fm('user_contact_info', 'contact'), 'project_x.md': fm('project_x', 'x') });
  assert.deepEqual(fileEntries('memory', root).map((e) => e.name), ['project_x']);
  assert.equal(fileEntries('skill', root).length, 2, 'the block applies to memory only');
});

test('memorySlug matches how Claude Code names project folders', () => {
  assert.equal(memorySlug('C:\\Users\\riley'), 'C--Users-riley');
  assert.equal(memorySlug('C:\\Users\\first.last'), 'C--Users-first-last');
});

test('short words match whole tokens only; a rare word outranks common ones', () => {
  const lib = buildLibrary([
    () => [{ kind: 'memory', name: 'email-ops', dir: 'a', description: 'send email video', path: '', body: 'video video' }],
    () => [{ kind: 'memory', name: 'ai-gps', dir: 'b', description: 'AI business map', path: '', body: 'x' }],
    () => [{ kind: 'memory', name: 'common', dir: 'c', description: 'video lane', path: '', body: 'video' }]
  ]);
  assert.deepEqual(searchSkills('ai', 8, { library: lib }).map((e) => e.name), ['ai-gps']);
  assert.equal(searchSkills('video business', 8, { library: lib })[0].name, 'ai-gps');
  assert.equal(searchSkills('video', 1, { library: lib }).length, 1, 'limit is honoured');
});

const library = buildLibrary([
  () => [{ kind: 'skill', name: 'seedance-cinematic', dir: '01-cinematic', description: 'film look video', path: '', body: 'b' }],
  () => [{ kind: 'agent', name: 'code-reviewer', dir: 'code-reviewer', description: 'reviews code', path: '', body: 'b' }],
  () => [{ kind: 'memory', name: 'feedback-voice', dir: 'feedback_voice', description: 'narration voice kokoro', path: '', body: 'b' }]
]);

test('findSkill matches name, then folder, then a filename with .md', () => {
  assert.equal(findSkill('seedance-cinematic', library)?.dir, '01-cinematic');
  assert.equal(findSkill('01-cinematic', library)?.name, 'seedance-cinematic');
  assert.equal(findSkill('feedback_voice.md', library)?.name, 'feedback-voice');
  assert.equal(findSkill('no-such-thing', library), null);
});

test('searchSkills reaches memory notes and can filter by kind', () => {
  assert.equal(searchSkills('which narration voice', 8, { library })[0]?.name, 'feedback-voice');
  assert.deepEqual(searchSkills('voice', 8, { library, kind: 'skill' }), []);
  assert.deepEqual(searchSkills('a', 8, { library }), [], 'words under 3 chars are ignored');
});

test('queryWords drops dots and stopwords but keeps two-letter words like v2', () => {
  assert.deepEqual(queryWords('What is the link for A.C.M.E. video #3 (V2 vs Beta)?'), ['link', 'acme', 'video', 'v2', 'beta']);
});

test('searchSkills finds a fact that lives only in a note body', () => {
  const lib = buildLibrary([
    () => [{ kind: 'memory', name: 'feedback_video_lane', dir: 'a', description: 'V2 video lane, Beta fallback', path: '', body: 'lanes' }],
    () => [{ kind: 'memory', name: 'project_acme_landing', dir: 'b', description: 'landing page', path: '', body: 'A.C.M.E. video #3 V2-vs-Beta LIVE youtu.be/XYZ' }]
  ]);
  assert.equal(searchSkills('A.C.M.E. video #3 V2 vs Beta', 8, { library: lib })[0].name, 'project_acme_landing');
  assert.equal(searchSkills('youtu.be', 8, { library: lib })[0].name, 'project_acme_landing');
  assert.deepEqual(searchSkills('nothing-matches-this', 8, { library: lib }), []);
});

test('skillCatalog lists skill names only and counts the rest', () => {
  const cat = skillCatalog(library);
  assert.match(cat, /seedance-cinematic \(01-cinematic\)/);
  assert.match(cat, /1 memory notes/);
  assert.match(cat, /1 agent roles/);
  assert.doesNotMatch(cat, /### Skills[\s\S]*feedback-voice/, 'memory names stay out of the always-on list');
  assert.equal(skillCatalog([]), '');
});

// A public install has no takeover routine: the catalog points at it only when the library has it
test("skillCatalog names the takeover routine only when it is in the library, and the notes as the user's", () => {
  const cat = skillCatalog(library);
  assert.match(cat, /the user's standing orders/);
  assert.doesNotMatch(cat, /q23-takeover/, 'not in this library: not named');
  assert.match(skillCatalog([...library, { kind: 'skill', name: 'q23-takeover', dir: 'q23-takeover' }]), /load_skill\("q23-takeover"\) maps/);
});
