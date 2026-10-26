// T-LINK pairing (security model 2): device flow, reversed. `quantess --tlink-pair` asks the site
// for a short code and shows it in the TERMINAL; the user, signed in on their phone, enters it at <site>/tlink and sees which
// PC is asking before he approves. Only then does the site mint the key, which is saved locked and never printed.
// Nobody can grab a code off the screen first: the terminal holds the secret half (deviceCode) and polls with it.
import os from 'os';
import { PATHS, parsePairStart, parsePairPoll, readCapped } from './protocol.js';
import { TLINK_SITES, checkOrigin, pairableOrigin, writePairing, readPairing, clearPairing, maskToken, tlinkFile } from './store.js';

const REQUEST_MS = 15_000;
const BODY_CAP = 16_384;
const MAX_INTERVAL_MS = 60_000;   // slow_down can never stretch one wait past a minute

async function postJson(fetchImpl, url, body, headers = {}, timeoutMs = REQUEST_MS) {
  const res = await fetchImpl(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {})
  });
  const text = await readCapped(res, BODY_CAP);
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: null };
  }
}

/**
 * Pair this PC with the site. @returns {Promise<{ ok: true, deviceId: string, masked: string, expiresAt: number }
 *   | { ok: false, why: string }>}
 */
export async function pairDevice({ origin = TLINK_SITES[0], label = os.hostname(), fetchImpl = fetch, print = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), minIntervalMs = 2000, maxWaitMs = 900_000, now = Date.now,
  file = tlinkFile(), restrict } = {}) {
  if (!pairableOrigin(origin)) return { ok: false, why: `T-LINK pairs only with ${TLINK_SITES.join(', ')} (or this PC)` };
  const site = checkOrigin(origin).origin;
  let start;
  try {
    start = parsePairStart((await postJson(fetchImpl, `${site}${PATHS.pairStart}`, { label: String(label).slice(0, 64) })).json);
  } catch {
    return { ok: false, why: `could not reach ${site}` };
  }
  if (!start) return { ok: false, why: 'the site sent a reply T-LINK does not understand' };
  // The address is built from OUR origin, never taken from the reply: a reply cannot send the user somewhere else
  print(`On your phone, open ${site}/tlink , sign in, and enter this code:  ${start.userCode}`);
  print('Check that the PC it names is this one, then approve. Waiting...');
  let interval = Math.min(MAX_INTERVAL_MS, Math.max(minIntervalMs, start.intervalSec * 1000));
  const deadline = now() + Math.min(maxWaitMs, start.expiresInSec * 1000);
  while (now() < deadline) {
    await sleep(Math.min(interval, Math.max(0, deadline - now())));
    if (now() >= deadline) break;                 // the code died while we slept: never poll with it
    let poll;
    try {
      // A poll gets only the time the code has left: a site that never answers cannot hold pairing past expiry
      const left = Math.max(1, Math.min(REQUEST_MS, deadline - now()));
      poll = parsePairPoll((await postJson(fetchImpl, `${site}${PATHS.pairPoll}`, { deviceCode: start.deviceCode }, {}, left)).json);
    } catch {
      continue;                                   // a dropped poll: try again next interval
    }
    if (!poll || poll.status === 'pending') continue;
    if (poll.status === 'slow_down') {
      interval = Math.min(MAX_INTERVAL_MS, interval + Math.max(minIntervalMs, 2000));
      continue;
    }
    if (poll.status === 'denied') return { ok: false, why: 'you said no on the site - nothing was saved' };
    if (poll.status === 'expired') return { ok: false, why: 'the code expired before it was approved' };
    try {
      writePairing({ origin: site, deviceId: poll.deviceId, token: poll.token, expiresAt: poll.expiresAt }, { file, restrict });
    } catch (err) {
      return { ok: false, why: err.message };
    }
    return { ok: true, deviceId: poll.deviceId, masked: maskToken(poll.token), expiresAt: poll.expiresAt };
  }
  return { ok: false, why: 'the code expired before it was approved' };
}

/** Forget this PC on the site (best effort) and remove the key here. @returns {Promise<{ removed: boolean, revoked: boolean }>} */
export async function unpairDevice({ fetchImpl = fetch, file = tlinkFile() } = {}) {
  const pairing = readPairing({ file });
  let revoked = false;
  if (pairing) {
    try {
      const { status } = await postJson(fetchImpl, `${pairing.origin}${PATHS.revoke}`, {}, { authorization: `Bearer ${pairing.token}` });
      // 401/403: the site had already forgotten this key - it is revoked either way
      revoked = status === 200 || status === 401 || status === 403;
    } catch {
      revoked = false;
    }
  }
  clearPairing({ file });
  return { removed: true, revoked };
}
