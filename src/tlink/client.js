// T-LINK client (Phase 2): this PC's side of the wire. It only connects OUT to the paired site:
// it POSTs the activity feed in small batches and keeps one stream open for the phone's answers. Never in the job's
// way: every request has a timeout, failures back off with jitter, nothing throws into the agent, and a 401 or an
// "off" frame turns T-LINK off with the reason instead of retrying forever. Redirects are never followed - the key goes
// only to the origin it was paired with (security model 7). The site is treated as possibly hostile: its replies and
// its stream are read with hard limits, and a misbehaving site is backed off from, never looped on.
import { createSseParser } from './sse.js';
import { PATHS, parseAnswerFrame, readCapped } from './protocol.js';

const BODY_CAP = 65_536;        // a reply body is read this far, never further
const BATCH_BYTES = 48_000;     // a batch stays under the site's 64 KB request limit
const RESYNC_BYTES = 40_000;    // so does the snapshot re-posted after a site restart
const BATCH_EVENTS = 50;
const HISTORY = 100;            // recent lines kept to re-post after a site restart
const REQUEST_MS = 10_000;
const MAX_RESYNCS = 5;          // in a row: a site that never settles turns T-LINK off
const DRAIN_MS = 1000;          // end(): how long the last lines get to go out
const OFFLINE = 'the site is unreachable - retrying';
// Why the site stopped this PC's link, in the CLI's own words: the site's text is never printed in the user's terminal
const OFF_REASONS = Object.freeze({
  replaced: 'another quantess window on this PC took over your phone link (/tlink on takes it back)'
});

const safeJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
// BYTES, not characters: the site's limit is on the request, and CJK or emoji text is 3-4 bytes a character
const sizeOf = (e) => Buffer.byteLength(JSON.stringify(e)) + 1;
const success = (code) => code >= 200 && code < 300;
const refused = (code) => code === 401 || code === 403;
// The site read the batch and said no to its content. Anything else (404 mid-deploy, 429, 5xx...) is retried
const badBatch = (code) => code === 400 || code === 413 || code === 422;
const REPAIR = 'the site no longer knows this PC - run quantess --tlink-pair';

/**
 * @param {{
 *   pairing: { origin: string, token: string, deviceId: string },
 *   sessionId: string | (() => string),
 *   events: ReturnType<import('./events.js').createEventLog>,
 *   fetchImpl?: typeof fetch,
 *   snapshotPrompts?: () => object[],
 *   onStatus?: (status: string, reason: string) => void,
 *   flushMs?: number, backoffMs?: [number, number], idleMs?: number, stableMs?: number, settleMs?: number,
 *   random?: () => number,
 *   streamBudget?: { bytes: number, windowMs: number, framesPerSec: number }
 * }} options
 */
