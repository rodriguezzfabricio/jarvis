# Jarvis: Architecture (v1)

Oct 23, 2026 · Fabricio + Claude

How Jarvis itself is built. It turns `docs/01-decisions.md` (the what and why) into components, files, formats and a build order. v1 runs on Claude Code (CLI and desktop app) on macOS. The design keeps the Codex and DSH phases cheap: every component that touches the harness sits behind one adapter.

Wherever a piece depends on a Claude Code feature, this doc names the feature, and stage 0 verifies the exact flag or setting name against the pinned version. All *(verify)* items were resolved in stage 0 on Claude Code 2.1.309 (`docs/stage0-findings.md`, decisions 57–66).

---

## 1. The big picture

```
 you ──/jarvis "idea"──►  ┌──────────────────────── Claude Code (interactive: CLI or desktop) ────────────────────────┐
                          │  Jarvis plugin: /jarvis command · skills · subagent roles · hooks                        │
                          │  1. triage  2. research  3. intake (questions + mockups)  4. spec  5. hand off            │
                          └───────────────┬──────────────────────────────────────────────────────────────────────────┘
                                          │ jarvis run --detach
                                          ▼
 ┌─────────────────────────────── jarvis runner (plain Node process, outside any sandbox) ───────────────────────────┐
 │  task loop ─► fresh `claude -p` per task (in a worktree, inside Claude Code's sandbox, explicit config)            │
 │      │            └─ agent edits code, runs tests, may call `jarvis act …` (client) ─┐                            │
 │      ├─ after session: protected checks on the committed revision → evidence      │                            │
 │      ├─ reviewer session(s) → verdict (runner records it)                          ▼                            │
 │      ├─ ledger (append-only, hash-chained) ◄──────────────── broker (holds credentials, checks approvals,       │
 │      ├─ notifier (ntfy / email) ◄─► your phone                  executes the exact operation, writes receipt)   │
 │      └─ morning report                                                                                          │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
   ~/.jarvis/            runner-owned, denied to sessions: ledger, evidence, protected checks, secrets, memory, run/
   ~/.jarvis-work/       worktrees and eval workspaces (decision 67)
   <repo>/               agent-editable: code, AGENTS.md, docs/ (spec, decisions, PRODUCT.md, DESIGN.md), .jarvis/ views
```

**Two programs, one plugin:**
- **The Jarvis plugin for Claude Code.** It holds the `/jarvis` command, the skills, the subagent role definitions and the hooks. It's what you talk to.
- **The `jarvis` CLI.** A TypeScript program, with `jarvis run` and `jarvis act` among its commands. It's what keeps working when you leave.

The broker and notifier are parts of the CLI that run only while a run is active. Nothing runs in the background when Jarvis is idle.

## 2. Every request starts with triage, so a bug fix never triggers the design workflow

The first thing `/jarvis` does is classify the request. That classification picks the pipeline, and a pipeline only runs its own steps.

| Type | Typical tier | Steps that run | Steps that never run |
|---|---|---|---|
| **New product** | 2 | research (product + build-vs-buy) → intake with mockups → spec → design → architecture → build loop → all relevant lanes → preview deploy → report | — |
| **Feature** | 1–2 | decision-register check → spike if needed → intake (no mockups if a `DESIGN.md` exists) → spec → build loop → lanes the change touches → report | Mockups and design direction, unless the feature needs a new kind of screen and no design system exists |
| **Bug** | 0–1 | reproduce → failing test → fix → checks → lanes the change touches → report | Intake, mockups, design stage, architecture |
| **Refactor** | 1 | pin current behavior with tests → small steps → same tests pass → architecture lane | Intake, design |
| **Question / onboarding** | — | read-only research → answer with file citations → decision archaeology (for onboarding) | Any edit |
| **Release / ops** | — | release manifest → rehearsals → broker-gated deploy → smoke test | Building |
| **Sweep** (scheduled) | 0–1 | cleanup, docs, dependency report, memory prune | Intake, design |

