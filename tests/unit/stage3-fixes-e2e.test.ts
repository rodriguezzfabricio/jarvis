import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as brokerHost from "../../packages/cli/src/broker/host.ts";
import { prepareProductionRun, reviewMaterialFor } from "../../packages/cli/src/commands/run-compose.ts";
import { register } from "../../packages/cli/src/commands/run.ts";
import type { GateInput, GateResult } from "../../packages/cli/src/checks/gate.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { jarvisMetrics, runJarvis } from "../../packages/cli/src/eval/jarvis.ts";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { createClaudeReviewer } from "../../packages/cli/src/harness/claude/review.ts";
import { runSession, type SessionSpec } from "../../packages/cli/src/proc/session.ts";
import { createReviewService, DEFAULT_REVIEW_ROUTING } from "../../packages/cli/src/review/index.ts";
import { runLoop } from "../../packages/cli/src/runner/loop.ts";
import { createE2EProject, sessionCalls, writeFakeClaudeShim, type E2EProject } from "../integration/e2e-helpers.ts";
import { fixture, removeFixtures, featureTask, planFile, validTasks } from "./helpers/eval-jarvis-run-fixture.ts";

const projects: E2EProject[] = [];
afterEach(() => { vi.restoreAllMocks(); projects.splice(0).forEach(p => p.cleanup()); removeFixtures(); });
const checked = ["spec-criteria", "data-flow", "error-paths", "unchanged-callers", "bug-brief-inputs"];
const result = (text: string) => ({ event: { type: "result", subtype: "success", result: text, usage: { input_tokens: 23, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, total_cost_usd: 0, num_turns: 1 } });
/** The fake gate owns its evidence and reads the committed candidate. No sandbox runtime or network. */
async function gate(g: GateInput): Promise<GateResult> {
  const observed = safeGit(g.repoPath, ["show", `${g.revision}:fixed.txt`], { home: g.workRoot }).toString();
  expect(observed).toBe("fixed\n");
  const dir = join(g.projectDir, "evidence", `gate-${g.taskId}-${g.check.name}`); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "stdout"), observed);
  const entry = g.ledger.append({ kind: "gate_result", actor: "runner", task_id: g.taskId, attempt_id: g.attemptId,
    data: { check: g.check.name, revision: g.revision, status: "pass", evidence: { dir, files: { stdout: createHash("sha256").update(observed).digest("hex") } } } });
  return { status: "pass", entry, evidenceDir: dir };
}

