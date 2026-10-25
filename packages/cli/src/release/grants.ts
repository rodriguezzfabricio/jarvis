import type { Broker } from "../broker/broker.ts";
import type { Ledger } from "../ledger/ledger.ts";
import { manifestHash } from "./manifest.ts";
import type { ReleaseManifest } from "./types.ts";

/** Trusted intake/host only. The broker retains the extra scope fields in its existing grant entry. */
export function grantRelease(broker: Broker, manifest: ReleaseManifest, by: string, allowRollback: boolean): void {
  const scope = { project: manifest.project, manifestHash: manifestHash(manifest), allowRollback };
  broker.grant("deploy.promote", scope, by);
}
export function hasReleaseGrant(ledger: Ledger, manifest: ReleaseManifest, rollback = false): boolean {
  const hash = manifestHash(manifest);
  return ledger.entries().some(e => {
    const d = e.data as { op?: string; scope?: { project?: string; manifestHash?: string; allowRollback?: boolean } };
    return e.kind === "grant" && e.actor === "runner" && d.op === "deploy.promote"
      && d.scope?.project === manifest.project && d.scope.manifestHash === hash
      && (!rollback || d.scope.allowRollback === true);
  });
}
