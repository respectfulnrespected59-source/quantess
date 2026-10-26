import { test } from 'node:test';
import assert from 'node:assert/strict';
import { USAGE, parseFlags, refusedWithoutPerson } from './flags.js';

// quantus-cli's switches, in quantess: they are read off the command line and never leak into the task text

test('switches come off the command line and the task keeps only its words', () => {
  const f = parseFlags(['--persona', 'quanti-code', '--teach', '--no-learn', '--ask', 'fix', 'the', 'kart', 'boost']);
  assert.equal(f.persona, 'quanti-code');
  assert.equal(f.teach, true);
  assert.equal(f.learn, false);
  assert.equal(f.ask, true);
  assert.deepEqual(f.rest, ['fix', 'the', 'kart', 'boost']);
});

test('the defaults: no persona, teach off, learning on, ask off, VS Code view auto', () => {
  const f = parseFlags(['hello']);
  assert.deepEqual({ persona: f.persona, teach: f.teach, learn: f.learn, ask: f.ask, vscode: f.vscode }, { persona: null, teach: false, learn: true, ask: false, vscode: 'auto' });
  assert.equal(parseFlags(['--vscode']).vscode, 'on');
  assert.equal(parseFlags(['--no-vscode']).vscode, 'off');
});

// 10-24: config named a deepModel (Ultra) "for --deep" but no flag ever switched it on - every build ran on Lightning
test('--deep asks for the big thinker; off by default; it never becomes part of the task', () => {
  const f = parseFlags(['--deep', '--no-learn', 'build', 'the', 'site']);
  assert.equal(f.deep, true);
  assert.deepEqual(f.rest, ['build', 'the', 'site']);
  assert.equal(parseFlags(['hello']).deep, false);
  assert.match(USAGE, /--deep/);
});

test('negative: --persona with no name is an error, never a persona called "--teach"', () => {
  assert.match(parseFlags(['--persona']).error, /persona needs a name/);
  assert.match(parseFlags(['--persona', '--teach']).error, /persona needs a name/);
});

test('--paid stays for its own parser, untouched', () => {
  assert.deepEqual(parseFlags(['--teach', '--paid', '2', 'make', 'it']).rest, ['--paid', '2', 'make', 'it']);
});

// Code review 10-23: --doctor, --version and --signin worked only as the very first word
test('the one-off commands are found anywhere on the line', () => {
  assert.equal(parseFlags(['--ask', '--doctor']).command, 'doctor');
  assert.equal(parseFlags(['-v']).command, 'version');
  assert.equal(parseFlags(['--teach', '--version']).command, 'version');
  const signin = parseFlags(['--no-vscode', '--signin', 'https://quantus-ai.onrender.com']);
  assert.equal(signin.command, 'signin');
  assert.equal(signin.signinUrl, 'https://quantus-ai.onrender.com');
  assert.equal(parseFlags(['fix', 'it']).command, null);
});

// Phase 6: pick up the last session
// 10-23: `quantess --help` went to the model as a task ("Running task: --help"), at a cost, and printed no usage
test('--help and -h print the usage instead of running as a task', () => {
  for (const arg of ['--help', '-h']) {
    const flags = parseFlags([arg]);
    assert.equal(flags.command, 'help');
    assert.deepEqual(flags.rest, []);
  }
  for (const word of ['quantess', '--teach', '--ask', '--persona', '--no-learn', '--continue', '--version', '--doctor', '--signin', '--help']) {
    assert.ok(USAGE.includes(word), `usage names ${word}`);
  }
});

// T-LINK Phase 2: pair / unpair this PC with the phone, or keep T-LINK off for one run
test('--tlink-pair [url], --tlink-unpair and --no-tlink', () => {
  assert.deepEqual((({ command, tlinkUrl }) => ({ command, tlinkUrl }))(parseFlags(['--tlink-pair'])), { command: 'tlink-pair', tlinkUrl: null });
  assert.equal(parseFlags(['--tlink-pair', 'http://localhost:3000']).tlinkUrl, 'http://localhost:3000');
  assert.equal(parseFlags(['--tlink-pair', '--no-learn']).tlinkUrl, null, 'a flag after it is not a url');
  assert.equal(parseFlags(['--tlink-unpair']).command, 'tlink-unpair');
  assert.equal(parseFlags(['hello']).tlink, true, 'on by default once paired');
  assert.equal(parseFlags(['--no-tlink', 'go']).tlink, false);
  assert.deepEqual(parseFlags(['--no-tlink', 'go']).rest, ['go']);
  for (const word of ['--tlink-pair', '--tlink-unpair', '--no-tlink']) assert.ok(USAGE.includes(word), word);
});

