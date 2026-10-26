#!/usr/bin/env node
import { Agent } from './agent.js';
import { listSessions, exportSession, sessionDir, latestStateId } from './session/index.js';
import { appendHandoff } from './handoff.js';
import fs from 'fs';
import path from 'path';
import { createEvalTemplate, runEvals } from './evals/index.js';
import { config } from './config/index.js';
import prompts from 'prompts';
import chalk from 'chalk';
import { loadSkills, searchSkills, findSkill } from './skills/index.js';
import {
  closeBrowser, isAllowedUrl, openForSignIn, parsePaidFlag, SIGNIN_URL, setPaidClickApprover,
  setPaidClickBudget
} from './browser/index.js';
import { runDoctor } from './doctor.js';
import { setPublishApprover } from './pushGate.js';
import { createVscode } from './vscode.js';
import { toolLine, resultLine, safeText, checklistLines } from './activity.js';
import { stopAllJobs } from './tools/jobs.js';
import { setSiteApprover } from './browser/siteGate.js';
import { defaultMemory, setMemoryApprover } from './memory.js';
import { USAGE, parseFlags, refusedWithoutPerson } from './flags.js';
import { migrateHome } from './home.js';
import { closeMcpServers } from './mcp.js';
import { runToEnd, autoContinueRounds } from './continueRun.js';
import { createAskers } from './askUser.js';
import { startTlink } from './tlink/cliLink.js';
import { pairDevice, unpairDevice } from './tlink/pair.js';
import { login, logout, whoami } from './hosted/login.js';
import { maskKey } from './hosted/auth.js';
import { hostedModel, provider } from './provider.js';
import { spentToday, dailyCapUsd } from './budget.js';
import { parseReplInput } from './replInput.js';
import { appendToSession } from './session/index.js';

const LF = String.fromCharCode(10);
import ora from 'ora';

/**
 * Print banner
 */
function printBanner(model = config.agent.defaultModel) {
  const paidBy = provider();
  console.log(chalk.cyan.bold('\n╔══════════════════════════════════════════╗'));
  console.log(chalk.cyan.bold('║                 QUANTESS                 ║'));
  console.log(chalk.cyan.bold('║   one command - builds, runs, researches ║'));
  console.log(chalk.cyan.bold('╚══════════════════════════════════════════╝\n'));
  console.log(chalk.gray(`Model: ${paidBy.mode === 'hosted' ? hostedModel(model) : model}`));
  console.log(chalk.gray(paidBy.mode === 'hosted'
    ? `Paid by: your QUAN-TESS AI plan (terminal key ${maskKey(paidBy.apiKey)})`
    : paidBy.mode === 'direct' ? 'Paid by: your own OpenRouter key' : 'Not signed in'));
  console.log(chalk.gray(`Workspace: ${process.cwd()}\n`));
}

/**
 * Print help
 */
