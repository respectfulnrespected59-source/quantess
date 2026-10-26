/**
 * Browser tools for Q23: the same Playwright MCP server Claude Code drives, so a skill that
 * says browser_navigate -> browser_snapshot -> browser_click works here as written. Before
 * this, Q23 had to write a Playwright script blind.
 *
 * Q23 uses its OWN Chrome profile (owner's call, 2026-10-13): it only holds the accounts the user
 * signs into there, because page text goes to free models that may log it.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import dns from 'dns';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { toolResult } from '../tools/index.js';
import { secretProblem } from '../tools/web.js';
import { addressProblem } from '../tools/netGuard.js';
import { gateSite, siteOf } from './siteGate.js';
import { redact } from '../skills/index.js';
import { gatePaidClick, noteToolResult, pageLabels, paidClickLabel } from './paidClicks.js';

export {
  pageLabels, paidClickLabel, gatePaidClick, setPaidClickBudget, setPaidClickApprover, parsePaidFlag, touchesQ23Limits,
  startPaidClickTurn, noteToolResult, paidClickQuestion
} from './paidClicks.js';

const require = createRequire(import.meta.url);

/** Playwright MCP keeps its Chrome profiles here: Claude Code's `mcp-chrome-*`, and Q23's own. */
export const PROFILES_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'ms-playwright-mcp'
);

const Q23_PROFILE = 'q23-chrome';

/** Where `--signin` opens by default, and the page `--doctor` checks for a sign-in. */
export const SIGNIN_URL = 'https://quantus-ai.onrender.com';
const COOKIES = path.join('Default', 'Network', 'Cookies');

/** A page snapshot is ~7.5k tokens at this size: enough for a full app page on a free model. */
export const MAX_PAGE_CHARS = 30000;

// Image generation can take a minute or more; the SDK default of 60 s would cut a wait_for short.
const CALL_TIMEOUT_MS = 180000;

// What a site workflow needs. Drag/drop, network inspection and run_code_unsafe stay out: they
// cost tokens every turn and are rarely needed.
const SAFE_TOOLS = Object.freeze([
  'browser_navigate', 'browser_navigate_back', 'browser_snapshot', 'browser_click', 'browser_type',
  'browser_fill_form', 'browser_press_key', 'browser_select_option', 'browser_hover', 'browser_wait_for',
  'browser_handle_dialog', 'browser_tabs', 'browser_find', 'browser_take_screenshot', 'browser_close'
]);
// evaluate can read cookies and fetch anywhere; file_upload can send any local file to a page.
// A page that talks a free model into using them is the realistic attack, so they are opt-in.
const UNSAFE_TOOLS = Object.freeze(['browser_evaluate', 'browser_file_upload']);

// Where quantess may open pages: anywhere a person can, by default. QUANTESS_BROWSER_SITES:
//   ask (default) - QMM sites, Q23_BROWSER_ALLOW and sites the user saved open freely; any other site asks the user
//                   once (siteGate.js), also when a click or redirect lands there
//   any           - no asking;  qmm - the QMM list only, as before
// In every mode browserUrlProblem refuses keys in a URL, stuffed payloads and the home network.
const DEFAULT_ALLOWED_HOSTS = Object.freeze([
  'quantus-ai.onrender.com', 'quantummelaninmedia.com', 'baketunes-site.onrender.com', 'alignment365.onrender.com'
]);
// A model-typed URL carrying more than this is carrying data out, not opening a page
const MAX_URL_DATA_CHARS = 512;
const MAX_URL_PATH_CHARS = 1024;
const MAX_HOST_CHARS = 100;

let session = null;

/** 'ask' (default), 'any' or 'qmm': see above. */
export function browserSitesMode(env = process.env) {
  const mode = String(env.QUANTESS_BROWSER_SITES ?? 'ask').trim().toLowerCase();
  return mode === 'qmm' || mode === 'any' ? mode : 'ask';
}

/** The QMM sites plus the user's Q23_BROWSER_ALLOW: always open. */
function qmmHosts(env = process.env) {
  // "https://studio.youtube.com/x" and "studio.youtube.com" both mean the host
  const toHost = (entry) => (URL.canParse(entry) ? new URL(entry).hostname : entry).toLowerCase();
  const extra = (env.Q23_BROWSER_ALLOW ?? '').split(',').map((h) => h.trim()).filter(Boolean).map(toHost);
  return [...DEFAULT_ALLOWED_HOSTS, ...extra];
}

