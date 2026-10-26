// T-LINK: the site's API as the CLI sees it. Phase 3 builds the server side of exactly these
// routes. Everything the site sends back is checked here, field by field - the CLI never trusts its shape.

export const PATHS = Object.freeze({
  pairStart: '/api/tlink/pair/start',      // POST { label } -> { deviceCode, userCode, intervalSec, expiresInSec }
  pairPoll: '/api/tlink/pair/poll',        // POST { deviceCode } -> { status: pending | approved (+ device) | denied | expired }
  whoami: '/api/tlink/cli/whoami',         // GET (Bearer) -> { deviceId, label } | 401
  events: '/api/tlink/cli/events',         // POST (Bearer) { sessionId, resync?, events[] } -> 200 | 409 resync | 401
  stream: '/api/tlink/cli/stream',         // GET (Bearer) SSE: hello / answer / off, ': ping' keep-alives
  end: '/api/tlink/cli/end',               // POST (Bearer) { sessionId }
  revoke: '/api/tlink/cli/revoke'          // POST (Bearer)
});

/**
 * A reply body read up to cap characters, then the rest is never pulled (a hostile site cannot stream megabytes into
 * memory). Shared by every request the CLI makes to the site.
 */
export async function readCapped(res, cap) {
  if (!res.body) return '';
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of res.body) {
    out += decoder.decode(chunk, { stream: true });
    if (out.length > cap) break;
  }
  return out.slice(0, cap);
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const HASH = /^[0-9a-f]{64}$/;
const TOKEN = /^tlk_[A-Za-z0-9_-]{43}$/;
const DEVICE = /^[A-Za-z0-9_-]{8,64}$/;
const DEVICE_CODE = /^[A-Za-z0-9_-]{16,128}$/;
const USER_CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

const safeJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isId = (v) => typeof v === 'string' && ID.test(v);

/**
 * An answer from the phone, as the stream carries it. Only the four fields, each shape-checked; only yes or no.
 * @returns {{ promptId: string, sessionId: string, textHash: string, answer: 'yes'|'no' } | null}
 */
export function parseAnswerFrame(text) {
  const f = safeJson(text);
  if (!isObject(f) || !isId(f.promptId) || !isId(f.sessionId)) return null;
  if (typeof f.textHash !== 'string' || !(HASH.test(f.textHash) || ID.test(f.textHash))) return null;
  if (f.answer !== 'yes' && f.answer !== 'no') return null;
  return { promptId: f.promptId, sessionId: f.sessionId, textHash: f.textHash, answer: f.answer };
}

/** @returns {{ deviceCode: string, userCode: string, intervalSec: number, expiresInSec: number } | null} */
export function parsePairStart(j) {
  if (!isObject(j) || !DEVICE_CODE.test(String(j.deviceCode)) || !USER_CODE.test(String(j.userCode))) return null;
  const intervalSec = Number(j.intervalSec);
  const expiresInSec = Number(j.expiresInSec);
  if (!(intervalSec > 0 && intervalSec <= 60) || !(expiresInSec > 0 && expiresInSec <= 1800)) return null;
  return { deviceCode: j.deviceCode, userCode: j.userCode, intervalSec, expiresInSec };
}

/**
 * @returns {{ status: 'pending'|'slow_down'|'denied'|'expired' }
 *   | { status: 'approved', deviceId: string, token: string, expiresAt: number } | null}
 */
export function parsePairPoll(j) {
  if (!isObject(j)) return null;
  if (['pending', 'slow_down', 'denied', 'expired'].includes(j.status)) return { status: j.status };
  if (j.status === 'approved' && DEVICE.test(String(j.deviceId)) && TOKEN.test(String(j.token)) && Number.isFinite(j.expiresAt)) {
    return { status: 'approved', deviceId: j.deviceId, token: j.token, expiresAt: j.expiresAt };
  }
  return null;
}
