# Jarvis: Stage 0 findings

Oct 23, 2026 · Fabricio + Claude

These are the results of the eight checks in `03-architecture.md` §9, run on Fabricio's MacBook Air (macOS 26.5.2, 16 GB, arm64). Probes used a planted dummy canary file and temporary folders under `/tmp`, deleted afterward. No real secret was read. Decisions 57–66 in `01-decisions.md` turn these into rules.

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
- Also useful: `--setting-sources`, `--no-session-persistence`, `--effort`, `--json-schema`, `--tools`, `--restricted`. `--restricted` is unsuitable for builders, because it removes Bash.
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

## 6. ntfy (pending phone test)

- The public server is reachable (`/v1/health` returned 200).
- The docs confirm `view`, `http` and `copy` buttons on iOS.
- There is **no typed-reply action**. Decision 50 is corrected to buttons plus the app's publish box.

## 7. Impeccable and Maestro (in progress)

- Impeccable 4.7.0 (Apache-2.0) scans local files and live URLs; exit code 2 means findings.
- Open issue #795: contrast and accessibility rules don't run on `.svelte` source. That matters for FreeHire.
- Maestro isn't installed yet.

## 8. Codex reviewer (pass)

- `codex exec --sandbox read-only --json --ephemeral --output-schema` returned a schema-valid verdict.
- The event types are `thread.started`, `turn.started`, `item.*` and `turn.completed`.
- User skills load unless `CODEX_HOME` is isolated (decision 66).
