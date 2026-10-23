# Stage 0 review 5: Codex

Oct 23, 2026 · codex-cli 0.163.0, `--sandbox read-only`, reasoning effort high, isolated `CODEX_HOME` and `HOME` (decision 66).

- **Reviewed revision:** `95192604cb10344a1a29693120c1cdc7092cb3f3`, plus the first stage 1 modules.
- **Raw verdict:** `stage0-codex-5.json`.

> **Note on the evidence.** This review's mutation-check log ends in exit 143, and the reviewed clone had a mutated `eval/schedule.ts`. The builder's `pkill -f mutation-check.mjs`, aimed at a run in the working tree, also killed the run in the review clone. Mutations now run only in a disposable clone (finding 11).

## Verdict: FAIL

Reviewed revision 95192604cb10344a1a29693120c1cdc7092cb3f3 and the supplied checkout. Stage 0 does not meet decision 71's revised proof, even excluding baselines and the stage 2 typed-reply test. Five high findings remain, including a credential leak and two ways gate results can misrepresent the candidate.

Prior-finding audit, by original finding number:

Review 1:
1. Project hooks: fixed, with args/probe regressions and the live negative control. Runner hook/fsmonitor protections also have adversarial tests.
2. Outside reads: fixed for the implemented task envelope, with settings/probe, escaping-symlink and private-cache regressions.
3. Research tools: fixed; args/settings tests guard tool exclusion and explicit denial.
4. Mandatory preflight: fixed; baseline tests assert that rejection starts neither workspace nor session.
5. Credentials: the reported multiline, URL and non-dotenv cases have fixes and regression assertions. The new apostrophe bypass below means the overall safeguard remains incomplete.
6. Network canary: fixed; tests require allowed-host connectivity, blocked-host 000 and denial evidence, including both live negative controls.
7. Settings validation: fixed; exact-context comparison and tests reject changed paths and widened permissions.
8. Usage limits: fixed for the reported failures, with window-reset, rejected-stream and scheduling regressions.
9. Output flushing: fixed, with delayed-sink and output-error tests. The inherited-pipe cleanup gap below remains.
10. Completion claims: reconciled by decision 71; this is a scope change, without an executable regression test.

Review 2:
1. Inline-comment dotenv leak: fixed, with the reported reproduction, escapes and unterminated-value tests.
2. Uninspected files: the size/NUL skips and JSON-URL omission are fixed and regression-tested. Credential coverage remains incomplete as described below.
3. Shared cache: fixed, with distinct paths, cross-run marker checks and deletion assertions.
4. Host-specific network failure: fixed, with denial-record and live negative-control regressions.
5. Usage scheduler: fixed for skips and preflight limits, with scheduling-path tests.
6. Unhandled output errors: fixed for the reported error path, with early-open and mid-write fault injection; normal descendant cleanup still has the gap below.
7. Mutation classification: partly fixed. Process status, identities, collection failures and timeouts are guarded; standalone unhandled errors can still escape classification.

Review 3:
1. Placeholder exemptions: fixed for the reported passwords, now with snapshot-level regressions as well as helper assertions.
2. Binary private keys: the reported DER case is fixed, with generated-key, container and size-boundary tests.
3. Mutation classification: the reported all-timeout and SIGKILL cases are fixed and tested; the unhandled-error gap remains.
4. Bounded termination: the reported resistant-leader case is fixed and tested. Cleanup still waits for inherited pipes before reacting to normal leader exit.
5. Spawn failures: fixed in the commit, with session and scheduler regressions. The supplied checkout has the scheduler's started guard disabled by a leftover mutation.
6. Final-task wait: fixed, with final-task tests covering resets inside and beyond the cap.

Review 4:
1. Short/encrypted PEM keys: fixed, with generated Ed25519, X25519 and encrypted RSA snapshot regressions, plus dummy-envelope detection.
2. Password-only URLs: fixed for the reported Redis case, with helper and snapshot regressions. Apostrophes create another bypass below.
3. Descendant escalation: fixed for the reported redirected-output cases, with normal-completion and capture-failure regressions. The inherited-pipe case remains.
4. Matcher-named runtime errors: fixed, with mixed test failures, unfinished statuses and exit-status regressions. Standalone unhandled errors remain unaccounted for.

