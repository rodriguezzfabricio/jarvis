import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyEvidence } from "../checks/gate.ts";
import { canonical, type Ledger, type LedgerEntry } from "../ledger/ledger.ts";
import { manifestHash, parseManifest, releaseUrl } from "./manifest.ts";
import type { ReachStateInput, ReleaseEvidence, ReleaseManifest, ReleaseState, StateResult } from "./types.ts";

type Data = Record<string, unknown>;
const data = (entry: LedgerEntry): Data => entry.data !== null && typeof entry.data === "object" ? entry.data as Data : {};

/** Runner-only observations: files are created outside the session tree and never overwritten. */
export function recordObservation(ledger: Ledger, manifest: ReleaseManifest, check: string, status: "pass" | "fail", extra: Data = {}): LedgerEntry {
  const dir = join(ledger.dir, "evidence", `release-${randomUUID()}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const observation = { ...extra, check: check.startsWith("release.") ? check : `release.${check}`, status,
    project: manifest.project, revision: manifest.revision, manifestHash: manifestHash(manifest) };
  const body = canonical(observation) + "\n";
  writeFileSync(join(dir, "observation.json"), body, { mode: 0o600, flag: "wx" });
  const files = { "observation.json": createHash("sha256").update(body).digest("hex") };
  return ledger.append({ kind: "gate_result", actor: "runner", data: { ...observation, evidence: { dir, files } } });
}
export function recordPlan(ledger: Ledger, input: ReleaseManifest): { manifest: LedgerEntry; rollback: LedgerEntry } {
  const manifest = parseManifest(input);
  return { manifest: recordObservation(ledger, manifest, "manifest", "pass", { manifest }),
    rollback: recordObservation(ledger, manifest, "rollback", "pass", { rollback: manifest.rollback }) };
}
export function evidenceIntact(entry: LedgerEntry): boolean {
  try {
    const evidence = data(entry).evidence as { files?: Record<string, string> } | undefined;
    return !!evidence?.files && Object.keys(evidence.files).length > 0 && verifyEvidence(entry).ok;
  } catch { return false; }
}
export function deploymentReceipt(entry: LedgerEntry | undefined, manifest: ReleaseManifest, action: "preview" | "promote"): boolean {
  if (!entry || entry.kind !== "broker_receipt" || entry.actor !== "broker") return false;
  const d = data(entry);
  const detail = d.detail as Data | undefined;
  return d.status === "succeeded" && d.op === (action === "preview" ? "deploy.preview" : "deploy.promote")
    && detail?.manifestHash === manifestHash(manifest) && detail.action === action
    && typeof detail.url === "string" && releaseUrl(detail.url);
}
function gate(entry: LedgerEntry | undefined, manifest: ReleaseManifest, check?: string): boolean {
  if (!entry || entry.kind !== "gate_result" || entry.actor !== "runner") return false;
  const d = data(entry);
  return d.status === "pass" && d.revision === manifest.revision
    && (d.manifestHash === undefined || d.manifestHash === manifestHash(manifest))
    && (!check || (d.check === `release.${check}` && d.manifestHash === manifestHash(manifest))) && evidenceIntact(entry);
}
const required = (state: ReleaseState): (keyof ReleaseEvidence)[] => ["checks", "previewDeploy", "previewSmoke",
  ...(state !== "preview-ready" ? ["manifest", "rehearsal", "restore", "rollback"] as const : []),
  ...(state === "deployed" ? ["production", "smoke", "failureSignal"] as const : [])];
/** Reserved for a concrete protected monitor/alert-delivery check; no writer exists yet. */
export const REQUIRED_FAILURE_SIGNAL_KIND = "failure_signal";

/** Check by ledger sequence, never by a session-supplied entry or status string. */
export function missingEvidence(input: ReachStateInput): string[] {
  const { ledger, state, evidence } = input;
  const manifest = parseManifest(input.manifest);
  if (!["preview-ready", "release-ready", "deployed"].includes(state)) return ["state"];
  const entries = ledger.entries();
  const at = (seq: unknown) => typeof seq === "number" ? entries.find(e => e.seq === seq) : undefined;
  const missing: string[] = [];
  for (const key of required(state)) {
    const value = evidence[key];
    let ok = false;
    if (key === "failureSignal") {
      // Generic observations cannot attest monitor installation or real alert delivery.
      ok = false;
    } else if (key === "checks") {
      const approved = entries.filter(e => e.kind === "checks_approved" && e.actor === "runner").at(-1);
      ok = Array.isArray(value) && value.length > 0 && value.every(seq => {
        const e = at(seq);
        return gate(e, manifest) && typeof data(e!).check === "string" && !(data(e!).check as string).startsWith("release.")
          && !!approved && data(e!).checksLock === data(approved).lockHash
          && !entries.some(later => later.seq > seq && later.kind === "gate_result"
          && data(later).revision === manifest.revision && data(later).check === data(e!).check && data(later).status !== "pass");
      });
      const latest = new Map<string, LedgerEntry>();
      for (const e of entries) {
        const d = data(e);
        if (e.kind === "gate_result" && e.actor === "runner" && d.revision === manifest.revision
          && typeof d.check === "string" && !d.check.startsWith("release.")) latest.set(d.check, e);
      }
      if ([...latest.values()].some(e => !gate(e, manifest) || !(value as number[] | undefined)?.includes(e.seq))) ok = false;
    } else if (key === "previewDeploy" || key === "production") {
      ok = deploymentReceipt(at(value), manifest, key === "production" ? "promote" : "preview");
      if (key === "production" && entries.some(e => e.seq > (value as number) && e.kind === "broker_receipt"
        && (data(e).detail as Data | undefined)?.manifestHash === manifestHash(manifest)
        && (data(e).detail as Data | undefined)?.action === "rollback" && ["succeeded", "unknown"].includes(data(e).status as string))) ok = false;
    } else {
      const check = key === "previewSmoke" ? "preview" : key;
      const e = at(value);
      ok = gate(e, manifest, check);
      const latestFailure = ok && entries.some(later => later.seq > e!.seq && later.kind === "gate_result" && later.actor === "runner"
        && data(later).check === data(e!).check && data(later).revision === manifest.revision
        && data(later).manifestHash === manifestHash(manifest) && data(later).status !== "pass");
      if (latestFailure) ok = false;
      if ((key === "previewSmoke" || key === "smoke") && ok) {
        const deploySeq = key === "previewSmoke" ? evidence.previewDeploy : evidence.production;
        ok = data(e!).deploymentSeq === deploySeq && e!.seq > (deploySeq ?? Infinity);
      }
    }
    if (!ok) missing.push(key);
  }
  return missing;
}
export function reachState(input: ReachStateInput): StateResult {
  const missing = missingEvidence(input);
  if (missing.length) return { missing };
  const entry = input.ledger.append({ kind: "state_reached", actor: "runner", data: {
    state: input.state, project: input.manifest.project, revision: input.manifest.revision,
    manifestHash: manifestHash(input.manifest), evidence: input.evidence,
  } });
  return { missing, entry };
}
/** Recheck the evidence behind the runner's last release-ready entry before a production action. */
export function isReleaseReady(ledger: Ledger, manifest: ReleaseManifest): boolean {
  const entry = ledger.entries().filter(e => e.kind === "state_reached" && e.actor === "runner"
    && data(e).state === "release-ready" && data(e).manifestHash === manifestHash(manifest)).at(-1);
  if (!entry) return false;
  const evidence = data(entry).evidence as ReleaseEvidence;
  return !!evidence && missingEvidence({ ledger, manifest, state: "release-ready", evidence }).length === 0;
}
