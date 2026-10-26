// The operating brief: standing orders loaded from the repo root, so they apply whatever folder quantess runs in.
// BRIEF.md is the public one. QMM.md, the owner's own brief, is kept out of the public copy and replaces BRIEF.md
// when it is there.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = new URL('../', import.meta.url);
export const OWNER_BRIEF = fileURLToPath(new URL('QMM.md', REPO_ROOT));
export const PUBLIC_BRIEF = fileURLToPath(new URL('BRIEF.md', REPO_ROOT));
// Also owner-only: the takeover routine. With it, a missing QMM.md is a broken owner install, not a public one
// (code review of 12048ea: the brief's own absence must not quietly turn the owner's checks off)
const OWNER_MARK = fileURLToPath(new URL('skills/q23-takeover/SKILL.md', REPO_ROOT));

/** Is this the owner's install (their own brief, and the skill library that goes with it)? */
export const isOwnerInstall = ({ brief = OWNER_BRIEF, mark = OWNER_MARK } = {}) => fs.existsSync(brief) || fs.existsSync(mark);

/**
 * The owner's brief when there is one, else the public brief; '' (with a warning) when neither can be read. On the
 * owner's install a missing owner brief is said out loud.
 */
export function loadBrief({ owner = OWNER_BRIEF, pub = PUBLIC_BRIEF, warn = console.warn, ownerInstall = isOwnerInstall() } = {}) {
  for (const file of [owner, pub]) {
    try {
      return fs.readFileSync(file, 'utf-8');
    } catch (error) {
      if (error.code !== 'ENOENT' || (file === owner && ownerInstall)) warn(`[brief not loaded: ${error.message}]`);
    }
  }
  warn('[brief not loaded: BRIEF.md is missing]');
  return '';
}
