import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { manifestHash, parseManifest } from "../../packages/cli/src/release/manifest.ts";
import { reachState, recordObservation } from "../../packages/cli/src/release/states.ts";

const root = mkdtempSync(join(tmpdir(), "release-evidence-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function setup() {
  const ledger = Ledger.open(join(root, String(++n)));
  const manifest = parseManifest({ version: 1, project: "p", revision: "a".repeat(40), provider: "vercel", artifactDir: "/trusted/artifacts", artifactHash: "c".repeat(64), siteId: "site",
    productionUrl: "https://app.example.com", smokePaths: ["/health"], data: { kind: "none" }, rollback: { deploymentId: "old", url: "https://old.vercel.app", steps: ["Restore."] } });
  const lockHash = "d".repeat(64);
  ledger.append({ kind: "checks_approved", actor: "runner", data: { lockHash } });
  const obs = recordObservation(ledger, manifest, "test", "pass");
  const check = ledger.append({ kind: "gate_result", actor: "runner", data: { ...obs.data as object, check: "test", checksLock: lockHash } });
  const preview = ledger.append({ kind: "broker_receipt", actor: "broker", data: { status: "succeeded", op: "deploy.preview", detail: { manifestHash: manifestHash(manifest), action: "preview", url: "https://new.vercel.app" } } });
  const smoke = recordObservation(ledger, manifest, "preview", "pass", { deploymentSeq: preview.seq });
  const evidence = { checks: [check.seq], previewDeploy: preview.seq, previewSmoke: smoke.seq };
  return { ledger, manifest, evidence };
}
describe("release counterevidence", () => {
  it("does not claim readiness from an earlier smoke pass after newer smoke failure", () => {
    const { ledger, manifest, evidence } = setup();
    recordObservation(ledger, manifest, "preview", "fail", { deploymentSeq: evidence.previewDeploy });
    expect(reachState({ ledger, manifest, state: "preview-ready", evidence }).missing).toContain("previewSmoke");
  });
  it.each(["check", "lock", "receipt"])("lists missing evidence instead of crashing on a malformed %s", mode => {
    const { ledger, manifest, evidence } = setup();
    if (mode === "check") evidence.checks = [ledger.append({ kind: "gate_result", actor: "runner", data: null }).seq];
    if (mode === "lock") ledger.append({ kind: "checks_approved", actor: "runner", data: null });
    if (mode === "receipt") evidence.previewDeploy = ledger.append({ kind: "broker_receipt", actor: "broker", data: null }).seq;
    const result = reachState({ ledger, manifest, state: "preview-ready", evidence });
    expect(result.missing).toContain(mode === "receipt" ? "previewDeploy" : "checks");
    expect(ledger.entries().some(e => e.kind === "state_reached")).toBe(false);
  });
});
