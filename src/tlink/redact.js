// T-LINK: what may leave the PC for the phone (security model 6).
// displayPaths is lossless display (the home folder becomes ~); scrubSecrets is lossy (a value becomes [secret]) and
// says so, because a prompt that lost text is No-only on the phone - what is approved must be what was shown.
// Every pattern is bounded and forPhone cuts text to size BEFORE scrubbing (review 10-24): web-page text flows in
// here, and an unbounded regex on a hostile megabyte froze the CLI for seconds to minutes.
import os from 'os';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The home folder as Windows, JSON (doubled backslashes), forward-slash, Git Bash and WSL spell it. */
function homeForms(home) {
  const fwd = home.replace(/\\/g, '/');
  const forms = new Set([home, home.replace(/\\/g, '\\\\'), fwd]);
  const drive = /^([A-Za-z]):\/(.*)$/.exec(fwd);
  if (drive) {
    forms.add(`/mnt/${drive[1].toLowerCase()}/${drive[2]}`);
    forms.add(`/${drive[1].toLowerCase()}/${drive[2]}`);
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

/**
 * Every spelling of the home folder becomes ~. A longer folder name that merely starts the same is left alone, and a
 * spelling inside another path (/c/... inside /mnt/c/...) is not taken apart.
 */
export function displayPaths(text, { home = os.homedir() } = {}) {
  let out = String(text ?? '');
  if (!home) return out;
  for (const form of homeForms(home)) {
    out = out.replace(new RegExp(`(?<![\\w.-])${esc(form)}(?=[\\\\/]|$|[^\\w.-]|\\.(?:\\s|$))`, 'gi'), '~');
  }
  return out;
}

// Env vars whose VALUES are secrets; a value that is a path (GIT_ASKPASS, SSH_AUTH_SOCK) is not one
const SECRET_NAME = /key|token|secret|pass|pwd|cookie|session|auth|credential/i;
const PATH_VALUE = /^(?:[A-Za-z]:[\\/]|\/|\\\\)/;
const MIN_SECRET = 8;

function envSecrets(env) {
  return Object.entries(env ?? {})
    .filter(([name, value]) => SECRET_NAME.test(name) && typeof value === 'string' && value.length >= MIN_SECRET
      && !PATH_VALUE.test(value))
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
}

const S = '[secret]';
// The shapes of known keys and tokens (also used to check a public copy holds none)
export const KEY_SHAPES = Object.freeze([
  /\b(?:sk-or-v1-|sk-proj-|sk-ant-|sk-|sk_live_|sk_test_|rk_live_|rk_test_)[A-Za-z0-9_-]{16,512}/g,
  /\bsk_[a-f0-9]{32,128}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,255}|\bgithub_pat_[A-Za-z0-9_]{20,255}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,255}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,64}/g,
  /\b(?:hf_[A-Za-z0-9]{20,255}|npm_[A-Za-z0-9]{30,255}|glpat-[A-Za-z0-9_-]{20,255}|whsec_[A-Za-z0-9+/=]{20,255}|GOCSPX-[A-Za-z0-9_-]{20,255})/g,
  /\bya29\.[A-Za-z0-9_-]{20,1024}/g,
  /\bSG\.[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{16,128}/g,
  /\btlk_[A-Za-z0-9_-]{20,64}/g,
  // the terminal key (hosted mode)
  /qtk_[A-Za-z0-9_-]{20,64}/g,
  /\beyJ[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,2048}/g
]);
// Best effort, by design: an unknown format can slip through, which is why only summaries leave the PC and any
// scrubbed prompt is No-only (the review's bound on this risk). Every quantifier is bounded.
const PATTERNS = [
  [/-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,8000}?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/g, S],
  [/\bBearer\s{1,8}[A-Za-z0-9._~+/=-]{16,1024}/gi, `Bearer ${S}`],
  [/\bBasic\s{1,8}[A-Za-z0-9+/=]{12,1024}/g, `Basic ${S}`],
  ...KEY_SHAPES.map((re) => [re, S]),
  [/\b([A-Za-z0-9_]{0,40}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD)[A-Za-z0-9_]{0,40})(\s{0,4}[=:]\s{0,4}["']?)([^\s"'&]{8,512})/gi, `$1$2${S}`],
  [/("(?:api_?key|token|secret|password|access_?token|refresh_?token|client_?secret)"\s{0,4}:\s{0,4}")([^"]{8,512})"/gi, `$1${S}"`],
  [/(--(?:password|passwd|token|api-key|apikey|secret|key)(?:\s{1,4}|=))(["']?)[^\s"']{6,512}/gi, `$1$2${S}`],
  [/(\s-u\s{1,4})[^\s:]{1,64}:[^\s]{1,128}/g, `$1${S}`],
  [/([?&](?:token|key|api_?key|access_?token|secret|sig|signature|password)=)[^&\s#]{6,512}/gi, `$1${S}`],
  [/(?<![\w.+-])([a-z][a-z0-9+.-]{0,15}:\/\/)[^/\s:@]{1,64}:[^/\s@]{1,128}@/gi, `$1${S}@`]
];

// A long run of key-like characters mixing upper case, lower case and digits is treated as a secret. Found linearly
// (a regex with look-aheads for each class went quadratic); git hashes (lower-case hex) and paths are not caught.
const BLOB = /[A-Za-z0-9+_-]{32,}/g;
const looksRandom = (s) => /[A-Z]/.test(s) && /[a-z]/.test(s) && /\d/.test(s);

/** @returns {{ text: string, scrubbed: boolean }} */
export function scrubSecrets(text, { env = process.env, extra = [] } = {}) {
  let out = String(text ?? '');
  const before = out;
  for (const value of [...extra.filter(Boolean), ...envSecrets(env)]) out = out.split(value).join(S);
  for (const [re, to] of PATTERNS) out = out.replace(re, to);
  out = out.replace(BLOB, (run) => (looksRandom(run) ? S : run));
  return { text: out, scrubbed: out !== before };
}

/**
 * Text ready for the phone: cut to size, paths shortened, secrets scrubbed, capped. exact is false when anything was
 * cut or scrubbed - such a prompt is No-only on the phone.
 * @returns {{ text: string, exact: boolean }}
 */
export function forPhone(text, { home = os.homedir(), env = process.env, extra = [], cap = 200 } = {}) {
  const raw = String(text ?? '');
  // Never scrub more than the phone could show (plus room for a secret that straddles the cut)
  const room = cap * 2 + 256;
  const sliced = raw.length > room ? raw.slice(0, room) : raw;
  const scrubbed = scrubSecrets(displayPaths(sliced, { home }), { env, extra });
  const cut = sliced.length < raw.length || scrubbed.text.length > cap;
  return { text: scrubbed.text.length > cap ? `${scrubbed.text.slice(0, cap)}… (cut)` : `${scrubbed.text}${cut ? '… (cut)' : ''}`,
    exact: !scrubbed.scrubbed && !cut };
}
