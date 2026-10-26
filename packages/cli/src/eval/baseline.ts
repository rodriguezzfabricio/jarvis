import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLAUDE_CODE_VERSION, pinnedClaudeBin } from "../config/pins.ts";
import {
  buildChildEnv,
  buildTaskArgs,
  cacheEnv,
  checkSessionToolchain,
  fixedPath,
  toolchainEnv,
  makeSessionTmpDir,
  sessionTmpEnv,
  hitRateLimitError,
  initInfo,
  parseStreamJson,
  rateLimits,
  runSession,
  toolCalls,
  usageWaitUntil,
  writeTaskSettings,
  type RateLimitInfo,
} from "../harness/claude/index.ts";
import { safeGit } from "./git.ts";
import { assertTaskDomains } from "./allowlist.ts";
import { assertHiddenAbsent } from "./hidden.ts";
import { PreflightError, type PreflightResult } from "./schedule.ts";
import { createSnapshot, type SnapshotManifest } from "./snapshot.ts";
import { evalToolchainDir } from "./toolchain.ts";
import { prepareGoToolchain, removeGoToolchain, type PreparedToolchain, type ToolchainReport } from "../toolchain/go.ts";

/**
 * Plain-Claude-Code baselines (decision 47): the golden task's prompt, typed as Fabricio would,
 * on a sanitized snapshot, with no Jarvis plugin, skills, memory or run header. The safety
 * envelope is the same as Jarvis task sessions, because hard stops are live during evals, and
 * there's no live web until recorded research fixtures exist (decisions 15, 70).
 */

export interface GoldenTask {
  id: string;
  title: string;
  prompt: string;
  source?: { repo: string; rev: string; revert?: string[]; allowSecretsIn?: string[] };
  model: string;
  maxTurns: number;
  timeoutMinutes: number;
  allowedDomains: string[];
}

/**
 * The only hosts an eval session may reach (decision 79). The snapshot scanner is best-effort, so this
 * list is part of the boundary: a host that accepts authenticated writes (today only the npm registry)
 * is added only after the scanner covers its credential forms, with tests and mutations. Public Go
 * module discovery can forward task-chosen paths to an origin: retained pending a read-only mirror
 * (round 18, option b). It is not an exfiltration barrier for snapshot contents.
 */
export const EVAL_ALLOWED_DOMAINS: readonly string[] = ["registry.npmjs.org", "proxy.golang.org", "sum.golang.org", "fonts.googleapis.com", "fonts.gstatic.com"];

export function checkEvalDomains(id: string, domains: readonly string[]): void {
  try {
    assertTaskDomains(domains);
    const extra = domains.filter((d) => !EVAL_ALLOWED_DOMAINS.includes(d));
    if (extra.length) throw new Error(`outside the eval allowlist: ${extra.join(", ")}`);
  } catch (error) {
    throw new Error(`${id}: allowedDomains refused (decision 79): ${String(error)}`, { cause: error });
  }
}

export function loadTask(evalsRepo: string, id: string): GoldenTask {
  const t = JSON.parse(readFileSync(join(evalsRepo, "tasks", id, "task.json"), "utf8")) as GoldenTask & { webResearch?: unknown };
  if ("webResearch" in t) throw new Error(`${id}: webResearch is no longer supported; evals have no live web until fixtures exist (decision 70)`);
  checkEvalDomains(id, t.allowedDomains);
  const prompt = readFileSync(join(evalsRepo, "tasks", id, "prompt.md"), "utf8").trim();
  const repo = t.source?.repo.replace(/^~(?=\/)/, homedir());
  return { ...t, prompt, ...(t.source && repo ? { source: { ...t.source, repo } } : {}) };
}