**How triage decides:**
- **Signals code can read:** whether the folder is empty (new product); whether an issue, error or stack trace is attached; whether the request says "fix", "broken", "doesn't" (bug); which files the change will likely touch (from a quick search); whether `DESIGN.md` exists.
- **The model's judgment** on the request text.
- **Your override, which always wins:** `/jarvis fix …`, `/jarvis build …`, `/jarvis feature …`, `/jarvis ask …`.
- **Upgrades are announced, never silent.** If a "bug" turns out to need product decisions (the right behavior was never specified), triage upgrades the tier and says so in its first message: "This looks like missing behavior, not a bug. Treating it as a small feature: 2 questions."

**Lanes run only on what a change touches.** A bug fix in a Go handler runs the tests plus the security and API lanes, and no UI checks. A bug fix on a misaligned button runs the UI checks on that one screen: the AI-tells scan, token lint, accessibility and an interaction test. It never asks about direction or makes mockups.

## 3. Components

### 3.1 The Jarvis plugin (Claude Code)
It installs once, globally, and every project gets it. It contains:

| Part | Contents |
|---|---|
| Command | `/jarvis` (dispatches to triage) |
| Skills | `research`, `intake`, `spec`, `design`, `architect`, `build`, `debug`, `review`, `security`, `qa`, `ship`, `onboard`, `compound`, `sweep` (decision 30) |
| Subagent roles | `explorer` (fast model, read-only), `researcher` (read-only, web, no write tools), `reviewer` (strong model, read-only repo), `security-reviewer`, `design-reviewer`, `spec-reader` (fresh-context spec check) |
| Hooks | `SessionStart` (inject the run header and memory index), `PreToolUse` (denylist tripwires, protected-path guard), `Stop` (run `jarvis gate quick` and block on failure, with its own retry counter; this is fast feedback for the agent and never counts as evidence) |
| Output style | `jarvis-explain` (teach-me mode, decision 32) |

Skills follow the portable Agent Skills format: name and description frontmatter only, under 500 lines and 20 KB. They're written once in `skills/` in the Jarvis repo and linked into the plugin, which is what makes the later Codex and DSH adapters cheap.

The desktop app reads the same plugin, settings and hooks as the CLI; this is checked in stage 0.

### 3.2 The `jarvis` CLI
TypeScript in strict mode on Node 24, built with pnpm and tested with Vitest. Dependencies are few: commander, zod and yaml. Hashing, child processes and file locks use Node's built-ins. There's no database: state lives in JSONL files with fsync after each write.

| Command | Does |
|---|---|
| `jarvis setup` | One-time: accounts (decision 43), secrets backend, ntfy topics, taste profile, Claude Code version check, installs the plugin |
| `jarvis doctor` | Preflight (decision 46): versions, sandbox, network allowlist, protected paths, broker reachable, iCloud check, memory-based concurrency, plugin loaded in CLI and desktop |
| `jarvis run [--detach]` | The runner: works through the plan, hosts the broker and notifier, writes the report |
| `jarvis steer "…"` | Adds a note to the inbox; the runner reads it between tasks (decision 40) |
| `jarvis status` | Current run state from the ledger |
| `jarvis report [--open]` | Rebuilds and opens the morning report |
| `jarvis why <thing>` | Answers from the decision register, with sources (decision 48) |
| `jarvis act <operation> …` | Client for the broker. The only path to outside actions (decision 12) |
| `jarvis gate <name>` | Runs a protected check (`quick`, `test`, `lint`, `security`, `qa`, `design`, `done`). Only runs the runner launches after a session ends are recorded as evidence; runs from inside a session are feedback only (decision 49) |
| `jarvis approve <id>` / `reject <id>` | Answers a pending approval from the terminal (same as answering through ntfy) |
| `jarvis mode explain\|quiet` | Teach-me mode on or off |
| `jarvis eval <task>` | Runs a golden task on a sanitized snapshot, with Jarvis and with the plain-Claude-Code baseline (decisions 35, 47) |

### 3.3 Triage and intake (interactive, inside Claude Code)
Triage, research, the questions, the mockups and the spec happen in your interactive session:
- **Asking questions:** Claude Code's question tool when you're at the computer; the ntfy notifier when you're away. The 15-minute default timer runs in the runner, which starts in "intake-wait" mode as soon as questions are sent.
- **Handoff:** once the spec is confirmed (or defaulted), the session runs `jarvis run --detach` and tells you it's safe to close Claude Code.

