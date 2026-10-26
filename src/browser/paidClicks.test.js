import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pageLabels, paidClickLabel, parsePaidFlag, touchesQ23Limits, gatePaidClick, setPaidClickBudget,
  setPaidClickApprover, startPaidClickTurn, noteToolResult, paidClickQuestion
} from './paidClicks.js';

const PAGE = [
  '- button "Generate Image" [ref=f1e248] [cursor=pointer]',
  '- button "Open Full Size" [ref=f1e260]',
  '- button "Upscale 2×" [ref=f1e263] [box=751,718,78,28]',
  '- button "Say \\"Generate\\" now" [ref=e5]',
  '- link "Sign out" [ref=f1e91]'
].join('\n');
const CALM_PAGE = '- button "Open Full Size" [ref=e1]\n- link "Sign out" [ref=e2]';

test('pageLabels maps refs to labels, escaped quotes included', () => {
  const labels = pageLabels(PAGE);
  assert.equal(labels.get('f1e263'), 'Upscale 2×');
  assert.equal(labels.get('e5'), 'Say \\"Generate\\" now');
  assert.equal(labels.get('f1e91'), 'Sign out');
});

test('a click by selector or text is judged by the selector too, not just the description', () => {
  const labels = pageLabels(PAGE);
  const click = (target, element = 'image') => paidClickLabel('browser_click', { target, element }, labels);
  assert.ok(click("getByRole('button', { name: 'Upscale 2×' })"));
  assert.ok(click('text=Upscale'));
  assert.equal(click('text=Open Full Size'), null);
  assert.doesNotThrow(() => paidClickLabel('browser_click', { target: 42, element: 'x' }, labels));
});

test('escaped quotes in a label cannot hide a money button', () => {
  assert.ok(paidClickLabel('browser_click', { target: 'e5', element: 'harmless' }, pageLabels(PAGE)));
});

test('an unknown ref falls back to the model\'s description', () => {
  assert.ok(paidClickLabel('browser_click', { target: 'e999', element: 'Generate button' }, pageLabels(PAGE)));
  assert.equal(paidClickLabel('browser_click', { target: 'e999', element: 'gallery tab' }, pageLabels(PAGE)), null);
});

test('payment, credits, top-up, trial and order buttons count as money; ordinary ones do not', () => {
  const paid = ['Continue to payment', 'Add credits', 'Buy credits', 'Top up', 'Start free trial', 'Confirm order', 'Place order'];
  const free = ['Open Full Size', 'Sign out', 'Create account', 'Credits', 'Order history', 'Payment methods help'];
  for (const label of paid) assert.ok(paidClickLabel('browser_click', { element: label, target: 'x' }, new Map()), label);
  for (const label of free) assert.equal(paidClickLabel('browser_click', { element: label, target: 'x' }, new Map()), null, label);
});

test('Enter, Space or submit while a money button is on the page needs approval', () => {
  const labels = pageLabels(PAGE);
  assert.match(paidClickLabel('browser_press_key', { key: 'Enter' }, labels), /Generate Image/);
  assert.ok(paidClickLabel('browser_press_key', { key: ' ' }, labels));
  assert.ok(paidClickLabel('browser_type', { text: 'a mandala', submit: true }, labels));
  assert.equal(paidClickLabel('browser_type', { text: 'a mandala', submit: false }, labels), null);
  assert.equal(paidClickLabel('browser_press_key', { key: 'a' }, labels), null);
  assert.equal(paidClickLabel('browser_press_key', { key: 'Enter' }, pageLabels(CALM_PAGE)), null, 'no money button on screen');
});

test('parsePaidFlag takes a whole number and keeps the task', () => {
  assert.deepEqual(parsePaidFlag(['--paid', '2', 'make', 'an image']), { budget: 2, rest: ['make', 'an image'] });
  assert.deepEqual(parsePaidFlag(['make', 'an image']), { budget: null, rest: ['make', 'an image'] });
  assert.match(parsePaidFlag(['--paid', 'make an image']).error, /needs a number/);
  assert.match(parsePaidFlag(['--paid', '-1', 'x']).error, /needs a number/);
  assert.match(parsePaidFlag(['--paid']).error, /needs a number/);
});

test('touchesQ23Limits catches Q23 trying to raise its own limits from the shell', () => {
  for (const cmd of ['quantessq23 --paid 5 "go"', 'node src/cli.js --paid 1 x', '$env:Q23_PAID_CLICKS=9', 'setx Q23_BROWSER_ALLOW "*"', 'set Q23_BROWSER_UNSAFE=1',
    // 10-23: the model could raise its own spending cap, reopen the browser list, or wipe the day's spend
    'setx QUANTESS_DAILY_CAP_USD 500', '$env:QUANTESS_BROWSER_SITES="any"', 'Remove-Item ~/.quantess/ledger.json',
    'echo {} > C:\\Users\\riley\\.quantess\\ledger.json', 'setx QUANTESS_HOME C:/tmp/fresh',
    // Security review 10-23: the cap without _USD, a junction to the quantess home, the 8.3 short name
    'setx QUANTESS_DAILY_CAP 999', 'mklink /J C:\\t\\q C:\\Users\\riley\\.quantess', 'cmd /c mklink /D C:\\t\\q C:\\x',
    'New-Item -ItemType Junction -Path C:/t/q -Target C:/x', 'Get-Content C:\\Users\\riley\\QUANTE~1\\ledger.json',
    'dir $HOME\\.quantess']) {
    assert.equal(touchesQ23Limits(cmd), true, cmd);
  }
  for (const cmd of ['git status', 'npm test', 'echo paid invoices', 'node -e "console.log(item.quantity)"', 'New-Item -ItemType Directory dist']) {
    assert.equal(touchesQ23Limits(cmd), false, cmd);
  }
});