These regression assertions would fail if their corresponding fixes were reverted; the supplied mutation evidence does not demonstrate a completed mutation run. It contains only exit 143, and the checker left an uncommitted scheduler mutation. Supplied evidence records 125 passing unit/fault tests, three passing live tests, and successful typecheck and doctor --live. I independently passed typecheck under Node 24 and ran read-only/in-memory reproductions for the credential, ledger, check-map and process failures. I also reproduced the pinned sandbox CLI's signal-to-success mapping with sandbox initialization substituted. Filesystem-writing suites and a complete corrupt-object gate exploit were not rerun in this read-only checkout. Tests-first development order is not established by these logs.

## Findings

### 1. [high] Valid apostrophes in URL userinfo bypass credential protection
`packages/cli/src/eval/snapshot.ts:40`

**Scenario.** CRED_URL excludes apostrophes from usernames and passwords, although they are valid userinfo characters. I reproduced findCredentials returning no hits for JSON containing postgres://svc:N7q'4QmV8@db.prod.acme.net/app. Node's URL parser recognizes the password. A password-only rediss URL behaves identically, and redactEnvText leaves either URL unchanged under CONNECTION_URL with no redaction keys. These tracked credentials therefore reach task snapshots.

**Fix.** Parse URL candidates with their containing format rather than treating every apostrophe as a string boundary. Handle valid userinfo consistently in detection and redaction. Add snapshot regressions for apostrophes in usernames and passwords, including empty usernames in dotenv, JSON and YAML.

### 2. [high] An interrupted check can be recorded as passing
`packages/cli/src/checks/gate.ts:100`

**Scenario.** The gate trusts the sandbox CLI's exit code. The pinned sandbox-runtime 0.0.81 CLI explicitly converts payload SIGTERM and SIGINT into process.exit(0). Agent-controlled code invoked by a protected check can signal its parent check shell; the sandbox permits signals between processes in the same sandbox. The remaining assertions never execute, yet the gate records pass with timedOut false. I reproduced exit 0 through the actual pinned CLI's lifecycle code with only sandbox initialization/wrapping substituted.

**Fix.** Use a runtime adapter that preserves the payload's exit code and terminating signal, and treat any signal as failure. Add a gate regression in which candidate code terminates the protected check shell before a failing assertion; it must never pass.

### 3. [high] Local cloning does not establish candidate object integrity
`packages/cli/src/checks/gate.ts:69`

**Scenario.** The source object directory is agent-controlled, but the local clone only copies objects and then compares HEAD's name. An agent can replace a loose blob's compressed contents while retaining its filename. The commit and tree still name the original hash, while checkout materializes substituted passing content. No object-hash validation occurs before the check. This code-derived attack follows Git's local-copy path; --no-hardlinks changes copying, not content validation. See the [Git 2.50.1 clone implementation](https://github.com/git/git/blob/v2.50.1/builtin/clone.c#L230-L345).

**Fix.** Validate all candidate-reachable object hashes in an isolated copy before checkout, rejecting corrupt or externally dependent object stores. Preserve the existing runner Git protections. Add a regression that substitutes a loose blob without changing its object filename and verifies that no pass is recorded.

### 4. [high] Short writes can acknowledge a missing ledger entry
`packages/cli/src/ledger/ledger.ts:190`

**Scenario.** writeSync's byte count is ignored for both entries and head files. A successful short write, such as a partial write under storage exhaustion, is fsynced and followed by an acknowledged head update. I injected a short entry write: append returned seq 2, but verification recovered only seq 1 and reported a torn line/head mismatch. The acknowledged entry's data was absent. Random SIGKILL tests do not exercise short writes.

**Fix.** Serialize to a Buffer and loop until every byte is written, rejecting zero progress and errors. Apply this to entry, head and lock writes. Never acknowledge a partial record. Add positive-short-write and subsequent-write-failure fault tests.

### 5. [high] Takeover-lock reclamation can admit concurrent writers
`packages/cli/src/ledger/ledger.ts:261`

**Scenario.** Reclamation of ledger.lock.takeover has no ownership check or serialization. With dead main and takeover locks, two waiters can both observe the old takeover holder. One removes it and acquires a new takeover lock; the delayed waiter then removes that live replacement. Both can enter recovery and read the same dead main holder. One removes the main lock and acquires it for writing; the other can then remove that new lock using its earlier observation. Two appenders can now enter the critical section, producing duplicate sequences or overwritten head updates.

