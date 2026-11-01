import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Broker } from "../../packages/cli/src/broker/broker.ts";
import { grantRelease } from "../../packages/cli/src/release/grants.ts";
import { reachState, recordObservation, releaseStatus } from "../../packages/cli/src/release/states.ts";
import { notifierSummary, renderReport } from "../../packages/cli/src/runner/report.ts";
import { rebuildState } from "../../packages/cli/src/runner/state.ts";
import { gateEntry, PREVIEW_URL, previewReadyLedger } from "./helpers/release-fixture.ts";

// Decision 158 (pre-review finding 6): REPORT.md and the notifications recheck the release evidence and its
// counterevidence every time they render, so a later failed smoke, an edited file or a newer promotion un-readies.
const root = mkdtempSync(join(tmpdir(), "report-release-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function ready() {
  const r = previewReadyLedger(join(root, String(++n)));
  const reached = reachState({ ledger: r.ledger, manifest: r.manifest, state: "preview-ready", evidence: r.evidence, requiredChecks: r.requiredChecks });
  expect(reached.missing).toEqual([]);
  const render = () => {
    const entries = r.ledger.entries();
    const state = rebuildState(entries, { now: Date.now() });
    return { report: renderReport(state, entries), summary: notifierSummary(state, entries) };
  };
  return { ...r, reached: reached.entry!, render };
}

describe("release state in REPORT.md and the notifications", () => {
  it("shows preview-ready with its preview URL, and production gated with the grant command", () => {
    const r = ready();
    const { report, summary } = r.render();
    expect(report).toContain("State: preview-ready");
    expect(report).toContain(`Preview: ${PREVIEW_URL}`);
    expect(report).toContain(`Production: gated; no grant is bound to manifest ${r.hash}. To allow it: jarvis release grant ${r.hash}`);
    expect(summary).toMatch(new RegExp(`^preview-ready at ${PREVIEW_URL.replace(/[.]/g, "\\.")}; production gated \\(no grant\\)\\. 1/1 done`));
  });

  it("un-readies when a later preview smoke fails", () => {
    const r = ready();
    recordObservation(r.ledger, r.manifest, "preview", "fail", { deploymentSeq: r.evidence.previewDeploy });
    const { report, summary } = r.render();
    expect(report).toContain("State: not-reached");
    expect(report).toContain(`Lapsed: preview-ready (#${r.reached.seq}) no longer holds; missing previewSmoke`);
    expect(report).not.toContain(`Preview: ${PREVIEW_URL}`);
    expect(summary).toMatch(/^not-reached\./);
  });

  it("un-readies when an evidence file behind the state changes or disappears", () => {
    const r = ready();
    const gate = r.checks[1]!.data as { evidence: { dir: string } };
    writeFileSync(join(gate.evidence.dir, "stdout"), "edited after the run");
    expect(r.render().report).toMatch(/State: not-reached[\s\S]*missing checks/);
    const smoke = r.ledger.entries().find((e) => e.seq === r.evidence.previewSmoke)!.data as { evidence: { dir: string } };
    rmSync(smoke.evidence.dir, { recursive: true, force: true });
    expect(r.render().report).toMatch(/missing checks, previewSmoke/);
  });

  it("un-readies when a later check result on the release revision fails", () => {
    const r = ready();
    gateEntry(r.ledger, "e2e", { status: "fail" });
    expect(r.render().report).toContain("State: not-reached");
  });

  it("holds nothing for a runner state whose own required names lack evidence", () => {
    const r = previewReadyLedger(join(root, String(++n)));
    // A self-inconsistent runner record: it names a11y as required but carries no a11y result.
    r.ledger.append({ kind: "state_reached", actor: "runner", data: { state: "preview-ready", project: "p", revision: r.manifest.revision, manifestHash: r.hash,
      evidence: r.evidence, requiredChecks: [...r.requiredChecks, "a11y"] } });
    expect(releaseStatus(r.ledger.entries()).current).toBeUndefined();
  });

  it("names a production grant bound to the manifest, without claiming a deploy", () => {
    const r = ready();
    grantRelease(new Broker({ ledger: r.ledger, project: "p", adapters: [], secrets: { get: () => undefined } }), r.manifest, "test", false);
    const { report, summary } = r.render();
    expect(report).toContain(`Production: a grant is bound to manifest ${r.hash}; promotion is not automated yet`);
    expect(summary).toContain("production granted, not promoted");
    expect(report).not.toContain("deployed");
  });

  it("shows the release step's latest outcome when no state holds", () => {
    const r = previewReadyLedger(join(root, String(++n)));
    r.ledger.append({ kind: "decision", actor: "runner", data: { type: "release.step", outcome: "stopped: preview smoke failed" } });
    r.ledger.append({ kind: "decision", actor: "broker", data: { type: "release.step", outcome: "BROKER_FORGED" } });
    const report = renderReport(rebuildState(r.ledger.entries(), { now: Date.now() }), r.ledger.entries());
    expect(report).toContain("Release step: stopped: preview smoke failed");
    expect(report).not.toContain("BROKER_FORGED");
  });
});
