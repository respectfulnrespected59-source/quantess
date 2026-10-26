import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  resolveProfile,
  profileInUse,
  waitForChromeToClose,
  signInArgs,
  findChrome,
  toOpenAiTool,
  formatBrowserResult,
  isBrowserTool,
  browserToolNames,
  browserToolDefinitions,
  callBrowserTool,
  closeBrowser,
  isAllowedUrl,
  allowedHosts,
  serverCommand,
  paidClickLabel,
  gatePaidClick,
  setPaidClickBudget,
  setPaidClickApprover,
  MAX_PAGE_CHARS
} from './index.js';

function tempProfiles() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'q23-profiles-'));
}

function makeProfile(root, name, { cookies = true, mtime } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'Default', 'Network'), { recursive: true });
  if (cookies) {
    const file = path.join(dir, 'Default', 'Network', 'Cookies');
    fs.writeFileSync(file, 'x');
    if (mtime) fs.utimesSync(file, mtime, mtime);
  }
  return dir;
}

test('resolveProfile defaults to Q23\'s own profile even when Claude has one (owner, 2026-10-13)', () => {
  const root = tempProfiles();
  makeProfile(root, 'mcp-chrome-aaaaaaa');
  const got = resolveProfile({ env: {}, profilesDir: root });
  assert.deepEqual(got, { dir: path.join(root, 'q23-chrome'), source: 'q23' });
});

test('resolveProfile shares Claude\'s most recent profile only when asked with Q23_BROWSER_PROFILE=claude', () => {
  const root = tempProfiles();
  makeProfile(root, 'mcp-chrome-old0000', { mtime: new Date('2026-01-01') });
  const newest = makeProfile(root, 'mcp-chrome-new0000', { mtime: new Date('2026-10-01') });
  makeProfile(root, 'mcp-chrome-empty00', { cookies: false });
  const got = resolveProfile({ env: { Q23_BROWSER_PROFILE: 'claude' }, profilesDir: root });
  assert.deepEqual(got, { dir: newest, source: 'claude' });
});

test('resolveProfile=claude with no Claude profile falls back to Q23\'s own', () => {
  const missing = path.join(os.tmpdir(), 'q23-no-such-dir-' + Date.now());
  const got = resolveProfile({ env: { Q23_BROWSER_PROFILE: 'claude' }, profilesDir: missing });
  assert.equal(got.source, 'q23');
});

test('resolveProfile takes any other Q23_BROWSER_PROFILE as a folder path', () => {
  const got = resolveProfile({ env: { Q23_BROWSER_PROFILE: 'D:\\mine' }, profilesDir: tempProfiles() });
  assert.deepEqual(got, { dir: 'D:\\mine', source: 'env' });
});

test('profileInUse is false for a profile Chrome is not holding', () => {
  const root = tempProfiles();
  const dir = makeProfile(root, 'idle');
  assert.equal(profileInUse(dir), false, 'no lockfile');
  fs.writeFileSync(path.join(dir, 'lockfile'), '');
  assert.equal(profileInUse(dir), false, 'lockfile left behind but not held');
  // The held case (EBUSY while Chrome runs) is proven live: see `--signin`.
});

test('waitForChromeToClose gives up waiting for a lockfile that never appears, and returns once it is free', async () => {
  const dir = makeProfile(tempProfiles(), 'never-opened');
  await waitForChromeToClose(dir, { pollMs: 5, appearMs: 40 });
  fs.writeFileSync(path.join(dir, 'lockfile'), '');
  await waitForChromeToClose(dir, { pollMs: 5, appearMs: 40 });
});

test('allowedHosts accepts full URLs in Q23_BROWSER_ALLOW and keeps just the host', () => {
  assert.ok(allowedHosts({ QUANTESS_BROWSER_SITES: 'qmm', Q23_BROWSER_ALLOW: 'https://Studio.YouTube.com/channel/x' }).includes('studio.youtube.com'));
});

test('signInArgs stop Chrome lingering in the background after the user closes the window', () => {
  // Seen 2026-10-13: with sync on, Chrome kept the profile locked with no window open
  const args = signInArgs('C:\\p\\q23-chrome', 'https://quantus-ai.onrender.com');
  assert.ok(args.includes('--disable-background-mode'));
  assert.ok(args.includes('--user-data-dir=C:\\p\\q23-chrome'));
  assert.equal(args.at(-1), 'https://quantus-ai.onrender.com');
});

