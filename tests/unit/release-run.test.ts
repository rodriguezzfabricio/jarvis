import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Broker } from "../../packages/cli/src/broker/broker.ts";
import type { GateCheck, GateInput, GateResult } from "../../packages/cli/src/checks/gate.ts";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { runSession, type SessionOutcome, type SessionSpec } from "../../packages/cli/src/proc/session.ts";
import { parseReleaseSetup, saveReleaseSetup, type ReleaseSetup } from "../../packages/cli/src/release/config.ts";
import { prepareRelease, runReleaseStep, type ReleaseSeams } from "../../packages/cli/src/release/run.ts";
import { releaseStatus } from "../../packages/cli/src/release/states.ts";
import type { Harness, TaskInput, TaskOutcome } from "../../packages/cli/src/runner/harness.ts";
import { DEFAULT_ROUTING } from "../../packages/cli/src/runner/routing.ts";
import type { SandboxedRun } from "../../packages/cli/src/sandbox/srt.ts";
import { shortTmp } from "../helpers.ts";
import { initRepo } from "./helpers/git-repo.ts";
import { doneTask } from "./helpers/release-fixture.ts";

// Decision 157: the release step's order and its stops, with every outside piece faked: the ship session, the
// sandbox, the gates, the provider CLI and fetch. The real composition runs in tests/integration/e2e-release.test.ts.
const root = shortTmp("jrr-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const ok = (stdout: string): SessionOutcome => ({ code: 0, timedOut: false, overflowed: false, durationMs: 1, stdout, stderr: "" });
const LOCK = "d".repeat(64);
const CLAIMS = { smokePaths: ["/", "/health"], rollback: { steps: ["Restore the previous deploy."] }, data: { kind: "none" } };

interface Options { setup?: Partial<ReleaseSetup>; claims?: unknown; failGate?: string; failSmoke?: boolean; providerOutput?: string; cliVersion?: string; doneAt?: "head" | "older" | "none"; sessionStatus?: TaskOutcome["status"] }
async function step(o: Options = {}) {
  const dir = join(root, `s${++n}`);
  const repo = join(dir, "repo"); mkdirSync(repo, { recursive: true });
  initRepo(repo, { identity: true });
  writeFileSync(join(repo, "index.html"), "<h1>Habits</h1>\n");
  writeFileSync(join(repo, "health"), "ok\n");
  safeGit(repo, ["add", "-A"], { home: dir }); safeGit(repo, ["commit", "-q", "-m", "app"], { home: dir });
  const head = safeGit(repo, ["rev-parse", "HEAD"], { home: dir }).toString().trim();
  const jarvisHome = join(dir, "jarvis"); const projectDir = join(jarvisHome, "projects", "habits");
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  const ledger = Ledger.open(projectDir);
  if (o.doneAt !== "none") doneTask(ledger, "T1", ["unit"], ["code"], o.doneAt === "older" ? "b".repeat(40) : head);
  ledger.append({ kind: "checks_approved", actor: "runner", data: { lockHash: LOCK } });
  saveReleaseSetup(projectDir, parseReleaseSetup({ version: 1, provider: "netlify", plan: "free", siteId: "habits-site", productionUrl: "https://habits.example.com",
    build: { command: "mkdir -p site && cp index.html health site/", output: "site", timeoutMs: 10_000 }, ...o.setup }));
  // A real, trusted file at the pinned path; its --version and its deploys are answered by the fakes below.
  const binDir = join(dir, "bin"); mkdirSync(binDir, { mode: 0o755 });
  const bin = join(binDir, "netlify"); writeFileSync(bin, "#!/bin/sh\nexit 9\n", { mode: 0o755 });
  const served = join(dir, "served"); mkdirSync(served);
  const providerCalls: SessionSpec[] = [];
  const seams: ReleaseSeams = {
    cli: { pins: { netlify: { version: "99.1.0" } }, bin: () => bin, run: async () => ok(`netlify-cli/${o.cliVersion ?? "99.1.0"}`) },
    run: async (spec) => {
      providerCalls.push(spec);
      cpSync(spec.args[spec.args.indexOf("--dir") + 1]!, join(served, "1"), { recursive: true });
      return ok(o.providerOutput ?? JSON.stringify({ deploy_url: "https://deploy-1--habits.netlify.app" }));
    },
    sandbox: async (r: SandboxedRun) => runSession({ bin: "/bin/sh", args: ["-c", r.command], cwd: r.cwd, env: r.env, timeoutMs: r.timeoutMs }),
    gate: async (g: GateInput): Promise<GateResult> => {
      const ev = join(projectDir, "evidence", `g-${g.check.name}-${n}-${Math.random()}`); mkdirSync(ev, { recursive: true }); writeFileSync(join(ev, "out"), "x");
      const status = o.failGate === g.check.name ? "fail" : "pass";
      const entry = g.ledger.append({ kind: "gate_result", actor: "runner", task_id: g.taskId, attempt_id: g.attemptId, data: { check: g.check.name, revision: g.revision, status,
        checksLock: LOCK, evidence: { dir: ev, files: { out: createHash("sha256").update("x").digest("hex") } } } });
      return { status, entry, evidenceDir: ev };
    },
    fetch: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (o.failSmoke && url.pathname === "/health") return new Response("down", { status: 500 });
      const file = join(served, "1", url.pathname === "/" ? "index.html" : url.pathname);
      return existsSync(file) && statSync(file).isFile() ? new Response(readFileSync(file)) : new Response("missing", { status: 404 });
    }) as typeof globalThis.fetch,
  };
  const host = { projectId: "habits", projectDir, workRoot: join(dir, "work"), worktreeRoot: join(dir, "work", "worktrees"), repoPath: repo, home: dir, ledger };
  const runtime = (await prepareRelease(host, seams))!;
  const broker = new Broker({ ledger, project: "habits", adapters: runtime.adapters, secrets: { get: (k) => k === "NETLIFY_PREVIEW_TOKEN" ? "fake-preview-0001" : k === "NETLIFY_PRODUCTION_TOKEN" ? "fake-production-0001" : undefined } });
  const requests: string[] = [];
  const sessions: TaskInput[] = [];
  const harness: Harness = { runTask: async (input) => {
    sessions.push(input);
    mkdirSync(join(input.workspace, ".jarvis", "release"), { recursive: true });
    writeFileSync(join(input.workspace, ".jarvis", "release", "manifest.json"), JSON.stringify(o.claims ?? CLAIMS));
    const base = { exitCode: 0, durationMs: 1, usage: [], usageWaitUntil: undefined };
    return o.sessionStatus === "timeout" ? { ...base, status: "timeout" } : { ...base, status: "finished" };
  } };
  const checks: GateCheck[] = [{ name: "unit", cases: [{ id: "u", command: "true" }], verify: "true", timeoutMs: 1000 }, { name: "e2e", cases: [{ id: "e", command: "true" }], verify: "true", timeoutMs: 1000 }];
  const outcome = await runReleaseStep({ runtime, ledger, broker: { handle: (req) => { requests.push(req.op); return broker.handle(req); } }, projectId: "habits", projectDir, jarvisHome, repoPath: repo,
    workRoot: host.workRoot, worktreeRoot: host.worktreeRoot, gitHome: dir, runBranch: "main", git: (args) => safeGit(repo, args, { home: dir }).toString().trim(), checks,
    harness, routing: DEFAULT_ROUTING, tier: 1, maxTurns: 20, timeoutMs: 60_000, seams });
  const steps = ledger.entries().filter((e) => e.kind === "decision" && (e.data as { type?: string }).type === "release.step").map((e) => (e.data as { outcome: string }).outcome);
  return { outcome, ledger, requests, providerCalls, sessions, steps, head };
}

