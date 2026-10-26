// Real money for model calls (10-23: a job has to be able to finish, so paid Nemotron is the main lane). Paid models are cheap (Nemotron 3.5 Lightning $0.07/$0.20 per million tokens) but
// never free, so each call books OpenRouter's own usage.cost to a daily ledger, and past the day's cap only
// free models run - the job keeps going, it just stops spending.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Nemotron spends its whole budget thinking and returns an EMPTY reply unless reasoning is off.
// Ultra and the 3-Super answer with thinking on, kept out of the reply.
const REASONING_OFF = [/nemotron/i];
const REASONING_HIDDEN = [/nemotron-3-ultra/i, /nemotron-3-super/i];

export const isFreeModel = (model) => /:free$/.test(String(model ?? ''));

/** Extra OpenRouter body fields for one call: the real cost back, and the reasoning switch the model needs. */
export function requestExtras(model) {
  const extras = { usage: { include: true } };
  if (REASONING_HIDDEN.some((re) => re.test(model))) extras.reasoning = { enabled: true, exclude: true };
  else if (REASONING_OFF.some((re) => re.test(model))) extras.reasoning = { enabled: false };
  return extras;
}

/** Where quantess keeps its own files: QUANTESS_HOME, else ~/.quantess. */
export function quantessHome(env = process.env) {
  return env.QUANTESS_HOME || path.join(accountHome(), '.quantess');
}

/**
 * The account's own home folder. os.homedir() follows USERPROFILE / HOME, which any command can set for the processes
 * it starts - a `quantess login` run that way would save its key outside every guard (security review of 4d1cc19).
 */
function accountHome() {
  // Elsewhere HOME is how containers, sudo and CI place the home on purpose (verification review of 37321b2)
  if (process.platform !== 'win32') return os.homedir();
  try {
    return os.userInfo().homedir || os.homedir();
  } catch {
    return os.homedir();
  }
}

const defaultLedger = () => path.join(quantessHome(), 'ledger.json');
const utcDay = (now) => now().toISOString().slice(0, 10);

function readLedger(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    // Missing or unreadable: a broken ledger must never block work; the next book() rewrites it
    return {};
  }
}

/** USD spent on models today (UTC). */
export function spentToday({ file = defaultLedger(), now = () => new Date() } = {}) {
  return Number(readLedger(file)[utcDay(now)] || 0);
}

/** Add one call's real cost to today's total. $0 calls are not written. */
export function book(usd, { file = defaultLedger(), now = () => new Date() } = {}) {
  const amount = Number(usd);
  if (!(amount > 0)) return;
  const ledger = readLedger(file);
  const key = utcDay(now);
  const next = { ...ledger, [key]: Number(((Number(ledger[key]) || 0) + amount).toFixed(6)) };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2));
  } catch (err) {
    console.warn(`[quantess: could not write the cost ledger (${err.message}) - spend still shows per turn]`);
  }
}

/** The day's cap in USD: QUANTESS_DAILY_CAP_USD when it is a positive number, else the default. */
export function dailyCapUsd(env = process.env, fallback = 5) {
  const value = Number(env.QUANTESS_DAILY_CAP_USD);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * The model chain for a turn. Under the cap it is untouched. At the cap only the free models in it run, in
 * their order; with none in the chain, the free safety net is used - never a paid model.
 * @param {{ model: string, fallbacks: string[] }} chain
 * @param {{ spent: number, cap: number, freeNet?: string[] }} money
 * @returns {{ model: string, fallbacks: string[], capped: boolean }}
 */
export function chainUnderCap(chain, { spent, cap, freeNet = [] }) {
  if (!(spent >= cap)) return { ...chain, capped: false };
  const free = [chain.model, ...chain.fallbacks].filter(isFreeModel);
  const [model, ...fallbacks] = free.length ? free : freeNet.filter(isFreeModel);
  return { model, fallbacks, capped: true };
}
