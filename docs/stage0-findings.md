# Jarvis: Stage 0 findings

Oct 23, 2026 · Fabricio + Claude

These are the results of the eight checks in `03-architecture.md` §9, run on Fabricio's MacBook Air (macOS 26.5.2, 16 GB, arm64). Probes used a planted dummy canary file and temporary folders under `/tmp`, deleted afterward. No real secret was read. Decisions 57–71 in `01-decisions.md` turn these into rules. Section 10 covers what Codex's first review changed.

## Machine

| Item | Found |
|---|---|
| Claude Code on `PATH` | `~/.local/bin/claude`, an "ai-harness" wrapper that runs 2.1.270 |
| Claude Code binaries on disk | 2.1.273 … 2.1.302, 2.1.309 in `~/.local/share/claude/versions/` |
| Claude Code bundled in the desktop app | 2.1.308 (app 3.6556.2) |
| npm channels | latest 2.1.309, stable 2.1.308 |
| Codex | codex-cli 0.163.0 (`~/.npm-global/bin/codex`), logged in with ChatGPT; also wrapped on `PATH` |
| DSH | 0.2.0-rc.2 |
| Node, pnpm, git | 24.21.0, 11.7.0, 2.50.1 |
| Docker | 28.4.0 (daemon not running at check time); Podman not installed |
| Xcode, simulators | 26.4; iOS 26.4 and 17.5 runtimes |
| Java | OpenJDK 21.0.5 (Maestro needs 17 or newer) |
| Disk | 29 GB free of 460 GB (94% used) |
| iCloud Desktop & Documents | off (`FXICloudDriveDesktop = 0`) |

## 1. Claude Code flags (pass)

On 2.1.309, every flag in architecture §5 exists. `--max-turns`, `--append-system-prompt-file`, `--system-prompt-file` and `--permission-prompt-tool` are hidden from `--help` but accepted.

- The non-interactive permission setting is `--permission-mode dontAsk` together with `--permission-prompts none`.
- Also useful: `--setting-sources`, `--no-session-persistence`, `--effort`, `--json-schema`, `--tools`, `--restricted`. `--restricted` is unsuitable for builders, because it removes Bash. (Superseded Oct 23 by decision 68: `--restricted` plus an explicit `--tools` list keeps Bash.)
- The `--model` aliases changed meaning across versions (decision 61).

## 2. Usage-limit reporting (partly verified)

A live `rate_limit_event` was captured:
```json
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1792786200,"rateLimitType":"five_hour",
 "overageStatus":"rejected","isUsingOverage":false,
 "unifiedWindows":{"five_hour":{"utilization":0.09,"resetsAt":1792786200},"seven_day":{"utilization":0.03,"resetsAt":1793095200}}}}
```
`resetsAt` is in seconds. A real rejected session wasn't triggered on purpose (decision 62).

## 3. Sandbox (pass on 2.1.309)

| Attempt from inside a session | Result |
|---|---|
| Bash `cat` of a file under `sandbox.filesystem.denyRead` | `Operation not permitted` |
| Read tool on the same file, with a `Read(//…/**)` deny rule | Denied by permission settings |
| `curl https://example.com`, not in `allowedDomains` | Blocked (`deny network-outbound`) |
| Write outside the worktree | `operation not permitted` |
| Connect to the socket listed in `allowUnixSockets` (real path) | Worked |
| Same socket listed as `/tmp/…` (a symlink) | Blocked |
| Connect to a socket that isn't listed | Blocked |
| Canary string anywhere in the output | 0 occurrences |
| Settings file with one wrong-typed value | Whole file silently dropped; with `dontAsk`, every tool was then refused (fails closed) |

## 4. Desktop app (partly verified)

The docs say the desktop app reads the same settings files, skills and plugins as the CLI. Differences that matter:
- It bundles and auto-updates its own Claude Code.
- `dontAsk` is CLI-only.

Still open: one interactive check, with Fabricio present, that the Jarvis plugin loads in the desktop Code tab.

## 5. Subscription headless use (pass)

`init` reports `apiKeySource: "none"`, so runs use the Max login, and limits are shared with interactive use. An `ANTHROPIC_API_KEY` in the environment would switch billing to the API (decision 58). Usage terms: decision 65.

## 6. ntfy (buttons verified; typed reply pending)

- The public server is reachable.
- On Fabricio's iPhone the three `http` buttons rendered, and every tap reached the reply topic: 34 taps in the first minute, 60+ in total.
- **The iOS app gives no feedback after a tap**, so it looked broken and he kept tapping. Decision 50 now requires first-answer-wins, a per-request nonce, and a confirmation message.
- There is no typed-reply action; the publish-box test is pending.

## 7. Impeccable and Maestro (partly verified)

- **Impeccable 4.7.0 on FreeHire** (a copy of `web/src` at `23d3266`): exit 2 with 7 findings.
  - `overused-font` ×5, all in server-side OG image generators.
  - `side-tab` ×1 in `AssistantChat.svelte`.
  - `marquee` ×1 on the nav progress bar. That's a false positive: a loading indicator with reduced-motion handled.
  - So Jarvis needs reviewed inline ignores, not a blind "exit 0 or fail".
