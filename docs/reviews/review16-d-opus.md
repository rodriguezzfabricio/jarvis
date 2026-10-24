# Review 16 lane D fixes — independent Opus review

October 24, 2026. Branch `codex/review16-d`, based on `a929016`. Claude remains sole main integrator. This report approves only the scoped changes, not a stage transition.

## Commits and outcome

- `2339f74`: D3, broker socket ownership, explicit run selection, shutdown cleanup, and live integration wiring.
- `d2a851a`: D4, atomic first valid answer, conflicting-answer errors, payload binding.
- `3ead99c`: D5, bounded reclaim names and safe recovery of legacy markers.
- `9015491`: D8, effective plugin hook and manifest checks.

Independent reviewer: pinned Claude Code 2.1.309, full model `claude-opus-5-5`, requested effort high. All review sessions reported `apiKeySource: none`, tools Read/Glob/Grep, dontAsk, restricted policy and empty external MCP configuration. Fresh live canaries passed 21/21 before each review. First review FAIL was corrected; full re-review PASS and narrow final follow-up PASS are preserved below. Reviewers read source; deterministic tests were run by Codex.

Final verification: `pnpm test` 260 passed / 4 live skipped, 45.58 seconds; `pnpm typecheck` and `git diff --check` pass. Separately, `JARVIS_LIVE=1 pnpm exec vitest run tests/live/safety.live.test.ts` passes (12.50 seconds), with every original assertion retained. Eighteen focused mutations classify as caught using the existing classifier, clean baselines, identical test identities and the unhandled reporter. Exact definitions are in `review16-d-mutations.json`. Three replace existing anchors; fifteen are additional controls. The complete project mutation suite remains Claude-owned and must still run before stage review.

Tests were written first and reproduced the original D3/D4/D5/D8 failures. Subsequent regressions reproduced the legacy-marker migration race, misleading conflicting-answer CLI success, missing signal cleanup and weak hook registrations before fixes. A payload-binding mutation initially survived; an added wrong-hash/right-id regression now catches it. No survived control is counted as caught.

## Socket contract and runtime evidence

Node 24/macOS `net.Server.close()` unlinks its bound pathname even after replacement. The server therefore binds a unique private address and atomically hard-links a public alias. It refuses any occupied alias; close checks alias inode/device and lets native close remove only its private address. Shutdown covers SIGINT, SIGTERM and SIGHUP. Uncatchable crashes may leave names; they are never reclaimed without ownership proof.

Hard-link and symlink public aliases both failed sandbox integration with EPERM when only the alias was allowlisted. The final API returns `server.socketPath`, the actual bound private address. Callers MUST use it in both `TaskSettingsInput.brokerSocket` and task clients. The CLI prints that bound address and the public alias separately. Host clients can use the alias. No sandbox or settings policy was loosened. The live test verifies that the bound directory is mode 0700, within runner home, outside work/cache/tmp, and that a real task cannot write there.

The default public alias is `~/.jarvis/run/<key>.sock`, where key is the first 24 SHA-256 hex characters of JSON.stringify([project, randomUUID()]). Explicit `--socket` takes precedence over JARVIS_BROKER_SOCKET, which takes precedence over the default. The private name is `.b-<UUID-without-dashes>.sock` when space permits; otherwise it shortens to fit the Unix path byte limit and retries collisions without removing existing paths. `act` requires an explicit socket or JARVIS_BROKER_SOCKET. `doctor` now accepts `--socket` and warns if no run socket was selected.

## Review history and remaining limitations

The first review found a legacy-name migration race, conflicting-answer CLI misinformation, missing graceful cleanup, unverified sandbox alias connectivity, stale CLI defaults, long path incompatibility and weak hook options. All were addressed. The second review passed with two low follow-ups (SIGHUP and live setup cleanup); both were fixed and independently passed in the final follow-up.

Do not run old and new ledger reclaim implementations concurrently during upgrade; stop running brokers before switching versions. Empty JARVIS_BROKER_SOCKET for the broker fails closed with an unhelpful path error. If live-test server.close itself rejects, subsequent temporary-directory cleanup can be skipped; this is a test-cleanup limitation, not a product authorization gap. These nonblocking notes are handed to Claude rather than silently changing shared scope.

## Full re-review verdict

Reading is done; writing up the verdict now.

**PASS.** All seven earlier findings (M1–M4, L1–L3) are fixed. I found no new high or medium issues in D3, D4, D5 or D8. What's left is two low issues and two notes. I made no edits and ran nothing: this is from reading the code and tests. The live result I relied on is the run you pasted.

## Earlier findings, re-checked

