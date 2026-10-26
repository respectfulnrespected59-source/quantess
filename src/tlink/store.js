// T-LINK pairing: the device token that lets this PC post its activity to the owner's phone.
// It lives only in ~/.quantess/tlink.json (the model may not write there, read it, or name it in a shell command),
// is sent only to the QUAN-TESS site (or this PC, for testing), is never shown whole, and is scrubbed - plain, base64
// and hex - from anything the model sees.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { execFileSync } from 'child_process';
import { quantessHome } from '../budget.js';

const TOKEN_SHAPE = /^tlk_[A-Za-z0-9_-]{43}$/;          // tlk_ + 32 random bytes, base64url
const DEVICE_SHAPE = /^[A-Za-z0-9_-]{8,64}$/;
const THIS_PC = new Set(['localhost', '127.0.0.1', '[::1]']);
// The only sites a T-LINK key is ever sent to (review 10-24): a rewritten or planted tlink.json cannot redirect it.
// A new domain for the site is added here, in code - never from a file or an env var.
export const TLINK_SITES = Object.freeze(['https://quantus-ai.onrender.com']);
export const TOKEN_LABEL = '[tlink token]';

/** The pairing file: ~/.quantess/tlink.json. @param {NodeJS.ProcessEnv} [env] */
export const tlinkFile = (env = process.env) => path.join(quantessHome(env), 'tlink.json');

/**
 * A well-formed origin: https anywhere, http only to this PC. Scheme + host only - a path, query, user or password is
 * refused, so `http://localhost@evil.com` or `http://localhost.evil.com` never pass.
 * @returns {{ ok: true, origin: string } | { ok: false, why: string }}
 */
export function checkOrigin(value) {
  let url;
  try {
    url = new URL(String(value ?? ''));
  } catch {
    return { ok: false, why: 'not a URL' };
  }
  if (url.username || url.password) return { ok: false, why: 'a user or password in the URL' };
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return { ok: false, why: 'only scheme and host' };
  if (url.protocol === 'https:') return { ok: true, origin: url.origin };
  if (url.protocol === 'http:' && THIS_PC.has(url.hostname)) return { ok: true, origin: url.origin };
  return { ok: false, why: 'https only (http just for this PC)' };
}

/** May a T-LINK key go here? Only the QUAN-TESS site, or this PC. */
export function pairableOrigin(value) {
  const checked = checkOrigin(value);
  if (!checked.ok) return false;
  return TLINK_SITES.includes(checked.origin) || THIS_PC.has(new URL(checked.origin).hostname);
}

function validPairing(p, now) {
  return Boolean(p) && typeof p === 'object' && pairableOrigin(p.origin) && DEVICE_SHAPE.test(String(p.deviceId))
    && TOKEN_SHAPE.test(String(p.token)) && Number.isFinite(p.expiresAt) && p.expiresAt > now;
}

/**
 * The saved pairing, or null when there is none, it is unreadable or misshapen, it points anywhere but the site, or it
 * has expired.
 * @returns {{ origin: string, deviceId: string, token: string, expiresAt: number } | null}
 */
export function readPairing({ file = tlinkFile(), now = Date.now } = {}) {
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    return validPairing(p, now()) ? { origin: p.origin, deviceId: p.deviceId, token: p.token, expiresAt: p.expiresAt } : null;
  } catch {
    return null;
  }
}

/**
 * Only this Windows user may read the file (chmod 600 elsewhere). icacls is run from System32 by full path (a bare
 * name could pick up an icacls.exe planted in the working folder) for the domain-qualified user.
 * @returns {boolean} false if it could not be done
 */
export function restrictToOwner(file, { platform = process.platform, run = execFileSync, user = os.userInfo().username,
  env = process.env } = {}) {
  try {
    if (platform === 'win32') {
      const icacls = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
      const who = env.USERDOMAIN ? `${env.USERDOMAIN}\\${user}` : user;
      run(icacls, [file, '/inheritance:r', '/grant:r', `${who}:F`], { stdio: 'ignore' });
    } else {
      fs.chmodSync(file, 0o600);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Save a pairing. It is written to a temp file, locked to the owner, and only then given its real name - so the key
 * never sits readable under its name. A bad pairing, or a file that cannot be locked, saves nothing and throws.
 */
export function writePairing(pairing, { file = tlinkFile(), restrict = restrictToOwner, now = Date.now } = {}) {
  if (!pairableOrigin(pairing?.origin)) throw new Error('T-LINK pairing refused: bad origin (only the QUAN-TESS site)');
  if (!validPairing(pairing, now())) throw new Error('T-LINK pairing refused: bad device id, token or expiry');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { origin, deviceId, token, expiresAt } = pairing;
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify({ origin, deviceId, token, expiresAt }), { mode: 0o600 });
    if (!restrict(temp)) throw new Error('T-LINK pairing refused: could not lock the key file to this user');
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/** Forget the pairing on this PC. */
export function clearPairing({ file = tlinkFile() } = {}) {
  fs.rmSync(file, { force: true });
}

/** tlk_…ab12 - the only way the token is ever shown. */
export function maskToken(token) {
  return typeof token === 'string' && token.length > 8 ? `tlk_…${token.slice(-4)}` : '(none)';
}

/**
 * The token as text could carry it: plain, hex, and base64 at each of the three byte offsets it could start at inside
 * a longer encoded stream (review of 22b35f5). For base64 the first and last 4 characters can depend on the bytes
 * around the token, so the inner run - which the token alone decides - is what gets scrubbed.
 */
function tokenForms(token) {
  const bytes = Buffer.from(token, 'utf8');
  const hex = bytes.toString('hex');
  const forms = [token, hex, hex.toUpperCase()];
  for (let offset = 0; offset < 3; offset += 1) {
    const shifted = Buffer.concat([Buffer.alloc(offset), bytes]);
    for (const enc of ['base64', 'base64url']) forms.push(shifted.toString(enc).slice(4, -4));
  }
  return forms.sort((a, b) => b.length - a.length);
}

/**
 * Is this path the T-LINK key file itself - by its name, or by the file on disk (a hard link has another name but the
 * same volume and file id)? Shared by every read path the model has (review of 22b35f5).
 */
export function isKeyFile(filepath, { file = tlinkFile() } = {}) {
  try {
    const a = fs.statSync(filepath, { bigint: true });
    const b = fs.statSync(file, { bigint: true });
    return a.ino !== 0n && a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  }
}

/**
 * Every copy of the token in text replaced, so a tool result that held it never reaches the model or a transcript.
 * The terminal key (hosted mode) uses the same forms with its own label.
 */
export function scrubToken(text, token, label = TOKEN_LABEL) {
  if (!token || typeof text !== 'string') return text;
  let out = text;
  for (const form of tokenForms(token)) out = out.split(form).join(label);
  return out;
}

// The key on file, by file name, re-read only when that file changes
const cache = new Map();

/**
 * The token in the pairing file, for scrubbing - even an expired or otherwise unusable pairing's, since that key
 * must keep being scrubbed too. null when there is no file or no token-shaped value in it.
 */
export function liveToken({ file = tlinkFile() } = {}) {
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    cache.delete(file);
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.token;
  let token = null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))?.token;
    token = TOKEN_SHAPE.test(String(raw)) ? raw : null;
  } catch {
    token = null;
  }
  cache.set(file, { mtimeMs, token });
  return token;
}
