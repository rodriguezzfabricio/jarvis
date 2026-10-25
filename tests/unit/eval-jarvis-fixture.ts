/**
 * Fixtures for the Jarvis arm of `jarvis eval` (tests/unit/eval-jarvis-*.test.ts): a small source repo
 * with a planted regression (a fix commit the snapshot undoes, like golden tasks 4 and 5), a temp evals
 * repo with tasks/ and hidden/ in the real layout, and fake loops that act out runner/loop.ts's ledger
 * contract (tests/integration/e2e.test.ts). No real claude, no network, no credential.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runGate, type GateInput, type GateResult } from "../../packages/cli/src/checks/gate.ts";
import { ChecksStore } from "../../packages/cli/src/checks/store.ts";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import type { RunLoop, RunLoopOptions } from "../../packages/cli/src/eval/jarvis.ts";
import type { GoldenTask } from "../../packages/cli/src/eval/baseline.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { buildSessionUsageEntry } from "../../packages/cli/src/runner/usage-log.ts";
import { createWorkspace } from "../../packages/cli/src/runner/worktrees.ts";
import { shortTmp } from "../helpers.ts";

export const BUGGY = "export function requiresCitizenship(html) {\n  return /US citizen/i.test(html);\n}\n";
export const FIXED = "// FIXED: read the visible text: strip tags, fold no-break spaces.\nexport function requiresCitizenship(html) {\n  const text = html.replace(/<[^>]*>/g, \" \").replace(/\\u00a0|&nbsp;/g, \" \").replace(/\\s+/g, \" \");\n  return /US citizen/i.test(text);\n}\n";
/** The hidden test from the "real fix": it fails on BUGGY and passes on FIXED. Its marker must never reach a session. */
export const HIDDEN_MARKER = "HIDDEN-MARKER-7f3a9c";
export const HIDDEN_TEST = [
  `// ${HIDDEN_MARKER}: the hidden suite adapted from the fix commit.`,
  "import assert from \"node:assert/strict\";",
  "import { test } from \"node:test\";",
  "import { requiresCitizenship } from \"../src/citizen.mjs\";",
  "test(\"reads visible text\", () => {",
  "  assert.equal(requiresCitizenship(\"Must be a US&nbsp;citizen\"), true);",
  "  assert.equal(requiresCitizenship(\"<b>US</b> citizen required\"), true);",
  "  assert.equal(requiresCitizenship(\"No requirement\"), false);",
  "});",
  "",
].join("\n");
const OWN_TEST = "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { requiresCitizenship } from \"../src/citizen.mjs\";\ntest(\"plain text\", () => assert.equal(requiresCitizenship(\"US citizen\"), true));\n";
/** Printed by the grading verifier: grading output must reach no prompt, session input or loop ledger (decision 97). */
export const GRADE_CANARY = "GRADE-CANARY-51d0e2";
const VERIFY = [
  "#!/bin/sh",
  "# Grading: every case must exit 0; the completion line comes last (decision 76).",
  `echo "${GRADE_CANARY}: expected requiresCitizenship(US&nbsp;citizen) = true"`,
  "for c in \"$JARVIS_OUT\"/*/; do",
  "  [ \"$(cat \"$c/code\")\" = \"0\" ] || { echo \"case $(basename \"$c\") failed\"; exit 1; }",
  "done",
  "echo \"JARVIS-CHECK-COMPLETE $(cat \"$JARVIS_COMPLETION_FILE\")\"",
  "",
].join("\n");

export interface EvalFixture {
  root: string;
  sourceRepo: string;
  /** The fix commit: the snapshot is taken at it, with it undone (planted regression). */
  fixRev: string;
  evalsRepo: string;
  jarvisHome: string;
  workRoot: string;
  /** HOME for runner git calls and sessions: outside every root below. */
  home: string;
  cleanup(): void;
}

const git = (cwd: string, home: string, args: string[]) => safeGit(cwd, args, { home }).toString().trim();
function put(root: string, files: Record<string, string>): void {
  for (const [p, text] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), text); }
}

