import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { captureProcessGroup, cleanupLeftovers } from "../../packages/cli/src/runner/cleanup.ts";
import { buildLease, rebuildState } from "../../packages/cli/src/runner/state.ts";
import type { AppendInput, LedgerEntry } from "../../packages/cli/src/ledger/ledger.ts";
import { shortTmp } from "../helpers.ts";

const root = shortTmp("jrc-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function setup(paths: string[] = []) {
  const dir = join(root, String(++n));
  const worktreeRoot = join(dir, "worktrees");
  mkdirSync(join(worktreeRoot, "p"), { recursive: true });
  const pidFile = join(dir, "runner.pid");
  writeFileSync(pidFile, "51\n");
  const workspaces = paths.length ? paths : [join(worktreeRoot, "p", "task-a1")];
  for (const path of workspaces) mkdirSync(path, { recursive: true });
  const events: AppendInput[] = [{ kind: "run_started", actor: "runner", data: { runId: "dead", pid: 51, workspaces, processGroups: [61], processGroupRecords: [{ groupId: 61, leaderPid: 61, startedAt: "Mon Oct 26 01:02:03 2026", exited: false }] } }];
  const state = () => rebuildState(events.map((e, i) => ({ ...e, task_id: e.task_id ?? null, attempt_id: e.attempt_id ?? null, seq: i + 1, ts: "", hash: "", prev_hash: "" })) as LedgerEntry[], { now: 100 });
  const killed: [number, NodeJS.Signals][] = [];
  return { readProcessStartTime: () => "Mon Oct 26 01:02:03 2026", worktreeRoot, pidFile, workspaces, events, state, killed, kill: (pid: number, sig: NodeJS.Signals) => { killed.push([pid, sig]); } };
}

