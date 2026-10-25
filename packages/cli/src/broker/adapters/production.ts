import { payloadHash } from "../broker.ts";
import type { Ledger } from "../../ledger/ledger.ts";
import { manifestHash, releaseRef } from "../../release/manifest.ts";
import type { ReleaseManifest, ReleaseProjectConfig } from "../../release/types.ts";
import type { ProductionDeployment } from "./types.ts";

type Data = Record<string, unknown>;
const data = (value: unknown): Data => value !== null && typeof value === "object" ? value as Data : {};

/** Written before promotion, linked to the broker's executing intent. Never uses a session target. */
export function recordCurrentProduction(ledger: Ledger, manifest: ReleaseManifest, setup: ReleaseProjectConfig, deployment: ProductionDeployment): void {
  const hash = payloadHash("deploy.promote", { ref: releaseRef(manifest, "promote") });
  ledger.transact((entries, add) => {
    const intent = entries.filter(e => e.kind === "broker_request" && e.actor === "broker" && data(e.data).phase === "executing" && data(e.data).payloadHash === hash).at(-1);
    if (!intent) throw new Error("broker promotion intent required");
    add({ kind: "decision", actor: "broker", data: { type: "release.production-before", executionSeq: intent.seq,
      project: setup.project, provider: setup.provider, siteId: setup.siteId, manifestHash: manifestHash(manifest), deployment } });
  });
}
export function recordedRollbackTarget(ledger: Ledger, manifest: ReleaseManifest, setup: ReleaseProjectConfig): ProductionDeployment | undefined {
  const entries = ledger.entries();
  const captured = entries.filter(e => {
    const d = data(e.data);
    return e.kind === "decision" && e.actor === "broker" && d.type === "release.production-before" && d.project === setup.project
      && d.provider === setup.provider && d.siteId === setup.siteId && d.manifestHash === manifestHash(manifest)
      && entries.some(r => r.kind === "broker_receipt" && r.actor === "broker" && r.seq > e.seq && data(r.data).executionSeq === d.executionSeq
        && data(r.data).status === "succeeded" && data(data(r.data).detail).action === "promote");
  }).at(-1);
  if (!captured) return undefined;
  const target = data(data(captured.data).deployment);
  return typeof target.id === "string" && typeof target.url === "string" ? { id: target.id, url: target.url } : undefined;
}
