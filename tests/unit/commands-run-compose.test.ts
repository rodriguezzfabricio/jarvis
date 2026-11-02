import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as brokerHost from "../../packages/cli/src/broker/host.ts";
import { requestBroker } from "../../packages/cli/src/broker/client.ts";
import type { SignalHost } from "../../packages/cli/src/broker/host.ts";
import { prepareProductionRun, reviewDispatch, reviewMaterialFor, type ReviewDeps, type ComposeOptions } from "../../packages/cli/src/commands/run-compose.ts";
import type { PreparedRun } from "../../packages/cli/src/commands/run.ts";
import { approvedDesign } from "../../packages/cli/src/review/design-material.ts";
import { planFileHash } from "../../packages/cli/src/review/plan-resolve.ts";
import { PLAN_POLICY_HASH } from "../../packages/cli/src/review/plan-service.ts";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import type { SessionOutcome, SessionSpec } from "../../packages/cli/src/proc/session.ts";
import type { Message, Notifier } from "../../packages/cli/src/notify/notifier.ts";
import { DEFAULT_ROUTING } from "../../packages/cli/src/runner/routing.ts";
import { createE2EProject, type E2EProject } from "../integration/e2e-helpers.ts";

const projects: E2EProject[] = [];
const prepared: PreparedRun[] = [];
afterEach(async () => {
  for (const p of prepared.splice(0)) await p.close();
  projects.splice(0).forEach((p) => p.cleanup());
});
function project(approveChecks = true) {
  const p = createE2EProject({ scenario: "happy", approveChecks }); projects.push(p);
  return p;
}
class FakeHost extends EventEmitter implements SignalHost {
  readonly pid = 4242;
  kill() { return true; }
}
const context = (p: E2EProject, extra: object = {}) => ({ projectId: p.projectId, projectDir: p.projectDir, jarvisHome: p.jarvisHome, repoPath: p.repoPath, ...extra });
const seams = (extra: Partial<ComposeOptions> = {}): ComposeOptions => ({
  preflight: async () => true, reprobe: async () => true, createReview: () => async () => "pass" as const, signals: new FakeHost(), warn: () => {}, ...extra,
});
async function prepare(p: E2EProject, ctx: object = {}, extra: Partial<ComposeOptions> = {}): Promise<PreparedRun> {
  const options = { home: p.home, ...seams(extra) };
  if (Object.hasOwn(extra, "createDesignReview")) delete options.createReview;
  const run = await prepareProductionRun(context(p, ctx), options);
  prepared.push(run);
  return run;
}
function writePlan(p: E2EProject, criteria = true, notes?: string[], tier?: 0 | 1 | 2, reviewed = true) {
  mkdirSync(join(p.repoPath, ".jarvis"), { recursive: true });
  const tasks = p.tasks.map((t) => ({ id: t.id, title: t.title, goal: t.goal, exitCondition: t.exitCondition, acceptanceCriteria: criteria ? t.criteria : [], storyIds: [t.story], dependencies: t.dependencies, priority: t.priority, requiredChecks: t.requiredChecks, requiredReviews: t.requiredReviews }));
  writeFileSync(join(p.repoPath, ".jarvis", "plan.json"), JSON.stringify({ ...(notes ? { notes } : {}), ...(tier !== undefined ? { tier } : {}), tasks }));
  if (reviewed) recordPlanReview(p);
}
/** The runner's overall record of a Goldfish review at the current plan's hash (decision 170), as plan-service.ts writes it. */
function recordPlanReview(p: E2EProject, verdict: "pass" | "resolve" | "fail" = "pass", findings: { id: string; lens: string; severity: "blocker" | "major" | "nit"; scope: string }[] = [], counts = true) {
  const planHash = planFileHash(p.repoPath);
  return p.ledger.append({ kind: "plan_review", actor: "runner", task_id: null, data: { lens: "overall", revision: p.baseRevision, planHash, policyHash: PLAN_POLICY_HASH, model: "claude-opus-5-5", verdict, counts, planted: [], findings, purpose: "review" } });
}
const runDir = (p: E2EProject) => join(p.jarvisHome, "run");
const socketsIn = (p: E2EProject) => existsSync(runDir(p)) ? readdirSync(runDir(p)).filter((n) => n.endsWith(".sock")) : [];

