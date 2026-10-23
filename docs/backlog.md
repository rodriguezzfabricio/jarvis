# Jarvis: Backlog

Medium and low findings from the Codex reviews (decision 74), and other deferred work. Each row says where it came from.

| # | From | Severity | Item | Status |
|---|---|---|---|---|
| 1 | Decision 71 | — | ntfy typed replies from the iPhone (the iOS app can't publish; try the Safari web app or an iOS Shortcut) | Stage 2 |
| 2 | Decision 71 | — | The desktop app loads the Jarvis plugin, settings and hooks like the CLI; needs Fabricio at the Mac | Stage 1 proof |
| 3 | Decision 71 | — | Maestro on an Expo development build in the iOS simulator | Stage 4 |
| 4 | Decision 71 | — | Impeccable on a real Next.js app (task 11) | Stage 4 |
| 5 | Decision 71 | — | `jarvis setup` account creation (GitHub, Vercel, Neon, …) | Stage 5 |
| 6 | Decision 68 | — | `dontAsk` refuses compound shell commands (`for` loops); the build skill must work around it | Stage 3 |
| 7 | Decision 68 | — | Loopback is all-or-nothing; dev-server tests run in the runner's checks, not in sessions | Stages 3–4 |
| 8 | Decision 69 | — | A read-only, runner-managed package mirror, to speed up per-run caches | Later |
| 9 | Stage 0 findings | — | Disk: 29 GB free, so one writing task at a time | Fabricio |
| 10 | Codex stage 0 review 5 #9 | medium | `runSession` starts group cleanup only after the child's pipes close; a descendant holding inherited stdout or stderr delays cleanup until the timeout. Fix: react to the leader's exit, and clean up while waiting for the pipes | Open |
| 11 | Codex stage 0 review 5 #10 | medium | Vitest's JSON report omits standalone unhandled errors, so the mutation classifier can't see them alongside a failed assertion. Fix: a custom reporter that records them | Open |