test('findChrome returns the first Chrome that exists, or null', () => {
  const env = { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\LA' };
  const only = (want) => (p) => p === want;
  assert.equal(findChrome(env, only(path.join('C:\\LA', 'Google', 'Chrome', 'Application', 'chrome.exe'))),
    path.join('C:\\LA', 'Google', 'Chrome', 'Application', 'chrome.exe'));
  assert.equal(findChrome(env, () => false), null);
});

test('toOpenAiTool maps an MCP tool and drops the $schema key', () => {
  const mcp = {
    name: 'browser_click',
    description: 'Click',
    inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { target: { type: 'string' } } }
  };
  const got = toOpenAiTool(mcp);
  assert.deepEqual(got, {
    type: 'function',
    function: { name: 'browser_click', description: 'Click', parameters: { type: 'object', properties: { target: { type: 'string' } } } }
  });
  assert.ok('$schema' in mcp.inputSchema, 'input must not be mutated');
});

test('formatBrowserResult keeps text, drops images, reports errors', () => {
  const ok = formatBrowserResult('browser_navigate', {
    content: [{ type: 'text', text: '### Page\n- Page URL: https://x' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }]
  });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.data.page, '### Page\n- Page URL: https://x');
  assert.ok(!JSON.stringify(ok).includes('AAAA'), 'image bytes must not reach the model');

  const bad = formatBrowserResult('browser_click', { isError: true, content: [{ type: 'text', text: '### Error\nRef e9 not found' }] });
  assert.equal(bad.status, 'error');
  assert.equal(bad.summary, 'browser_click failed: Ref e9 not found', 'the reason, not the markdown heading');
});

test('formatBrowserResult masks secrets on screen before they reach a free model', () => {
  const screen = [
    `- cell "${'sk-or-v1-' + 'a'.repeat(40)}"`,
    `- cell "whsec_${'b'.repeat(32)}"`,
    `- cell "xkeysib-${'c'.repeat(40)}"`,
    '- cell "postgres://admin:hunter2pass@db.example.com:5432/app"',
    `- cell "Bearer ${'d'.repeat(30)}"`
  ].join('\n');
  const page = formatBrowserResult('browser_snapshot', { content: [{ type: 'text', text: screen }] }).data.page;
  for (const leak of ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc', 'hunter2pass', 'dddddddddddddddd']) {
    assert.ok(!page.includes(leak), `leaked ${leak}`);
  }
  assert.match(page, /db\.example\.com/, 'the host stays readable');
});

test('formatBrowserResult cuts a huge page and says how to see the rest', () => {
  const huge = 'a '.repeat(MAX_PAGE_CHARS);
  const got = formatBrowserResult('browser_snapshot', { content: [{ type: 'text', text: huge }] });
  assert.ok(got.data.page.length < MAX_PAGE_CHARS + 300);
  assert.match(got.data.page, /cut at/);
});

test('evaluate and file upload stay off unless Q23_BROWSER_UNSAFE=1', () => {
  assert.equal(isBrowserTool('browser_click', {}), true);
  assert.equal(isBrowserTool('browser_evaluate', {}), false);
  assert.equal(isBrowserTool('browser_file_upload', {}), false);
  assert.equal(isBrowserTool('browser_run_code_unsafe', { Q23_BROWSER_UNSAFE: '1' }), false);
  assert.equal(isBrowserTool('browser_evaluate', { Q23_BROWSER_UNSAFE: '1' }), true);
  assert.equal(isBrowserTool('run_shell', {}), false);
});

test('isAllowedUrl lets Q23 open QMM sites and blocks everything else', () => {
  const hosts = ['quantus-ai.onrender.com', 'quantummelaninmedia.com'];
  assert.equal(isAllowedUrl('https://quantus-ai.onrender.com/create', hosts), true);
  assert.equal(isAllowedUrl('https://www.quantummelaninmedia.com/', hosts), true, 'subdomain of an allowed host');
  assert.equal(isAllowedUrl('about:blank', hosts), true);
  assert.equal(isAllowedUrl('https://attacker.example/?d=secret', hosts), false);
  assert.equal(isAllowedUrl('https://quantus-ai.onrender.com.attacker.example/', hosts), false, 'lookalike suffix');
  assert.equal(isAllowedUrl('https://evil.onrender.com/', hosts), false, 'anyone can host on onrender.com');
  assert.equal(isAllowedUrl('javascript:fetch("//x")', hosts), false);
  assert.equal(isAllowedUrl('file:///C:/Users/riley/.env', hosts), false);
  assert.equal(isAllowedUrl('quantus-ai.onrender.com', hosts), false, 'no scheme');
  assert.equal(isAllowedUrl('https://anything.example/', ['*']), true, '* turns the list off');
});

