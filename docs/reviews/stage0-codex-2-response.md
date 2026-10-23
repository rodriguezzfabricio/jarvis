# Response to stage 0 review 2 (Codex)

Oct 23, 2026. Reviewed revision `9330856`; fixes are in the next commit. Each finding was reproduced or checked in code first. Each fix has a regression test, and `scripts/mutation-check.mjs` breaks it and confirms an assertion fails. The script now requires a clean control run and counts crashes as errors, not catches.

| # | Severity | Finding | Response |
|---|---|---|---|
| 1 | high | An inline comment makes the dotenv parser swallow the next secret | **Fixed:** a real dotenv parser (`"`, `'` and `` ` `` quotes, backslash escapes, inline comments). An unterminated quote refuses the snapshot. **Tests:** the reproduced case, escaped quotes, unquoted comments, unterminated values. |
| 2 | high | Uninspected files (over 5 MiB, NUL bytes, UTF-16) and credential URLs outside dotenv | **Fixed:** every file is scanned in UTF-8, UTF-16 (with or without a BOM) and raw-byte views. Files over 64 MiB, and env files that aren't UTF-8, are refused unless a person allowlists them. Credential URLs with non-local hosts are flagged in any text format. **Tests:** UTF-16 token, binary token, JSON credential URL; local and `.example` placeholders stay allowed. FreeHire at `486c357` still passes. |
| 3 | high | The shared writable cache passes data between runs | **Fixed:** a private, empty cache per run, deleted afterwards (decision 69 updated). **Test:** a run that leaves a note in `GOCACHE` isn't seen by the next run, and the run's cache is gone. |
| 4 | high | A host-specific failure passes the network check | **Fixed:** the check requires the sandbox's own denial record for the blocked host, plus curl `000`, plus a reachable allowlisted host. **Tests:** a DNS-style failure with no denial record fails. **Live negative control:** with the blocked host allowlisted, exactly `network_blocked` fails (200, no denial record). |
| 5 | medium | Usage-limited attempts use up retries and skip the task; preflight limits aren't handled | **Fixed:** `eval/schedule.ts` keeps usage waits out of the attempt budget and retries the same task. A usage-limited preflight becomes a wait (the probe reports it). Every other stop is recorded explicitly. **Tests:** six scheduling cases, including four limits followed by recovery, preflight limit, preflight failure, wait cap and retry cap. |
| 6 | medium | Output-stream errors can crash the runner | **Fixed:** error handlers attach as soon as each sink opens. A sink error stops the child and the run fails with `EvidenceCaptureError`. **Tests:** a slow sink (fails if the flush wait is removed; it's in the mutation list), an output file that can't be opened, and ENOSPC mid-session. |
| 7 | medium | The mutation check counts runner failures as caught | **Fixed:** an unmodified control run must pass. Results come from Vitest's JSON report. "Caught" needs failing assertions with the same test count; crashes and collection errors are `ERROR`. |
| — | evidence | No live evidence that plugin hooks work under `--restricted` | The live probe now loads a runner-owned plugin through `--plugin-dir` and requires its SessionStart hook to run (`jarvis_plugin_hooks_run`). It passes on 2.1.309. |

Found while fixing, and recorded in decision 68:
- Loopback is all-or-nothing (`allowLocalBinding`). It stays off.
- `dontAsk` refuses compound commands such as `for` loops, even when sandboxed.

Two more changes while closing these:
- **Two weak tests found by the stricter mutation check.** "Probe accepts 4xx" was masked by the denial-record requirement, so there's now a case where a denial is recorded *and* the host answered. "One shared cache" was masked by the after-run deletion, so the test now requires a distinct cache path per run. 22 of 22 mutations are caught.
- **The broadened credential-URL scan refused FreeHire** on seven files. The builder reviewed all seven; every one is a documentation or test placeholder (`user:pass@host`, `%s:%s@%s`, `<user>:<pass>@…`, `u:p@1.2.3.4`). Placeholder passwords (four characters or fewer, template markers, common placeholder words) are now ignored; random-looking passwords still trip the scan. This is tested both ways.
