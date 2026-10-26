import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processKill, backgroundAmpersand } from './shellGuard.js';

// Live 10-24 (the Bowl & Bloom rebuild): a localhost server would not come up, so quantess listed every python on the PC
// and ran "Stop-Process -Id 2640 -Force" - a python it had NOT started (another program's encode controller). Killing by
// NAME was already forbidden in the prompt; it killed by PID instead. run_shell now refuses every process kill.
test('processKill catches every way a shell command stops a process', () => {
  for (const cmd of [
    'Stop-Process -Id 2640 -Force',
    '2640 | Stop-Process -Force',
    'Get-Process python* | Stop-Process',
    'stop-process -name python',
    'spps -Id 12',
    'taskkill /PID 2640 /F',
    'taskkill.exe /IM node.exe /F',
    'kill 2640',
    'kill -9 2640',
    'kill -Id 2640',
    'kill -Name python',
    'pkill -f http.server',
    'killall node',
    'tskill 2640',
    'wmic process where name="python.exe" delete',
    'wmic process where processid=2640 call terminate',
    '(Get-Process -Id 2640).Kill()',
    'npx kill-port 8080',
    'fuser -k 8080/tcp',
    'Stop-Service MySQL',
    'Get-CimInstance Win32_Process -Filter "ProcessId=2640" | Invoke-CimMethod -MethodName Terminate',
    // the 10-24 reviews: shapes a model writes by accident
    'Get-Process foo | kill',
    'Get-Process node | % { $_.Kill($true) }',
    'kill $p',
    'node -e "process.kill(2640)"',
    'python -c "import os; os.kill(2640, 9)"',
    'python -c "import psutil; psutil.Process(2640).terminate()"',
    'npx fkill node',
    'net stop MySQL80',
    'sc.exe stop Spooler',
    'sc stop Spooler'
  ]) {
    assert.ok(processKill(cmd), `missed: ${cmd}`);
  }
});

test('processKill leaves ordinary commands alone (negative)', () => {
  for (const cmd of [
    'Get-Process python*',
    'npm run build',
    'python -m http.server 8765',
    'echo "the skill library"',
    'git log --oneline -5',
    'Start-Process notepad',
    'node scripts/skillcheck.js',
    'Get-ChildItem -LiteralPath C:/Users/riley/my-site/site',
    'grep -rn "killTree" src'
  ]) {
    assert.equal(processKill(cmd), null, `false alarm: ${cmd}`);
  }
});

// Live 10-24: "python -m http.server 8080 &" - in pwsh a trailing & makes a PowerShell job that dies the moment run_shell's
// pwsh exits, so the server never stayed up and quantess burned steps on it every round. background:true is the way.
test('backgroundAmpersand catches a bash-style trailing &', () => {
  for (const cmd of ['python -m http.server 8080 &', 'python3 -m http.server 8080 2>&1 &', 'npm run dev &  ']) {
    assert.equal(backgroundAmpersand(cmd), true, cmd);
  }
});

test('backgroundAmpersand leaves && and the pwsh call operator alone (negative)', () => {
  for (const cmd of ['npm install && npm test', '& "C:/tools/x.exe" --help', 'echo a & echo b', 'python script.py 2>&1']) {
    assert.equal(backgroundAmpersand(cmd), false, cmd);
  }
});
