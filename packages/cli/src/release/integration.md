# Ship lane integration

## Wired (decisions 157–159)

- `release/run.ts` `prepareRelease` loads the protected setup (`release/config.ts`,
  `~/.jarvis/projects/<id>/release.json`, written by `jarvis release configure`),
  verifies the pinned provider CLI (`release/provider-cli.ts`, `PROVIDER_CLI_PINS`),
  starting it as the adapters do (`providerLaunch` under `pinnedProviderNode()`,
  decision 161), and builds `deployAdapters(...)` with the checked bin, version and
  interpreter. `jarvis run` hosts them in place of the outbox for
  `deploy.preview` and `deploy.promote`; the outbox keeps the other operations, and
  every operation when there is no release setup (evals).
- `runReleaseStep` runs after a complete build loop (`commands/run-release.ts`):
  ship session (`release/ship.ts`), fixed-revision build (`release/build.ts`),
  manifest acceptance (`release/accepted.ts`), every approved check on the revision
  (`runGate` with `taskId: null`), preview through the broker, `runSmoke`,
  `reachState("preview-ready")` with the approved names as `requiredChecks`.
- Readiness is complete against the plan and the approved names (`releaseScope`);
  reports and notifications recheck with `releaseStatus`.
- Tokens: `<PROVIDER>_PREVIEW_TOKEN` and `<PROVIDER>_PRODUCTION_TOKEN`, stored by
  `jarvis setup` in the house-stack accounts file, which the hosted broker reads after
  the project's own file.
- Grants: `jarvis release grant <manifest-hash> [--allow-rollback]` shows the accepted
  manifest and calls `grantRelease`.
- Not wired yet: steps 4–7 below (backlog 185).

The notes below are the library's contract.

## Protected project configuration

`DeployAdapterOptions.projectConfig` and `SmokeInput.projectConfig` are a
`ReleaseProjectConfig` loaded from runner-owned setup/build state outside the
session checkout. Never derive this object or its roots from the submitted manifest.
It contains:

- `project`, `provider`, `siteId`, `productionUrl`: setup owns the account/site/live
  origin. Vercel also needs `orgId`. A manifest differing from setup is refused.
- `artifactRoot`: allowed build-output root. The runner builds a fixed, checked
  revision and records `artifacts[revision] = artifactDigest(output)`. Do not copy
  this binding from session notes or an unverified manifest. Keep build outputs
  outside the ledger/project state directory, in the runner's work/build area.
- `privateRoot`: an existing directory below the runner's ledger/project directory,
  denied to sessions. Deploy copies are fresh children, hashed before deploying.
- `snapshotRoot`: a private project data-snapshot root.
- `dataSnapshot`: optional `{ kind, source }`, pointing to the configured consistent
  SQLite export or Postgres dump. `createDataSnapshot(config)` makes a fresh private
  copy; the runner puts its returned path/kind into the accepted manifest.

The resolver accepts only runner-approved manifests. `checkManifest` checks the
trusted destination and revision/hash binding. `runRehearsal` receives `snapshotRoot`
separately and rejects sources whose realpath escapes it, including symlink escapes.

## Provider execution and rollback

Decision 161. `ProviderConfig` is `{ bin, version, interpreter?, home, cwd }`:
`bin` the absolute CLI at `pinnedProviderBin(provider)`, `version` its exact
`x.y.z` from `PROVIDER_CLI_PINS` (required; the table is empty until a CLI is
installed), `interpreter` the absolute Node that runs it (`pinnedProviderNode()`;
the npm CLIs' `#!/usr/bin/env node` finds no node under the adapters' PATH, so the
process is `<interpreter> <bin> <args>`; omit it for a native binary), and
`home`/`cwd` existing runner-owned folders inside `ledger.dir` (the project
folder). Every provider process, the version probe included, gets fresh private
HOME and cwd children there, removed afterwards, and exactly `PATH=/usr/bin:/bin`,
`HOME`, `CI=1` plus its own variables: one token (`VERCEL_TOKEN` with the project
and org IDs, or `NETLIFY_AUTH_TOKEN`). Before any credential is read the adapter
runs `--version` with no token and refuses anything but the pinned version, read
by the provider's own parser (`providers.ts`). `jarvis doctor` reports
`deploy.vercel`/`deploy.netlify` the same way (warn, or fail when listed in
`required`). Providers are reached only through the `PROVIDERS` registry
(`broker/adapters/providers.ts`) and the deploy-tree table in `artifacts.ts`; a new
`Provider` doesn't compile until it has both. Credentials come only from `envFileSecrets` via
broker adapter child env: `VERCEL_PREVIEW_TOKEN`, `VERCEL_PRODUCTION_TOKEN`,
`NETLIFY_PREVIEW_TOKEN`, `NETLIFY_PRODUCTION_TOKEN`. Candidate build commands never
run with these tokens.

