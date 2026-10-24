# Parallel work handoff — October 24, 2026 (decision 84)

One integrator session owns main and every shared file (decision 81, rule 2). The earlier integrator, the second Claude worker, the Codex app chat and the lane workers were stopped. Their unfinished work stays on disk and is integrated from there.

## Where the work is

| Work | Where | State |
|---|---|---|
| Lane 1, notifier | `~/.jarvis-work/lanes/notify` | Finished, uncommitted; integrating |
| Lane 2, decision register | `~/.jarvis-work/lanes/decisions` | Finished, uncommitted; integrating |
| Lane 3, spec checker | `~/.jarvis-work/lanes/spec` | Stopped during its decision 83 follow-up; integrating |
| Lanes 4–5, research and intake skills | `.claude/worktrees/elated-hamilton-eeed4f` | Research committed on its branch; intake uncommitted |
| Foreman | `foreman` branch, `lanes/foreman-*` | Shelved (decision 84) |
| Desktop plugin check kit | main (`5c7ee97`) | Done |

## Rules for workers

- Codex CLI workers: decision 82, one clone per lane under `~/.jarvis-work/lanes/`.
- Claude workers: subagents of the integrator, each in its own git worktree.
- Every worker runs only its own tests and waits while `~/.jarvis-work/quiet-slot` exists.
- Only the integrator commits to main, by reading each diff and having it reviewed by the other model family.
