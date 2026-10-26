# quantess installer for Windows PowerShell 5.1+ and PowerShell 7.
# One line, from PowerShell or Git Bash:
#   powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/respectfulnrespected59-source/quantess/main/install.ps1 | iex"
# Or from a copy of the repo:
#   powershell -ExecutionPolicy Bypass -File install.ps1
# Safe to re-run: it updates an existing install instead of duplicating it.
# Calls are paid by your QUAN-TESS AI plan (quantess login), or by your own OpenRouter key with -OwnKey.

param(
  [string]$InstallDir = (Join-Path $HOME 'quantess'),
  [string]$RepoUrl = 'https://github.com/respectfulnrespected59-source/quantess.git',
  # Pay with your own OpenRouter key (paid models up to $5 a day, then free models) instead of a QUAN-TESS AI plan
  [switch]$OwnKey
)

# Windows PowerShell 5.1 turns ANY text a program writes to stderr into a fatal error under 'Stop' - even
# git's harmless "no upstream" note. Programs are judged by their exit code ($LASTEXITCODE) below instead,
# and the PowerShell file steps say -ErrorAction Stop themselves.
$ErrorActionPreference = 'Continue'
$CommandName = 'quantess'

function Step($n, $text) { Write-Host "`n[$n/6] $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "  OK  $text" -ForegroundColor Green }
function Note($text) { Write-Host "  NOTE  $text" -ForegroundColor Yellow }
# throw, not exit: run with irm | iex, exit would close the whole window before the FIX could be read
function Fail($text, $fix) {
  Write-Host "  FAIL  $text" -ForegroundColor Red
  Write-Host "  FIX:  $fix" -ForegroundColor Yellow
  throw 'quantess install stopped: see FAIL above.'
}

function Test-Command($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

# An install made before the public repo lives in ~/q23-agent: keep updating that one
if (-not $PSBoundParameters.ContainsKey('InstallDir')) {
  $older = Join-Path $HOME 'q23-agent'
  if (Test-Path (Join-Path $older '.git')) { $InstallDir = $older }
}

Step 1 'Checking Git and Node.js'
if (-not (Test-Command git)) {
  Fail 'Git is not installed.' 'Run: winget install Git.Git   then CLOSE this window, open a new one, and run the installer again.'
}
Ok (git --version)
if (-not (Test-Command node)) {
  Fail 'Node.js is not installed.' 'Run: winget install OpenJS.NodeJS.LTS   then CLOSE this window, open a new one, and run the installer again.'
}
$nodeMajor = [int]((node -v).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) {
  Fail "Node.js $(node -v) is too old (need 20 or newer)." 'Run: winget upgrade OpenJS.NodeJS.LTS   then open a new window.'
}
Ok "Node.js $(node -v)"

Step 2 "Getting the code into $InstallDir"
if (Test-Path (Join-Path $InstallDir '.git')) {
  # A local branch with no remote (work in progress) has nothing to pull: keep it as it is
  git -C $InstallDir rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Note 'This copy is on a local branch with no remote: kept as it is, nothing pulled'
  } else {
    git -C $InstallDir pull --ff-only
    if ($LASTEXITCODE -ne 0) {
      Fail 'git pull failed (local changes or no access).' "Run: git -C `"$InstallDir`" status   to see what changed."
    }
    Ok 'Updated existing copy'
  }
} else {
  if (Test-Path $InstallDir) {
    Fail "$InstallDir exists but is not a git copy." "Rename it (e.g. Rename-Item `"$InstallDir`" quantess-old) and run the installer again."
  }
  git clone $RepoUrl $InstallDir
  if ($LASTEXITCODE -ne 0) {
    Fail "Could not download $RepoUrl." 'Check your internet connection and try again. (A private copy needs: gh auth login)'
  }
  Ok 'Downloaded fresh copy'
}
Ok "Version: $(git -C $InstallDir log --oneline -1)"

Step 3 'Installing packages (npm install)'
Push-Location $InstallDir
try {
  npm install --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { Fail 'npm install failed.' 'Read the red text above; running the installer again often fixes a network hiccup.' }
} finally {
  Pop-Location
}
Ok 'Packages installed'

# The old names (quantus, quantessq23, q23) exist only in copies that still carry their bin\ files
$Aliases = @(@('quantus', 'quantessq23', 'q23') | Where-Object { Test-Path (Join-Path $InstallDir "bin\$_.js") })
Step 4 "Creating the '$CommandName' command"
$shimDir = Join-Path $env:APPDATA 'npm'
New-Item -ItemType Directory -Force -Path $shimDir -ErrorAction Stop | Out-Null
if ($Aliases -contains 'quantus') {
  # The old separate quantus CLI (npm install -g) owns quantus / quantus.cmd / quantus.ps1, and PowerShell would run
  # its .ps1 before our .cmd. Its global install goes; its folder on disk is left alone (reinstall: npm i -g <folder>).
  $oldQuantus = npm ls -g --depth=0 quantus-cli 2>$null | Out-String
  if ($oldQuantus -match 'quantus-cli@') {
    npm uninstall -g quantus-cli --loglevel=error | Out-Null
    Ok 'Removed the old separate quantus install (quantus now runs quantess)'
  }
}
function Write-Shim($name, $script) {
  $target = Join-Path $InstallDir $script
  Set-Content -Path (Join-Path $shimDir "$name.cmd") -Value "@node `"$target`" %*" -Encoding ASCII -ErrorAction Stop
  # Git Bash finds the file with no extension
  $unix = $target -replace '\\', '/'
  Set-Content -Path (Join-Path $shimDir $name) -Value "#!/bin/sh`nexec node `"$unix`" `"`$@`"" -Encoding ASCII -NoNewline -ErrorAction Stop
}
Write-Shim $CommandName 'src\cli.js'
foreach ($alias in $Aliases) { Write-Shim $alias "bin\$alias.js" }
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($userPath -split ';') -contains $shimDir)) {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$shimDir", 'User')
  Ok "Added $shimDir to your PATH (new windows will see it)"
}
if (-not (($env:Path -split ';') -contains $shimDir)) { $env:Path = "$env:Path;$shimDir" }
$cli = Join-Path $InstallDir 'src\cli.js'
if ($Aliases.Count) { Ok "$CommandName -> $cli   (also: $($Aliases -join ', '))" } else { Ok "$CommandName -> $cli" }

