// T-LINK approval race (approval protocol): the terminal question and the phone run side by side.
// The first ACCEPTED answer wins and the other side is cancelled. The terminal can always answer. A phone answer only
// counts if judge() (the CLI's policy) accepts it. With a timeout (T-LINK on), nobody answering settles as a timeout,
// which the caller turns into "no".

/**
 * @param {{
 *   terminal: (signal: AbortSignal) => Promise<unknown>,
 *   subscribe?: (onMessage: (msg: unknown) => void) => () => void,
 *   judge?: (msg: unknown) => ({ ok: true, answer: string } | { ok: false, why: string }),
 *   timeoutMs?: number,
 *   setTimer?: Function, clearTimer?: Function
 * }} options
 * @returns {Promise<{ answer: unknown, by: 'terminal'|'phone'|'timeout' }>}
 */
export function firstAnswer({ terminal, subscribe, judge = () => ({ ok: false, why: 'no policy' }), timeoutMs = Infinity,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  const stopTerminal = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = null;
    let timer = null;
    const finish = (outcome, error) => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      if (timer) clearTimer(timer);
      if (outcome?.by !== 'terminal') stopTerminal.abort();
      if (error) reject(error);
      else resolve(outcome);
    };
    // The timer first: an answer delivered during subscribe() (a buffered replay) must find it to clear (review 10-24)
    if (Number.isFinite(timeoutMs)) timer = setTimer(() => finish({ answer: null, by: 'timeout' }), timeoutMs);
    if (subscribe) {
      const off = subscribe((msg) => {
        if (settled) return;
        let verdict;
        try {
          verdict = judge(msg);
        } catch {
          // A malformed message is ignored, never thrown into the transport that delivered it
          return;
        }
        if (verdict?.ok) finish({ answer: verdict.answer, by: 'phone' });
      });
      if (settled) off?.();
      else unsubscribe = off;
    }
    Promise.resolve()
      .then(() => terminal(stopTerminal.signal))
      .then(
        (answer) => { if (!stopTerminal.signal.aborted) finish({ answer, by: 'terminal' }); },
        (error) => { if (!stopTerminal.signal.aborted) finish(null, error); }
      );
  });
}