export interface BaselineRunResult {
  task: string;
  runId: string;
  resultsDir: string;
  workspace: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  init: ReturnType<typeof initInfo>;
  /** False when no model session actually started (no init event): never counts as a recorded baseline. */
  started: boolean;
  resultSubtype: string | undefined;
  numTurns: number | undefined;
  toolCalls: number;
  rateLimits: RateLimitInfo[];
  /** Set when the run hit or neared a usage limit: wait until this Unix time, then retry this task. */
  usageWaitUntil: number | undefined;
  usageLimited: boolean;
  finalCommit: string;
  diffStat: string;
  snapshot: SnapshotManifest;
  /** The session's Go (decision 123): the gate's pinned toolchain, or why it had the host's. */
  toolchain: ToolchainReport;
}

export interface BaselineOptions {
  /** Must pass (a live doctor) before any session starts (decision 59). */
  preflight: () => Promise<PreflightResult>;
  claudeBin?: string;
  jarvisHome?: string;
  workRoot?: string;
  runId?: string;
  parentEnv?: Readonly<Record<string, string | undefined>>;
  extraEnv?: Readonly<Record<string, string>>;
  /** The task's hidden folders (grading and gate checks): the snapshot must hold none of their files, checked before the session. */
  hiddenDirs?: readonly string[];
  /** The gate's Go module cache (eval/toolchain.ts evalGoFixture): the Jarvis arm's sessions get the same (decision 123). */
  goFixture?: string;
  log?: (m: string) => void;
}

/** Build output and tool folders kept out of candidate commits (both arms). */
export const EXCLUDE = ["node_modules/", ".next/", "dist/", "build/", ".svelte-kit/", "coverage/", ".turbo/", "*.log", ".DS_Store"];

