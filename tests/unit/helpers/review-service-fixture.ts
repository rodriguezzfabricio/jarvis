// Shared fixture for the loop reviewer boundary tests (tests/unit/review-service-*.test.ts). Each test file
// calls `afterEach(removeFixtureRoots)` so every fixture's temp folder is removed after its test.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { Ledger } from "../../../packages/cli/src/ledger/ledger.ts";
import { safeGit } from "../../../packages/cli/src/eval/git.ts";
import { DEFAULT_ROUTING, type RoutingTable } from "../../../packages/cli/src/runner/routing.ts";
import type { ReviewerInput, ReviewerOutput } from "../../../packages/cli/src/review/types.ts";

const roots: string[] = [];
export const removeFixtureRoots = () => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); };
export const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export function setup(tier: 0 | 1 | 2 = 2) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "review-service-"))); roots.push(root);
  const repoPath = join(root, "repo"), workRoot = join(root, "work"), projectDir = join(root, "runner");
  for (const d of [repoPath, workRoot, projectDir]) mkdirSync(d);
  const git = (args: string[]) => safeGit(repoPath, args, { home: root }).toString().trim();
  git(["init", "--quiet"]); writeFileSync(join(repoPath, "app.txt"), "before\n"); git(["add", "."]); git(["commit", "--quiet", "-m", "base"]);
  const baseRevision = git(["rev-parse", "HEAD"]);
  writeFileSync(join(repoPath, "app.txt"), "candidate\n");
  mkdirSync(join(repoPath, ".jarvis/notes"), { recursive: true }); writeFileSync(join(repoPath, ".jarvis/notes/T1.md"), "BUILDER-NARRATIVE-SECRET");
  git(["add", "."]); git(["commit", "--quiet", "-m", "BUILDER-NARRATIVE-SECRET"]);
  const revision = git(["rev-parse", "HEAD"]);
  writeFileSync(join(repoPath, "app.txt"), "dirty edits should not be reviewed");
  const ledger = Ledger.open(projectDir);
  const evidenceDir = join(projectDir, "evidence/gate"); mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, "stdout"), "RUNNER-PROOF");
  ledger.append({ kind: "gate_result", actor: "runner", task_id: "T1", attempt_id: "A1", data: { revision, status: "pass", check: "test", evidence: { dir: evidenceDir, files: { stdout: sha("RUNNER-PROOF") } } } });
  const called: { engine: string; input: ReviewerInput }[] = [];
  const reviewer = (engine: "claude" | "codex") => vi.fn(async (input: ReviewerInput): Promise<ReviewerOutput> => {
    called.push({ engine, input });
    expect(readFileSync(join(input.workspace, "app.txt"), "utf8")).toBe("candidate\n");
    expect(existsSync(join(input.workspace, ".jarvis"))).toBe(false);
    expect(existsSync(join(input.workspace, ".git"))).toBe(false);
    expect(input.prompt).not.toContain("BUILDER-NARRATIVE-SECRET");
    expect(input.prompt).toContain("RUNNER-PROOF");
    expect(input.prompt).toContain("+candidate");
    expect(input.prompt).toContain("AC1: keeps revision immutable");
    return { reviewer: engine, model: input.model, rawOutput: `${engine}-raw`, rawVerdict: '{"findings":[]}' };
  });
  const claude = reviewer("claude"), codex = reviewer("codex");
  const options = { ledger, projectDir, workRoot, home: root, routing: structuredClone(DEFAULT_ROUTING) as RoutingTable & { cross_model?: { codex: { model: string; effort: "medium" | "high" } } },
    resolveMaterial: async () => ({ repoPath, baseRevision, tier, spec: "Approved spec", acceptanceCriteria: ["AC1: keeps revision immutable"] }), claude, codex };
  return { root, options, called, claude, codex, ledger, evidenceDir, baseRevision, request: { taskId: "T1", attemptId: "A1", revision } };
}
