import { test } from 'node:test';
import assert from 'node:assert/strict';
import { videoId, parseCaptions, formatTranscript, fetchTranscript } from './youtube.js';

// Ported from quantus-cli: the YouTube connector (title, channel, timestamped transcript from a link or id)

test('youtube ids come out of every link shape', () => {
  for (const url of ['https://www.youtube.com/watch?v=DNqg7mrxiHg', 'https://youtu.be/DNqg7mrxiHg?t=3', 'https://youtube.com/shorts/DNqg7mrxiHg',
    'https://www.youtube.com/watch?feature=share&v=DNqg7mrxiHg', 'DNqg7mrxiHg']) {
    assert.equal(videoId(url), 'DNqg7mrxiHg', url);
  }
  assert.equal(videoId('https://example.com/watch?v=nope'), null);
});

test('captions parse in both XML shapes and format with timestamps', () => {
  const legacy = parseCaptions('<transcript><text start="0.5" dur="2">Hello &amp; welcome</text><text start="31" dur="2">Part two</text></transcript>');
  assert.deepEqual(legacy.map((l) => l.text), ['Hello & welcome', 'Part two']);
  const srv3 = parseCaptions('<timedtext><body><p t="1000" d="500"><s>Hi</s> there</p></body></timedtext>');
  assert.deepEqual(srv3, [{ start: 1, text: 'Hi there' }]);
  assert.equal(formatTranscript(legacy), '[0:00] Hello & welcome \n[0:31] Part two');
});

// Code review 10-23: "&amp;lt;" was decoded twice into "<" - it means the literal text "&lt;"
test('an escaped entity in a caption is decoded once, never twice', () => {
  const [line] = parseCaptions('<transcript><text start="0" dur="1">a &amp;lt; b</text></transcript>');
  assert.equal(line.text, 'a &lt; b');
});

test('a video without captions says so instead of returning nothing', async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ({ playabilityStatus: { status: 'OK' }, videoDetails: { title: 'T', author: 'A', lengthSeconds: '60' } }) });
  const v = await fetchTranscript('DNqg7mrxiHg', { fetchImpl: fakeFetch });
  assert.equal(v.transcript, '');
  assert.match(v.note, /no captions/);
});

test('a private video surfaces YouTube\'s reason', async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'This video is private' } }) });
  await assert.rejects(fetchTranscript('DNqg7mrxiHg', { fetchImpl: fakeFetch }), /private/);
});

test('captions download from the link YouTube gave, and come back timestamped', async () => {
  const urls = [];
  const fakeFetch = async (url) => {
    urls.push(String(url));
    if (urls.length === 1) {
      return { ok: true, json: async () => ({ playabilityStatus: { status: 'OK' }, videoDetails: { title: 'EP04', author: 'Channel', lengthSeconds: '120' },
        captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en', baseUrl: 'https://www.youtube.com/api/timedtext?v=x&fmt=srv3' }] } } }) };
    }
    return { ok: true, text: async () => '<transcript><text start="0" dur="2">Truth tables</text></transcript>' };
  };
  const v = await fetchTranscript('https://youtu.be/DNqg7mrxiHg', { fetchImpl: fakeFetch });
  assert.equal(v.transcript, '[0:00] Truth tables');
  assert.equal(urls[1], 'https://www.youtube.com/api/timedtext?v=x', 'fmt dropped so the XML shape comes back');
});

// The caption link comes out of YouTube's reply: it must point at YouTube before anything fetches it
test('negative: a caption link that is not YouTube\'s is never fetched', async () => {
  let fetched = 0;
  const fakeFetch = async () => {
    fetched += 1;
    return { ok: true, json: async () => ({ playabilityStatus: { status: 'OK' }, videoDetails: { title: 'T' },
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en', baseUrl: 'http://169.254.169.254/latest/meta-data' }] } } }) };
  };
  await assert.rejects(fetchTranscript('DNqg7mrxiHg', { fetchImpl: fakeFetch }), /not a YouTube caption link/);
  assert.equal(fetched, 1);
});