export function createTlinkClient({ pairing, sessionId, events, fetchImpl = fetch, snapshotPrompts = () => [],
  onStatus = () => {}, flushMs = 500, backoffMs = [1000, 30_000], idleMs = 60_000, stableMs = 30_000, settleMs = 1500,
  random = Math.random, streamBudget = { bytes: 1_048_576, windowMs: 10_000, framesPerSec: 200 } }) {
  let status = 'off';
  let reason = '';
  let stopped = false;
  let started = false;
  let session = sessionId;
  const sid = () => (typeof session === 'function' ? session() : session);
  // "on" needs BOTH halves: lines getting out (sendOk) and the answer stream open (streamOk). Either recovering
  // brings it back (review: one failed send used to leave it "offline" while the stream was fine)
  let sendOk = true;
  let streamOk = false;
  let everOn = false;
  let inflight = null;
  const carry = [];                // taken from the log but not yet sent (did not fit the last batch)
  let resyncs = 0;
  let stream = null;               // the open stream's AbortController
  const halt = new AbortController();   // stop() cancels every request still waiting on the site
  // Each pause has its own wake-up: flush() ends the sender's idle wait only - never a back-off, never the stream's
  const wakers = { idle: null, backoff: null, stream: null };
  const wakeAll = () => Object.values(wakers).forEach((w) => w?.());
  const history = [];
  const subscribers = new Set();
  const auth = { authorization: `Bearer ${pairing.token}` };

  const setStatus = (next, why = '') => {
    if (next === status && why === reason) return;
    status = next;
    reason = why;
    try {
      onStatus(next, why);
    } catch {
      // a status line must never break the client
    }
  };
  const derive = () => {
    if (stopped) return;
    if (sendOk && streamOk) {
      everOn = true;
      setStatus('on');
    } else {
      setStatus(everOn ? 'offline' : 'connecting', everOn ? OFFLINE : '');
    }
  };
  const backoff = (n) => Math.min(backoffMs[1], backoffMs[0] * 2 ** n) * (0.5 + random() * 0.5);
  /** A pause one loop can be woken from (each loop has its own: a flush wakes the sender, never the stream). */
  const pause = (which, ms) => new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      if (wakers[which] === done) wakers[which] = null;
      resolve();
    }
    wakers[which] = done;
  });

  async function request(path, { method = 'GET', body } = {}) {
    const res = await fetchImpl(`${pairing.origin}${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(REQUEST_MS), halt.signal]),
      headers: { ...auth, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, json: safeJson(await readCapped(res, BODY_CAP)) };
  }

  /** Lines for one POST: up to 50, and - checked before each line is added - under the size limit. */
  function nextBatch() {
    const out = [];
    let bytes = 64;
    while (out.length < BATCH_EVENTS) {
      const next = carry.length ? [carry.shift()] : events.take(1);
      if (!next.length) break;
      const left = [];
      for (const e of next) {
        if (left.length || out.length >= BATCH_EVENTS || (out.length && bytes + sizeOf(e) > BATCH_BYTES)) left.push(e);
        else {
          out.push(e);
          bytes += sizeOf(e);
        }
      }
      if (left.length) {
        carry.unshift(...left);         // back at the FRONT: lines always leave in the order they happened
        break;
      }
    }
    return out;
  }
  const queued = () => Boolean(inflight) || carry.length > 0 || events.pending() > 0;

  const remember = (batch) => {
    history.push(...batch);
    history.splice(0, Math.max(0, history.length - HISTORY));
  };

  function stop(why = 'stopped') {
    if (stopped) return;
    stopped = true;
    halt.abort();
    stream?.abort();
    wakeAll();
    setStatus('stopped', why);
  }

  /**
   * The site restarted and lost its copy: re-post the newest lines that fit, plus every open question with the time
   * it has left (never a stale prompt_open from history).
   */
  async function resync() {
    const open = snapshotPrompts() ?? [];
    let bytes = 64 + open.reduce((n, e) => n + sizeOf(e), 0);
    const kept = [];
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const e = history[i];
      if (e.type === 'prompt_open' || e.type === 'dropped') continue;
      if (bytes + sizeOf(e) > RESYNC_BYTES) break;
      kept.unshift(e);
      bytes += sizeOf(e);
    }
    const res = await request(PATHS.events, { method: 'POST', body: { sessionId: sid(), resync: true, events: [...kept, ...open] } });
    if (refused(res.status)) return stop(REPAIR);
    if (!success(res.status)) throw new Error(`resync ${res.status}`);
    sendOk = true;
    derive();
  }

  /**
   * The site refused this batch's content. Halve it until the bad line is alone, then drop just that line and tell
   * the phone one is missing - the lines around it still go.
   */
  function dropBad() {
    if (inflight.length > 1) {
      carry.unshift(...inflight.slice(Math.ceil(inflight.length / 2)));
      inflight = inflight.slice(0, Math.ceil(inflight.length / 2));
      return false;
    }
    // A refused marker is not marked again: a site that refuses everything must not get an endless trail of them
    if (inflight[0]?.type !== 'dropped') carry.unshift({ at: Date.now(), type: 'dropped', count: 1 });
    inflight = null;
    return !queued();
  }

  /** One send. @returns {Promise<boolean>} true when there is nothing more to send right now */
  async function sendOnce() {
    if (!inflight) {
      inflight = nextBatch();
      if (!inflight.length) {
        inflight = null;
        return true;
      }
    }
    const res = await request(PATHS.events, { method: 'POST', body: { sessionId: sid(), events: inflight } });
    if (success(res.status)) {
      remember(inflight);
      inflight = null;
      resyncs = 0;
      sendOk = true;
      derive();
      return !queued();
    }
    if (refused(res.status)) {
      stop(REPAIR);
      return true;
    }
    if (res.status === 409) {
      resyncs += 1;
      if (resyncs > MAX_RESYNCS) {
        stop('the site keeps asking to resync - T-LINK off (check the site)');
        return true;
      }
      await resync();
      if (resyncs > 1 && !stopped) await pause('backoff', backoff(resyncs - 1));
      return false;
    }
    if (!badBatch(res.status)) throw new Error(`events ${res.status}`);
    // It answered: the site is reachable, whatever it thought of this batch
    sendOk = true;
    derive();
    return dropBad();
  }

  async function sendLoop() {
    let attempt = 0;
    while (!stopped) {
      try {
        const idle = await sendOnce();
        attempt = 0;
        if (idle && !stopped) await pause('idle', flushMs);
      } catch {
        if (stopped) break;
        sendOk = false;
        derive();
        await pause('backoff', backoff(attempt++));
      }
    }
  }

  /** Frames and bytes a stream may send before it is dropped (a flood is cut off, never read without limit). */
  function streamGuard(ctrl) {
    let windowStart = Date.now();
    let bytes = 0;
    let secondStart = Date.now();
    let frames = 0;
    return {
      chunk(n) {
        const now = Date.now();
        if (now - windowStart > streamBudget.windowMs) {
          windowStart = now;
          bytes = 0;
        }
        bytes += n;
        if (bytes > streamBudget.bytes) ctrl.abort();
      },
      frame() {
        const now = Date.now();
        if (now - secondStart > 1000) {
          secondStart = now;
          frames = 0;
        }
        frames += 1;
        if (frames > streamBudget.framesPerSec) ctrl.abort();
      }
    };
  }

  function onFrame({ event, data }) {
    if (event === 'answer') {
      const frame = parseAnswerFrame(data);
      if (!frame) return;
      for (const fn of [...subscribers]) {
        try {
          fn(frame);
        } catch {
          // one bad listener never stops the stream
        }
      }
    } else if (event === 'off') {
      const code = safeJson(data)?.reason;
      stop(typeof code === 'string' && Object.hasOwn(OFF_REASONS, code) ? OFF_REASONS[code] : 'turned off from the site');
    }
  }

  async function streamLoop() {
    let attempt = 0;
    while (!stopped) {
      const ctrl = new AbortController();
      stream = ctrl;
      let idle = null;
      let settle = null;
      let openedAt = 0;
      const kick = () => {
        clearTimeout(idle);
        idle = setTimeout(() => ctrl.abort(), idleMs);
      };
      try {
        kick();
        const res = await fetchImpl(`${pairing.origin}${PATHS.stream}`, {
          headers: { ...auth, accept: 'text/event-stream' }, redirect: 'error', signal: ctrl.signal
        });
        if (refused(res.status)) {
          stop(REPAIR);
          break;
        }
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        openedAt = Date.now();
        // "on" only once the stream has stayed up a moment: a site that accepts and hangs up at once never counts
        settle = setTimeout(() => {
          streamOk = true;
          derive();
        }, settleMs);
        const guard = streamGuard(ctrl);
        const parser = createSseParser({
          onEvent: (e) => {
            if (ctrl.signal.aborted) return;   // the guard tripped: the rest of this chunk is never handed on
            guard.frame();
            if (!ctrl.signal.aborted) onFrame(e);
          },
          onError: () => ctrl.abort()
        });
        const decoder = new TextDecoder();
        for await (const chunk of res.body) {
          kick();
          guard.chunk(chunk.byteLength);
          if (ctrl.signal.aborted) break;
          parser.push(decoder.decode(chunk, { stream: true }));
          if (stopped || ctrl.signal.aborted) break;
        }
      } catch {
        // dropped, timed out, refused, flooded or reset: reconnect below
      } finally {
        clearTimeout(idle);
        clearTimeout(settle);
        ctrl.abort();
      }
      if (stopped) break;
      streamOk = false;
      derive();
      // The wait only starts over after a stream that stayed up: one that drops at once waits longer each time
      attempt = openedAt && Date.now() - openedAt >= stableMs ? 0 : attempt + 1;
      await pause('stream', backoff(attempt));
    }
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      setStatus('connecting');
      sendLoop();
      streamLoop();
    },
    stop,
    /**
     * The session is over: give the last lines a moment to go out, then tell the site (best effort), then stop.
     * After /tlink off (or any stop) it says nothing more.
     */
    async end() {
      if (stopped || !started) return;
      const deadline = Date.now() + DRAIN_MS;
      wakers.idle?.();
      wakers.backoff?.();
      while (queued() && !stopped && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      if (stopped) return;
      try {
        await request(PATHS.end, { method: 'POST', body: { sessionId: sid() } });
      } catch {
        // the site will notice the stream closing
      }
      stop('session ended');
    },
    /** @returns {() => void} unsubscribe */
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    connected: () => status === 'on' && !stopped,
    status: () => ({ status, reason }),
    /** Send what is queued now instead of at the next tick (a question just opened). */
    flush: () => wakers.idle?.(),
    setSession(id) {
      session = id;
    }
  };
}
