// Notebook connectors, ported from quantus-cli: Jupyter .ipynb read as cells, and NotebookLM source packs.
import fs from 'fs';
import path from 'path';
import { slugify } from '../memory.js';

const MAX_CELL_OUTPUT = 2000;
// NotebookLM caps a single source at 500,000 words
const WORDS_PER_SOURCE = 450_000;

/** Jupyter .ipynb -> readable text: markdown cells, code cells, and their text outputs. */
export function notebookToText(json, { maxOutput = MAX_CELL_OUTPUT } = {}) {
  const nb = typeof json === 'string' ? JSON.parse(json) : json;
  if (!Array.isArray(nb.cells)) throw new Error('Not a Jupyter notebook (no cells array)');
  const lang = nb.metadata?.kernelspec?.language || nb.metadata?.language_info?.name || '';
  const src = (v) => (Array.isArray(v) ? v.join('') : String(v || ''));
  return nb.cells
    .map((cell, i) => {
      const head = `## Cell ${i + 1} · ${cell.cell_type}`;
      if (cell.cell_type !== 'code') return `${head}\n${src(cell.source)}`;
      const outputs = (cell.outputs || [])
        .map((o) => src(o.text) || src(o.data?.['text/plain']) || (o.ename ? `${o.ename}: ${o.evalue}` : ''))
        .filter(Boolean)
        .join('\n');
      const shown = outputs.length > maxOutput ? `${outputs.slice(0, maxOutput)}…` : outputs;
      return `${head}\n\`\`\`${lang}\n${src(cell.source)}\n\`\`\`${shown ? `\nOutput:\n${shown}` : ''}`;
    })
    .join('\n\n');
}

/**
 * Consumer NotebookLM has no public API, so the connector writes a source pack: one markdown file per source
 * (uploadable as-is) plus the links NotebookLM can ingest directly (YouTube and web), with the steps to add them.
 * @param {string} dir
 * @param {{ title: string, sources: { title?: string, content?: string, url?: string }[] }} pack
 */
/** The exact folder a pack is written to: the agent's guard checks this same path. */
export const packDir = (dir, title) => path.join(String(dir || '.'), `notebooklm-${slugify(title) || 'pack'}`);

export function writeNotebookLmPack(dir, { title, sources }) {
  if (!Array.isArray(sources) || !sources.length) throw new Error('A pack needs at least one source');
  const root = packDir(dir, title);
  fs.mkdirSync(root, { recursive: true });
  const links = [];
  const files = [];
  sources.forEach((s, i) => {
    if (s.url && !s.content) {
      links.push(`${s.title ? `${s.title}: ` : ''}${s.url}`);
      return;
    }
    const words = String(s.content || '').split(/\s+/);
    for (let part = 0; part * WORDS_PER_SOURCE < words.length; part++) {
      const chunk = words.slice(part * WORDS_PER_SOURCE, (part + 1) * WORDS_PER_SOURCE).join(' ');
      const suffix = words.length > WORDS_PER_SOURCE ? `-part${part + 1}` : '';
      const name = `${String(i + 1).padStart(2, '0')}-${slugify(s.title) || 'source'}${suffix}.md`;
      fs.writeFileSync(path.join(root, name), `# ${s.title || `Source ${i + 1}`}\n\n${chunk}\n`);
      files.push(name);
    }
  });
  const readme = [
    `# ${title} — NotebookLM source pack`,
    '',
    '1. Open https://notebooklm.google.com and create a notebook.',
    '2. Add source → Upload → select every .md file in this folder.',
    links.length ? '3. Add source → YouTube / Website → paste each link below.' : '',
    '',
    files.length ? `## Files\n${files.map((f) => `- ${f}`).join('\n')}` : '',
    links.length ? `\n## Links\n${links.map((l) => `- ${l}`).join('\n')}` : ''
  ]
    .filter((l) => l !== '')
    .join('\n');
  fs.writeFileSync(path.join(root, 'README.md'), `${readme}\n`);
  return { dir: root, files, links };
}
