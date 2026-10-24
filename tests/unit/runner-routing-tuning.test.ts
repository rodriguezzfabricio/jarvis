import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MODELS } from "../../packages/cli/src/config/pins.ts";
import type { AppendInput, LedgerEntry } from "../../packages/cli/src/ledger/ledger.ts";
import type { TaskOutcome } from "../../packages/cli/src/runner/harness.ts";
import { DEFAULT_ROUTING, loadRouting, validateRouting, type ModelTier, type RoutingTable } from "../../packages/cli/src/runner/routing.ts";
import {
  assertWithinFloors, proposeRouting, routingProposalLines, routingStats, writeRoutingProposals, type RoutingProposal,
} from "../../packages/cli/src/runner/routing-tuning.ts";
import { buildSessionUsageEntry } from "../../packages/cli/src/runner/usage-log.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));
const fresh = () => { const root = mkdtempSync(join(realpathSync("/tmp"), "jarvis-tune-")); roots.push(root); return root; };
const revision = "a".repeat(40);
const model: Record<ModelTier, string> = MODELS;
const finished = { status: "finished", exitCode: 0, durationMs: 1, usage: [], usageWaitUntil: undefined } as TaskOutcome;

type Verdict = "pass" | "gate_fail" | "review_fail" | "tampered" | "unknown";
interface Attempt { tier: ModelTier; verdict: Verdict; role?: "build" | "debug"; failure?: "gate_fail" | "review_fail" }
function history(tasks: Attempt[][], actor: "runner" | "broker" = "runner"): LedgerEntry[] {
  const out: AppendInput[] = [{ kind: "run_started", actor: "runner", data: { runId: "r1", pid: 2 } }];
  tasks.forEach((attempts, t) => {
    const task = `T${t}`;
    out.push({ kind: "task_created", actor: "runner", task_id: task, data: {} });
    attempts.forEach((a, i) => {
      const attempt = `${task}-a${i}`;
      const at = (kind: AppendInput["kind"], data: unknown): AppendInput => ({ kind, actor, task_id: task, attempt_id: attempt, data });
      out.push(at("attempt_started", { runId: "r1" }));
      const failure = a.failure ?? (i > 0 ? "gate_fail" : undefined);
      out.push({ ...buildSessionUsageEntry({ runId: "r1", taskId: task, attemptId: attempt, role: a.role ?? "build", tier: 1, route: { model: model[a.tier], modelTier: a.tier }, outcome: finished, ...(failure ? { failure } : {}) }), actor });
      out.push(at("session_usage", { ignored: true }));
      if (a.verdict === "gate_fail") out.push(at("gate_result", { check: "unit", revision, status: "fail" }));
      if (a.verdict === "tampered") out.push(at("gate_result", { check: "unit", revision, status: "tampered" }));
      if (a.verdict === "review_fail") out.push(at("gate_result", { check: "unit", revision, status: "pass" }), at("review_result", { reviewer: "code", revision, status: "fail" }));
      if (a.verdict === "pass") out.push(at("gate_result", { check: "unit", revision, status: "pass" }), at("review_result", { reviewer: "code", revision, status: "pass" }), at("state_reached", { state: "passed", revision }));
    });
  });
  return out.map((e, i) => ({ ...e, task_id: e.task_id ?? null, attempt_id: e.attempt_id ?? null, seq: i + 1, ts: "", prev_hash: "", hash: `h${i}` }));
}
/** n tasks whose first fast attempt passes `passes` times; failures are repaired on strong. */
const fastRuns = (n: number, passes: number, role: "build" | "debug" = "build"): Attempt[][] => Array.from({ length: n }, (_, i) =>
  i < passes ? [{ tier: "fast", verdict: "pass", role }] : [{ tier: "fast", verdict: i % 2 ? "gate_fail" : "review_fail", role }, { tier: "strong", verdict: "pass", role }]);
const clone = (r: RoutingTable): RoutingTable => JSON.parse(JSON.stringify(r)) as RoutingTable;