// Hosted mode: `quantess login / whoami / logout` - the word alone is the command, in a sentence it is a task
test('login, whoami and logout alone (or as --flags) are commands; inside a task they stay words for the model', () => {
  for (const word of ['login', 'whoami', 'logout']) {
    assert.deepEqual((({ command, rest }) => ({ command, rest }))(parseFlags([word])), { command: word, rest: [] });
    assert.equal(parseFlags([`--${word}`]).command, word);
    assert.ok(USAGE.includes(`quantess ${word}`), word);
  }
  assert.equal(parseFlags(['login', '--deep']).command, 'login', 'a switch beside it does not make it a task');
  for (const task of [['login', 'page', 'is', 'broken'], ['fix', 'the', 'login'], ['whoami?']]) {
    const flags = parseFlags(task);
    assert.equal(flags.command, null, task.join(' '));
    assert.deepEqual(flags.rest, task);
  }
});

test('--continue (or -c) asks to resume the newest saved session; off by default', () => {
  assert.equal(parseFlags(['--continue']).continue, true);
  assert.equal(parseFlags(['-c', 'and', 'now']).continue, true);
  assert.deepEqual(parseFlags(['-c', 'and', 'now']).rest, ['and', 'now']);
  assert.equal(parseFlags(['hi']).continue, false);
});

// Security review of 4d1cc19: binding or dropping a key needs a person at a real terminal, never a piped agent shell
test('login, logout and T-LINK pairing refuse to run without an interactive terminal; other commands do not care', () => {
  for (const command of ['login', 'logout', 'tlink-pair', 'tlink-unpair']) {
    assert.match(refusedWithoutPerson(command, { stdinTTY: false, stdoutTTY: false }), /your own terminal/, command);
    assert.match(refusedWithoutPerson(command, { stdinTTY: true, stdoutTTY: false }), /your own terminal/, command);
    assert.equal(refusedWithoutPerson(command, { stdinTTY: true, stdoutTTY: true }), null, command);
  }
  for (const command of ['whoami', 'doctor', 'version', null]) {
    assert.equal(refusedWithoutPerson(command, { stdinTTY: false, stdoutTTY: false }), null, String(command));
  }
});

test('--logout inside a task stays a task (an "add a --logout button" request is not a sign-out)', () => {
  const flags = parseFlags(['add', 'a', '--logout', 'button']);
  assert.equal(flags.command, null);
  assert.deepEqual(flags.rest, ['add', 'a', '--logout', 'button']);
});

// Verification review of 37321b2: the agent's mark beats any terminal; Git Bash (mintty) users can still sign in
test('the agent-shell mark refuses sign-in even in a real terminal; no variable stands in for a terminal (Git Bash gets the way round)', async () => {
  const { AGENT_SHELL_MARK } = await import('./flags.js');
  const tty = { stdinTTY: true, stdoutTTY: true };
  assert.match(refusedWithoutPerson('login', { ...tty, env: { [AGENT_SHELL_MARK]: '1' } }), /your own terminal/);
  assert.match(refusedWithoutPerson('tlink-pair', { ...tty, env: { [AGENT_SHELL_MARK]: '1' } }), /your own terminal/);
  assert.equal(refusedWithoutPerson('login', { ...tty, env: { MSYSTEM: 'MINGW64' } }), null, 'Git Bash with a real console (ConPTY / winpty)');
  for (const env of [{ MSYSTEM: 'MINGW64' }, { TERM_PROGRAM: 'mintty' }]) {
    const said = refusedWithoutPerson('login', { stdinTTY: false, stdoutTTY: false, env });
    assert.match(said, /your own terminal/);
    assert.match(said, /once from PowerShell/);
    assert.match(said, /winpty quantess\.cmd login/);
  }
  assert.match(refusedWithoutPerson('login', { stdinTTY: false, stdoutTTY: false, env: { MSYSTEM: 'MINGW64', [AGENT_SHELL_MARK]: '1' } }), /your own terminal/);
  assert.match(refusedWithoutPerson('login', { stdinTTY: false, stdoutTTY: false, env: {} }), /your own terminal/);
});
