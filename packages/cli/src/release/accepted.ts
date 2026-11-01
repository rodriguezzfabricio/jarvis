import type { Ledger, LedgerEntry } from "../ledger/ledger.ts";
import { manifestHash, parseManifest } from "./manifest.ts";
import type { ReleaseManifest } from "./types.ts";

/**
 * The runner's record of a manifest it accepted (decision 157): the ship session's claims merged with
 * runner-owned values, checked against protected setup and the fixed-revision build. Only these entries
 * resolve a release ref, for the broker's deploy adapters, the report and `jarvis release grant`.
 */
export const ACCEPTED_TYPE = "release.manifest-accepted";
type Data = Record<string, unknown>;
const data = (e: LedgerEntry): Data => e.data !== null && typeof e.data === "object" ? e.data as Data : {};

export function recordAcceptedManifest(ledger: Ledger, input: ReleaseManifest, extra: Data = {}): LedgerEntry {
  const manifest = parseManifest(input);
  return ledger.append({ kind: "decision", actor: "runner", data: { ...extra, type: ACCEPTED_TYPE, project: manifest.project, manifestHash: manifestHash(manifest), manifest } });
}

/** A runner-accepted manifest by hash; a broker entry, an edited body or a hash that doesn't match its body resolves nothing. */
export function acceptedManifest(entries: readonly LedgerEntry[], hash: unknown): ReleaseManifest | undefined {
  if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) return undefined;
  for (const e of [...entries].reverse()) {
    const d = data(e);
    if (e.kind !== "decision" || e.actor !== "runner" || d.type !== ACCEPTED_TYPE || d.manifestHash !== hash) continue;
    try {
      const manifest = parseManifest(d.manifest);
      if (manifestHash(manifest) === hash && manifest.project === d.project) return manifest;
    } catch { /* A malformed body resolves nothing. */ }
  }
  return undefined;
}

/** The latest accepted manifest, for `jarvis release show` and the grant prompt. */
export function latestAccepted(entries: readonly LedgerEntry[]): { entry: LedgerEntry; manifest: ReleaseManifest } | undefined {
  for (const e of [...entries].reverse()) {
    if (e.kind !== "decision" || e.actor !== "runner" || data(e).type !== ACCEPTED_TYPE) continue;
    const manifest = acceptedManifest([e], data(e).manifestHash);
    if (manifest) return { entry: e, manifest };
  }
  return undefined;
}
