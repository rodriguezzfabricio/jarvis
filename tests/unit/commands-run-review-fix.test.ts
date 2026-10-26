// `jarvis run --plan review` (decision 126, backlog 109): the interactive review session wrote the report
// and .jarvis/review/findings.json in the checkout; the runner commits the report, plans one bug task per
// finding, and its drive runs the fixes, then the report update. Fault injection: no report, a symlink.
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SignalHost } from "../../packages/cli/src/broker/host.ts";
import { prepareProductionRun, reviewMaterialFor, type ComposeOptions, type ReviewDeps } from "../../packages/cli/src/commands/run-compose.ts";
import { register, type PreparedRun } from "../../packages/cli/src/commands/run.ts";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import type { RunLoopOptions, RunLoopResult } from "../../packages/cli/src/runner/loop.ts";
import { BUG_EXIT_CONDITION, readSessionPlan, SESSION_PLAN_KINDS } from "../../packages/cli/src/runner/plan.ts";
import { REVIEW_FINDINGS_FILE } from "../../packages/cli/src/runner/review-fix.ts";
import { createE2EProject, type E2EProject } from "../integration/e2e-helpers.ts";

const projects: E2EProject[] = [];
const prepared: PreparedRun[] = [];
afterEach(async () => {
  for (const p of prepared.splice(0)) await p.close();
  projects.splice(0).forEach((p) => p.cleanup());
});
class FakeHost extends EventEmitter implements SignalHost { readonly pid = 4242; kill() { return true; } }
const put = (root: string, rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
const git = (p: E2EProject, args: string[]) => safeGit(p.repoPath, args, { home: p.gitHome }).toString().trim();

const REQUEST = "Review the adder and fix the real problems.";
const REPORT = "# Review\n\n## F1: src/add.mjs:1 (high)\nAdds strings. Fix: coerce.\n\n## Not a problem\n- test/add.test.mjs:1\n";
const FINDINGS = JSON.stringify({ request: REQUEST, report: "REVIEW.md", cleared: [],
  findings: [{ id: "F1", title: "add() concatenates strings", severity: "high", confidence: "medium", file: "src/add.mjs", line: 1, evidence: "The CLI passes argv strings to add().", fix: "Coerce both arguments to numbers." }] });

let captured: ReviewDeps | undefined;
function project(write = true): E2EProject {
  const p = createE2EProject({ scenario: "happy", approveChecks: true }); projects.push(p);
  if (write) { put(p.repoPath, "REVIEW.md", REPORT); put(p.repoPath, REVIEW_FINDINGS_FILE, FINDINGS); }
  return p;
}
async function prepare(p: E2EProject, extra: Partial<ComposeOptions> = {}, reviewReport?: string): Promise<PreparedRun> {
  const run = await prepareProductionRun({ projectId: p.projectId, projectDir: p.projectDir, jarvisHome: p.jarvisHome, repoPath: p.repoPath, planKind: "review", ...(reviewReport ? { reviewReport } : {}) }, {
    home: p.home, preflight: async () => true, reprobe: async () => true, signals: new FakeHost(), warn: () => {},
    createReview: (deps) => { captured = deps; return async () => "pass" as const; }, ...extra,
  });
  prepared.push(run);
  return run;
}
/** The refusal's message, or a line that fails the match: an assertion, never a thrown error, decides (decision 115). */
const refusal = (run: Promise<unknown>) => run.then(() => "no error: the run was prepared", (e: unknown) => (e instanceof Error ? e.message : String(e)));
const socketsIn = (p: E2EProject) => existsSync(join(p.jarvisHome, "run")) ? readdirSync(join(p.jarvisHome, "run")).filter((n) => n.endsWith(".sock")) : [];

describe("jarvis run --plan review", () => {
  it("is a run plan kind the CLI accepts, and its findings are never read as a plan file", () => {
    expect(SESSION_PLAN_KINDS).toContain("review");
    const p = project();
    put(p.repoPath, ".jarvis/review/plan.json", JSON.stringify({ tasks: [{ id: "T1", title: "x", goal: "x", exitCondition: "x", acceptanceCriteria: [], storyIds: [], dependencies: [], priority: 0, requiredChecks: ["unit"], requiredReviews: ["code"] }] }));
    expect(() => readSessionPlan(p.repoPath, "review", [{ name: "unit" }])).toThrow(/not a plan/);
  });

  it("commits the session's report on the run branch, and plans one bug task per finding", async () => {
    const p = project();
    const before = git(p, ["rev-parse", "HEAD"]);
    const run = await prepare(p);
    // Assertions that can't throw first: the run branch moved, and the checkout is clean (promotion needs it; .jarvis/ is excluded).
    expect(git(p, ["rev-parse", "HEAD"])).not.toBe(before);
    expect(git(p, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
    expect(git(p, ["rev-parse", "HEAD^"])).toBe(before);
    expect(git(p, ["show", "HEAD:REVIEW.md"])).toBe(REPORT.trimEnd());
    expect(git(p, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])).toBe("REVIEW.md");
    expect(run.loop.plan?.tasks.map((t) => [t.id, t.requiredChecks, t.requiredReviews])).toEqual([["T1", ["unit"], ["code"]]]);
    expect(run.loop.plan?.tasks[0]!.exitCondition).toContain(BUG_EXIT_CONDITION);
    expect(run.loop.plan?.tasks[0]!.goal).toContain(REQUEST);
    expect(typeof run.drive).toBe("function");
  });

  // Codex security review, round 1 (high 1): the session's findings file never picks the file the runner commits.
  it("takes the report path from the run (--report, else REVIEW.md), never from the session's findings", async () => {
    const p = project(false);
    put(p.repoPath, "OTHER.md", "# Review\n\n## F1: src/add.mjs:1 (high)\nAdds strings.\n");
    put(p.repoPath, REVIEW_FINDINGS_FILE, FINDINGS.replace("\"report\":\"REVIEW.md\"", "\"report\":\"OTHER.md\""));
    const head = git(p, ["rev-parse", "HEAD"]);
    expect(await refusal(prepare(p))).toMatch(/wrote no report at REVIEW\.md/);
    put(p.repoPath, "REVIEW.md", REPORT);
    expect(await refusal(prepare(p))).toMatch(/names the report OTHER\.md, not REVIEW\.md/);
    expect(git(p, ["rev-parse", "HEAD"])).toBe(head);
    expect(socketsIn(p)).toEqual([]);
    const run = await prepare(p, {}, "OTHER.md");
    expect(git(p, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])).toBe("OTHER.md");
    expect(run.loop.plan?.tasks.map((t) => t.id)).toEqual(["T1"]);
  });

  it("refuses a build file named as the report, before anything is committed or hosted", async () => {
    const p = project(false);
    put(p.repoPath, "requirements.txt", "evil-package==6.6.6\n");
    put(p.repoPath, REVIEW_FINDINGS_FILE, JSON.stringify({ request: REQUEST, report: "requirements.txt", findings: [], cleared: [] }));
    const head = git(p, ["rev-parse", "HEAD"]);
    expect(await refusal(prepare(p, {}, "requirements.txt"))).toMatch(/refused/);
    expect(git(p, ["rev-parse", "HEAD"])).toBe(head);
    expect(socketsIn(p)).toEqual([]);
  });

  it("numbers the fix tasks after the project's own, which the loop would never re-create", async () => {
    const p = project();
    Ledger.open(p.projectDir).append({ kind: "task_created", actor: "runner", task_id: "T1", data: { title: "earlier", goal: "an earlier task", exitCondition: "done", acceptanceCriteria: [], storyIds: [], dependencies: [], priority: 0, requiredChecks: ["unit"], requiredReviews: ["code"] } });
    const run = await prepare(p);
    expect(run.loop.plan?.tasks.map((t) => t.id)).toEqual(["T2"]);
    // As the loop seeds it; then planning the same findings again keeps that task instead of adding T3.
    const { id, ...data } = run.loop.plan!.tasks[0]!;
    Ledger.open(p.projectDir).append({ kind: "task_created", actor: "runner", task_id: id, data });
    await prepared.splice(prepared.indexOf(run), 1)[0]!.close();
    const again = await prepare(p);
    expect(again.loop.plan?.tasks.map((t) => t.id)).toEqual(["T2"]);
  });

  it("leaves a report already committed as it stands", async () => {
    const p = project();
    git(p, ["add", "--", "REVIEW.md"]);
    git(p, ["commit", "-q", "--no-verify", "-m", "review"]);
    const head = git(p, ["rev-parse", "HEAD"]);
    await prepare(p);
    expect(git(p, ["rev-parse", "HEAD"])).toBe(head);
  });

  it("refuses to start when the review session wrote no report, or a symlinked one, and hosts nothing", async () => {
    const none = project(false);
    put(none.repoPath, REVIEW_FINDINGS_FILE, FINDINGS);
    expect(await refusal(prepare(none))).toMatch(/wrote no report at REVIEW\.md/);
    expect(socketsIn(none)).toEqual([]);
    const linked = project(false);
    put(linked.repoPath, "real.md", REPORT);
    symlinkSync("real.md", join(linked.repoPath, "REVIEW.md"));
    put(linked.repoPath, REVIEW_FINDINGS_FILE, FINDINGS);
    const head = git(linked, ["rev-parse", "HEAD"]);
    expect(await refusal(prepare(linked))).toMatch(/REVIEW\.md is refused/);
    expect(git(linked, ["rev-parse", "HEAD"])).toBe(head);
    expect(socketsIn(linked)).toEqual([]);
  });

  it("reviews each fix against its finding with the bug brief, and the report update without it", async () => {
    const p = project();
    const run = await prepare(p);
    const fix = reviewMaterialFor(captured!, "T1", git(p, ["rev-parse", "HEAD"]));
    expect(fix.kind).toBe("bug");
    expect(fix.spec).toContain(REQUEST);
    expect(fix.spec).toContain("src/add.mjs:1");
    expect(fix.acceptanceCriteria).toEqual([run.loop.plan!.tasks[0]!.exitCondition]);
    Ledger.open(p.projectDir).append({ kind: "task_created", actor: "runner", task_id: "T2", data: { title: "update", goal: "update the report", exitCondition: "the report says it", acceptanceCriteria: [], storyIds: [], dependencies: [], priority: 0, requiredChecks: ["unit"], requiredReviews: ["code"], mayTouch: ["REVIEW.md"] } });
    const update = reviewMaterialFor(captured!, "T2", git(p, ["rev-parse", "HEAD"]));
    expect(update.kind).toBeUndefined();
    expect(update.spec).toContain("update the report");
  });

  it("drives the fixes, then the report update with what happened, through the same loop", async () => {
    const p = project();
    const run = await prepare(p);
    const calls: RunLoopOptions[] = [];
    const loop = async (o: RunLoopOptions): Promise<RunLoopResult> => {
      calls.push(o);
      const ledger = Ledger.open(o.projectDir);
      for (const { id, ...data } of o.plan?.tasks ?? []) {
        ledger.append({ kind: "task_created", actor: "runner", task_id: id, data });
        if (id === "T1") ledger.append({ kind: "blocked", actor: "runner", task_id: id, data: { reason: "review code needs investigation" } });
      }
      return calls.length === 1 ? { status: "blocked", done: [], blocked: ["T1"] } : { status: "blocked", done: ["T2"], blocked: ["T1"] };
    };
    const result = await run.drive!(loop);
    expect(calls.map((c) => c.plan?.tasks.map((t) => t.id))).toEqual([["T1"], ["T2"]]);
    expect(calls[1]!.plan!.tasks[0]!.mayTouch).toEqual(["REVIEW.md"]);
    expect(calls[1]!.plan!.tasks[0]!.goal).toContain("review code needs investigation");
    expect(calls[1]).toMatchObject({ runBranch: run.loop.runBranch, repoPath: run.loop.repoPath, checks: run.loop.checks });
    expect(result).toEqual({ status: "blocked", done: ["T2"], blocked: ["T1"] });
  });
});

describe("jarvis run --report", () => {
  const { Command } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("commander") as { Command: new () => Parameters<typeof register>[0] };
  async function cli(args: string[], seams: Partial<Parameters<typeof register>[1]> = {}) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cmd-run-report-")));
    mkdirSync(join(root, ".git"));
    const contexts: unknown[] = [];
    let probes = 0;
    const program = new Command().exitOverride();
    register(program, { jarvisHome: root, cwd: root, env: { JARVIS_PROJECT: "p" }, keepAwake: () => {}, output: () => {},
      probe: async () => { probes++; return { ok: true }; },
      run: async (context) => { contexts.push(context); return { status: "complete", done: [], blocked: [] }; }, ...seams });
    try {
      const error = await program.parseAsync(["run", ...args], { from: "user" }).then(() => undefined, (e: unknown) => e as Error);
      return { error, contexts, probes };
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  it("passes a checked report path to the run, only with --plan review, before the probe", async () => {
    const ok = await cli(["--plan", "review", "--report", "docs/security-review.md"]);
    expect(ok.error).toBeUndefined();
    expect(ok.contexts).toEqual([expect.objectContaining({ planKind: "review", reviewReport: "docs/security-review.md" })]);
    for (const args of [["--plan", "review", "--report", "CMakeLists.txt"], ["--plan", "review", "--report", "../REVIEW.md"], ["--plan", "review", "--report", "[C]MakeLists.md"], ["--report", "REVIEW.md"], ["--plan", "sweep", "--report", "REVIEW.md"]]) {
      const r = await cli(args);
      expect(r.error?.message ?? "no error", args.join(" ")).toMatch(/--report/);
      expect(r.probes, args.join(" ")).toBe(0);
      expect(r.contexts, args.join(" ")).toEqual([]);
    }
  });

  it("hands --report to a detached runner", async () => {
    const spawned: string[][] = [];
    const spawn = (_bin: string, args: string[]) => { spawned.push(args); return { pid: 1, unref: () => {}, once: (event: string, cb: () => void) => { if (event === "spawn") queueMicrotask(cb); } }; };
    const r = await cli(["--plan", "review", "--report", "docs/r.md", "--detach"], { spawn, entrypoint: "/runner/cli.ts" });
    expect(r.error).toBeUndefined();
    expect(spawned[0]).toEqual(expect.arrayContaining(["--plan", "review", "--report", "docs/r.md"]));
  });
});

describe("jarvis run drives a prepared run's own phases", () => {
  it("calls the prepared drive with the loop instead of running the loop once", async () => {
    const { Command } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("commander") as { Command: new () => Parameters<typeof register>[0] };
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cmd-run-drive-")));
    try {
      mkdirSync(join(root, ".git"));
      const result: RunLoopResult = { status: "complete", done: ["T1", "T2"], blocked: [] };
      const runLoop = vi.fn(async () => result);
      const drive = vi.fn(async (loop: (o: RunLoopOptions) => Promise<RunLoopResult>) => { await loop({} as RunLoopOptions); return loop({} as RunLoopOptions); });
      const finished = vi.fn(async () => {});
      const program = new Command().exitOverride();
      register(program, { jarvisHome: root, cwd: root, env: { JARVIS_PROJECT: "p" }, probe: async () => ({ ok: true }), keepAwake: () => {}, output: () => {},
        prepareRun: async () => ({ loop: {} as RunLoopOptions, close: async () => {}, finished, drive }), runLoop });
      await program.parseAsync(["run", "--plan", "review"], { from: "user" });
      expect(drive).toHaveBeenCalledTimes(1);
      expect(runLoop).toHaveBeenCalledTimes(2);
      expect(finished).toHaveBeenCalledWith(result);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