$key = [Environment]::GetEnvironmentVariable('OPENROUTER_API_KEY', 'User')
if (-not $key) { $key = $env:OPENROUTER_API_KEY }
$planChosen = ([Environment]::GetEnvironmentVariable('QUANTESS_HOSTED', 'User') -eq '1') -or ($env:QUANTESS_HOSTED -eq '1')

Step 5 'Who pays for the calls'
$useOwnKey = [bool]$OwnKey
if (-not $OwnKey -and $key -and -not $planChosen) {
  # An OpenRouter key already on this PC (maybe for another tool): never spend on it without a yes
  Write-Host '  There is an OpenRouter key on this PC. quantess can use it (your OpenRouter account pays),' -ForegroundColor Cyan
  Write-Host '  or your QUAN-TESS AI plan.' -ForegroundColor Cyan
  $answer = 'y'
  try {
    $answer = Read-Host '  Use your own OpenRouter key? Type y for yes, or just press Enter to use your plan'
  } catch {
    Note 'No way to ask here: keeping your own key, as before.'
  }
  $useOwnKey = $answer -match '^\s*y(es)?\s*$'
  if (-not $useOwnKey) {
    [Environment]::SetEnvironmentVariable('QUANTESS_HOSTED', '1', 'User')
    $env:QUANTESS_HOSTED = '1'
    Ok 'quantess will use your QUAN-TESS AI plan, even with the key on this PC (QUANTESS_HOSTED=1 saved)'
  }
}

