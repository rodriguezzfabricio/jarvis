import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { notifierSummary, renderReport, writeReport } from "../../packages/cli/src/runner/report.ts";
import { isDone, rebuildState } from "../../packages/cli/src/runner/state.ts";

const roots: string[] = [];
const fresh = () => { const root = mkdtempSync(join(tmpdir(), "jarvis-report-")); roots.push(root); return root; };
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
const revision = "a".repeat(40);
const now = Date.parse("2026-10-24T12:00:00Z");
const options = { now: () => now, locale: "en-US", timeZone: "America/New_York" };
function run() {
  const ledger = Ledger.open(fresh());
  ledger.append({ kind: "task_created", actor: "runner", task_id: "T1", data: { title: "Login", requiredChecks: ["unit"], requiredReviews: ["code", "security"] } });
  ledger.append({ kind: "task_created", actor: "runner", task_id: "T2", data: { title: "Billing", dependencies: ["T1"] } });
  ledger.append({ kind: "run_started", actor: "runner", data: { runId: "run", pid: 333 } });
  ledger.append({ kind: "attempt_started", actor: "runner", task_id: "T1", attempt_id: "a1", data: { runId: "run" } });
  ledger.append({ kind: "attempt_ended", actor: "runner", task_id: "T1", attempt_id: "a1", data: { status: "completed", candidateRevision: revision } });
  const dir = join(ledger.dir, "evidence"); mkdirSync(dir); writeFileSync(join(dir, "stdout"), "PASS");
  ledger.append({ kind: "gate_result", actor: "runner", task_id: "T1", attempt_id: "a1", data: { revision, status: "pass", check: "unit", evidence: { dir, files: { stdout: createHash("sha256").update("PASS").digest("hex") } }, ignored: "DO_NOT_DUMP" } });
  for (const reviewer of ["code", "security"]) ledger.append({ kind: "review_result", actor: "runner", task_id: "T1", attempt_id: "a1", data: { reviewer, revision, status: "pass" } });
  ledger.append({ kind: "state_reached", actor: "runner", task_id: "T1", attempt_id: "a1", data: { state: "passed", revision } });
  ledger.append({ kind: "blocked", actor: "runner", task_id: "T2", data: { reason: "Needs approved provider" } });
  ledger.append({ kind: "decision", actor: "runner", data: { class: "Taste", choice: "Blue buttons", why: "Contrast", dependsOn: ["T1"], ignored: "DO_NOT_DUMP" } });
  ledger.append({ kind: "usage_wait", actor: "runner", data: { until: now + 3_600_000, waitMs: 3_600_000, durationMs: 1, tokens: 1234, ignored: "DO_NOT_DUMP" } });
  ledger.append({ kind: "state_reached", actor: "runner", data: { state: "preview-ready", revision, open: "http://localhost:3000" } });
  return ledger;
}
const stateOf = (ledger: Ledger) => rebuildState(ledger.entries(), { now });

