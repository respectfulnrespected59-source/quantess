// The terminal key for hosted mode (`quantess login`): it lets this PC make model calls through the QUAN-TESS site,
// paid from the user's plan. It lives only in ~/.quantess/terminal-key.json and is guarded like T-LINK's key
// (src/tlink/store.js): sent only to the QUAN-TESS site (or this PC, for testing), locked to this user, never shown
// whole, scrubbed from anything the model sees, and the model may not read, write or grep for it.
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { quantessHome } from '../budget.js';
import { checkOrigin, restrictToOwner } from '../tlink/store.js';

const KEY_SHAPE = /^qtk_[A-Za-z0-9_-]{43}$/;          // qtk_ + 32 random bytes, base64url
const KEY_ID_SHAPE = /^key_[A-Za-z0-9_-]{6,40}$/;
const THIS_PC = new Set(['localhost', '127.0.0.1', '[::1]']);
// The only sites a terminal key is ever sent to. A new domain is added here, in code - never from a file or env var.
export const HOSTED_SITES = Object.freeze(['https://quantus-ai.onrender.com']);
export const KEY_LABEL = '[terminal key]';

/** ~/.quantess/terminal-key.json (a name no project uses, so the shell guard can block it by name). @param {NodeJS.ProcessEnv} [env] */
export const authFile = (env = process.env) => path.join(quantessHome(env), 'terminal-key.json');

/**
 * The site's origin if a terminal key may go there, else null: the QUAN-TESS site, or this PC only when the user set
 * QUANTESS_LOCAL_SITE=1 (a site under test; never from a project .env). Without it, a planted key file pointing at a
 * local listener the model started cannot send the key there (security review of 4d1cc19).
 */
export function hostedSite(value, { allowLocal = process.env.QUANTESS_LOCAL_SITE === '1' } = {}) {
  const checked = checkOrigin(value);
  if (!checked.ok) return null;
  if (HOSTED_SITES.includes(checked.origin)) return checked.origin;
  return allowLocal && THIS_PC.has(new URL(checked.origin).hostname) ? checked.origin : null;
}

// Fragments of a key in any form a tool might print it: plain, reversed, hex, and base64 / base64url at each byte
// offset (of the UTF-8 and of UTF-16 text). Compared with punctuation, case and JSON escapes stripped, so spaced-out,
// dashed, line-wrapped (even one character a line), tabbed or hex-dumped copies still match. Built from the key's
// RANDOM part only - its fixed qtk_ / tlk_ prefix would match any copy of the prefix - and never from UTF-16 hex, whose
// 12-character windows carry only 3 characters of the key (verification review of 37321b2: false positives).
// 12 characters: long enough that ordinary text never hits one by chance.
const WINDOW = 12;
// A JSON escape (\n, \t, é...) is two or six characters of punctuation-and-letter that are not in the text
const squash = (text) => String(text).replace(/\\(?:[nrtbf"\\/]|u[0-9a-fA-F]{4})/g, ' ').toLowerCase().replace(/[^a-z0-9]/g, '');
const needleCache = new Map();
function needlesFor(token) {
  const hit = needleCache.get(token);
  if (hit) return hit;
  const body = token.replace(/^(?:qtk|tlk)_/, '');
  const utf8 = Buffer.from(body, 'utf8');
  const utf16 = Buffer.from(body, 'utf16le');
  const forms = [body, [...body].reverse().join(''), utf8.toString('hex')];
  for (const bytes of [utf8, utf16]) {
    for (let offset = 0; offset < 3; offset += 1) {
      const shifted = Buffer.concat([Buffer.alloc(offset), bytes]);
      // The first and last characters depend on the bytes around the key: the inner run is the key's alone
      for (const enc of ['base64', 'base64url']) forms.push(shifted.toString(enc).slice(4, -4));
    }
  }
  const windows = new Set();
  for (const form of forms) {
    const flat = squash(form);
    for (let i = 0; i + WINDOW <= flat.length; i += 1) windows.add(flat.slice(i, i + WINDOW));
  }
  if (needleCache.size > 8) needleCache.clear();
  needleCache.set(token, windows);
  return windows;
}

/** Does this text hold a piece of any of these keys, in any of those forms? (null keys are skipped) */
export function leaksKey(text, ...tokens) {
  const keys = tokens.filter((t) => typeof t === 'string' && t.length >= WINDOW);
  if (!keys.length || typeof text !== 'string') return false;
  const flat = squash(text);
  const needles = keys.map(needlesFor);
  // A hex dump of UTF-16 text is the UTF-8 hex with a 00 after every byte: with the 00s taken out, the UTF-8 hex
  // needles catch it (the key's own hex never holds a 00 - its characters are all printable)
  const dezeroed = flat.replace(/00/g, '');
  for (const hay of dezeroed === flat ? [flat] : [flat, dezeroed]) {
    // Each window of the text against the keys' needles: memory stays flat however long the text is
    for (let i = 0; i + WINDOW <= hay.length; i += 1) {
      const w = hay.slice(i, i + WINDOW);
      if (needles.some((n) => n.has(w))) return true;
    }
  }
  return false;
}

const validAuth = (a) => Boolean(a) && typeof a === 'object' && hostedSite(a.site) !== null
  && KEY_SHAPE.test(String(a.token)) && KEY_ID_SHAPE.test(String(a.keyId)) && typeof a.label === 'string';

/** The saved sign-in, or null when there is none, it is unreadable or misshapen, or it points anywhere but the site. */
export function readAuth({ file = authFile() } = {}) {
  try {
    const a = JSON.parse(fs.readFileSync(file, 'utf8'));
    return validAuth(a) ? { site: hostedSite(a.site), keyId: a.keyId, label: a.label, token: a.token } : null;
  } catch {
    return null;
  }
}

/**
 * Save a sign-in: written to a temp file, locked to this user, and only then given its real name - the key never sits
 * readable under its name. A bad sign-in, or a file that cannot be locked, saves nothing and throws.
 */
export function writeAuth(auth, { file = authFile(), restrict = restrictToOwner } = {}) {
  if (hostedSite(auth?.site) === null) throw new Error('terminal sign-in refused: bad site (only the QUAN-TESS site)');
  if (!validAuth(auth)) throw new Error('terminal sign-in refused: bad key or key id');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { site, keyId, label, token } = auth;
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify({ site: hostedSite(site), keyId, label, token }), { mode: 0o600 });
    if (!restrict(temp)) throw new Error('terminal sign-in refused: could not lock the key file to this user');
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/** Forget the sign-in on this PC (the key itself is revoked on the site, at /cli/activate). */
export function clearAuth({ file = authFile() } = {}) {
  fs.rmSync(file, { force: true });
}

/** qtk_…ab12 - the only way the key is ever shown. */
export function maskKey(token) {
  return typeof token === 'string' && token.length > 8 ? `qtk_…${token.slice(-4)}` : '(none)';
}

/** Is this path the key file itself - by its name's file on disk (a hard link has another name, same file id)? */
export function isAuthFile(filepath, { file = authFile() } = {}) {
  try {
    const a = fs.statSync(filepath, { bigint: true });
    const b = fs.statSync(file, { bigint: true });
    return a.ino !== 0n && a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  }
}

// The key on file, by file name, re-read only when that file changes
const cache = new Map();

/** The key on file, for scrubbing - even a misshapen file's key-shaped value. null when there is none. */
export function liveAuthToken({ file = authFile() } = {}) {
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
    token = KEY_SHAPE.test(String(raw)) ? raw : null;
  } catch {
    token = null;
  }
  cache.set(file, { mtimeMs, token });
  return token;
}
