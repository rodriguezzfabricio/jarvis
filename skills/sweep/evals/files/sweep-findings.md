Fixture for the sweep skill evals: what the eval snapshot plants, so expectations can name exact findings. The sweep must find these by reading the snapshot, not from this file.

- `src/lib/format.ts:12` exports `formatSalary`; nothing in the repo references it, and no config, template or dynamic import builds its name.
- `src/jobs/match.ts:40` has `// TODO(2025-03-02): drop the legacy scorer once v2 ships`; `docs/backlog.md` marks v2 shipped, and the legacy scorer was removed in `src/jobs/`.
- `src/jobs/match.test.ts:88` has `it.skip("ranks remote jobs first", …)` with the comment `// flaky on CI`.
- The ledger shows check `unit` passing at seq 210 and failing at seq 214 on the same revision for `src/jobs/match.test.ts`.
- `README.md:22` says `pnpm test:e2e`; `package.json` has no such script (it's `test:browser`).
- `docs/decisions.md` D9 (active, made by the user): "Distances are shown in kilometres". `src/jobs/card.svelte:31` formats miles.
- 312 files import `oldFetch` from `src/lib/http.ts`, which is marked `@deprecated`.
- Memory note M4 [project] cites `src/legacy/queue.ts`, which no longer exists.
