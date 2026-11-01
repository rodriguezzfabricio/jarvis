import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectId } from "../../packages/cli/src/config/project.ts";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { planFileHash } from "../../packages/cli/src/review/plan-resolve.ts";
import { readPlanCalibration } from "../../packages/cli/src/review/plan-service.ts";
import type { ReviewerInput, ReviewerOutput } from "../../packages/cli/src/review/types.ts";
import { runnerProjectDir } from "../../packages/cli/src/runner/inbox.ts";
import { initRepo } from "./helpers/git-repo.ts";
import { clean, lensOf, seedCalibration, withFindings } from "./helpers/plan-review-fixture.ts";

const { Command } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("commander") as { Command: new () => Parameters<typeof import("../../packages/cli/src/commands/plan.ts").register>[0] };
const FIXTURES = fileURLToPath(new URL("../fixtures/plan-review/", import.meta.url));
const roots: string[] = [];
const originalExitCode = process.exitCode;
afterEach(() => { process.exitCode = originalExitCode; for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const SPEC = `---
spec: 1
date: 2026-10-28
status: confirmed
supersedes: none
---
## Goals
- Return the result.
## Non-goals
None.
## User stories
- **S1 (P1):** As a user, I want a result.
## Acceptance criteria
- **AC1 (S1):** WHEN asked THE SYSTEM SHALL return the result.
## Assumptions
None.
## Open questions
None.
`;
const REGISTER = "| ID | Date | Decision | Made by | Status | Source | Class | Reversibility | Why | Alternatives | Depends on | Supersedes |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| D1 | 2026-10-30 | Keep the file store | jarvis | active | src/app.mjs | Mechanical | easy | It exists | [] | [] | - |\n";
const PLAN = { tier: 1, tasks: [{ id: "T1", title: "Result", goal: "Return the result", exitCondition: "AC1 passes", acceptanceCriteria: ["AC1"], storyIds: ["S1"], dependencies: [], priority: 1, requiredChecks: ["ac1"], requiredReviews: ["code"] }] };
const planted = (lens: "zoom-out" | "critic" | "readiness") => lens === "zoom-out" ? withFindings(lens, [{ severity: "major", scope: "T2" }]) : lens === "critic" ? withFindings(lens, [{ severity: "blocker", scope: "D3" }]) : withFindings(lens, [{ severity: "major", scope: "T3" }]);

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plan-cmd-"))); roots.push(root);
  const home = join(root, "home"), repo = join(root, "repo");
  mkdirSync(home, { mode: 0o700 }); mkdirSync(repo);
  const git = (args: string[]) => safeGit(repo, args, { home }).toString().trim();
  initRepo(repo, { branch: "main" });
  mkdirSync(join(repo, "docs", "spec"), { recursive: true }); mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "docs", "spec", "v1.md"), SPEC); writeFileSync(join(repo, "docs", "decisions.md"), REGISTER);
  writeFileSync(join(repo, "src", "app.mjs"), "export const result = 1;\n"); writeFileSync(join(repo, ".gitignore"), ".jarvis/\n");
  git(["add", "-A"]); git(["commit", "--quiet", "-m", "base"]);
  mkdirSync(join(repo, ".jarvis"), { recursive: true }); writeFileSync(join(repo, ".jarvis", "plan.json"), JSON.stringify(PLAN));
  const projectDir = runnerProjectDir(projectId(repo), join(home, ".jarvis"));
  mkdirSync(join(projectDir, "checks"), { recursive: true, mode: 0o700 });
  writeFileSync(join(projectDir, "checks", "ac1.check.json"), JSON.stringify({ name: "ac1", criteria: ["AC1"], cases: [{ id: "main", command: "node src/cli.mjs" }], verify: "sh v.sh", timeoutMs: 1000 }));
  const seen: string[][] = [];
  const reviewer = vi.fn(async (input: ReviewerInput): Promise<ReviewerOutput> => ({ reviewer: "claude", model: input.model, rawOutput: "raw", rawVerdict: clean(lensOf(input.prompt)) }));
  const claude = async (input: ReviewerInput) => { seen.push([existsSync(join(input.workspace, ".jarvis", "plan.json")) ? "plan" : "", existsSync(join(input.workspace, ".jarvis", "checks")) ? "checks" : "", existsSync(join(input.workspace, "src", "util", "retry.mjs")) ? "retry" : ""].filter(Boolean)); return reviewer(input); };
  const out: string[] = [];
  const invoke = async (...args: string[]) => {
    const { register } = await import("../../packages/cli/src/commands/plan.ts");
    const program = new Command().name("jarvis").exitOverride();
    register(program, { home, reviewer: claude, fixturesDir: FIXTURES, out: (text) => out.push(text) });
    process.exitCode = undefined;
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((text: unknown) => { errors.push(String(text)); });
    try { await program.parseAsync(["plan", ...args, "--repo", repo], { from: "user" }); } finally { spy.mockRestore(); }
    return { code: process.exitCode, errors };
  };
  const ledger = () => Ledger.open(projectDir);
  const calibrate = async () => {
    reviewer.mockImplementation(async (input) => ({ reviewer: "claude", model: input.model, rawOutput: "raw", rawVerdict: planted(lensOf(input.prompt)) }));
    await invoke("review", "--calibrate", "bad");
    reviewer.mockImplementation(async (input) => ({ reviewer: "claude", model: input.model, rawOutput: "raw", rawVerdict: clean(lensOf(input.prompt)) }));
    await invoke("review", "--calibrate", "good");
  };
  return { root, home, repo, projectDir, reviewer, seen, out, invoke, ledger, calibrate };
}

