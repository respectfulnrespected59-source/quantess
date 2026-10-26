import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { quantessHome } from '../budget.js';

/**
 * Where transcripts live: one store, never the folder Q23 runs in. In a game repo ./sessions rode
 * into `git add -A`, and Q23 once read a previous run's transcript there as if it were a fact (09-28).
 * Claude reads these on return, so nothing here deletes them.
 */
export function sessionDir(env = process.env) {
  // One home: ~/.quantess/sessions (the old ~/.q23/sessions are copied in once, see home.js)
  return env.Q23_SESSION_DIR || env.QUANTESS_SESSION_DIR || path.join(quantessHome(env), 'sessions');
}

const SESSION_DIR = sessionDir();

// A session's conversation, saved after each turn beside its transcript so quantess --continue can pick it up
const STATE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESUMABLE_ROLES = new Set(['user', 'assistant', 'tool']);

/** Save { messages, readOutside } for a session (written to a temp file and renamed: never half a file). */
export function saveState(sessionId, state, dir = sessionDir()) {
  if (!STATE_ID.test(String(sessionId ?? ''))) return false;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ v: 1, savedAt: new Date().toISOString(), ...state }));
  fs.renameSync(`${file}.tmp`, file);
  return true;
}

/**
 * A saved conversation, or null: an id that is not a real session id (no path tricks), a missing file, or one
 * that is not a valid saved state. Only user / assistant / tool messages come back; the system prompt is rebuilt.
 */
export function loadState(sessionId, dir = sessionDir()) {
  if (!STATE_ID.test(String(sessionId ?? ''))) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(dir, `${sessionId}.json`), 'utf8'));
  } catch {
    // no saved state for this session (older sessions only have a transcript)
    return null;
  }
  if (!data || !Array.isArray(data.messages)) return null;
  const messages = data.messages.filter((m) => m && typeof m === 'object' && RESUMABLE_ROLES.has(m.role));
  return { ...data, messages };
}

/** A transcript for a resumed session whose .md went missing, so the next turn can append to it. */
export function ensureTranscript(sessionId) {
  if (!STATE_ID.test(String(sessionId ?? ''))) return;
  ensureSessionDir();
  const filePath = path.join(SESSION_DIR, `${sessionId}.md`);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `# Agent Session\n\nID: ${sessionId}\nResumed: ${new Date().toISOString()}\n\n---\n\n`, 'utf-8');
  }
}

/** The most recently saved session that can be resumed, or null. */
export function latestStateId(dir = sessionDir()) {
  let newest = null;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const id = entry.name.replace(/\.json$/, '');
      if (!entry.isFile() || !entry.name.endsWith('.json') || !STATE_ID.test(id)) continue;
      const mtime = fs.statSync(path.join(dir, entry.name)).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { id, mtime };
    }
  } catch {
    // no sessions folder yet
    return null;
  }
  return newest?.id ?? null;
}

/**
 * Ensure session directory exists
 */
export function ensureSessionDir() {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }
}

/**
 * Create a new session file
 */
export function createSession(initialContent = '') {
  ensureSessionDir();
  // Node's own random UUID: the uuid package (moderate advisory) is no longer needed
  const sessionId = randomUUID();
  const filePath = path.join(SESSION_DIR, `${sessionId}.md`);
  const content = `# Agent Session\n\nID: ${sessionId}\nCreated: ${new Date().toISOString()}\n\n---\n\n${initialContent}`;
  fs.writeFileSync(filePath, content, 'utf-8');
  return { sessionId, filePath };
}

/**
 * Load a session by ID
 */
export function loadSession(sessionId) {
  const filePath = path.join(SESSION_DIR, `${sessionId}.md`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Session ${sessionId} not found`);
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  return { sessionId, filePath, content };
}

/**
 * Append to a session (add a turn)
 */
export function appendToSession(sessionId, role, content, metadata = {}) {
  const { filePath } = loadSession(sessionId);
  const timestamp = new Date().toISOString();
  let entry = `\n## ${role.charAt(0).toUpperCase() + role.slice(1)} - ${timestamp}\n\n`;
  if (metadata && Object.keys(metadata).length > 0) {
    entry += `\`\`\`json\n${JSON.stringify(metadata, null, 2)}\n\`\`\`\n\n`;
  }
  entry += `${content}\n`;
  fs.appendFileSync(filePath, entry, 'utf-8');
}

/**
 * List all session IDs
 */
export function listSessions() {
  ensureSessionDir();
  const files = fs.readdirSync(SESSION_DIR).filter(f => f.endsWith('.md'));
  return files.map(f => f.replace('.md', ''));
}

/**
 * Export session to other formats
 */
export function exportSession(sessionId, format = 'md') {
  const { filePath, content } = loadSession(sessionId);
  switch (format) {
    case 'txt':
      return content.replace(/#+/g, '').replace(/`{3}[\s\S]*?`{3}/g, '');
    case 'json': {
      // Simple extraction of turns
      const turns = [];
      const sections = content.split(/## (User|Agent|System) - /);
      // First element is header
      for (let i = 1; i < sections.length; i += 2) {
        const role = sections[i].split(' - ')[0].toLowerCase();
        const rest = sections[i + 1];
        const timestampMatch = rest.match(/^([^\n]+)\n/);
        const timestamp = timestampMatch ? timestampMatch[1] : '';
        const body = timestampMatch ? rest.substring(timestampMatch[0].length) : rest;
        turns.push({ role, timestamp, body: body.trim() });
      }
      return JSON.stringify({ sessionId, turns }, null, 2);
    }
    default:
      return content;
  }
}

/**
 * Compact session (remove old turns, keep summary)
 * Simple implementation: keep last N turns
 */
export function compactSession(sessionId, keepLastN = 10) {
  const { filePath, content } = loadSession(sessionId);
  const lines = content.split('\n');
  // Find session header (first --- after metadata)
  const headerEnd = lines.findIndex(l => l.trim() === '---');
  if (headerEnd === -1) return; // malformed
  const header = lines.slice(0, headerEnd + 1).join('\n');
  const body = lines.slice(headerEnd + 1).join('\n');
  
  // Split by ## turns
  const turnSections = body.split(/## (User|Agent|System) - /);
  // First element is preamble before any turns
  const preamble = turnSections[0];
  const turns = [];
  for (let i = 1; i < turnSections.length; i += 2) {
    if (i + 1 < turnSections.length) {
      turns.push(turnSections[i] + ' - ' + turnSections[i + 1]);
    }
  }
  
  // Keep last N turns
  const keptTurns = turns.slice(-keepLastN);
  const newBody = preamble + keptTurns.join('');
  const newContent = header + '\n' + newBody;
  
  fs.writeFileSync(filePath, newContent, 'utf-8');
  return { sessionId, filePath, originalLength: content.length, newLength: newContent.length };
}