# Working on Jarvis

Jarvis is a thin orchestrator around Claude Code: research, one round of questions, an autonomous build loop, and evidence-based "done". This file is a table of contents. The real content lives in `docs/`.

## Read first
- `docs/00-brief.md`: what Jarvis is for.
- `docs/01-decisions.md`: the decision register (what and why). Decisions 57–66 are stage 0 findings.
- `docs/03-architecture.md`: components, files, formats and build order (§8 stages, §10 rules for the builder).
- `docs/02-golden-tasks.md`: the test set every stage is measured on.
- `docs/stage0-findings.md`: what was verified on the real machine.

## Rules
- **Stage by stage** (architecture §8). A stage starts only after the previous stage's proof passes and its Codex review is saved in `docs/reviews/`.
- **Tests first.** Safety, ledger and settings code gets its tests before the code, including fault-injection tests. Check that a new test fails when the code it guards is broken.
- **Claude-specific code lives only in `packages/cli/src/harness/claude/`.** Everything else talks to interfaces.
- **No credential where a task session can read it,** not even in a test fixture. Unit tests use `tests/fixtures/fake-claude.mjs`.
- **Pinned binaries by absolute path** (`packages/cli/src/config/pins.ts`): Claude Code 2.1.309, codex-cli 0.164.0. Never call `claude` or `codex` through `PATH`.
- **Full model IDs** (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`), never aliases.
- **When a doc and reality disagree,** stop, record a new or superseding decision in `docs/01-decisions.md`, then adjust. Don't silently work around it.
- **Scaffolding that exists because of a model or harness weakness** gets a line in `docs/harness-assumptions.md`.
- **Small commits with clear messages.** The repo is private until stage 7.
- **Jarvis runs only Fabricio's own work on his own plan** (decision 65).

## Permanent safety requirements (decisions 59, 60, 68, 69)
Every task session must run with all of these. Each has a test; don't weaken them.
1. `sandbox.failIfUnavailable: true` and `allowUnsandboxedCommands: false` (`harness/claude/settings.ts`).
2. `--restricted` plus an explicit `--tools` list from `BUILD_TOOLS` (`harness/claude/args.ts`). Never `--setting-sources`: it loads project hooks, which run outside the sandbox.
3. `--permission-mode dontAsk --permission-prompts none`, `--strict-mcp-config`, `--no-session-persistence`.
4. `autoMemoryEnabled: false`.
5. `blockReadsOutsideWorkingDirectories: true`; only the toolchain cache is reopened.
6. The live canary probe (`harness/claude/probe.ts`) passes before any unattended run. `jarvis eval` runs it before every session.

Rules that go with these:
- Settings reach disk only through `writeTaskSettings`, which refuses anything but the exact policy for the context. Claude Code silently drops an invalid settings file.
- The runner's git calls in agent-writable folders go through `eval/git.ts` (no hooks, no fsmonitor, no global config).
- `node scripts/mutation-check.mjs` must report every mutation caught.

## Layout
```
packages/cli/src/
  config/pins.ts           pinned versions, model IDs, disk thresholds
  harness/claude/          settings, args, clean env, sessions, stream-json, live probe (the only Claude-specific code)
  doctor/                  jarvis doctor
  eval/                    sanitized snapshots, baselines, runner-safe git
  cli.ts                   entry point (Node 24 runs the TypeScript directly)
tests/unit/                fast tests (fake claude)
tests/live/                real pinned Claude Code, only with JARVIS_LIVE=1 (probe + negative control)
scripts/mutation-check.mjs breaks each safeguard and checks the suite catches it
docs/                      brief, decisions, golden tasks, architecture, findings, reviews
```

## Commands
| Command | Does |
|---|---|
| `pnpm install` | Install pinned dependencies |
| `pnpm test` | Unit tests |
| `pnpm test:live` | Live canary probe on the pinned Claude Code (a little plan usage) |
| `pnpm typecheck` | `tsc --noEmit` in strict mode |
| `pnpm jarvis doctor [--live]` | Preflight checks |

## Stack
TypeScript (strict, `erasableSyntaxOnly`) on Node 24, pnpm, Vitest. Runtime dependencies: commander, zod, and later yaml. Exact versions are pinned in `package.json`.
