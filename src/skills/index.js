import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

/**
 * The skill library: everything Claude Code knows on this PC, so Q23 can take over when
 * Claude's limit is hit. Sources are read in priority order; the first entry with a
 * given name wins.
 *
 *   skill  - Q23's own ./skills, ~/.claude/skills (plus the claude.ai-synced set under
 *            skills/synced/<id>/), and the skills of every installed Claude Code plugin
 *   agent  - ~/.claude/agents and installed plugin agents: specialist roles to adopt
 *   rule   - ~/.claude/rules/**: the always-follow standards
 *   memory - Claude's memory notes: standing orders, traps, project state
 */
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const REPO_SKILLS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');
const REPO_AGENTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'agents');

export const SKILLS_DIR = process.env.Q23_SKILLS_DIR || path.join(CLAUDE_DIR, 'skills');

/** Claude Code keys project memory by the home path with every non-alphanumeric turned into a dash. */
export const memorySlug = (home) => home.replace(/[^A-Za-z0-9]/g, '-');

export const MEMORY_DIR =
  process.env.Q23_MEMORY_DIR || path.join(CLAUDE_DIR, 'projects', memorySlug(os.homedir()), 'memory');

/** Memory notes that never leave the PC: bodies go to a third-party free model. */
const PRIVATE_NOTES = new Set(['user_contact_info']);

/** Key-shaped strings are masked before any text reaches the model. */
export function redact(text) {
  return text
    .replace(/\b(sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/g, '[REDACTED-KEY]')
    .replace(/\b(api[_-]?key|secret|token|password)(\s*[:=]\s*)["']?[^\s"'`]{12,}/gi, '$1$2[REDACTED]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, '[REDACTED-KEY]')
    // Stripe webhook, Brevo, AWS and Resend keys, and bearer tokens: as they appear on a dashboard page
    .replace(/\b(whsec_[A-Za-z0-9]{16,}|xkeysib-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|re_[A-Za-z0-9_]{20,})/g, '[REDACTED-KEY]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/g, '$1[REDACTED]')
    // user:password inside a connection string; the host stays readable
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/"']+:[^\s@/"']+@/gi, '$1[REDACTED]@');
}

export function parseFrontmatter(raw) {
  const m = raw.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: raw.replace(/^﻿/, '') };
  const data = {};
  const lines = m[1].split(/\r?\n/);
  // Only top-level scalar keys matter; indented (nested) lines are skipped unless they
  // continue a folded/literal block (`description: >` or `|`).
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^[>|][+-]?$/.test(v)) {
      const block = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
      v = block.join(' ');
    } else if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1).replace(/\\"/g, '"');
    }
    data[kv[1]] = v;
  }
  return { data, body: m[2] };
}

function readDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // a missing source is normal (e.g. no plugins on this PC)
  }
}

function toEntry(kind, file, fallbackName) {
  if (kind === 'memory' && PRIVATE_NOTES.has(fallbackName)) return null;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return null; // a folder without a SKILL.md is not a skill
  }
  const { data, body } = parseFrontmatter(raw);
  if (!body.trim()) return null;
  return {
    kind,
    name: (data.name || fallbackName).trim(),
    dir: fallbackName,
    description: redact((data.description || '').replace(/\s+/g, ' ').trim()),
    path: file,
    body: redact(body.trim())
  };
}

/** <dir>/<name>/SKILL.md */
export function folderEntries(kind, dir) {
  return readDir(dir)
    .filter((e) => e.isDirectory())
    .map((e) => toEntry(kind, path.join(dir, e.name, 'SKILL.md'), e.name))
    .filter(Boolean);
}

/** <dir>/<name>.md */
export function fileEntries(kind, dir) {
  return readDir(dir)
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => toEntry(kind, path.join(dir, e.name), e.name.slice(0, -3)))
    .filter(Boolean);
}

/** Every .md under dir, named by its relative path: rules/common/coding-style */
export function treeEntries(kind, dir, prefix, rel = '') {
  return readDir(path.join(dir, rel)).flatMap((e) => {
    const sub = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) return treeEntries(kind, dir, prefix, sub);
    if (!e.isFile() || !e.name.endsWith('.md')) return [];
    const entry = toEntry(kind, path.join(dir, sub), `${prefix}/${sub.slice(0, -3)}`);
    return entry ? [{ ...entry, name: entry.dir }] : [];
  });
}

/** Install paths of the Claude Code plugins that are actually installed. */
function installedPluginPaths() {
  const file = path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json');
  if (!fs.existsSync(file)) return [];
  try {
    const plugins = JSON.parse(fs.readFileSync(file, 'utf-8')).plugins || {};
    return Object.values(plugins)
      .map((installs) => installs?.[0]?.installPath)
      .filter(Boolean);
  } catch (err) {
    console.error(`q23: could not read ${file}: ${err.message}. Plugin skills skipped.`);
    return [];
  }
}

/** The default sources, in priority order. Each is a function returning entries. */
export function defaultSources() {
  const plugins = installedPluginPaths();
  const synced = path.join(SKILLS_DIR, 'synced');
  return [
    () => folderEntries('skill', REPO_SKILLS),
    () => folderEntries('skill', SKILLS_DIR),
    () => readDir(synced)
      .filter((e) => e.isDirectory())
      .flatMap((e) => folderEntries('skill', path.join(synced, e.name))),
    () => plugins.flatMap((p) => folderEntries('skill', path.join(p, 'skills'))),
    // quantess's own personas (quantus, quanti-code, quanta-clause, quant-ology) ship in the repo
    () => fileEntries('agent', REPO_AGENTS),
    () => fileEntries('agent', path.join(CLAUDE_DIR, 'agents')),
    () => plugins.flatMap((p) => fileEntries('agent', path.join(p, 'agents'))),
    () => treeEntries('rule', path.join(CLAUDE_DIR, 'rules'), 'rules'),
    () => fileEntries('memory', MEMORY_DIR)
  ];
}

