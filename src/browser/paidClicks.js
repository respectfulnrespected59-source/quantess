/**
 * Hard stop on buttons that spend money (owner's call, 2026-10-13). On its first real job Q23
 * generated the approved image, then clicked "Upscale 2×" twice on its own. A written rule
 * did not hold a free model, so the action itself is gated: the user approves, Q23 never can.
 */

import { visibleLine } from '../activity.js';

// How much of a paid button's label the question shows
const LABEL_SHOWN = 160;

// Labels that start a paid job or a payment. "Create", "Credits" and "Order history" alone are free.
const PAID_LABEL = new RegExp([
  '\\b(generate|regenerate|upscale|render|bake|animate|buy|purchase|pay|checkout|subscribe|upgrade|donate)\\b',
  '\\bcontinue to payment\\b', '\\b(add|buy|get) credits\\b', '\\btop[ -]?up\\b',
  '\\bstart (free )?trial\\b', '\\b(place|confirm) order\\b'
].join('|'), 'i');

// A Playwright MCP snapshot ref, e.g. e228 or f1e263. Anything else is a selector or text.
const REF = /^(f\d+)?e\d+$/;
const SUBMIT_KEYS = new Set(['enter', 'numpadenter', ' ', 'space']);

let budget = Math.max(0, Number.parseInt(process.env.Q23_PAID_CLICKS ?? '0', 10) || 0);
let approver = null;
// Per task (10-14): the user approved "Generate Image" four times with no way to tell the 4th from the
// 1st, and Q23 generated after the photo upload had failed, so every image was of strangers.
let turn = { paidClicks: 0, failedUpload: null };

const isPaid = (text) => PAID_LABEL.test(String(text ?? ''));

/** Every `"label" ... [ref=X]` on a snapshot, as ref -> label. Escaped quotes stay inside the label. */
export function pageLabels(text) {
  const labels = new Map();
  for (const m of String(text ?? '').matchAll(/"((?:[^"\\\n]|\\.)*)"[^\n]*?\[ref=([a-z0-9]+)\]/gi)) {
    labels.set(m[2], m[1]);
  }
  return labels;
}

function clickLabel(args, labels) {
  const target = String(args?.target ?? '');
  const element = String(args?.element ?? '');
  if (REF.test(target)) {
    // The page's own label wins: the model once called "Upscale 2×" an "Open Full Size button"
    const label = labels.get(target) ?? element;
    return isPaid(label) ? label : null;
  }
  // A selector or text target ("text=Upscale") is judged on its own words as well as the description;
  // the description reads better in the user's y/n question, so it is named first
  if (isPaid(element)) return element;
  return isPaid(target) ? target : null;
}

function submitLabel(name, args, labels) {
  const submits = (name === 'browser_press_key' && SUBMIT_KEYS.has(String(args?.key ?? '').toLowerCase()))
    || (name === 'browser_type' && args?.submit === true);
  if (!submits) return null;
  const paidOnScreen = [...labels.values()].find(isPaid);
  return paidOnScreen ? `Enter/submit while "${paidOnScreen}" is on the page` : null;
}

/**
 * What a call would spend money on, or null. Clicks, plus Enter/Space/submit while a money
 * button is on screen (that can fire it without a click).
 * @param {Map<string,string>|string} labelsOrPage ref -> label, or raw snapshot text
 */
export function paidClickLabel(name, args, labelsOrPage) {
  const labels = typeof labelsOrPage === 'string' ? pageLabels(labelsOrPage) : (labelsOrPage ?? new Map());
  if (name === 'browser_click') return clickLabel(args, labels);
  return submitLabel(name, args, labels);
}

/** `--paid N` at the front of the arguments: N must be a whole number, and the task stays intact. */
export function parsePaidFlag(argv) {
  if (argv[0] !== '--paid') return { budget: null, rest: argv };
  if (!/^\d+$/.test(argv[1] ?? '')) return { error: '--paid needs a number, e.g. quantessq23 --paid 2 "make an image of ..."' };
  return { budget: Number(argv[1]), rest: argv.slice(2) };
}