function printHelp() {
  console.log(chalk.bold('\nCommands:'));
  console.log(chalk.gray('  /help              - Show this help'));
  console.log(chalk.gray('  /skills [topic]    - List or search the skill library'));
  console.log(chalk.gray('  /model <name>      - Switch model'));
  console.log(chalk.gray('  /session           - List sessions'));
  console.log(chalk.gray('  /session <id>      - Load session'));
  console.log(chalk.gray('  /new               - Start new session'));
  console.log(chalk.gray('  /compact           - Fold the older part of this session into a summary'));
  console.log(chalk.gray('  /export <format>   - Export session (md/txt/json)'));
  console.log(chalk.gray('  /cost              - Show cost summary'));
  console.log(chalk.gray('  /eval <name>       - Create eval template'));
  console.log(chalk.gray('  /run-eval <name>   - Run evals'));
  console.log(chalk.gray('  /vscode            - Toggle the VS Code view (changed files open at the line)'));
  console.log(chalk.gray('  /persona [name]    - Work as quantus, quanti-code, quanta-clause, quant-ology (or any agent)'));
  console.log(chalk.gray('  /teach             - Teach mode: every step explained so you learn it'));
  console.log(chalk.gray('  /learn             - Save what this session taught (also runs at /exit; --no-learn skips)'));
  console.log(chalk.gray('  /tlink [on|off|allow-yes 2h|revoke-yes] - T-LINK: your phone watches, and answers y/n within the rules'));
  console.log(chalk.gray('  /memory            - What quantess has learned (its own notes)'));
  console.log(chalk.gray('  /forget <name>     - Delete one memory'));
  console.log(chalk.gray('  /clear             - Clear screen'));
  console.log(chalk.gray('  /exit, /quit       - Exit'));
  console.log(chalk.gray('  (outside quantess) quantess --doctor - check this PC can run quantess jobs'));
  console.log(chalk.gray('  (outside quantess) quantess --signin [url] - sign in to a site in quantess\'s own Chrome'));
  console.log(chalk.gray('  (outside quantess) quantess --paid 2 "task" - pre-approve 2 money clicks for a hands-off run'));
  console.log(chalk.gray('  (outside quantess) quantess --ask | --teach | --persona <name> | --no-learn - how it works with you'));
  console.log(chalk.gray('  (outside quantess) quantess --continue - pick up your last session (Ctrl+C stops a job, twice quits)\n'));
}

let activeSpinner = null;

/** Claude's shift log: one block per turn that used tools, written by the program (src/handoff.js). */
function logHandoff(task, result) {
  const sessionPath = result?.sessionId ? path.join(sessionDir(), `${result.sessionId}.md`) : undefined;
  appendHandoff({ task, result, sessionPath });
}

/** One activity line: stop the spinner, print, start it again, so the line never tears through it. */
function showStep(line) {
  activeSpinner?.stop();
  console.log(line);
  activeSpinner?.start();
}

// The user's five y/n questions (money click, push / merge, --ask change, memory, new site): src/askUser.js. Ctrl-C at any of
// them stops the whole job; quantess itself can never answer them.
const ask = createAskers({ prompts, quit, spinner: () => activeSpinner });

// quantus-cli's four personas, shipped in the repo's agents/ folder
const PERSONAS = ['quantus', 'quanti-code', 'quanta-clause', 'quant-ology'];

/** The learning pass: the model saves what this session taught it (nothing runs if no tool was used). */
async function learnFrom(agent) {
  // With nobody to approve, a session that read outside text cannot save a memory: do not spend a call trying
  if (agent.readOutside && !process.stdin.isTTY) {
    console.log(chalk.gray('(learning pass skipped: nobody at the terminal to approve memories from this session)'));
    return;
  }
  const spinner = ora('Learning from this session').start();
  activeSpinner = spinner;
  try {
    const learned = await agent.reflect();
    spinner.stop();
    if (learned) console.log(chalk.cyan(`  ✎ ${safeText(learned).split(LF)[0]}`));
  } catch (err) {
    spinner.stop();
    console.log(chalk.gray(`(learning pass skipped: ${safeText(err.message)})`));
  } finally {
    activeSpinner = null;
  }
}

// T-LINK for this session (src/tlink/cliLink.js), or null when this PC is not paired
let activeLink = null;
// 10-24: on Windows, process.exit() while fetch's sockets are still closing trips a libuv assertion
// ("!(handle->flags & UV_HANDLE_CLOSING)", exit 0xC0000409) - every T-LINK pairing and session ended that way.
// Measured: 1 ms still crashed, 20 ms mostly passed, 100 ms always passed. Give the closes this long before exiting.
const EXIT_SETTLE_MS = 150;

/** After a turn: the phone gets the answer and the day's spend. */
function tlinkTurnEnd(hooks, result) {
  if (!hooks) return;
  // A refusal is not an answer: the phone shows it as one
  if (result?.response) hooks.answer(result.refused ? `Not completed: ${result.response}` : result.response);
  hooks.spend({ today: spentToday(), cap: dailyCapUsd(process.env, config.agent.dailyCapUsd), turn: Number(result?.cost?.totalCost) });
}

