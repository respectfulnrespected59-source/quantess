// The five y/n questions quantess puts to the user at the terminal (moved out of cli.js for T-LINK):
// a money click, a push / merge, an --ask change, a memory after outside text, and a new site. Every question's text
// comes from tlink/describe.js - the one description the phone also gets - so what is approved is what runs.
// Ctrl-C at any of them stops the whole job, as before. New: each takes an optional AbortSignal; when the phone answers
// first, the terminal question is closed quietly instead of quitting.
import chalk from 'chalk';
import { describePrompt } from './tlink/describe.js';
import { memoryPreview } from './memory.js';

const LF = String.fromCharCode(10);
const indent = (text) => String(text).replace(/\n/g, `${LF}  `);

/**
 * @param {{ prompts: Function, quit: (code: number) => Promise<void>, spinner?: () => ({ stop(): void, start(): void } | null) }} deps
 */
export function createAskers({ prompts, quit, spinner = () => null }) {
  /** One question. @returns {Promise<{ value: unknown, remote: boolean }>} remote = closed because the phone answered */
  async function ask(question, { signal } = {}) {
    if (signal?.aborted) return { value: undefined, remote: true };
    spinner()?.stop();
    let element = null;
    let remote = false;
    let userCancelled = false;
    const close = () => {
      remote = true;
      element?.abort();
    };
    signal?.addEventListener('abort', close, { once: true });
    let answers;
    try {
      answers = await prompts({
        ...question,
        onRender() {
          if (element === this) return;
          element = this;
          // The phone answered before this question existed: close it on the next tick (an abort inside the first
          // render fires before prompts is listening, and the question would never settle)
          if (remote) setImmediate(() => this.abort());
        }
      }, {
        onCancel: () => {
          if (!remote) userCancelled = true;
          return false;
        }
      });
    } finally {
      signal?.removeEventListener('abort', close);
    }
    // Ctrl-C at this question stops the whole job, not just this question
    if (userCancelled) await quit(130);
    spinner()?.start();
    return { value: answers?.[question.name], remote };
  }

  const confirm = async (prompt, signal) => (await ask({ type: 'confirm', name: 'ok', message: chalk.yellow(indent(prompt.text)),
    initial: false }, { signal })).value === true;
  const select = async (prompt, signal) => (await ask({ type: 'select', name: 'answer',
    message: chalk.yellow(`${indent(prompt.text)}${LF}`), choices: prompt.choices, initial: 0 }, { signal })).value ?? 'no';

  return {
    /** The hard stop on money buttons. @returns {Promise<boolean>} */
    pay: (label, { count = 1, signal } = {}) => confirm(describePrompt('pay', { label, count }), signal),
    /** git push / gh pr merge: the exact command. @returns {Promise<boolean>} */
    publish: (cmd, { signal } = {}) => confirm(describePrompt('publish', { cmd }), signal),
    /** --ask: the whole change (approvalText's text). @returns {Promise<'yes'|'always'|'no'>} */
    change: (_name, text, { complete = true, signal } = {}) => select(describePrompt('change', { text, complete }), signal),
    /** A memory after outside text, shown whole. @returns {Promise<boolean>} */
    async remember(memory, { signal } = {}) {
      let preview;
      try {
        preview = memoryPreview(memory);
      } catch {
        // remember will refuse it with the reason; nothing to approve
        return false;
      }
      return confirm(describePrompt('memory', preview), signal);
    },
    /** A site the browser has not been to. @returns {Promise<'yes'|'always'|'no'>} */
    site: (site, url, { signal } = {}) => select(describePrompt('site', { site, url }), signal)
  };
}
