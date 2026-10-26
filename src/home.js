// One home for quantess (~/.quantess). quantessq23 kept its sessions in ~/.q23 and quantus kept its memories and
// spend ledger in ~/.quantus: they are copied over once, never overwriting what quantess has, and the old folders
// are never touched. quantus's daily cap setting is NOT carried over: raising a spending limit is the user's call.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { quantessHome } from './budget.js';
import { createMemory } from './memory.js';

const MARKER = 'migrated.json';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const defaultDirs = () => ({ home: quantessHome(), q23: path.join(os.homedir(), '.q23'), quantus: path.join(os.homedir(), '.quantus') });

/** Copy each file quantess does not have yet; returns how many came over. */
function copyMissing(fromDir, toDir, keep = () => true) {
  let entries;
  try {
    entries = fs.readdirSync(fromDir, { withFileTypes: true });
  } catch {
    // no old folder on this machine: nothing to bring over
    return 0;
  }
  fs.mkdirSync(toDir, { recursive: true });
  let copied = 0;
  for (const entry of entries) {
    const to = path.join(toDir, entry.name);
    if (!entry.isFile() || !keep(entry.name) || fs.existsSync(to)) continue;
    fs.copyFileSync(path.join(fromDir, entry.name), to);
    copied += 1;
  }
  return copied;
}

function readLedger(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    // missing or unreadable: an empty ledger
    return {};
  }
}

/** Add the old ledger's spend into quantess's, day by day; returns how many days came over. */
function mergeLedger(fromFile, toFile) {
  const days = Object.entries(readLedger(fromFile)).filter(([day, usd]) => DAY.test(day) && Number.isFinite(Number(usd)));
  if (!days.length) return 0;
  const merged = days.reduce((acc, [day, usd]) => ({ ...acc, [day]: Number(((acc[day] ?? 0) + Number(usd)).toFixed(6)) }), readLedger(toFile));
  fs.mkdirSync(path.dirname(toFile), { recursive: true });
  fs.writeFileSync(toFile, JSON.stringify(merged, null, 2));
  return days.length;
}

/**
 * Bring the old homes into the quantess home, once.
 * @param {{ home: string, q23: string, quantus: string }} [dirs]
 * @returns {{ at: string, sessions: number, memories: number, ledgerDays: number } | null} null when it already ran
 */
export function migrateHome(dirs = defaultDirs()) {
  const marker = path.join(dirs.home, MARKER);
  if (fs.existsSync(marker)) return null;
  fs.mkdirSync(dirs.home, { recursive: true });
  // Claimed first (code review 10-23): a crash part way can leave old spend un-merged, never added twice
  fs.writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), started: true }, null, 2));
  const sessions = copyMissing(path.join(dirs.q23, 'sessions'), path.join(dirs.home, 'sessions'));
  const memories = copyMissing(path.join(dirs.quantus, 'memory'), path.join(dirs.home, 'memory'), (name) => name.endsWith('.md') && name !== 'MEMORY.md');
  if (memories) createMemory(path.join(dirs.home, 'memory')).reindex();
  const ledgerDays = mergeLedger(path.join(dirs.quantus, 'ledger.json'), path.join(dirs.home, 'ledger.json'));
  const result = { at: new Date().toISOString(), sessions, memories, ledgerDays };
  fs.writeFileSync(marker, JSON.stringify(result, null, 2));
  return result;
}
