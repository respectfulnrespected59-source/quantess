// T-LINK security model 4: ONE description per y/n question, used by the terminal and the
// phone alike, every hidden character shown. What the user approves anywhere is exactly what will run.
import { createHash } from 'crypto';
import { visible, visibleLine } from '../activity.js';
import { paidClickQuestion } from '../browser/paidClicks.js';
import { publishQuestion } from '../pushGate.js';

const URL_SHOWN = 160;

/** The host as the browser will resolve it (punycode for a lookalike), or '?' when the URL does not parse. */
function hostOf(url) {
  try {
    return new URL(String(url)).hostname || '?';
  } catch {
    return '?';
  }
}

/**
 * @param {'change'|'site'|'memory'|'pay'|'publish'} kind
 * @returns {{ kind: string, type: 'select'|'confirm', text: string, complete: boolean, choices?: {title: string, value: string}[] }}
 */
export function describePrompt(kind, args = {}) {
  switch (kind) {
    case 'change': {
      // args.text is approvalText's, which already shows every hidden character (and keeps the step's line breaks).
      // "always" only for a step shown whole
      const complete = args.complete !== false;
      const choices = [
        { title: 'Yes', value: 'yes' },
        ...(complete ? [{ title: 'Always (this kind of step, this session)', value: 'always' }] : []),
        { title: 'No', value: 'no' }
      ];
      return { kind, type: 'select', text: `quantess wants to ${args.text}`, complete, choices };
    }
    case 'site': {
      // What a Yes approves is the site; the URL is context, cut when long
      const url = visibleLine(args.url);
      const shownUrl = url.length > URL_SHOWN ? `${url.slice(0, URL_SHOWN)}… (cut)` : url;
      return {
        kind,
        type: 'select',
        text: `quantess wants to open a new site: ${visibleLine(args.site)}\n  host ${visibleLine(hostOf(args.url))}  ·  ${shownUrl}`,
        complete: true,
        choices: [{ title: 'Yes, this session', value: 'yes' }, { title: 'Always (remember this site)', value: 'always' },
          { title: 'No', value: 'no' }]
      };
    }
    case 'memory':
      // The whole memory (at most 2000 characters), hidden characters shown rather than deleted (review 10-24)
      return {
        kind,
        type: 'confirm',
        text: 'quantess took in outside text this session (files, commands, pages) and wants to remember:\n' +
          `[${visibleLine(args.type)}] ${visibleLine(args.name)} - ${visibleLine(args.description)}\n${visible(args.content)}\nKeep it?`,
        complete: true
      };
    case 'pay': {
      const text = paidClickQuestion(args.label, args.count ?? 1);
      return { kind, type: 'confirm', text, complete: !text.includes('(label cut)') };
    }
    case 'publish':
      return { kind, type: 'confirm', text: publishQuestion(args.cmd), complete: true };
    default:
      throw new Error(`unknown T-LINK prompt kind: ${kind}`);
  }
}

/** The hash an answer must carry back: it binds the answer to this exact question text. */
export function hashText(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}
