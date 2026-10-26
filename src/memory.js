// What quantess has learned: one markdown file per memory plus an index it reads at the start of every session.
// Ported from quantus-cli (learning mode): nothing is retrained, lessons are written down and read back. Its own
// folder (~/.quantess/memory), never Claude's curated memory, and never a key or token.
import fs from 'fs';
import path from 'path';
import { parseFrontmatter } from './skills/index.js';
import { quantessHome } from './budget.js';
import { secretProblem } from './tools/web.js';

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference', 'lesson'];
const INDEX = 'MEMORY.md';
const MAX_INDEX_CHARS = 12_000;
const MAX_DESCRIPTION_CHARS = 160;
const MAX_CONTENT_CHARS = 2000;
const MAX_RECALL = 8;

export const slugify = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/**
 * A memory exactly as it would be saved (name, type, one-line description, content), or an Error thrown. The
 * approval prompt shows this same text, so what the user approves is what is written (security review 10-23).
 */
export function memoryPreview({ name, type = 'lesson', description, content } = {}) {
  const slug = slugify(name);
  if (!slug) throw new Error('remember needs a name');
  const body = String(content ?? '').trim();
  if (!body) throw new Error('remember needs content');
  if (body.length > MAX_CONTENT_CHARS) throw new Error(`a memory is a short note: keep it under ${MAX_CONTENT_CHARS} characters`);
  if (secretProblem(`${name} ${description ?? ''} ${body}`)) throw new Error('not saved: it holds something shaped like a key or token');
  return {
    name: slug,
    type: MEMORY_TYPES.includes(type) ? type : 'lesson',
    description: String(description || body).replace(/\s+/g, ' ').slice(0, MAX_DESCRIPTION_CHARS),
    content: body
  };
}

/** @param {string} dir */
export function createMemory(dir) {
  fs.mkdirSync(dir, { recursive: true });

  const list = () =>
    fs.readdirSync(dir)
      .filter((f) => f.endsWith('.md') && f !== INDEX)
      .map((f) => {
        const { data, body } = parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
        return { file: f, name: data.name || f.replace(/\.md$/, ''), type: data.type || 'lesson', description: data.description || '', body: body.trim() };
      });

  const rebuildIndex = () => {
    const lines = list()
      .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
      .map((m) => `- [${m.type}] ${m.name} (${m.file}) — ${m.description}`);
    fs.writeFileSync(path.join(dir, INDEX), `# quantess memory\n${lines.join('\n')}\n`);
  };

  return {
    dir,
    list,
    // Memories copied in from elsewhere (the old quantus home) need the index rebuilt
    reindex: rebuildIndex,
    index() {
      const p = path.join(dir, INDEX);
      if (!fs.existsSync(p)) return '';
      const text = fs.readFileSync(p, 'utf8');
      return text.length > MAX_INDEX_CHARS ? `${text.slice(0, MAX_INDEX_CHARS)}\n…(index truncated — use recall)` : text;
    },
    remember(args) {
      const m = memoryPreview(args);
      const file = `${m.name}.md`;
      const existed = fs.existsSync(path.join(dir, file));
      // Only quotes are escaped: the frontmatter reader undoes exactly that, so a Windows path reads back as written
      const quoted = `"${m.description.replace(/"/g, '\\"')}"`;
      const text = `---\nname: ${m.name}\ndescription: ${quoted}\ntype: ${m.type}\nupdated: ${new Date().toISOString()}\n---\n\n${m.content}\n`;
      fs.writeFileSync(path.join(dir, file), text);
      rebuildIndex();
      return { file, updated: existed };
    },
    recall(query) {
      const words = String(query || '').toLowerCase().split(/\W+/).filter((w) => w.length > 2);
      return list()
        .map((m) => {
          const hay = `${m.name} ${m.description} ${m.body}`.toLowerCase();
          return { m, score: words.length ? words.filter((w) => hay.includes(w)).length : 1 };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_RECALL)
        .map((x) => x.m);
    },
    forget(name) {
      const p = path.join(dir, `${slugify(name)}.md`);
      if (!fs.existsSync(p)) return false;
      fs.rmSync(p);
      rebuildIndex();
      return true;
    }
  };
}

let approver = null;

/**
 * How the CLI asks the user to keep a memory that came after outside text (resolves true / false); null when
 * nobody is at a terminal. Security review 10-23: a memory rides into every future session's prompt.
 */
export function setMemoryApprover(fn) {
  approver = fn;
}

export function memoryApprover() {
  return approver;
}

let cached = null;

/** The memory in the quantess home (QUANTESS_HOME is read at call time). */
export function defaultMemory() {
  const dir = path.join(quantessHome(), 'memory');
  if (!cached || cached.dir !== dir) cached = createMemory(dir);
  return cached;
}