/** Stop background jobs, close Chrome and the browser server before leaving, so nothing keeps a port or the profile. */
async function quit(code) {
  // T-LINK tells the site the session is over (it never holds quantess up for long)
  await activeLink?.end().catch(() => {});
  stopAllJobs();
  await closeMcpServers();
  await closeBrowser();
  await new Promise((resolve) => setTimeout(resolve, EXIT_SETTLE_MS));
  process.exit(code);
}

// The job running now: Ctrl+C stops IT and keeps quantess (Phase 6). A second Ctrl+C, or one with no job running,
// quits - and quit() still closes Chrome so the profile is never left locked
let turnStop = null;
process.on('SIGINT', () => {
  if (turnStop && !turnStop.signal.aborted) {
    turnStop.abort();
    activeSpinner?.stop();
    console.log(chalk.yellow(`${LF}Stopping this job... (Ctrl+C again quits quantess)`));
    return;
  }
  quit(130);
});

/** One job, stoppable with Ctrl+C. */
async function runStoppable(agent, task) {
  turnStop = new AbortController();
  try {
    return await agent.run(task, { signal: turnStop.signal });
  } finally {
    turnStop = null;
  }
}
process.once('SIGTERM', () => quit(143));
// Closing the terminal window; and any other way out, so no dev server outlives quantess
process.once('SIGHUP', () => quit(129));
process.on('exit', stopAllJobs);

async function signIn(url) {
  console.log(chalk.cyan(`\nOpening quantess's own Chrome at ${url}`));
  console.log(chalk.gray('Sign in yourself (quantess never sees your password), then CLOSE that Chrome window.\n'));
  const profile = await openForSignIn(url);
  console.log(chalk.green(`Saved. quantess will use this sign-in: ${profile.dir}\n`));
  if (!isAllowedUrl(url)) {
    const host = URL.canParse(url) ? new URL(url).hostname : url;
    console.log(chalk.yellow(`quantess is not allowed on ${host} yet. To allow it: setx Q23_BROWSER_ALLOW "${host}" (then open a new window)\n`));
  }
}

/**
 * Main REPL loop
 */