describe("routing stats", () => {
  it("counts first attempts, repairs, gate and review failures per role and tier", () => {
    const stats = routingStats(history([...fastRuns(4, 1), [{ tier: "fast", verdict: "tampered" }], [{ tier: "fast", verdict: "unknown" }]]));
    expect(stats).toEqual([
      { role: "build", modelTier: "fast", firstAttempts: 4, firstPasses: 1, firstPassRate: 0.25, repairAttempts: 0, repairPasses: 0, gateFails: 2, reviewFails: 1 },
      { role: "build", modelTier: "strong", firstAttempts: 0, firstPasses: 0, firstPassRate: null, repairAttempts: 3, repairPasses: 3, gateFails: 0, reviewFails: 0 },
    ]);
  });

  it("never counts an escalated or later attempt as a first attempt", () => {
    const stats = routingStats(history([[{ tier: "fast", verdict: "gate_fail" }, { tier: "fast", verdict: "pass" }], [{ tier: "fast", verdict: "pass", failure: "review_fail" }]]));
    expect(stats).toEqual([{ role: "build", modelTier: "fast", firstAttempts: 1, firstPasses: 0, firstPassRate: 0, repairAttempts: 2, repairPasses: 2, gateFails: 1, reviewFails: 0 }]);
  });

  it("ignores broker-authored history", () => {
    expect(routingStats(history(fastRuns(6, 0), "broker"))).toEqual([]);
  });
});

describe("routing proposals", () => {
  it("proposes starting a role on the strong tier when the fast first-attempt pass rate is under the threshold", () => {
    const routing = clone(DEFAULT_ROUTING);
    const file = proposeRouting(history(fastRuns(10, 4)), routing, { now: () => Date.parse("2026-10-24T00:00:00Z") });
    expect(file.proposals).toEqual([expect.objectContaining({ id: "build-start-fast-to-strong", path: "roles.build.start", from: "fast", to: "strong" })]);
    expect(file.proposals[0]!.reason).toMatch(/40%.*10 tasks.*60%/);
    expect(file.override).toEqual({ roles: { build: { start: "strong" } } });
    expect(file).toMatchObject({ version: 1, generatedAt: "2026-10-24T00:00:00.000Z", ledgerHead: expect.stringMatching(/^h/), threshold: 0.6, minSamples: 5 });
    expect(routing).toEqual(DEFAULT_ROUTING);
  });

  it("does not propose at or above the threshold", () => {
    expect(proposeRouting(history(fastRuns(10, 6)), DEFAULT_ROUTING).proposals).toEqual([]);
  });

  it("does not propose from fewer samples than the minimum", () => {
    expect(proposeRouting(history(fastRuns(4, 0)), DEFAULT_ROUTING).proposals).toEqual([]);
    expect(proposeRouting(history(fastRuns(4, 0)), DEFAULT_ROUTING, { minSamples: 4 }).proposals).toHaveLength(1);
  });

  it("escalates cheap to fast, and never past strong", () => {
    const cheap = clone(DEFAULT_ROUTING);
    cheap.roles.debug.start = "cheap";
    const runs = Array.from({ length: 6 }, () => [{ tier: "cheap" as const, verdict: "gate_fail" as const, role: "debug" as const }]);
    expect(proposeRouting(history(runs), cheap).proposals.map((p) => [p.path, p.from, p.to])).toEqual([["roles.debug.start", "cheap", "fast"]]);
    const strong = clone(DEFAULT_ROUTING);
    strong.roles.build.start = "strong";
    const strongRuns = Array.from({ length: 6 }, () => [{ tier: "strong" as const, verdict: "gate_fail" as const }]);
    expect(proposeRouting(history(strongRuns), strong).proposals).toEqual([]);
  });

  it("only uses history from the tier the role starts on now", () => {
    const strong = clone(DEFAULT_ROUTING);
    strong.roles.build.start = "strong";
    expect(proposeRouting(history(fastRuns(10, 0)), strong).proposals).toEqual([]);
  });

  it("produces an override that loads and keeps every floor", () => {
    const file = proposeRouting(history([...fastRuns(10, 0), ...fastRuns(10, 0, "debug")]), DEFAULT_ROUTING);
    expect(file.proposals.map((p) => p.path)).toEqual(["roles.build.start", "roles.debug.start"]);
    const dir = fresh();
    writeFileSync(join(dir, ".jarvis-routing.json"), JSON.stringify(file.override));
    const loaded = loadRouting(dir);
    expect(loaded.roles.build.start).toBe("strong");
    expect(loaded.tiers.strong.model).toBe(MODELS.strong);
    expect(loaded.roles.review).toEqual(DEFAULT_ROUTING.roles.review);
    expect(loaded.escalate_on).toEqual(["gate_fail", "review_fail"]);
  });

  it.each([
    ["a reviewer downgrade", { id: "x", path: "roles.review.default", from: "fast", to: "cheap", reason: "" }],
    ["a strong-tier model change", { id: "x", path: "tiers.strong.model", from: "fast", to: "strong", reason: "" }],
    ["an escalate_on change", { id: "x", path: "escalate_on", from: "fast", to: "strong", reason: "" }],
    ["a builder downgrade", { id: "x", path: "roles.build.start", from: "fast", to: "cheap", reason: "" }],
    ["a no-op", { id: "x", path: "roles.build.start", from: "fast", to: "fast", reason: "" }],
    ["a proposal from a tier not in effect", { id: "x", path: "roles.build.start", from: "cheap", to: "fast", reason: "" }],
  ])("refuses %s", (_name, proposal) => {
    expect(() => assertWithinFloors([proposal as RoutingProposal], DEFAULT_ROUTING)).toThrow();
  });

  it("validates options", () => {
    expect(() => proposeRouting([], DEFAULT_ROUTING, { threshold: 1.5 })).toThrow();
    expect(() => proposeRouting([], DEFAULT_ROUTING, { minSamples: 0 })).toThrow();
    expect(() => proposeRouting([], { ...DEFAULT_ROUTING, escalate_on: [] } as unknown as RoutingTable)).not.toThrow();
  });
});