### 3.4 The runner
A detached Node process. It survives closing Claude Code, and its PID lives in `~/.jarvis/projects/<id>/runner.pid`. It starts `caffeinate -i -w <pid>`, so the Mac stays awake exactly as long as the runner lives.

**Loop:**
```
load ledger → rebuild state → clean leftovers of any dead run (worktrees, browsers, child processes)
while there are runnable tasks and the budget allows:
    read the inbox (steer notes, approvals) → replan the affected slice if needed (decision 40)
    pick the next task → write a lease to the ledger → reserve budget
    create a worktree at the task's base revision (in ~/.jarvis-work/worktrees/…, decision 67)
    start a fresh `claude -p` in that worktree (flags in §5), streaming JSON to a log file
        on a usage-limit message → checkpoint, sleep until the reset, resume (not a failure)
    when the session ends: commit whatever is there as a candidate revision
    run the protected checks on a fresh checkout of that revision → evidence entries
    run the reviewer session(s) on the revision → verdict entry
    pass → merge into the run branch, tag "last-green", mark the task done
    fail → repair attempt (max 2) → still failing: mark it blocked; try the next alternative once if it's on the critical path
send notifications at milestones; write REPORT.md; stop the broker; exit
```
- **Concurrency:** 2 writing tasks at once on 16 GB (each in its own worktree), 1 headless browser, and only the Docker services a task's checks need. All are set by `jarvis doctor`.
- **Sessions:** fresh per task, so nothing carries over except the files the next session is given (decision 49).

### 3.5 Ledger and evidence store
Everything here lives in `~/.jarvis/projects/<id>/`, outside the repo. The agent's sandbox can't write there, and permission rules deny the file tools on that path.

| Path | What |
|---|---|
| `ledger.jsonl` | Append-only. Each line has `seq`, `ts`, `kind`, `actor` (runner or broker), `task_id`, `attempt_id`, `data`, `prev_hash` and `hash` (SHA-256 over the previous hash plus this entry) |
| `evidence/<seq>/` | Raw outputs from checks: stdout and stderr logs, JUnit XML, screenshots, axe JSON, detector JSON. The matching ledger entry records the file hashes |
| `checks/` | Protected check definitions: the acceptance tests generated from the spec, test config and gate scripts. `checks.lock` holds the approved hash of each file |
| `head.hash` | The latest ledger hash, also printed in every report |

Ledger entry kinds:
- `task_created`, `lease`, `attempt_started`, `attempt_ended`, `usage_wait`
- `gate_result`, `review_result`, `state_reached` (preview-ready, release-ready, deployed)
- `spec_version`, `decision`, `steer`
- `approval_request`, `approval`, `broker_request`, `broker_receipt` (succeeded, failed or unknown)
- `blocked`, `reconciled`

Inside the repo, `.jarvis/` (gitignored) holds human-readable views rebuilt from the ledger: `plan.md`, `progress.md`, `REPORT.md`, `inbox.md` and `mockups/`. Editing a view changes nothing; only `inbox.md` is read, and only as steer notes.

### 3.6 The broker
The broker is how Jarvis does anything outside the computer without the agent ever holding a credential. It runs inside the runner process: outside the sandbox, only while a run is active. It listens on a Unix socket in `~/.jarvis/run/broker.sock`, and the sandbox allows exactly that one socket through `sandbox.network.allowUnixSockets`, listed by its real path (verified in stage 0; decision 59). `jarvis act` is a thin client that sends a request over the socket.

**Operation catalog** (each one a typed adapter):

| Operation | What it does |
|---|---|
| `email.send` | Sends exactly one message: recipient, subject and body are fixed |
| `deploy.preview` | Allowed without asking |
| `deploy.promote` | Production; allowed if the project's grant exists |
| `git.push_protected` | Force-push or pushes to protected branches |
| `git.create_remote` | Creates a remote |
| `data.delete` | Deletes data |
| `spend` | Any paid action, with an amount |
| `service.add_paid` | Adds a paid service |
| `store.submit` | Submits to an app store |
| `domain.buy` | Buys a domain |