export function allowedHosts(env = process.env) {
  return browserSitesMode(env) === 'qmm' ? qmmHosts(env) : ['*'];
}

/** Why the browser may not open this URL ({ code, reason }), or null when it may. */
export function browserUrlProblem(url, env = process.env) {
  const hosts = allowedHosts(env);
  if (!isAllowedUrl(url, hosts)) {
    const reason = hosts.includes('*') ? 'only http(s) pages can be opened' : `not one of quantess's allowed sites (${hosts.join(', ')})`;
    return { code: 'SITE_NOT_ALLOWED', reason };
  }
  if (url === 'about:blank') return null;
  const secret = secretProblem(url, env);
  if (secret) return { code: 'URL_CARRIES_SECRET', reason: secret };
  const { hostname, username, password, pathname, search, hash } = new URL(url);
  const host = hostname.replace(/^\[|\]$/g, '');
  const isLoopback = /^127\./.test(host) || host === '::1';
  if (net.isIP(host) && !isLoopback && addressProblem(host)) return { code: 'PRIVATE_NETWORK', reason: `${host} is on the home or cloud network` };
  // Security review 10-23: data also rides in the path, a long host name, or a login before the @
  if (username || password) return { code: 'URL_CARRIES_DATA', reason: 'the URL carries a login (user:password@)' };
  if (host.length > MAX_HOST_CHARS) return { code: 'URL_CARRIES_DATA', reason: `the host name is ${host.length} characters long` };
  if (search.length + hash.length > MAX_URL_DATA_CHARS || pathname.length + search.length + hash.length > MAX_URL_PATH_CHARS) {
    return { code: 'URL_CARRIES_DATA', reason: `the URL carries ${pathname.length + search.length + hash.length} characters of data` };
  }
  return null;
}

/**
 * Why a URL's host NAME is off limits: it resolves into the home or cloud network (this PC stays open), or null.
 * A name that does not resolve is the browser's problem to report, not this check's.
 * @param {string} url
 * @param {{ lookup?: (host: string, options: object) => Promise<{ address: string }[]> }} [deps]
 */
export async function networkProblem(url, { lookup = dns.promises.lookup } = {}) {
  if (!URL.canParse(url)) return null;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (!host || net.isIP(host)) return null;
  let addresses;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    return null;
  }
  const isLoopback = (ip) => /^127\./.test(ip) || ip === '::1';
  const bad = addresses.map((a) => a.address).find((ip) => !isLoopback(ip) && addressProblem(ip));
  return bad ? { code: 'PRIVATE_NETWORK', reason: `${host} resolves to ${bad}, on the home or cloud network` } : null;
}

/**
 * A URL as a message may show it: the origin only. Security review 10-23: the full URL of a refused page went back
 * to the model, key and all.
 */
export function urlLabel(url) {
  return URL.canParse(url) ? new URL(url).origin : '(not a valid URL)';
}

/** Where the browser is now, from a Playwright result's "- Page URL:" line, or null. */
export function pageUrlOf(text) {
  return /^- Page URL: (\S+)/m.exec(String(text ?? ''))?.[1] ?? null;
}

/** Why the browser may not stay on this page, or null. In every mode: no key in the URL, no home network. */
async function landedProblem(url) {
  if (!url || url === 'about:blank' || !URL.canParse(url)) return null;
  const secret = secretProblem(url);
  if (secret) return secret;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  const isLoopback = /^127\./.test(host) || host === '::1';
  if (net.isIP(host) && !isLoopback && addressProblem(host)) return `${host} is on the home or cloud network`;
  const network = await networkProblem(url);
  if (network) return network.reason;
  const mode = browserSitesMode();
  if (mode === 'any') return null;
  if (mode === 'qmm') return isAllowedUrl(url, allowedHosts()) ? null : 'not on the site list';
  const gate = await gateSite(url, { openHosts: qmmHosts() });
  return gate.allowed ? null : `${siteOf(url)} is a site the user has not approved (${gate.how})`;
}

/**
 * After EVERY browser call (security review 10-23): if the page is somewhere off limits - a click, a redirect, a
 * page never checked - go back; if that page is off limits too, leave for about:blank. Returns why, or null.
 * The click's own request has already gone out by then: this stops the model working there, it cannot unsend it.
 * @param {string|null} url where the browser is
 * @param {{ goBack: () => Promise<unknown>, goBlank: () => Promise<unknown>, currentUrl: () => string|null }} browser
 */
