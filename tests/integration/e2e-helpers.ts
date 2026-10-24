/**
 * End-to-end test support (decision 84): a temp project built from tests/fixtures/e2e-project, a temp
 * JARVIS home with a ledger and approved protected checks, and a fake `claude` at the pinned path
 * under a temp HOME that acts out a scenario. Plus assertions that read only the ledger and the repo.
 *
 * No real claude, no network, no credential: sessions run tests/fixtures/fake-claude.mjs, chosen by
 * the `claude` shim itself (FAKE_CLAUDE_SCENARIO is set inside the shim, after the runner built the
 * child environment), so buildChildEnv's allowlist is untouched.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import type { GateCheck } from "../../packages/cli/src/checks/gate.ts";
import { ChecksStore } from "../../packages/cli/src/checks/store.ts";
import { pinnedClaudeBin } from "../../packages/cli/src/config/pins.ts";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { Ledger, type LedgerEntry } from "../../packages/cli/src/ledger/ledger.ts";
import { shortTmp } from "../helpers.ts";

export const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/e2e-project/", import.meta.url));
export const FAKE_CLAUDE = fileURLToPath(new URL("../fixtures/fake-claude.mjs", import.meta.url));
export const SCENARIOS = ["happy", "repair", "blocked", "usage-limit", "tamper", "timeout"] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

/** One entry of tests/fixtures/e2e-project/tasks.json; the fields after `exitCondition` match runner/state.ts's task definition. */
export interface E2ETask {
  id: string;
  title: string;
  story: string;
  criteria: string[];
  goal: string;
  exitCondition: string;
  dependencies: string[];
  priority: number;
  requiredChecks: string[];
  requiredReviews: string[];
}

/** One line of the fake's calls log: one per session launch. */
export interface SessionCall {
  n: number;
  /** The scenario session it acted out; null when none matched (it then failed with exit 1). */
  session: string | null;
  index: number;
  task: string | null;
  cwd: string;
  model: string | null;
  effort: string | null;
  tools: string | null;
  maxTurns: string | null;
  prompt: string;
  /** Safety-envelope problems with the launch; non-empty means it refused to act (exit 3). */
  envelope: string[];
  ts: number;
}

export interface E2EProject {
  /** Temp root holding everything below; removed by cleanup(). */
  root: string;
  /** The temp JARVIS home (stands in for ~/.jarvis). */
  jarvisHome: string;
  projectId: string;
  /** jarvisHome/projects/<id>: ledger.jsonl, checks/, checks.lock, evidence/. */
  projectDir: string;
  /** The project repo: the fixture, committed once on runBranch. */
  repoPath: string;
  runBranch: string;
  /** The fixture commit. */
  baseRevision: string;
  /** Stands in for ~/.jarvis-work: gate checkouts go under workRoot/checks. */
  workRoot: string;
  /** Task worktrees (decision 67): createWorkspace's worktreeRoot. */
  worktreeRoot: string;
  /** Parent for per-session caches (ClaudeHarnessOptions.cacheRoot). */
  cacheRoot: string;
  /** HOME for task sessions; the fake claude is at pinnedClaudeBin(home). */
  home: string;
  claudeBin: string;
  /** HOME for the runner's own git calls (safeGit). */
  gitHome: string;
  ledger: Ledger;
  store: ChecksStore;
  /** Protected checks by name, in the form checks/gate.ts runs. */
  checks: Record<string, GateCheck>;
  /** Spec criterion IDs each check covers. */
  criteria: Record<string, string[]>;
  tasks: E2ETask[];
  specPath: string;
  specVersion: number;
  /** The materialized scenario the fake reads; its .state and .calls.jsonl sit next to it. */
  scenarioPath: string;
  cleanup(): void;
}

export interface E2EOptions {
  /** A fixture scenario name, or a scenario object (same format, see fake-claude-scenario.mjs). */
  scenario: ScenarioName | { sessions: unknown[]; description?: string };
  projectId?: string;
  runBranch?: string;
  /** Record the fixture checks as approved in the ledger (default true). */
  approveChecks?: boolean;
}

const git = (p: Pick<E2EProject, "gitHome">, cwd: string, args: string[]) => safeGit(cwd, args, { home: p.gitHome }).toString().trim();

