/**
 * OpenRouter answers 429 for three different reasons, and each needs its own response:
 * - 'model':       one model is swamped ("High demand for X"). Another model is not, so switch.
 * - 'free-minute': the account's per-minute FREE allowance is spent. Every :free model draws on it,
 *                  so switching only burns the fallback chain. Wait for the minute to roll over.
 * - 'free-daily':  the daily free allowance is spent. It resets at midnight UTC: nothing helps today.
 */
export const RATE_LIMIT_WAITS_MS = Object.freeze([20_000, 40_000, 60_000]);
export const MAX_RATE_LIMIT_WAIT_MS = 65_000;
// Header values below this are epoch SECONDS; above, epoch milliseconds
const EPOCH_MS_FLOOR = 1e12;
// Land just after the reset, not on it
const RESET_MARGIN_MS = 1_000;

/** @returns {'model'|'free-minute'|'free-daily'|null} null when the error is not a rate limit */
export function rateLimitKind(error) {
  if (error?.status !== 429) return null;
  const text = String(error.message ?? '');
  if (/free-models-per-day/i.test(text)) return 'free-daily';
  if (/free-models-per-min/i.test(text)) return 'free-minute';
  return 'model';
}

/**
 * How long to wait before retrying: until the reset OpenRouter names, else retry-after,
 * else the next step of the backoff schedule. Capped so Q23 never sits silent for long.
 */
export function rateLimitWaitMs(error, attempt, now = Date.now()) {
  const scheduled = RATE_LIMIT_WAITS_MS[Math.min(attempt, RATE_LIMIT_WAITS_MS.length - 1)];
  const reset = Number(readHeader(error, 'x-ratelimit-reset'));
  const resetMs = reset < EPOCH_MS_FLOOR ? reset * 1000 : reset;
  if (resetMs > now) return Math.min(resetMs - now + RESET_MARGIN_MS, MAX_RATE_LIMIT_WAIT_MS);
  const retryAfterSeconds = Number(readHeader(error, 'retry-after'));
  if (retryAfterSeconds > 0) return Math.min(retryAfterSeconds * 1000, MAX_RATE_LIMIT_WAIT_MS);
  return scheduled;
}

// OpenRouter puts its limit headers in the error BODY (error.metadata.headers) as well as on the response
function readHeader(error, name) {
  const sources = [error?.headers, error?.error?.metadata?.headers];
  for (const headers of sources) {
    if (!headers || typeof headers !== 'object') continue;
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
    if (key !== undefined && headers[key] != null) return headers[key];
  }
  return undefined;
}
