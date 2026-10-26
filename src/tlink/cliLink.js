// T-LINK inside a quantess session: the one place cli.js talks to. Off unless this PC is paired
// (quantess --tlink-pair) and not --no-tlink. It feeds the phone (hooks), lets the phone answer the five y/n questions
// (askers - only with a real terminal; a scripted run is watch-only), and handles /tlink.
import { readPairing, maskToken } from './store.js';
import { createEventLog } from './events.js';
import { createGrant, parseWindow } from './policy.js';
import { createTlinkClient } from './client.js';
import { createPhoneApprovals } from './approvers.js';
import { PATHS } from './protocol.js';

// Owner decision 10-24: a question nobody answers becomes "no" after 10 minutes while T-LINK is on
export const PROMPT_TTL_MS = 10 * 60_000;
const END_WAIT_MS = 1500;

// Stops quantess itself asked for: nothing to tell the user (they did it, or quantess is closing)
const LOCAL_STOPS = new Set(['turned off at the terminal', 'quantess closed', 'session ended']);

const hm = (ms) => `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;

function auditLine({ by, answer }) {
  if (by === 'timeout') return `[T-LINK] nobody answered in ${PROMPT_TTL_MS / 60_000} min - treated as No`;
  return `[T-LINK] answered from your phone: ${answer === 'yes' ? 'Yes' : 'No'}`;
}

/**
 * @param {{ enabled?: boolean, file?: string, interactive: boolean, ask: object, sessionId: () => string,
 *   print: (line: string) => void, audit?: (line: string) => void, fetchImpl?: typeof fetch, clientOptions?: object,
 *   ttlMs?: number }} options
 * @returns {null | { askers: object | null, hooks: object, command(args: string[]): string[], status(): object,
 *   banner(): string, stop(): void, end(): Promise<void> }}
 */
export function startTlink({ enabled = true, file, interactive, ask, sessionId, print, audit = () => {}, fetchImpl,
  clientOptions = {}, ttlMs = PROMPT_TTL_MS }) {
  if (!enabled) return null;
  const pairing = readPairing({ file });
  if (!pairing) return null;
  const events = createEventLog();
  const grant = createGrant();
  const say = (line) => {
    try {
      print(line);
    } catch {
      // printing must never break a job
    }
  };
  let current = null;
  let wasOn = false;
  let saidOffline = false;

  // One line per change the user needs to know about: offline once (not every retry), back on, or stopped for a reason
  // he did not cause
  function onStatus(status, why) {
    if (status === 'stopped') {
      if (!LOCAL_STOPS.has(why)) say(`[T-LINK off: ${why}]`);
    } else if (status === 'offline' && wasOn && !saidOffline) {
      saidOffline = true;
      say(`[T-LINK: ${why}]`);
    } else if (status === 'on') {
      if (saidOffline) say('[T-LINK reconnected]');
      saidOffline = false;
      wasOn = true;
    }
  }
  /** A hook feeds the phone; it must never throw into the job that called it. */
  const safe = (fn) => (...a) => {
    try {
      fn(...a);
    } catch {
      // a line the phone does not get is better than a job that breaks
    }
  };

  function connect() {
    let phone = null;
    const client = createTlinkClient({ pairing, sessionId, events, fetchImpl, onStatus,
      snapshotPrompts: () => phone?.openEvents() ?? [], ...clientOptions });
    phone = createPhoneApprovals({ client, events, grant, sessionId, ttlMs, onAudit: (a) => {
      const line = auditLine(a);
      say(line);
      audit(line);
    }, onNotice: (line) => say(`[T-LINK] ${line}`) });
    current = { client, wrapped: interactive ? phone.wrap(ask) : null };
    client.start();
  }
  connect();

  // The askers always go through whichever connection is current (/tlink off then on makes a new one)
  const askers = interactive ? {
    pay: (...a) => current.wrapped.pay(...a),
    publish: (...a) => current.wrapped.publish(...a),
    change: (...a) => current.wrapped.change(...a),
    remember: (...a) => current.wrapped.remember(...a),
    site: (...a) => current.wrapped.site(...a)
  } : null;

  const statusLines = () => {
    const { status, reason } = current.client.status();
    return [
      `T-LINK: ${status}${reason ? ` (${reason})` : ''}  ·  ${pairing.deviceId}, key ${maskToken(pairing.token)}  ·  watch at ${pairing.origin}/tlink`,
      `phone Yes: ${grant.active() ? `on for ${hm(grant.remainingMs())} (changes, sites, memories)` : 'off - the phone can only say No (/tlink allow-yes 2h)'}`
    ];
  };

  return {
    askers,
    hooks: {
      turnStart: safe((task) => events.turnStart(task)),
      toolStart: safe((name, args) => events.step(name, args)),
      toolEnd: safe((name, result) => {
        events.stepDone(name, result);
        if (name === 'todo_write' && result?.status === 'success') events.checklist(result.data?.items);
      }),
      answer: safe((text) => events.answer(text)),
      spend: safe((s) => events.spend(s))
    },
    /** /tlink [status | on | off | allow-yes <window> | revoke-yes] -> the lines to print */
    command([sub = 'status', value] = []) {
      switch (sub) {
        case 'status':
          return statusLines();
        case 'off':
          current.client.stop('turned off at the terminal');
          return ['T-LINK is off for this session (/tlink on to start it again).'];
        case 'on':
          if (current.client.status().status !== 'stopped') return [`T-LINK is already ${current.client.status().status}.`];
          connect();
          return ['T-LINK starting...'];
        case 'allow-yes': {
          const ms = parseWindow(value);
          if (!ms) return ['Usage: /tlink allow-yes 2h   (or 30m, 90, 1h30m - up to 12h)'];
          grant.allow(ms);
          return [`Your phone can say Yes to file changes, new sites and memories for ${hm(ms)}.`,
            'Money clicks and pushes still need the keyboard. /tlink revoke-yes ends it now.'];
        }
        case 'revoke-yes':
          grant.revoke();
          return ['Phone Yes is off: your phone can only say No.'];
        default:
          return ['/tlink  ·  /tlink on | off  ·  /tlink allow-yes 2h  ·  /tlink revoke-yes'];
      }
    },
    status: () => current.client.status(),
    banner: () => `T-LINK on: your phone can watch at ${pairing.origin}/tlink - it can only say No until you /tlink allow-yes 2h. /tlink off to stop.`,
    stop: () => current.client.stop('quantess closed'),
    /** Tell the site the session is over, without ever holding quantess up for long. */
    end: async () => {
      let timer;
      try {
        await Promise.race([current.client.end(), new Promise((r) => { timer = setTimeout(r, END_WAIT_MS); })]);
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

/** --doctor's T-LINK line: unpaired is fine (optional); a PC the site forgot must go red. */
export function tlinkCheck(pairing, probe) {
  const label = 't-link';
  if (!pairing) return { level: 'ok', label, detail: 'not paired (optional: quantess --tlink-pair links your phone)' };
  const who = `${pairing.deviceId}, key ${maskToken(pairing.token)}`;
  if (probe?.status === 200) return { level: 'ok', label, detail: `paired (${who}); the site knows this PC` };
  if (probe?.status === 401 || probe?.status === 403) {
    return { level: 'fail', label, detail: `the site no longer knows this PC (${who}): run quantess --tlink-pair` };
  }
  return { level: 'warn', label, detail: `paired (${who}) but the site did not answer: ${probe?.error ?? probe?.status ?? 'no reply'}` };
}

/** Ask the site whether it still knows this PC (for --doctor). */
export async function probeTlink({ file, fetchImpl = fetch } = {}) {
  const pairing = readPairing({ file });
  if (!pairing) return { pairing: null, probe: null };
  try {
    const res = await fetchImpl(`${pairing.origin}${PATHS.whoami}`, {
      headers: { authorization: `Bearer ${pairing.token}` }, redirect: 'error', signal: AbortSignal.timeout(10_000)
    });
    await res.body?.cancel().catch(() => {});
    return { pairing, probe: { status: res.status } };
  } catch (err) {
    // The reason is shown in --doctor: one short plain line, never whatever the network layer put in it
    return { pairing, probe: { error: String(err?.cause?.code ?? err?.name ?? 'error').replace(/[^\w .:-]/g, '').slice(0, 60) } };
  }
}
