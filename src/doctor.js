/**
 * quantess --doctor: prove this PC can do a quantess job. It asks the real thing (opens the
 * library, starts the browser server, launches Chrome) instead of reading config, because
 * a PC can look installed and still be missing a piece.
 */
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { config } from './config/index.js';
import { loadSkills, MEMORY_DIR, SKILLS_DIR } from './skills/index.js';
import { browserToolDefinitions, callBrowserTool, closeBrowser, resolveProfile, SIGNIN_URL } from './browser/index.js';
import { runShell } from './tools/index.js';
import { rigPwsh } from './tools/shell.js';
import { readMcpConfig, startMcpServers, closeMcpServers, mcpConfigFile } from './mcp.js';
import { probeTlink, tlinkCheck } from './tlink/cliLink.js';
import { provider } from './provider.js';
import { whoami } from './hosted/login.js';
import { isOwnerInstall } from './brief.js';

// The folder quantess is installed in (where npm install and git pull run)
const INSTALL_DIR = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]$/, '');

const MARK = { ok: chalk.green('OK  '), warn: chalk.yellow('WARN'), fail: chalk.red('FAIL') };

const check = (level, label, detail) => ({ level, label, detail });

/** The user's MCP servers (~/.quantess/mcp.json): optional; a bad entry or a server that will not start warns. */
export function checkMcp(mcpConfig, started) {
  const problems = [...(mcpConfig?.problems ?? []), ...(started?.problems ?? [])];
  if (problems.length) return check('warn', 'mcp servers', problems.join('; '));
  if (!mcpConfig?.servers?.length) return check('ok', 'mcp servers', `none set up (optional: ${mcpConfigFile()})`);
  return check('ok', 'mcp servers', `${started?.tools?.length ?? 0} tools from ${mcpConfig.servers.map((s) => s.name).join(', ')}`);
}

/**
 * Can this terminal make calls at all? Your own key (direct), or a sign-in to a paid QUAN-TESS AI plan (hosted - asked
 * of the site, not the file), or neither.
 */
export function checkProvider(p, me) {
  if (p?.mode === 'direct') return checkKey(p.apiKey);
  if (p?.mode === 'hosted') {
    if (!me?.ok) return check('fail', 'quantess plan', me?.why ?? 'The site could not say who this terminal is.');
    if (me.plan === 'free') return check('fail', 'quantess plan', `Signed in as ${me.name || '(no name)'} on the FREE plan: making calls needs Creator, Pro or Studio.`);
    return check('ok', 'quantess plan', `${me.name || '(no name)'} - ${me.plan} plan - terminal key ${me.masked}`);
  }
  return check('fail', 'sign-in', 'Not signed in: run quantess login (a paid QUAN-TESS AI plan), or set OPENROUTER_API_KEY.');
}

export function checkKey(key) {
  if (key && key.startsWith('sk-or-')) return check('ok', 'openrouter key', 'set (not shown)');
  return check('fail', 'openrouter key', 'OPENROUTER_API_KEY is missing or not an OpenRouter key (they start sk-or-).');
}

/**
 * The library quantess reads (its own skills plus Claude Code's ~/.claude). On the owner's install (their brief is
 * there) the library is required: empty memory means quantess cannot see the standing orders on this PC. On a public
 * install it is optional - quantess works without Claude Code - so an empty library is not a failure.
 */
export function checkLibrary(library, memoryDir, { owner = isOwnerInstall() } = {}) {
  const count = (kind) => library.filter((s) => s.kind === kind).length;
  const has = (name) => library.some((s) => s.name === name);
  const need = (n, label, fix) => {
    if (n > 0) return check('ok', label, `${n} found`);
    return owner ? check('fail', label, fix) : check('ok', label, `none (optional: ${fix})`);
  };
  const entries = [
    need(count('skill'), 'skills', owner
      ? `none in ${SKILLS_DIR}. Copy ~/.claude/skills over from your main PC.`
      : `quantess also uses Claude Code skills in ${SKILLS_DIR}`),
    need(count('memory'), 'memory', owner
      ? `no notes in ${memoryDir}. Sync the memory repo, or set Q23_MEMORY_DIR to its folder.`
      : `Claude Code memory notes in ${memoryDir}`),
    need(count('agent'), 'agents', owner ? 'no agent roles in ~/.claude/agents.' : 'agent roles in ~/.claude/agents'),
    need(count('rule'), 'rules', owner ? 'no rules in ~/.claude/rules.' : 'rules in ~/.claude/rules')
  ];
  if (!owner) return entries;
  return [...entries, has('q23-takeover')
    ? check('ok', 'q23-takeover', 'start routine found')
    : check('fail', 'q23-takeover', `skill missing. git pull in ${INSTALL_DIR}.`)];
}