**Fix.** Use a locking primitive with atomic ownership and crash release, or a rigorously serialized acquisition/reclamation protocol that cannot unlink another owner's replacement. Add a deterministic test that pauses two reclaimers around stale takeover removal and main-lock replacement.

### 6. [medium] A crash before writing the lock PID causes an infinite recovery loop
`packages/cli/src/ledger/ledger.ts:254`

**Scenario.** A kill between exclusive lock creation and its PID write leaves an empty ledger.lock. Both holder reads parse its PID as NaN, so again.pid === h.pid is always false. Once the lock ages past one second, each iteration acquires/releases the takeover lock and continues before checking the deadline. I reproduced 60 recovery iterations spanning 121 seconds of simulated time, with the empty main lock retained and no timeout.

**Fix.** Publish fully initialized ownership atomically, handle malformed abandoned locks safely, and check the deadline on every loop path. Add a deterministic crash fixture at the create-before-PID-write boundary.

### 7. [medium] A second recovery crash makes a valid ledger unrecoverable
`packages/cli/src/ledger/ledger.ts:175`

**Scenario.** A lagging head is accepted but is not repaired before another entry is appended. After a crash between entry fsync and head replacement, restart can append another entry. A second crash at the same boundary leaves head two entries behind, which verification calls tampering. I reproduced this with two injected failures before head rename; the complete, valid chain then refused further appends.

**Fix.** Under the writer lock, durably repair the head to the verified tail before extending the ledger. Keep the existing tamper checks rather than accepting arbitrary lag. Test crashes during recovery itself.

### 8. [medium] A protected file named __proto__ is omitted from the approved hashes
`packages/cli/src/checks/store.ts:20`

**Scenario.** hashAll builds a normal object and assigns filenames as properties. Assigning the string hash to __proto__ invokes the inherited setter and creates no own property. I reproduced identical empty hash maps before and after changing that file from exit 1 to exit 0. An approved gate script with this filename can consequently change without changing checks.lock or failing verification.

**Fix.** Use a null-prototype map or safe own-property construction, and use own-property checks during comparison. Add approval/verification regressions for __proto__ and other inherited-property names.

### 9. [medium] Inherited output pipes delay cleanup until the session timeout
`packages/cli/src/proc/session.ts:114`

**Scenario.** Cleanup starts only after child close, which waits for inherited stdout/stderr pipes to close. A successfully exited leader can leave a background child holding those pipes open, preventing cleanup from starting. I reproduced a leader exiting 0 after spawning sleep with inherited output: runSession waited until its 700 ms timeout and returned code 0 with timedOut true. With production limits this can leave descendants running for hours and falsely fail a completed gate. Current descendant tests redirect their output.

**Fix.** React to leader exit immediately and start bounded group cleanup while separately awaiting pipe and sink completion. Preserve the leader's outcome. Add regressions with cooperative and resistant descendants that retain stdout/stderr.

### 10. [medium] Standalone unhandled errors remain invisible to mutation classification
`scripts/mutation-classify.mjs:48`

**Scenario.** The pinned Vitest JSON reporter serializes test modules but does not include the standalone unhandled errors passed to onTestRunEnd. A run with one genuine AssertionError plus an unhandled rejection can therefore have unchanged test identities, empty file messages and exit 1; classify labels it caught. The current unhandled-error regression covers only a run with no failed test, while mixed-error tests place both failures inside test cases.

**Fix.** Use a reporter that explicitly records standalone unhandled errors, cancellation and completion state, and reject any such errors even alongside an assertion failure. Add an integration regression combining a failed assertion with an unhandled rejection.

### 11. [medium] Interrupted mutation checking leaves production safeguards disabled
`scripts/mutation-check.mjs:91`

**Scenario.** The checker mutates the reviewed source tree and relies on finally for restoration. Default SIGTERM termination does not run that restoration. This occurred in the supplied evidence: mutation-check.log contains only exit 143, and git diff shows the committed if (!r.started) guard replaced by if (false) in eval/schedule.ts. The supplied checkout now counts unstarted runs despite its earlier passing test log, and no complete mutation result is available.

**Fix.** Run mutations in disposable isolated copies/worktrees so interruption cannot alter the reviewed code. Restore the supplied checkout and rerun the full check. Add an interruption regression and verify that the authoritative checkout remains unchanged.

## Builder response

See `stage0-codex-5-response.md`.
