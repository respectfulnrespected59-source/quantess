import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { addressProblem, guardedFetch, readCapped } from './netGuard.js';

// Security review 10-23 (MEDIUM, SSRF): web_fetch would open anything a page or a model typed - this PC's own
// servers, the router, a cloud metadata address. Those are refused by the address the connection really uses.

test('addresses on this PC or its private network are refused; public ones are allowed', () => {
  for (const ip of ['127.0.0.1', '127.8.8.8', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::a9fe:a9fe',
    // Security review 10-23 (LOW): 6to4, Teredo, IPv4-compatible, SIIT, site-local, discard-only, local NAT64
    '2002:7f00:1::', '2002:c0a8:101::', '2001::1', '::7f00:1', '::ffff:0:7f00:1', 'fec0::1', '100::1', '64:ff9b:1::1',
    '192.0.2.1', '198.51.100.7', '203.0.113.9']) {
    assert.ok(addressProblem(ip), `should refuse ${ip}`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.215.14', '2606:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(addressProblem(ip), null, `should allow ${ip}`);
  }
  assert.ok(addressProblem('not-an-ip'));
});

function countingServer() {
  const server = http.createServer((_req, res) => { server.hits += 1; res.end('secret local page'); });
  server.hits = 0;
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('negative: an IP on this PC is refused before any connection is made', async () => {
  const server = await countingServer();
  try {
    await assert.rejects(guardedFetch(`http://127.0.0.1:${server.address().port}/`), /refused/i);
    assert.equal(server.hits, 0);
  } finally {
    server.close();
  }
});

test('negative: a NAME that resolves to this PC is refused at connect time (no DNS trick)', async () => {
  const server = await countingServer();
  try {
    await assert.rejects(guardedFetch(`http://localhost:${server.address().port}/`), /refused/i);
    assert.equal(server.hits, 0);
  } finally {
    server.close();
  }
});

// Security review 10-23 (MEDIUM): past the cap the decompressor kept expanding what it had already buffered
test('negative: a decompression bomb is cut at the cap, and the connection is dropped', async () => {
  const bomb = zlib.gzipSync(Buffer.alloc(50_000_000));
  const res = Readable.from([bomb]);
  res.headers = { 'content-encoding': 'gzip' };
  const body = await readCapped(res, 1_000_000);
  assert.equal(body.length, 1_000_000);
  assert.equal(res.destroyed, true);
});

test('a plain body under the cap comes back whole', async () => {
  const res = Readable.from([Buffer.from('hello '), Buffer.from('world')]);
  res.headers = {};
  assert.equal((await readCapped(res, 1_000_000)).toString(), 'hello world');
});
