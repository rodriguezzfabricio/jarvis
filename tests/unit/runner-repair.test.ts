import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { decideRepair } from "../../packages/cli/src/runner/repair.ts";
import { rebuildState } from "../../packages/cli/src/runner/state.ts";

const roots: string[] = [];
const fresh = () => { const root = mkdtempSync(join(tmpdir(), "jarvis-repair-")); roots.push(root); return root; };
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
const revision = "c".repeat(40);
function run(failures: number, last: "completed" | "usage_wait" | "crash" = "completed", status = "fail") {
  const ledger = Ledger.open(fresh());
  ledger.append({ kind: "task_created", actor: "runner", task_id: "T1", data: { title: "Login" } });
  ledger.append({ kind: "run_started", actor: "runner", data: { runId: "run", pid: 333 } });
  for (let n = 1; n <= failures; n++) {
    const attempt_id = `a${n}`;
    ledger.append({ kind: "attempt_started", actor: "runner", task_id: "T1", attempt_id, data: { runId: "run" } });
    const outcome = n === failures ? last : "completed";
    if (outcome !== "crash") ledger.append({ kind: "attempt_ended", actor: "runner", task_id: "T1", attempt_id, data: { status: outcome, candidateRevision: revision } });
    const dir = join(ledger.dir, "evidence", attempt_id); mkdirSync(join(dir, "cases", "login"), { recursive: true });
    const outputs = { "cases/login/stdout": Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"), "cases/login/stderr": "Expected 2, got 1", "cases/login/code": "7\n" };
    const files: Record<string, string> = {};
    for (const [path, value] of Object.entries(outputs)) { writeFileSync(join(dir, path), value); files[path] = createHash("sha256").update(value).digest("hex"); }
    ledger.append({ kind: "gate_result", actor: "runner", task_id: "T1", attempt_id, data: { check: "unit", revision, status, caseResults: [{ id: "login", code: 7, timedOut: false }], evidence: { dir, files }, secretExtra: "DO_NOT_DUMP_GATE_JSON" } });
  }
  return ledger;
}
const task = (ledger: Ledger) => rebuildState(ledger.entries(), { now: 0 }).tasks.T1!;
const alternative = { decisionId: "D1", from: "primary", to: "fallback" };

describe("shared-state repair policy", () => {
  it.each([1, 2])("offers repair %i after the corresponding completed failed attempt", (count) => {
    const decision = decideRepair(task(run(count)), { kind: "failure" });
    expect(decision).toMatchObject({ kind: "repair", repairNumber: count });
  });

  it("carries verified bounded output tails and exit codes rather than gate JSON", () => {
    const decision = decideRepair(task(run(1)), { kind: "failure" });
    if (decision.kind !== "repair") throw new Error("expected repair");
    for (const text of ["line 99", "Expected 2, got 1", "exit 7", revision, "unit"]) expect(decision.prompt).toContain(text);
    expect(decision.prompt).not.toContain("line 0\n");
    expect(decision.prompt).not.toContain("DO_NOT_DUMP_GATE_JSON");
    expect(Buffer.byteLength(decision.prompt)).toBeLessThanOrEqual(16_384);
  });

  it("blocks after three failed completed attempts with one short human reason and a durable alternative switch", () => {
    const ledger = run(3); const result = decideRepair(task(ledger), { kind: "failure" }, { criticalPath: true, alternative });
    expect(result).toMatchObject({ kind: "blocked", entry: { kind: "blocked", actor: "runner", task_id: "T1" }, alternative: { kind: "decision", actor: "runner", task_id: "T1", data: { type: "alternative_switch", ...alternative } } });
    if (result.kind !== "blocked") throw new Error("expected blocked");
    const reason = (result.entry.data as { reason: string }).reason;
    expect(reason).not.toMatch(/[\r\n]/); expect(reason.length).toBeLessThanOrEqual(200);
    expect(reason).toContain("unit");
    ledger.append(result.alternative!);
    expect(decideRepair(task(ledger), { kind: "failure" }, { criticalPath: true, alternative })).not.toHaveProperty("alternative");
    expect(decideRepair(task(run(3)), { kind: "failure" }, { criticalPath: false, alternative })).not.toHaveProperty("alternative");
  });

  it.each(["usage_wait", "runner_crash"] as const)("never charges or blocks on %s", (kind) => {
    expect(decideRepair(task(run(3)), { kind })).toEqual({ kind: "resume" });
  });

  it.each(["usage_wait", "crash"] as const)("does not turn a %s into a completed failure", (last) => {
    expect(decideRepair(task(run(3, last)), { kind: "failure" })).toEqual({ kind: "resume" });
  });

  it("blocks tampered checks immediately without repair or alternative", () => {
    expect(decideRepair(task(run(1, "completed", "tampered")), { kind: "failure" }, { criticalPath: true, alternative })).toMatchObject({ kind: "blocked", entry: { data: { reason: "protected check changed" } } });
    expect(decideRepair(task(run(1, "completed", "tampered")), { kind: "failure" }, { criticalPath: true, alternative })).not.toHaveProperty("alternative");
  });

  it("uses named review failures and never charges broker-authored failures", () => {
    const ledger = run(1, "completed", "pass");
    ledger.append({ kind: "review_result", actor: "runner", task_id: "T1", attempt_id: "a1", data: { reviewer: "code", status: "fail", revision, summary: "Missing AC1" } });
    const decision = decideRepair(task(ledger), { kind: "failure" });
    expect(decision).toMatchObject({ kind: "repair", repairNumber: 1 });
    if (decision.kind === "repair") expect(decision.prompt).toContain("code: Missing AC1");
    const forged = run(1, "completed", "pass");
    forged.append({ kind: "review_result", actor: "broker", task_id: "T1", attempt_id: "a1", data: { reviewer: "code", status: "fail", revision } });
    expect(decideRepair(task(forged), { kind: "failure" })).toEqual({ kind: "resume" });
  });
});
