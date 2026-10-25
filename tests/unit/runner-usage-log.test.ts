import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Ledger, type AppendInput, type LedgerEntry } from "../../packages/cli/src/ledger/ledger.ts";
import type { SessionUsage, TaskOutcome } from "../../packages/cli/src/runner/harness.ts";
import { renderReport } from "../../packages/cli/src/runner/report.ts";
import { rebuildState } from "../../packages/cli/src/runner/state.ts";
import {
  buildSessionUsageEntry, recordSessionUsage, summarizeUsage, usageReportLines, type SessionUsageInput,
} from "../../packages/cli/src/runner/usage-log.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));
const freshLedger = () => { const root = mkdtempSync(join(realpathSync("/tmp"), "jarvis-usage-")); roots.push(root); return Ledger.open(root); };

const usage = (extra: Partial<SessionUsage> = {}): SessionUsage => ({
  reportedModel: "claude-sonnet-5-5", inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 30000, cacheWriteTokens: 4000,
  costUsd: 0.5, turns: 6, complete: true, ...extra,
});
const outcome = (extra: Partial<TaskOutcome> = {}, session: SessionUsage | null = usage()): TaskOutcome => ({
  status: "finished", exitCode: 0, durationMs: 60_000, usageWaitUntil: undefined,
  usage: [
    { windows: { five_hour: { utilization: 0.1, resetsAt: 5000 }, seven_day: { utilization: 0.02, resetsAt: 9000 } } },
    { windows: { five_hour: { utilization: 0.3, resetsAt: 5000 }, seven_day: { utilization: 0.04, resetsAt: 9000 } } },
  ],
  ...(session ? { sessionUsage: session } : {}),
  ...extra,
} as TaskOutcome);
const input = (extra: Partial<SessionUsageInput> = {}): SessionUsageInput => ({
  runId: "r1", taskId: "T1", attemptId: "a1", role: "build", tier: 1,
  route: { model: "claude-sonnet-5-5", modelTier: "fast" }, outcome: outcome(), ...extra,
});
const dataOf = (e: AppendInput) => e.data as Record<string, unknown>;

function entries(events: AppendInput[]): LedgerEntry[] {
  return events.map((e, i) => ({ ...e, task_id: e.task_id ?? null, attempt_id: e.attempt_id ?? null, seq: i + 1, ts: new Date(0).toISOString(), prev_hash: "", hash: String(i) }));
}
const runStarted = (runId: string): AppendInput => ({ kind: "run_started", actor: "runner", data: { runId, pid: 42 } });

