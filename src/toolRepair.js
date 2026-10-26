// Free models write tool arguments that are ALMOST JSON. One bad call used to stay in the history and make
// the provider refuse every later request: a 10-19 game-build job died on a Windows path with a single
// backslash ("Bad escaped character"), then "400 Provider returned error" on every message after it.
// Everything here returns new objects; nothing mutates the history it is given.

const BACKSLASH = '\\';
const SIMPLE_ESCAPES = new Set(['"', BACKSLASH, '/', 'b', 'f', 'n', 'r', 't']);
// Where a Windows path run ends inside a string ("C:\Program Files" stops at the space: a known limit)
const PATH_END = new Set(['"', ' ', '\t', '\n', '\r', ',', ';', '|', '&', ')', "'", '<', '>']);
// In the RAW text: a drive path written with single backslashes, either as a path-named field
// ("cwd": "C:\temp") or anywhere with two or more separators ("cd C:\Users\riley"). Read from the raw
// text, never the parsed value: "A: hello\nB: world" is valid content and must never look like a path.
const PATH_FIELD_LONE = /"(?:file_?path|path|cwd|file|dir|directory|folder|root|target|dest|destination|src|source|output|out|workspace)"\s*:\s*"[A-Za-z]:\\(?![\\"])/i;
const LONE_DRIVE_PATH = /(?:^|[^A-Za-z0-9])[A-Za-z]:\\(?![\\"])[^"\s\\]*\\(?![\\"])/;
const hasLonePath = (text) => PATH_FIELD_LONE.test(text) || LONE_DRIVE_PATH.test(text);
const CUT_OFF = 'The tool call was cut off at the token limit before its arguments ended. Nothing was run. Send it again in smaller pieces.';

function tryParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, err };
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const usable = (parsed) => parsed.ok && isObject(parsed.value);

/** Apply `fn` to the text OUTSIDE string literals only (escaped quotes inside strings are honoured). */
function outsideStrings(text, fn) {
  let out = '';
  let segment = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '"') {
      segment += text[i++];
      continue;
    }
    out += fn(segment);
    segment = '';
    let j = i + 1;
    while (j < text.length && text[j] !== '"') j += text[j] === BACKSLASH ? 2 : 1;
    out += text.slice(i, j + 1);
    i = j + 1;
  }
  return out + fn(segment);
}

/**
 * Inside a Windows path run (a drive letter, ":" and a backslash, up to a space, quote or shell
 * separator), every single backslash is a path separator - anywhere in a string, so "cd C:\Users\riley"
 * keeps its \r. Only runs when the raw text really holds such a path (see hasLonePath).
 */
function escapePathBackslashes(text) {
  if (!hasLonePath(text)) return text;
  let out = '';
  let inString = false;
  let inPath = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    const startsDrive = /[A-Za-z]/.test(ch) && text[i + 1] === ':' && text[i + 2] === BACKSLASH;
    if (!inPath && startsDrive && !/[A-Za-z0-9]/.test(text[i - 1] ?? '')) inPath = true;
    if (ch === BACKSLASH) {
      const next = text[i + 1];
      if (inPath && next !== BACKSLASH && next !== '"') {
        out += BACKSLASH + BACKSLASH;
      } else {
        // an escape pair (or an already doubled separator): kept exactly as sent
        out += ch + (next ?? '');
        i++;
      }
      continue;
    }
    if (ch === '"') {
      inString = false;
      inPath = false;
    } else if (inPath && PATH_END.has(ch)) {
      inPath = false;
    }
    out += ch;
  }
  return out;
}

/** Inside any string, a backslash that does not start a valid JSON escape is taken literally. */
function escapeLoneBackslashes(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }
    if (ch !== BACKSLASH) {
      out += ch;
      continue;
    }
    const next = text[i + 1];
    if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
      out += text.slice(i, i + 6);
      i += 5;
    } else if (next !== undefined && SIMPLE_ESCAPES.has(next)) {
      out += ch + next;
      i++;
    } else {
      out += BACKSLASH + BACKSLASH;
    }
  }
  return out;
}

