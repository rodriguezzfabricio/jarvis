# Security review follow-up

Proposed decision-register addition (the lane cannot edit docs/01-decisions.md):

> Scanner subprocess reports use runner-owned temporary files when a tool opens its report path.
> On the lane's managed Mac sandbox, gitleaks 8.28.0 exits with "Report path is not writable"
> for /dev/stdout (operation not permitted). The adapter rewrites that report destination to a
> private temporary file, parses it after the process ends and removes it. Full gitleaks redaction
> is mandatory. This replaces the earlier /dev/stdout invocation assumption.

Coverage note for the integrator's docs:

> Gitleaks dir does not scan Git history. Jarvis now supplies a protected copy of the 8.28.0
> default rules without path allowlists, including dependency directories and lockfiles in scans.
> A pass covers the candidate's scanned current-tree files; history requires separately approved
> checks. Candidate suppression files are rejected,
> preserved on disk and reported as errors rather than silently removed.

## Lane 22: offline scanners

Observed in a clean environment on Oct 24: Semgrep **1.182.0** (needs the fixed
`SSL_CERT_FILE=/etc/ssl/cert.pem`) and OSV-Scanner **2.7.0** (also prints OSV-Scalibr
0.5.3). Absolute pins and reviewed arguments are in `pinnedSecurityScanners`.
Original rules cover JS/TS, Python and Go; there is no copied community ruleset.
The small ruleset is a conservative sink screen, not complete dataflow coverage.

The lane's write allowlist excludes `scripts/`. The integrator must add exactly
this `scripts/osv-db-fetch.mjs` entry point (Node 24):

```js
import { osvDbFetchMain } from "../packages/cli/src/security/osv-db-fetch.ts";
await osvDbFetchMain();
```

Run it explicitly **outside the gate**, with network access:

```sh
node scripts/osv-db-fetch.mjs /absolute/project /absolute/runner-owned/new-osv-snapshot
```

It inventories supported ecosystems without executing project code, writes
controlled lockfiles in a disposable input folder, invokes only the pinned OSV
binary with the explicit download flag, and publishes a new cache snapshot plus
`manifest.json`. Failed downloads do not publish the destination. Existing
snapshots are refused. The fetcher was unit-tested with fakes; **no real database
was downloaded in this lane**. Download and cache-layout compatibility still need
the integrator's real fetch plus the optional OSV planted-finding test.

Wire the pins into the existing security plan before approval:

```ts
const scanners = pinnedSecurityScanners("/absolute/runner-owned/new-osv-snapshot");
installSecurityChecks(store, { nodeBin: process.execPath, scanners });
```

`installSecurityChecks` copies rules and the snapshot into
`checks/fixtures/security/`; the existing store approval hashes them all. Later
updates need a new reviewed plan/store; installation never silently overwrites a
plan. Calling `pinnedSecurityScanners()` without a snapshot still installs the
other scanners; OSV is explicitly not run and cannot pass.

Optional checks (respect the quiet slot):

```sh
JARVIS_SECURITY_LIVE=1 node_modules/.bin/vitest run tests/unit/security-offline-live.test.ts
JARVIS_SECURITY_LIVE=1 JARVIS_OSV_DB_DIRECTORY=/absolute/runner-owned/new-osv-snapshot node_modules/.bin/vitest run tests/unit/security-offline-live.test.ts
```

The Semgrep live test passed all six categories in JS/TS, Python and Go, including
inline nosem and a nested ignore file. The worker has restricted network, but a
second OS-level network-denial sandbox could not start (`sandbox_apply: Operation
not permitted`). Repeat both scanner live checks in the real gate sandbox, with a
network control, before claiming a fully verified offline gate. OSV's live test
skips when its downloaded manifest is absent.

Proposed decision-register additions: use a fixed system certificate path for
Semgrep startup; use OSV's explicit local matcher plugin with both offline flags;
require hashed ecosystem-covering cache snapshots; ship the small original sink
ruleset and document its limits; record cache age without an expiry threshold.

## Scanner coverage gaps (backlog 104–106)

Semgrep now requires `paths.scanned` and compares it with every candidate JS/TS,
Python and Go file, including `.mts`, `.cts` and extensionless interpreter scripts.
Shebang detection reads at most 4096 bytes and does not depend on executable bits.
The inventory excludes `.git`; symlinks, special files, unreadable inventory and
an overlong shebang fail closed. Up to 20 missing paths are named. Reported
`paths.skipped` and `skipped_targets` still refuse a pass, even with full coverage.

The pinned Semgrep sources expose `--scan-unknown-extensions` for explicit file
targets, but it adds unknown files to every configured language. `--lang` is used
for pattern rules; it does not replace the languages in this protected ruleset.
This lane keeps the existing invocation and reports omissions as errors. A
separate language-scoped invocation needs live validation before replacing this
fail-closed behavior. The optional live regression accepts only an actual eval
finding or the specific named coverage error, not a generic infrastructure error.

`gitleaks.toml` contains all 217 default rules from the pinned 8.28.0 binary,
with the global paths field and three path-dependent rule allowlist tables removed.
The remaining value-based exceptions are unchanged. The source hash, upstream
location and MIT license are included. `withGitleaksConfig` supplies this config
for existing pins, and installation copies it to the approved fixtures. Explicit
reviewed configs keep the existing outside-checkout and fixture validation.
No `config/pins.ts` or CLI change is required.

Fresh checks installation and approval are required to pick up the new driver
modules and gitleaks policy; existing installed plans are never overwritten.
The lane ran only fake-based unit checks. The integrator should run
`tests/unit/security-coverage-live.test.ts` with `JARVIS_SECURITY_LIVE=1` in its
reserved evidence slot, alongside the existing scanner live checks. No network
or live scanner was used by this lane.