**For each request, the broker:**
1. Checks for a matching approval in the ledger: an exact payload hash, or a standing grant such as "production for this project" from intake.
2. If there is none, it creates an `approval_request`, notifies you, and returns "pending". The task continues with other work or waits.
3. Executes the operation with the credential from the secrets backend.
4. Writes a receipt. When the outcome can't be known (a timeout after sending), the receipt is "unknown" and is never retried automatically (decision 41).

**Secrets backend:** an env file at `~/.jarvis/secrets/<project>.env` (permissions 0600) by default, or the macOS Keychain. The path is in `sandbox.filesystem.denyRead` (blocks shell reads) and in a `Read(//…/**)` permission deny rule (blocks the file tools). Both were verified in stage 0 (decision 59). Stage 1's safety tests prove an agent can't read it.

### 3.7 Notifier
An adapter with `send(message, actions)` and `poll()`. ntfy is the default, with send-only email as an option (decision 50).
- **Topics:** `jarvis-<random-24>` for messages out and `jarvis-<random-24>-reply` for replies.
- **Message kinds:**
  - questions (with "Use defaults"),
  - approval requests (Approve / Reject),
  - blocked,
  - finished (state + one line),
  - usage-wait (only if longer than 2 hours).
- **Replies** come from buttons (`http` actions that post a fixed answer to the reply topic) or from text typed into the app's publish box (read as a steer note). They're parsed into ledger entries (`approval`, `steer`, `defaults`).
- **Limits:** messages stay under about 4 KB; mockup screenshots go as attachments (they expire after 3 hours) or as a path on your Mac.

### 3.8 Memory, decisions and design files
| Where | File | Holds |
|---|---|---|
| Global (`~/.jarvis/memory/`) | `MEMORY.md` + `user/` | Your taste profile and preferences (decision 39) |
| Global (`~/.jarvis/memory/`) | `feedback/` | Corrections that apply everywhere |
| In each repo, committed | `docs/decisions.md` | The decision register (decision 48) |
| In each repo, committed | `docs/spec/vN.md` | The versioned spec (decision 9) |
| In each repo, committed | `PRODUCT.md`, `DESIGN.md` | The design files (decision 51) |
| In each repo, committed | `docs/harness-assumptions.md` | What each piece of scaffolding covers (decision 29) |
| In each repo, committed | `AGENTS.md` | Created if missing, otherwise only a small Jarvis block is added |

The `SessionStart` hook injects only the index lines and the decisions relevant to the task, never whole files.

### 3.9 Routing table
`~/.jarvis/routing.yaml` holds the defaults; a project can override them in `.jarvis-routing.yaml`.

```yaml
tiers:
  strong: { model: claude-opus-5-5,   effort: high }
  fast:   { model: claude-sonnet-5-5, effort: medium }
  cheap:  { model: claude-haiku-5-5,  effort: low }
roles:
  intake:   { tier2: strong, default: fast }
  spec:     { tier2: strong, default: fast }
  architect:{ tier2: strong, default: fast }
  review:   { tier2: strong, default: fast, cross_model: codex }   # codex exec read-only, falls back to strong
  build:    { start: fast, escalate: strong }
  debug:    { start: fast, escalate: strong }
  explore:  { start: cheap }
escalate_on: [gate_fail, review_fail]
```
Full model IDs, never aliases (decision 61). Codex review runs `codex exec` read-only on your ChatGPT plan, isolated as in decision 66; when it hits its limit or isn't installed, the strong Claude reviewer takes over (decision 24).

### 3.10 Evals
`jarvis eval` builds a sanitized snapshot: the files exported into a new single-commit repo with no remotes and empty memory. It applies any planted change, runs the task with Jarvis and then with plain `claude -p` on the same budget, and runs the hidden checks from the private eval repo (`jarvis-evals`). Results land in `~/.jarvis/evals/<task>/<run>/` with your rating prompt (decisions 35, 47).

## 4. One full run, step by step