/** Fills ${CHECKS_DIR}, ${PROJECT_DIR}, ${JARVIS_HOME} and ${REPO} in a scenario; unknown names throw. */
export function materializeScenario(text: string, vars: Record<string, string>): string {
  return text.replace(/\$\{([A-Z_]+)\}/g, (_m, name: string) => {
    const v = vars[name];
    if (v === undefined) throw new Error(`unknown scenario variable: ${name}`);
    return JSON.stringify(v).slice(1, -1);
  });
}

/** Writes an executable `claude` at `bin` that runs the fake with this Node, acting out `scenarioPath`. */
export function writeFakeClaudeShim(bin: string, scenarioPath: string): void {
  for (const p of [bin, scenarioPath, FAKE_CLAUDE, process.execPath]) if (p.includes("'")) throw new Error(`path not usable in the shim: ${p}`);
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(bin, `#!/bin/sh\nFAKE_CLAUDE_SCENARIO='${scenarioPath}'\nexport FAKE_CLAUDE_SCENARIO\nexec '${process.execPath}' '${FAKE_CLAUDE}' "$@"\n`);
  chmodSync(bin, 0o755);
}

export function loadFixtureChecks(dir = join(FIXTURE_DIR, "checks")): { checks: Record<string, GateCheck>; criteria: Record<string, string[]> } {
  const checks: Record<string, GateCheck> = {};
  const criteria: Record<string, string[]> = {};
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".check.json")).sort()) {
    const c = JSON.parse(readFileSync(join(dir, f), "utf8")) as GateCheck & { criteria: string[] };
    checks[c.name] = { name: c.name, cases: c.cases, verify: c.verify, timeoutMs: c.timeoutMs };
    criteria[c.name] = c.criteria;
  }
  return { checks, criteria };
}

