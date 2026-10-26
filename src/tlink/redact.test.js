import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayPaths, scrubSecrets, forPhone } from './redact.js';

// T-LINK: what may leave the PC for the phone (security model 6). Paths are shortened for display
// (lossless - the approval hash binds the original text); secrets are scrubbed (lossy - the prompt becomes No-only)

const HOME = 'C:\\Users\\riley';
const env = { OPENROUTER_API_KEY: 'sk-or-v1-0123456789abcdef0123456789abcdef', SESSIONNAME: 'Console',
  GIT_ASKPASS: 'C:\\Program Files\\Git\\askpass.exe', PATH: 'C:\\Windows' };

test('displayPaths shortens the home folder in every spelling, and only the home folder', () => {
  assert.equal(displayPaths('read C:\\Users\\riley\\my-site\\brief.md', { home: HOME }), 'read ~\\my-site\\brief.md');
  assert.equal(displayPaths('cd C:/Users/riley/q23-agent && npm test', { home: HOME }), 'cd ~/q23-agent && npm test');
  assert.equal(displayPaths('ls /c/Users/riley/Videos', { home: HOME }), 'ls ~/Videos');
  assert.equal(displayPaths('c:\\users\\RILEY', { home: HOME }), '~');
  assert.equal(displayPaths('C:\\Users\\rileyann\\x', { home: HOME }), 'C:\\Users\\rileyann\\x', 'a longer name is not the home');
});

test('scrubSecrets removes env secret values and common key formats, and says it did', () => {
  const cases = [
    `curl -H "Authorization: Bearer ${'a'.repeat(30)}" x`,
    'key sk-or-v1-0123456789abcdef0123456789abcdef in a log',
    'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx',
    '{"apiKey":"abcdefghijklmnop"}',
    'https://api.x.com/v1?token=abcdef123456&q=1',
    'git clone https://riley:hunter2hunter2@github.com/x.git',
    'ghp_0123456789abcdefghijklmnopqrstuvwxyz',
    'AKIAIOSFODNN7EXAMPLE',
    `eyJhbGciOiJIUzI1NiJ9.${'b'.repeat(20)}.${'c'.repeat(20)}`,
    `tlk_${'Z'.repeat(43)}`,
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----'
  ];
  for (const text of cases) {
    const out = scrubSecrets(text, { env });
    assert.equal(out.scrubbed, true, text);
    assert.match(out.text, /\[secret\]/, text);
  }
  const exact = scrubSecrets('the key is sk-or-v1-0123456789abcdef0123456789abcdef!', { env });
  assert.doesNotMatch(exact.text, /0123456789abcdef/);
});

test('negative: ordinary text, short or path-valued env vars are left alone', () => {
  for (const text of ['npm test && git status', 'Console', 'C:\\Program Files\\Git\\askpass.exe', 'write site/index.html (408 lines)']) {
    const out = scrubSecrets(text, { env });
    assert.equal(out.scrubbed, false, text);
    assert.equal(out.text, text);
  }
});

// Review 10-24: more home-path spellings, more key formats, no false alarms on everyday commands, and no slow regex
test('displayPaths: WSL and JSON-escaped spellings, a sentence-final path, and an empty home', () => {
  assert.equal(displayPaths('ls /mnt/c/Users/riley/x', { home: HOME }), 'ls ~/x');
  assert.equal(displayPaths('{"p":"C:\\\\Users\\\\riley\\\\x"}', { home: HOME }), '{"p":"~\\\\x"}');
  assert.equal(displayPaths('it lives in C:\\Users\\riley.', { home: HOME }), 'it lives in ~.');
  assert.equal(displayPaths('abc', { home: '' }), 'abc');
});

test('scrubSecrets: more key formats and flag-style passwords', () => {
  for (const text of ['sk_test_abcdefghijklmnop1234', `sk_${'a1'.repeat(24)}`, `hf_${'x'.repeat(30)}`, `npm_${'Y'.repeat(36)}`,
    `glpat-${'z'.repeat(20)}`, `whsec_${'w'.repeat(30)}`, 'ASIAIOSFODNN7EXAMPLE', `ya29.${'q'.repeat(30)}`,
    `GOCSPX-${'g'.repeat(28)}`, `SG.${'s'.repeat(22)}.${'t'.repeat(43)}`, 'Authorization: Basic cmlsZXk6aHVudGVyMmh1bnRlcg==',
    'mysql --password hunter2hunter2', 'tool --api-key abcdefgh12345678', 'curl -u riley:hunter2hunter2 x',
    `blob Ab3${'xK9q'.repeat(9)} end`]) {
    assert.equal(scrubSecrets(text, { env: {} }).scrubbed, true, text);
  }
});

test('negative: everyday commands, git hashes and words are not mistaken for secrets', () => {
  for (const text of ['mkdir -p src/tlink && npm test', 'git checkout 3e93516f0a1b2c3d4e5f60718293a4b5c6d7e8f9',
    'keyboard.js', 'ssh://git@github.com/riley/repo.git', 'git push origin feat/quantess', 'apiKeyHelper()']) {
    assert.equal(scrubSecrets(text, { env: {} }).scrubbed, false, text);
  }
});

test('negative: hostile long text cannot freeze the scrub (every pattern stays fast)', () => {
  const nasty = ['key'.repeat(70_000), 'a.'.repeat(100_000), `-----BEGIN RSA PRIVATE KEY-----${'x'.repeat(200_000)}`,
    `${'a:'.repeat(100_000)}@`, 'Bearer '.repeat(30_000), `${'A1b'.repeat(70_000)}`];
  for (const text of nasty) {
    const t0 = Date.now();
    scrubSecrets(text, { env: {} });
    forPhone(text, { home: HOME, env: {}, cap: 6144 });
    assert.ok(Date.now() - t0 < 1500, `${text.slice(0, 12)}… took ${Date.now() - t0} ms`);
  }
});

test('forPhone: paths shortened, secrets scrubbed, long text capped; exact only when nothing was lost', () => {
  assert.deepEqual(forPhone('edit C:\\Users\\riley\\x.js', { home: HOME, env, cap: 200 }), { text: 'edit ~\\x.js', exact: true });
  const secret = forPhone('run TOKEN=abcdefghijklmnop npm start', { home: HOME, env, cap: 200 });
  assert.equal(secret.exact, false);
  assert.doesNotMatch(secret.text, /abcdefghijklmnop/);
  const long = forPhone('x'.repeat(500), { home: HOME, env, cap: 100 });
  assert.equal(long.exact, false);
  assert.ok(long.text.length <= 100 + 20);
  assert.match(long.text, /cut/);
});
