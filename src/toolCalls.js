/**
 * Helpers for the agent's tool-call step, kept pure so they can be tested without a model.
 */

const STUB_NOTE = '[older page dropped to save context: act on the NEWEST snapshot]';
const STUB_HEAD_CHARS = 600;
const SNAPSHOT = '### Snapshot';

/**
 * Free models sometimes send arguments that are not valid JSON. Return the problem to the
 * model so it can resend, instead of throwing (a throw burned a fallback model per bad call).
 * @returns {{ args: object } | { error: string }}
 */
export function parseToolArgs(raw) {
  if (raw && typeof raw === 'object') return { args: raw };
  if (raw === undefined || raw === null || String(raw).trim() === '') return { args: {} };
  try {
    return { args: JSON.parse(raw) ?? {} };
  } catch (err) {
    return { error: `Tool arguments were not valid JSON (${err.message}). Resend the call with valid JSON.` };
  }
}

function stub(content) {
  // Keep what happened and where (everything before the snapshot), drop the snapshot and its refs.
  return `${content.split(SNAPSHOT)[0].slice(0, STUB_HEAD_CHARS)} ${STUB_NOTE}`;
}

/**
 * Every browser action returns a full page snapshot. Ten of them would fill a free model's
 * context, and old refs are stale anyway, so only the newest page stays whole.
 *
 * Results are matched by message object, not tool_call_id: some providers reuse ids
 * (call_0 every turn). Only results that carry a snapshot are shrunk, so data the model
 * pulled out (browser_find, browser_tabs) survives. Returns a new array.
 *
 * @param {object[]} messages
 * @param {WeakSet<object>} browserResults tool messages that came from a browser call
 * @param {object} keep the newest browser result
 */
export function stubStaleBrowserResults(messages, browserResults, keep) {
  return messages.map((m) => {
    if (m === keep || !browserResults.has(m)) return m;
    const content = String(m.content);
    if (!content.includes(SNAPSHOT) || content.includes(STUB_NOTE)) return m;
    return { ...m, content: stub(content) };
  });
}

export const TRIM_NOTE = '[older tool result dropped to save context: run the tool again if you need it]';
const TRIM_HEAD_CHARS = 400;

// ~100k tokens of history. The default free model holds 256k; the rest is the reply and headroom.
export const HISTORY_BUDGET_CHARS = 400_000;
export const KEEP_WHOLE_TOOL_RESULTS = 8;

const DROPPED_ARGS = JSON.stringify({ note: 'old arguments dropped to save context' });
const BIG_ARGS_CHARS = 1000;

const argsSize = (m) => (m.tool_calls || []).reduce((n, tc) => n + String(tc.function?.arguments ?? '').length, 0);

/** Old tool calls whose arguments were big (a write_file payload), with the arguments dropped. */
function dropBigArgs(m) {
  return {
    ...m,
    tool_calls: m.tool_calls.map((tc) => (String(tc.function?.arguments ?? '').length > BIG_ARGS_CHARS
      ? { ...tc, function: { ...tc.function, arguments: DROPPED_ARGS } }
      : tc))
  };
}

/**
 * A day of game work is hundreds of reads, edits and test runs. Once the history passes the
 * budget, older entries shrink, oldest first, until it fits: tool results to their first lines
 * (what was called and how it went), big tool-call arguments (write_file payloads) to a note.
 * Everything from the newest `keepWhole` tool results on stays whole, as do user messages and
 * anything `protect` says to keep (browser pages: their refs live in the snapshot, and
 * stubStaleBrowserResults already shrinks old ones). Returns the same array when nothing needs
 * trimming, else a new one.
 *
 * @param {object[]} messages
 * @param {{ budget?: number, keepWhole?: number, protect?: (m: object) => boolean }} [options]
 */
export function trimOldToolResults(messages, {
  budget = HISTORY_BUDGET_CHARS, keepWhole = KEEP_WHOLE_TOOL_RESULTS, protect = () => false
} = {}) {
  const size = (m) => String(m.content ?? '').length + argsSize(m);
  let total = messages.reduce((n, m) => n + size(m), 0);
  if (total <= budget) return messages;

  const toolIdx = messages.flatMap((m, i) => (m.role === 'tool' ? [i] : []));
  const cutoff = toolIdx.length > keepWhole ? toolIdx[toolIdx.length - keepWhole] : (toolIdx[0] ?? messages.length);
  const out = [...messages];
  for (let i = 0; i < cutoff && total > budget; i++) {
    const m = out[i];
    if (protect(m)) continue;
    let next = m;
    if (m.role === 'tool') {
      const content = String(m.content ?? '');
      if (!content.includes(TRIM_NOTE) && content.length > TRIM_HEAD_CHARS) {
        next = { ...m, content: `${content.slice(0, TRIM_HEAD_CHARS)} ${TRIM_NOTE}` };
      }
    } else if (m.role === 'assistant' && argsSize(m) > BIG_ARGS_CHARS) {
      next = dropBigArgs(m);
    }
    if (next !== m) {
      total -= size(m) - size(next);
      out[i] = next;
    }
  }
  return out;
}