export async function enforceLanding(url, { goBack, goBlank, currentUrl }) {
  const why = await landedProblem(url);
  if (!why) return null;
  await goBack();
  const back = currentUrl();
  if (!back || back === url || await landedProblem(back)) await goBlank();
  return why;
}

/** http(s) on an allowed host or its subdomain, or about:blank. Never file:, javascript:, lookalikes. */
export function isAllowedUrl(url, hosts = allowedHosts()) {
  if (url === 'about:blank') return true;
  if (!URL.canParse(url)) return false;
  const { protocol, hostname } = new URL(url);
  // Checked before "*": with uploads on, the server no longer blocks file:// itself
  if (protocol !== 'https:' && protocol !== 'http:') return false;
  if (hosts.includes('*')) return true;
  const host = hostname.toLowerCase();
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

/** The URL a call would open, if any: navigate, or a new tab with a url. */
function urlToOpen(name, args) {
  if (name === 'browser_navigate') return args?.url;
  if (name === 'browser_tabs' && args?.action === 'new') return args?.url;
  return undefined;
}

export function browserToolNames(env = process.env) {
  return env.Q23_BROWSER_UNSAFE === '1' ? [...SAFE_TOOLS, ...UNSAFE_TOOLS] : [...SAFE_TOOLS];
}

export function isBrowserTool(name, env = process.env) {
  return browserToolNames(env).includes(name);
}

function mtimeOrZero(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
}

function latestClaudeProfile(profilesDir) {
  let names;
  try {
    names = fs.readdirSync(profilesDir);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const [latest] = names
    .filter((n) => n.startsWith('mcp-chrome-'))
    .map((n) => path.join(profilesDir, n))
    .map((dir) => ({ dir, used: mtimeOrZero(path.join(dir, COOKIES)) }))
    .filter((p) => p.used > 0)
    .sort((a, b) => b.used - a.used);
  return latest?.dir ?? null;
}

/**
 * Pick the Chrome profile. Default: Q23's own. Q23_BROWSER_PROFILE=claude shares Claude
 * Code's most recent one (every login it has); any other value is a profile folder.
 * @returns {{ dir: string, source: 'q23' | 'claude' | 'env' }}
 */
export function resolveProfile({ env = process.env, profilesDir = PROFILES_DIR } = {}) {
  const own = { dir: path.join(profilesDir, Q23_PROFILE), source: 'q23' };
  const wanted = env.Q23_BROWSER_PROFILE;
  if (!wanted) return own;
  if (wanted.toLowerCase() === 'claude') {
    const dir = latestClaudeProfile(profilesDir);
    return dir ? { dir, source: 'claude' } : own;
  }
  return { dir: wanted, source: 'env' };
}

/** The installed Google Chrome, or null. */
export function findChrome(env = process.env, exists = fs.existsSync) {
  const tail = path.join('Google', 'Chrome', 'Application', 'chrome.exe');
  const candidates = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]
    .filter(Boolean)
    .map((root) => path.join(root, tail));
  return candidates.find((p) => exists(p)) ?? null;
}

/**
 * Chrome holds <profile>\lockfile open while it runs, and Windows refuses a second open (EBUSY).
 * This is the reliable "window still open" signal: the chrome.exe Q23 starts can exit at once
 * while the window lives on in a relaunched process (seen on a fresh profile, 2026-10-13).
 */
export function profileInUse(dir) {
  try {
    fs.closeSync(fs.openSync(path.join(dir, 'lockfile'), 'r+'));
    return false;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    if (err.code === 'EBUSY') return true;
    throw err;
  }
}

const LOCK_POLL_MS = 1000;
const LOCK_APPEAR_MS = 15000;

/**
 * Wait until Chrome has opened the profile (lock held at least once, up to appearMs) and then let
 * it go. Waiting only for "free" said "Saved" before the relaunched window had even taken the lock.
 */
export function waitForChromeToClose(dir, { pollMs = LOCK_POLL_MS, appearMs = LOCK_APPEAR_MS } = {}) {
  const started = Date.now();
  let seenOpen = false;
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      try {
        const inUse = profileInUse(dir);
        seenOpen = seenOpen || inUse;
        const neverOpened = !seenOpen && Date.now() - started > appearMs;
        if ((seenOpen && !inUse) || neverOpened) {
          clearInterval(timer);
          resolve();
        }
      } catch (err) {
        clearInterval(timer);
        reject(err);
      }
    }, pollMs);
  });
}

