import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { acceptedManifest, recordAcceptedManifest } from "../../packages/cli/src/release/accepted.ts";
import { manifestHash } from "../../packages/cli/src/release/manifest.ts";
import { isReleaseReady, missingEvidence, reachState, recordObservation, recordPlan } from "../../packages/cli/src/release/states.ts";
import { doneTask, gateEntry, previewReadyLedger, releaseManifest, REVISION } from "./helpers/release-fixture.ts";

// Decision 157 (pre-review finding 5): readiness is measured against the required set from protected runner state,
// the plan's tasks and required checks plus the approved store's names, never against the gates that happened to run.
const root = mkdtempSync(join(tmpdir(), "release-readiness-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = (options: Parameters<typeof previewReadyLedger>[1] = {}) => previewReadyLedger(join(root, String(++n)), options);

describe("preview-ready completeness", () => {
  it("is reached with every required check, the done plan and the preview evidence", () => {
    const r = fresh();
    const result = reachState({ ledger: r.ledger, manifest: r.manifest, state: "preview-ready", evidence: r.evidence, requiredChecks: r.requiredChecks });
    expect(result.missing).toEqual([]);
    expect(result.entry?.data).toMatchObject({ state: "preview-ready", manifestHash: r.hash, requiredChecks: r.requiredChecks });
  });

  it("refuses when a check the plan requires never ran at the release revision, though every observed one passed", () => {
    const r = fresh();
    const observedOnly = { ...r.evidence, checks: [r.checks[0]!.seq] }; // e2e never ran on the release revision
    expect(missingEvidence({ ledger: r.ledger, manifest: r.manifest, state: "preview-ready", evidence: observedOnly })).toContain("checks");
  });

  it("refuses when an approved check the runner names never ran, even if the plan doesn't require it", () => {
    const r = fresh();
    expect(missingEvidence({ ledger: r.ledger, manifest: r.manifest, state: "preview-ready", evidence: r.evidence, requiredChecks: [...r.requiredChecks, "a11y"] })).toContain("checks");
  });

  it("refuses with no plan: there is no protected required set to be complete against", () => {
    const ledger = Ledger.open(join(root, String(++n)));
    const manifest = releaseManifest();
    ledger.append({ kind: "checks_approved", actor: "runner", data: { lockHash: "d".repeat(64) } });
    const check = gateEntry(ledger, "unit");
    const receipt = ledger.append({ kind: "broker_receipt", actor: "broker", data: { status: "succeeded", op: "deploy.preview", detail: { manifestHash: manifestHash(manifest), action: "preview", url: "https://x.vercel.app" } } });
    const smoke = recordObservation(ledger, manifest, "preview", "pass", { deploymentSeq: receipt.seq });
    const missing = missingEvidence({ ledger, manifest, state: "preview-ready", evidence: { checks: [check.seq], previewDeploy: receipt.seq, previewSmoke: smoke.seq } });
    expect(missing).toEqual(expect.arrayContaining(["tasks", "checks"]));
  });

  it("refuses while a planned task is not done", () => {
    const r = fresh();
    r.ledger.append({ kind: "task_created", actor: "runner", task_id: "T2", data: { title: "Streaks", requiredChecks: ["unit"], requiredReviews: ["code"] } });
    expect(missingEvidence({ ledger: r.ledger, manifest: r.manifest, state: "preview-ready", evidence: r.evidence })).toEqual(["tasks"]);
  });

  it("refuses when a planned task's required review never passed", () => {
    const ledger = Ledger.open(join(root, String(++n)));
    doneTask(ledger, "T1", ["unit"], ["code", "design"]);
    // T1 is promoted, but its design review is missing: the replay never counts it done.
    const r = { ledger, manifest: releaseManifest() };
    const without = ledger.entries().filter((e) => !(e.kind === "review_result" && (e.data as { reviewer: string }).reviewer === "design"));
    expect(missingEvidence({ ledger: { entries: () => without }, manifest: r.manifest, state: "preview-ready", evidence: {} })).toContain("tasks");
  });

  it("refuses a manifest revision other than the one the runner last promoted", () => {
    const r = fresh();
    doneTask(r.ledger, "T2", ["unit"], ["code"], "b".repeat(40)); // a later promotion moved last green past the manifest's revision
    expect(missingEvidence({ ledger: r.ledger, manifest: r.manifest, state: "preview-ready", evidence: r.evidence })).toContain("tasks");
  });

  it("rechecks the recorded required set before production: a plan task added later un-readies release-ready", () => {
    const r = fresh();
    const plan = recordPlan(r.ledger, r.manifest);
    const rehearsal = recordObservation(r.ledger, r.manifest, "rehearsal", "pass");
    const restore = recordObservation(r.ledger, r.manifest, "restore", "pass");
    const evidence = { ...r.evidence, manifest: plan.manifest.seq, rollback: plan.rollback.seq, rehearsal: rehearsal.seq, restore: restore.seq };
    expect(reachState({ ledger: r.ledger, manifest: r.manifest, state: "release-ready", evidence, requiredChecks: r.requiredChecks }).missing).toEqual([]);
    expect(isReleaseReady(r.ledger, r.manifest)).toBe(true);
    r.ledger.append({ kind: "task_created", actor: "runner", task_id: "T9", data: { title: "Late", requiredChecks: ["unit"] } });
    expect(isReleaseReady(r.ledger, r.manifest)).toBe(false);
  });

  it("keeps the runner's required names in the recorded state, so a recheck can't drop one", () => {
    const r = fresh();
    reachState({ ledger: r.ledger, manifest: r.manifest, state: "preview-ready", evidence: r.evidence, requiredChecks: r.requiredChecks });
    const state = r.ledger.entries().filter((e) => e.kind === "state_reached" && (e.data as { state: string }).state === "preview-ready").at(-1)!;
    expect((state.data as { requiredChecks: string[] }).requiredChecks).toEqual(["unit", "e2e"]);
  });
});

describe("accepted manifests", () => {
  it("resolve only from a runner entry whose body hashes to the ref", () => {
    const ledger = Ledger.open(join(root, String(++n)));
    const manifest = releaseManifest();
    const hash = manifestHash(manifest);
    expect(acceptedManifest(ledger.entries(), hash)).toBeUndefined();
    ledger.append({ kind: "decision", actor: "broker", data: { type: "release.manifest-accepted", project: "p", manifestHash: hash, manifest } });
    ledger.append({ kind: "decision", actor: "runner", data: { type: "release.manifest-accepted", project: "p", manifestHash: hash, manifest: { ...manifest, siteId: "other" } } });
    expect(acceptedManifest(ledger.entries(), hash)).toBeUndefined();
    recordAcceptedManifest(ledger, manifest);
    expect(acceptedManifest(ledger.entries(), hash)).toEqual(manifest);
    expect(acceptedManifest(ledger.entries(), "e".repeat(64))).toBeUndefined();
    expect(acceptedManifest(ledger.entries(), REVISION)).toBeUndefined();
  });
});