describe("the release step", () => {
  it("reaches preview-ready with one preview deploy and never asks for production", async () => {
    const s = await step();
    expect(s.outcome).toMatchObject({ status: "preview-ready", url: "https://deploy-1--habits.netlify.app" });
    expect(s.requests).toEqual(["deploy.preview"]);
    expect(s.providerCalls).toHaveLength(1);
    expect(s.providerCalls[0]!.env.NETLIFY_AUTH_TOKEN).toBe("fake-preview-0001");
    expect(s.providerCalls[0]!.args).not.toContain("--prod");
    expect(s.sessions.map((x) => x.prompt.split("\n")[0])).toEqual(["Task: ship"]);
    expect(readFileSync(s.sessions[0]!.runHeaderPath, "utf8")).toContain('<skill name="ship">');
    expect(releaseStatus(s.ledger.entries()).current?.state).toBe("preview-ready");
    expect(s.steps.at(-1)).toMatch(/^preview-ready at https:\/\/deploy-1--habits\.netlify\.app; production gated/);
  });

  it.each([
    ["the plan is not done", { doneAt: "none" } as Options, /not every planned task is done/],
    ["the head is not the revision the runner last promoted", { doneAt: "older" } as Options, /is not the revision the runner last promoted/],
    ["the provider CLI is not the pinned version", { cliVersion: "99.2.0" } as Options, /not the pinned version/],
    ["the ship session did not finish", { sessionStatus: "timeout" } as Options, /the ship session timeout/],
    ["the manifest's claims are invalid", { claims: { smokePaths: ["https://evil.example.com"], rollback: { steps: ["x"] }, data: { kind: "none" } } } as Options, /manifest is refused/],
    ["the manifest declares data the setup has no source for", { claims: { ...CLAIMS, data: { kind: "sqlite", commands: { migrate: "m", backup: "b", restore: "r", verify: "v" } } } } as Options, /no data snapshot source/],
    ["the build fails", { setup: { build: { command: "exit 4", output: "site", timeoutMs: 10_000 } } } as Options, /release build exited 4/],
    ["a protected check fails on the release revision", { failGate: "e2e" } as Options, /protected check e2e failed/],
    ["the provider's outcome is uncertain", { providerOutput: "not json" } as Options, /the preview deploy unknown/],
    ["the preview smoke test fails", { failSmoke: true } as Options, /preview smoke test failed/],
  ])("stops, records why and reaches nothing when %s", async (_name, options, reason) => {
    const s = await step(options);
    expect(s.outcome).toMatchObject({ status: "stopped", reason: expect.stringMatching(reason) });
    expect(s.steps.at(-1)).toMatch(/^stopped: /);
    expect(s.ledger.entries().some((e) => e.kind === "state_reached" && (e.data as { state: string }).state === "preview-ready")).toBe(false);
    expect(s.requests.filter((op) => op !== "deploy.preview")).toEqual([]);
  });

  it("refuses a paid plan even if the setup file was written around the schema", async () => {
    const s = await step({ setup: {} });
    expect(s.outcome.status).toBe("preview-ready");
    const dir = join(root, `s${n}`, "jarvis", "projects", "habits");
    const setup = JSON.parse(readFileSync(join(dir, "release.json"), "utf8")) as ReleaseSetup;
    const { runReleaseStep: again } = await import("../../packages/cli/src/release/run.ts");
    const runtime = { setup: { ...setup, plan: "pro" }, config: {} as never, providerConfig: undefined, verifyCli: async () => ({ ok: false as const, reason: "unused" }), adapters: [] };
    const result = await again({ runtime, ledger: s.ledger, broker: { handle: async () => { throw new Error("no request may be made"); } }, projectId: "habits", projectDir: dir, jarvisHome: join(root, `s${n}`, "jarvis"),
      repoPath: join(root, `s${n}`, "repo"), workRoot: join(root, `s${n}`, "work"), worktreeRoot: join(root, `s${n}`, "work", "worktrees"), gitHome: join(root, `s${n}`), runBranch: "main",
      git: () => s.head, checks: [], harness: { runTask: async () => { throw new Error("no session may start"); } }, routing: DEFAULT_ROUTING, tier: 1, maxTurns: 1, timeoutMs: 1 });
    expect(result).toMatchObject({ status: "stopped", reason: expect.stringMatching(/not the free plan/) });
  });
});
