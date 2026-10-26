// Where web_fetch may connect. Security review 10-23 (MEDIUM, SSRF): a page or a model could point it at this
// PC's own servers, the router or a cloud metadata address. The check runs on the address the connection
// really uses (the lookup below), so a name that resolves somewhere private is refused too.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';

const PRIVATE_V4 = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]];
// Ranges that carry an IPv4 address inside (IPv4-compatible ::/96, SIIT, NAT64, 6to4 2002::/16, Teredo 2001::/32)
// can reach a private one, so they are refused whole; plus local, site-local, discard-only and multicast
const PRIVATE_V6 = [['::', 96], ['::ffff:0:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]];

const blocked = new net.BlockList();
for (const [address, prefix] of PRIVATE_V4) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of PRIVATE_V6) blocked.addSubnet(address, prefix, 'ipv6');

const NO_BODY_STATUS = new Set([204, 205, 304]);
const DECOMPRESS = { gzip: zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress };

/** An IPv4 address written inside IPv6 (::ffff:7f00:1 is 127.0.0.1) as plain IPv4, else null. */
function mappedV4(ip) {
  const canonical = new URL(`http://[${ip}]`).hostname.slice(1, -1);
  const tail = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!tail) return null;
  const [hi, lo] = [parseInt(tail[1], 16), parseInt(tail[2], 16)];
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}

/** Why web_fetch may not connect to this IP address, or null when it may. */
export function addressProblem(ip) {
  const text = String(ip ?? '').replace(/^\[|\]$/g, '');
  const reason = `${text} is this PC or a private network`;
  if (net.isIPv4(text)) return blocked.check(text, 'ipv4') ? reason : null;
  if (!net.isIPv6(text)) return `${text || '(empty)'} is not an IP address`;
  const v4 = mappedV4(text);
  if (v4) return addressProblem(v4);
  return blocked.check(text, 'ipv6') ? reason : null;
}

const refusal = (reason) => Object.assign(new Error(`Refused: ${reason}.`), { code: 'ADDRESS_REFUSED' });

/** dns.lookup that refuses private answers; the socket connects to exactly the address checked here. */
export function guardedLookup(hostname, options, callback) {
  const done = typeof options === 'function' ? options : callback;
  const opts = typeof options === 'number' ? { family: options } : typeof options === 'object' && options ? options : {};
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return done(err);
    const bad = addresses.length === 0 ? `${hostname} has no address` : addresses.map((a) => addressProblem(a.address)).find(Boolean);
    if (bad) return done(refusal(bad));
    if (opts.all) return done(null, addresses);
    return done(null, addresses[0].address, addresses[0].family);
  });
}

function toResponse(res, body) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (name !== 'content-encoding' && name !== 'content-length') headers.set(name, Array.isArray(value) ? value.join(', ') : String(value));
  }
  const status = res.statusCode;
  return new Response(NO_BODY_STATUS.has(status) ? null : body, { status, headers });
}

/**
 * A response body, decompressed, up to maxBytes. At the cap it stops reading and destroys the decompressor
 * as well as the connection: a small zip bomb already buffered would otherwise keep expanding into memory.
 * @param {import('node:http').IncomingMessage} res
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
export function readCapped(res, maxBytes) {
  const decompress = DECOMPRESS[String(res.headers?.['content-encoding'] ?? '').trim().toLowerCase()];
  const body = decompress ? res.pipe(decompress()) : res;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const settle = (fn, value) => {
      if (done) return;
      done = true;
      fn(value);
    };
    body.on('data', (chunk) => {
      if (done) return;
      chunks.push(chunk);
      size += chunk.length;
      if (size < maxBytes) return;
      settle(resolve, Buffer.concat(chunks).subarray(0, maxBytes));
      body.destroy();
      res.destroy();
    });
    body.on('end', () => settle(resolve, Buffer.concat(chunks)));
    body.on('error', (err) => settle(reject, err));
    res.on('error', (err) => settle(reject, err));
  });
}

/**
 * GET one URL from a public address only. Redirects are NOT followed: the caller re-checks each one.
 * The body is read up to maxBytes (after decompression, so a zip bomb stops there too).
 * @param {string} url
 * @param {{ headers?: Record<string, string>, signal?: AbortSignal, maxBytes?: number }} [options]
 * @returns {Promise<Response>}
 */
export function guardedFetch(url, { headers = {}, signal, maxBytes = 2_000_000 } = {}) {
  const target = new URL(url);
  const literal = target.hostname.replace(/^\[|\]$/g, '');
  const literalProblem = net.isIP(literal) ? addressProblem(literal) : null;
  if (literalProblem) return Promise.reject(refusal(literalProblem));
  const client = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const req = client.get(target, { headers: { 'Accept-Encoding': 'gzip, deflate, br', ...headers }, lookup: guardedLookup, signal }, (res) => {
      readCapped(res, maxBytes).then((body) => {
        try {
          settle(resolve, toResponse(res, body));
        } catch (err) {
          settle(reject, err);
        }
      }, (err) => settle(reject, err));
    });
    req.on('error', (err) => settle(reject, err));
  });
}