1. You type `/jarvis build me a habit tracker` in Claude Code.
2. Triage reports: new product, tier 2. The research skill starts; the explorer and researcher subagents run in parallel, read-only.
3. Intake gives you a 5-line summary, any decision conflicts, up to 7 questions with defaults, and 3 mockups. It appears in Claude Code's question tool and is also sent via ntfy if you're away. The runner starts in intake-wait and accepts defaults after 15 minutes.
4. The spec is written as `docs/spec/v1.md`, along with `PRODUCT.md` and `DESIGN.md`. The spec-reader checks it. The acceptance tests are generated into `~/.jarvis/projects/<id>/checks/` and their hashes locked.
5. Handoff: `jarvis run --detach`. You can close Claude Code.
6. The runner works through the tasks, with sessions, checks, reviews and last-green tags. Overnight it may wait out a usage window.
7. On a production grant at intake, the broker promotes the release once it's release-ready and the live smoke test runs; without one, it stops at preview-ready.
8. Morning: an ntfy notification says "Preview-ready. 2 Taste decisions to check." `REPORT.md` has the evidence, decisions and what's left. You reply or `jarvis steer` to change anything.

## 5. How `claude -p` is called

Every flag is explicit, so neither your global config nor a friend's changes behavior (decisions 3, 58, 60). The binary is the pinned one, called by absolute path (decision 57), with a clean environment (decision 58).

```
~/.local/share/claude/versions/2.1.309 -p "<task prompt from the runner>" \
  --output-format stream-json \
  --settings ~/.jarvis/projects/<id>/claude-settings.json \   # sandbox, network allowlist, permission deny rules, hooks
  --plugin-dir ~/.jarvis/plugin \                             # the Jarvis plugin (skills, agents, hooks)
  --mcp-config ~/.jarvis/projects/<id>/mcp.json --strict-mcp-config \
  --setting-sources project --no-session-persistence \       # no user hooks, plugins, skills or history (decision 60)
  --append-system-prompt-file <run header> \                  # task, spec version, constraints
  --permission-mode dontAsk --permission-prompts none \      # fails closed if the settings file is dropped (decision 59)
  --model <from routing table> \
  --max-turns <cap>
```
The task prompt is short and structured:
- the goal and its exit condition,
- the acceptance criteria IDs it must satisfy,
- the relevant decisions,
- where the spec lives,
- what it may not touch,
- "write your result notes to `.jarvis/notes/<task>.md`". Those notes are claims, not evidence.

**Permission deny rules** (in the generated settings) block:
- writes, and file-tool reads, under `~/.jarvis/` (except reading the run header),
- web fetches outside the allowlist,
- MCP servers not in the Jarvis config,
- `git push --force`, production deploy CLIs, and package publishing.

## 6. Where things run, and what each is allowed

| Piece | Runs | Can write | Network | Credentials |
|---|---|---|---|---|
| Interactive Claude Code + plugin | Your session | The repo | Claude Code's normal permissions | None that Jarvis adds |
| Task sessions (`claude -p`) | Claude Code's sandbox, in a worktree | That worktree only | Per-project allowlist (registries, docs, localhost, preview host) | None |
| Researcher subagent | Inside a task session | Nothing (no write tools) | Web reads | None |
| Runner | Plain process | `~/.jarvis/`, worktrees, `.jarvis/` views | ntfy, `claude` | Reads the secrets backend only to start the broker |
| Broker | Inside the runner | Ledger receipts | Only the operation's target (Gmail, Vercel, …) | Holds them |
| Checks | Spawned by the runner on a fresh checkout | A temp folder | Localhost only | None |

## 7. Repo layout of Jarvis itself

```
jarvis/
├── AGENTS.md                 # ~100 lines: how to work on Jarvis (for the agent building it)
├── CLAUDE.md                 # one line: @AGENTS.md
├── docs/                     # brief, decisions, golden tasks, architecture, research, reviews
├── packages/cli/             # the `jarvis` CLI (TypeScript)
│   └── src/
│       ├── commands/         # setup, doctor, run, steer, status, report, why, act, gate, approve, mode, eval
│       ├── runner/           # loop, leases, worktrees, usage-wait, repair/blocked, replan
│       ├── ledger/           # append, hash chain, rebuild state, views
│       ├── broker/           # socket server, approvals, operation adapters
│       ├── notify/           # ntfy, email
│       ├── checks/           # protected-check store, lock, evidence capture
│       ├── harness/claude/   # builds settings/flags, parses stream-json (the only Claude-specific code)
│       ├── triage/           # classification signals, pipelines
│       └── eval/             # snapshots, baseline runs, results
├── plugin/                   # Claude Code plugin: commands/, agents/, hooks/, output-styles/, skills → ../skills
├── skills/                   # the 14 skills, standard format, each with evals/ and a gotchas section
├── templates/                # AGENTS.md block, spec, PRODUCT.md, DESIGN.md, decisions.md, report
├── stacks/                   # house-stack starters and their known-traps lists
└── tests/                    # unit + integration (fake `claude` binary), safety tests, fault injection
```
The golden tasks and snapshots live in a separate private repo, `jarvis-evals` (decision 36).