export function createE2EProject(opts: E2EOptions): E2EProject {
  const root = shortTmp("je2e-");
  const projectId = opts.projectId ?? "e2e";
  const runBranch = opts.runBranch ?? "main";
  const jarvisHome = join(root, "jarvis");
  const projectDir = join(jarvisHome, "projects", projectId);
  const repoPath = join(root, "repo");
  const workRoot = join(root, "work");
  const worktreeRoot = join(workRoot, "worktrees");
  const cacheRoot = join(root, "caches");
  const home = join(root, "home");
  const gitHome = join(root, "git-home");
  for (const d of [jarvisHome, workRoot, worktreeRoot, cacheRoot, home, gitHome]) mkdirSync(d, { recursive: true, mode: 0o700 });

  cpSync(join(FIXTURE_DIR, "repo"), repoPath, { recursive: true });
  const g = { gitHome };
  git(g, repoPath, ["init", "-q", "-b", runBranch]);
  git(g, repoPath, ["add", "-A"]);
  git(g, repoPath, ["commit", "-q", "-m", "e2e fixture: e2e-mathlib"]);
  const baseRevision = git(g, repoPath, ["rev-parse", "HEAD"]);

  const ledger = Ledger.open(projectDir);
  cpSync(join(FIXTURE_DIR, "checks"), join(projectDir, "checks"), { recursive: true });
  const store = new ChecksStore(projectDir);
  if (opts.approveChecks !== false) store.approve(ledger, "spec v1 (e2e fixture)");
  const { checks, criteria } = loadFixtureChecks();
  const plan = JSON.parse(readFileSync(join(FIXTURE_DIR, "tasks.json"), "utf8")) as { specPath: string; specVersion: number; tasks: E2ETask[] };

  const scenarioDir = join(root, "scenario");
  mkdirSync(scenarioDir, { mode: 0o700 });
  const scenarioPath = join(scenarioDir, "scenario.json");
  const raw = typeof opts.scenario === "string" ? readFileSync(join(FIXTURE_DIR, "scenarios", `${opts.scenario}.json`), "utf8") : JSON.stringify(opts.scenario);
  writeFileSync(scenarioPath, materializeScenario(raw, { CHECKS_DIR: store.checksDir, PROJECT_DIR: projectDir, JARVIS_HOME: jarvisHome, REPO: repoPath }));
  const claudeBin = pinnedClaudeBin(home);
  writeFakeClaudeShim(claudeBin, scenarioPath);

  return {
    root, jarvisHome, projectId, projectDir, repoPath, runBranch, baseRevision, workRoot, worktreeRoot, cacheRoot, home, claudeBin, gitHome,
    ledger, store, checks, criteria, tasks: plan.tasks, specPath: plan.specPath, specVersion: plan.specVersion, scenarioPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Appends a task_created entry per fixture task (data in runner/state.ts's definition shape, plus title, story, criteria, goal). */
export function seedTasks(p: E2EProject): LedgerEntry[] {
  return p.tasks.map(({ id, ...data }) => p.ledger.append({ kind: "task_created", actor: "runner", task_id: id, data }));
}

/** What createClaudeHarness (harness/claude/task.ts) needs, pointed at this project; the live preflight is stubbed to pass. */
export function harnessOptions(p: E2EProject) {
  return {
    jarvisHome: p.jarvisHome,
    cacheRoot: p.cacheRoot,
    home: p.home,
    parentEnv: { HOME: p.home, USER: "e2e", LANG: "en_US.UTF-8" },
    allowedDomains: [] as string[],
    preflight: async () => ({ ok: true }),
  };
}

/** A clock whose sleep returns at once and moves time forward, for usage waits (runner/usage-wait.ts takes now and sleep). */
export function virtualClock(start = Date.now()) {
  let t = start;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => { slept.push(ms); t += ms; },
    slept,
  };
}

// ---- Reading the evidence -------------------------------------------------------------------------

/** Verified ledger entries (throws on a broken chain). */
export const entries = (p: E2EProject): LedgerEntry[] => p.ledger.entries();
export const taskEntries = (p: E2EProject, taskId: string, kind?: LedgerEntry["kind"]): LedgerEntry[] =>
  entries(p).filter((e) => e.task_id === taskId && (kind === undefined || e.kind === kind));
type GateData = { check: string; revision: string; status: string };
const gateData = (e: LedgerEntry) => e.data as GateData;

/** gate_result statuses for a task, in ledger order, optionally for one check. */
export function gateStatuses(p: E2EProject, taskId: string, check?: string): string[] {
  return taskEntries(p, taskId, "gate_result").filter((e) => check === undefined || gateData(e).check === check).map((e) => gateData(e).status);
}

/** Attempt IDs with at least one non-passing gate_result, in order: the failures a repair budget counts. */
export function failedAttempts(p: E2EProject, taskId: string): string[] {
  const out: string[] = [];
  for (const e of taskEntries(p, taskId, "gate_result")) if (gateData(e).status !== "pass" && e.attempt_id && !out.includes(e.attempt_id)) out.push(e.attempt_id);
  return out;
}

export const attempts = (p: E2EProject, taskId: string): string[] => [...new Set(taskEntries(p, taskId, "attempt_started").map((e) => e.attempt_id ?? ""))];
const passedEntry = (p: E2EProject, taskId: string) => taskEntries(p, taskId, "state_reached").filter((e) => (e.data as { state?: string }).state === "passed").at(-1);

/** The `last-green` tag in the project repo, or null. */
export function lastGreen(p: E2EProject): string | null {
  try { return git(p, p.repoPath, ["rev-parse", "-q", "--verify", "refs/tags/last-green^{commit}"]); } catch { return null; }
}
export function fileAt(p: E2EProject, revision: string, path: string): string | null {
  try { return git(p, p.repoPath, ["show", `${revision}:${path}`]); } catch { return null; }
}
export const isAncestor = (p: E2EProject, a: string, b: string): boolean => {
  try { git(p, p.repoPath, ["merge-base", "--is-ancestor", a, b]); return true; } catch { return false; }
};

/** The fake's calls log: one line per session launch. */
export function sessionCalls(p: Pick<E2EProject, "scenarioPath">): SessionCall[] {
  const f = `${p.scenarioPath}.calls.jsonl`;
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as SessionCall) : [];
}

// ---- Assertions -----------------------------------------------------------------------------------

/** Done (decision 16): a runner state_reached "passed" at a revision where every required check has a pass gate_result. Returns that revision. */
export function expectTaskDone(p: E2EProject, taskId: string): string {
  const task = p.tasks.find((t) => t.id === taskId);
  expect(task, `fixture task ${taskId}`).toBeDefined();
  const passed = passedEntry(p, taskId);
  expect(passed, `${taskId}: no state_reached "passed"`).toBeDefined();
  expect(passed!.actor).toBe("runner");
  const revision = (passed!.data as { revision: string }).revision;
  for (const check of task!.requiredChecks) {
    const pass = taskEntries(p, taskId, "gate_result").some((e) => gateData(e).check === check && gateData(e).status === "pass" && gateData(e).revision === revision && e.actor === "runner");
    expect(pass, `${taskId}: no passing ${check} gate at ${revision}`).toBe(true);
  }
  expect(taskEntries(p, taskId, "blocked"), `${taskId} is also blocked`).toEqual([]);
  return revision;
}

/** Blocked after `failures` failed attempts (3 = the first attempt and two repairs), and never done. */
export function expectTaskBlocked(p: E2EProject, taskId: string, failures?: number): void {
  expect(taskEntries(p, taskId, "blocked").length, `${taskId}: no blocked entry`).toBeGreaterThan(0);
  expect(passedEntry(p, taskId), `${taskId} reached passed`).toBeUndefined();
  if (failures !== undefined) expect(failedAttempts(p, taskId)).toHaveLength(failures);
}

export function expectTaskNotDone(p: E2EProject, taskId: string): void {
  expect(passedEntry(p, taskId), `${taskId} reached passed`).toBeUndefined();
}

/** A usage_wait was recorded for the task and marked as not a failure. */
export function expectUsageWait(p: E2EProject, taskId: string): LedgerEntry {
  const waits = taskEntries(p, taskId, "usage_wait");
  expect(waits.length, `${taskId}: no usage_wait`).toBeGreaterThan(0);
  for (const w of waits) expect((w.data as { countsAsFailure?: boolean }).countsAsFailure, "usage_wait counted as a failure").not.toBe(true);
  return waits[0]!;
}

/** No gate ever failed for the task: nothing used its repair budget. */
export function expectNoFailures(p: E2EProject, taskId: string): void {
  expect(failedAttempts(p, taskId)).toEqual([]);
  expect(taskEntries(p, taskId, "blocked")).toEqual([]);
}

/** A gate detected the edited checks: at least one tampered gate_result, and the store no longer verifies. Returns the first one. */
export function expectTampered(p: E2EProject, taskId?: string): LedgerEntry {
  const tampered = entries(p).filter((e) => e.kind === "gate_result" && gateData(e).status === "tampered" && (taskId === undefined || e.task_id === taskId));
  expect(tampered.length, "no tampered gate_result").toBeGreaterThan(0);
  expect(p.store.verify(p.ledger).ok).toBe(false);
  return tampered[0]!;
}

/** No gate passes after ledger seq `seq` (once the checks are tampered, nothing may pass). */
export function expectNoPassAfter(p: E2EProject, seq: number): void {
  const late = entries(p).filter((e) => e.seq > seq && e.kind === "gate_result" && gateData(e).status === "pass");
  expect(late.map((e) => `${e.task_id}:${gateData(e).check}`)).toEqual([]);
}

/** last-green moved forward from `from` (or appeared) and contains `path`, when given. Returns it. */
export function expectLastGreenMoved(p: E2EProject, from: string | null, path?: string): string {
  const now = lastGreen(p);
  expect(now, "no last-green tag").not.toBeNull();
  expect(now).not.toBe(from);
  if (from) expect(isAncestor(p, from, now!), "last-green does not descend from the old one").toBe(true);
  if (path) expect(fileAt(p, now!, path), `${path} at last-green`).not.toBeNull();
  return now!;
}

/** The ledger chain verifies, and every session the runner launched carried the safety envelope and matched a scripted session. */
export function expectRunSound(p: E2EProject): void {
  expect(p.ledger.verify().ok).toBe(true);
  for (const c of sessionCalls(p)) {
    expect(c.envelope, `session ${c.n} launched without the safety envelope`).toEqual([]);
    expect(c.session, `session ${c.n} (task ${c.task}) matched no scripted session`).not.toBeNull();
  }
}
