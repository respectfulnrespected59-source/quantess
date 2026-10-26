// What the user sees while Q23 works: one line per tool call and one per result, the way Claude Code
// shows its steps. Without it a long job looked like a frozen terminal and a wrong turn went unseen.

const WIDTH = 96;

// Terminal escape sequences (CSI, incl. the one-byte C1 form, and OSC), then any control character left.
// Arguments come from the model and summaries can quote a web page: either could clear the line and
// print a fake "✓ pushed".
// CSI | OSC (7- or 8-bit, only when terminated, length-bounded) | DCS/SOS/PM/APC (only when terminated) |
// any other ESC with one Fe byte. Unterminated string sequences lose just their introducer, never the text after.
const ESCAPE_SEQUENCE = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|(?:\u001b\]|\u009d)[^\u0007\u001b\u009c]{0,512}(?:\u0007|\u009c|\u001b\\)|(?:\u001b[PX^_]|[\u0090\u0098\u009e\u009f])[\s\S]{0,4096}?(?:\u001b\\|\u009c)|\u001b[@-_]?/g;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/** A whole answer for the terminal: line breaks and tabs stay, escape sequences and other control codes go. */
export function safeText(value) {
  return String(value ?? '').replace(ESCAPE_SEQUENCE, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

/** One line of text, cut with an ellipsis so it never wraps across the terminal. */
function clip(value, width = WIDTH) {
  const text = String(value ?? '').replace(/\s+/g, ' ').replace(ESCAPE_SEQUENCE, '').replace(CONTROL_CHARS, '').trim();
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

/**
 * @param {string} name tool name
 * @param {Record<string, unknown>} [args] the call's parsed arguments
 * @returns {string}
 */
export function toolLine(name, args = {}) {
  const a = args ?? {};
  const file = a.filepath ?? '?';
  switch (name) {
    case 'read_file':
      return clip(`read ${file}${a.startLine ? `:${a.startLine}-${a.endLine ?? ''}` : ''}`);
    case 'write_file':
      return clip(`write ${file}`);
    case 'edit_file':
      return clip(`edit ${file}`);
    case 'run_shell':
      if (a.background === true) return clip(`start ${clip(a.cmd, 70)} (background)`);
      return clip(`run ${clip(a.cmd, 70)}${a.cwd ? ` (in ${a.cwd})` : ''}`);
    case 'job_output':
      return clip(`check ${a.id ?? 'jobs'}`);
    case 'job_stop':
      return clip(`stop ${a.id ?? '?'}`);
    case 'list_files':
      return clip(`list ${a.pattern ?? '?'}`);
    case 'grep':
      return clip(`grep "${clip(a.pattern, 40)}"${a.globPattern ? ` in ${a.globPattern}` : ''}`);
    case 'load_skill':
      return clip(`skill ${a.name ?? '?'}`);
    case 'find_skill':
      return clip(`find skill "${clip(a.query, 50)}"`);
    case 'look_at_image':
      return clip(`look at ${file}: ${clip(a.question, 50)}`);
    case 'screenshot_page':
      return clip(`screenshot ${a.url ?? '?'}`);
    case 'web_search':
      return clip(`search "${clip(a.query, 70)}"`);
    case 'web_fetch':
      return clip(`fetch ${a.url ?? '?'}`);
    case 'youtube_transcript':
      return clip(`youtube ${a.url ?? '?'}`);
    case 'notebooklm_pack':
      return clip(`notebooklm pack "${clip(a.title, 50)}" (${Array.isArray(a.sources) ? a.sources.length : 0} sources)`);
    case 'todo_write':
      return clip(`plan (${Array.isArray(a.items) ? a.items.length : 0} steps)`);
    case 'remember':
      return clip(`remember ${a.name ?? '?'}`);
    case 'recall':
      return clip(`recall "${clip(a.query, 60)}"`);
    case 'delegate':
      return clip(`delegate to ${a.agent ?? '?'}: ${clip(a.task, 60)}`);
    default:
      if (!name) return '(no tool name)';
      if (a.url) return clip(`${name} ${a.url}`);
      if (a.element) return clip(`${name} "${clip(a.element, 50)}"`);
      return clip(name);
  }
}

// A write up to this many lines is shown whole; a longer one shows its start and end and is marked incomplete
const WHOLE_FILE_LINES = 200;
const HEAD_LINES = 100;
const TAIL_LINES = 50;
// Control characters (except line break and tab) and invisible Unicode (format characters such as bidi overrides
// and zero-width spaces; line and paragraph separators). In an approval they are SHOWN as escapes, never deleted:
// what runs must be what was shown (security review 10-23)
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/gu;
const HAS_HIDDEN = new RegExp(HIDDEN.source, 'u');

const escapeHidden = (ch) => {
  const code = ch.codePointAt(0);
  return code < 0x100 ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u{${code.toString(16)}}`;
};
/** Every hidden character shown as an escape: for any text a y/n question puts in front of the user. */
export const visible = (value) => String(value ?? '').replace(HIDDEN, escapeHidden);
/** visible() for a ONE-line question: a line break or tab is shown too, so it cannot fake a second line or a "(y/N)". */
export const visibleLine = (value) => visible(value).replace(/[\n\t]/g, escapeHidden);

function describeChange(name, a) {
  switch (name) {
    case 'run_shell': {
      const how = a.background === true ? 'start this command in the background' : 'run this command';
      const limit = a.background !== true && Number(a.timeout) > 0 ? ` (may run up to ${Math.round(Number(a.timeout) / 60_000)} min)` : '';
      return { text: `${how}${a.cwd ? ` in ${visible(a.cwd)}` : ''}${limit}:\n${visible(a.cmd)}`, complete: true };
    }
    case 'write_file': {
      const lines = visible(a.content).split('\n');
      const head = `write ${visible(a.filepath)} (${lines.length} lines):\n`;
      if (lines.length <= WHOLE_FILE_LINES) return { text: head + lines.join('\n'), complete: true };
      const middle = lines.length - HEAD_LINES - TAIL_LINES;
      return {
        text: `${head}${lines.slice(0, HEAD_LINES).join('\n')}\n… ${middle} lines in the middle not shown …\n${lines.slice(-TAIL_LINES).join('\n')}`,
        complete: false
      };
    }
    case 'edit_file':
      return {
        text: `edit ${visible(a.filepath)}${a.replaceAll ? ' (every match)' : ''}:\n` +
          `- ${visible(a.oldString).replace(/\n/g, '\n- ')}\n+ ${visible(a.newString).replace(/\n/g, '\n+ ')}`,
        complete: true
      };
    case 'notebooklm_pack':
      return { text: `write a NotebookLM pack "${visible(a.title)}" with ${Array.isArray(a.sources) ? a.sources.length : 0} sources into ${visible(a.dir || '.')}`, complete: true };
    default:
      // An MCP tool (or anything else under --ask): its whole arguments, since it can do anything
      return { text: `call ${visible(name)} with:\n${visible(JSON.stringify(a, null, 2))}`, complete: true };
  }
}

/**
 * What an --ask approval shows: the whole command or change, every hidden character made visible, background and
 * timeout said out loud (security review 10-23). complete is false when part of it could not be shown.
 * @returns {{ text: string, complete: boolean }}
 */
export function approvalText(name, args = {}) {
  const a = args ?? {};
  const change = describeChange(name, a);
  const hidden = Object.values(a).some((v) => typeof v === 'string' && HAS_HIDDEN.test(v));
  const warning = hidden ? '⚠ this step holds hidden characters, shown below as \\x.. / \\u{..} - read it closely\n' : '';
  return { text: warning + change.text, complete: change.complete };
}

const CHECK = { done: '☑', in_progress: '◐', pending: '☐' };

/** The plan from todo_write as checklist lines, control codes stripped. */
export function checklistLines(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => `${CHECK[item?.status] ?? '☐'} ${clip(safeText(item?.text), 90)}`);
}

/**
 * @param {{ status?: string, summary?: string } | null} result a tool result
 * @returns {string}
 */
export function resultLine(result) {
  const failed = result?.status === 'error';
  return `${failed ? '✗' : '✓'} ${clip(result?.summary || (failed ? 'failed' : 'done'), 110)}`;
}