describe("routing proposal file", () => {
  it("writes routing-proposals.json in the runner folder and changes no routing", () => {
    const dir = fresh();
    const file = proposeRouting(history(fastRuns(10, 0)), DEFAULT_ROUTING);
    const path = writeRoutingProposals(dir, file, DEFAULT_ROUTING);
    expect(path).toBe(join(dir, "routing-proposals.json"));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(file);
    expect(readdirSync(dir)).toEqual(["routing-proposals.json"]);
    expect(existsSync(join(dir, ".jarvis-routing.json"))).toBe(false);
    expect(validateRouting(DEFAULT_ROUTING)).toEqual(DEFAULT_ROUTING);
  });

  it("refuses a symlinked folder or target, and a file that breaks a floor", () => {
    const real = fresh();
    const dir = fresh();
    const linked = join(dir, "linked");
    symlinkSync(real, linked);
    const file = proposeRouting(history(fastRuns(10, 0)), DEFAULT_ROUTING);
    expect(() => writeRoutingProposals(linked, file, DEFAULT_ROUTING)).toThrow(/real directory/);
    const other = fresh();
    symlinkSync(join(real, "elsewhere"), join(other, "routing-proposals.json"));
    expect(() => writeRoutingProposals(other, file, DEFAULT_ROUTING)).toThrow(/symlink/);
    expect(existsSync(join(real, "elsewhere"))).toBe(false);
    const bad = { ...file, override: { roles: { review: { tier2: "strong", default: "cheap" } } } };
    const plain = fresh();
    mkdirSync(join(plain, "x"));
    expect(() => writeRoutingProposals(plain, bad as unknown as typeof file, DEFAULT_ROUTING)).toThrow(/floor|override/);
    expect(existsSync(join(plain, "routing-proposals.json"))).toBe(false);
  });

  it("renders report lines that point at the file and change nothing", () => {
    const file = proposeRouting(history(fastRuns(10, 2)), DEFAULT_ROUTING);
    const text = routingProposalLines(file, "/home/x/.jarvis/projects/p/routing-proposals.json").join("\n");
    expect(text).toContain("## Routing proposals");
    expect(text).toContain("build start fast → strong");
    expect(text).toContain("routing-proposals.json");
    expect(text).toMatch(/not applied/i);
    expect(routingProposalLines(proposeRouting([], DEFAULT_ROUTING), "/p")).toEqual(["## Routing proposals", "", "- None."]);
  });
});