async function main() {
  // quantus-cli's switches: --persona <name>, --teach, --no-learn, --ask; the VS Code view by --vscode / --no-vscode.
  // The one-off commands (--version, --doctor, --signin) work anywhere on the line
  const flags = parseFlags(process.argv.slice(2));
  if (flags.command === 'help') {
    console.log(USAGE);
    return quit(0);
  }
  if (flags.command === 'version') {
    const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(`quantess ${version}`);
    return quit(0);
  }
  if (flags.command === 'doctor') {
    return quit(await runDoctor());
  }
  if (flags.command === 'signin') {
    await signIn(flags.signinUrl || SIGNIN_URL);
    return quit(0);
  }
  // Pairing, signing in and out need a person at a real terminal - never the agent's own (piped) shells
  const needsPerson = refusedWithoutPerson(flags.command, { stdinTTY: process.stdin.isTTY, stdoutTTY: process.stdout.isTTY, env: process.env });
  if (needsPerson) {
    console.error(chalk.red(needsPerson));
    return quit(2);
  }
  // T-LINK: link the phone (a code shows here; the user approves this PC on the site) or forget the link
  if (flags.command === 'tlink-pair') {
    const paired = await pairDevice({ ...(flags.tlinkUrl ? { origin: flags.tlinkUrl } : {}), print: (l) => console.log(chalk.cyan(l)) });
    console.log(paired.ok
      ? chalk.green(`\nT-LINK paired (${paired.deviceId}, key ${paired.masked}). Start quantess and your phone can watch.\n`)
      : chalk.red(`\nT-LINK not paired: ${paired.why}\n`));
    return quit(paired.ok ? 0 : 1);
  }
  if (flags.command === 'tlink-unpair') {
    const gone = await unpairDevice();
    console.log(chalk.green(`T-LINK: this PC is forgotten here${gone.revoked ? ' and on the site' : ' (the site could not be reached - revoke it there too)'}.`));
    return quit(0);
  }

  // Hosted mode: sign this terminal in to the QUAN-TESS AI plan (a code shows here), ask who it is, or forget it here
  if (flags.command === 'login') {
    const done = await login({ print: (l) => console.log(chalk.cyan(l)) });
    console.log(done.ok
      ? chalk.green(`\nSigned in (terminal key ${done.masked}). Start quantess: your QUAN-TESS AI plan pays for its calls.\n`)
      : chalk.red(`\nNot signed in: ${done.why}\n`));
    if (done.ok && done.replaced) {
      console.log(chalk.yellow(`This replaced the key ${done.replaced}, which still works on the site: revoke it at https://quantus-ai.onrender.com/cli/activate\n`));
    }
    if (done.ok && process.env.OPENROUTER_API_KEY && process.env.QUANTESS_HOSTED !== '1') {
      console.log(chalk.yellow('OPENROUTER_API_KEY is set, so quantess still uses YOUR key. To use the plan instead: setx QUANTESS_HOSTED 1 (then open a new window).\n'));
    }
    return quit(done.ok ? 0 : 1);
  }
  if (flags.command === 'whoami') {
    const me = await whoami();
    console.log(me.ok
      ? chalk.green(`Signed in as ${me.name || '(no name)'} - plan: ${me.plan} - terminal key ${me.masked} ("${me.label}")`)
      : chalk.red(me.why));
    return quit(me.ok ? 0 : 1);
  }
  if (flags.command === 'logout') {
    const out = logout();
    console.log(out.removed
      ? chalk.green(`Signed out on this PC (${out.keyId}). To end the key for good, revoke it at ${out.revokeAt}`)
      : chalk.gray('This terminal was not signed in.'));
    return quit(0);
  }

  printBanner(flags.deep ? config.agent.deepModel : undefined);
  // No key of your own and not signed in: nothing could answer, so say how to start instead of failing on the first call
  if (provider().mode === 'none') {
    console.log(chalk.yellow('quantess needs a sign-in: run  quantess login  (a paid QUAN-TESS AI plan pays for its calls),'));
    console.log(chalk.yellow('or set your own OPENROUTER_API_KEY.\n'));
    return quit(1);
  }

  // One home: the old quantessq23 sessions and quantus memories / spend come over once (old folders untouched).
  // A folder it cannot write must not stop quantess from starting
  try {
    const moved = migrateHome();
    if (moved && moved.sessions + moved.memories + moved.ledgerDays > 0) {
      console.log(chalk.gray(`Moved into ~/.quantess: ${moved.sessions} sessions, ${moved.memories} memories, ${moved.ledgerDays} days of spend (old folders untouched)${LF}`));
    }
  } catch (err) {
    console.log(chalk.yellow(`[could not move the old quantus / q23 folders in: ${safeText(err.message)}]${LF}`));
  }

  if (flags.error) {
    console.error(chalk.red(flags.error));
    return quit(2);
  }
  const persona = flags.persona ? findSkill(`agent:${flags.persona}`) : null;
  if (flags.persona && !persona) {
    console.error(chalk.red(`No persona named "${flags.persona}". Try: ${PERSONAS.join(', ')}`));
    return quit(2);
  }
  const vscode = createVscode({ setting: flags.vscode, onProblem: (m) => console.log(chalk.yellow(`\n[${m}]`)) });
  if (vscode.enabled) console.log(chalk.gray('VS Code view on: each file quantess changes opens at the changed line (/vscode to toggle)\n'));

  // T-LINK: the phone watches, and (with a real terminal) can answer the y/n questions within the policy
  let agent;
  activeLink = startTlink({
    enabled: flags.tlink, interactive: Boolean(process.stdin.isTTY), ask,
    sessionId: () => agent?.sessionId || 'starting',
    print: (line) => showStep(chalk.magenta(line)),
    audit: (line) => { if (agent?.sessionId) appendToSession(agent.sessionId, 'system', line); }
  });
  if (activeLink) console.log(chalk.magenta(`${activeLink.banner()}${LF}`));
  const approvers = activeLink?.askers ?? ask;
  const link = activeLink?.hooks;

  agent = new Agent({
    // --deep: the big thinker first; the usual fallbacks behind it
    model: flags.deep ? config.agent.deepModel : undefined,
    persona,
    teach: flags.teach,
    learn: flags.learn,
    // --ask: each file change or command waits for the user's yes / always / no (nobody at a terminal = nothing changes)
    askBeforeChanges: flags.ask,
    // A server in ~/.quantess/mcp.json that will not start is said once, never fatal
    onMcpProblem: (problem) => showStep(chalk.yellow(`[MCP: ${safeText(problem)}]`)),
    approveChange: process.stdin.isTTY ? approvers.change : null,
    onFileChanged: (file, line) => vscode.show(file, line),
    // The user watches each step the way Claude Code shows its own: a long job never looks frozen
    onToolStart: (name, args) => {
      showStep(chalk.cyan(`  ⎿ ${toolLine(name, args)}`));
      link?.toolStart(name, args);
    },
    onToolEnd: (name, result) => {
      link?.toolEnd(name, result);
      const line = resultLine(result);
      showStep(line.startsWith('✗') ? chalk.yellow(`    ${line}`) : chalk.gray(`    ${line}`));
      // The plan as a checklist, the way Claude Code shows its todo list
      if (name === 'todo_write' && result?.status === 'success') {
        for (const item of checklistLines(result.data?.items)) showStep(chalk.white(`      ${item}`));
      }
    }
  });
  let currentSessionId = null;

  // Money buttons: ask the user when they are at a terminal; --paid N pre-approves N for hands-off runs
  if (process.stdin.isTTY) setPaidClickApprover(approvers.pay);
  // Pushes and merges: same y/n, and with nobody at a terminal they are blocked outright
  if (process.stdin.isTTY) setPublishApprover(approvers.publish);
  // A new website: the user says yes (this session), always, or no. With nobody at a terminal, new sites are refused
  if (process.stdin.isTTY) setSiteApprover(approvers.site);
  // A memory after outside text: the user's yes, or it is not kept
  if (process.stdin.isTTY) setMemoryApprover(approvers.remember);
  const memories = defaultMemory().list().length;
  if (memories) console.log(chalk.gray(`${memories} memor${memories === 1 ? 'y' : 'ies'} saved (/memory to review, /forget <name> to delete one)${LF}`));
  if (persona || flags.teach) console.log(chalk.gray(`${persona ? `Persona: ${persona.name}` : ''}${persona && flags.teach ? ' · ' : ''}${flags.teach ? 'teach mode on' : ''}${LF}`));
  const paid = parsePaidFlag(flags.rest);
  if (paid.error) {
    console.error(chalk.red(paid.error));
    return quit(2);
  }
  if (paid.budget !== null) setPaidClickBudget(paid.budget);

  // --continue: the newest saved session, so a one-off task or the chat picks up where it left off
  if (flags.continue) {
    const id = latestStateId();
    if (id && agent.resume(id)) {
      console.log(chalk.gray(`Continuing session ${id} (${agent.messages.length - 1} messages)${LF}`));
    } else {
      console.log(chalk.gray(`Nothing saved to continue: starting a new session${LF}`));
    }
  }

  // Check for initial task from command line
  const args = paid.rest;
  if (args.length > 0 && !args[0].startsWith('/')) {
    const task = args.join(' ');
    console.log(chalk.yellow(`Running task: ${task}\n`));
    // T-LINK: give the session its id first, so the phone's first line is filed under it (not 'starting')
    if (activeLink && !agent.sessionId) await agent.initSession();
    // Out of steps mid-job: keep going a few turns (live 10-24: three rounds quit at the cap and still said "completed")
    link?.turnStart(task);
    const result = await runToEnd((t) => runStoppable(agent, t), task, {
      rounds: autoContinueRounds(),
      onPause: (round, rounds) => console.log(chalk.yellow(`\nOut of steps this turn - keeping going (${round} of ${rounds})...`))
    });
    logHandoff(task, result);
    tlinkTurnEnd(link, result);
    if (result.response) console.log(`\n${safeText(result.response)}`);
    if (result.error) console.log(chalk.yellow(`\nThe next turn failed: ${safeText(result.error)}`));
    console.log(result.stopped ? chalk.yellow('\nStopped')
      : result.refused ? chalk.red('\n✗ Not completed: the QUAN-TESS site refused the call (above).')
        : result.paused ? chalk.yellow('\nPaused: out of steps. Run quantess --continue and say "keep going".')
          : chalk.green('\n✓ Task completed'));
    console.log(chalk.gray(`Cost: $${result.cost.totalCost} | Iterations: ${result.iterations}`));
    // A refused turn learned nothing, and a learning call would only be refused again
    if (flags.learn && !result.refused) await learnFrom(agent);
    // Unattended runs can tell a plan or quota stop from a finished job
    await quit(result.refused ? 1 : 0);
  }
  
  // Start with a new session, or (--continue) the newest saved one
  if (agent.sessionId) {
    currentSessionId = agent.sessionId;
  } else {
    await agent.initSession();
    currentSessionId = agent.sessionId;
  }
  console.log(chalk.gray(`Session: ${currentSessionId}\n`));
  
  while (true) {
    try {
      const { input } = await prompts({
        type: 'text',
        name: 'input',
        message: chalk.cyan('>'),
        validate: v => v.length > 0 || 'Enter a command or task'
      });
      
      // prompts returns no value when the prompt is cancelled (Ctrl-C / Esc): treat that as exit
      if (input === undefined) {
        console.log(chalk.cyan('\nGoodbye!\n'));
        await quit(0);
      }
      // Decided on the trimmed line: live 10-24 a leading space sent "/tlink allow-yes 1h" to the model as a task
      const line = parseReplInput(input);
      if (line.kind === 'empty') continue;

      // Handle commands
      if (line.kind === 'command') {
        const { cmd, args } = line;
        
        switch (cmd) {
          case 'help':
            printHelp();
            break;

          case 'memory': {
            const all = defaultMemory().list();
            if (!all.length) console.log(chalk.gray('Nothing learned yet.'));
            for (const m of all) console.log(`  ${chalk.cyan(`[${m.type}]`)} ${m.name} ${chalk.gray(safeText(m.description).slice(0, 90))}`);
            if (all.length) console.log(chalk.gray(`${LF}${defaultMemory().dir}  ·  /forget <name> to delete one${LF}`));
            break;
          }

          case 'forget': {
            const target = args.join(' ').trim();
            console.log(target && defaultMemory().forget(target) ? chalk.green(`Forgot ${target}`) : chalk.yellow(`No memory named "${target}" (/memory lists them)`));
            break;
          }
            
          case 'skills': {
            const q = args.join(' ').trim();
            const list = q ? searchSkills(q, 40) : loadSkills();
            if (!list.length) {
              console.log(chalk.gray(q ? `No skill matches "${q}"` : 'No skills found. Is ~/.claude/skills present?'));
              break;
            }
            console.log(chalk.bold(`${LF}${list.length} skill(s)${q ? ` matching "${q}"` : ''}:${LF}`));
            if (q) {
              for (const sk of list) console.log(`  ${chalk.gray(`[${sk.kind}]`)} ${chalk.cyan(sk.name)} — ${chalk.gray((sk.description || '').slice(0, 100))}`);
            } else {
              const byKind = (k) => list.filter((sk) => sk.kind === k);
              console.log(chalk.gray(['skill', 'agent', 'rule', 'memory'].map((k) => `${byKind(k).length} ${k}`).join(' · ') + LF));
              console.log(chalk.gray(byKind('skill').map((sk) => sk.name).join(', ')));
              console.log(chalk.gray(`${LF}/skills <topic> to search, then just ask — the agent loads what it needs.`));
            }
            console.log('');
            break;
          }

          case 'model': {
            if (args.length === 0) {
              console.log(chalk.gray(`Current model: ${agent.model}`));
              console.log(chalk.gray(agent.hosted
                ? 'On your QUAN-TESS AI plan: nvidia/nemotron-3.5-lightning, nvidia/nemotron-3.5-super-vl, nvidia/nemotron-3-ultra-550b-a55b'
                : 'Free: cohere/north-mini-code:free, dots-studio/dots-3-note-preview:free, nvidia/nemotron-3.5-lightning:free  |  Paid: openai/gpt-4o-mini, anthropic/claude-3-haiku'));
            } else {
              const wanted = args.join(' ');
              // On the plan only the proxy's models run (lightning, super-vl, ultra): say which one will
              agent.model = agent.hosted ? hostedModel(wanted) : wanted;
              console.log(agent.model === wanted
                ? chalk.green(`Model switched to: ${agent.model}`)
                : chalk.yellow(`On your QUAN-TESS AI plan quantess runs Nemotron Lightning, Super-VL or Ultra: using ${agent.model}`));
            }
            break;
          }
          
          case 'session': {
            if (args.length === 0) {
              const sessions = listSessions();
              console.log(chalk.bold('\nSessions:'));
              sessions.forEach(s => {
                const marker = s === currentSessionId ? '*' : ' ';
                console.log(`  ${marker} ${s}`);
              });
            } else {
              if (agent.resume(args[0])) {
                currentSessionId = args[0];
                console.log(chalk.green(`Resumed session ${currentSessionId} (${agent.messages.length - 1} messages)`));
              } else {
                console.log(chalk.yellow('No saved conversation for that session (sessions from before 10-23 only have a transcript).'));
              }
            }
            break;
          }
          
          case 'new': {
            // Fresh prompt: memories saved during the last session are in it now
            agent.buildPrompt();
            await agent.initSession();
            currentSessionId = agent.sessionId;
            console.log(chalk.green(`New session: ${currentSessionId}`));
            break;
          }
          
          case 'compact': {
            // The model's history, not the transcript file: the older part becomes one summary note
            const folded = await agent.compact().catch((err) => {
              console.log(chalk.yellow(`Could not compact: ${safeText(err.message)}`));
              return null;
            });
            if (folded === false) console.log(chalk.gray('Nothing to compact yet: the session is short.'));
            if (folded) console.log(chalk.green(`Compacted: the older part is now a summary (${agent.messages.length} messages)`));
            break;
          }
          
          case 'export': {
            if (!currentSessionId) {
              console.log(chalk.red('No active session'));
              break;
            }
            const format = args[0] || 'md';
            const content = exportSession(currentSessionId, format);
            console.log(content);
            break;
          }
          
          case 'cost': {
            const summary = agent.getCostSummary();
            console.log(chalk.bold('\nCost Summary:'));
            console.log(chalk.gray(`  Input tokens:  ${summary.totalInputTokens.toLocaleString()}`));
            console.log(chalk.gray(`  Output tokens: ${summary.totalOutputTokens.toLocaleString()}`));
            console.log(chalk.green(`  Total cost:    $${summary.totalCost}`));
            if (Object.keys(summary.byModel).length > 0) {
              console.log(chalk.bold('\nBy Model:'));
              for (const [model, data] of Object.entries(summary.byModel)) {
                console.log(`  ${model}: $${data.cost.toFixed(6)} (${data.inputTokens.toLocaleString()} in / ${data.outputTokens.toLocaleString()} out)`);
              }
            }
            break;
          }
          
          case 'eval': {
            const name = args[0] || await prompts({
              type: 'text',
              name: 'name',
              message: 'Eval name:'
            });
            if (name) {
              const path = createEvalTemplate(name);
              console.log(chalk.green(`Created eval template: ${path}`));
            }
            break;
          }
          
          case 'run-eval': {
            const name = args[0] || (await prompts({
              type: 'text',
              name: 'name',
              message: 'Eval name to run:'
            })).name;
            if (name) {
              const spinner = ora(`Running evals for ${name}...`).start();
              try {
                const results = await runEvals(name, { modelClient: agent.client, model: agent.model });
                if (results.error) {
                  spinner.fail(results.error);
                  break;
                }
                spinner.succeed();
                console.log(chalk.bold(`\nResults for ${name}:`));
                console.log(chalk.gray(`  Capability: ${results.capability.passed}/${results.capability.total}`));
                console.log(chalk.gray(`  Regression: ${results.regression.passed}/${results.regression.total}`));
                results.capability.details.forEach(d => {
                  console.log(`    ${d.passed ? '✓' : '✗'} ${d.name}: ${d.detail}`);
                });
              } catch (err) {
                spinner.fail();
                console.error(chalk.red(err.message));
              }
            }
            break;
          }
          
          case 'vscode':
            console.log(chalk.cyan(`VS Code view ${vscode.toggle() ? 'ON: changed files open at the changed line' : 'OFF'}`));
            break;

          case 'clear':
            console.clear();
            printBanner(agent.model);
            break;
          
          case 'persona': {
            const name = args.join(' ').trim();
            if (!name) {
              console.log(chalk.gray(`Persona: ${agent.persona?.name ?? 'none'}. Pick one: ${PERSONAS.join(', ')} (or any agent from /skills)`));
              break;
            }
            const entry = findSkill(`agent:${name}`);
            if (!entry) {
              console.log(chalk.yellow(`No agent named "${name}". Try: ${PERSONAS.join(', ')}`));
              break;
            }
            agent.setPersona(entry);
            console.log(chalk.green(`Persona: ${entry.name}`));
            break;
          }

          case 'teach':
            agent.setTeach(!agent.teach);
            console.log(chalk.green(agent.teach ? 'Teach mode ON: every step is explained so you learn it' : 'Teach mode off'));
            break;

          case 'tlink':
            if (!activeLink) {
              console.log(chalk.gray(flags.tlink ? 'T-LINK is not paired on this PC: quantess --tlink-pair links your phone.' : 'T-LINK is off for this run (--no-tlink).'));
            } else {
              for (const line of activeLink.command(args)) console.log(chalk.magenta(line));
            }
            break;

          case 'learn':
            await learnFrom(agent);
            break;

          case 'exit':
          case 'quit':
            if (flags.learn) await learnFrom(agent);
            console.log(chalk.cyan('\nGoodbye!\n'));
            await quit(0);
            
          default:
            console.log(chalk.red(`Unknown command: /${cmd}`));
            printHelp();
        }
      } else {
        // Regular task - run agent
        const spinner = ora('Thinking...').start();
        activeSpinner = spinner;
        try {
          link?.turnStart(line.text);
          const result = await runStoppable(agent, line.text);
          tlinkTurnEnd(link, result);
          logHandoff(line.text, result);
          activeSpinner = null;
          if (result.stopped) spinner.warn('Stopped');
          else if (result.refused) spinner.fail('Not completed');
          else spinner.succeed('Done');
          console.log(`\n${result.response ? safeText(result.response) : chalk.yellow('(No reply from the model - try asking again.)')}\n`);
          if (result.cost.totalCost > 0) {
            console.log(chalk.gray(`\nCost this turn: $${result.cost.totalCost} | Iterations: ${result.iterations}`));
          }
        } catch (err) {
          activeSpinner = null;
          spinner.fail('Error');
          console.error(chalk.red(err.message));
        }
      }
    } catch (err) {
      if (err.name === 'ExitPromptError') {
        console.log(chalk.cyan('\nGoodbye!\n'));
        await quit(0);
      }
      console.error(chalk.red('Error:'), err.message);
    }
  }
}

// A one-shot task that throws (fallback chain exhausted) must still close Chrome, or the
// open browser-server pipes keep Node alive and the command hangs
main().catch(async (err) => {
  console.error(chalk.red(`Error: ${err.message}`));
  await quit(1);
});