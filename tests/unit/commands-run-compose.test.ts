import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareProductionRun } from "../../packages/cli/src/commands/run-compose.ts";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { createE2EProject, type E2EProject } from "../integration/e2e-helpers.ts";

const projects: E2EProject[] = [];
afterEach(() => projects.splice(0).forEach((p) => p.cleanup()));
function project(approveChecks = true) {
  const p = createE2EProject({ scenario: "happy", approveChecks }); projects.push(p);
  return p;
}
const context = (p: E2EProject, extra: object = {}) => ({ projectId: p.projectId, projectDir: p.projectDir, jarvisHome: p.jarvisHome, repoPath: p.repoPath, ...extra });
const seams = { preflight: async () => true, reprobe: async () => true, createReview: () => async () => "pass" as const };
function writePlan(p: E2EProject, criteria = true) {
  mkdirSync(join(p.repoPath, ".jarvis"), { recursive: true });
  const tasks = p.tasks.map((t) => ({ id: t.id, title: t.title, goal: t.goal, exitCondition: t.exitCondition, acceptanceCriteria: criteria ? t.criteria : [], storyIds: [t.story], dependencies: t.dependencies, priority: t.priority, requiredChecks: t.requiredChecks, requiredReviews: t.requiredReviews }));
  writeFileSync(join(p.repoPath, ".jarvis", "plan.json"), JSON.stringify({ tasks }));
}

describe("jarvis run production composition", () => {
  it("loads the approved checks, the run branch and the architect's plan judged against the committed spec", async () => {
    const p = project(); writePlan(p);
    const opts = await prepareProductionRun(context(p), { home: p.home, ...seams });
    expect(Object.keys(opts.checks).sort()).toEqual(["ac1", "ac2", "ac3", "unit"]);
    expect(opts.runBranch).toBe(p.runBranch);
    expect(opts.plan?.tasks.map((t) => t.id)).toEqual(["T1", "T2"]);
    expect(opts.worktreeRoot).toBe(join(p.home, ".jarvis-work", "worktrees"));
    expect(typeof opts.createHarness).toBe("function"); expect(typeof opts.recoverIntake).toBe("function");
  });

  it("refuses to start without approved protected checks", async () => {
    const p = project(false);
    await expect(prepareProductionRun(context(p), { home: p.home, ...seams })).rejects.toThrow(/approved/);
  });

  it("refuses a plan that doesn't cover the committed spec's criteria", async () => {
    const p = project(); writePlan(p, false);
    await expect(prepareProductionRun(context(p), { home: p.home, ...seams })).rejects.toThrow(/cover|AC/);
  });

  it("judges coverage against the committed spec, not an edited working copy", async () => {
    const p = project(); writePlan(p);
    writeFileSync(join(p.repoPath, "docs/spec/v1.md"), "not a spec\n");
    await expect(prepareProductionRun(context(p), { home: p.home, ...seams })).resolves.toMatchObject({ runBranch: p.runBranch });
  });

  it("refuses a detached checkout", async () => {
    const p = project();
    safeGit(p.repoPath, ["checkout", "-q", "--detach"], { home: p.gitHome });
    await expect(prepareProductionRun(context(p), { home: p.home, ...seams })).rejects.toThrow(/branch/);
  });

  it("reads a session plan only when one is named", async () => {
    const p = project();
    mkdirSync(join(p.repoPath, ".jarvis", "onboard"), { recursive: true });
    writeFileSync(join(p.repoPath, ".jarvis", "onboard", "plan.json"), JSON.stringify({ tasks: [{ id: "T1", title: "Tidy", goal: "Tidy src", exitCondition: "unit passes", acceptanceCriteria: [], storyIds: [], dependencies: [], priority: 0, requiredChecks: ["unit"], requiredReviews: ["code"] }] }));
    expect((await prepareProductionRun(context(p), { home: p.home, ...seams })).plan).toBeUndefined();
    expect((await prepareProductionRun(context(p, { planKind: "onboard" }), { home: p.home, ...seams })).plan?.tasks.map((t) => t.goal)).toEqual(["Tidy src"]);
  });

  it("uses the injected reviewer hook", async () => {
    const p = project(); const review = vi.fn(async () => "pass" as const);
    const opts = await prepareProductionRun(context(p), { home: p.home, ...seams, createReview: () => review });
    expect(opts.review).toBe(review);
  });
});