- **M1 (D5) fixed.** Below the root level, `packages/cli/src/ledger/ledger.ts:356-367` now only *steps down into* an old-style marker that already exists. If that marker has disappeared or its owner is alive, the code waits and returns; it never recreates it. The only marker name it creates below the root is the new bounded one (`:368-372`). That name is derived from the parent marker and its owner, so each parent has exactly one possible claim. I traced the earlier interleaving (Y sees L2, X deletes L2, Y and Z claim together): Y now returns at `:365-366`, so Z holds the only claim. An old-style marker can only disappear after someone has won the claim on it, so a contender that skips it creates the only live claim on the parent. The regression test at `tests/unit/ledger.test.ts` ("never recreates a legacy descendant…") forces exactly this order.
- **M2 (D4) fixed.** A conflicting second answer throws `already answered: <first>` (`broker.ts:126-128`). Repeating the same answer adds nothing (`:129-131`). In the CLI, the exception escapes before `console.log` (`cli.ts:94-95`), so the command exits non-zero and doesn't print "Rejected". The new subprocess test covers this.
- **M3 (D3) fixed.** SIGINT and SIGTERM now call `close()` (`cli.ts:118-125`). `close()` removes the public link synchronously, and only if its inode matches (`server.ts:87-88`). `server.close()` then makes libuv unlink the private name at once, even while connections are still open, so the 5 s forced exit leaves nothing behind. The EEXIST case has a clear error message (`server.ts:75-77`). The subprocess test restarts twice on the same explicit socket.
- **M4 (D3) fixed.** The hard link doesn't work inside the sandbox (it fails with EPERM), so the API now returns the private socket path, and the sandbox allowlist names that exact path. The live test uses it in both `act` and `brokerSocket`, and checks that the socket's folder is mode 0700, inside the Jarvis home folder, and outside work/cache/tmp. It also checks that the task can't write into that folder. All earlier assertions are still there.
- **L1 fixed.** No command falls back to a global socket any more. `act` refuses to run without a socket, and doctor gains `--socket` and warns when none is selected.
- **L2 fixed.** The private name shrinks to fit the space left in the socket path (`server.ts:19-22,55`). If a name is taken, it retries with a fresh random name (EADDRINUSE) and never unlinks anything. The case near the length limit is tested on macOS.
- **L3 fixed.** Doctor now requires the exact keys, matcher and command for each hook, and checks the manifest's `name === "jarvis"` and that it has a version (`foundation.ts:64-90`). These match the real `plugin/hooks/hooks.json` and `plugin.json`.

## Other checks that passed

- **D3:** a second broker can't take over an active socket: the public link is created with `link`, which fails if the name exists, and that covers stale files and symlinks too. Closing an old server leaves its replacement in place. The default path is unique per run and hashed, so a project id can't be used to inject a path. A failed start closes and unlinks its own private socket. Calling `close()` twice is safe.
- **D4:** `decide` and `claim` both run inside `transact`. They agree on which answer is linked (same approval id, payload hash and op, and a valid decision), and the earliest such answer wins. Older ledgers with an invalid answer followed by two contradictory ones resolve correctly. Answers linked to a different request are ignored.
- **D5:** the bounded names stay under 256 bytes. Every level of descent uses the same deadline, with no depth limit. The 7-level old-style chain that reaches the filename limit is recovered. A live owner, whether old-style or at the deepest level, is respected. A replacement lock is never removed. `sweepMarkers` still matches the new names by their root nonce.

## Low

**L-A (D3): SIGHUP isn't handled** (`cli.ts:124-125`). Closing the terminal of a foreground broker sends SIGHUP, which takes the default path and leaves both the public link and the private socket. To reproduce: `jarvis broker --project p --socket ~/.jarvis/run/x.sock`, close the terminal, run it again. It refuses with EEXIST. That fails closed, as designed for crashes, but SIGHUP is a normal way for a terminal session to end. With the default socket path it also leaves two dead files per run in `~/.jarvis/run`. The fix is to add `process.once("SIGHUP", shutdown)`.

**L-B (live test): a setup failure leaves a folder in the real home directory** (`tests/live/safety.live.test.ts:28,40-45`). The test now creates `~/.jarvis-broker-test-*`. But `startBrokerServer` and the three folder assertions run *before* the `try`, so if any of them fails, the `finally` never runs. That leaves the folder under `~`, the `/tmp` folder, and an open server. The fix is to move those lines inside the `try`, with `server` declared as possibly undefined.

## Notes (not findings)