describe("jarvis plan (decisions 170, 172)", () => {
  it("reviews the plan against the committed spec, register and approved checks; without a control the verdict does not count and the command fails", async () => {
    const s = setup();
    const r = await s.invoke("review");
    expect(r.code).toBe(1);
    expect(s.out[0]).toContain("Plan review pass (does not count: no passing negative control)");
    expect(s.out.at(-1)).toContain("no passing negative control");
    expect(s.seen).toEqual([["plan", "checks"], ["plan", "checks"], ["plan", "checks"]]);
    expect(JSON.parse(readFileSync(join(s.repo, ".jarvis", "plan-review", "findings.json"), "utf8"))).toMatchObject({ verdict: "error", counts: false, planHash: planFileHash(s.repo) });
    const status = await s.invoke("status");
    expect(status.code).toBe(1); expect(s.out.at(-1)).toContain("does not count");
  });
  it("calibrates on the fixtures (the reviewer sees the fixture repo, plan and checks), then a clean review counts and status accepts the plan", async () => {
    const s = setup();
    await s.calibrate();
    expect(s.seen.slice(0, 6).every((seen) => seen.includes("retry") && seen.includes("plan") && seen.includes("checks"))).toBe(true);
    expect(s.out[0]).toMatch(/^Plan review fail; 3 finding\(s\); control entry [a-f0-9]{64}$/);
    expect(s.out.filter((line) => line.startsWith("Plan review pass; 0 finding(s); control entry"))).toHaveLength(1);
    const r = await s.invoke("review");
    expect(r.code, s.out.join("\n")).toBeUndefined();
    expect(s.out.at(-1)).toBe("Plan review pass; 0 finding(s); findings in .jarvis/plan-review/findings.json");
    expect((await s.invoke("status")).code).toBeUndefined();
    expect(s.out.at(-1)).toContain("jarvis run may build it");
  });
  it("a major is listed, fails the command, and runs only after jarvis plan resolve records a contest with evidence", async () => {
    const s = setup(); seedCalibration(s.ledger());
    s.reviewer.mockImplementation(async (input) => ({ reviewer: "claude", model: input.model, rawOutput: "raw", rawVerdict: lensOf(input.prompt) === "readiness" ? withFindings("readiness", [{ severity: "major", scope: "T1" }]) : clean(lensOf(input.prompt)) }));
    expect((await s.invoke("review")).code).toBe(1);
    expect(s.out.at(-2)).toContain("Plan review resolve; 1 finding(s)"); expect(s.out.at(-1)).toContain("readiness-1 [major] T1");
    expect((await s.invoke("status")).code).toBe(1); expect(s.out.at(-1)).toContain("readiness-1");
    mkdirSync(join(s.repo, ".jarvis", "plan-review"), { recursive: true });
    writeFileSync(join(s.repo, ".jarvis", "plan-review", "resolution.json"), JSON.stringify({ planHash: planFileHash(s.repo), resolutions: [{ id: "readiness-1", action: "contest", evidence: "nope.mjs" }] }));
    const refused = await s.invoke("resolve");
    expect(refused.code).toBe(1); expect(refused.errors.join()).toContain("names no file");
    writeFileSync(join(s.repo, ".jarvis", "plan-review", "resolution.json"), JSON.stringify({ planHash: planFileHash(s.repo), resolutions: [{ id: "readiness-1", action: "contest", evidence: "D1" }] }));
    expect((await s.invoke("resolve")).code).toBeUndefined(); expect(s.out.at(-1)).toContain("Resolution recorded");
    expect((await s.invoke("status")).code).toBeUndefined();
  });
  it("an escalation waits for jarvis plan accept, answered once", async () => {
    const s = setup(); seedCalibration(s.ledger());
    s.reviewer.mockImplementation(async (input) => ({ reviewer: "claude", model: input.model, rawOutput: "raw", rawVerdict: lensOf(input.prompt) === "critic" ? withFindings("critic", [{ severity: "major", scope: "D1" }]) : clean(lensOf(input.prompt)) }));
    await s.invoke("review");
    mkdirSync(join(s.repo, ".jarvis", "plan-review"), { recursive: true });
    writeFileSync(join(s.repo, ".jarvis", "plan-review", "resolution.json"), JSON.stringify({ planHash: planFileHash(s.repo), resolutions: [{ id: "critic-1", action: "escalate", question: "Keep the file store?" }] }));
    expect((await s.invoke("resolve")).code).toBeUndefined(); expect(s.out.at(-1)).toContain("waiting for the user on critic-1");
    expect((await s.invoke("status")).code).toBe(1); expect(s.out.at(-1)).toContain("jarvis plan accept");
    expect((await s.invoke("accept", "critic-1", "--answer", "Yes, keep it.")).code).toBeUndefined();
    expect(s.out.at(-1)).toContain("Answer recorded for critic-1");
    expect((await s.invoke("status")).code).toBeUndefined();
    expect((await s.invoke("accept", "critic-1", "--answer", "Again")).errors.join()).toContain("already answered");
  });
  it("saves a verified calibration pair to the runner home, and refuses malformed flags", async () => {
    const s = setup(); await s.calibrate();
    const controls = s.ledger().entries().filter((e) => (e.data as { purpose?: string; lens?: string }).purpose === "calibration" && (e.data as { lens?: string }).lens === "overall");
    expect(controls).toHaveLength(2);
    expect((await s.invoke("review", "--save-calibration", `${controls[0]!.hash}:${controls[1]!.hash}`)).code).toBeUndefined();
    expect(readPlanCalibration(join(s.home, ".jarvis"))?.record).toMatchObject({ bad: controls[0]!.hash, good: controls[1]!.hash });
    expect((await s.invoke("review", "--save-calibration", `${controls[1]!.hash}:${controls[0]!.hash}`)).code).toBe(1);
    expect((await s.invoke("review", "--save-calibration", "nope")).errors.join()).toContain("two ledger entry hashes");
    expect((await s.invoke("review", "--calibrate", "ugly")).errors.join()).toContain("bad or good");
  });
  it("refuses a repo without an approved spec or a plan", async () => {
    const s = setup();
    rmSync(join(s.repo, ".jarvis", "plan.json"));
    expect((await s.invoke("review")).errors.join()).toMatch(/plan\.json/);
    expect((await s.invoke("status")).errors.join()).toMatch(/plan\.json/);
  });
});