const norm = (s) => String(s || '').toLowerCase().trim().replace(/\.md$/, '');

/** Merge sources; within a kind, the first entry with a given name (case-insensitive) wins. */
export function buildLibrary(sources) {
  const seen = new Set();
  const out = [];
  for (const source of sources) {
    for (const entry of source()) {
      const key = `${entry.kind}:${norm(entry.name)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

let cache = null;

/** Every entry in the library. Read once per process. */
export function loadSkills({ force = false } = {}) {
  if (cache && !force) return cache;
  cache = buildLibrary(defaultSources());
  return cache;
}

const KIND_ORDER = ['skill', 'agent', 'rule', 'memory'];

/**
 * Match on the frontmatter name first, then the folder or file name, since they often
 * differ. When a skill and an agent share a name, the skill wins; "agent:planner" picks one.
 */
export function findSkill(name, library = loadSkills()) {
  const [, prefix, rest] = String(name).match(/^(skill|agent|rule|memory):(.+)$/) || [];
  const key = norm(rest || name);
  const pool = prefix ? library.filter((s) => s.kind === prefix) : library;
  const rank = (s) => KIND_ORDER.indexOf(s.kind);
  const pick = (field) =>
    pool.filter((s) => norm(s[field]) === key).sort((a, b) => rank(a) - rank(b))[0];
  return pick('name') || pick('dir') || null;
}

const STOPWORDS = new Set(
  'a an and are as at be by do for from how in is it of on or the to vs we what when where which who why with you'.split(' ')
);

/** Dots are dropped so "A.C.M.E." matches "acme"; two-letter words like "v2" are kept. */
export function queryWords(query) {
  return [...new Set(norm(query).replace(/\./g, '').split(/[^a-z0-9]+/))]
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * Rank by the query words found in each entry: 3 for the name, 2 for the description,
 * 1 for the body (facts like links and hashes often live only in the body). Each word is
 * weighted by how rare it is across the library, so "acme" outranks "video".
 * `kind` narrows to one source type.
 */
const flat = (s) => norm(s).replace(/\./g, '');

/** A field is searchable as flat text (substring) and as a set of whole tokens. */
function field(text) {
  const f = flat(text);
  return { text: f, tokens: new Set(f.split(/[^a-z0-9]+/)) };
}

// Searchable text is built once per library, not on every call.
const searchIndex = new WeakMap();
function indexOf(library) {
  if (!searchIndex.has(library)) {
    searchIndex.set(
      library,
      library.map((s) => ({ s, name: field(`${s.name} ${s.dir}`), desc: field(s.description), body: field(s.body) }))
    );
  }
  return searchIndex.get(library);
}

/** Short words must match a whole token ("ai" must not hit "email"); longer ones may match a stem. */
const hit = (f, w) => (w.length < 4 ? f.tokens.has(w) : f.text.includes(w));

export function searchSkills(query, limit = 8, { kind, library = loadSkills() } = {}) {
  const words = queryWords(query);
  if (!words.length) return [];
  const docs = indexOf(library).filter((d) => !kind || d.s.kind === kind);
  const rarity = Object.fromEntries(
    words.map((w) => {
      const df = docs.filter((d) => hit(d.name, w) || hit(d.desc, w) || hit(d.body, w)).length;
      return [w, Math.log((docs.length + 1) / (df + 1)) + 1];
    })
  );
  return docs
    .map(({ s, name, desc, body }) => {
      const score = words.reduce(
        (n, w) => n + rarity[w] * (hit(name, w) ? 3 : hit(desc, w) ? 2 : hit(body, w) ? 1 : 0),
        0
      );
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.s);
}

/**
 * The always-on catalog. Skill names only: listing every description would cost about
 * 9k tokens on every turn. Agents, rules and memory notes are counted, not listed;
 * find_skill reaches them.
 */
export function skillCatalog(library = loadSkills()) {
  if (!library.length) return '';
  const count = (k) => library.filter((s) => s.kind === k).length;
  const names = library
    .filter((s) => s.kind === 'skill')
    .map((s) => (s.name === s.dir ? s.name : `${s.name} (${s.dir})`))
    .join(', ');
  // The takeover routine maps Claude Code's tools to ours; only the owner's install carries it
  const toolMap = library.some((s) => s.name === 'q23-takeover')
    ? ' load_skill("q23-takeover") maps each of those to what you can do instead.'
    : ' Use the closest tool you have.';
  return `## Library (${library.length})

The same library Claude Code uses on this PC. Load what covers the job BEFORE starting it.

- load_skill("<name>") returns the full text. Follow it.
- find_skill("<topic>") searches everything below by name and description.
- ${count('memory')} memory notes: the user's standing orders, known traps and where each project stands.
  Before touching a project, find_skill("<project name>") and read its note. load_skill("MEMORY") is the index.
- ${count('agent')} agent roles (code-reviewer, planner, security-reviewer...): load one and work in that role.
- ${count('rule')} rules (rules/common/...): coding, testing, git and security standards.

Skills were written for Claude Code and may name tools you do not have (Task, Agent, MCP
servers).${toolMap}

### Skills (${count('skill')})
${names}`;
}