describe("session usage entries", () => {
  it("records one runner session_usage entry per attempt with tokens, cost, model, time, turns and windows", () => {
    const entry = buildSessionUsageEntry(input());
    expect(entry).toMatchObject({ kind: "session_usage", actor: "runner", task_id: "T1", attempt_id: "a1" });
    expect(entry.data).toEqual({
      runId: "r1", role: "build", tier: 1, modelTier: "fast", model: "claude-sonnet-5-5", reportedModel: "claude-sonnet-5-5",
      failure: null, status: "finished",
      tokens: { input: 1000, output: 2000, cacheRead: 30000, cacheWrite: 4000 },
      costUsd: 0.5, durationMs: 60_000, turns: 6, complete: true,
      windows: { five_hour: [{ before: 0.1, after: 0.3, resetsAt: 5000 }], seven_day: [{ before: 0.02, after: 0.04, resetsAt: 9000 }] },
      problems: [],
    });
  });

  it("records the escalation reason of a repair attempt", () => {
    expect(dataOf(buildSessionUsageEntry(input({ failure: "gate_fail", route: { model: "claude-opus-5-5", modelTier: "strong" }, outcome: outcome({}, usage({ reportedModel: "claude-opus-5-5" })) })))).toMatchObject({ failure: "gate_fail", modelTier: "strong" });
  });

  it("keeps missing fields unknown (null), never zero, and says which", () => {
    const data = dataOf(buildSessionUsageEntry(input({ outcome: outcome({}, usage({ inputTokens: undefined, costUsd: undefined, turns: undefined })) })));
    expect(data.tokens).toMatchObject({ input: null, output: 2000 });
    expect(data.costUsd).toBeNull();
    expect(data.turns).toBeNull();
    expect(data.problems).toEqual(expect.arrayContaining(["missing inputTokens", "missing costUsd", "missing turns"]));
  });

  it("marks a truncated session incomplete, a lower bound", () => {
    const data = dataOf(buildSessionUsageEntry(input({ outcome: outcome({ status: "timeout" }, usage({ complete: false, costUsd: undefined })) })));
    expect(data).toMatchObject({ complete: false, status: "timeout", costUsd: null });
    expect(data.problems).toContain("no final result: figures are a lower bound");
  });

  it("records an outcome without usage as unknown and incomplete", () => {
    const data = dataOf(buildSessionUsageEntry(input({ outcome: outcome({ status: "error", message: "boom" } as Partial<TaskOutcome>, null) })));
    expect(data).toMatchObject({ complete: false, costUsd: null, turns: null, tokens: { input: null, output: null, cacheRead: null, cacheWrite: null } });
    expect(data.problems).toContain("no usage reported");
  });

  it.each([
    ["inputTokens", 1e15], ["outputTokens", -1], ["cacheReadTokens", 1.5], ["cacheWriteTokens", Number.NaN],
    ["costUsd", 1e9], ["costUsd", -0.01], ["turns", 1e9], ["turns", 2.5], ["inputTokens", Number.POSITIVE_INFINITY],
  ] as const)("rejects an implausible %s of %s", (field, value) => {
    const data = dataOf(buildSessionUsageEntry(input({ outcome: outcome({}, usage({ [field]: value })) })));
    const flat: Record<string, unknown> = { ...(data.tokens as Record<string, unknown>), costUsd: data.costUsd, turns: data.turns };
    const key = { inputTokens: "input", outputTokens: "output", cacheReadTokens: "cacheRead", cacheWriteTokens: "cacheWrite", costUsd: "costUsd", turns: "turns" }[field];
    expect(flat[key]).toBeNull();
    expect(data.problems).toContain(`implausible ${field}`);
  });

  it("rejects an implausible wall time and window utilization", () => {
    const data = dataOf(buildSessionUsageEntry(input({ outcome: outcome({ durationMs: 1e13, usage: [{ windows: { five_hour: { utilization: 99, resetsAt: 1 }, "bad key!": { utilization: 0.1, resetsAt: 1 } } }] }) })));
    expect(data.durationMs).toBeNull();
    expect(data.problems).toContain("implausible durationMs");
    expect(data.windows).toEqual({});
  });

  it("drops an unrecognized reported model and flags a model that differs from the route", () => {
    const odd = dataOf(buildSessionUsageEntry(input({ outcome: outcome({}, usage({ reportedModel: "sonnet | <b>" })) })));
    expect(odd.reportedModel).toBeNull();
    expect(odd.problems).toContain("unrecognized reportedModel");
    const other = dataOf(buildSessionUsageEntry(input({ outcome: outcome({}, usage({ reportedModel: "claude-haiku-5-5" })) })));
    expect(other.reportedModel).toBe("claude-haiku-5-5");
    expect(other.problems).toContain("reported model differs from the route");
  });

  it("refuses programmer errors: an alias model or empty ids", () => {
    expect(() => buildSessionUsageEntry(input({ route: { model: "sonnet", modelTier: "fast" } }))).toThrow();
    expect(() => buildSessionUsageEntry(input({ taskId: "" }))).toThrow();
  });

  it("appends to the ledger, skips refused sessions, and never throws when the ledger fails", () => {
    const ledger = freshLedger();
    expect(recordSessionUsage(ledger, input())).toEqual({ recorded: true });
    expect(recordSessionUsage(ledger, input({ outcome: outcome({ status: "refused", reason: "no preflight" } as Partial<TaskOutcome>, null) }))).toEqual({ recorded: false, reason: "session not started" });
    expect(ledger.entries().map((e) => e.kind)).toEqual(["session_usage"]);
    const broken = { append: () => { throw new Error("disk full"); } };
    expect(recordSessionUsage(broken, input())).toEqual({ recorded: false, reason: "disk full" });
  });

  it("leaves state replay and the existing report unchanged", () => {
    const ledger = freshLedger();
    ledger.append({ kind: "task_created", actor: "runner", task_id: "T1", data: { title: "x" } });
    const before = rebuildState(ledger.entries(), { now: 0 });
    ledger.append(buildSessionUsageEntry(input()));
    expect(ledger.verify().ok).toBe(true);
    const after = rebuildState(ledger.entries(), { now: 0 });
    expect(after).toEqual(before);
    expect(renderReport(after, ledger.entries())).not.toContain("session_usage");
  });
});

