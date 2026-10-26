// Where model calls go (every client in quantess is made here):
//   direct - your own OPENROUTER_API_KEY, straight to OpenRouter, exactly as before;
//   hosted - signed in with `quantess login` and no key of your own: the QUAN-TESS site's proxy (/api/cli/v1), paid
//            from your QUAN-TESS AI plan (the site holds the OpenRouter key, prices the call, and caps the day);
//   none   - neither: the terminal says to sign in, and no call is made.
// QUANTESS_HOSTED=1 picks the proxy even with a key of your own (QUANTESS_ settings never come from a project .env).
import OpenAI from 'openai';
import { PROJECT_ENV_KEYS, config } from './config/index.js';
import { readAuth } from './hosted/auth.js';

/** The only models the proxy takes (the site's server/cli/pricing.ts). */
export const HOSTED_MODELS = Object.freeze({
  default: 'nvidia/nemotron-3.5-lightning',
  vision: 'nvidia/nemotron-3.5-super-vl',
  deep: 'nvidia/nemotron-3-ultra-550b-a55b',
});
const HOSTED_ALLOWED = new Set(Object.values(HOSTED_MODELS));

/**
 * Your own key counts only when it is an OpenRouter key (a placeholder is not), and one that came from a project's .env
 * never takes a signed-in user off the plan - a cloned repo could otherwise route your prompts to its own account.
 * @returns {{ mode: 'direct'|'hosted'|'none', baseURL: string, apiKey?: string, keyId?: string, site?: string }}
 */
export function resolveProvider({ env = process.env, auth = readAuth(), fromProject = PROJECT_ENV_KEYS } = {}) {
  const hostedAsked = env.QUANTESS_HOSTED === '1';
  const key = String(env.OPENROUTER_API_KEY ?? '').trim();
  const ownKey = /^sk-or-/.test(key) && !(auth && fromProject.has('OPENROUTER_API_KEY'));
  if (ownKey && !hostedAsked) {
    return { mode: 'direct', baseURL: config.openRouter.baseUrl, apiKey: key };
  }
  if (auth) return { mode: 'hosted', baseURL: `${auth.site}/api/cli/v1`, apiKey: auth.token, keyId: auth.keyId, site: auth.site };
  return { mode: 'none', baseURL: config.openRouter.baseUrl };
}

let current = null;

/** This run's provider, decided once. */
export function provider() {
  current ??= resolveProvider();
  return current;
}

/** A newer sign-in picked up mid-session (`quantess login` in another window): web_search and look_at_image use it too. */
export function useProvider(p) {
  current = p;
}

/**
 * An OpenAI-compatible client for it. With no key at all the client still builds; the call is refused, not a crash.
 * Hosted: no hidden SDK retries - a proxy timeout charges the whole hold, so a silent second try could charge twice;
 * the agent decides every retry itself.
 */
export function providerClient(p = provider()) {
  return new OpenAI({ baseURL: p.baseURL, apiKey: p.apiKey ?? 'not-signed-in', ...(p.mode === 'hosted' ? { maxRetries: 0 } : {}) });
}

/** The model a hosted call may use: the one asked for if the proxy takes it, else that role's default. */
export function hostedModel(model, role = 'default') {
  return HOSTED_ALLOWED.has(model) ? model : HOSTED_MODELS[role];
}
