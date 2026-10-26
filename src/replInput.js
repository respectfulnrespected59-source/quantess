// One line typed at the quantess prompt: a /command, a task for the model, or nothing. Decided on the TRIMMED line - live
// 10-24, " /tlink allow-yes 1h" (a leading space) went to the model as a task, and the model claimed the window was
// granted. Arguments split on any run of whitespace, so "allow-yes  1h" works too.

/** @returns {{ kind: 'empty' } | { kind: 'command', cmd: string, args: string[] } | { kind: 'task', text: string }} */
export function parseReplInput(raw) {
  const line = String(raw ?? '').trim();
  if (!line) return { kind: 'empty' };
  if (!line.startsWith('/')) return { kind: 'task', text: line };
  const [cmd = '', ...args] = line.slice(1).trim().split(/\s+/).filter(Boolean);
  return { kind: 'command', cmd, args };
}