describe("jarvis run production composition", () => {
  it("loads the approved checks, the run branch and the architect's plan judged against the committed spec", async () => {
    const p = project(); writePlan(p);
    const { loop: opts } = await prepare(p);
    expect(Object.keys(opts.checks).sort()).toEqual(["ac1", "ac2", "ac3", "unit"]);
    expect(opts.runBranch).toBe(p.runBranch);
    expect(opts.tier).toBe(1);
    expect(opts.plan?.tasks.map((t) => t.id)).toEqual(["T1", "T2"]);
    expect(opts.worktreeRoot).toBe(join(p.home, ".jarvis-work", "worktrees"));
    expect(typeof opts.createHarness).toBe("function"); expect(typeof opts.recoverIntake).toBe("function");
    expect(opts.plan?.tasks.some((t) => "planNotes" in t)).toBe(false);
  });

  it("gives every planned task the architect's top-level notes (decision 113), and refuses any other top-level key", async () => {
    const p = project(); writePlan(p, true, ["Keep the store behind an interface."]);
    const { loop: opts } = await prepare(p);
    expect(opts.plan?.tasks.map((t) => [t.id, t.planNotes])).toEqual([["T1", ["Keep the store behind an interface."]], ["T2", ["Keep the store behind an interface."]]]);
    const q = project(); writePlan(q);
    const path = join(q.repoPath, ".jarvis", "plan.json");
    writeFileSync(path, JSON.stringify({ feature: "habits", ...JSON.parse(readFileSync(path, "utf8")) }));
    await expect(prepare(q)).rejects.toThrow(/Unrecognized key/);
  });

  it.each([0, 2] as const)("carries plan tier %s into the loop and review material", async (tier) => {
    const p = project(); writePlan(p, true, undefined, tier);
    const hosted = vi.spyOn(brokerHost, "hostBroker").mockResolvedValue({ socketPath: join(p.home, "fake.sock"), alias: join(p.home, "fake-alias.sock"), reconciled: 0, close: async () => {} });
    let deps: ReviewDeps | undefined;
    let loop: PreparedRun["loop"];
    try { ({ loop } = await prepare(p, {}, { createReview: (input) => { deps = input; return async () => "pass"; } })); }
    finally { hosted.mockRestore(); }
    expect(loop.tier).toBe(tier);
    safeGit(p.repoPath, ["commit", "--allow-empty", "-qm", "candidate"], { home: p.home });
    expect(reviewMaterialFor(deps!, "T1", safeGit(p.repoPath, ["rev-parse", "HEAD"], { home: p.home }).toString().trim())).toMatchObject({ tier });
  });
  it("reviews review-fix bug tasks at tier 2 and leaves the report update at the plan's tier", () => {
    const p = project();
    const deps: ReviewDeps = {
      context: context(p), ledger: p.ledger, workRoot: p.home, cacheRoot: p.home, spec: undefined, tier: 1,
      git: () => "base", preflight: async () => true,
      reviewFix: { request: "Fix confirmed findings", tasks: new Map(), bugTasks: new Set(["T1"]) },
    };
    expect(reviewMaterialFor(deps, "T1", "candidate")).toMatchObject({ tier: 2, kind: "bug" });
    expect(reviewMaterialFor(deps, "T2", "candidate")).toMatchObject({ tier: 1 });
    expect(reviewMaterialFor(deps, "T2", "candidate").kind).toBeUndefined();
    expect(reviewMaterialFor({ ...deps, tier: 2 }, "T2", "candidate").tier).toBe(2);
  });
  it("reviews direct refactors against preserved behavior instead of bug-reproduction requirements", async () => {
    const p = project();
    const { bugRequestPlan } = await import("../../packages/cli/src/runner/plan.ts");
    const request = "Refactor src/store.mjs into smaller functions without changing behavior.";
    const plan = bugRequestPlan(request, [{ name: "unit" }]);
    let deps: ReviewDeps | undefined;
    await prepare(p, { request }, { createReview: (input) => { deps = input; return async () => "pass"; } });
    const material = reviewMaterialFor({ ...deps!, git: () => "base" }, plan.tasks[0]!.id, "candidate");
    expect(material.kind).toBeUndefined();
    expect(material.acceptanceCriteria).toEqual([plan.tasks[0]!.exitCondition]);
  });

  it.each(["The citizenship filter is missing some jobs that require US citizenship.", "Chromium won't start in the container. Fix it."])("plans a bug request without a spec: %s", async (request) => {
    const p = project();
    safeGit(p.repoPath, ["rm", "-r", "docs/spec"], { home: p.home });
    safeGit(p.repoPath, ["commit", "-qm", "no spec"], { home: p.home });
    let deps: ReviewDeps | undefined;
    const hosted = vi.spyOn(brokerHost, "hostBroker").mockResolvedValue({ socketPath: join(p.home, "fake.sock"), alias: join(p.home, "fake-alias.sock"), reconciled: 0, close: async () => {} });
    let loop: PreparedRun["loop"];
    try { ({ loop } = await prepare(p, { request }, { createReview: input => { deps = input; return async () => "pass"; } })); }
    finally { hosted.mockRestore(); }
    expect(loop.plan?.tasks).toHaveLength(1);
    const task = loop.plan!.tasks[0]!;
    expect(task.goal).toBe(request);
    expect(task.exitCondition).toContain("every path");
    expect(task.requiredChecks).toContain("unit");
    expect(task.requiredReviews).toContain("code");
    expect(reviewMaterialFor(deps!, task.id, safeGit(p.repoPath, ["rev-parse", "HEAD"], { home: p.home }).toString().trim())).toMatchObject({
      kind: "bug", tier: loop.tier, spec: expect.stringContaining(request), acceptanceCriteria: [task.exitCondition],
    });
  });
  it("refuses a feature request through the spec-free bug handoff", async () => {
    const p = project();
    await expect(prepare(p, { request: "Build a new habit tracker app" })).rejects.toThrow(/bug.*spec|spec.*bug/);
    expect(socketsIn(p)).toEqual([]);
  });
  it("keeps the approved spec requirement for an ordinary architect plan", async () => {
    const p = project(); writePlan(p);
    safeGit(p.repoPath, ["rm", "-r", "docs/spec"], { home: p.home });
    safeGit(p.repoPath, ["commit", "-qm", "no spec"], { home: p.home });
    await expect(prepare(p)).rejects.toThrow(/approved spec/);
  });
  it("refuses to start without approved protected checks", async () => {
    const p = project(false);
    await expect(prepare(p)).rejects.toThrow(/approved/);
    expect(socketsIn(p)).toEqual([]);
  });

  it("refuses a plan that doesn't cover the committed spec's criteria", async () => {
    const p = project(); writePlan(p, false);
    await expect(prepare(p)).rejects.toThrow(/cover|AC/);
    expect(socketsIn(p)).toEqual([]);
  });

  it("judges coverage against the committed spec, not an edited working copy", async () => {
    const p = project(); writePlan(p);
    writeFileSync(join(p.repoPath, "docs/spec/v1.md"), "not a spec\n");
    await expect(prepare(p)).resolves.toMatchObject({ loop: { runBranch: p.runBranch } });
  });

  it("refuses a detached checkout", async () => {
    const p = project();
    safeGit(p.repoPath, ["checkout", "-q", "--detach"], { home: p.gitHome });
    await expect(prepare(p)).rejects.toThrow(/branch/);
  });

  it("reads a session plan only when one is named", async () => {
    const p = project();
    mkdirSync(join(p.repoPath, ".jarvis", "onboard"), { recursive: true });
    writeFileSync(join(p.repoPath, ".jarvis", "onboard", "plan.json"), JSON.stringify({ tasks: [{ id: "T1", title: "Tidy", goal: "Tidy src", exitCondition: "unit passes", acceptanceCriteria: [], storyIds: [], dependencies: [], priority: 0, requiredChecks: ["unit"], requiredReviews: ["code"] }] }));
    expect((await prepare(p)).loop.plan).toBeUndefined();
    expect((await prepare(p, { planKind: "onboard" })).loop.plan?.tasks.map((t) => t.goal)).toEqual(["Tidy src"]);
  });

  it("uses the injected reviewer hook", async () => {
    const p = project(); const review = vi.fn(async () => "pass" as const);
    const { loop } = await prepare(p, {}, { createReview: () => review });
    expect(loop.review).toBe(review);
  });
});