- **Old and new versions running together (D5).** A process still running the pre-fix code still creates old-style nested markers. If one runs at the same time as the new code, and a reclaimer has crashed holding the root marker, the two could each hold a claim on the same parent. This needs both versions running concurrently plus a crashed reclaimer. The safe practice is to stop running brokers before upgrading.
- **Empty `JARVIS_BROKER_SOCKET` (nit).** `act` treats an empty value as missing (`cli.ts:79`), but `broker` uses `??` (`cli.ts:105`). So `JARVIS_BROKER_SOCKET= jarvis broker` tries `link(…, "")`, fails with ENOENT, and cleans up. That fails closed but gives a confusing error.

The two-process test and the CLI subprocess test are what actually exercise D4's concurrency and its CLI behaviour. The in-process "idempotent" test runs both calls one after the other.

## Final narrow follow-up verdict

**PASS** on all three deltas. I only read the changed files. I had no shell, so I didn't run the tests myself; I'm relying on your report of the before/after test results and the live log.

**1. SIGHUP handler (`packages/cli/src/cli.ts:126`)**: PASS
- `process.once("SIGHUP", shutdown)` uses the same `shutdown` as SIGINT and SIGTERM. That means the same 5s deadline (`unref`'d), the same `server.close()`, and the same exit codes.
- `tests/unit/broker-server.test.ts:72` adds `"SIGHUP"` to the `it.each` list. Each signal gets its own home directory and socket path. The test checks over two attempts that the public socket and the `.b-*` bound names are removed, which also proves the explicit socket can be reused after a restart. The `finally` sends SIGKILL to any child that's still alive. This covers the change properly.

**2. Live test setup and cleanup (`tests/live/safety.live.test.ts:27-112`)**: PASS. This closes L-A and L-B.
- Only `root` is created before `try` (line 27). Nothing exists yet that would need cleaning if that call fails.
- `jarvisHome` and `server` are declared outside the `try` as optional values (lines 28-29). Creating `jarvisHome` and all the other setup now happen inside the `try`.
- The `finally` closes `server` only if it was created, always removes `root`, and removes `jarvisHome` if it was created. So a failure at any setup step after line 27 now cleans up both roots.
- One small leftover, not blocking: if `server.close()` rejects, the two `rmSync` calls on lines 110-111 are skipped. Wrapping the close in its own `try/finally` would cover that case too. It's outside what L-A and L-B asked for, so it doesn't change the verdict.

**3. Wrong-payloadHash test for D4 (`tests/unit/broker.test.ts:198-207`)**: PASS
- The test appends an `approval` that has the correct `approvalId` and `op`, decision `approve`, and `payloadHash: "wrong-payload-hash"`. It then expects the same request to still return `pending`.
- This targets the `d.payloadHash === hash` check in `claim` (`packages/cli/src/broker/broker.ts:223`). If that check were removed, the forged answer would match on id and op and the request would no longer be `pending`. So this is a real negative control.
- It complements the existing test at line 190, which covers the opposite case: wrong id with a correct hash.
- I made no changes to the production broker.

## Final content hashes

```json
{
  "packages/cli/src/broker/server.ts": "2f7d2054a08c4a0376a2aedeb65507fe0fe8d82ccd5eda008a8fbc4bbd7565b8",
  "packages/cli/src/cli.ts": "f5aae52bf0492c7efa7353e3d38083c949e0cfdc724f76d383f6f6b20c01d67a",
  "packages/cli/src/broker/broker.ts": "e24e7c84bbb9687617b5101e970d5d6d9f97065ee84cf61cc88be9803fcab2bb",
  "packages/cli/src/ledger/ledger.ts": "23dcdd28e08d9bcdcd34ff737558422bbaf27e1f03916a9dbdb1e23b453eafc1",
  "packages/cli/src/doctor/foundation.ts": "95b8ec897601e131bae8b520805f38b2a7852f1ea123a740f2f218bcdd5959b3",
  "tests/unit/broker-server.test.ts": "b5f5eca76977f7595409729940d8d1e4b71a705de00fc0b149139e339c432499",
  "tests/unit/broker.test.ts": "f6a46a6fcc737031f77b8d272b982982290dd35bd09e669921655ab5d8da135a",
  "tests/unit/ledger.test.ts": "4417b164399a9833bd394fce0bdf883d98dc23d9c7c2033684a5c5850c8af9f9",
  "tests/unit/foundation.test.ts": "080145f57a66e9471c5cac593ed45fadd2f9e1e473d76d957362a397366c0b05",
  "tests/live/safety.live.test.ts": "ed0004dcccfaf82aba71326a9574a414b8ba3b4c7556c204bd2baae05639c95f"
}
```

Raw local evidence: `/private/tmp/jarvis-review16-d-7lCPz3/`. Full test log: `/private/tmp/jarvis-d-final4-tests.log`. Live integration log: `/private/tmp/jarvis-d-live-final.log`. Focused mutation evidence locations are embedded in the JSON definitions.