export const BUG_PROMPT = "The citizenship filter is missing some jobs that require US citizenship.";
export const FEATURE_PROMPT = "I want a feature that greets each user by name on the CLI.";
export const SPEC = [
  "---", "spec: 1", "date: 2026-10-24", "status: unconfirmed", "supersedes: none", "---", "", "# Spec v1", "",
  "## Goals", "- Greet the user by name.", "", "## Non-goals", "None.", "",
  "## User stories", "- **S1 (P1):** As a user, I see a greeting with my name.", "",
  "## Acceptance criteria",
  "- **AC1 (S1):** WHEN `greet <name>` runs THE SYSTEM SHALL print `Hello, <name>!`.",
  "- **AC2 (S1):** WHEN `greet` runs without a name THE SYSTEM SHALL exit 2.", "",
  "## Assumptions", "- **A1 [delegated]:** Plain Node, no dependencies.", "",
  "## Open questions", "None.", "",
].join("\n");

/** The gate's verifier: the project's own suite, judged on its exit code; it shares no byte with grading. */
const GATE_VERIFY = [
  "#!/bin/sh",
  "# Gate (the project's own suite, decision 97): the case must exit 0.",
  "[ \"$(cat \"$JARVIS_OUT/unit/code\")\" = \"0\" ] || { echo \"project tests failed\"; exit 1; }",
  "echo \"JARVIS-CHECK-COMPLETE $(cat \"$JARVIS_COMPLETION_FILE\")\"",
  "",
].join("\n");