/**
 * Chrome flags for the sign-in window. Without --disable-background-mode, Chrome with sync on
 * kept running with no window and held the profile lock, so --signin never returned (2026-10-13).
 */
export function signInArgs(dir, url) {
  return [`--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--disable-background-mode', url];
}

/**
 * Open plain Chrome on Q23's profile so the user can sign in themselves (they type their own passwords).
 * Resolves when he closes the window. Plain Chrome, not Playwright: some sign-in pages refuse
 * a browser that reports automation.
 */
export async function openForSignIn(url, profile = resolveProfile()) {
  const chrome = findChrome();
  if (!chrome) throw new Error('Google Chrome is not installed (looked in Program Files and LocalAppData)');
  fs.mkdirSync(profile.dir, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn(chrome, signInArgs(profile.dir, url), { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', resolve);
  });
  await waitForChromeToClose(profile.dir);
  return profile;
}

/** MCP tool -> OpenAI function definition. Some providers reject the $schema key. */
export function toOpenAiTool({ name, description, inputSchema }) {
  const { $schema, ...parameters } = inputSchema ?? { type: 'object', properties: {} };
  return { type: 'function', function: { name, description, parameters } };
}

function hintFor(text) {
  if (/already in use/i.test(text)) {
    return 'another Chrome window has this profile open: ask the user to close it, then try again';
  }
  if (/not found|ref/i.test(text)) return 'take a fresh browser_snapshot and use a target from it';
  return 'browser_snapshot to see where the page is now';
}

/**
 * MCP result -> Q23 tool result. Text only (free models cannot see images, and the bytes would
 * flood context), with key-shaped strings masked: whatever is on screen goes to a free model.
 */
export function formatBrowserResult(name, result) {
  const text = redact((result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'));
  const page = text.length > MAX_PAGE_CHARS
    ? `${text.slice(0, MAX_PAGE_CHARS)}\n[... cut at ${MAX_PAGE_CHARS} of ${text.length} chars. Use browser_find to locate an element, or scroll and snapshot again.]`
    : text;
  if (result?.isError) {
    return toolResult({
      status: 'error',
      // The server leads with a "### Error" heading; the reason is the first line after it.
      summary: `${name} failed: ${text.split('\n').find((l) => l.trim() && !l.startsWith('#')) ?? 'no detail'}`,
      nextActions: [hintFor(text)],
      data: { page },
      error: { code: 'BROWSER_ERROR' }
    });
  }
  return toolResult({
    status: 'ok',
    summary: `${name} done`,
    nextActions: ['read data.page, then act on a [ref=...] from the NEWEST snapshot'],
    data: { page }
  });
}

export function serverCommand(profile, outputDir, env = process.env) {
  const cli = path.join(path.dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');
  // The server only reads files inside its cwd (outputDir), so without this an upload of
  // the user's photo from Pictures fails "outside allowed roots" even with the upload tool on.
  const fileAccess = isBrowserTool('browser_file_upload', env) ? ['--allow-unrestricted-file-access'] : [];
  return {
    command: process.execPath,
    args: [cli, '--user-data-dir', profile.dir, '--image-responses', 'omit', '--output-dir', outputDir, ...fileAccess],
    // A snapshot saved with a relative filename lands in the server's cwd. Without this it went
    // into whatever repo Q23 was running in, unredacted (seen 2026-10-13).
    cwd: outputDir
  };
}

async function connect(profile) {
  // Snapshots and screenshots can hold whatever was on screen: a private folder, deleted on close.
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'q23-playwright-'));
  const transport = new StdioClientTransport({ ...serverCommand(profile, outputDir), stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (d) => { stderr = (stderr + d.toString()).slice(-2000); });
  const client = new Client({ name: 'q23-agent', version: '1.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const exposed = tools.filter((t) => isBrowserTool(t.name)).map(toOpenAiTool);
    return { client, profile, outputDir, tools: exposed };
  } catch (err) {
    await client.close().catch((closeErr) => console.warn(`[browser server close failed: ${closeErr.message}]`));
    fs.rmSync(outputDir, { recursive: true, force: true });
    throw new Error(`Playwright MCP did not start: ${err.message}${stderr ? ` | ${stderr.trim()}` : ''}`);
  }
}

/**
 * Start the Playwright MCP server (once) and return its tools as OpenAI definitions.
 * Starting the server does not open Chrome; the first browser_* call does.
 */
export async function browserToolDefinitions({ profile = resolveProfile() } = {}) {
  if (!session) session = await connect(profile);
  return session.tools;
}

export async function callBrowserTool(name, args) {
  const target = urlToOpen(name, args);
  const problem = target === undefined ? null : (browserUrlProblem(target) ?? await networkProblem(target));
  if (problem) {
    return toolResult({
      status: 'error',
      summary: `Blocked: ${urlLabel(target)} - ${problem.reason}. Full URLs only, with https://`,
      nextActions: ['open the page without the data in its URL, or tell the user what you needed. Never work around it.'],
      error: { code: problem.code }
    });
  }
  if (target !== undefined && browserSitesMode() === 'ask') {
    const gate = await gateSite(target, { openHosts: qmmHosts() });
    if (!gate.allowed) {
      return toolResult({
        status: 'error',
        summary: `Not opened: ${siteOf(target)} is a new site and was not approved (${gate.how}).`,
        nextActions: ['do NOT reach that site another way. Tell the user what you needed from it.'],
        error: { code: 'SITE_NOT_APPROVED' }
      });
    }
  }
  if (!session) {
    return toolResult({
      status: 'error',
      summary: 'Browser tools are not running on this PC',
      nextActions: ['tell the user to run: quantessq23 --doctor'],
      error: { code: 'BROWSER_OFF' }
    });
  }
  // A new page has new refs: forget the old page's labels before it loads
  if (name === 'browser_navigate' || name === 'browser_navigate_back') session.labels = new Map();
  const paidLabel = paidClickLabel(name, args, session.labels ?? new Map());
  if (paidLabel) {
    const gate = await gatePaidClick(paidLabel);
    if (!gate.allowed) {
      return toolResult({
        status: 'error',
        summary: `Stopped: "${paidLabel}" can spend money and was not approved (${gate.how}).`,
        nextActions: ['do NOT try another way to trigger it. Stop and tell the user what you wanted to click and why.'],
        error: { code: 'PAID_CLICK_BLOCKED' }
      });
    }
    console.warn(`[paid click allowed: "${paidLabel}", ${gate.how}]`);
  }
  const out = await runOnServer(name, args);
  // A failed upload blocks money buttons until one works (see paidClicks.js)
  noteToolResult(name, out.status === 'ok', out.summary);
  // A click, a redirect or going back can land somewhere nobody approved: leave before the model works there
  const landed = session.pageUrl;
  const offLimits = await enforceLanding(landed, {
    goBack: () => runOnServer('browser_navigate_back', {}),
    goBlank: () => runOnServer('browser_navigate', { url: 'about:blank' }),
    currentUrl: () => session.pageUrl
  });
  if (offLimits) {
    return toolResult({
      status: 'error',
      summary: `Left that page: ${name === 'browser_navigate' ? 'it redirected' : 'that step led'} to ${urlLabel(landed)} - ${offLimits}.`,
      nextActions: ['do NOT reach that site another way. Tell the user what you needed from it.'],
      error: { code: 'SITE_NOT_APPROVED' }
    });
  }
  return out;
}

async function runOnServer(name, args) {
  try {
    const result = await session.client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
    // Labels come from the FULL text, before the 30k cut, and build up across snapshots of the
    // same page, so a ref the model still holds keeps its real label
    const fullText = (result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    session.labels = new Map([...(session.labels ?? []), ...pageLabels(fullText)]);
    session.pageUrl = pageUrlOf(fullText) ?? session.pageUrl;
    return formatBrowserResult(name, result);
  } catch (err) {
    return toolResult({
      status: 'error',
      summary: `${name} failed: ${err.message}`,
      nextActions: [hintFor(err.message)],
      error: { code: 'BROWSER_ERROR' }
    });
  }
}

/** Stop the server (which closes Chrome) and delete its output folder. Never throws. */
export async function closeBrowser() {
  if (!session) return;
  const { client, outputDir } = session;
  session = null;
  try {
    await client.close();
  } catch (err) {
    console.warn(`[browser server close failed: ${err.message}]`);
  }
  fs.rmSync(outputDir, { recursive: true, force: true });
}
