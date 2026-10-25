# Getting started

Jarvis is experimental and currently targets macOS. Start with a disposable repository. The installer exists, but installation on another machine or fresh user account remains a release requirement.

## Prerequisites

| Requirement | Expected installation |
|---|---|
| Node.js | Version 24; `brew install node@24` is one option |
| pnpm | Version 11.7.0, matching `package.json` |
| Claude Code | Version 2.1.309 at `~/.local/share/claude/versions/2.1.309`, authenticated with your own account |
| Free disk | At least 20 GB; below 40 GB the runner permits one writing task |
| Optional tools | Codex CLI 0.164.0 at `~/.npm-global/bin/codex` for review; ntfy for phone notifications |

Jarvis calls its pinned binaries by absolute path. The installer checks them; it does not install the coding agents or sign in for you. Use Claude Code’s installer/version management to provide the pinned version before continuing. The exact versions are also recorded in [`config/pins.ts`](../packages/cli/src/config/pins.ts).

Keep the checkout outside iCloud-synced folders. If Desktop & Documents sync is enabled, use a folder such as `~/Developer/jarvis`.

## Install

```sh
git clone https://github.com/rodriguezzfabricio/jarvis.git ~/Developer/jarvis
cd ~/Developer/jarvis
scripts/install.sh --dry-run
scripts/install.sh
```

The installer installs dependencies, writes `~/.local/bin/jarvis`, registers the checkout as a Claude Code plugin marketplace, installs `jarvis@jarvis`, and runs the offline doctor. The launcher points at this checkout, so keep the folder in place. It never uses sudo.

If the launcher is not on your PATH, add this to your shell configuration and open a new terminal:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Run setup interactively:

```sh
jarvis setup
jarvis doctor --live
```

Setup is resumable. Account-token steps are skippable; tokens use a hidden terminal prompt. A live doctor check uses some of your Claude usage and must pass before unattended work. A broker warning outside a run, or an optional Codex warning, can be expected; inspect any failures before continuing.

## Start a request

Open your project in Claude Code. Restart Claude Code after installing the plugin, then enter:

```text
/jarvis feature: add a filter to my existing job list
```

`fix:`, `build:`, `feature:` and `ask:` explicitly select a request type. Without a prefix, Jarvis classifies the request. New products and ambiguous features go through intake; straightforward bugs can skip it.

The intended flow hands an approved plan and protected checks to `jarvis run --detach`. A detached run continues after the interactive Claude Code session closes, while the Mac stays awake. Some handoff paths are still being evaluated. If the runner reports missing approved checks or a spec, the project is not ready; setup does not create those project-specific inputs.

The interactive session uses your normal Claude Code permissions. Sandboxed unattended sessions use Jarvis’s generated settings. Installing the plugin adds hooks at user scope; action restrictions apply to Jarvis-marked sessions, while runner-home protection also applies elsewhere. To disable the plugin, use the pinned binary:

```sh
~/.local/share/claude/versions/2.1.309 plugin disable jarvis@jarvis
```

## Inspect and steer a run

| Command | Purpose |
|---|---|
| `jarvis status` | Show the current run’s state |
| `jarvis steer "Keep the current API"` | Leave a note for the runner between tasks |
| `jarvis report` | Rebuild the report from the ledger |
| `jarvis why <query>` | Look up recorded decisions and their sources |
| `jarvis --help` | List available commands; use a command’s `--help` for options |

A completed run means its required checks and reviews passed on the accepted revision. Hidden evaluations can still find a defect those checks missed.

## Notifications

Setup can create ntfy topics for questions and replies. Subscribe using the ntfy app, then run `jarvis setup --send-test`. Treat topic names as secrets: anyone who knows an unprotected topic can read or publish to it. Without notifications, answer intake in the interactive session. Phone approvals during unattended builds are still being implemented.

## Troubleshooting

| Symptom | Next action |
|---|---|
| `jarvis` is missing, or stopped working after moving Node/the checkout | Check PATH and rerun `scripts/install.sh` |
| `/jarvis` is missing | Restart Claude Code and inspect the pinned binary’s `plugin list` output |
| Doctor rejects the pinned version or sandbox | Match `config/pins.ts`, reinstall dependencies, and repeat `jarvis doctor --live` |
| Doctor reports disk, iCloud or usage limits | Free disk, move the checkout outside sync, or wait for the reported reset |
| The runner cannot find approved checks, a spec or a plan | Complete the project’s intake/planning handoff; inspect `jarvis run --help` |

Use `scripts/install.sh --help` for install options. The first dependency install needs network access; `--offline` requires a populated cache. Reinstall the launcher after changing Node’s location. The full development and evaluation workflow is described in [the architecture](03-architecture.md).