if ($useOwnKey) {
  Write-Host '  Checking your OpenRouter key' -ForegroundColor Cyan
  function Test-Key($key) {
    if (-not $key -or -not $key.StartsWith('sk-or-')) { return $false }
    try {
      $env:OPENROUTER_API_KEY = $key
      $testOut = & node $cli --no-learn 'Reply with just the word OK. Do not use tools.' 2>&1 | Out-String
      return $testOut -match 'Task completed'
    } catch {
      return $false
    }
  }
  function Read-Key($prompt) {
    try {
      $secure = Read-Host $prompt -AsSecureString
      return [System.Net.NetworkCredential]::new('', $secure).Password
    } catch {
      Fail 'No key and no way to ask for one here.' 'Run the installer in a normal PowerShell window.'
    }
  }
  if ($key) {
    Write-Host '  Found a saved key, testing it (one tiny paid call, about $0.0001)...' -ForegroundColor Cyan
    if (-not (Test-Key $key)) {
      Write-Host '  The saved key is invalid or expired.' -ForegroundColor Yellow
      $key = $null
    } else {
      Ok 'Key found and working'
    }
  }
  if (-not $key) {
    Write-Host '  Make a key at https://openrouter.ai/keys (name it quantess).' -ForegroundColor Yellow
    do {
      $candidate = Read-Key '  Paste the key here (it stays hidden)'
      if (-not $candidate.StartsWith('sk-or-')) {
        Write-Host '  That does not look like an OpenRouter key (it starts with sk-or-).' -ForegroundColor Yellow
        continue
      }
      Write-Host '  Testing the key (one tiny paid call)...' -ForegroundColor Cyan
      if (Test-Key $candidate) { $key = $candidate } else { Write-Host '  That key did not work. Get a fresh one from openrouter.ai/keys.' -ForegroundColor Yellow }
    } while (-not $key)
    [Environment]::SetEnvironmentVariable('OPENROUTER_API_KEY', $key, 'User')
    Ok 'Key saved and working'
  }
  $env:OPENROUTER_API_KEY = $key
  Note 'quantess stops paid models at $5 a day by itself, but anything with a shell can work around rules written inside it.'
  Note 'The one HARD wall: set a credit limit on this key at https://openrouter.ai/keys (Edit key -> Credit limit).'
  Step 6 'Done checking: your key answered'
  Ok 'quantess runs on your own OpenRouter key'
} else {
  # Already signed in (a re-run): signing in again would make a second terminal key and leave the first one live
  & node $cli whoami 2>&1 | Out-Null
  $signedIn = ($LASTEXITCODE -eq 0)
  if ($signedIn) {
    Ok 'This terminal is already signed in to your QUAN-TESS AI plan'
  } else {
    Write-Host '  Signing this terminal in to your QUAN-TESS AI plan.' -ForegroundColor Cyan
    Write-Host '  A code shows below. Open the page it names, sign in to QUAN-TESS AI, and approve the code.' -ForegroundColor Cyan
    Write-Host '  Calls need a paid plan (Creator, Pro or Studio). Nothing is charged for signing in.' -ForegroundColor Gray
    & node $cli login
    $signedIn = ($LASTEXITCODE -eq 0)
    if (-not $signedIn) {
      Note 'Not signed in yet. Open a PowerShell window and run:  quantess login'
    }
  }
  Step 6 'Checking the sign-in (free, no model call)'
  if ($signedIn) {
    & node $cli whoami
    if ($LASTEXITCODE -eq 0) { Ok 'Signed in' } else { Note 'The site could not confirm the sign-in. Run  quantess whoami  in a new window.' }
  } else {
    Note 'Skipped: sign in first (quantess login), then check with  quantess whoami'
  }
}

Write-Host "`nDONE. Open a NEW window and type:  $CommandName" -ForegroundColor Green
Write-Host '  quantess --doctor     checks everything this PC can do (it opens Chrome once)' -ForegroundColor Gray
Write-Host '  quantess --teach      explains every step so you learn it' -ForegroundColor Gray
Write-Host '  quantess --ask        asks before every change it makes' -ForegroundColor Gray