test('"*" opens every website, never local files or javascript: links', () => {
  // With uploads on, the browser server no longer blocks file:// itself: this check is the only one left
  assert.equal(isAllowedUrl('file:///C:/Users/riley/.env', ['*']), false);
  assert.equal(isAllowedUrl('javascript:fetch("//x")', ['*']), false);
  assert.equal(isAllowedUrl('about:blank', ['*']), true);
});

test('the browser server keeps files inside its own folder unless uploads are switched on', () => {
  const profile = { dir: 'C:/profiles/q23-chrome' };
  const UNLOCK = '--allow-unrestricted-file-access';
  // Seen 10-14: with the default, uploading a photo from Pictures failed "outside allowed roots"
  assert.ok(!serverCommand(profile, 'C:/tmp/out', {}).args.includes(UNLOCK));
  assert.ok(serverCommand(profile, 'C:/tmp/out', { Q23_BROWSER_UNSAFE: '1' }).args.includes(UNLOCK));
  assert.equal(serverCommand(profile, 'C:/tmp/out', {}).cwd, 'C:/tmp/out');
});

test('allowedHosts adds Q23_BROWSER_ALLOW to the QMM defaults', () => {
  const hosts = allowedHosts({ QUANTESS_BROWSER_SITES: 'qmm', Q23_BROWSER_ALLOW: ' YouTube.com, studio.youtube.com ,' });
  assert.ok(hosts.includes('quantus-ai.onrender.com'));
  assert.ok(hosts.includes('youtube.com'));
  assert.ok(hosts.includes('studio.youtube.com'));
  assert.ok(!hosts.includes(''));
});

test('with QUANTESS_BROWSER_SITES=qmm, callBrowserTool refuses an off-list site before anything opens', async () => {
  const before = process.env.QUANTESS_BROWSER_SITES;
  process.env.QUANTESS_BROWSER_SITES = 'qmm';
  try {
    const nav = await callBrowserTool('browser_navigate', { url: 'https://attacker.example/?d=1' });
    assert.equal(nav.error.code, 'SITE_NOT_ALLOWED');
    const tab = await callBrowserTool('browser_tabs', { action: 'new', url: 'https://attacker.example/' });
    assert.equal(tab.error.code, 'SITE_NOT_ALLOWED');
  } finally {
    if (before === undefined) delete process.env.QUANTESS_BROWSER_SITES; else process.env.QUANTESS_BROWSER_SITES = before;
  }
});

// Any site by default (10-23); the leak routes a page could talk the
// model into are closed instead: keys in a URL, a URL stuffed with data, the home network.
test('by default the browser opens any website, and this PC for dev servers', async () => {
  const { browserUrlProblem } = await import('./index.js');
  assert.deepEqual(allowedHosts({}), ['*']);
  for (const url of ['https://www.youtube.com/watch?v=n_RFkBkTmBo', 'https://en.wikipedia.org/wiki/Node.js',
    'https://www.google.com/search?q=spark+plug+gap+2014+camaro', 'http://localhost:5173/', 'http://127.0.0.1:8864/?view=fps', 'about:blank']) {
    assert.equal(browserUrlProblem(url, {}), null, url);
  }
});

