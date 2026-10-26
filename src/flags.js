// The switches quantess reads off the command line (ported from quantus-cli). Whatever is left is the task;
// --paid stays in it for its own parser.
const SWITCHES = {
  '--teach': { teach: true },
  '--no-learn': { learn: false },
  // 10-24: config.agent.deepModel (Ultra) was named "for --deep" but nothing switched it on
  '--deep': { deep: true },
  '--ask': { ask: true },
  '--vscode': { vscode: 'on' },
  '--no-vscode': { vscode: 'off' },
  // T-LINK (10-24): keep the phone link off for this run
  '--no-tlink': { tlink: false },
  // Phase 6: pick up the newest saved session
  '--continue': { continue: true },
  '-c': { continue: true }
};

const COMMANDS = {
  '--version': 'version',
  '-v': 'version',
  '--doctor': 'doctor',
  '--signin': 'signin',
  // 10-23: --help used to go to the model as a task
  '--help': 'help',
  '-h': 'help',
  // T-LINK (10-24): pair this PC with the phone (device flow), or forget the pairing
  '--tlink-pair': 'tlink-pair',
  '--tlink-unpair': 'tlink-unpair'
};
// Hosted mode (your QUAN-TESS AI plan pays): sign this terminal in, out, or ask who it is. The word (or --word) alone on
// the line is the command; with anything else it stays a task for the model ("add a --logout button" is a task)
const ACCOUNT_WORDS = {
  login: 'login', logout: 'logout', whoami: 'whoami',
  '--login': 'login', '--logout': 'logout', '--whoami': 'whoami'
};

// Commands that bind or drop a key: a person must run them, never the agent (security reviews of 4d1cc19 and 37321b2).
// Every shell the agent starts carries AGENT_SHELL_MARK, which anything it launches inherits (a new window too), and a
// real terminal is always required - no environment variable stands in for one. Git Bash's mintty does not look like a
// terminal to Node, so it gets the way round instead: sign in once from PowerShell (the key is shared), or use winpty
const NEEDS_A_PERSON = new Set(['login', 'logout', 'tlink-pair', 'tlink-unpair']);
export const AGENT_SHELL_MARK = 'QUANTESS_AGENT_SHELL';

/**
 * Why this command may not run here, or null.
 * @param {{ stdinTTY?: boolean, stdoutTTY?: boolean, env?: NodeJS.ProcessEnv }} where
 */
export function refusedWithoutPerson(command, { stdinTTY, stdoutTTY, env = {} }) {
  if (!NEEDS_A_PERSON.has(command)) return null;
  const why = `quantess ${command} has to be run by you, at your own terminal (not from a script or the agent's own shell).`;
  if (env[AGENT_SHELL_MARK] === '1') return why;
  if (stdinTTY && stdoutTTY) return null;
  const gitBash = env.TERM_PROGRAM === 'mintty' || Boolean(env.MSYSTEM);
  return gitBash
    ? `${why} Git Bash does not show quantess a real terminal: run quantess ${command} once from PowerShell ` +
      `(or here: winpty quantess.cmd ${command}). After that, quantess works from Git Bash too.`
    : why;
}

/** What `quantess --help` prints. No model call. */
export const USAGE = `quantess - one command: builds, runs, researches

  quantess                      start a session (type a task, /help inside for commands)
  quantess "<task>"             run one task, then keep the session open
  quantess --continue  (-c)     pick up your newest saved session
  quantess --persona <name>     quantus, quanti-code, quanta-clause or quant-ology
  quantess --teach              explain each step as it works
  quantess --ask                ask before every shell command and file write
  quantess --no-learn           do not save new memories this session
  quantess --deep               the big thinker for hard builds (slower, ~4x the cost; the $5/day cap still holds)
  quantess --vscode / --no-vscode   show files in VS Code, or never
  quantess --doctor             check the key, models, browser and budget
  quantess --signin [url]       sign in to a site in quantess's browser (you type the password)
  quantess --tlink-pair         T-LINK: link your phone - watch jobs and answer y/n from it (a code shows here)
  quantess --tlink-unpair       T-LINK: forget this PC on the site and here
  quantess --no-tlink           T-LINK off for this run
  quantess login                sign this terminal in to your QUAN-TESS AI plan (a code shows here)
  quantess whoami               who this terminal is signed in as, and the plan
  quantess logout               forget the sign-in on this PC (revoke the key on the site)
  quantess --version  (-v)      print the version
  quantess --help  (-h)         this list

The old names quantus, quantessq23 and q23 run the same command.
Spending: signed in (quantess login), your QUAN-TESS AI plan pays (a paid plan; the site caps the day).
With your own OPENROUTER_API_KEY instead: paid Nemotron up to $5 a day, then free models only.`;

/**
 * @param {string[]} argv the arguments after the command name
 * @returns {{ persona: string|null, teach: boolean, learn: boolean, ask: boolean, vscode: 'auto'|'on'|'off',
 *   command: 'version'|'doctor'|'signin'|null, signinUrl: string|null, rest: string[], error?: string }}
 */
export function parseFlags(argv) {
  let flags = { persona: null, teach: false, learn: true, ask: false, deep: false, vscode: 'auto', continue: false, tlink: true,
    command: null, signinUrl: null, tlinkUrl: null };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    // One-off commands, found anywhere on the line (code review 10-23: they worked only as the first word)
    if (COMMANDS[arg]) {
      flags = { ...flags, command: COMMANDS[arg] };
      if (arg === '--signin' && argv[i + 1] && !argv[i + 1].startsWith('--')) {
        flags = { ...flags, signinUrl: argv[i + 1] };
        i += 1;
      }
      if (arg === '--tlink-pair' && argv[i + 1] && !argv[i + 1].startsWith('--')) {
        flags = { ...flags, tlinkUrl: argv[i + 1] };
        i += 1;
      }
    } else if (arg === '--persona') {
      const name = argv[i + 1];
      if (!name || name.startsWith('--')) {
        return { ...flags, rest, error: '--persona needs a name: quantus, quanti-code, quanta-clause or quant-ology' };
      }
      flags = { ...flags, persona: name };
      i += 1;
    } else if (SWITCHES[arg]) {
      flags = { ...flags, ...SWITCHES[arg] };
    } else {
      rest.push(arg);
    }
  }
  if (!flags.command && rest.length === 1 && Object.prototype.hasOwnProperty.call(ACCOUNT_WORDS, rest[0])) {
    return { ...flags, command: ACCOUNT_WORDS[rest[0]], rest: [] };
  }
  return { ...flags, rest };
}
