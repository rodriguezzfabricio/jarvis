import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLAUDE_CODE_VERSION, pinnedClaudeBin } from "../config/pins.ts";
import {
  buildChildEnv,
  buildTaskArgs,
  cacheEnv,
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
import { PreflightError, type PreflightResult } from "./schedule.ts";
import { createSnapshot, type SnapshotManifest } from "./snapshot.ts";

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

export function loadTask(evalsRepo: string, id: string): GoldenTask {
  const t = JSON.parse(readFileSync(join(evalsRepo, "tasks", id, "task.json"), "utf8")) as GoldenTask & { webResearch?: unknown };
  if ("webResearch" in t) throw new Error(`${id}: webResearch is no longer supported; evals have no live web until fixtures exist (decision 70)`);
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
}

const EXCLUDE = ["node_modules/", ".next/", "dist/", "build/", ".svelte-kit/", "coverage/", ".turbo/", "*.log", ".DS_Store"];

export async function runBaseline(task: GoldenTask, opts: BaselineOptions): Promise<BaselineRunResult> {
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

  const snapshot = await createSnapshot({
    dest: workspace,
    ...(task.source ? { sourceRepo: task.source.repo, rev: task.source.rev, revert: task.source.revert ?? [], allowSecretsIn: task.source.allowSecretsIn ?? [] } : {}),
  });
  writeFileSync(join(workspace, ".git", "info", "exclude"), `${EXCLUDE.join("\n")}\n`);

  const settingsPath = join(resultsDir, "settings.json");
  const mcpPath = join(resultsDir, "mcp.json");
  writeTaskSettings(settingsPath, { worktree: workspace, jarvisHome, cacheDir, allowedDomains: task.allowedDomains });
  writeFileSync(mcpPath, '{"mcpServers":{}}\n', { mode: 0o600 });
  const args = buildTaskArgs({ prompt: task.prompt, settingsPath, mcpConfigPath: mcpPath, model: task.model, maxTurns: task.maxTurns });
  const bin = opts.claudeBin ?? pinnedClaudeBin();
  writeFileSync(
    join(resultsDir, "manifest.json"),
    `${JSON.stringify({ task: task.id, title: task.title, variant: "baseline-plain-claude-code", claudeCodeVersion: CLAUDE_CODE_VERSION, bin, args, cacheDir, snapshot, startedAt: new Date().toISOString() }, null, 2)}\n`,
  );

  const streamPath = join(resultsDir, "stream.jsonl");
  const outcome = await runSession({
    bin,
    args,
    cwd: workspace,
    env: buildChildEnv(opts.parentEnv ?? process.env, { ...cacheEnv(cacheDir), ...(opts.extraEnv ?? {}) }),
    timeoutMs: task.timeoutMinutes * 60_000,
    stdoutPath: streamPath,
    stderrPath: join(resultsDir, "stderr.txt"),
  }).finally(() => rmSync(cacheDir, { recursive: true, force: true }));

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
    resultSubtype: typeof result?.subtype === "string" ? result.subtype : undefined,
    numTurns: typeof result?.num_turns === "number" ? result.num_turns : undefined,
    toolCalls: toolCalls(events).length,
    rateLimits: limits,
    usageWaitUntil: waitUntil,
    usageLimited: limitedByError || limits.at(-1)?.status === "rejected",
    finalCommit,
    diffStat,
    snapshot,
  };
  writeFileSync(join(resultsDir, "summary.json"), `${JSON.stringify(out, null, 2)}\n`);
  return out;
}
