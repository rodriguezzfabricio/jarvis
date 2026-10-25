# Ship lane integration

This is a runner library with no new command or `cli.ts` registration. Replace the
stage-1 deploy outbox adapters with `deployAdapters(...)`; preserve other outbox
operations for evals. Broker selects the first adapter for each operation.

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

Provider config supplies an absolute pinned CLI path, private empty `home` and
`cwd`. Credentials come only from `envFileSecrets` via broker adapter child env:
`VERCEL_PREVIEW_TOKEN`, `VERCEL_PRODUCTION_TOKEN`, `NETLIFY_PREVIEW_TOKEN`,
`NETLIFY_PRODUCTION_TOKEN`. Candidate build commands never run with these tokens.

The adapter copies artifacts from `artifactRoot` into `privateRoot`, hashes that
copy against the approved hash, then adds runner-controlled metadata. It writes
`.well-known/jarvis-release` for Netlify or
`.vercel/output/static/.well-known/jarvis-release` for Vercel. Its contents are the
manifest hash, avoiding a circular artifact hash by stamping after verification.
Vercel's linked project metadata is replaced with trusted site/organization IDs.
The CLI deploys this private copy; the live session directory is never reread by it.
Copies are removed after completion or failure.

`grantRelease(broker, manifest, by, allowRollback)` remains a trusted host/intake
operation. Both production and rollback use `deploy.promote` with distinct
hash-bound refs. No shared broker schema change is needed.

Before promotion the adapter inspects the configured provider's current production
(`vercel inspect --json`, or Netlify `getSite`). It validates the target and records
a `decision` with type `release.production-before`, actor `broker`, linked to the
broker's executing intent. Rollback selects only that recorded ID for a successful
promotion; manifest rollback IDs/URLs are legacy claims and ignored. If current
production cannot be established, promotion is refused before a deploy is attempted.

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
