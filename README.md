# Jarvis

Jarvis is a thin layer around Claude Code. You describe what you want once. Jarvis researches the options, asks one round of questions (each with a recommended default), writes a spec, and then builds on its own for hours, in fresh sessions, inside Claude Code's sandbox. It calls something "done" only when checks it runs itself pass on the committed code, never because the model says so.

It has two parts:

- **The Jarvis plugin for Claude Code**: the `/jarvis` command, skills and safety hooks. This is what you talk to.
- **The `jarvis` CLI**: a TypeScript program that runs the checks, keeps the ledger, holds credentials in a broker, and later drives the unattended build loop.

Status: a work in progress, built stage by stage (`docs/03-architecture.md` §8). Triage, intake, specs, the decision register, the ledger, the broker and the protected checks work today. The unattended runner (`jarvis run`) and `jarvis setup` are still coming. Commands that don't exist yet are marked "coming" below.

## Requirements

- **macOS.** v1 runs on macOS only.
- **Node 24** (`node --version` prints `v24.x`). For example: `brew install node@24`.
- **pnpm**, through corepack, which comes with Node: `corepack enable pnpm`.
- **Claude Code 2.1.309**, at exactly `~/.local/share/claude/versions/2.1.309`. Jarvis calls this file by its absolute path and never uses whatever `claude` is on your `PATH`. Install Claude Code with Anthropic's native installer if you don't have it yet, then run `claude install 2.1.309`. This may also switch your everyday `claude` to that version. Sign in with your own Claude account: Jarvis never shares a login.
- **codex-cli 0.164.0** (optional), at `~/.npm-global/bin/codex`. Codex reviews Jarvis's work; without it, a Claude reviewer takes over. To install: `npm config set prefix ~/.npm-global`, then `npm install -g @openai/codex@0.164.0`, then `codex login`.
- **The ntfy app** on your phone ([ntfy.sh](https://ntfy.sh)), so Jarvis can send you questions and approval requests while you're away. Install it yourself; nothing checks for it.
- About **20 GB of free disk**. Below that, `jarvis doctor` refuses unattended runs.

The installer checks macOS, Node, pnpm and the two pinned binaries, and `jarvis doctor` checks disk space. It never installs Claude Code or Codex for you and never touches their logins. The phone app is the one prerequisite nothing checks.

## Install

Clone the repo somewhere that iCloud doesn't sync (not inside Desktop or Documents if "Desktop & Documents" sync is on):

```sh
git clone <this repo> ~/Developer/jarvis
cd ~/Developer/jarvis
scripts/install.sh --dry-run   # shows what it would do, changes nothing
scripts/install.sh
```

The installer:

1. checks macOS, Node 24, pnpm, and the pinned Claude Code and Codex;
2. runs `pnpm install --frozen-lockfile`;
3. writes a small `jarvis` launcher to `~/.local/bin/jarvis` (use `--prefix DIR` for `DIR/bin`). It points at this checkout, so keep the checkout where it is;
4. adds this checkout as a Claude Code plugin marketplace and installs the `jarvis@jarvis` plugin for your user, using the pinned Claude Code with a clean environment;
5. runs `jarvis doctor`.

It is safe to run again: steps that are already done are skipped. It never uses `sudo`. Other options: `--offline`, `--no-plugin`, `--no-doctor`, `--node PATH`. Run `scripts/install.sh --help` for details.

If `~/.local/bin` isn't on your `PATH`, the installer tells you. Add `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc` and open a new terminal.

## First run

1. **Set up** (coming): `jarvis setup` will create your ntfy topics, accounts and taste profile. Until it exists, set up notifications by hand:

   ```sh
   mkdir -p ~/.jarvis
   node -e 'const t = "jarvis-" + require("crypto").randomBytes(12).toString("hex"); console.log(JSON.stringify({ baseUrl: "https://ntfy.sh", topic: t, replyTopic: t + "-reply" }, null, 2))' > ~/.jarvis/notify.json
   chmod 600 ~/.jarvis/notify.json
   cat ~/.jarvis/notify.json
   ```

   Subscribe to both topics in the ntfy app. Anyone who knows a topic name can read it or post to it, so treat the names like passwords. Without this file, intake still works; you just answer in the session.

2. **Check everything**, including the live probe:

   ```sh
   jarvis doctor --live
   ```

   `--live` starts the pinned Claude Code once with Jarvis's generated settings and checks that the sandbox and the other safety settings really took effect. It uses a little of your plan's usage. Every line should say `ok`, apart from `broker` (it runs only during a run) and `codex_pinned` if you skipped Codex. Jarvis won't run anything unattended until the live probe passes.

3. **Use it.** Open a project in Claude Code (the CLI or the desktop app) and type:

   ```
   /jarvis build: a habit tracker for my phone
   ```

   `/jarvis` sorts the request first (new product, feature, bug, refactor, question, review or release), and only the steps that type needs run. A first word with a colon (`fix:`, `build:`, `feature:`, `ask:`) forces the type. Without the colon, the word is read as ordinary text.

## How it stays safe

Jarvis lets the agent work without asking permission for every step, so the safety comes from structure, not from the model behaving well:

- **The sandbox.** Every build session runs the pinned Claude Code inside its sandbox, in its own git worktree. It can write only to that worktree and can read almost nothing outside it. The network is closed apart from a short allowlist (package registries, docs, localhost, the preview host).
- **The broker.** Sessions hold no credentials. Anything that leaves your Mac (sending email, deploying, pushing to a protected branch, spending money, deleting data) is a request to the broker. The broker checks your approval, does exactly that one operation with a credential the session can't see, and writes a receipt. Spending money always needs your approval.
- **Protected checks.** The acceptance tests are written from the spec and locked by hash in `~/.jarvis/`, outside anything a session can touch. After each session the runner runs them on a fresh copy of the committed revision and records the results in a hash-chained ledger. Editing a check, or the evidence, is detected.
- **Tripwires.** The plugin's hooks catch obvious mistakes early by matching recognizable command forms (a `git push --force`, an `npm publish`, a `--prod` deploy flag, a Keychain read). A command written another way can slip past them. They are a warning layer. The walls are the sandbox and the broker.

Six requirements hold for every build session. Each has a test, and `jarvis doctor --live` checks them on the real binary:

1. The sandbox must be available, or the session doesn't start. Commands can't opt out of it.
2. Claude Code runs in restricted mode with an explicit tool list, so your own settings, project hooks and plugins don't load.
3. There are no permission prompts (anything not allowed is refused), only Jarvis's own MCP servers are allowed, and the transcript isn't saved to your history.
4. Claude Code's auto-memory is off.
5. Reads outside the worktree are blocked, apart from a private toolchain cache.
6. The live canary probe passes before any unattended run.

Your interactive Claude Code sessions are different: they run with your normal Claude Code permissions. Jarvis adds no credentials to them.

**What the plugin changes in your everyday Claude Code.** The plugin is installed for your user, so its tripwire runs in every Claude Code session you open, in any project. In those sessions the tripwire stops Claude's commands that look like a `git push`, a package publish or a `--prod` deploy, and its tool calls on `~/.jarvis` paths. It matches the usual ways of writing these, not every possible one. Your own terminal is unaffected. To turn the plugin off: `~/.local/share/claude/versions/2.1.309 plugin disable jarvis@jarvis`.

## Commands

From `jarvis --help` today:

| Command | What it does |
|---|---|
| `jarvis doctor [--live] [--json]` | Preflight: pinned binaries, clean environment, disk, iCloud, ledgers, plugin, checks sandbox. `--live` adds the canary probe |
| `jarvis triage "<request>"` | Classifies a request and prints its pipeline. `/jarvis` calls it first |
| `jarvis lanes select\|lint` | Read-only: which standards lanes a change needs, and the token, DESIGN.md and AI-tells lints (decisions 45, 53) |
| `jarvis intake send\|answer\|answers` | Intake rounds: shown in the session, mirrored to ntfy; `answers --wait` waits for your reply |
| `jarvis taste save <file>` | Saves your design taste profile |
| `jarvis spec check` | Checks the structure and references of `docs/spec/vN.md` |
| `jarvis decide "<decision>" …` | Adds or supersedes an entry in the project's decision register |
| `jarvis why <query>` | Answers from the decision register, with sources |
| `jarvis steer "<note>"` | Leaves a note for the runner to read between tasks |
| `jarvis status` | The current run, rebuilt from its ledger |
| `jarvis act <operation>` | Asks the broker for an outside action. Sessions use this |
| `jarvis approve <id> --project <id>` / `jarvis reject <id> --project <id>` | Answers a pending approval from the terminal |
| `jarvis broker --project <id>` | Runs the broker in the foreground (for testing; the runner hosts it during runs) |
| `jarvis eval baseline <tasks…>` | Runs plain Claude Code on golden tasks, as the baseline Jarvis must beat |

Coming:

| Command | What it will do |
|---|---|
| `jarvis setup` | One-time setup: accounts, secrets, ntfy topics, taste profile |
| `jarvis run [--detach]` | The unattended build loop. It keeps working after you close Claude Code |
| `jarvis report [--open]` | The morning report |
| `jarvis gate <name>` | Runs a protected check by hand (feedback only, never evidence) |
| `jarvis mode explain\|quiet` | Teach-me mode on or off |
| `jarvis eval <task>` | Golden task with Jarvis and with the baseline, side by side |

## Troubleshooting

Start with `jarvis doctor`. Each line is `ok`, `warn` or `FAIL`, and any `FAIL` blocks unattended runs.

- **`jarvis: command not found`.** `~/.local/bin` (or your `--prefix`) isn't on your `PATH`. See [Install](#install).
- **`Jarvis needs Node 24`.** Install Node 24, or pass `--node /path/to/node` to the installer.
- **`jarvis` stops working after you upgrade, move or uninstall Node.** The launcher calls the exact Node path it was installed with (for example `/opt/homebrew/bin/node`). Run `scripts/install.sh` again after any Node change; it rewrites the launcher.
- **pnpm asks to download itself.** That's corepack fetching the pnpm version this repo pins. Answer yes, or run `corepack enable pnpm` first.
- **The install needs the network the first time, even with `--offline`.** pnpm 11 checks the lockfile against the registry's supply-chain policies (release age, trust) before installing, and on a machine that has never installed Jarvis it has no cached result, so `--offline` stalls or fails there. Run the first install online. `--offline` only works once the pnpm store and that check's cache already hold everything.
- **`FAIL claude_pinned`.** The file `~/.local/share/claude/versions/2.1.309` is missing or reports another version. Run `claude install 2.1.309`, then run the installer again so it can install the plugin.
- **`warn codex_pinned`.** Codex is missing or a different version. That's fine; a Claude reviewer takes over.
- **`FAIL child_env_clean`, or `warn parent_env`.** Your shell sets something like `ANTHROPIC_API_KEY`, `CLAUDE_CODE_USE_*`, a `*_BASE_URL` or `CLAUDE_CONFIG_DIR`. Jarvis keeps these out of build sessions, because they could send work to another provider or bill an API key instead of your plan. Remove them from your shell startup files if doctor fails.
- **`FAIL disk_free`.** Under 20 GB free. Under 40 GB, Jarvis runs one build task at a time.
- **`FAIL icloud_sync`.** The checkout is inside a folder iCloud syncs. Move it (for example to `~/Developer/jarvis`) and run the installer again.
- **`FAIL checks_sandbox`.** Anthropic's sandbox runtime didn't hold in its self-test. Run `pnpm install --frozen-lockfile` again in the checkout.
- **`FAIL canary_probe`.** The generated settings didn't take effect on the pinned Claude Code. Check that you're on exactly 2.1.309. If the probe hit a usage limit, doctor says so; try again after the reset.
- **`warn broker`.** Normal. The broker runs only while a run is active.
- **"a Claude Code marketplace named 'jarvis' already points at …".** You installed from another checkout before. Remove it with `~/.local/share/claude/versions/2.1.309 plugin marketplace remove jarvis`, then run the installer again.
- **`/jarvis` doesn't show up in Claude Code.** Restart Claude Code after installing. Check with `~/.local/share/claude/versions/2.1.309 plugin list`: `jarvis@jarvis` should be listed and enabled.
- **After `git pull`, Claude Code still uses the old plugin.** Run `~/.local/share/claude/versions/2.1.309 plugin update jarvis@jarvis` and restart Claude Code.

## More

- `docs/00-brief.md`: what Jarvis is for.
- `docs/01-decisions.md`: every decision and why.
- `docs/03-architecture.md`: how it's built.
- `AGENTS.md`: how to work on Jarvis itself.

## License

MIT (see `LICENSE`), as accepted in the decision register's answered questions (Oct 23). Pieces borrowed from other projects keep their own licenses and credits (`skills/CREDITS.md`).
