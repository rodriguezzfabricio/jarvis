# Evaluation

Jarvis is being tested against plain Claude Code on real development tasks. The current results are preliminary, and the project does not claim a general improvement over Claude Code.

## What is being tested

The stage 3 comparison uses a citizenship-filter bug, a Chromium container configuration bug, and a recruiter-finder feature. Each arm starts from a sanitized project snapshot. The feature task gives both arms the same approved spec. A separate suite grades the final code, outside the coding session.

The broader [golden task set](02-golden-tasks.md) covers intake, security, UI, onboarding and overnight recovery. That document describes evaluation goals; it is not a claim that every task has passed.

## Models and budgets

Plain Claude Code uses `claude-opus-5-5`. The three current tasks allow, respectively, 100 turns/45 minutes, 150 turns/60 minutes, and 400 turns/180 minutes in one session.

Jarvis uses the production routing table: Sonnet 5.5 for initial build/debug work, Opus 5.5 after escalation, and Haiku 5.5 for exploration. Its current evaluation reviewer is Claude, despite Codex review support in the general runner. The successful citizenship smoke run recorded Sonnet and Opus build sessions and a Sonnet review.

Jarvis gets the task’s limits per session and can use multiple sessions. Total compute is therefore unequal. Wall time and usage must accompany quality claims; a successful result alone does not demonstrate a more efficient workflow.

## What counts as a result

The comparison requires at least two counted runs per arm, with every run graded and rated. Jarvis must have a higher average quality rating, no higher rate of incorrect completion claims, and no lower hidden-check pass rate. All compared grades must have the same test-suite fingerprint.

An incorrect completion claim means the agent reported success but the final revision failed the hidden checks. The runner’s own checks are separate from the hidden grader, so Jarvis cannot repair against the hidden answers during the run.

A smoke run is development feedback and must be identified separately from the formal evaluation. Failed attempts remain relevant to reliability, even when a fixed implementation is tested again. Changes to the harness between runs also limit what can be inferred from a comparison.

## Current evidence

On October 25, 2026, a citizenship-filter smoke run completed in about 32 minutes and passed the citizenship, original-test and unit checks. An earlier smoke run blocked because review evidence exceeded its size limit. The subsequent counted citizenship run reported completion but failed a hidden check. The six plain-Claude stage 3 baseline runs also each failed at least one hidden check.

This is evidence that Jarvis can complete a real task and that its current completion checks can miss defects. It is insufficient to establish a repeatable advantage. Formal comparisons and quality ratings remain in progress.

## Why a completion message is insufficient

Approved checks are stored outside the task workspace. The runner captures process output, exit codes and revision identities, and binds results to a hash-chained ledger. Hidden grading checks are not readable by the coding agent. The comparison refuses grades from different suite fingerprints.

For delegated quality ratings, a fresh Claude Opus 5.5 judge and a separate GPT-6-Astra judge assess the recorded work independently. The integrator does not rate the work it orchestrated. Subjective ratings remain fallible, even when judges agree.

Tests also exercise failure paths. Mutation checks remove or break safeguards and verify that the tests detect the change. Unit tests use a fake Claude process; optional live probes check the installed binaries and sandbox behavior.

## Reproducibility limits

The evaluation repository is private because it holds personal project snapshots and hidden checks. It is not published with Jarvis, so external readers cannot currently reproduce the complete comparison. Public code and review records can be inspected, but they are not an independently reproduced benchmark. A public, redistributable evaluation fixture is future work.

The coding sessions have restricted access; the project maintainers can still change the harness and grading code. Logs, hashes and independent judges reduce some failure modes without removing that trust requirement. Two runs per task also give little information about the failure rate on unfamiliar projects.

The CLI exposes `jarvis eval baseline`, `jarvis eval jarvis`, `jarvis eval grade` and `jarvis eval compare`. These commands require the private evaluation inputs for the current golden tasks. For tests that ship with this repository, run `pnpm test` and `pnpm typecheck`.
