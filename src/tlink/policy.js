// T-LINK policy (owner decisions 10-24). The phone can always say No. It can say Yes only to a
// change, a site or a memory, only when the question was shown exactly, and only inside a window the user granted at the
// terminal (/tlink allow-yes 2h). Money (pay) and git push (publish) are No-only on the phone, always.
// All of it is decided here, in the CLI, on the CLI's own clock: a hacked site cannot widen it.
import { performance } from 'perf_hooks';

export const PHONE_YES_KINDS = new Set(['change', 'site', 'memory']);
export const MAX_GRANT_MS = 12 * 3_600_000;

/** '2h', '30m', '90' (minutes), '1h30m' -> milliseconds; null for zero, over 12 hours, or anything else. */
export function parseWindow(text) {
  const m = /^(?:(\d+)h)?(?:(\d+)m?)?$/i.exec(String(text ?? '').trim());
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  const ms = (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60_000;
  return ms > 0 && ms <= MAX_GRANT_MS ? ms : null;
}

/** The terminal-granted window for phone Yeses, on a monotonic clock (a changed PC clock cannot stretch it). */
export function createGrant({ now = () => performance.now() } = {}) {
  let until = 0;
  return {
    allow(ms) {
      until = now() + Math.min(Math.max(0, Number(ms) || 0), MAX_GRANT_MS);
    },
    revoke() {
      until = 0;
    },
    active: () => now() < until,
    remainingMs: () => Math.max(0, until - now())
  };
}

/** The buttons the phone may show for this question. */
export function phoneChoices(kind, { exact, grantActive }) {
  return PHONE_YES_KINDS.has(kind) && exact === true && grantActive === true ? ['yes', 'no'] : ['no'];
}

/**
 * Should the CLI take this answer from the phone? open = { promptId, sessionId, textHash, kind, exact, deadline,
 * consumed:Set }. Only 'yes' or 'no' (never 'always'), for the open question, by its own deadline, once.
 * @returns {{ ok: true, answer: 'yes'|'no' } | { ok: false, why: string }}
 */
export function judgeRemote(msg, open, { grant, now = () => performance.now() }) {
  if (!msg || typeof msg !== 'object') return { ok: false, why: 'not an answer' };
  if (msg.answer !== 'yes' && msg.answer !== 'no') return { ok: false, why: 'only yes or no' };
  // Fail closed (review 10-24): an id that is missing on both sides is not a match, a missing deadline is never "in time"
  const ids = ['promptId', 'sessionId', 'textHash'];
  if (!ids.every((k) => typeof open?.[k] === 'string' && open[k] !== '' && msg[k] === open[k])) {
    return { ok: false, why: 'not the open question' };
  }
  if (!(open.consumed instanceof Set)) return { ok: false, why: 'no record of answers' };
  if (open.consumed.has(open.promptId)) return { ok: false, why: 'already answered' };
  if (!(now() < open.deadline)) return { ok: false, why: 'too late' };
  if (msg.answer === 'yes' && !phoneChoices(open.kind, { exact: open.exact, grantActive: grant.active() }).includes('yes')) {
    return { ok: false, why: 'Yes from the phone is not allowed for this question' };
  }
  // Used up: the same answer can never count twice
  open.consumed.add(open.promptId);
  return { ok: true, answer: msg.answer };
}