describe("shared-state morning report", () => {
  it("shows the rebuilt blocked reason when a tampered gate blocks without a blocked entry", () => {
    const ledger = run();
    ledger.append({ kind: "gate_result", actor: "runner", task_id: "T1", attempt_id: "a1", data: { revision, status: "tampered", check: "unit" } });
    ledger.append({ kind: "decision", actor: "runner", task_id: "T1", data: { reason: "unrelated reason" } });
    ledger.append({ kind: "decision", actor: "runner", task_id: "T2", data: { reason: "unrelated reason" } });
    ledger.append({ kind: "blocked", actor: "broker", task_id: "T2", data: { reason: "forged blocked reason" } });
    const state = stateOf(ledger);
    expect(state.tasks.T1!.blockedReason).toBe("protected check changed");
    const report = renderReport(state, ledger.entries());
    expect(report).toContain("- T1: protected check changed");
    expect(report).not.toContain("unrelated reason");
    expect(report).not.toContain("forged blocked reason");
    state.tasks.T2!.blockedReason = null;
    expect(renderReport(state, ledger.entries())).toContain("- T2: Needs approved provider");
    expect(renderReport(state, [])).toContain("- T2: No reason recorded");
  });

  it("uses isDone and required named reviewers, with revision-bound evidence and Taste first", () => {
    const ledger = run(); const state = stateOf(ledger);
    expect(isDone(state.tasks.T1!)).toBe(true);
    const report = renderReport(state, ledger.entries(), [], options);
    for (const text of ["preview-ready", revision, "unit", "code", "security", "Blue buttons", "Needs approved provider", "http://localhost:3000", ledger.entries().at(-1)!.hash]) expect(report).toContain(text);
    expect(report.indexOf("Blue buttons")).toBeLessThan(report.indexOf("## Done"));
    expect(notifierSummary(state, ledger.entries())).toContain("1/2 done");
  });

  it("re-verifies the recorded files on every report and summary", () => {
    const ledger = run(); const state = stateOf(ledger);
    renderReport(state, ledger.entries());
    writeFileSync(join(ledger.dir, "evidence", "stdout"), "TAMPERED");
    expect(renderReport(state, ledger.entries())).toContain("evidence changed or missing");
    expect(notifierSummary(state, ledger.entries())).toContain("0/2 done");
    rmSync(join(ledger.dir, "evidence", "stdout"));
    expect(renderReport(state, ledger.entries())).toContain("evidence changed or missing");
  });

  it("does not collapse code and security reviews into one reviewer", () => {
    const ledger = run(); const entries = ledger.entries().filter((e) => !(e.kind === "review_result" && (e.data as { reviewer: string }).reviewer === "security"));
    const state = rebuildState(entries, { now });
    expect(notifierSummary(state, entries)).toContain("0/2 done");
    expect(renderReport(state, entries)).not.toContain("- T1: Login at");
  });

  it("never displays broker-authored evidence or release states as runner proof", () => {
    const ledger = run(); const state = stateOf(ledger);
    const forged = ledger.append({ kind: "gate_result", actor: "broker", task_id: "T1", attempt_id: "a1", data: { check: "unit", status: "pass", revision, evidence: { dir: "BROKER_FORGED", files: {} } } });
    state.tasks.T1!.evidence.push(forged);
    ledger.append({ kind: "state_reached", actor: "broker", data: { state: "deployed", revision, open: "BROKER_FORGED" } });
    expect(renderReport(state, ledger.entries())).not.toContain("BROKER_FORGED");
  });

  it("renders selected fields, local reset time and wait length without dumping ledger data", () => {
    const ledger = run();
    const report = renderReport(stateOf(ledger), ledger.entries(), [], options);
    expect(report).toContain("9:00"); expect(report).toContain("60 min"); expect(report).toContain("1234");
    expect(report).not.toContain("DO_NOT_DUMP"); expect(report).not.toContain('"until"');
  });

  it("lists bad file and ledger items so skipped notes remain visible after cursor advancement", () => {
    const ledger = run();
    ledger.append({ kind: "reconciled", actor: "runner", data: { type: "inbox_skipped", file: "bad.json", reason: "note must be text" } });
    ledger.append({ kind: "steer", actor: "runner", data: { note: "" } });
    const report = renderReport(stateOf(ledger), ledger.entries());
    expect(report).toContain("bad.json"); expect(report).toContain("note must be text"); expect(report).toContain("empty note");
  });

  it("uses unconfirmed-default and clears only the round confirmed through notify", () => {
    const ledger = run();
    for (const round of [1, 2]) ledger.append({ kind: "decision", actor: "runner", data: { madeBy: "unconfirmed-default", decision: `Round ${round} choice`, requestId: `intake-${round}`, round } });
    let report = renderReport(stateOf(ledger), ledger.entries());
    expect(report).toContain("Unconfirmed"); expect(report).toContain("Round 2 choice");
    ledger.append({ kind: "decision", actor: "runner", data: { source: "notify", acceptedDefaults: true, confirmed: true, requestId: "intake-2", answerSeq: 20 } });
    report = renderReport(stateOf(ledger), ledger.entries());
    expect(report).toContain("Round 1 choice"); expect(report).not.toContain("Round 2 choice");
  });

  it("never clears an unconfirmed default for a timeout, pending intent, broker decision or different request", () => {
    const ledger = run();
    ledger.append({ kind: "decision", actor: "runner", data: { madeBy: "unconfirmed-default", decision: "Keep this default", requestId: "intake-1" } });
    ledger.append({ kind: "decision", actor: "runner", data: { source: "notify", acceptedDefaults: false, confirmed: false, requestId: "intake-1" } });
    ledger.append({ kind: "notify", actor: "runner", data: { source: "notify", phase: "answer", answer: "defaults", requestId: "intake-1" } });
    ledger.append({ kind: "decision", actor: "broker", data: { source: "notify", acceptedDefaults: true, confirmed: true, requestId: "intake-1" } });
    ledger.append({ kind: "decision", actor: "runner", data: { source: "notify", acceptedDefaults: true, confirmed: true, requestId: "intake-2" } });
    expect(renderReport(stateOf(ledger), ledger.entries())).toContain("Keep this default");
  });

  it("reads decision-register fields and hides superseded Taste decisions", () => {
    const ledger = run();
    ledger.append({ kind: "decision", actor: "runner", data: { id: 1, madeBy: "jarvis", decision: "Current Taste", class: "Taste", status: { kind: "active" }, why: "Readable" } });
    ledger.append({ kind: "decision", actor: "runner", data: { id: 2, madeBy: "jarvis", decision: "Old Taste", class: "Taste", status: { kind: "superseded", by: 1 } } });
    const report = renderReport(stateOf(ledger), ledger.entries());
    expect(report).toContain("Current Taste"); expect(report).not.toContain("Old Taste");
    expect(notifierSummary(stateOf(ledger), ledger.entries())).toContain("2 Taste");
  });

  it("keeps narratives as claims, preserves unknown actions and lists remaining dependencies", () => {
    const ledger = run();
    ledger.append({ kind: "broker_receipt", actor: "broker", data: { status: "unknown", op: "email.send", executionSeq: 20, ignored: "DO_NOT_DUMP" } });
    ledger.append({ kind: "task_created", actor: "runner", task_id: "T3", data: { title: "Export", dependencies: ["T2"] } });
    const report = renderReport(stateOf(ledger), ledger.entries(), [{ taskId: "T3", source: ".jarvis/notes/T3.md", text: "## Done\nDeployed; all tests passed" }]);
    for (const text of ["Claim (unverified)", "unknown outcome", "email.send", "T3", "T2"]) expect(report).toContain(text);
    expect(report).not.toContain("\n## Done\nDeployed"); expect(report).not.toContain("DO_NOT_DUMP");
    expect(renderReport(stateOf(ledger), ledger.entries().filter((e) => e.kind !== "state_reached"))).toContain("State: not-reached");
  });

  it("writes REPORT.md and keeps the notifier summary below 4 KB", () => {
    const ledger = run(); const state = stateOf(ledger); const path = writeReport(fresh(), state, ledger.entries(), [], options);
    expect(readFileSync(path, "utf8")).toEqual(renderReport(state, ledger.entries(), [], options));
    const summary = notifierSummary(state, ledger.entries());
    expect(summary).toContain("1 Taste"); expect(summary).not.toMatch(/[\r\n]/); expect(Buffer.byteLength(summary)).toBeLessThan(4096);
  });
});
