// T-LINK: what the phone sees. Only the summary lines the user already sees in the
// terminal leave the PC - never a tool's data - each one redacted (paths shortened, secrets scrubbed) and capped.
// The queue is bounded: if the site is unreachable for a long job, the oldest lines go and the phone is told.
import { toolLine, resultLine, checklistLines } from '../activity.js';
import { forPhone } from './redact.js';
import { hashText } from './describe.js';
import { phoneChoices } from './policy.js';

export const CAPS = Object.freeze({ line: 200, checklistItems: 30, checklistLine: 120, task: 500, answer: 8192,
  prompt: 6144, queue: 500 });

const BY = new Set(['terminal', 'phone', 'timeout', 'off']);
const num = (v) => (Number.isFinite(v) ? Math.round(v * 10_000) / 10_000 : 0);

/**
 * @param {{ redact?: typeof forPhone, now?: () => number, queueCap?: number }} [options]
 */
export function createEventLog({ redact = forPhone, now = Date.now, queueCap = CAPS.queue } = {}) {
  let seq = 0;
  let dropped = 0;
  const queue = [];
  const text = (value, cap) => redact(String(value ?? ''), { cap }).text;
  const push = (type, body) => {
    seq += 1;
    const event = { seq, at: now(), type, ...body };
    queue.push(event);
    while (queue.length > queueCap) {
      queue.shift();
      dropped += 1;
    }
    return event;
  };

  return {
    turnStart: (task) => push('turn', { task: text(task, CAPS.task) }),
    step: (name, args) => push('step', { line: text(toolLine(name, args), CAPS.line) }),
    stepDone: (name, result) => push('result', { line: text(resultLine(result), CAPS.line), ok: result?.status !== 'error' }),
    checklist: (items) => {
      const all = checklistLines(items);
      return push('checklist', {
        lines: all.slice(0, CAPS.checklistItems).map((line) => text(line, CAPS.checklistLine)),
        more: Math.max(0, all.length - CAPS.checklistItems)
      });
    },
    spend: ({ today, cap, turn } = {}) => push('spend', { today: num(today), cap: num(cap), turn: num(turn) }),
    answer: (value) => push('answer', { text: text(value, CAPS.answer) }),
    /** A line quantess itself has to tell the user (no tool behind it), shown like a step. */
    notice: (line) => push('step', { line: text(line, CAPS.line) }),

    /**
     * A y/n question for the phone. textHash binds the ORIGINAL text (what the terminal shows); exact is false when
     * the phone's copy lost anything, which makes it No-only.
     */
    promptOpen({ promptId, sessionId, prompt, ttlMs, grantActive }) {
      const shown = redact(prompt.text, { cap: CAPS.prompt });
      const exact = shown.exact && prompt.complete === true;
      const textHash = hashText(prompt.text);
      const event = push('prompt_open', { promptId, sessionId, kind: prompt.kind, text: shown.text, exact, textHash,
        choices: phoneChoices(prompt.kind, { exact, grantActive }), ttlMs });
      return { event, exact, textHash };
    },
    promptClosed: (promptId, by, answer) => push('prompt_closed', {
      promptId,
      by: BY.has(by) ? by : 'terminal',
      answer: answer === 'yes' || answer === 'always' || answer === true ? 'yes' : 'no'
    }),

    /** Up to max events, oldest first, with a "dropped" marker first when the queue overflowed. */
    take(max = 50) {
      const out = queue.splice(0, max);
      if (dropped) {
        // No seq: the server dedupes by seq, and this marker must never collide with a real event
        out.unshift({ at: now(), type: 'dropped', count: dropped });
        dropped = 0;
      }
      return out;
    },
    pending: () => queue.length
  };
}
