// `quantess login` / `whoami` / `logout`: sign this terminal in to the user's QUAN-TESS AI plan with a device code
// (the site's server/cli/router.ts). The signed-in user types the code at /cli/activate and approves; the key comes back
// to this poll exactly once and is saved by auth.js. It is never printed.
//
// Like T-LINK's pair.js (security review of 4d1cc19): the page shown is the site's own fixed /cli/activate - nothing
// from the answer is printed as a link - the code is checked for shape before it is shown, every request refuses
// redirects, has a timeout and a capped read, and a key the site made but this PC could not save is named for revoking.
import os from 'os';
import { HOSTED_SITES, authFile, clearAuth, hostedSite, maskKey, readAuth, writeAuth } from './auth.js';
import { readCapped } from '../tlink/protocol.js';

const MAX_WAIT_SEC = 900;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_BODY_CHARS = 64_000;
// The site's own shape (ABCD-EFGH), exactly
const USER_CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const DEVICE_CODE = /^[A-Za-z0-9_-]{8,128}$/;
const KEY_ID = /^key_[A-Za-z0-9_-]{6,40}$/;
const NOT_SIGNED_IN = 'Not signed in. Run quantess login.';

/** The site's own label rule (safeLabel): letters, numbers, spaces, - _ '; 40 characters. */
export const hostLabel = (name = os.hostname()) =>
  String(name).replace(/[^A-Za-z0-9 _'-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'terminal';

async function call(fetchImpl, url, init) {
  try {
    const res = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    let body = null;
    try {
      // Streamed and cut at the cap as it arrives (T-LINK's reader), never read whole first
      const text = res.body && typeof res.body[Symbol.asyncIterator] === 'function'
        ? await readCapped(res, MAX_BODY_CHARS + 1)
        : typeof res.text === 'function' ? await res.text() : JSON.stringify(await res.json());
      body = text.length > MAX_BODY_CHARS ? null : JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch (error) {
    return { status: 0, body: null, error };
  }
}
const post = (fetchImpl, url, body) =>
  call(fetchImpl, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/**
 * @returns {Promise<{ ok: true, keyId: string, masked: string, replaced: string|null } | { ok: false, why: string }>}
 *   replaced: the key id this sign-in took over from (still live on the site until revoked there)
 */
export async function login({ site = HOSTED_SITES[0], label = hostLabel(), fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, print = console.log,
  file = authFile(), restrict } = {}) {
  const origin = hostedSite(site);
  if (!origin) return { ok: false, why: 'Terminal keys go only to the QUAN-TESS site.' };
  const page = `${origin}/cli/activate`;
  const started = await post(fetchImpl, `${origin}/api/cli/auth/start`, { label });
  if (started.status === 0) return { ok: false, why: `Could not reach ${origin}.` };
  if (started.status === 404) return { ok: false, why: 'Terminal sign-in is not open on the site yet.' };
  const { deviceCode, userCode, intervalSec, expiresInSec } = started.body ?? {};
  if (started.status !== 200) return { ok: false, why: `The site answered ${started.status}. Try again in a minute.` };
  if (!DEVICE_CODE.test(String(deviceCode)) || !USER_CODE.test(String(userCode))) {
    return { ok: false, why: 'The site\'s answer did not look right, so nothing was shown. Try again in a minute.' };
  }
  print(`Open ${page} and enter the code ${userCode}`);
  print('Only approve a code THIS terminal is showing. Making calls needs a paid QUAN-TESS AI plan.');
  const until = now() + Math.min(Number(expiresInSec) || 600, MAX_WAIT_SEC) * 1000;
  const every = Math.max(2, Math.min(Number(intervalSec) || 5, 30)) * 1000;
  let reached = false;
  while (now() < until) {
    await sleep(every);
    const polled = await post(fetchImpl, `${origin}/api/cli/auth/poll`, { deviceCode });
    if (polled.status !== 0) reached = true;
    const status = polled.body?.status;
    if (status === 'approved') return save(polled.body, { origin, label, file, restrict, page });
    if (status === 'denied') return { ok: false, why: 'The sign-in was refused on the site.' };
    if (status === 'expired') return { ok: false, why: 'The code expired. Run quantess login again.' };
    // pending, or a blip (a rate limit, a server error, the network): keep polling until the code runs out
  }
  return { ok: false, why: reached ? 'The code expired. Run quantess login again.' : `Could not reach ${origin} while waiting.` };
}

/** The approved key, saved - or named for revoking when it cannot be (the site hands it over only once). */
function save(answer, { origin, label, file, restrict, page }) {
  const keyId = KEY_ID.test(String(answer.keyId)) ? answer.keyId : null;
  const before = readAuth({ file });
  try {
    writeAuth({ site: origin, keyId: answer.keyId, label, token: answer.token }, { file, ...(restrict ? { restrict } : {}) });
  } catch (error) {
    return {
      ok: false,
      why: `The site made a terminal key${keyId ? ` (${keyId})` : ''} but this PC could not save it (${String(error?.message ?? error)}). ` +
        `Revoke it at ${page}, then run quantess login again.`
    };
  }
  return { ok: true, keyId, masked: maskKey(answer.token), replaced: before && before.keyId !== keyId ? before.keyId : null };
}

/** Who this terminal is signed in as, asked of the site. */
export async function whoami({ fetchImpl = fetch, file = authFile() } = {}) {
  const auth = readAuth({ file });
  if (!auth) return { ok: false, signedIn: false, why: NOT_SIGNED_IN };
  const res = await call(fetchImpl, `${auth.site}/api/cli/whoami`, { headers: { authorization: `Bearer ${auth.token}` } });
  if (res.status === 200 && res.body) {
    const text = (value, fallback) => (typeof value === 'string' && value ? value.replace(/[^\w .'@-]/g, '').slice(0, 60) : fallback);
    return { ok: true, signedIn: true, name: text(res.body.user?.name, ''), plan: text(res.body.plan, 'unknown'),
      keyId: auth.keyId, label: auth.label, masked: maskKey(auth.token) };
  }
  if (res.status === 401) return { ok: false, signedIn: true, why: 'This terminal key no longer works (revoked, expired, or the password changed). Run quantess login.' };
  if (res.status === 404) return { ok: false, signedIn: true, why: 'Terminal sign-in is not open on the site right now.' };
  return { ok: false, signedIn: true, why: res.status === 0 ? `Could not reach ${auth.site}.` : `The site answered ${res.status}.` };
}

/** Forget the key on this PC. Revoking it for good is on the site (/cli/activate). */
export function logout({ file = authFile() } = {}) {
  const auth = readAuth({ file });
  clearAuth({ file });
  return { removed: Boolean(auth), keyId: auth?.keyId ?? null, revokeAt: `${auth?.site ?? HOSTED_SITES[0]}/cli/activate` };
}