/**
 * A shell command that would raise Q23's own money or browser limits. Only the user sets those.
 * 10-23: also the daily spending cap, the browser's site list, and the ledger that counts the day's spend.
 */
export function touchesQ23Limits(cmd) {
  // Security review 10-23: also the cap's other spellings, the 8.3 short name, and making a junction or link
  // (a link to ~/.quantess walks past any check on the path's text)
  // T-LINK (10-24): the device key file, by name, wherever it is said; and (review of 22b35f5) wildcard spellings of
  // the folder or the key (~\.q*, tl*) and fsutil hard links. A speed bump, not a wall: a command runs as the user -
  // which is why the key itself can never approve anything (src/tlink/policy.js). Hosted mode: the terminal key file,
  // the agent-shell mark (src/flags.js), and quantess's own sign-in / sign-out / pairing, however it is launched
  return /--paid\b|Q23_PAID_CLICKS|Q23_BROWSER_(ALLOW|UNSAFE|PROFILE)|QUANTESS_(DAILY_CAP\w*|BROWSER_SITES|HOME|TLINK\w*|HOSTED\w*|LOCAL_SITE\w*|AGENT_SHELL\w*)|\bquantess\b[^\n]*(?:\blogin\b|\blogout\b|--tlink-(?:un)?pair)|\.quantess\b|QUANTE~\d|ledger\.json|tlink\.json|terminal-key\.json|[\\/~]\.q[\w?*]*[*?]|\btl[\w.]*[*?]|\bmklink\b|\bfsutil\s+hardlink\b|-ItemType\s+(Junction|SymbolicLink|HardLink)/i
    .test(String(cmd ?? ''));
}

/** Pre-approve this many paid clicks (quantessq23 --paid N). Only the CLI calls this. */
export function setPaidClickBudget(n) {
  budget = Math.max(0, Math.trunc(n) || 0);
}

/** How the CLI asks the user y/n in a terminal; null when nobody is there to ask. */
export function setPaidClickApprover(fn) {
  approver = fn;
}

/** A new task from the user: the paid-click count starts over and an earlier failed upload stops blocking. */
export function startPaidClickTurn() {
  turn = { paidClicks: 0, failedUpload: null };
}

/** Remember whether the latest upload worked. Paying after a failed one makes the wrong thing. */
export function noteToolResult(name, ok, detail) {
  if (name !== 'browser_file_upload') return;
  turn = { ...turn, failedUpload: ok ? null : String(detail ?? 'upload failed') };
}

/** The user's y/n question. From the second click on it says so, so a retry never looks like the first. */
export function paidClickQuestion(label, count = 1) {
  const again = count > 1 ? ` AGAIN: this would be paid click #${count} for this task` : '';
  // The label is the page's own text: escape codes or a line break in it could redraw this question (security
  // review 10-24). A long one is cut, and says so.
  const shown = visibleLine(label);
  const cut = shown.length > LABEL_SHOWN ? `${shown.slice(0, LABEL_SHOWN)}… (label cut)` : shown;
  return `quantess wants to click "${cut}"${again}. That can spend money. Allow this one click?`;
}

/** A failed upload blocks first, then the budget is spent, then the user is asked, else block. */
export async function gatePaidClick(label) {
  if (turn.failedUpload) {
    return { allowed: false, how: `the upload this task needs failed (${turn.failedUpload}); stop and tell the user` };
  }
  const count = turn.paidClicks + 1;
  if (budget > 0) {
    budget -= 1;
    turn = { ...turn, paidClicks: count };
    return { allowed: true, how: `pre-approved (${budget} left)` };
  }
  if (approver && (await approver(label, { count }))) {
    turn = { ...turn, paidClicks: count };
    return { allowed: true, how: `the user said yes (paid click #${count} this task)` };
  }
  return { allowed: false, how: approver ? 'the user said no' : 'no approval: nobody at the terminal and no --paid budget' };
}