describe("dead runner leftovers", () => {
  it("lists and removes dead run workspaces and kills only its recorded groups", () => {
    const p = setup();
    const r = cleanupLeftovers({ ...p, state: p.state(), pidAlive: () => false, now: () => 100 });
    expect(r.deadRunIds).toEqual(["dead"]);
    expect(r.workspaces).toEqual(p.workspaces);
    expect(r.removed).toEqual(p.workspaces);
    expect(p.killed).toEqual([[-61, "SIGKILL"]]);
    expect(existsSync(p.workspaces[0]!)).toBe(false);
  });


  it("recovers a crash after workspace creation but before attempt_started", () => {
    const p = setup();
    p.events[0] = { kind: "run_started", actor: "runner", data: { runId: "dead", pid: 51 } };
    p.events.push({ kind: "task_created", actor: "runner", task_id: "task", data: {} }, buildLease({ taskId: "task", attemptId: "a1", runId: "dead", holderPid: 51, ttlMs: 1000, workspace: p.workspaces[0]!, processGroup: 61, processGroupRecord: { groupId: 61, leaderPid: 61, startedAt: "Mon Oct 26 01:02:03 2026", exited: false } }, () => 0));
    const result = cleanupLeftovers({ ...p, state: p.state(), pidAlive: () => false, now: () => 100 });
    expect(result.removed).toEqual(p.workspaces);
    expect(p.killed).toEqual([[-61, "SIGKILL"]]);
  });

  it("leaves a live prior runner entirely alone", () => {
    const p = setup();
    const older = join(p.worktreeRoot, "p", "older");
    mkdirSync(older);
    p.events.push({ kind: "run_started", actor: "runner", data: { runId: "older", pid: 52, workspaces: [older], processGroups: [62] } });
    expect(cleanupLeftovers({ ...p, state: p.state(), pidAlive: (id) => id === 51 }).removed).toEqual([]);
    expect(existsSync(older)).toBe(true);
    expect(p.killed).toEqual([]);
    expect(existsSync(p.workspaces[0]!)).toBe(true);
  });

  it("preserves a live lease's workspace and group but reclaims one whose holder died", () => {
    for (const alive of [true, false]) {
      const p = setup();
      p.events.push({ kind: "task_created", actor: "runner", task_id: "task", data: {} }, buildLease({ taskId: "task", attemptId: "a1", runId: "other", holderPid: 71, ttlMs: 1000, workspace: p.workspaces[0]!, processGroup: 61, processGroupRecord: { groupId: 61, leaderPid: 61, startedAt: "Mon Oct 26 01:02:03 2026", exited: false } }, () => 0));
      const r = cleanupLeftovers({ ...p, state: p.state(), pidAlive: (pid) => pid === 71 && alive, now: () => 100 });
      expect(r.removed).toEqual(alive ? [] : p.workspaces);
      expect(p.killed).toEqual(alive ? [] : [[-61, "SIGKILL"]]);
    }
  });


  it("protects workspace ancestors owned by a live lease even through a root alias", () => {
    const p = setup();
    const alias = join(root, `alias${n}`);
    symlinkSync(p.worktreeRoot, alias);
    const workspace = join(alias, "p", "task-a1", "nested");
    mkdirSync(workspace);
    p.events.push({ kind: "task_created", actor: "runner", task_id: "task", data: {} }, buildLease({ taskId: "task", attemptId: "a1", runId: "other", holderPid: 71, ttlMs: 1000, workspace }, () => 0));
    const result = cleanupLeftovers({ ...p, state: p.state(), pidAlive: (id) => id === 71, now: () => 100 });
    expect(result.removed).toEqual([]);
    expect(existsSync(workspace)).toBe(true);
  });

  it("never deletes outside the root, through symlink parents, or the root itself", () => {
    const p = setup();
    const outside = join(root, "outside");
    mkdirSync(join(outside, "keep"), { recursive: true });
    writeFileSync(join(outside, "keep", "proof"), "keep");
    symlinkSync(outside, join(p.worktreeRoot, "escape"));
    p.events.push({ kind: "run_started", actor: "runner", data: { runId: "bad", pid: 52, workspaces: [outside, p.worktreeRoot, join(p.worktreeRoot, "escape", "keep"), join(p.worktreeRoot, "..", "outside")] } });
    const r = cleanupLeftovers({ ...p, state: p.state(), pidAlive: () => false });
    expect(r.refused).toHaveLength(4);
    expect(existsSync(join(outside, "keep", "proof"))).toBe(true);
    expect(existsSync(p.worktreeRoot)).toBe(true);
  });


  it("refuses symlink parents even when they lead inside the root", () => {
    const p = setup();
    const target = join(p.worktreeRoot, "real", "keep");
    mkdirSync(target, { recursive: true });
    symlinkSync(join(p.worktreeRoot, "real"), join(p.worktreeRoot, "alias"));
    const path = join(p.worktreeRoot, "alias", "keep");
    p.events.push({ kind: "run_started", actor: "runner", data: { runId: "alias", pid: 52, workspaces: [path] } });
    const result = cleanupLeftovers({ ...p, state: p.state(), pidAlive: () => false });
    expect(result.refused).toContain(path);
    expect(existsSync(target)).toBe(true);
  });

  it("rechecks lease expiry using the cleanup clock", () => {
    const p = setup();
    p.events.push({ kind: "task_created", actor: "runner", task_id: "task", data: {} }, buildLease({ taskId: "task", attemptId: "a1", runId: "other", holderPid: 71, ttlMs: 1000, workspace: p.workspaces[0]! }, () => 0));
    expect(cleanupLeftovers({ ...p, state: p.state(), pidAlive: (id) => id === 71, now: () => 1001 }).removed).toEqual(p.workspaces);
  });

  it("refuses a mismatched or malformed runner.pid and never signals invalid groups", () => {
    const p = setup();
    for (const text of ["51garbage", "0", "52"]) {
      writeFileSync(p.pidFile, text);
      expect(() => cleanupLeftovers({ ...p, state: p.state(), pidAlive: () => false })).toThrow();
    }
    writeFileSync(p.pidFile, "51");
    p.events.push({ kind: "run_started", actor: "runner", data: { runId: "invalid", pid: 52, processGroups: [0, -1, 1, process.pid] } });
    expect(() => cleanupLeftovers({ ...p, state: p.state(), pidAlive: () => false })).toThrow();
    expect(p.killed).toEqual([]);
  });

  it("is idempotent for missing workspaces and ESRCH groups, and reports other kill failures", () => {
    const p = setup();
    rmSync(p.workspaces[0]!, { recursive: true });
    const gone = () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); };
    expect(cleanupLeftovers({ ...p, state: p.state(), pidAlive: () => false, kill: gone }).errors).toEqual([]);
    const denied = () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); };
    expect(cleanupLeftovers({ ...p, state: p.state(), pidAlive: () => false, kill: denied }).errors).toHaveLength(1);
  });
});


