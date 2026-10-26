// T-LINK approvals (approval protocol): each y/n question races the terminal, the phone and -
// with T-LINK on - a deadline. The terminal's answer is taken exactly as before (yes / always / no). The phone's only
// within the CLI's own policy (src/tlink/policy.js): No any time; Yes to a change, site or memory only inside a window
// the user granted at the keyboard; money and push never. Nobody answering by the deadline is "no".
import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import { describePrompt } from './describe.js';
import { judgeRemote } from './policy.js';
import { firstAnswer } from './race.js';
import { memoryPreview } from '../memory.js';

export const ALWAYS_NOTICE = 'Always picked at the keyboard: steps like this now run without asking for the rest of this ' +
  "session, so your phone won't be asked. (Yes approves just one.)";

/**
 * @param {{
 *   client: { connected(): boolean, subscribe(fn: Function): () => void, flush(): void },
 *   events: ReturnType<import('./events.js').createEventLog>,
 *   grant: ReturnType<import('./policy.js').createGrant>,
 *   sessionId: () => string,
 *   ttlMs?: number, now?: () => number, randomId?: () => string,
 *   onAudit?: (a: { kind: string, promptId: string, by: string, answer: unknown, text: string }) => void,
 *   onNotice?: (line: string) => void
 * }} options
 */
export function createPhoneApprovals({ client, events, grant, sessionId, ttlMs = 600_000, now = () => performance.now(),
  randomId = randomUUID, onAudit = () => {}, onNotice = () => {} }) {
  const open = new Map();          // promptId -> { event, deadline }: every question still waiting (two can overlap)
  const quietly = (fn) => {
    try {
      fn();
    } catch {
      // telling the phone must never change the answer
    }
  };

  /** One question: the terminal alone when T-LINK is off (or the phone side cannot be set up), otherwise the race. */
  async function decide(kind, args, terminal) {
    if (!client.connected()) return { answer: await terminal(undefined), by: 'terminal' };
    let state;
    let prompt;
    try {
      prompt = describePrompt(kind, args);
      const promptId = randomId();
      const session = sessionId();
      const deadline = now() + ttlMs;
      const { event, exact, textHash } = events.promptOpen({ promptId, sessionId: session, prompt, ttlMs, grantActive: grant.active() });
      open.set(promptId, { event, deadline });
      state = { promptId, sessionId: session, textHash, kind, exact, deadline, consumed: new Set() };
      client.flush();
    } catch {
      if (state) {
        open.delete(state.promptId);
        quietly(() => events.promptClosed(state.promptId, 'off', 'no'));
      }
      return { answer: await terminal(undefined), by: 'terminal' };
    }
    let closed = false;
    try {
      const result = await firstAnswer({
        terminal, subscribe: client.subscribe, timeoutMs: ttlMs,
        judge: (msg) => judgeRemote(msg, state, { grant, now })
      });
      quietly(() => events.promptClosed(state.promptId, result.by, result.answer));
      // 10-24 live: Always on the first render meant the rest never asked, and the phone just went quiet - say so
      if (kind === 'change' && result.by === 'terminal' && result.answer === 'always') {
        quietly(() => events.notice(ALWAYS_NOTICE));
        quietly(() => onNotice(ALWAYS_NOTICE));
      }
      closed = true;
      quietly(() => client.flush());
      if (result.by !== 'terminal') quietly(() => onAudit({ kind, promptId: state.promptId, by: result.by, answer: result.answer, text: prompt.text }));
      return result;
    } finally {
      // A terminal question that failed (stdin closed...) still takes the question off the phone
      if (!closed) {
        quietly(() => events.promptClosed(state.promptId, 'off', 'no'));
        quietly(() => client.flush());
      }
      open.delete(state.promptId);
    }
  }

  // The terminal's own answer as before; the phone's or the deadline's mapped to yes / no only (never "always")
  const asYes = (r) => (r.by === 'terminal' ? r.answer === true : r.answer === 'yes');
  const asChoice = (r) => (r.by === 'terminal' ? (r.answer ?? 'no') : r.answer === 'yes' ? 'yes' : 'no');

  return {
    /** The five askers (src/askUser.js), each now answerable from the phone too. Same signatures and answers. */
    wrap(ask) {
      return {
        pay: async (label, opts = {}) => asYes(await decide('pay', { label, count: opts.count ?? 1 },
          (signal) => ask.pay(label, { ...opts, signal }))),
        publish: async (cmd, opts = {}) => asYes(await decide('publish', { cmd }, (signal) => ask.publish(cmd, { ...opts, signal }))),
        change: async (name, text, opts = {}) => asChoice(await decide('change', { text, complete: opts.complete !== false },
          (signal) => ask.change(name, text, { ...opts, signal }))),
        site: async (site, url, opts = {}) => asChoice(await decide('site', { site, url }, (signal) => ask.site(site, url, { ...opts, signal }))),
        async remember(memory, opts = {}) {
          let preview;
          try {
            preview = memoryPreview(memory);
          } catch {
            return false;
          }
          return asYes(await decide('memory', preview, (signal) => ask.remember(memory, { ...opts, signal })));
        }
      };
    },
    /** Every open question, each with the time it has left (re-posted after the site restarts). */
    openEvents: () => [...open.values()].map(({ event, deadline }) => ({ ...event, ttlMs: Math.max(0, Math.round(deadline - now())) }))
  };
}