describe("jarvis run hosts the project's broker for the run", () => {
  it("listens on a bound socket in the owner-only run folder, answers sessions' requests, and close removes it", async () => {
    const p = project();
    const run = await prepare(p);
    expect(socketsIn(p)).toHaveLength(2); // the bound address and its public alias (decision 78)
    expect(readdirSync(runDir(p)).length).toBe(2);
    expect(statSync(runDir(p)).mode & 0o777).toBe(0o700);
    const bound = boundSocket(p);
    const res = await requestBroker(bound, { op: "email.send", payload: { to: "jane@example.com", subject: "Hi", body: "Hello" } });
    expect(res.status).toBe("pending");
    expect(p.ledger.entries().some((e) => e.kind === "approval_request")).toBe(true);
    await run.close();
    expect(socketsIn(p)).toEqual([]);
  });

  it("refuses a secrets file anyone else can read, before hosting anything", async () => {
    const p = project();
    mkdirSync(join(p.jarvisHome, "secrets"), { mode: 0o700 });
    writeFileSync(join(p.jarvisHome, "secrets", `${p.projectId}.env`), "X_TOKEN=fake-not-a-token\n");
    chmodSync(join(p.jarvisHome, "secrets", `${p.projectId}.env`), 0o644);
    await expect(prepare(p)).rejects.toThrow(/chmod 600/);
    expect(socketsIn(p)).toEqual([]);
  });

  it("gives each task session the bound socket, the read-only install and the jarvis launcher, and never a secret", async () => {
    const p = project();
    mkdirSync(join(p.jarvisHome, "secrets"), { mode: 0o700 });
    writeFileSync(join(p.jarvisHome, "secrets", `${p.projectId}.env`), "VERCEL_PREVIEW_TOKEN=fake-sentinel-6d1e\n", { mode: 0o600 });
    type Settings = { sandbox: { network: { allowUnixSockets: string[] }; filesystem: { allowRead: string[]; denyWrite: string[] } } };
    const seen: { spec?: SessionSpec; settings?: Settings; files?: string } = {};
    const session = async (spec: SessionSpec): Promise<SessionOutcome> => {
      seen.spec = spec;
      const settingsPath = spec.args[spec.args.indexOf("--settings") + 1]!;
      seen.settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
      seen.files = readdirSync(join(settingsPath, "..")).map((n) => n.endsWith(".json") ? readFileSync(join(settingsPath, "..", n), "utf8") : "").join("\n");
      writeFileSync(spec.stdoutPath!, `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`);
      return { code: 0, timedOut: false, overflowed: false, durationMs: 1, stdout: "", stderr: "" };
    };
    const run = await prepare(p, {}, { harness: { binaryRealpath: (b) => b, session } });
    const outcome = await runTask(p, run);
    expect(outcome.status).toBe("finished");
    const spec = seen.spec!;
    const settings = seen.settings!;
    expect(seen.files).not.toContain("fake-sentinel-6d1e");
    const bound = boundSocket(p);
    expect(spec.env.JARVIS_BROKER_SOCKET).toBe(bound);
    expect(settings.sandbox.network.allowUnixSockets).toEqual([bound]);
    expect(bound).toMatch(/\/\.b-[0-9a-f]+\.sock$/); // the bound address, never the public alias
    const install = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
    expect(settings.sandbox.filesystem.allowRead).toContain(install);
    expect(settings.sandbox.filesystem.denyWrite).toContain(install);
    expect(spec.env.PATH!.split(":")[0]).toBe(join(install, "packages", "cli", "bin"));
    expect(spec.env.JARVIS_NODE).toBe(realpathSync(process.execPath));
    expect(JSON.stringify(spec)).not.toContain("fake-sentinel-6d1e");
  });
});