describe("review process-group identity safeguards", () => {
  const identity = { groupId: 61, leaderPid: 61, startedAt: "Mon Oct 26 01:02:03 2026", exited: false };
  it("never kills process groups from ended runs", () => {
    const p = setup();
    p.events.push({ kind: "run_ended", actor: "runner", data: { runId: "dead" } });
    const result = cleanupLeftovers({ ...p, state: p.state(), pidAlive: () => false, readProcessStartTime: () => identity.startedAt });
    expect(p.killed).toEqual([]);
    expect(result.deadRunIds).toEqual([]);
  });
  it("never kills a reused PGID whose leader start time changed", () => {
    const p = setup();
    p.events[0] = { kind: "run_started", actor: "runner", data: { runId: "dead", pid: 51, workspaces: p.workspaces, processGroups: [61], processGroupRecords: [identity] } };
    cleanupLeftovers({ ...p, state: p.state(), pidAlive: () => false, readProcessStartTime: () => "Tue Oct 27 01:02:03 2026" });
    expect(p.killed).toEqual([]);
  });
  it("records creation identity and checks it immediately before killing", () => {
    expect(captureProcessGroup(61, () => identity.startedAt)).toEqual(identity);
    const p = setup();
    p.events[0] = { kind: "run_started", actor: "runner", data: { runId: "dead", pid: 51, processGroups: [61], processGroupRecords: [identity] } };
    const order: string[] = [];
    cleanupLeftovers({ ...p, state: p.state(), pidAlive: () => false,
      readProcessStartTime: (pid) => { order.push(`identity ${pid}`); return identity.startedAt; },
      kill: (pid) => { order.push(`kill ${pid}`); } });
    expect(order).toEqual(["identity 61", "kill -61"]);
  });
  it("does not kill exited or unidentified legacy groups", () => {
    for (const records of [[], [{ ...identity, exited: true }]]) {
      const p = setup();
      p.events[0] = { kind: "run_started", actor: "runner", data: { runId: "dead", pid: 51, processGroups: [61], processGroupRecords: records } };
      cleanupLeftovers({ ...p, state: p.state(), pidAlive: () => false, readProcessStartTime: () => identity.startedAt });
      expect(p.killed).toEqual([]);
    }
  });
  it("rebuilds group creation and exited checkpoints without losing identity", () => {
    const p = setup();
    p.events[0] = { kind: "run_started", actor: "runner", data: { runId: "dead", pid: 51 } };
    p.events.push({ kind: "task_created", actor: "runner", task_id: "task", data: {} },
      { kind: "attempt_started", actor: "runner", task_id: "task", attempt_id: "a1", data: { runId: "dead", processGroup: 61, processGroupRecord: identity } },
      { kind: "attempt_ended", actor: "runner", task_id: "task", attempt_id: "a1", data: { status: "completed", processGroupRecord: { ...identity, exited: true } } });
    expect(p.state().runs[0]?.processGroupRecords).toEqual([{ ...identity, exited: true }]);
    cleanupLeftovers({ ...p, state: p.state(), pidAlive: () => false, readProcessStartTime: () => identity.startedAt });
    expect(p.killed).toEqual([]);
  });
});