// Automated review of 22b35f5: wildcard spellings of the quantess folder or the T-LINK key, and fsutil hard links.
// Text matching is a speed bump, not a wall (a command runs as the user) - the key cannot approve anything anyway.
test('negative: wildcard spellings of the quantess folder or the key, and fsutil hard links, are caught', () => {
  for (const cmd of ['type %USERPROFILE%\\.q*\\t*.json', 'cat ~/.qu*/tl*', 'Get-Content $HOME\\.quan?ess\\*.json',
    'gci ~\\.q* -Recurse', 'fsutil hardlink create C:\\t\\x C:\\Users\\riley\\y', 'certutil -encode ~\\tlink.j* out.txt']) {
    assert.equal(touchesQ23Limits(cmd), true, cmd);
  }
  for (const cmd of ['ls src/*.js', 'git log -1', 'grep -r "query" src', 'npm run test:quick']) {
    assert.equal(touchesQ23Limits(cmd), false, cmd);
  }
});

// 10-14: the user said yes four times to "Generate Image" with no way to tell the 4th from the 1st,
// and Q23 generated after the photo upload had failed, so all four were strangers.
const UPLOAD_ERROR = 'browser_file_upload failed: The tool "browser_file_upload" can only be used when there is related modal state present.';

/** A fresh task with the user at the terminal, answering `answer` and logging what they were asked. */
function userAtTerminal(answer = true) {
  const asked = [];
  startPaidClickTurn();
  setPaidClickBudget(0);
  setPaidClickApprover(async (label, context) => { asked.push({ label, ...context }); return answer; });
  return asked;
}

test('the user is told which paid click this is when Q23 comes back for another', async () => {
  const asked = userAtTerminal();
  await gatePaidClick('Generate Image');
  await gatePaidClick('Generate Image');
  assert.deepEqual(asked.map((a) => a.count), [1, 2]);
  assert.match(paidClickQuestion('Generate Image', 2), /AGAIN.*#2/);
  assert.doesNotMatch(paidClickQuestion('Generate Image', 1), /AGAIN|#/);
});

test('a click the user refuses is not counted', async () => {
  const asked = userAtTerminal(false);
  await gatePaidClick('Generate Image');
  await gatePaidClick('Generate Image');
  assert.deepEqual(asked.map((a) => a.count), [1, 1]);
});

test('a new task from the user starts the count over', async () => {
  const asked = userAtTerminal();
  await gatePaidClick('Generate Image');
  startPaidClickTurn();
  await gatePaidClick('Generate Image');
  assert.deepEqual(asked.map((a) => a.count), [1, 1]);
});

test('after a failed upload, money buttons stop without even asking the user', async () => {
  const asked = userAtTerminal();
  noteToolResult('browser_file_upload', false, UPLOAD_ERROR);
  const gate = await gatePaidClick('Generate Image');
  assert.equal(gate.allowed, false);
  assert.match(gate.how, /upload/);
  assert.deepEqual(asked, []);
});

test('a failed upload outranks a pre-approved --paid budget, and does not use it up', async () => {
  userAtTerminal();
  setPaidClickApprover(null);
  setPaidClickBudget(1);
  noteToolResult('browser_file_upload', false, UPLOAD_ERROR);
  assert.equal((await gatePaidClick('Generate Image')).allowed, false);
  noteToolResult('browser_file_upload', true, 'browser_file_upload done');
  assert.equal((await gatePaidClick('Generate Image')).allowed, true, 'the budget was still there');
});

test('a later upload that works, or a new task, lifts the stop', async () => {
  userAtTerminal();
  noteToolResult('browser_file_upload', false, UPLOAD_ERROR);
  noteToolResult('browser_file_upload', true, 'browser_file_upload done');
  assert.equal((await gatePaidClick('Generate Image')).allowed, true);
  noteToolResult('browser_file_upload', false, UPLOAD_ERROR);
  startPaidClickTurn();
  assert.equal((await gatePaidClick('Generate Image')).allowed, true);
});

test('other failed steps do not block money buttons on their own', async () => {
  userAtTerminal();
  noteToolResult('browser_click', false, 'browser_click failed: Ref e601 not found');
  assert.equal((await gatePaidClick('Generate Image')).allowed, true);
  setPaidClickApprover(null);
});

// T-LINK security review 10-24: the label is the PAGE's text and reached the terminal prompt raw
test('negative: a paid button label shows hidden characters as escapes, never raw', () => {
  const q = paidClickQuestion('Upscale\u001b[2K\u001b[1GFree preview\u200b', 1);
  assert.doesNotMatch(q, /[\u001b\u200b]/);
  assert.ok(q.includes('\\x1b[2K'), q);
  assert.ok(q.includes('\\u{200b}'), q);
});

test('negative: a paid label cannot fake a second line, and a long one is cut and says so', () => {
  const q = paidClickQuestion('Upscale\nFree preview (no charge)\t', 1);
  assert.equal(q.split('\n').length, 1);
  assert.ok(q.includes('\\x0aFree preview'), q);
  const long = paidClickQuestion('Buy '.repeat(200), 1);
  assert.ok(long.length < 400, `${long.length}`);
  assert.match(long, /\(label cut\)/);
});
