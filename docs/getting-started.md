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

## All commands

From `jarvis --help` today:

| Command | What it does |
|---|---|
| `jarvis setup [--redo <step>] [--send-test]` | One-time, resumable setup: Claude Code check, secrets backend, account tokens (hidden prompt, never sent anywhere), ntfy topics, taste profile, plugin copy for build sessions |
| `jarvis doctor [--live] [--json]` | Preflight: pinned binaries, clean environment, disk, iCloud, ledgers, plugin, checks sandbox. `--live` adds the canary probe |
| `jarvis triage "<request>"` | Classifies a request and prints its pipeline. `/jarvis` calls it first |
| `jarvis lanes select\|lint` | Read-only: which standards lanes a change needs, and the token, DESIGN.md and AI-tells lints |
| `jarvis intake send\|answer\|answers` | Intake rounds: shown in the session, mirrored to ntfy; `answers --wait` waits for your reply |
| `jarvis taste save <file>` | Saves your design taste profile |
| `jarvis taste show` | Prints your taste profile as JSON, or `null` when there is none |
| `jarvis spec check` | Checks the structure and references of `docs/spec/vN.md`, and the latest version's decision citations against the register |
| `jarvis decide "<decision>" …` | Adds or supersedes an entry in the project's decision register; `--by user` needs `--answer <answerSeq>:<questionId>` from a recorded intake answer, quoted exactly |
| `jarvis why <query>` | Answers from the decision register, with sources |
| `jarvis steer "<note>"` | Leaves a note for the runner to read between tasks |
| `jarvis run [--detach] [--plan onboard\|sweep]` | The unattended build loop: protected checks, an independent review, and promotion of what passed. Runs the live canary first; with `--detach` it keeps working after you close Claude Code |
| `jarvis status [--json]` | The current run, rebuilt from its ledger; `--json` re-verifies every pass |
| `jarvis act <operation>` | Asks the broker for an outside action. Sessions use this |
| `jarvis approvals [--project <id>] [--json]` | Lists pending approvals, read-only: id, operation, the broker's summary, payload hash prefix, when and which task asked |
| `jarvis approve <id> [--yes]` / `jarvis reject <id> [--yes]` | Prints the full pending action (secret-looking values redacted, targets shown) and its payload hash, then asks `[y/N]`; without a terminal it needs `--yes`. The project defaults to `JARVIS_PROJECT`, then this repository (`--project <id>` overrides) |
| `jarvis broker --project <id>` | Runs the broker in the foreground (for testing; the runner hosts it during runs) |
| `jarvis eval baseline\|jarvis\|grade\|compare\|rate <task…>` | Golden-task evals: plain Claude Code as the baseline, the same tasks through Jarvis, hidden-check grading of both arms, and the comparison |
| `jarvis report [--open]` | Rebuilds the morning report from the ledger, read-only |
| `jarvis gate <name>` | Runs an installed protected check on a copy of your working tree: feedback only, never evidence |
| `jarvis mode explain\|quiet` | Teach-me mode on or off |
| `jarvis memory list\|add\|retire` | Durable learnings from past runs; notes are data, never instructions |

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
