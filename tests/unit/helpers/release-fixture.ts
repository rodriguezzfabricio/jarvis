// A ledger that holds everything a preview-ready release needs (decisions 44, 157): a done plan task with its
// gates and review at the release revision, the runner-accepted manifest, protected gates on that revision under
// the approved lock, a broker preview receipt and a passing preview smoke. Tests then take pieces away.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger, type LedgerEntry } from "../../../packages/cli/src/ledger/ledger.ts";
import { recordAcceptedManifest } from "../../../packages/cli/src/release/accepted.ts";
import { manifestHash, parseManifest } from "../../../packages/cli/src/release/manifest.ts";
import { recordObservation } from "../../../packages/cli/src/release/states.ts";
import type { ReleaseEvidence, ReleaseManifest } from "../../../packages/cli/src/release/types.ts";

export const REVISION = "a".repeat(40);
export const LOCK = "d".repeat(64);
export const PREVIEW_URL = "https://habits-1.vercel.app";

export function releaseManifest(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return parseManifest({ version: 1, project: "p", revision: REVISION, provider: "vercel", artifactDir: "/trusted/artifacts", artifactHash: "c".repeat(64), siteId: "site",
    productionUrl: "https://app.example.com", smokePaths: ["/health"], data: { kind: "none" }, rollback: { steps: ["Restore the recorded production deployment."] }, ...overrides });
}

let evidenceCount = 0;
/** A runner gate_result with a real evidence file, so evidenceIntact holds until someone edits it. */
export function gateEntry(ledger: Ledger, check: string, extra: Record<string, unknown> = {}, place: { task_id?: string; attempt_id?: string } = {}): LedgerEntry {
  const dir = join(ledger.dir, "evidence", `gate-${++evidenceCount}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "stdout"), `PASS ${check}`);
  return ledger.append({ kind: "gate_result", actor: "runner", ...place, data: { check, revision: REVISION, status: "pass", checksLock: LOCK,
    evidence: { dir, files: { stdout: createHash("sha256").update(`PASS ${check}`).digest("hex") } }, ...extra } });
}

/** A plan task the runner finished at `revision`: its gates and reviews passed there and it was promoted there. */
export function doneTask(ledger: Ledger, id: string, checks: readonly string[], reviews: readonly string[] = ["code"], revision = REVISION): void {
  ledger.append({ kind: "task_created", actor: "runner", task_id: id, data: { title: id, requiredChecks: [...checks], requiredReviews: [...reviews] } });
  if (!ledger.entries().some((e) => e.kind === "run_started")) ledger.append({ kind: "run_started", actor: "runner", data: { runId: "run", pid: 333 } });
  ledger.append({ kind: "attempt_started", actor: "runner", task_id: id, attempt_id: `${id}-a1`, data: { runId: "run" } });
  ledger.append({ kind: "attempt_ended", actor: "runner", task_id: id, attempt_id: `${id}-a1`, data: { status: "completed", candidateRevision: revision } });
  for (const check of checks) gateEntry(ledger, check, { revision }, { task_id: id, attempt_id: `${id}-a1` });
  for (const reviewer of reviews) ledger.append({ kind: "review_result", actor: "runner", task_id: id, attempt_id: `${id}-a1`, data: { reviewer, revision, status: "pass" } });
  ledger.append({ kind: "state_reached", actor: "runner", task_id: id, attempt_id: `${id}-a1`, data: { state: "passed", revision, mergedRevision: revision } });
}

export interface ReleaseLedger { ledger: Ledger; manifest: ReleaseManifest; hash: string; evidence: ReleaseEvidence; checks: LedgerEntry[]; requiredChecks: string[] }

/** Everything preview-ready needs, in the order the release step writes it; no state_reached yet. */
export function previewReadyLedger(dir: string, options: { checks?: readonly string[]; manifest?: ReleaseManifest } = {}): ReleaseLedger {
  const ledger = Ledger.open(dir);
  const manifest = options.manifest ?? releaseManifest();
  const requiredChecks = [...(options.checks ?? ["unit", "e2e"])];
  doneTask(ledger, "T1", requiredChecks);
  ledger.append({ kind: "checks_approved", actor: "runner", data: { lockHash: LOCK } });
  recordAcceptedManifest(ledger, manifest);
  const checks = requiredChecks.map((check) => gateEntry(ledger, check));
  const receipt = ledger.append({ kind: "broker_receipt", actor: "broker", data: { status: "succeeded", op: "deploy.preview", payloadHash: "unused",
    detail: { manifestHash: manifestHash(manifest), action: "preview", url: PREVIEW_URL } } });
  const smoke = recordObservation(ledger, manifest, "preview", "pass", { deploymentSeq: receipt.seq });
  return { ledger, manifest, hash: manifestHash(manifest), requiredChecks, checks, evidence: { checks: checks.map((e) => e.seq), previewDeploy: receipt.seq, previewSmoke: smoke.seq } };
}
