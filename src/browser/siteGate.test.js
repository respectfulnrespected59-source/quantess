import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { siteOf, gateSite, setSiteApprover, forgetSessionSites, savedSites } from './siteGate.js';

// Security review 10-23 (HIGH): with every site open, a page could steer the model to carry data out to a site
// of the attacker's - in the path, a subdomain, a form or a click. A new site now asks the user first.
const sitesFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quantess-sites-')), 'browser-sites.json');

beforeEach(() => {
  forgetSessionSites();
  setSiteApprover(null);
});

test('siteOf names the site a page belongs to; on shared hosting it is the subdomain', () => {
  assert.equal(siteOf('https://www.youtube.com/watch?v=x'), 'youtube.com');
  assert.equal(siteOf('https://studio.youtube.com/channel/x'), 'youtube.com');
  assert.equal(siteOf('https://www.bbc.co.uk/news'), 'bbc.co.uk');
  assert.equal(siteOf('https://evil.onrender.com/'), 'evil.onrender.com');
  assert.equal(siteOf('https://a.b.github.io/'), 'b.github.io');
  assert.equal(siteOf('http://localhost:5173/'), 'localhost');
  assert.equal(siteOf('http://127.0.0.1:8864/'), '127.0.0.1');
  assert.equal(siteOf('about:blank'), null);
  // Security review 10-23: a hand-kept list of shared hosts missed these; the Public Suffix List knows them
  assert.equal(siteOf('https://evil.workers.dev/'), 'evil.workers.dev');
  assert.equal(siteOf('https://x.azurewebsites.net/'), 'x.azurewebsites.net');
  assert.equal(siteOf('https://bucket.s3.amazonaws.com/a'), 'bucket.s3.amazonaws.com');
});

test('known sites and this PC open without asking', async () => {
  let asked = 0;
  setSiteApprover(async () => { asked += 1; return 'no'; });
  const file = sitesFile();
  assert.equal((await gateSite('https://quantus-ai.onrender.com/create', { openHosts: ['quantus-ai.onrender.com'], file })).allowed, true);
  assert.equal((await gateSite('http://localhost:5173/', { file })).allowed, true);
  assert.equal((await gateSite('about:blank', { file })).allowed, true);
  assert.equal(asked, 0);
});

test('a new site asks once: yes holds for the session, always is saved for next time', async () => {
  const file = sitesFile();
  const answers = ['yes', 'always'];
  const asked = [];
  setSiteApprover(async (site) => { asked.push(site); return answers.shift(); });
  assert.equal((await gateSite('https://en.wikipedia.org/wiki/Node.js', { file })).allowed, true);
  assert.equal((await gateSite('https://en.wikipedia.org/wiki/Berkeley', { file })).allowed, true);
  assert.equal((await gateSite('https://www.youtube.com/watch?v=x', { file })).allowed, true);
  assert.deepEqual(asked, ['wikipedia.org', 'youtube.com'], 'each new site asked exactly once');
  assert.deepEqual(savedSites(file), ['youtube.com']);
  forgetSessionSites();
  setSiteApprover(null);
  assert.equal((await gateSite('https://studio.youtube.com/', { file })).allowed, true, 'always survives a new session');
  assert.equal((await gateSite('https://en.wikipedia.org/wiki/Node.js', { file })).allowed, false, 'yes did not');
});

test('negative: a no, or nobody at the terminal, refuses the site', async () => {
  const file = sitesFile();
  setSiteApprover(async () => 'no');
  assert.equal((await gateSite('https://attacker.example/x', { file })).allowed, false);
  setSiteApprover(null);
  const nobody = await gateSite('https://attacker.example/x', { file });
  assert.equal(nobody.allowed, false);
  assert.match(nobody.how, /nobody/);
});

test('negative: a stranger on shared hosting is not the QMM site there', async () => {
  const r = await gateSite('https://evil.onrender.com/', { openHosts: ['quantus-ai.onrender.com'], file: sitesFile() });
  assert.equal(r.allowed, false);
});