export function createEvalFixture(): EvalFixture {
  const root = shortTmp("jtj-");
  const home = join(root, "home");
  const sourceRepo = join(root, "source");
  const evalsRepo = join(root, "evals");
  const jarvisHome = join(root, "jarvis");
  const workRoot = join(root, "work");
  for (const d of [home, sourceRepo, evalsRepo, jarvisHome, workRoot]) mkdirSync(d, { recursive: true, mode: 0o700 });

  put(sourceRepo, { "package.json": "{\"name\":\"jobs\",\"type\":\"module\"}\n", "src/citizen.mjs": BUGGY, "test/citizen.test.mjs": OWN_TEST });
  git(sourceRepo, home, ["init", "-q", "-b", "main"]);
  git(sourceRepo, home, ["add", "-A"]);
  git(sourceRepo, home, ["commit", "-q", "-m", "start"]);
  put(sourceRepo, { "src/citizen.mjs": FIXED });
  git(sourceRepo, home, ["commit", "-q", "-am", "fix: citizenship reads visible text"]);
  const fixRev = git(sourceRepo, home, ["rev-parse", "HEAD"]);

  const fx: EvalFixture = { root, sourceRepo, fixRev, evalsRepo, jarvisHome, workRoot, home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  addTask(fx, "05-citizenship", BUG_PROMPT, { revert: [fixRev] });
  addHidden(fx, "05-citizenship", "checks", { unit: [] });
  addHidden(fx, "05-citizenship", "gate", { unit: [] });
  return fx;
}

export function addTask(fx: EvalFixture, id: string, prompt: string, o: { revert?: string[]; rev?: string; spec?: string; noSource?: boolean } = {}): GoldenTask {
  const task = {
    id, title: `fixture ${id}`, model: "claude-sonnet-5-5", maxTurns: 20, timeoutMinutes: 2, allowedDomains: ["registry.npmjs.org", "localhost"],
    ...(o.noSource ? {} : { source: { repo: fx.sourceRepo, rev: o.rev ?? fx.fixRev, revert: o.revert ?? [] } }),
  };
  put(join(fx.evalsRepo, "tasks", id), { "task.json": JSON.stringify(task, null, 2), "prompt.md": `${prompt}\n`, ...(o.spec ? { "spec.md": o.spec } : {}) });
  return { ...task, prompt } as GoldenTask;
}

/**
 * hidden/<id>/<kind>/: one check per entry (name → criteria). Grading checks (checks/) run the hidden test
 * as a black box and print the canary; gate checks (gate/) run the project's own suite only.
 */
export function addHidden(fx: EvalFixture, id: string, kind: "checks" | "gate", checks: Record<string, string[]>): string {
  const dir = join(fx.evalsRepo, "hidden", id, kind);
  const grading = kind === "checks";
  const files: Record<string, string> = grading ? { "verify.sh": VERIFY, "fixtures/hidden.test.mjs": HIDDEN_TEST } : { "gate-verify.sh": GATE_VERIFY };
  for (const [name, criteria] of Object.entries(checks)) {
    files[`${name}.check.json`] = JSON.stringify({
      name, criteria,
      cases: [{ id: "unit", command: grading ? "mkdir -p test && cp \"$JARVIS_FIXTURES/hidden.test.mjs\" test/hidden.test.mjs && node --test" : "node --test" }],
      verify: grading ? "sh \"$JARVIS_CHECKS/verify.sh\"" : "sh \"$JARVIS_CHECKS/gate-verify.sh\"", timeoutMs: 60_000,
    }, null, 2);
  }
  put(dir, files);
  return dir;
}

/** A grading gate for fast tests: pass when the revision's src file carries the fix marker. Records a runner gate_result like the real gate. */
export function markerGate(file = "src/citizen.mjs", marker = "FIXED"): { gate: (g: GateInput) => Promise<GateResult>; calls: GateInput[] } {
  const calls: GateInput[] = [];
  return {
    calls,
    gate: async (g) => {
      calls.push(g);
      let text = "";
      try { text = safeGit(g.repoPath, ["show", `${g.revision}:${file}`], { home: process.env.HOME ?? "/" }).toString(); } catch { text = ""; }
      const status = text.includes(marker) ? "pass" as const : "fail" as const;
      const entry = g.ledger.append({ kind: "gate_result", actor: "runner", task_id: g.taskId, attempt_id: g.attemptId, data: { check: g.check.name, revision: g.revision, status } });
      return { status, entry, evidenceDir: join(g.projectDir, "evidence") };
    },
  };
}

export type LoopBehavior = "fix" | "blocked" | "crash" | "usage-wait" | "crash-before-start";

/**
 * A fake runner/loop.ts that writes the ledger as the real loop does (attempts, gate and review results,
 * state_reached, blocked, usage_wait) and promotes by committing on runBranch and tagging last-green.
 */
export function fakeLoop(behavior: LoopBehavior, files: Record<string, string> = { "src/citizen.mjs": FIXED }, calls: RunLoopOptions[] = []): RunLoop {
  return async (o) => {
    calls.push(o);
    if (behavior === "crash-before-start") throw new Error("loop refused to start: lock held");
    const ledger = Ledger.open(o.projectDir);
    const g = (args: string[]) => git(o.repoPath, o.gitHome ?? process.env.HOME ?? "/", args);
    const tasks = ledger.entries().filter((e) => e.kind === "task_created").map((e) => ({ id: e.task_id!, data: e.data as { requiredChecks: string[]; requiredReviews: string[] } }));
    ledger.append({ kind: "run_started", actor: "runner", data: { runId: "loop-1", pid: process.pid } });
    const done: string[] = [];
    const blocked: string[] = [];
    for (const t of tasks) {
      const start = (attempt: string) => {
        ledger.append({ kind: "attempt_started", actor: "runner", task_id: t.id, attempt_id: attempt, data: { runId: "loop-1", baseRevision: g(["rev-parse", "HEAD"]) } });
        ledger.append(buildSessionUsageEntry({ runId: "loop-1", taskId: t.id, attemptId: attempt, role: "debug", tier: 0, route: { model: "claude-sonnet-5-5", modelTier: "fast" }, outcome: {
          status: "finished", exitCode: 0, durationMs: 60_000, usage: [], usageWaitUntil: undefined,
          sessionUsage: { reportedModel: "claude-sonnet-5-5", inputTokens: 120_000, outputTokens: 8_000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.75, turns: 12, complete: true },
        } }));
      };
      const commit = (contents: Record<string, string>, msg: string) => { put(o.repoPath, contents); g(["add", "-A"]); g(["commit", "-q", "--allow-empty", "-m", msg]); return g(["rev-parse", "HEAD"]); };
      const judge = async (attempt: string, rev: string, status: "pass" | "fail") => {
        ledger.append({ kind: "attempt_ended", actor: "runner", task_id: t.id, attempt_id: attempt, data: { status: "completed", candidateRevision: rev } });
        for (const check of t.data.requiredChecks) ledger.append({ kind: "gate_result", actor: "runner", task_id: t.id, attempt_id: attempt, data: { check, revision: rev, status } });
        if (status !== "pass") return false;
        const verdict = await o.review({ taskId: t.id, attemptId: attempt, revision: rev });
        ledger.append({ kind: "review_result", actor: "runner", task_id: t.id, attempt_id: attempt, data: { reviewer: "code", revision: rev, status: verdict, reviews: [{ reviewer: "claude" }] } });
        return verdict === "pass";
      };
      if (behavior === "crash") { start("a1"); throw new Error("worktree vanished mid-task"); }
      if (behavior === "blocked") {
        for (const attempt of ["a1", "a2", "a3"]) { start(attempt); await judge(attempt, commit({ [`notes-${attempt}.txt`]: "try\n" }, `try ${attempt}`), "fail"); }
        g(["reset", "-q", "--hard", "HEAD~3"]);
        ledger.append({ kind: "blocked", actor: "runner", task_id: t.id, data: { reason: "3 failed attempts" } });
        blocked.push(t.id);
        continue;
      }
      if (behavior === "usage-wait") {
        start("a1");
        ledger.append({ kind: "usage_wait", actor: "runner", task_id: t.id, attempt_id: "a1", data: { taskId: t.id, resumeAt: 1, waitMs: 3_600_000, until: 1, resetAt: 1, fallback: false, reason: "usage-limited", countsAsFailure: false } });
        ledger.append({ kind: "attempt_ended", actor: "runner", task_id: t.id, attempt_id: "a1", data: { status: "usage_wait" } });
      }
      start("a1");
      const rev = commit(files, `fix ${t.id}`);
      if (await judge("a1", rev, "pass")) {
        ledger.append({ kind: "state_reached", actor: "runner", task_id: t.id, attempt_id: "a1", data: { state: "passed", revision: rev } });
        g(["tag", "-f", "last-green", rev]);
        done.push(t.id);
      }
    }
    ledger.append({ kind: "run_ended", actor: "runner", data: { runId: "loop-1" } });
    return { status: blocked.length ? "blocked" : "complete", done, blocked };
  };
}

/** A loop whose only task runs one real session through the injected harness, in a runner-made worktree, then promotes what the session wrote. */
export function harnessLoop(calls: RunLoopOptions[] = []): RunLoop {
  return async (o) => {
    calls.push(o);
    const ledger = Ledger.open(o.projectDir);
    const home = o.gitHome ?? process.env.HOME ?? "/";
    const base = git(o.repoPath, home, ["rev-parse", "HEAD"]);
    ledger.append({ kind: "run_started", actor: "runner", data: { runId: "loop-1", pid: process.pid } });
    ledger.append({ kind: "attempt_started", actor: "runner", task_id: "T1", attempt_id: "a1", data: { runId: "loop-1", baseRevision: base } });
    const w = createWorkspace({ repoPath: o.repoPath, projectId: o.projectId, taskId: "T1", attemptId: "a1", baseRevision: base, worktreeRoot: o.worktreeRoot, home });
    mkdirSync(join(o.projectDir, "sessions"), { recursive: true });
    const header = join(o.projectDir, "sessions", "T1-a1.header.md");
    writeFileSync(header, "Task: T1\n");
    const outcome = await o.harness.runTask({ workspace: w.path, prompt: "Task: T1\nFix the citizenship filter.", runHeaderPath: header, role: "debug", tier: 0, maxTurns: o.maxTurns ?? 5, timeoutMs: o.taskTimeoutMs ?? 60_000, logPath: join(o.projectDir, "sessions", "T1-a1.jsonl") });
    if (outcome.status !== "finished") throw new Error(`session ${outcome.status}`);
    const fixed = safeGit(w.path, ["diff", "--binary", base], { home });
    rmSync(w.path, { recursive: true, force: true });
    if (fixed.length) safeGit(o.repoPath, ["apply", "-"], { home, input: fixed });
    git(o.repoPath, home, ["add", "-A"]);
    git(o.repoPath, home, ["commit", "-q", "-m", "T1 candidate"]);
    const rev = git(o.repoPath, home, ["rev-parse", "HEAD"]);
    ledger.append({ kind: "attempt_ended", actor: "runner", task_id: "T1", attempt_id: "a1", data: { status: "completed", candidateRevision: rev } });
    ledger.append({ kind: "gate_result", actor: "runner", task_id: "T1", attempt_id: "a1", data: { check: "unit", revision: rev, status: "pass" } });
    ledger.append({ kind: "review_result", actor: "runner", task_id: "T1", attempt_id: "a1", data: { reviewer: "code", revision: rev, status: await o.review({ taskId: "T1", attemptId: "a1", revision: rev }) } });
    ledger.append({ kind: "state_reached", actor: "runner", task_id: "T1", attempt_id: "a1", data: { state: "passed", revision: rev } });
    git(o.repoPath, home, ["tag", "-f", "last-green", rev]);
    return { status: "complete", done: ["T1"], blocked: [] };
  };
}

/**
 * A loop that judges T1 the way the real one does: the fix committed as a candidate, every required check
 * run on the real gate against the loop's own checks (o.checks, installed in o.projectDir), then o.review,
 * which the production review service answers from that runner evidence.
 */
export function realGateLoop(files: Record<string, string> = { "src/citizen.mjs": FIXED }, calls: RunLoopOptions[] = []): RunLoop {
  return async (o) => {
    calls.push(o);
    const ledger = Ledger.open(o.projectDir);
    const store = new ChecksStore(o.projectDir);
    const home = o.gitHome ?? process.env.HOME ?? "/";
    const g = (args: string[]) => git(o.repoPath, home, args);
    const base = g(["rev-parse", "HEAD"]);
    ledger.append({ kind: "run_started", actor: "runner", data: { runId: "loop-1", pid: process.pid } });
    ledger.append({ kind: "attempt_started", actor: "runner", task_id: "T1", attempt_id: "a1", data: { runId: "loop-1", baseRevision: base } });
    g(["checkout", "-q", "-b", "jarvis/candidates/T1/a1"]);
    put(o.repoPath, files);
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "T1 candidate"]);
    const rev = g(["rev-parse", "HEAD"]);
    g(["checkout", "-q", o.runBranch]);
    ledger.append({ kind: "attempt_ended", actor: "runner", task_id: "T1", attempt_id: "a1", data: { status: "completed", candidateRevision: rev } });
    const def = ledger.entries().find((e) => e.kind === "task_created" && e.task_id === "T1")!.data as { requiredChecks: string[] };
    let passed = true;
    for (const name of def.requiredChecks) {
      const r = await runGate({ ledger, store, projectDir: o.projectDir, jarvisHome: o.jarvisHome, workRoot: o.workRoot, repoPath: o.repoPath, revision: rev, check: o.checks[name]!, taskId: "T1", attemptId: "a1" });
      passed &&= r.status === "pass";
    }
    if (!passed || (await o.review({ taskId: "T1", attemptId: "a1", revision: rev })) !== "pass") return { status: "blocked", done: [], blocked: ["T1"] };
    g(["merge", "-q", "--ff-only", rev]);
    ledger.append({ kind: "state_reached", actor: "runner", task_id: "T1", attempt_id: "a1", data: { state: "passed", revision: rev } });
    g(["tag", "-f", "last-green", rev]);
    return { status: "complete", done: ["T1"], blocked: [] };
  };
}