describe("jarvis run notifies through the configured notifier", () => {
  function notifier() {
    const sent: Message[] = [];
    const n: Notifier = { send: async (m) => { sent.push(m); }, poll: async () => [] };
    return { sent, createNotifier: () => n };
  }
  it("wires blocked tasks, long usage waits and the finished summary to it", async () => {
    const p = project();
    writeFileSync(join(p.jarvisHome, "notify.json"), JSON.stringify({ baseUrl: "https://example.invalid", topic: "fake-out", replyTopic: "fake-in" }), { mode: 0o600 });
    const n = notifier();
    const run = await prepare(p, {}, { createNotifier: n.createNotifier });
    await run.loop.notifyBlocked!({ taskId: "T1", reason: "protected check changed" });
    await run.loop.notify!({ taskId: "T2", resumeAt: Date.now() + 3 * 3_600_000, waitMs: 3 * 3_600_000 });
    await run.finished({ status: "complete", done: [], blocked: [] });
    expect(n.sent.map((m) => m.kind)).toEqual(["blocked", "usage-wait", "finished"]);
    expect(n.sent[2]!.text).toMatch(/0\/0 done/);
  });

  it("prepares the run when the notifier config is broken, and says so, naming the config only", async () => {
    const p = project();
    writeFileSync(join(p.jarvisHome, "notify.json"), '{"topic":"fake-private-capability-91c2"}', { mode: 0o600 });
    const warnings: string[] = [];
    const run = await prepare(p, {}, { warn: (w) => warnings.push(w) });
    await expect(run.loop.notifyBlocked!({ taskId: "T1", reason: "x" })).resolves.toBeUndefined();
    expect(warnings.length).toBeGreaterThan(0);
    for (const w of warnings) { expect(w).toContain(join(p.jarvisHome, "notify.json")); expect(w).not.toContain("fake-private-capability-91c2"); }
  });
});