it("runs a spec-free production bug through fake builds, limited reviews, reprobes and promotion", async () => {
  const p = createE2EProject({ scenario: { sessions: [
    { name: "build", task: "T1", steps: [{ write: "fixed.txt", lines: ["fixed"] }, result("Built it")] },
    { name: "review-error", match: "Independently review", steps: [result("invalid verdict")] },
    { name: "review-limit", match: "Independently review", steps: [{ rateLimit: { status: "rejected", resetsAt: 5 } }, result("")] },
    { name: "review-pass", match: "Independently review", steps: [result(JSON.stringify({ findings: [], checked }))] },
  ] } }); projects.push(p);
  safeGit(p.repoPath, ["rm", "-r", "docs/spec"], { home: p.home });
  safeGit(p.repoPath, ["commit", "-qm", "bug has no spec"], { home: p.home });
  vi.spyOn(brokerHost, "hostBroker").mockResolvedValue({ socketPath: join(p.jarvisHome, "run/fake.sock"), alias: join(p.home, "fake-alias.sock"), reconciled: 0, close: async () => {} });
  let now = 1000, preflights = 0;
  const reprobe = vi.fn(async () => true), sessions: SessionSpec[] = [];
  const session = (spec: SessionSpec) => { sessions.push(spec); return runSession({ ...spec, bin: p.claudeBin }); };
  const { Command } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("commander");
  const program = new Command().exitOverride();
  register(program, { jarvisHome: p.jarvisHome, cwd: p.repoPath, env: { JARVIS_PROJECT: p.projectId }, probe: async () => ({ ok: true }), keepAwake: () => {}, output: () => {},
    prepareRun: context => prepareProductionRun(context, { home: p.home, preflight: async () => true, reprobe, warn: () => {},
      harness: { binaryRealpath: () => p.claudeBin, session, parentEnv: { HOME: p.home } },
      createReview: deps => {
        const service = createReviewService({ ledger: deps.ledger, projectDir: p.projectDir, workRoot: deps.workRoot, home: p.home, routing: DEFAULT_REVIEW_ROUTING, codex: null,
          resolveMaterial: async r => reviewMaterialFor(deps, r.taskId, r.revision),
          claude: createClaudeReviewer({ jarvisHome: p.jarvisHome, workRoot: deps.workRoot, cacheRoot: deps.cacheRoot, home: p.home, binaryRealpath: () => p.claudeBin, session,
            preflight: async () => ++preflights === 1 ? { ok: false, usageWaitUntil: 3 } : { ok: true } }),
        });
        return async r => ({ recorded: true, status: (await service.reviewDetailed(r)).verdict });
      },
    }),
    runLoop: async opts => { const r = await runLoop({ ...opts, gate, footprint: false, readProcessStartTime: () => "fake-start", now: () => now, sleep: async ms => { now += ms; }, usageMarginMs: 0 });
      expect(r.status, JSON.stringify(p.ledger.entries().filter(e => e.kind === "blocked" || e.kind === "review_result"))).toBe("complete"); return r; },
  });
  await program.parseAsync(["run", "--request", "The citizenship filter is missing some jobs that require US citizenship."], { from: "user" });
  expect(readFileSync(join(p.repoPath, "fixed.txt"), "utf8")).toBe("fixed\n");
  expect(sessionCalls(p).map(c => c.session)).toEqual(["build", "review-error", "review-limit", "review-pass"]);
  expect(reprobe).toHaveBeenCalledTimes(2);
  const metrics = jarvisMetrics(p.ledger.entries(), now, 0);
  expect(metrics).toMatchObject({ repairs: 0, sessions: { build: 1, review: 3, total: 4 }, usage: { inputTokens: 92, outputTokens: 28 } });
  expect(p.ledger.entries().filter(e => e.kind === "usage_wait").map(e => (e.data as { resetAt: number }).resetAt)).toEqual([3, 5]);
  const reviews = p.ledger.entries().filter(e => e.kind === "review_result");
  expect(new Set(reviews.map(e => (e.data as { revision: string }).revision)).size).toBe(1);
  expect(sessions.filter(s => s.args.includes("Read,Glob,Grep")).every(s => s.args.join(" ").includes("fixes a reported bug"))).toBe(true);
});

it("eval sends a validated tier-2 plan to real fake build/review processes and their usage rows", async () => {
  const fx = fixture(), task = featureTask(fx);
  const scenarioPath = join(fx.root, "tier-scenario.json");
  writeFileSync(scenarioPath, JSON.stringify({ sessions: [
    { name: "planner", match: "", steps: [{ write: ".jarvis/plan.json", content: planFile(validTasks(), { tier: 2 }) }, result("plan")] },
    { name: "build", task: "T1", steps: [{ write: "fixed.txt", lines: ["fixed"] }, result("built")] },
    { name: "review", match: "Independently review", repeat: true, steps: [result(JSON.stringify({ findings: [], checked }))] },
    { name: "build-2", task: "T2", steps: [result("built")] },
  ] }));
  const bin = join(fx.root, "fake-review"); writeFakeClaudeShim(bin, scenarioPath);
  const sessions: SessionSpec[] = [];
  const session = (s: SessionSpec) => { sessions.push(s); return runSession({ ...s, bin }); };
  const r = await runJarvis(task, { evalsRepo: fx.evalsRepo, jarvisHome: fx.jarvisHome, workRoot: fx.workRoot, home: fx.home,
    preflight: async () => ({ ok: true }), harnessSeams: { session, binaryRealpath: () => bin, home: fx.home, parentEnv: { HOME: fx.home } },
    reviewerSeams: { session, binaryRealpath: () => bin }, runLoop: opts => runLoop({ ...opts, gate, footprint: false, readProcessStartTime: () => "fake-start" }), gate,
  });
  expect(r.outcome, r.error).toBe("complete");
  expect(r.metrics.sessions).toEqual({ planner: 1, build: 2, review: 2, total: 5 });
  for (const s of sessions.filter(s => s.args.includes("Read,Glob,Grep"))) expect(s.args[s.args.indexOf("--model") + 1]).toBe("claude-opus-5-5");
  const usage = Ledger.open(join(r.resultsDir, "project")).entries().filter(e => e.kind === "session_usage").map(e => e.data as { role: string; tier: number });
  expect(usage.filter(d => d.role === "build" || d.role === "review")).toHaveLength(4);
  expect(usage.filter(d => d.role === "build" || d.role === "review").every(d => d.tier === 2)).toBe(true);
  expect(r.metrics.usage).toMatchObject({ inputTokens: 115, outputTokens: 35 });
});
