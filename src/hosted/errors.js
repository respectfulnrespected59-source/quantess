// What the QUAN-TESS proxy's refusals mean for a turn in hosted mode (the site's server/cli/proxy.ts error codes,
// carried by the OpenAI SDK as error.code). A refusal no wait can fix - signed out, the plan, today's limit, a paused
// account - ends the turn in the site's own words: never another model, never a retry loop. What a wait or a fold can
// fix (busy, rate limited, too many in flight, too large) is left to the normal retry and fold paths.

const SAY_SITE = (message) => message || 'The QUAN-TESS site refused this call, so the turn ends here.';
const STOP = Object.freeze({
  signed_out: () => 'This terminal is not signed in, or its key was revoked. Run: quantess login',
  not_found: () => 'The QUAN-TESS terminal service is not open for this account right now.',
  upgrade_required: SAY_SITE,
  quota_exhausted: SAY_SITE,
  daily_cap: SAY_SITE,
  account_paused: SAY_SITE,
  not_configured: SAY_SITE,
  wallet_unavailable: SAY_SITE,
  model_not_allowed: SAY_SITE,
  stream_unsupported: SAY_SITE,
});

const codeOf = (error) => (typeof error?.code === 'string' ? error.code : null);
// The SDK puts the status in front of the site's message ("402 Using QUANTESS ..."): the user gets the words only
const wordsOf = (error) => String(error?.error?.message ?? error?.message ?? '').replace(/^\d{3}\s+/, '').trim();

/** The message that ends the turn, or null when this is not such a refusal. */
export function hostedStop(error) {
  const code = codeOf(error);
  if (!code || !Object.prototype.hasOwnProperty.call(STOP, code)) return null;
  return STOP[code](wordsOf(error));
}

/** The proxy's "too large for one call": fold the history and try once more. */
export const isTooLarge = (error) => codeOf(error) === 'too_large';

// The connection was never made, so the request never left this PC
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/**
 * The call never reached the QUAN-TESS proxy, so nothing ran and nothing was held - the one hosted failure worth a
 * retry: the connection refused or the name not found, or Render's own edge page (a deploy, a restart: a 502 / 503
 * without the proxy's JSON error). Anything the proxy answered carries its code and is never this - its 502 / 504 may
 * already have charged the hold. A connection that dropped mid-way (ECONNRESET) may have run, so it is not this either.
 */
export function neverReachedSite(error) {
  if ((error?.status === 502 || error?.status === 503) && !codeOf(error)) return true;
  let link = error;
  for (let depth = 0; depth < 4 && link; depth += 1) {
    if (NOT_SENT.has(link.code)) return true;
    link = link.cause;
  }
  return false;
}