/** The address sessions get: the one socket name in the run folder that isn't the public alias. */
function boundSocket(p: E2EProject): string {
  const names = socketsIn(p).filter((n) => n.startsWith(".b-"));
  expect(names).toHaveLength(1);
  return join(realpathSync(runDir(p)), names[0]!);
}

async function runTask(p: E2EProject, run: PreparedRun) {
  const harness = run.loop.createHarness!(structuredClone(DEFAULT_ROUTING));
  const workspace = join(run.loop.worktreeRoot, p.projectId, "T1-a1");
  mkdirSync(workspace, { recursive: true });
  const header = join(p.jarvisHome, "header.md"); writeFileSync(header, "Task: T1\n");
  return harness.runTask({
    workspace, prompt: "p", runHeaderPath: header, role: "build", tier: 1, maxTurns: 4, timeoutMs: 60_000,
    logPath: join(p.projectDir, "logs", "T1-a1.jsonl"), onSpawn: () => true, onGroupExit: () => {},
  });
}


describe("production design composition", () => {
  beforeEach(() => { vi.spyOn(brokerHost,"hostBroker").mockResolvedValue({socketPath:"/fake/broker.sock",alias:"/fake/alias.sock",reconciled:0,close:async()=>{}}); });
  afterEach(() => vi.restoreAllMocks());
  it("composes the design service from committed design and dispatches its recorded verdict", async () => {
    const p=project();
    writeFileSync(join(p.repoPath,"DESIGN.md"),"## Overview\n- Principles: List first.\n");
    writeFileSync(join(p.repoPath,"PRODUCT.md"),"Habits");
    safeGit(p.repoPath,["add","DESIGN.md","PRODUCT.md"],{home:p.gitHome});
    safeGit(p.repoPath,["commit","-qm","approved design"],{home:p.gitHome});
    writeFileSync(join(p.repoPath,"DESIGN.md"),"candidate instructions");
    const reviewDetailed=vi.fn(async()=>({verdict:"pass",counts:true} as never));
    const createDesignReview=vi.fn(()=>({reviewDetailed}));
    const run=await prepare(p,{}, {createDesignReview});
    expect(createDesignReview).toHaveBeenCalledOnce();
    expect(createDesignReview.mock.calls[0]).toMatchObject([{projectDir:p.projectDir,jarvisHome:p.jarvisHome}]);
    const request={taskId:"T1",attemptId:"a1",revision:"a".repeat(40)};
    expect(await run.loop.review!({...request,reviewer:"design"} as never)).toEqual({status:"pass",recorded:true});
    expect(reviewDetailed).toHaveBeenCalledWith(request);
    // The real git seam reads the run branch's committed objects, never the edited working tree.
    const git=(args: readonly string[])=>safeGit(p.repoPath,args,{home:p.gitHome}).toString().trim();
    expect(approvedDesign(git,run.loop.runBranch)).toMatchObject({design:"## Overview\n- Principles: List first.",product:"Habits"});
  });
  it("a committed DESIGN.md without PRODUCT.md still starts the run; each design review's material is refused", async () => {
    const p=project();
    writeFileSync(join(p.repoPath,"DESIGN.md"),"## Overview\n- Principles: List first.\n");
    safeGit(p.repoPath,["add","DESIGN.md"],{home:p.gitHome});
    safeGit(p.repoPath,["commit","-qm","design without product"],{home:p.gitHome});
    const createDesignReview=vi.fn((_options: { resolveMaterial(request: { taskId: string; attemptId: string; revision: string }): Promise<unknown> }) => ({reviewDetailed:vi.fn()}));
    // The run starts: a refusal here is an assertion failure, not an error (decision 146).
    await expect(prepare(p,{}, {createDesignReview: createDesignReview as never})).resolves.toBeDefined();
    expect(createDesignReview).toHaveBeenCalledOnce();
    await expect(createDesignReview.mock.calls[0]![0].resolveMaterial({taskId:"T1",attemptId:"a1",revision:"a".repeat(40)})).rejects.toThrow(/PRODUCT\.md/);
  });
  it("does not compose design from a working-tree-only DESIGN.md", async () => {
    const p=project(); writeFileSync(join(p.repoPath,"DESIGN.md"),"unapproved");
    const createDesignReview=vi.fn();
    const run=await prepare(p,{}, {createDesignReview});
    expect(createDesignReview).not.toHaveBeenCalled();
    expect(await run.loop.review!({taskId:"T1",attemptId:"a1",revision:"a".repeat(40),reviewer:"design"} as never)).toEqual({status:"error",recorded:true});
  });
  it("dispatches code and design to separate services, preserving errors", async () => {
    const code={reviewDetailed:vi.fn(async()=>({verdict:"fail"} as never))};
    const design={reviewDetailed:vi.fn(async()=>({verdict:"error"} as never))};
    const dispatch=reviewDispatch(code,design)!;
    const request={taskId:"T1",attemptId:"a1",revision:"a".repeat(40)};
    expect(await dispatch({...request,reviewer:"design"} as never)).toEqual({status:"error",recorded:true});
    expect(code.reviewDetailed).not.toHaveBeenCalled();
    expect(await dispatch({...request,reviewer:"code"} as never)).toEqual({status:"fail",recorded:true});
    expect(code.reviewDetailed).toHaveBeenCalledOnce(); expect(design.reviewDetailed).toHaveBeenCalledOnce();
  });
});