const stripFence = (text) => text.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1');
const dropTrailingCommas = (text) => outsideStrings(text, (s) => s.replace(/,(\s*[}\]])/g, '$1'));
const pythonLiterals = (text) =>
  outsideStrings(text, (s) => s.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null'));
const singleQuotes = (text) => (text.includes('"') ? text : text.replace(/'/g, '"'));

// Applied in order, each on top of the last, stopping at the first text that parses into usable arguments
const REPAIRS = [
  ['removed a code fence', stripFence],
  ['doubled the single backslashes in a Windows path', escapePathBackslashes],
  ['escaped stray backslashes', escapeLoneBackslashes],
  ['removed trailing commas', dropTrailingCommas],
  ['turned Python True/False/None into JSON', pythonLiterals],
  ['turned single quotes into double quotes', singleQuotes]
];

/**
 * Parse a tool call's arguments, repairing the slips models make.
 * @param {unknown} raw the call's `arguments` (usually a string)
 * @param {{ truncated?: boolean }} [opts] truncated: the reply stopped at the token limit
 * @returns {{ args: object, json: string, repairs: string[] } | { error: string }}
 *   json is what goes back into the history (always valid); repairs names each fix, [] when none was needed.
 */
export function repairToolArgs(raw, { truncated = false } = {}) {
  if (isObject(raw)) return { args: raw, json: JSON.stringify(raw), repairs: [] };
  const text = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!text) return { args: {}, json: '{}', repairs: [] };

  const strict = tryParse(text);
  // Valid JSON is taken as sent - unless the raw text holds a single-backslash path, which can parse
  // "cleanly" into control characters ("C:\temp\new.txt" -> C:<TAB>emp<NEWLINE>ew.txt)
  if (usable(strict) && !hasLonePath(text)) return { args: strict.value, json: text, repairs: [] };
  // A cut-off write_file "repaired" into valid JSON would write half a file
  if (truncated && !strict.ok) return { error: CUT_OFF };

  let current = text;
  const repairs = [];
  for (const [name, fix] of REPAIRS) {
    const next = fix(current);
    if (next === current) continue;
    current = next;
    repairs.push(name);
    if (usable(tryParse(current))) return { args: JSON.parse(current), json: current, repairs };
  }
  const why = strict.ok ? (isObject(strict.value) ? 'a Windows path lost its backslashes' : 'arguments must be a JSON object') : strict.err.message;
  return { error: `Tool arguments were not valid JSON (${why}). Resend the call with valid JSON.` };
}

const noResult = (id) => ({
  role: 'tool',
  tool_call_id: id,
  content: JSON.stringify({ status: 'error', summary: 'No result was recorded for this call.' })
});

/**
 * The history as a provider will accept it: every tool call's arguments parse, every call has exactly one
 * reply directly after it, orphan replies and empty assistant turns are gone. Replies are matched by id
 * within the block after each call (providers reuse ids like call_0 across turns).
 * @param {object[]} messages
 * @returns {object[]} a new array; unchanged messages are reused, changed ones are copies
 */
export function sanitizeHistory(messages) {
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'tool') continue;
    const calls = m.role === 'assistant' ? m.tool_calls ?? [] : [];
    if (m.role === 'assistant' && !calls.length && !String(m.content ?? '').trim()) continue;
    if (!calls.length) {
      out.push(m);
      continue;
    }
    const fixedCalls = calls.map((tc) => {
      const fixed = repairToolArgs(tc.function?.arguments);
      const json = fixed.error ? '{}' : fixed.json;
      return json === tc.function?.arguments ? tc : { ...tc, function: { ...tc.function, arguments: json } };
    });
    out.push(fixedCalls.every((tc, k) => tc === calls[k]) ? m : { ...m, tool_calls: fixedCalls });

    const replies = [];
    let j = i + 1;
    while (j < messages.length && messages[j].role === 'tool') replies.push(messages[j++]);
    const used = new Set();
    for (const tc of fixedCalls) {
      const k = replies.findIndex((r, idx) => !used.has(idx) && r.tool_call_id === tc.id);
      if (k >= 0) {
        used.add(k);
        out.push(replies[k]);
      } else {
        out.push(noResult(tc.id));
      }
    }
    i = j - 1;
  }
  return out;
}

const clipText = (value, n) => {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

// Tools whose results quote outside text (web pages, the browser, a command's output): written into an
// assistant turn, an injected "ignore your instructions" would read as the model's own words.
const OUTSIDE_TEXT_TOOL = /^(browser_|web_|fetch|youtube|screenshot|run_shell)/;

/** What an old step returned, in words safe to keep as the model's own: our tool's status and summary only. */
function trustedOutcome(name, content) {
  if (OUTSIDE_TEXT_TOOL.test(String(name ?? ''))) return 'result not kept (outside text)';
  const parsed = tryParse(String(content ?? ''));
  if (!parsed.ok || !isObject(parsed.value) || typeof parsed.value.status !== 'string') return 'result not kept';
  const { status, summary } = parsed.value;
  return summary ? `${status}: ${clipText(summary, 200)}` : status;
}

/**
 * Last resort when a provider still refuses the history: older tool steps become plain assistant text
 * (what was called, what came back), so nothing tool-shaped is left for it to reject. The newest
 * `keepTurns` steps stay whole so the job can carry on.
 * @param {object[]} messages
 * @param {{ keepTurns?: number, maxChars?: number }} [opts]
 * @returns {object[]} a new array
 */
export function collapseOldToolTurns(messages, { keepTurns = 2, maxChars = 400 } = {}) {
  const steps = messages.flatMap((m, i) => (m.role === 'assistant' && m.tool_calls?.length ? [i] : []));
  const collapse = new Set(steps.slice(0, Math.max(0, steps.length - keepTurns)));
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!collapse.has(i)) {
      out.push(m);
      continue;
    }
    const replies = [];
    let j = i + 1;
    while (j < messages.length && messages[j].role === 'tool') replies.push(messages[j++]);
    const lines = m.tool_calls.map((tc, k) => {
      const reply = replies.find((r) => r.tool_call_id === tc.id) ?? replies[k];
      const outcome = reply ? trustedOutcome(tc.function?.name, reply.content) : 'no result';
      return `${tc.function?.name} ${clipText(tc.function?.arguments, 200)} -> ${clipText(outcome, maxChars)}`;
    });
    const text = `${m.content ? `${m.content}\n` : ''}[earlier step, kept as text]\n${lines.join('\n')}`;
    const prev = out[out.length - 1];
    // Back-to-back collapsed steps share one message
    if (prev?.role === 'assistant' && prev.collapsed) out[out.length - 1] = { ...prev, content: `${prev.content}\n${text}` };
    else out.push({ role: 'assistant', content: text, collapsed: true });
    i = j - 1;
  }
  return out.map((m) => {
    if (!m.collapsed) return m;
    const { collapsed, ...rest } = m;
    return rest;
  });
}