describe("usage summary", () => {
  const session = (task: string, attempt: string, extra: Partial<SessionUsageInput> = {}) => buildSessionUsageEntry(input({ taskId: task, attemptId: attempt, ...extra }));
  const passed = (task: string, attempt: string): AppendInput => ({ kind: "state_reached", actor: "runner", task_id: task, attempt_id: attempt, data: { state: "passed", revision: "a".repeat(40) } });

  it("totals by task, model and role group for the latest run only", () => {
    const list = entries([
      runStarted("r0"), session("OLD", "a0", { runId: "r0" }),
      runStarted("r1"),
      session("T1", "a1"),
      session("T1", "a1-review", { role: "review", route: { model: "claude-opus-5-5", modelTier: "strong" }, outcome: outcome({}, usage({ reportedModel: "claude-opus-5-5", costUsd: 2 })) }),
      session("T2", "a2", { role: "architect" }),
      session("T2", "a3", { role: "debug", outcome: outcome({ status: "timeout" }, usage({ complete: false, costUsd: undefined, inputTokens: 10 })) }),
      passed("T1", "a1"),
    ]);
    const s = summarizeUsage(list);
    expect(s.runId).toBe("r1");
    expect(s.total).toMatchObject({ sessions: 4, incomplete: 1, inputTokens: 3010, outputTokens: 8000, costUsd: 3, durationMs: 240_000, turns: 24, unknown: 1 });
    expect(s.byRole.map((r) => [r.key, r.totals.sessions])).toEqual([["builder", 2], ["reviewer", 1], ["planner", 1]]);
    expect(s.byModel.map((r) => [r.key, r.totals.sessions])).toEqual([["claude-opus-5-5", 1], ["claude-sonnet-5-5", 3]]);
    expect(s.byTask.map((r) => [r.key, r.totals.sessions])).toEqual([["T1", 2], ["T2", 2]]);
    expect(s.acceptedTasks).toBe(1);
    expect(s.costPerAccepted).toEqual({ usd: 3, complete: false });
  });

  it("can summarize a named run or the whole ledger", () => {
    const list = entries([runStarted("r0"), session("A", "a", { runId: "r0" }), runStarted("r1"), session("B", "b")]);
    expect(summarizeUsage(list, { runId: "r0" }).total.sessions).toBe(1);
    expect(summarizeUsage(list, { runId: null }).total.sessions).toBe(2);
  });

  it("re-checks ledger data: skips broker entries and absurd values written straight to the ledger", () => {
    const good = session("T1", "a1");
    const absurd: AppendInput = { ...good, data: { ...dataOf(good), tokens: { input: 1e300, output: 1, cacheRead: 1, cacheWrite: 1 } } };
    const negative: AppendInput = { ...good, data: { ...dataOf(good), costUsd: -100 } };
    const broker: AppendInput = { ...good, actor: "broker" };
    const s = summarizeUsage(entries([runStarted("r1"), good, absurd, negative, broker, { ...good, data: null }]));
    expect(s.total.sessions).toBe(1);
    expect(s.skipped).toBe(3);
  });

  it("measures window consumption per reset period and across concurrent sessions", () => {
    const at = (before: number, after: number, resetsAt = 5000) => outcome({ usage: [{ windows: { five_hour: { utilization: before, resetsAt } } }, { windows: { five_hour: { utilization: after, resetsAt } } }] });
    const s = summarizeUsage(entries([
      runStarted("r1"),
      session("A", "a", { outcome: at(0.1, 0.3) }),
      session("B", "b", { outcome: at(0.2, 0.4) }),
      session("C", "c", { outcome: at(0.05, 0.25, 9000) }),
    ]));
    expect(s.windows).toHaveLength(1);
    expect(s.windows[0]!.key).toBe("five_hour");
    expect(s.windows[0]!.consumed).toBeCloseTo(0.5);
    expect(s.windows[0]!.peak).toBeCloseTo(0.4);
  });

  it("renders a report section with escaped cells, unknowns and the most-of-a-window warning", () => {
    const heavy = outcome({ usage: [{ windows: { five_hour: { utilization: 0.1, resetsAt: 5000 } } }, { windows: { five_hour: { utilization: 0.7, resetsAt: 5000 } } }] }, usage({ costUsd: undefined }));
    const text = usageReportLines(entries([runStarted("r1"), session("T|1\n## injected", "a1", { outcome: heavy })])).join("\n");
    expect(text).toContain("## Usage");
    expect(text).toContain("API-equivalent");
    expect(text).toContain("T\\|1 \\#\\# injected");
    expect(text).not.toContain("\n## injected");
    expect(text).toContain("unknown");
    expect(text).toMatch(/five_hour.*60%.*most of a window/);
    expect(text).toMatch(/\| Builder \| 1 \|/);
  });

  it("keeps observations in their own reset periods when one session spans a reset", () => {
    const samples = [[0.8, 5000], [0.95, 5000], [0.05, 9000], [0.1, 9000]].map(([utilization, resetsAt]) => ({ windows: { five_hour: { utilization: utilization!, resetsAt: resetsAt! } } }));
    const list = entries([runStarted("r1"), session("A", "a", { outcome: outcome({ usage: samples }) })]);
    const [window] = summarizeUsage(list).windows;
    expect(window).toMatchObject({ key: "five_hour", first: 0.8, last: 0.1, peak: 0.95 });
    expect(window!.consumed).toBeCloseTo(0.2);
    const report = usageReportLines(list).join("\n");
    expect(report).toContain("used 20%");
    expect(report).not.toContain("most of a window");
  });

  it("reads legacy single-period entries alongside sessions spanning resets without double counting", () => {
    const old = session("A", "a");
    old.data = { ...dataOf(old), windows: { five_hour: { before: 0.8, after: 0.95, resetsAt: 5000 } } };
    const samples = [[0.85, 5000], [0.9, 5000], [0.05, 9000], [0.1, 9000]].map(([utilization, resetsAt]) => ({ windows: { five_hour: { utilization: utilization!, resetsAt: resetsAt! } } }));
    const ledger = freshLedger();
    for (const entry of [runStarted("r1"), old, session("B", "b", { outcome: outcome({ usage: samples }) })]) ledger.append(entry);
    const summary = summarizeUsage(Ledger.open(ledger.dir).entries());
    expect(summary.skipped).toBe(0);
    expect(summary.total.sessions).toBe(2);
    expect(summary.windows[0]!.consumed).toBeCloseTo(0.2);
  });

  it("labels dollar figures as estimates rather than subscription charges", () => {
    const report = usageReportLines(entries([runStarted("r1"), session("T1", "a1"), passed("T1", "a1")])).join("\n");
    expect(report).toContain("$0.50");
    expect(report).toContain("API-equivalent");
    expect(report).toContain("not billed on a subscription");
    expect(report).toMatch(/cost.*estimate/i);
  });

  it("does not warn when a run used less than half a window", () => {
    const text = usageReportLines(entries([runStarted("r1"), session("T1", "a1")])).join("\n");
    expect(text).not.toContain("most of a window");
    expect(text).toContain("five_hour 10% → 30%");
  });

  it("renders a placeholder when no session was recorded", () => {
    expect(usageReportLines([])).toEqual(["## Usage", "", "- No sessions recorded."]);
  });
});
