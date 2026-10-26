// New websites ask the user first: yes = this session, always = remembered, no = refused. Security review 10-23
// (HIGH): with every site open, a page could steer the model to carry data out to a site of the attacker's - in
// the path, a subdomain, a form or a click. Claude Code asks per domain the same way. With nobody at the
// terminal, a new site is refused.
import fs from 'fs';
import net from 'net';
import path from 'path';
import { getDomain } from 'tldts';
import { quantessHome } from '../budget.js';

/** The site a URL belongs to (youtube.com for www.youtube.com, me.github.io on shared hosting), or null. */
export function siteOf(url) {
  if (!URL.canParse(url)) return null;
  const { protocol, hostname } = new URL(url);
  if (protocol !== 'http:' && protocol !== 'https:') return null;
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (net.isIP(host) || !host.includes('.')) return host;
  // The Public Suffix List with its private section (security review 10-23: a hand-kept list missed workers.dev,
  // azurewebsites.net, s3): on shared hosting the site is the customer's subdomain, never the whole platform
  return getDomain(host, { allowPrivateDomains: true }) ?? host;
}

const isThisPc = (site) => site === 'localhost' || /^127\./.test(site) || site === '::1';
const defaultSitesFile = () => path.join(quantessHome(), 'browser-sites.json');

/** The sites the user said "always" to. */
export function savedSites(file = defaultSitesFile()) {
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(list) ? list.filter((site) => typeof site === 'string') : [];
  } catch {
    // none saved yet, or an unreadable file: every new site asks
    return [];
  }
}

function saveSite(site, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([...new Set([...savedSites(file), site])], null, 2));
}

let approver = null;
const sessionSites = new Set();

/** How the CLI asks the user (resolves 'yes' | 'always' | 'no'); null when nobody is at a terminal. */
export function setSiteApprover(fn) {
  approver = fn;
}

/** Forget this session's yes answers (a new session; tests). */
export function forgetSessionSites() {
  sessionSites.clear();
}

/**
 * May the browser be on this URL? QMM sites, the user's added and saved sites, and this PC are open; any other
 * site asks once.
 * @param {string} url
 * @param {{ openHosts?: string[], file?: string }} [options]
 * @returns {Promise<{ allowed: boolean, how: string }>}
 */
export async function gateSite(url, { openHosts = [], file = defaultSitesFile() } = {}) {
  const site = siteOf(url);
  if (!site || isThisPc(site)) return { allowed: true, how: 'not a new site' };
  const host = new URL(url).hostname.toLowerCase();
  const known = [...openHosts, ...savedSites(file)].map((h) => h.toLowerCase());
  if (known.some((h) => host === h || host.endsWith(`.${h}`))) return { allowed: true, how: 'a known site' };
  if (sessionSites.has(site)) return { allowed: true, how: 'approved this session' };
  if (!approver) return { allowed: false, how: 'nobody at the terminal to approve a new site' };
  const answer = await approver(site, url);
  if (answer === 'always') {
    saveSite(site, file);
    sessionSites.add(site);
    return { allowed: true, how: 'approved always' };
  }
  if (answer === 'yes') {
    sessionSites.add(site);
    return { allowed: true, how: 'approved this session' };
  }
  return { allowed: false, how: 'the user said no' };
}
