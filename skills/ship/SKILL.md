---
name: ship
description: Prepare a checked revision for preview or production release, including the release manifest, data rehearsal commands and rollback steps. Use when shipping an app or preparing its release; production actions remain behind Jarvis's broker and manifest-bound grant.
---

# Ship

Prepare `.jarvis/release/manifest.json` for the runner. Read the project's deployment and data decisions first; use its existing provider. For a new project use Vercel first, Netlify second (decision 43). Missing accounts stay missing: develop locally until setup with Fabricio, without inventing a replacement service.

## Manifest

Use the schema in `packages/cli/src/release/manifest.ts`: version, project, committed revision, provider, artifact directory and hash, smoke paths, rollback steps and data. The runner checks the site ID and production URL against protected setup config and checks the artifact hash against its own fixed-revision build record. Session values cannot select another site. Changes produce a new manifest hash and need a new production grant.

- Describe what deploys and where; smoke paths start with `/` and have no query, fragment or traversal. Include a useful health check and the main user path.
- Rollback contains written recovery steps, migration compatibility and result checks. The broker captures the current production ID from the provider before promoting; only that recorded ID can be rolled back. Session-provided legacy target IDs/URLs are ignored.
- The runner creates the SQLite snapshot or Postgres dump copy from its own project configuration. `data.source` must resolve within its private snapshot root; never select a live database or another runner file. Declare `migrate`, `backup`, `restore` and `verify` commands using `$JARVIS_DATA_COPY`, `$JARVIS_BACKUP` and `$JARVIS_RESTORE`. Restore targets a fresh copy. Use `data.kind: none` only with no persistent data. Rehearsal output is recorded as byte counts and hashes, never raw stdout/stderr.
- Include migration filenames and their purpose in `migrations`. Avoid destructive changes when the previous app must still run during rollback.

## Handoff and states

Ask for release, production and spending permissions here, against the concrete action and its evidence, through the broker. Intake answers and spec confirmation are not grants. Reuse an existing valid grant only for its exact approved scope.

Your manifest and notes are claims. Do not write ledger entries or manufacture check output. The runner runs checks, rehearses migrations, tests restore and collects deploy receipts and live smoke evidence after the session ends (decisions 44, 49).

Outside actions go through `jarvis act` on the run's explicit broker socket. Deploy payloads contain only `{ "ref": "release:<manifest SHA-256>:preview|promote|rollback" }`; the runner supplies that reference after accepting the manifest. Never run a provider CLI, read a token, pass a credential to a command, or create a grant from the task session.

Without a recorded production grant bound to this manifest, stop at **preview-ready**. A request to ship is not permission to spend or a grant. With a grant, promotion requires **release-ready**. The broker copies approved artifacts into a fresh private directory, hashes that copy and stamps `/.well-known/jarvis-release` with the manifest hash before deploying. Smoke requests the provider-reported URL and, for production, the trusted live origin; both must serve that marker. Failed production smoke triggers automatic rollback only when the grant explicitly allows it. A person-approved rollback without `allowRollback` is manual; the task session never runs the provider CLI. Unknown outcomes await reconciliation and are never retried automatically.

## Result notes

Write `.jarvis/notes/<task>.md` with the manifest path, migration and rollback instructions and unverified work. Quote a runner state only with its evidence reference:

- **Preview-ready:** checks passed and the preview is reachable. Production has not been deployed.
- **Release-ready:** additionally the manifest, migration rehearsal, backup restore and written rollback are verified. Production has not been deployed.
- **Deployed:** currently unreachable. A real protected `failure_signal` check that proves monitor installation and alert delivery is not implemented. A generic passing observation cannot substitute. Report release-ready plus the production/smoke receipts and the missing signal check, without claiming deployed.

If evidence is missing, say what remains unverified. A successful build or provider CLI exit alone does not mean deployed.

## Gotchas

- A project-wide grant without this manifest's hash is insufficient for these adapters.
- Credentials belong only to the broker adapter child environment. Neither notes, reports, notification text nor evidence should contain them.
- Preview-only tokens and production tokens are separate secrets; never fall back from one to the other.
- A restore command exiting zero proves little unless a fresh copy was populated and verification ran against it.
- Rollback changes the app; it does not undo an irreversible schema migration. Write the data recovery steps before production.
