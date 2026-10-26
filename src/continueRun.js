/**
 * One-shot mode (`quantess "<task>"`): a job that runs out of steps (config.agent.maxIterations a turn) keeps going for
 * a few more turns instead of quitting half-done. Live 10-24: three recorded rounds of a website build each stopped at
 * the 40-step cap mid-job, and quantess still printed "Task completed". The daily spending cap applies to every turn
 * (agent.run checks it), Ctrl+C still stops it, and the rounds are capped so it can never run on forever.
 */
export const DEFAULT_ROUNDS = 2;
export const MAX_ROUNDS = 5;

/**
 * @param {Record<string, string|undefined>} env
 * @returns {number} extra turns a paused one-shot job gets (QUANTESS_AUTO_CONTINUE, 0..5, default 2)
 */
export function autoContinueRounds(env = process.env) {
  const n = Number.parseInt(env.QUANTESS_AUTO_CONTINUE ?? '', 10);
  if (!Number.isFinite(n)) return DEFAULT_ROUNDS;
  return Math.min(Math.max(n, 0), MAX_ROUNDS);
}

/**
 * Run `task`, then "keep going" while the turn ended paused at the step cap, up to `rounds` more turns.
 * @param {(task: string) => Promise<{response: string|null, paused: boolean, stopped: boolean, iterations: number,
 *   cost: {totalCost: number}}>} run one agent turn
 * @param {string} task
 * @param {{rounds?: number, onPause?: (round: number, rounds: number) => void}} options
 * @returns {Promise<object>} the last turn's result with iterations summed over every turn. Cost is NOT summed:
 *   agent.run reports the session's running total (code review 10-24), so the last turn's figure is already the total.
 *   A continuation that throws ends the loop with the last good result and its message in `error`.
 */
export async function runToEnd(run, task, { rounds = DEFAULT_ROUNDS, onPause = () => {} } = {}) {
  let result = await run(task);
  let iterations = result.iterations;
  for (let round = 1; round <= rounds && result.paused && !result.stopped; round++) {
    onPause(round, rounds);
    try {
      const next = await run('keep going');
      iterations += next.iterations;
      result = next;
    } catch (err) {
      return { ...result, iterations, error: String(err?.message ?? err) };
    }
  }
  return { ...result, iterations };
}