test('negative: a URL carrying a key, a stuffed payload, or a home-network address is refused on any site', async () => {
  const { browserUrlProblem } = await import('./index.js');
  const env = { OPENROUTER_API_KEY: 'my-own-key-1234567890' };
  assert.equal(browserUrlProblem('https://evil.example/?k=sk-or-v1-0123456789abcdef0123456789abcdef', env).code, 'URL_CARRIES_SECRET');
  assert.equal(browserUrlProblem('https://evil.example/?x=my-own-key-1234567890', env).code, 'URL_CARRIES_SECRET');
  assert.equal(browserUrlProblem(`https://evil.example/?d=${'a'.repeat(600)}`, env).code, 'URL_CARRIES_DATA');
  assert.equal(browserUrlProblem(`https://evil.example/#${'a'.repeat(600)}`, env).code, 'URL_CARRIES_DATA');
  for (const url of ['http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5:8080/']) {
    assert.equal(browserUrlProblem(url, env).code, 'PRIVATE_NETWORK', url);
  }
  assert.equal(browserUrlProblem('file:///C:/Users/riley/.env', env).code, 'SITE_NOT_ALLOWED');
  assert.equal(browserUrlProblem('javascript:fetch("//x")', env).code, 'SITE_NOT_ALLOWED');
  // Security review 10-23: the path, a long host, or a login in the URL carried data past the query-only cap
  assert.equal(browserUrlProblem(`https://x.example/${'a'.repeat(3000)}`, env).code, 'URL_CARRIES_DATA');
  assert.equal(browserUrlProblem(`https://${'a'.repeat(60)}.${'b'.repeat(60)}.example/`, env).code, 'URL_CARRIES_DATA');
  assert.equal(browserUrlProblem('https://user:secret@x.example/', env).code, 'URL_CARRIES_DATA');
});

test('negative: a NAME that resolves into the home or cloud network is refused; this PC and public names are not', async () => {
  const { networkProblem } = await import('./index.js');
  const resolvesTo = (address) => async () => [{ address, family: 4 }];
  assert.equal((await networkProblem('https://router.example/', { lookup: resolvesTo('192.168.1.1') })).code, 'PRIVATE_NETWORK');
  assert.equal((await networkProblem('https://meta.example/', { lookup: resolvesTo('169.254.169.254') })).code, 'PRIVATE_NETWORK');
  assert.equal(await networkProblem('http://localhost:5173/', { lookup: resolvesTo('127.0.0.1') }), null);
  assert.equal(await networkProblem('https://example.com/', { lookup: resolvesTo('93.184.215.14') }), null);
  assert.equal(await networkProblem('https://nowhere.invalid/', { lookup: async () => { throw new Error('ENOTFOUND'); } }), null);
});

test('pageUrlOf reads where the browser landed, after a click or a redirect', async () => {
  const { pageUrlOf } = await import('./index.js');
  assert.equal(pageUrlOf('### Page\n- Page URL: https://www.youtube.com/watch?v=x\n- Page Title: x'), 'https://www.youtube.com/watch?v=x');
  assert.equal(pageUrlOf('no page here'), null);
});

// Security review 10-23: going back was never re-checked, a page reached without a change in URL was never checked,
// and a landing kept a key in its URL or sat on the home network unchecked
function fakeBrowser(history) {
  const calls = [];
  let at = history.length - 1;
  return {
    calls,
    current: () => history[at],
    goBack: async () => { calls.push('back'); at = Math.max(0, at - 1); },
    goBlank: async () => { calls.push('blank'); history.push('about:blank'); at = history.length - 1; }
  };
}

test('a page on an approved site stays; no going back', async () => {
  const { enforceLanding } = await import('./index.js');
  const b = fakeBrowser(['https://quantus-ai.onrender.com/', 'https://quantus-ai.onrender.com/create']);
  assert.equal(await enforceLanding(b.current(), { goBack: b.goBack, goBlank: b.goBlank, currentUrl: b.current }), null);
  assert.deepEqual(b.calls, []);
});

test('negative: a click onto an unapproved site goes back; if back is off limits too, the tab goes blank', async () => {
  const { enforceLanding } = await import('./index.js');
  const once = fakeBrowser(['https://quantus-ai.onrender.com/', 'https://attacker.example/x']);
  assert.match(await enforceLanding(once.current(), { goBack: once.goBack, goBlank: once.goBlank, currentUrl: once.current }), /not approved/);
  assert.deepEqual(once.calls, ['back']);
  const twice = fakeBrowser(['https://attacker.example/a', 'https://attacker.example/b']);
  await enforceLanding(twice.current(), { goBack: twice.goBack, goBlank: twice.goBlank, currentUrl: twice.current });
  assert.deepEqual(twice.calls, ['back', 'blank']);
  assert.equal(twice.current(), 'about:blank');
});