const PROFILE_FROM = { q23: "quantess's own", claude: 'shared with Claude Code', env: 'from Q23_BROWSER_PROFILE' };

export function checkProfile(profile, signedIn) {
  if (!signedIn) {
    return check('warn', 'quan-tess login', `not signed in on ${profile.dir}. Run: quantess --signin  (sign in, then close the window)`);
  }
  return check('ok', 'quan-tess login', `signed in (${PROFILE_FROM[profile.source]} profile: ${profile.dir})`);
}

/**
 * run_shell needs PowerShell 7: without it Q23 falls back to cmd.exe, where the PowerShell the
 * models write fails ("'ls' is not recognized"). `result` is a real run_shell of a version query.
 */
export function checkShell(pwshPath, result) {
  if (!pwshPath) {
    return check('warn', 'shell', 'PowerShell 7 not found: run_shell uses cmd.exe. Fix: winget install Microsoft.PowerShell, then open a new window.');
  }
  if (result?.status !== 'success') {
    return check('fail', 'shell', `pwsh found at ${pwshPath} but a test command failed: ${result?.summary ?? 'no result'}. Or set Q23_SHELL=cmd.`);
  }
  return check('ok', 'shell', `PowerShell ${String(result.data).trim()} (pwsh)`);
}

export function exitCode(checks) {
  return checks.some((c) => c.level === 'fail') ? 1 : 0;
}

/** Signed-in Quan-Tess pages show a "Sign out" button; the signed-out page does not. */
export const isSignedIn = (page) => /button "Sign out"/.test(page ?? '');
const hasAuthButton = (page) => /button "Sign (in|out)"/.test(page ?? '');

const AUTH_POLL_TRIES = 5;

/** The header draws Sign in / Sign out only after the page checks the session: wait for it. */
async function readSignedIn(firstPage) {
  let page = firstPage;
  for (let i = 0; i < AUTH_POLL_TRIES && !hasAuthButton(page); i++) {
    await callBrowserTool('browser_wait_for', { time: 2 });
    page = (await callBrowserTool('browser_snapshot', {})).data?.page;
  }
  return isSignedIn(page);
}

/**
 * Start the server and open Quan-Tess in Chrome: proves the binary, the profile, the lock and
 * the sign-in by asking the live page. (A Cookies file is no proof: Chrome makes an empty one
 * on first launch.)
 */
async function checkBrowser() {
  const profile = resolveProfile();
  const results = [];
  try {
    const tools = await browserToolDefinitions({ profile });
    results.push(check('ok', 'browser server', `${tools.length} browser tools`));
    const opened = await callBrowserTool('browser_navigate', { url: SIGNIN_URL });
    if (opened.status !== 'ok') {
      results.push(check('fail', 'chrome launch', `${opened.summary}. Fix: ${opened.nextActions.join('; ')}. Is Google Chrome installed?`));
      return results;
    }
    results.push(check('ok', 'chrome launch', 'Chrome opened Quan-Tess with this profile'));
    results.push(checkProfile(profile, await readSignedIn(opened.data?.page)));
  } catch (error) {
    results.push(check('fail', 'browser server', `${error.message}. Run npm install in ${INSTALL_DIR}.`));
  } finally {
    await closeBrowser();
  }
  return results;
}

export async function runDoctor() {
  console.log(chalk.cyan('\nquantess doctor: checking what this PC can actually do\n'));
  const mcpConfig = readMcpConfig();
  // Like Chrome: start each configured server for real and count its tools, then stop them
  const mcpStarted = mcpConfig.servers.length ? await startMcpServers(mcpConfig) : null;
  await closeMcpServers();
  const checks = [
    check(Number(process.versions.node.split('.')[0]) >= 20 ? 'ok' : 'fail', 'node', process.version),
    await (async () => {
      const p = provider();
      return checkProvider(p, p.mode === 'hosted' ? await whoami() : null);
    })(),
    checkShell(rigPwsh(), rigPwsh() ? await runShell('$PSVersionTable.PSVersion.ToString()', { timeout: 20000 }) : null),
    ...checkLibrary(loadSkills(), MEMORY_DIR),
    checkMcp(mcpConfig, mcpStarted),
    ...await checkBrowser(),
    // T-LINK: optional; a PC the site has forgotten goes red (it asks the site, not the file)
    await (async () => {
      const { pairing, probe } = await probeTlink();
      return tlinkCheck(pairing, probe);
    })()
  ];
  for (const c of checks) console.log(`  ${MARK[c.level]} ${c.label.padEnd(16)} ${chalk.gray(c.detail)}`);
  const code = exitCode(checks);
  console.log(code === 0 ? chalk.green('\nReady.\n') : chalk.red('\nNot ready: fix every FAIL above, then run --doctor again.\n'));
  return code;
}
