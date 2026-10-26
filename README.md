# QUANTESS

**One command in your terminal that reads, builds, runs, researches and remembers.**
Spelled QUAN-TESS, said "Quantus". From [QUAN-TESS AI](https://quantus-ai.onrender.com).

You type what you want ("build me a landing page", "why does this test fail", "research the best way to ...") and
quantess works step by step in the folder you started it in: it reads your files, writes code, runs commands, looks
at the pages it builds, searches the web, and shows you every step as it goes.

## What you need

- **Windows 10 or 11**, with PowerShell or Git Bash
- **Git** and **Node.js 20+** (the installer tells you how to get them if they are missing)
- **A paid QUAN-TESS AI plan** (Creator, Pro or Studio) at [quantus-ai.onrender.com](https://quantus-ai.onrender.com).
  Installing is free; making calls needs the plan.

## Install (one line)

Paste this into **PowerShell** or **Git Bash** and press Enter:

```
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/respectfulnrespected59-source/quantess/main/install.ps1 | iex"
```

The installer checks Git and Node.js, downloads quantess to `~/quantess`, creates the `quantess` command, and signs
this terminal in to your plan: **a code shows**. Open the page it names, sign in to QUAN-TESS AI, and approve the
code. When it says **DONE**, open a new terminal window.

Prefer to look first? Clone the repo and run the same installer from it:

```
git clone https://github.com/respectfulnrespected59-source/quantess.git
powershell -ExecutionPolicy Bypass -File quantess/install.ps1
```

### Git Bash: sign in once from PowerShell

Git Bash does not give quantess a real terminal, and signing in needs one (so a script can never sign you in).
Run `quantess login` once from **PowerShell**, or in Git Bash run `winpty quantess.cmd login`. After that, quantess
works from Git Bash too: the sign-in is shared.

## Use it

| Type this | What happens |
|-----------|--------------|
| `quantess` | Start a session: ask for anything, it works step by step |
| `quantess "fix the failing test"` | Run one task, then keep the session open |
| `quantess --ask` | Ask you before every file change and every command |
| `quantess --teach` | Explain each step as it works, so you learn it |
| `quantess --continue` | Pick up your last session |
| `quantess whoami` | Who this terminal is signed in as, and the plan |
| `quantess --doctor` | Check everything this PC can do |
| `quantess logout` | Forget the sign-in on this PC |
| `quantess --help` | The full list |

Inside a session, type `/help` for the session commands.

## What it costs

- **Signed in (`quantess login`):** your QUAN-TESS AI plan pays for every model call, and the site sets a daily limit.
  The free plan cannot make terminal calls.
- **Your own OpenRouter key instead:** after installing, run
  `powershell -ExecutionPolicy Bypass -File $HOME/quantess/install.ps1 -OwnKey` (PowerShell or Git Bash) and paste
  your key when it asks.
  Paid models up to $5 a day, then free models. Set a credit limit on the key at
  [openrouter.ai/keys](https://openrouter.ai/keys) as well. (If an OpenRouter key is already on your PC, the installer
  asks which one pays; nothing is spent on a key without your yes.)

## What it will and won't do

- It works in the folder you start it in.
- It **asks you yes / no** before it pushes or merges with git, clicks any button that costs money, opens a website
  it has not opened before, or keeps a memory after reading outside text. With `--ask`, before every change too.
- **It never types your passwords.** You sign in to websites yourself (`quantess --signin`).
- **Your terminal key stays hidden.** It lives in `~/.quantess/terminal-key.json`, locked to your Windows user, is only
  ever shown masked (`qtk_…ab12`), and the agent is blocked from reading it. Revoke a terminal any time at
  [quantus-ai.onrender.com/cli/activate](https://quantus-ai.onrender.com/cli/activate).
- It never stops a program it did not start.

## What leaves your PC

- Your tasks, and the files and command output quantess reads to do them, go to the AI model: through the QUAN-TESS
  AI site when you are signed in, or straight to OpenRouter with your own key.
- If you use Claude Code, quantess uses the same library: it lists your Claude Code skills (names only) to the model
  each session, and reads a skill, rule or memory note from `~/.claude` in full when a task calls for it.
- Its own memory, sessions and settings stay in `~/.quantess` on your PC.

## Uninstall

1. `quantess logout`, then revoke the terminal at [quantus-ai.onrender.com/cli/activate](https://quantus-ai.onrender.com/cli/activate).
2. Delete the `~/quantess` and `~/.quantess` folders, and the `quantess` and `quantess.cmd` files in `%APPDATA%\npm`.

## License

[Apache-2.0](LICENSE). Copyright 2026 Quantum Melanin Media.