The artifact is the static publish directory (for example `dist/`), never a
provider project or a `.vercel/output` tree: record
`artifacts[revision] = artifactDigest(publishDir)`. The adapter copies it from
`artifactRoot` into a fresh child of `privateRoot` that it builds itself: Vercel
gets `.vercel/output/static/<files>` beside a fixed `vercel.json`,
`.vercel/output/config.json` (`{"version":3}`) and `.vercel/project.json` (trusted
site/organization IDs); Netlify gets `public/<files>` beside a fixed `netlify.toml`
(no command, no plugins). The copy refuses, before any provider process or
credential read and naming the file: symlinks and special files, dot files other
than `.well-known`, `vercel.*`/`now.*` configuration, `netlify.toml`, `netlify/`,
`node_modules/`, any `package.json` or `*config.{js,ts,json,toml,yaml}`,
Netlify's `_redirects` and `_headers`, and files with an extension outside the
static list (HTML, CSS, browser JS, JSON, images, fonts, media, WASM, PDF).
Extensionless files (`health`, `CNAME`) and anything under `.well-known/` are
static. Files are copied without execute bits. The copy is hashed against the
approved digest, then stamped with `.well-known/jarvis-release` (the manifest
hash) inside the web root. Functions, middleware, edge functions, redirects and
headers are not supported; they need a separately reviewed contract. The CLI deploys this private copy; the live
session directory is never reread by it. Copies are removed after completion or
failure.

`grantRelease(broker, manifest, by, allowRollback)` remains a trusted host/intake
operation. Both production and rollback use `deploy.promote` with distinct
hash-bound refs. No shared broker schema change is needed.

Before promotion the adapter inspects the configured provider's current production
(`vercel inspect --json`, or Netlify `getSite`). It validates the target and records
a `decision` with type `release.production-before`, actor `broker`, linked to the
broker's executing intent. Rollback selects only that recorded ID for a successful
promotion; manifest rollback IDs/URLs are legacy claims and ignored. If current
production cannot be established, promotion is refused before a deploy is attempted.
A rollback succeeds only when the same production readback, run after the rollback
command exits 0, returns exactly the recorded deployment ID and URL. A mismatch,
a malformed or failed readback, or a nonzero rollback command is `unknown`.

Automatic recovery requires `allowRollback: true` on the matching manifest grant.
A person-approved rollback without that permission is manual. The task session
must not run a provider CLI or manufacture a grant. Unknown outcomes await
reconciliation and are never automatically retried.

## Evidence sequence

1. Run all protected gates on the fixed revision using `runGate`. Supply every
   latest gate sequence and the latest approved lock; release observations cannot
   substitute for protected checks.
2. Preview through the broker, then `runSmoke` using its actual receipt URL.
   Smoke checks root, manifest paths and the release marker. Reach preview-ready.
3. Without the manifest-bound production grant, stop at preview-ready.
4. Capture `recordPlan`; run rehearsals on the runner snapshot; reach release-ready.
5. Promote through the broker, which rechecks readiness and captures previous
   production. `runSmoke` checks both the provider-reported deployment URL and the
   setup-configured live origin. Both must serve this manifest's release marker.
6. On failed production smoke call `recoverFailedSmoke`; preview failures only
   notify that preview stopped. Recovery uses the recorded rollback target.
7. **Do not claim deployed.** `failureSignal` is always missing until a concrete
   protected check exists. Its required future evidence kind is `failure_signal`,
   not a `gate_result` produced by `recordObservation`.

The future signal check must verify the configured monitor is active for the
trusted site/live origin, inject a controlled failure, confirm delivery to the
configured alert destination, and clean up the controlled failure. Its runner-only
writer/verifier must bind project, site, manifest hash, monitor configuration and
alert receipt with protected evidence. Add the ledger kind and unlock the state
only together with that implementation. A passing boolean or session claim is
insufficient. Until then report release-ready, production/smoke receipts, and the
missing failure-signal check.

## Data executor

`runRehearsal` requires an isolated `execute(CopyCommandSpec)`. The provided
`dockerCopyExecutor` uses a preinstalled digest-pinned image, non-root UID:GID,
read-only root, no network, no capabilities or Docker socket, and one fresh copy
mount. It force-removes its container even after a CLI timeout. Configure an image
with the project's data tools and a user that can write the copy directory.

For local Postgres, project commands use `$JARVIS_LOCAL_DATA` and `$JARVIS_SOCKET`,
start/stop their local server inside the offline container, and use the separate
restored cluster for restore verification. No TCP ports are published. Restore
also writes the restored snapshot/dump to `$JARVIS_RESTORE`. SQLite uses independent
file copies. The original configured source is never given to project commands.

Only exit code, timeout status and stdout/stderr byte counts plus hashes are
recorded; raw command output never enters the ledger, evidence JSON, reports or
notifications. Tests use only fake executors/providers. Pinned CLI flags, JSON
schemas, environment-token behavior, Docker execution and real account setup
still require integration verification; no live provider or credential was used.