export async function runBaseline(task: GoldenTask, opts: BaselineOptions): Promise<BaselineRunResult> {
  checkEvalDomains(task.id, task.allowedDomains);
  const pre = await opts.preflight();
  if (!pre.ok) throw new PreflightError("preflight failed (run `jarvis doctor --live`); no session was started", pre.waitUntil);
  const home = homedir();
  const jarvisHome = realpathSync(opts.jarvisHome ?? join(home, ".jarvis"));
  const workRoot = opts.workRoot ?? join(home, ".jarvis-work");
  const runId = opts.runId ?? `baseline-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const resultsDir = join(jarvisHome, "evals", task.id, runId);
  mkdirSync(resultsDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(workRoot, "evals", task.id), { recursive: true, mode: 0o700 });
  // A private, empty toolchain cache per run, deleted afterwards: nothing passes between runs (Codex review 2).
  const cacheRoot = join(workRoot, "cache-runs", task.id, runId);
  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  const workspace = join(realpathSync(join(workRoot, "evals", task.id)), runId);
  const cacheDir = realpathSync(cacheRoot);
  mkdirSync(join(cacheDir, "tmp"), { mode: 0o700 }); // the session's TMPDIR (decision 93)

  const snapshot = await createSnapshot({
    dest: workspace,
    ...(task.source ? { sourceRepo: task.source.repo, rev: task.source.rev, revert: task.source.revert ?? [], allowSecretsIn: task.source.allowSecretsIn ?? [] } : {}),
  });
  writeFileSync(join(workspace, ".git", "info", "exclude"), `${EXCLUDE.join("\n")}\n`);
  // The same leak check as the Jarvis arm, before any session sees the snapshot (02-golden-tasks.md step 2).
  if (opts.hiddenDirs?.length) {
    try { assertHiddenAbsent(workspace, opts.hiddenDirs); } catch (e) { rmSync(cacheDir, { recursive: true, force: true }); throw e; }
  }
  // Decision 123: the gate's pinned Go, offline and read-only, exactly as the Jarvis arm's sessions get it.
  const { go, tc } = ((): { go: PreparedToolchain; tc: ReturnType<typeof checkSessionToolchain> } => {
    let prepared: PreparedToolchain | undefined;
    try {
      prepared = prepareGoToolchain({ workspace, fixture: opts.goFixture, dest: evalToolchainDir(workRoot, task.id, runId) });
      return { go: prepared, tc: checkSessionToolchain(prepared.toolchain, [realpathSync(join(workRoot, "evals", task.id)), cacheDir, jarvisHome]) };
    } catch (e) {
      rmSync(cacheDir, { recursive: true, force: true });
      if (prepared?.dir) removeGoToolchain(prepared.dir);
      throw e;
    }
  })();
  if (go.report.status === "unavailable") opts.log?.(`${task.id} ${runId}: go toolchain unavailable: ${go.report.reason}`);

  const settingsPath = join(resultsDir, "settings.json");
  const mcpPath = join(resultsDir, "mcp.json");
  const sessionTmpDir = makeSessionTmpDir(); // Claude Code's own temp root (decision 93)
  writeTaskSettings(settingsPath, { worktree: workspace, jarvisHome, cacheDir, sessionTmpDir, allowedDomains: task.allowedDomains, ...(tc.readOnlyDirs.length ? { readOnlyDirs: tc.readOnlyDirs } : {}) });
  writeFileSync(mcpPath, '{"mcpServers":{}}\n', { mode: 0o600 });
  const args = buildTaskArgs({ prompt: task.prompt, settingsPath, mcpConfigPath: mcpPath, model: task.model, maxTurns: task.maxTurns });
  const bin = opts.claudeBin ?? pinnedClaudeBin();
  writeFileSync(
    join(resultsDir, "manifest.json"),
    `${JSON.stringify({ task: task.id, title: task.title, variant: "baseline-plain-claude-code", claudeCodeVersion: CLAUDE_CODE_VERSION, bin, args, cacheDir, snapshot, toolchain: go.report, startedAt: new Date().toISOString() }, null, 2)}\n`,
  );

  const streamPath = join(resultsDir, "stream.jsonl");
  const parentEnv = opts.parentEnv ?? process.env;
  const outcome = await runSession({
    bin,
    args,
    cwd: workspace,
    env: buildChildEnv(parentEnv, { ...cacheEnv(cacheDir), ...sessionTmpEnv(sessionTmpDir), ...toolchainEnv(tc, [], fixedPath(parentEnv.HOME ?? home)), ...(opts.extraEnv ?? {}) }),
    timeoutMs: task.timeoutMinutes * 60_000,
    stdoutPath: streamPath,
    stderrPath: join(resultsDir, "stderr.txt"),
  }).finally(() => {
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(sessionTmpDir, { recursive: true, force: true });
    if (go.dir) removeGoToolchain(go.dir);
  });

  const events = parseStreamJson(readFileSync(streamPath, "utf8"));
  const result = events.filter((e) => e.type === "result").at(-1);
  const limits = rateLimits(events);
  const limitedByError = hitRateLimitError(events);
  const waitUntil = usageWaitUntil(limits, { limitedByError });
  // The candidate revision: whatever the session left, committed by the runner with hooks off.
  safeGit(workspace, ["add", "-A"], { home });
  safeGit(workspace, ["commit", "-q", "--allow-empty", "--no-verify", "-m", `baseline result (${runId})`], { home });
  const finalCommit = safeGit(workspace, ["rev-parse", "HEAD"], { home }).toString().trim();
  const diffStat = safeGit(workspace, ["diff", "--shortstat", snapshot.commit, finalCommit], { home }).toString().trim();

  const out: BaselineRunResult = {
    task: task.id,
    runId,
    resultsDir,
    workspace,
    exitCode: outcome.code,
    timedOut: outcome.timedOut,
    durationMs: outcome.durationMs,
    init: initInfo(events),
    started: initInfo(events) !== undefined,
    resultSubtype: typeof result?.subtype === "string" ? result.subtype : undefined,
    numTurns: typeof result?.num_turns === "number" ? result.num_turns : undefined,
    toolCalls: toolCalls(events).length,
    rateLimits: limits,
    usageWaitUntil: waitUntil,
    usageLimited: limitedByError || limits.at(-1)?.status === "rejected",
    finalCommit,
    diffStat,
    snapshot,
    toolchain: go.report,
  };
  writeFileSync(join(resultsDir, "summary.json"), `${JSON.stringify(out, null, 2)}\n`);
  return out;
}
