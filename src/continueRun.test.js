import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runToEnd, autoContinueRounds } from './continueRun.js';

// A fake agent turn: paused at the step cap for the first `pausedTurns` turns, then done. Like agent.run, cost is the
// SESSION's running total as a toFixed(6) string (code review 10-24: summing those printed $NaN and double-counted).
function fakeRun(pausedTurns, { stopAt = -1, throwAt = -1 } = {}) {
  const tasks = [];
  const run = async (task) => {
    tasks.push(task);
    const n = tasks.length;
    if (n === throwAt) throw new Error('every model in the chain failed');
    return {
      response: n > pausedTurns ? 'done: file:///C:/site/index.html' : null,
      paused: n <= pausedTurns,
      stopped: n === stopAt,
      iterations: 40,
      cost: { totalCost: (0.01 * n).toFixed(6) }
    };
  };
  return { run, tasks };
}

test('a continuation that throws keeps what the earlier turns did, and says why it stopped', async () => {
  const { run } = fakeRun(5, { throwAt: 2 });
  const r = await runToEnd(run, 'job', { rounds: 3 });
  assert.equal(r.paused, true);
  assert.equal(r.iterations, 40);
  assert.equal(r.cost.totalCost, '0.010000');
  assert.match(r.error, /every model in the chain failed/);
});

// Live 10-24: three one-shot rounds ended at the 40-step cap mid-job, and quantess printed "Task completed" each time.
test('a one-shot job paused at the step cap keeps going, and the totals add up', async () => {
  const { run, tasks } = fakeRun(2);
  const r = await runToEnd(run, 'build the site', { rounds: 2 });
  assert.deepEqual(tasks, ['build the site', 'keep going', 'keep going']);
  assert.equal(r.paused, false);
  assert.equal(r.response, 'done: file:///C:/site/index.html');
  assert.equal(r.iterations, 120);
  assert.equal(r.cost.totalCost, '0.030000', 'the session total from the last turn, not a sum of running totals');
});

test('it stops after its rounds and still says paused (negative: never endless)', async () => {
  const { run, tasks } = fakeRun(10);
  const r = await runToEnd(run, 'big job', { rounds: 2 });
  assert.equal(tasks.length, 3);
  assert.equal(r.paused, true);
});

test('Ctrl+C ends it at once (negative)', async () => {
  const { run, tasks } = fakeRun(5, { stopAt: 1 });
  const r = await runToEnd(run, 'job', { rounds: 3 });
  assert.equal(tasks.length, 1);
  assert.equal(r.stopped, true);
});

test('a job that finishes in one turn runs once (negative)', async () => {
  const { run, tasks } = fakeRun(0);
  await runToEnd(run, 'small job', { rounds: 2 });
  assert.equal(tasks.length, 1);
});

test('QUANTESS_AUTO_CONTINUE sets the rounds, 0 to 5, default 2', () => {
  assert.equal(autoContinueRounds({}), 2);
  assert.equal(autoContinueRounds({ QUANTESS_AUTO_CONTINUE: '0' }), 0);
  assert.equal(autoContinueRounds({ QUANTESS_AUTO_CONTINUE: '4' }), 4);
  assert.equal(autoContinueRounds({ QUANTESS_AUTO_CONTINUE: '99' }), 5);
  assert.equal(autoContinueRounds({ QUANTESS_AUTO_CONTINUE: 'lots' }), 2);
});