## 8. What gets built in each stage

| Stage | Components | Proof before moving on |
|---|---|---|
| 0. Setup | `jarvis setup`, `doctor` (first version), pinned Claude Code, accounts, ntfy, the `jarvis-evals` repo, baseline runs | Baselines recorded for tasks 1, 2, 11; every *(verify)* item in this doc resolved |
| 1. Foundation | Ledger, protected checks, evidence capture, broker + `jarvis act`, generated settings (sandbox, allowlist, deny rules), hooks, full `doctor` | Safety tests: every send, deploy, spend or secret read outside the broker fails; tampering is detected; the ledger survives a kill |
| 2. Intake | Triage, `research`, `intake`, `spec` and `design` skills (mockups, DESIGN.md), decision register, notifier questions | You rate task 1's questions; task 11's intake and mockups |
| 3. Build loop | Runner loop, worktrees, usage-wait, steer, repair/blocked, `build` and `debug` skills | Tasks 2, 4, 5 beat the baseline |
| 4. Verify | Review roles (with Codex), `security`, `qa` (Playwright, Maestro, Impeccable, token lint, axe), standards lanes | Tasks 3, 6 + the design negative control |
| 5. Ship | Release states, `ship` skill, broker deploy adapters, smoke tests, rollback | Task 11 preview-ready; task 12 built |
| 6. Memory and polish | `compound`, `sweep`, teach-me style, routing tuning, cost and footprint logs | Task 7; task 10 overnight with faults |
| 7. Package | README, installer, license, clean-install test | A friend-style install works from the README alone |

## 9. Things stage 0 must verify before code depends on them

1. **Claude Code flags and settings** in the pinned version: `--settings`, `--plugin-dir`, `--mcp-config` / `--strict-mcp-config`, `--append-system-prompt-file`, the non-interactive permission mode, `--max-turns`, `--output-format stream-json`.
2. **The exact form of the usage-limit message** in stream-json, and how a reset time is reported.
3. **Sandbox configuration:** a deny-read path for `~/.jarvis/secrets`, allowing one Unix socket, and the network allowlist format. Also which tools sit outside the shell sandbox (file, web, MCP) and the permission rules that cover them.
4. **The desktop app** loads the plugin, settings and hooks the same way the CLI does.
5. **Subscription headless use:** non-bare `claude -p` on Max 20x, and how it shares usage limits.
6. **ntfy on your phone:** action buttons and publish-box replies both reach the reply topic. ntfy has no typed-reply action (decision 50).
7. **The Impeccable detector** on a Next.js app and on FreeHire's SvelteKit UI; Maestro with an Expo development build on the iOS simulator.
8. **Codex as a reviewer:** `codex exec` read-only on your plan, and its JSON output.

## 10. For the agent building this

You're building the system in `docs/01-decisions.md` with the components above. Rules:
- **Work stage by stage** (§8). Don't start a stage until the previous stage's proof passes.
- **Write tests first.** Safety and ledger code gets tests before anything else, including fault-injection tests (kill mid-write, tampered check, missing broker).
- **Keep Claude-specific code in `harness/claude/`.** Everything else talks to an interface, so Codex and DSH adapters can be added later.
- **Never put a credential where a task session can read it,** even in a test fixture. Use the fake-`claude` binary in tests.
- **Small commits with clear messages.** Update `docs/harness-assumptions.md` whenever you add scaffolding that exists because of a model weakness.
- **When a doc and reality disagree** (a flag doesn't exist, a setting behaves differently), stop, record it in `docs/decisions.md` as a superseded or new decision, and adjust. Don't silently work around it.
- **Location:** work in `~/Developer/jarvis` if iCloud's Desktop & Documents sync is on. The repo is private until stage 7.
