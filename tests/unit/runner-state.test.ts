import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AppendInput, LedgerEntry } from "../../packages/cli/src/ledger/ledger.ts";
import { buildAlternativeSwitch, buildLease, failureEvidence, isDone, leaseExpired, rebuildState, repairsUsed } from "../../packages/cli/src/runner/state.ts";

import { shortTmp } from "../helpers.ts";

const root = shortTmp("jrs-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let evidenceNumber = 0;

const revision = "a".repeat(40);
function entries(events: AppendInput[]): LedgerEntry[] {
  return events.map((e, i) => ({ ...e, task_id: e.task_id ?? null, attempt_id: e.attempt_id ?? null, seq: i + 1, ts: new Date(0).toISOString(), prev_hash: "", hash: String(i) }));
}
const event = (kind: AppendInput["kind"], data: unknown = {}, task_id: string | null = "one", attempt_id: string | null = "a1"): AppendInput => ({ kind, actor: "runner", task_id, attempt_id, data });
const created = (id = "one", data = {}): AppendInput => event("task_created", { dependencies: [], priority: 0, requiredChecks: ["unit"], requiredReviews: ["code"], ...data }, id, null);
const started = [event("run_started", { runId: "r1", pid: 51 }, null, null), created(), buildLease({ taskId: "one", attemptId: "a1", runId: "r1", holderPid: 51, ttlMs: 1000 }, () => 0), event("attempt_started", { runId: "r1", baseRevision: revision, workspace: "/work/one-a1", processGroup: 61 })];
const ended = event("attempt_ended", { status: "completed", candidateRevision: revision });
const gate = event("gate_result", { check: "unit", revision, status: "pass", evidence: { dir: "/evidence", files: { stdout: "hash" } } });
const review = event("review_result", { reviewer: "code", revision, status: "pass" });
const passed = event("state_reached", { state: "passed", revision });


function failureFixture(caseResults = [{ id: "bad", code: 1 as number | null, timedOut: false }, { id: "good", code: 0 as number | null, timedOut: false }]) {
  const dir = join(root, `evidence${++evidenceNumber}`);
  const files: Record<string, string> = {};
  for (const c of caseResults) {
    mkdirSync(join(dir, "cases", c.id), { recursive: true });
    const content = {
      stdout: Array.from({ length: 80 }, (_, i) => `line-${i}`).join("\n") + "\n",
      stderr: "old-prefix\n" + "😀".repeat(3000) + "\nlast-error\n",
      code: c.code === null ? "signal\n" : `${c.code}\n`,
    };
    for (const [name, body] of Object.entries(content)) {
      const relative = `cases/${c.id}/${name}`;
      writeFileSync(join(dir, relative), body);
      files[relative] = createHash("sha256").update(body).digest("hex");
    }
  }
  for (const name of ["verify-stdout.log", "verify-stderr.log"]) {
    writeFileSync(join(dir, name), "assertion failed\n");
    files[name] = createHash("sha256").update("assertion failed\n").digest("hex");
  }
  const result = event("gate_result", { check: "unit", revision, status: "fail", caseResults, verifyExitCode: 1, verifyTimedOut: false, completed: false, evidence: { dir, files } });
  const task = () => rebuildState(entries([...started, ended, result]), { now: 100 }).tasks.one!;
  return { dir, result, task };
}

describe("runner ledger replay", () => {
  it("builds an expiring lease and detects a dead holder before the expiry", () => {
    const input = buildLease({ taskId: "one", attemptId: "a1", runId: "r1", holderPid: 51, ttlMs: 50, workspace: "/work/one-a1" }, () => 100);
    expect(input).toMatchObject({ kind: "lease", actor: "runner", task_id: "one", attempt_id: "a1", data: { expiresAt: 150, holderPid: 51 } });
    const lease = rebuildState(entries([created(), input]), { now: 100 }).activeLeases[0]!;
    expect(leaseExpired(lease, { now: () => 149, pidAlive: () => true })).toBe(false);
    expect(leaseExpired(lease, { now: () => 150, pidAlive: () => true })).toBe(true);
    expect(leaseExpired(lease, { now: () => 101, pidAlive: () => false })).toBe(true);
    expect(() => buildLease({ taskId: "one", attemptId: "a1", runId: "r1", holderPid: 0, ttlMs: 0 })).toThrow();
  });

  it("requires ended attempt plus all revision-bound gates and reviews before passing", () => {
    const good = rebuildState(entries([...started, ended, gate, review, passed]), { now: 100 });
    expect(good.tasks.one).toMatchObject({ status: "passed", attemptCount: 1, candidateRevision: revision });
    expect(good.tasks.one?.evidence).toHaveLength(2);
    expect(good.lastGreenRevision).toBe(revision);
    expect(good.activeLeases).toEqual([]);
    for (const invalid of [
      [...started, ended, passed],
      [...started, event("attempt_ended", { status: "failed", candidateRevision: revision }), gate, review, passed],
      [...started, ended, gate, review, event("state_reached", { state: "passed", revision: "c".repeat(40) })],
      [...started, ended, { ...gate, data: { check: "other", revision, status: "pass" } }, review, passed],
      [...started, ended, gate, { ...review, data: { reviewer: "other", revision, status: "pass" } }, passed],
      [...started, gate, review, passed],
      [...started, ended, gate, { ...review, data: { reviewer: "code", revision: "b".repeat(40), status: "pass" } }, passed],
      [...started, ended, gate, review, { ...gate, data: { check: "unit", revision, status: "fail" } }, passed],
      [...started, ended, { ...gate, attempt_id: "old" }, review, passed],
    ]) {
      const state = rebuildState(entries(invalid), { now: 2000 });
      expect(state.tasks.one?.status).not.toBe("passed");
      expect(state.lastGreenRevision).toBeNull();
    }
  });


  it("rebuilds recorded gate and review failures immediately while the lease has not expired", () => {
    for (const outcome of [
      event("gate_result", { check: "unit", revision, status: "fail" }),
      event("review_result", { reviewer: "code", revision, status: "fail" }),
    ]) {
      const state = rebuildState(entries([...started, ended, outcome]), { now: 100 });
      expect(state.tasks.one?.status).toBe("failed");
      expect(state.activeLeases).toEqual([]);
      expect(state.tasks.one?.candidateRevision).toBe(revision);
      expect(state.nextRunnableTaskId).toBe("one");
    }
  });

  it("recovers a committed candidate missing attempt_ended as interrupted, never passed", () => {
    const state = rebuildState(entries([...started, gate, review, passed]), { now: 10, alivePids: new Set() });
    expect(state.tasks.one).toMatchObject({ status: "failed", attemptCount: 1, interruption: "attempt ended without a result" });
    expect(state.activeLeases).toEqual([]);
    expect(state.nextRunnableTaskId).toBe("one");
    expect(state.runs[0]).toMatchObject({ workspaces: ["/work/one-a1"], processGroups: [61] });
  });

  it("keeps live attempts running, usage waits neutral, and retries counted by unique attempt", () => {
    const live = rebuildState(entries([...started, event("attempt_started", { runId: "r1" }), event("usage_wait", { until: 700 })]), { now: 100 });
    expect(live.tasks.one).toMatchObject({ status: "running", attemptCount: 1, usageWaitUntil: 700 });
    expect(live.nextRunnableTaskId).toBeNull();
    const wait = rebuildState(entries([...started, event("usage_wait", { until: 700 }), event("attempt_ended", { status: "usage_wait" })]), { now: 100 });
    expect(wait.tasks.one).toMatchObject({ status: "pending", attemptCount: 1 });
    expect(wait.nextRunnableTaskId).toBeNull();
    expect(rebuildState(entries([...started, event("attempt_ended", { status: "usage_wait" }), event("usage_wait", { until: 700 })]), { now: 701 }).nextRunnableTaskId).toBe("one");
  });


  it("resumes a usage wait with the same attempt", () => {
    const resumed = rebuildState(entries([...started, event("attempt_ended", { status: "usage_wait" }), event("usage_wait", { until: 70 }), event("run_started", { runId: "r2", pid: 52 }, null, null), buildLease({ taskId: "one", attemptId: "a1", runId: "r2", holderPid: 52, ttlMs: 1000 }, () => 100), event("attempt_started", { runId: "r2" })]), { now: 100 });
    expect(resumed.tasks.one).toMatchObject({ status: "running", attemptCount: 1, usageWaitUntil: null });
  });

  it("records a merge revision as last-green while retaining candidate-bound evidence", () => {
    const mergedRevision = "b".repeat(40);
    const merged = rebuildState(entries([...started, ended, gate, review, event("state_reached", { state: "passed", revision, mergedRevision })]), { now: 100 });
    expect(merged.lastGreenRevision).toBe(mergedRevision);
  });


  it("records later process checkpoints without counting another attempt", () => {
    const state = rebuildState(entries([...started, event("attempt_started", { runId: "r1", workspace: "/work/checkpoint", processGroup: 62 })]), { now: 100 });
    expect(state.tasks.one).toMatchObject({ status: "running", attemptCount: 1 });
    expect(state.runs[0]?.workspaces).toEqual(["/work/one-a1", "/work/checkpoint"]);
    expect(state.runs[0]?.processGroups).toEqual([61, 62]);
  });

  it("respects dependencies, higher priority first, ties by creation, and skips blocked tasks", () => {
    const events = [created("one", { priority: 1 }), created("two", { priority: 99, dependencies: ["one"] }), created("three", { priority: 2 }), created("four", { priority: 100 }), event("blocked", { reason: "budget" }, "four")];
    expect(rebuildState(entries(events), { now: 0 }).nextRunnableTaskId).toBe("three");
    expect(rebuildState(entries([...events, event("blocked", {}, "three")]), { now: 0 }).nextRunnableTaskId).toBe("one");
    const done = rebuildState(entries([...started, ended, gate, review, passed, created("two", { dependencies: ["one"] }), created("three")]), { now: 100, verifyEvidence: () => ({ ok: true, problems: [] }) });
    expect(done.nextRunnableTaskId).toBe("two");
  });

  it("does not accept stale outcomes, broker claims, or an expired replacement lease's old holder", () => {
    const state = rebuildState(entries([...started, ended, gate, review, passed,
      event("attempt_started", { runId: "r1" }, "one", "a2"),
      event("attempt_ended", { status: "completed", candidateRevision: revision }, "one", "a1"),
      { ...passed, actor: "broker" },
      event("run_ended", { runId: "r1" }, null, null),
    ]), { now: 100 });
    expect(state.tasks.one).toMatchObject({ status: "failed", attemptCount: 2 });
    expect(state.runs[0]?.ended).toBe(true);
    const renewed = rebuildState(entries([created(), ...[100, 200].map((time) => buildLease({ taskId: "one", attemptId: "a1", runId: "r1", holderPid: time, ttlMs: 10 }, () => time))]), { now: 205 });
    expect(renewed.activeLeases.map((l) => l.holderPid)).toEqual([200]);
  });


  it("ignores broker task outcomes and clears a previous attempt's evidence", () => {
    const broker = rebuildState(entries([created(), { ...event("blocked"), actor: "broker" }]), { now: 0 });
    expect(broker.tasks.one?.status).toBe("pending");
    const state = rebuildState(entries([...started, ended, gate, review, passed,
      event("attempt_started", { runId: "r1" }, "one", "a2"),
      event("attempt_ended", { status: "completed", candidateRevision: revision }, "one", "a2"),
      { ...passed, attempt_id: "a2" },
    ]), { now: 2000 });
    expect(state.tasks.one?.status).not.toBe("passed");
    expect(state.tasks.one?.evidence).toEqual([]);
  });

  it("rejects malformed replay payloads instead of guessing and handles prototype-shaped task IDs", () => {
    expect(() => rebuildState(entries([created("one", { priority: "high" })]), { now: 0 })).toThrow();
    const state = rebuildState(entries([created("__proto__")]), { now: 0 });
    expect(state.tasks.__proto__?.status).toBe("pending");
    expect(state.nextRunnableTaskId).toBe("__proto__");
  });
});


describe("decision 87 shared state and repair evidence", () => {
  it("retains title, acceptance ids, and optional story ids in the shared task definition", () => {
    const t = rebuildState(entries([created("T1", { title: "Build the search", acceptanceCriteria: ["AC1", "AC2"], storyIds: ["S1"] })]), { now: 0 }).tasks.T1!;
    expect(t.definition).toMatchObject({ title: "Build the search", acceptanceCriteria: ["AC1", "AC2"], storyIds: ["S1"] });
    expect(rebuildState(entries([created()]), { now: 0 }).tasks.one?.definition).toMatchObject({ title: "", acceptanceCriteria: [], storyIds: [] });
  });

  it("isDone requires the completion checkpoint and every named check and reviewer", () => {
    const definition = created("one", { requiredChecks: ["unit", "acceptance"], requiredReviews: ["code", "security"] });
    const prefix = [started[0]!, definition, ...started.slice(2), ended, gate, review];
    const extraGate = event("gate_result", { check: "acceptance", revision, status: "pass", evidence: {} });
    const extraReview = event("review_result", { reviewer: "security", revision, status: "pass" });
    const verify = vi.fn(() => ({ ok: true, problems: [] }));
    const done = rebuildState(entries([...prefix, extraGate, extraReview, passed]), { now: 100 }).tasks.one!;
    expect(isDone(done, verify)).toBe(true);
    expect(verify).toHaveBeenCalledTimes(2);
    for (const events of [prefix, [...prefix, extraGate, extraReview], [...prefix, extraGate, { ...extraReview, data: { reviewer: "code", revision, status: "pass" } }, passed]]) {
      const task = rebuildState(entries(events), { now: 100 }).tasks.one!;
      expect(isDone(task, verify)).toBe(false);
    }
    expect(isDone({ ...done, completion: null }, verify)).toBe(false);
    expect(isDone({ ...done, candidateRevision: "b".repeat(40) }, verify)).toBe(false);
  });

  it("isDone re-verifies the recorded gate evidence and refuses edits after a pass", () => {
    const p = failureFixture();
    const passedGate = { ...p.result, data: { ...(p.result.data as object), status: "pass" } };
    const task = rebuildState(entries([...started, ended, passedGate, review, passed]), { now: 100 }).tasks.one!;
    expect(isDone(task)).toBe(true);
    writeFileSync(join(p.dir, "cases", "bad", "stdout"), "edited after pass");
    expect(isDone(task)).toBe(false);
  });

  it("counts one repair for crash then failure then crash", () => {
    const task = rebuildState(entries([...started,
      event("attempt_started", { runId: "r1" }, "one", "a2"),
      event("attempt_ended", { status: "completed", candidateRevision: revision }, "one", "a2"),
      event("gate_result", { check: "unit", revision, status: "fail" }, "one", "a2"),
      event("review_result", { reviewer: "code", revision, status: "fail" }, "one", "a2"),
      event("attempt_started", { runId: "r1" }, "one", "a3"),
    ]), { now: 2000 }).tasks.one!;
    expect(repairsUsed(task)).toBe(1);
    expect(task.attempts.map((a) => a.outcome)).toEqual([null, "completed", null]);
  });

  it.each(["gate_result", "review_result"] as const)("counts completed %s failures and excludes usage waits, interrupted sessions, and foreign revisions", (kind) => {
    const failure = event(kind, { check: "unit", reviewer: "code", revision, status: "fail" });
    for (const status of [null, "usage_wait", "failed", "completed"] as const) {
      const suffix = status ? [event("attempt_ended", { status, candidateRevision: revision })] : [];
      const task = rebuildState(entries([...started, ...suffix, failure]), { now: 2000 }).tasks.one!;
      expect(repairsUsed(task)).toBe(status === "completed" ? 1 : 0);
    }
    const task = rebuildState(entries([...started, ended, { ...failure, data: { check: "unit", reviewer: "code", revision: "b".repeat(40), status: "fail" } }]), { now: 2000 }).tasks.one!;
    expect(repairsUsed(task)).toBe(0);
  });

  it("records an alternative switch using decision entries and rebuilds its history", () => {
    const input = buildAlternativeSwitch({ taskId: "one", decisionId: "D3", from: "primary", to: "fallback", reason: "Primary failed protected checks" });
    expect(input).toEqual({ kind: "decision", actor: "runner", task_id: "one", data: { type: "alternative_switch", decisionId: "D3", from: "primary", to: "fallback", reason: "Primary failed protected checks" } });
    const task = rebuildState(entries([created(), input]), { now: 0 }).tasks.one!;
    expect(task.alternativeSwitches).toEqual([input.data]);
    expect(() => buildAlternativeSwitch({ taskId: "one", decisionId: "D3", from: "same", to: "same", reason: "unchanged" })).toThrow();
  });

  it("reads only verified failing case output, with 40-line and 4 KB combined case bounds", () => {
    const p = failureFixture();
    const order: string[] = [];
    const verify = vi.fn(() => { order.push("verify"); return { ok: true, problems: [] }; });
    const reader = vi.fn((path: string, _maxBytes: number) => { order.push(path); return readFileSync(path, "utf8"); });
    const result = failureEvidence(p.task(), reader, verify)!;
    expect(result.verified).toBe(true);
    expect(order[0]).toBe("verify");
    expect(result.cases).toHaveLength(1);
    const c = result.cases[0]!;
    expect(c.id).toBe("bad");
    expect(c.code).toBe(1);
    expect(c.stdout.split("\n")).toHaveLength(40);
    expect(c.stdout).toContain("line-79");
    expect(c.stdout).not.toContain("line-0\n");
    expect(c.stderr).toContain("last-error");
    expect(Buffer.byteLength(c.stdout) + Buffer.byteLength(c.stderr)).toBeLessThanOrEqual(4096);
    expect(reader.mock.calls.map(([path]) => path).some((path) => path.includes("/good/"))).toBe(false);
    expect(reader.mock.calls.some(([path]) => path.endsWith("/bad/code"))).toBe(true);
  });

  it("refuses tampered evidence before reading output", () => {
    const p = failureFixture();
    writeFileSync(join(p.dir, "cases", "bad", "stderr"), "forged");
    const reader = vi.fn(() => "must not read");
    const result = failureEvidence(p.task(), reader)!;
    expect(result.verified).toBe(false);
    expect(result.cases).toEqual([]);
    expect(result.problems.join(" ")).toContain("changed");
    expect(reader).not.toHaveBeenCalled();
  });

  it("includes observations when verify failed despite exit-zero cases", () => {
    const p = failureFixture([{ id: "zero", code: 0, timedOut: false }]);
    const result = failureEvidence(p.task())!;
    expect(result.cases.map((c) => [c.id, c.code])).toEqual([["zero", 0]]);
    expect(result.verification).toMatchObject({ code: 1, stderr: "assertion failed" });
  });

  it("keeps signaled and timed-out cases and uses the latest failing gate across attempts", () => {
    const p = failureFixture([{ id: "signal", code: null, timedOut: false }, { id: "timeout", code: 0, timedOut: true }]);
    const task = rebuildState(entries([...started, ended, p.result, event("attempt_started", { runId: "r1" }, "one", "a2")]), { now: 2000 }).tasks.one!;
    const result = failureEvidence(task)!;
    expect(result).not.toBeNull();
    expect(result.cases.map((c) => [c.id, c.code])).toEqual([["signal", null], ["timeout", 0]]);
    expect(result.revision).toBe(revision);
    expect(failureEvidence(rebuildState(entries([created()]), { now: 0 }).tasks.one!)).toBeNull();
  });

  it("refuses malformed case paths and outputs absent from the hashed manifest", () => {
    for (const unsafe of ["../outside", "absent"]) {
      const p = failureFixture();
      const result = { ...p.result, data: { ...(p.result.data as object), caseResults: [{ id: unsafe, code: 1, timedOut: false }] } };
      const task = rebuildState(entries([...started, ended, result]), { now: 100 }).tasks.one!;
      const reader = vi.fn(() => "must not read");
      expect(failureEvidence(task, reader)!.verified).toBe(false);
      expect(reader).not.toHaveBeenCalled();
    }
  });
});


describe("decision 88 dispatch and tampered gates", () => {
  const sessionWait = (until: number, taskId: string | null = "one", attemptId: string | null = "a1") => event("usage_wait", {
    taskId, until, resumeAt: until, resetAt: until / 1000, waitMs: until - 100,
    fallback: false, reason: "usage-limited", countsAsFailure: false, futureSessionField: { allowed: true },
  }, taskId, attemptId);

  it("accepts session-shaped passthrough wait fields and pauses every task", () => {
    const events = [...started, event("attempt_ended", { status: "usage_wait" }), created("two", { priority: 10 }), sessionWait(700)];
    expect(() => rebuildState(entries(events), { now: 100 })).not.toThrow();
    const state = rebuildState(entries(events), { now: 100 });
    expect(state.nextRunnableTaskId).toBeNull();
    expect(state.usageWaitUntil).toBe(700);
    expect(state.usageWaits).toEqual([sessionWait(700).data]);
    expect(state.tasks.one?.status).toBe("pending");
    expect(state.tasks.two?.status).toBe("pending");
    expect(repairsUsed(state.tasks.one!)).toBe(0);
    expect(rebuildState(entries(events), { now: 700 }).nextRunnableTaskId).toBe("two");
  });

  it("holds dispatch for the longest wait despite a newer attempt or a shorter later wait", () => {
    const events = [...started, created("two", { priority: 10 }), sessionWait(900),
      event("attempt_started", { runId: "r1" }, "one", "a2"), sessionWait(700, "two", "old-attempt")];
    const state = rebuildState(entries(events), { now: 600 });
    expect(state.tasks.one?.usageWaitUntil).toBeNull();
    expect(state.usageWaitUntil).toBe(900);
    expect(state.nextRunnableTaskId).toBeNull();
    const expired = rebuildState(entries(events), { now: 900 });
    expect(expired.usageWaitUntil).toBeNull();
    expect(expired.nextRunnableTaskId).toBe("two");
  });

  it("honors an account-wide wait with no task or attempt and validates until", () => {
    const events = [created("two"), sessionWait(700, null, null)];
    expect(rebuildState(entries(events), { now: 100 }).nextRunnableTaskId).toBeNull();
    expect(() => rebuildState(entries([created(), event("usage_wait", { until: "tomorrow", countsAsFailure: false }, null, null)]), { now: 100 })).toThrow();
  });

  it.each([false, true])("blocks a tampered check immediately, completed=%s, and dispatches other tasks", (completed) => {
    const tampered = event("gate_result", { check: "unit", revision, status: "tampered", problems: ["check changed"] });
    const state = rebuildState(entries([...started, ...(completed ? [ended] : []), tampered, created("two")]), { now: 100 });
    expect(state.tasks.one).toMatchObject({ status: "blocked", blockedReason: "protected check changed" });
    expect(state.activeLeases).toEqual([]);
    expect(state.nextRunnableTaskId).toBe("two");
    expect(repairsUsed(state.tasks.one!)).toBe(0);
  });

  it("does not charge a repair for a tampered attempt even if another gate already failed", () => {
    const state = rebuildState(entries([...started, ended,
      event("gate_result", { check: "unit", revision, status: "fail" }),
      event("gate_result", { check: "acceptance", revision, status: "tampered" }),
    ]), { now: 100 });
    expect(state.tasks.one?.status).toBe("blocked");
    expect(repairsUsed(state.tasks.one!)).toBe(0);
    expect(state.nextRunnableTaskId).toBeNull();
  });

  it("keeps tampering blocked across late completion, leases, attempts, and passing checkpoints", () => {
    const state = rebuildState(entries([...started, event("gate_result", { check: "unit", revision, status: "tampered" }), ended,
      buildLease({ taskId: "one", attemptId: "a2", runId: "r1", holderPid: 51, ttlMs: 1000 }, () => 0),
      event("attempt_started", { runId: "r1" }, "one", "a2"),
      event("attempt_ended", { status: "completed", candidateRevision: revision }, "one", "a2"),
      { ...gate, attempt_id: "a2" }, { ...review, attempt_id: "a2" }, { ...passed, attempt_id: "a2" },
    ]), { now: 100 });
    expect(state.tasks.one).toMatchObject({ status: "blocked", blockedReason: "protected check changed" });
    expect(state.activeLeases).toEqual([]);
    expect(state.nextRunnableTaskId).toBeNull();
    expect(isDone(state.tasks.one!, () => ({ ok: true, problems: [] }))).toBe(false);
  });
});


describe("review lease and dependency safeguards", () => {
  it("keeps a new attempt lease owned until a newer attempt starts", () => {
    const lease = buildLease({ taskId: "one", attemptId: "a2", runId: "r1", holderPid: 51, ttlMs: 1000 }, () => 100);
    const events = [...started, event("attempt_ended", { status: "failed" }), lease];
    const state = rebuildState(entries(events), { now: 200 });
    expect(state.tasks.one?.status).toBe("leased");
    expect(state.nextRunnableTaskId).toBeNull();
    const superseded = rebuildState(entries([...events, event("attempt_started", { runId: "r1" }, "one", "a3")]), { now: 200 });
    expect(superseded.tasks.one?.status).toBe("failed");
  });
  it("unlocks dependencies only when isDone re-verifies their evidence", () => {
    const p = failureFixture();
    const goodGate = { ...p.result, data: { ...(p.result.data as object), status: "pass" } };
    const events = [...started, ended, goodGate, review, passed, created("two", { dependencies: ["one"] })];
    expect(rebuildState(entries(events), { now: 100 }).nextRunnableTaskId).toBe("two");
    writeFileSync(join(p.dir, "cases", "bad", "stdout"), "tampered");
    const state = rebuildState(entries(events), { now: 100 });
    expect(state.tasks.one?.status).toBe("passed");
    expect(state.nextRunnableTaskId).toBeNull();
  });
});
