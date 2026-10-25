// Shared fixture for the runner loop tests (tests/unit/runner-loop-*.test.ts). Each test file calls
// `afterEach(removeFixtureRoots)` so every fixture's temp folder is removed after its test.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import type { GateInput, GateResult, GateStatus } from "../../../packages/cli/src/checks/gate.ts";
import { safeGit } from "../../../packages/cli/src/eval/git.ts";
import { Ledger } from "../../../packages/cli/src/ledger/ledger.ts";
import type { LoopTaskInput, RunLoopOptions } from "../../../packages/cli/src/runner/loop.ts";
import type { TaskOutcome } from "../../../packages/cli/src/runner/harness.ts";

const roots: string[] = [];
export const removeFixtureRoots = () => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true }));
export const finished = (status: TaskOutcome["status"] = "finished"): TaskOutcome => ({ status, exitCode: 0, durationMs: 1, usage: [], usageWaitUntil: undefined, ...(status === "usage-limited" ? { resetAt: 2 } : {}) } as TaskOutcome);
export function fixture(count = 1) {
  const root = mkdtempSync(join(tmpdir(), "loop-")); roots.push(root);
  const repoPath = join(root, "repo"), jarvisHome = join(root, "jarvis"), projectDir = join(jarvisHome, "projects/p");
  mkdirSync(repoPath, { recursive: true });
  const git = (args: string[]) => safeGit(repoPath, args, { home: root }).toString().trim();
  git(["init", "-q", "-b", "main"]); writeFileSync(join(repoPath, ".gitignore"), ".jarvis/\n");
  git(["add", "-A"]); git(["commit", "-qm", "base"]);
  const ledger = Ledger.open(projectDir);
  for (let i = 1; i <= count; i++) ledger.append({ kind: "task_created", actor: "runner", task_id: `T${i}`, data: { title: `Task ${i}`, goal: `Goal ${i}`, exitCondition: "proven", mayTouch: [`T${i}.txt`], requiredChecks: ["unit"], requiredReviews: ["code"] } });
  let pgid = 2_000_000_000;
  const calls: LoopTaskInput[] = [];
  let body = async (input: LoopTaskInput): Promise<TaskOutcome> => { writeFileSync(join(input.workspace, `${/Task: (T\d+)/.exec(input.prompt)![1]}.txt`), "built"); return finished(); };
  const harness = { runTask: vi.fn(async (input: LoopTaskInput) => {
    calls.push(input); const id = pgid++;
    if (calls.length > 12) throw new Error("fake harness call budget exceeded");
    if (!input.onSpawn(id)) { input.onGroupExit(id); return finished("error"); }
    try { return await body(input); } finally { input.onGroupExit(id); }
  }) };
  const gate = vi.fn(async (g: GateInput): Promise<GateResult> => recordGate(g, "pass"));
  const review = vi.fn(async () => "pass" as const);
  let t = 1000;
  const sleep = vi.fn(async (ms: number) => { t += ms; });
  const options: RunLoopOptions = { projectId: "p", projectDir, jarvisHome, repoPath, runBranch: "main", workRoot: join(root, "work"), worktreeRoot: join(root, "work/trees"), gitHome: root, harness, checks: { unit: { name: "unit", cases: [{ id: "x", command: "true" }], verify: "true", timeoutMs: 10 } }, review, gate, verifyEvidence: () => ({ ok: true, problems: [] }), readProcessStartTime: () => "started", kill: () => {}, now: () => t, sleep, reprobe: async () => true, usageMarginMs: 0 };
  return { root, repoPath, projectDir, ledger, git, calls, harness, gate, review, sleep, options, setBody: (fn: typeof body) => { body = fn; } };
}
export function recordGate(g: GateInput, status: GateStatus): GateResult {
  const entry = g.ledger.append({ kind: "gate_result", actor: "runner", task_id: g.taskId, attempt_id: g.attemptId, data: { status, revision: g.revision, check: g.check.name, evidence: { dir: "unused", files: {} } } });
  return { status, entry, evidenceDir: "unused" };
}
export const data = (e: { data: unknown }) => e.data as Record<string, unknown>;

// ---- Opus review of loop.ts (H1, M1, M2, L1-L5, test gaps) ----------------------------------------

export type Fixture = ReturnType<typeof fixture>;
/** Every run-branch revision since the base, and last-green, was gated (every check) and reviewed (every reviewer) as that exact revision. */
export function expectEveryPromotedRevisionGated(f: Fixture, start: string, checks = ["unit"], reviewers = ["code"]): void {
  const entries = f.ledger.entries();
  const chain = f.git(["rev-list", "--first-parent", `${start}..main`]).split("\n").filter(Boolean);
  expect(chain.length).toBeGreaterThan(0);
  const promoted = new Set([...chain, f.git(["rev-parse", "last-green"])]);
  for (const revision of promoted) {
    for (const check of checks) expect(entries.some((e) => e.kind === "gate_result" && data(e).revision === revision && data(e).check === check && data(e).status === "pass"), `${check} gate at ${revision}`).toBe(true);
    for (const reviewer of reviewers) expect(entries.some((e) => e.kind === "review_result" && data(e).revision === revision && data(e).reviewer === reviewer && data(e).status === "pass"), `${reviewer} review at ${revision}`).toBe(true);
  }
}
export const taskOf = (input: LoopTaskInput) => /Task: (T\d+)/.exec(input.prompt)![1]!;
export const commitBase = (f: Fixture, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) writeFileSync(join(f.repoPath, path), text);
  f.git(["add", "-A"]); f.git(["commit", "-qm", "base files"]);
};
export const showAt = (f: Fixture, revision: string, path: string) => { try { return safeGit(f.repoPath, ["show", `${revision}:${path}`], { home: f.root }).toString().trim(); } catch { return null; } };
