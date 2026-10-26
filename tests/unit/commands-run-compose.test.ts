import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestBroker } from "../../packages/cli/src/broker/client.ts";
import type { SignalHost } from "../../packages/cli/src/broker/host.ts";
import { prepareProductionRun, type ComposeOptions } from "../../packages/cli/src/commands/run-compose.ts";
import type { PreparedRun } from "../../packages/cli/src/commands/run.ts";
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
  const run = await prepareProductionRun(context(p, ctx), { home: p.home, ...seams(extra) });
  prepared.push(run);
  return run;
}
function writePlan(p: E2EProject, criteria = true, notes?: string[]) {
  mkdirSync(join(p.repoPath, ".jarvis"), { recursive: true });
  const tasks = p.tasks.map((t) => ({ id: t.id, title: t.title, goal: t.goal, exitCondition: t.exitCondition, acceptanceCriteria: criteria ? t.criteria : [], storyIds: [t.story], dependencies: t.dependencies, priority: t.priority, requiredChecks: t.requiredChecks, requiredReviews: t.requiredReviews }));
  writeFileSync(join(p.repoPath, ".jarvis", "plan.json"), JSON.stringify({ ...(notes ? { notes } : {}), tasks }));
}
const runDir = (p: E2EProject) => join(p.jarvisHome, "run");
const socketsIn = (p: E2EProject) => existsSync(runDir(p)) ? readdirSync(runDir(p)).filter((n) => n.endsWith(".sock")) : [];

describe("jarvis run production composition", () => {
  it("loads the approved checks, the run branch and the architect's plan judged against the committed spec", async () => {
    const p = project(); writePlan(p);
    const { loop: opts } = await prepare(p);
    expect(Object.keys(opts.checks).sort()).toEqual(["ac1", "ac2", "ac3", "unit"]);
    expect(opts.runBranch).toBe(p.runBranch);
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