describe("the Goldfish gate on jarvis run (decision 170)", () => {
  it("refuses an architect plan with no plan review at its hash, and hosts nothing", async () => {
    const p = project(); writePlan(p, true, undefined, undefined, false);
    await expect(prepare(p)).rejects.toThrow(/no Goldfish review at hash [a-f0-9]{64}: run jarvis plan review/);
    expect(socketsIn(p)).toEqual([]);
  });
  it("refuses a review that does not count, a failed review, and a review of another plan", async () => {
    const p = project(); writePlan(p, true, undefined, undefined, false); recordPlanReview(p, "pass", [], false);
    await expect(prepare(p)).rejects.toThrow(/does not count/);
    const q = project(); writePlan(q, true, undefined, undefined, false); recordPlanReview(q, "fail", [{ id: "critic-1", lens: "critic", severity: "blocker", scope: "T1" }]);
    await expect(prepare(q)).rejects.toThrow(/critic-1/);
    const r = project(); writePlan(r); writeFileSync(join(r.repoPath, ".jarvis", "plan.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(r.repoPath, ".jarvis", "plan.json"), "utf8")), notes: ["changed after the review"] }));
    await expect(prepare(r)).rejects.toThrow(/no Goldfish review/);
  });
  it("runs a plan whose counted review passed", async () => {
    const p = project(); writePlan(p);
    const { loop } = await prepare(p);
    expect(loop.plan?.tasks.map((t) => t.id)).toEqual(["T1", "T2"]);
  });
  it("a review that needs resolution runs only once every major is resolved and no escalation is open", async () => {
    const p = project(); writePlan(p, true, undefined, undefined, false);
    const planHash = planFileHash(p.repoPath);
    recordPlanReview(p, "resolve", [{ id: "critic-1", lens: "critic", severity: "major", scope: "T1" }, { id: "readiness-1", lens: "readiness", severity: "major", scope: "T2" }, { id: "zoom-out-1", lens: "zoom-out", severity: "nit", scope: "T1" }]);
    await expect(prepare(p)).rejects.toThrow(/without a resolution: critic-1, readiness-1/);
    p.ledger.append({ kind: "plan_review", actor: "runner", task_id: null, data: { purpose: "resolution", planHash, resolutions: [{ id: "critic-1", action: "contest", evidence: "src/index.mjs" }, { id: "readiness-1", action: "escalate", question: "Which store?" }] } });
    p.ledger.append({ kind: "plan_review", actor: "runner", task_id: null, data: { purpose: "escalation", planHash, id: "readiness-1", question: "Which store?" } });
    await expect(prepare(p)).rejects.toThrow(/escalations wait for the user: readiness-1/);
    p.ledger.append({ kind: "plan_review", actor: "runner", task_id: null, data: { purpose: "escalation_answer", planHash, id: "readiness-1", answer: "SQLite", by: "user", source: "terminal" } });
    const { loop } = await prepare(p);
    expect(loop.plan?.tasks).toHaveLength(2);
  });
  it("session plans, bug requests and ledger-only runs are not gated", async () => {
    const p = project();
    const hosted = vi.spyOn(brokerHost, "hostBroker").mockResolvedValue({ socketPath: join(p.home, "fake.sock"), alias: join(p.home, "fake-alias.sock"), reconciled: 0, close: async () => {} });
    try {
      const { loop } = await prepare(p, { request: "The citizenship filter is missing some jobs that require US citizenship." });
      expect(loop.plan?.tasks).toHaveLength(1);
      const q = project();
      expect((await prepare(q)).loop.plan).toBeUndefined();
    } finally { hosted.mockRestore(); }
  });
});
