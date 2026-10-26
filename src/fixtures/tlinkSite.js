// A fake QUAN-TESS site for the T-LINK tests: the routes in src/tlink/protocol.js on 127.0.0.1, plus switches to make
// it misbehave (refuse, ask for a resync, redirect, send oversized or junk frames). Never used outside tests.
import http from 'node:http';
import { PATHS } from '../tlink/protocol.js';

const readBody = (req) => new Promise((resolve) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => resolve(body));
});

/**
 * @param {{ token?: string, pairAfterPolls?: number, pairResult?: 'approved'|'denied'|'expired' }} [options]
 */
export async function startFakeSite({ token = `tlk_${'T'.repeat(43)}`, pairAfterPolls = 2, pairResult = 'approved' } = {}) {
  const state = {
    token, revoked: false, batches: [], streams: new Set(), streamConnects: 0, requests: [],
    // switches a test flips
    refuseEvents: 0,           // answer N event posts with 401
    resyncOnce: false,         // answer the next event post with 409
    redirectTo: null,          // answer every route with a 302 here
    alwaysResync: false,       // answer every event post with 409
    rejectWhen: null,          // (batch) => a status to answer that batch with (400, 422...), or 0
    closeStreamsAtOnce: false, // accept a stream, then hang up straight away
    pairBody: null,            // a raw body for the next pair/start reply
    pairs: new Map()
  };
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    state.requests.push({ method: req.method, path: req.url, auth: req.headers.authorization ?? null, body });
    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (state.redirectTo) {
      res.writeHead(302, { location: `${state.redirectTo}${req.url}` });
      return res.end();
    }
    const authed = req.headers.authorization === `Bearer ${state.token}` && !state.revoked;
    switch (req.url) {
      case PATHS.pairStart: {
        if (state.pairBody) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return state.pairBody(res);
        }
        const deviceCode = `dc_${Math.random().toString(36).slice(2).padEnd(24, 'x')}`;
        state.pairs.set(deviceCode, { polls: 0, label: JSON.parse(body || '{}').label });
        return json(200, { deviceCode, userCode: 'ABCD-EFGH', intervalSec: 1, expiresInSec: 300 });
      }
      case PATHS.pairPoll: {
        const pair = state.pairs.get(JSON.parse(body || '{}').deviceCode);
        if (!pair) return json(400, { status: 'expired' });
        pair.polls += 1;
        if (pair.polls < pairAfterPolls) return json(200, { status: 'pending' });
        if (pairResult !== 'approved') return json(403, { status: pairResult });
        return json(200, { status: 'approved', deviceId: 'dev_test0001', token: state.token, expiresAt: Date.now() + 86_400_000 });
      }
      case PATHS.whoami:
        return authed ? json(200, { deviceId: 'dev_test0001', label: 'MY-PC' }) : json(401, { error: 'unauthorized' });
      case PATHS.events: {
        if (!authed || state.refuseEvents > 0) {
          state.refuseEvents = Math.max(0, state.refuseEvents - 1);
          return json(401, { error: 'unauthorized' });
        }
        if (state.resyncOnce || state.alwaysResync) {
          state.resyncOnce = false;
          if (!JSON.parse(body).resync || state.alwaysResync) return json(409, { resync: true });
        }
        const reject = state.rejectWhen?.(JSON.parse(body));
        if (reject) return json(reject, { error: 'bad batch' });
        state.batches.push(JSON.parse(body));
        return json(200, { ok: true });
      }
      case PATHS.stream: {
        if (!authed) return json(401, { error: 'unauthorized' });
        state.streamConnects += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(': hi\n\nevent: hello\ndata: {"bootId":"boot1"}\n\n');
        if (state.closeStreamsAtOnce) return res.end();
        state.streams.add(res);
        // the response's close fires when the client drops the stream (the request's fires once its body is read)
        res.on('close', () => state.streams.delete(res));
        return undefined;
      }
      case PATHS.end:
        return authed ? json(200, { ok: true }) : json(401, {});
      case PATHS.revoke:
        if (authed) state.revoked = true;
        return json(authed ? 200 : 401, {});
      default:
        return json(404, {});
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    state,
    /** Push one SSE frame to every open stream. */
    send(event, data) {
      for (const s of state.streams) s.write(`event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
    },
    raw(text) {
      for (const s of state.streams) s.write(text);
    },
    events: () => state.batches.flatMap((b) => b.events),
    close: () => new Promise((r) => {
      for (const s of state.streams) s.destroy();
      server.closeAllConnections?.();
      server.close(() => r());
    })
  };
}
