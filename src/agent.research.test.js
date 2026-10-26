import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Live 10-23: asked "Search the web: what is the spark plug gap...", Nemotron answered from memory in ONE
// step and invented a source link. A plain research ask now FORCES web_search on its first step.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'q23-research-')));
process.env.OPENROUTER_API_KEY ||= 'sk-or-test-not-a-real-key';
const { Agent, isWebResearchAsk } = await import('./agent.js');

test('a plain ask for web research is recognised; a code search is not', () => {
  for (const ask of ['Search the web: spark plug gap 2014 camaro', 'can you look it up online', 'research the best AI upscalers',
    'google that for me', 'web search the price of Wan 3.0', 'search online for the Discord zip']) {
    assert.equal(isWebResearchAsk(ask), true, ask);
  }
  for (const ask of ['search the codebase for boost', 'grep for flight', 'fix the search bar in the app', 'hello', '']) {
    assert.equal(isWebResearchAsk(ask), false, ask);
  }
});

function recordingAgent(replies) {
  const bodies = [];
  const agent = new Agent({ browser: false, sleep: async () => {} });
  agent.client = {
    chat: {
      completions: {
        create: async (body) => {
          bodies.push(body);
          const next = replies[Math.min(bodies.length - 1, replies.length - 1)];
          if (next instanceof Error) throw next;
          return { choices: [{ message: typeof next === 'string' ? { role: 'assistant', content: next } : next, finish_reason: 'stop' }] };
        }
      }
    }
  };
  return { agent, bodies };
}

const searchCall = { role: 'assistant', content: null, tool_calls: [{ id: 's1', type: 'function', function: { name: 'no_such_tool', arguments: '{}' } }] };

test('the first step of a research ask must call web_search; later steps choose freely', async () => {
  const { agent, bodies } = recordingAgent([searchCall, 'answer with links']);
  await agent.run('Search the web: spark plug gap for a 2014 Camaro 3.6');
  assert.deepEqual(bodies[0].tool_choice, { type: 'function', function: { name: 'web_search' } });
  assert.equal(bodies[1].tool_choice, 'auto');
});

test('negative: an ordinary task is never forced onto the web', async () => {
  const { agent, bodies } = recordingAgent(['done']);
  await agent.run('read prices.csv and add them up');
  assert.equal(bodies[0].tool_choice, 'auto');
});

test('a provider that refuses the forced choice gets the same step again, unforced - no red', async () => {
  const refuse = Object.assign(new Error('400 tool_choice is not supported'), { status: 400 });
  const { agent, bodies } = recordingAgent([refuse, 'answer']);
  assert.equal((await agent.run('research the best AI upscalers')).response, 'answer');
  assert.deepEqual(bodies[0].tool_choice, { type: 'function', function: { name: 'web_search' } });
  assert.equal(bodies[1].tool_choice, 'auto');
  assert.equal(bodies[1].model, bodies[0].model, 'same model, not a fallback');
});