test('negative: even with asking off, a landing with a key in its URL or on the home network is left', async () => {
  const { enforceLanding } = await import('./index.js');
  const before = process.env.QUANTESS_BROWSER_SITES;
  process.env.QUANTESS_BROWSER_SITES = 'any';
  try {
    for (const bad of ['https://evil.example/?k=sk-or-v1-0123456789abcdef0123456789abcdef', 'http://192.168.1.1/admin']) {
      const b = fakeBrowser(['https://example.com/', bad]);
      assert.ok(await enforceLanding(b.current(), { goBack: b.goBack, goBlank: b.goBlank, currentUrl: b.current }), bad);
      assert.deepEqual(b.calls, ['back'], bad);
    }
  } finally {
    if (before === undefined) delete process.env.QUANTESS_BROWSER_SITES; else process.env.QUANTESS_BROWSER_SITES = before;
  }
});

// Security review 10-23: "Left that page: ... to <url>" echoed a key in the URL back to the model
test('negative: a refused or left page is named by its origin only, never with the key it carried', async () => {
  const { urlLabel } = await import('./index.js');
  const key = 'sk-or-v1-0123456789abcdef0123456789abcdef';
  assert.equal(urlLabel(`https://evil.example/p/${key}?k=${key}#${key}`), 'https://evil.example');
  assert.equal(urlLabel('not a url'), '(not a valid URL)');
  const blocked = await callBrowserTool('browser_navigate', { url: `https://evil.example/?k=${key}` });
  assert.equal(blocked.error.code, 'URL_CARRIES_SECRET');
  assert.ok(!blocked.summary.includes(key), blocked.summary);
});

test('negative: by default a new site asks first, and with nobody at the terminal it is refused before anything opens', async () => {
  const nav = await callBrowserTool('browser_navigate', { url: 'https://attacker.example/' });
  assert.equal(nav.error.code, 'SITE_NOT_APPROVED');
});

const QT_PAGE = [
  '- button "Generate Image" [ref=f1e248] [cursor=pointer]',
  '- button "Open Full Size" [ref=f1e260]',
  '- button "Upscale 2×" [ref=f1e263] [box=751,718,78,28]',
  '- link "Sign out" [ref=f1e91]',
  '- button "Create account" [ref=f1e300]'
].join('\n');

test('paidClickLabel reads the REAL label off the page, not the model\'s description', () => {
  // 2026-10-13: the model called f1e263 "Open Full Size button in image"; it was Upscale 2×
  const args = { element: 'Open Full Size button in image', target: 'f1e263' };
  assert.equal(paidClickLabel('browser_click', args, QT_PAGE), 'Upscale 2×');
  assert.equal(paidClickLabel('browser_click', { target: 'f1e248' }, QT_PAGE), 'Generate Image');
  assert.equal(paidClickLabel('browser_click', { element: 'Buy now', target: 'button.buy' }, ''), 'Buy now', 'falls back to the description');
});

test('paidClickLabel lets ordinary clicks through', () => {
  for (const target of ['f1e260', 'f1e91', 'f1e300']) {
    assert.equal(paidClickLabel('browser_click', { target }, QT_PAGE), null, target);
  }
  assert.equal(paidClickLabel('browser_type', { target: 'f1e263' }, QT_PAGE), null, 'only clicks are gated');
});

test('gatePaidClick: no budget and nobody to ask means blocked', async () => {
  setPaidClickBudget(0);
  setPaidClickApprover(null);
  assert.equal((await gatePaidClick('Upscale 2×')).allowed, false);
});

test('gatePaidClick spends a pre-approved budget one click at a time', async () => {
  setPaidClickBudget(1);
  setPaidClickApprover(null);
  assert.equal((await gatePaidClick('Generate Image')).allowed, true);
  assert.equal((await gatePaidClick('Generate Image')).allowed, false, 'second click needs the user again');
});

test('gatePaidClick asks the user when there is no budget, and respects a no', async () => {
  setPaidClickBudget(0);
  const asked = [];
  setPaidClickApprover(async (label) => { asked.push(label); return label !== 'Upscale 2×'; });
  assert.equal((await gatePaidClick('Generate Image')).allowed, true);
  assert.equal((await gatePaidClick('Upscale 2×')).allowed, false);
  assert.deepEqual(asked, ['Generate Image', 'Upscale 2×']);
  setPaidClickApprover(null);
});

test('the real Playwright MCP server starts and offers every exposed tool', async () => {
  try {
    const defs = await browserToolDefinitions({ profile: { dir: path.join(tempProfiles(), 'p'), source: 'q23' } });
    assert.deepEqual(defs.map((d) => d.function.name).sort(), [...browserToolNames()].sort());
  } finally {
    await closeBrowser();
  }
});