- **Impeccable on a deliberately generic page:**
  - The *source* scan of a `.tsx` file found only `ai-color-palette`.
  - The *DOM* scan of the same page as HTML found `overused-font`, `gray-on-color`, `low-contrast`, `flat-type-hierarchy` and `skipped-heading`.
  - Neither caught emoji icons, three identical cards, generic copy, the ALL-CAPS eyebrow, `→` on every button, or two primary buttons.
  - Consequences: the QA lane must scan both source and the running app's URL, and Jarvis's own copy and layout checks (decision 54) must cover the rest. The design negative control (stage 4) will measure this.
- **Maestro 2.11.0** was installed with the official installer into `~/.maestro`. Homebrew refused because the Command Line Tools (15.3) are out of date; updating them needs an admin prompt.
- **Not yet run:** a Maestro flow on an Expo development build in the iOS simulator. A dev build needs several GB, and the disk is at the 40 GB single-writer threshold. Deferred to stage 4 (task 9), where it's needed.

## 8. Codex reviewer (pass)

- `codex exec --sandbox read-only --json --ephemeral --output-schema` returned a schema-valid verdict.
- The event types are `thread.started`, `turn.started`, `item.*` and `turn.completed`.
- Isolation needs both an empty `CODEX_HOME` (login symlinked) and an empty `HOME`. Codex reads `~/.agents/skills` (4,193 skills here) from the real home.
- A trivial call's input dropped from about 53k tokens with no isolation, to about 25.5k with `CODEX_HOME` only, to about 15.8k with both (decision 66).
- Stdin must be `/dev/null`.

## 9. Baselines (in progress)

Plain Claude Code 2.1.309 on `claude-opus-5-5`, on sanitized snapshots, in the same safety envelope as task sessions. Results are in `~/.jarvis/evals/<task>/<run>/`.

| Task | Run 1 | Run 2 |
|---|---|---|
| 01 intake | 1 min, 6 turns, no file changes. It read the repo (existing follow-up drafter, read-only Google scopes), then asked 3 decisions with recommendations: the contact source, what "reaches out" means, and who the feature is for. It did no outside research, and it couldn't see the backlog's "no follow-ups" rule, which isn't in the repo. | Overnight |
| 11 habit tracker | Overnight (from 00:30) | Overnight |
| 02 build | Overnight | Overnight |

The hidden checks and rubric grading are applied to the recorded revisions once they're written (stage 2 for task 01's rubric).

## 10. After Codex review 1

`docs/reviews/stage0-codex-1.md` (FAIL: 1 critical, 5 high) and `stage0-codex-1-response.md`.

- **Project hooks ran outside the sandbox** under `--setting-sources project` (confirmed live). Task sessions now run `--restricted --tools Bash,Read,Edit,Write,Glob,Grep` (decision 68).
- Under `--restricted`: project hooks don't run, Jarvis's own plugin hooks do, and agent writes to `.git/hooks`, `.git/config` and `.claude/` are blocked. Agents can't `git commit`; the runner commits.
- **Reads outside the worktree** are blocked with `blockReadsOutsideWorkingDirectories`. The toolchain cache `~/.jarvis-work/cache` is reopened with `allowRead` and `allowWrite`, and Go, npm and pnpm are pointed at it (decision 69).
- **The live probe now has 20 checks**, all passing on 2.1.309. A live negative control started with the old flags fails exactly `project_hooks_not_run`.
- **Mutation check:** 14 of 14 mutations caught.
- The baseline chain was stopped. Task 01's first baseline ran under the old envelope and is kept only for reference; all baselines rerun under the fixed one.

## 11. After Codex review 2

`docs/reviews/stage0-codex-2.md` (FAIL: 4 high, 3 medium) and `stage0-codex-2-response.md`.

- **Private toolchain cache per run**, deleted afterwards. A shared cache let runs pass notes to each other.
- **The network check requires the sandbox's denial record** (`deny network-outbound example.com:443`). A live negative control with the blocked host allowlisted fails exactly that check.
- **Loopback:** without `allowLocalBinding`, even allowlisted `127.0.0.1:<port>` is unreachable (curl exit 7). With it, every local port is reachable, allowlisted or not. It stays off.
- **Compound commands:** under `dontAsk`, a `for` loop in Bash was refused even with the sandbox on. Plain commands and `sh script.sh` ran.
- **Jarvis's own plugin hooks** (`--plugin-dir`) run under `--restricted`; this is now a live probe check.
- **A real dotenv parser** and a fail-closed scan of every file in every encoding.
- **Live probe:** 21 checks plus 2 negative controls, all as expected on 2.1.309.

## 12. After Codex review 3

`docs/reviews/stage0-codex-3.md` (FAIL: 2 high, 4 medium) and `stage0-codex-3-response.md`.

- **Credential scan:**
  - Placeholders are only complete template forms or placeholder words. Short, percent-encoded and punctuated passwords are flagged.
  - Binary DER private keys and credential containers are refused.
  - FreeHire's one ambiguous fixture, `test_engines.py` (`u:p@1.2.3.4`), is allowlisted by review in jarvis-evals.
- **Sessions:**
  - They run in their own process group, and shutdown is SIGTERM then SIGKILL after a grace period.
  - Leftover background processes are cleaned when a session ends. Writing the test showed a killed shell's grandchild kept the output pipes open.
  - A session that fails to spawn is an error with a written diagnostic, never an empty run.
- **Scheduler:** high-usage waits only happen before a next run. Unstarted runs stop the chain and aren't counted.
- **Mutation check:** results are classified by test identity, assertion type, timeouts, signals and file errors (tested). 28 of 28 mutations caught. The stricter classifier caught one equivalent mutation and one weak test, and both were replaced.
