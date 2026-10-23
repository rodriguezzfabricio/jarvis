import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync, createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLAUDE_CODE_VERSION, pinnedClaudeBin } from "../config/pins.ts";
import { buildTaskArgs } from "../harness/claude/args.ts";
import { buildChildEnv } from "../harness/claude/env.ts";
import { buildTaskSettings, writeTaskSettings } from "../harness/claude/settings.ts";
import { initInfo, parseStreamJson, rateLimits, toolCalls, type RateLimitInfo } from "../harness/claude/streamjson.ts";
import { createSnapshot, type SnapshotManifest } from "./snapshot.ts";

/**
 * Plain-Claude-Code baselines (decision 47): the golden task's prompt, typed as Fabricio
 * would, on a sanitized snapshot, with no Jarvis plugin, skills, memory or run header.
 * The safety envelope is the same as Jarvis task sessions (sandbox, allowlist, no
 * credentials), because hard stops are live during evals.
 */

export interface GoldenTask {
  id: string;
  title: string;
  prompt: string;
  source?: { repo: string; rev: string; revert?: string[] };
  model: string;
  maxTurns: number;
  timeoutMinutes: number;
  allowedDomains: string[];
  webResearch: boolean;
}

export function loadTask(evalsRepo: string, id: string): GoldenTask {
  const t = JSON.parse(readFileSync(join(evalsRepo, "tasks", id, "task.json"), "utf8")) as GoldenTask;
  const prompt = readFileSync(join(evalsRepo, "tasks", id, "prompt.md"), "utf8").trim();
  const repo = t.source?.repo.replace(/^~(?=\/)/, homedir());
  return { ...t, prompt, ...(t.source && repo ? { source: { ...t.source, repo } } : {}) };
}

/** decision 62: wait when the plan is rejected or nearly used up, until its window resets. */
export function usageWaitUntil(infos: readonly RateLimitInfo[], threshold = 0.85): number | undefined {
  const last = infos.at(-1);
  if (!last) return undefined;
  const high = Object.values(last.utilization).some((u) => u >= threshold);
  if (last.status === "rejected" || high) return last.resetsAt;
  return undefined;
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
  finalCommit: string;
  diffStat: string;
  snapshot: SnapshotManifest;
}

export interface BaselineOptions {
  claudeBin?: string;
  jarvisHome?: string;
  workRoot?: string;
  runId?: string;
  parentEnv?: Readonly<Record<string, string | undefined>>;
  extraEnv?: Readonly<Record<string, string>>;
}

const EXCLUDE = ["node_modules/", ".next/", "dist/", "build/", ".svelte-kit/", "coverage/", ".turbo/", "*.log", ".DS_Store"];

export async function runBaseline(task: GoldenTask, opts: BaselineOptions = {}): Promise<BaselineRunResult> {
  const jarvisHome = realpathSync(opts.jarvisHome ?? join(homedir(), ".jarvis"));
  const workRoot = opts.workRoot ?? join(homedir(), ".jarvis-work");
  const runId = opts.runId ?? `baseline-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const resultsDir = join(jarvisHome, "evals", task.id, runId);
  mkdirSync(resultsDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(workRoot, "evals", task.id), { recursive: true, mode: 0o700 });
  const workspace = join(realpathSync(join(workRoot, "evals", task.id)), runId);

  const snapshot = await createSnapshot({
    dest: workspace,
    ...(task.source ? { sourceRepo: task.source.repo, rev: task.source.rev, revert: task.source.revert ?? [] } : {}),
  });
  writeFileSync(join(workspace, ".git", "info", "exclude"), `${EXCLUDE.join("\n")}\n`);

  const settingsPath = join(resultsDir, "settings.json");
  const mcpPath = join(resultsDir, "mcp.json");
  writeTaskSettings(settingsPath, buildTaskSettings({ worktree: workspace, jarvisHome, allowedDomains: task.allowedDomains, webResearch: task.webResearch }));
  writeFileSync(mcpPath, '{"mcpServers":{}}\n', { mode: 0o600 });
  const args = buildTaskArgs({ prompt: task.prompt, settingsPath, mcpConfigPath: mcpPath, model: task.model, maxTurns: task.maxTurns });
  const bin = opts.claudeBin ?? pinnedClaudeBin();
  writeFileSync(
    join(resultsDir, "manifest.json"),
    `${JSON.stringify({ task: task.id, title: task.title, variant: "baseline-plain-claude-code", claudeCodeVersion: CLAUDE_CODE_VERSION, bin, args, snapshot, startedAt: new Date().toISOString() }, null, 2)}\n`,
  );

  const started = Date.now();
  const streamPath = join(resultsDir, "stream.jsonl");
  const { code, timedOut } = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
    const child = spawn(bin, args, { cwd: workspace, env: buildChildEnv(opts.parentEnv ?? process.env, opts.extraEnv ?? {}), stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(createWriteStream(streamPath));
    child.stderr.pipe(createWriteStream(join(resultsDir, "stderr.txt")));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000);
    }, task.timeoutMinutes * 60_000);
    child.on("close", (c) => {
      clearTimeout(timer);
      resolve({ code: c, timedOut });
    });
  });
  const durationMs = Date.now() - started;

  const events = parseStreamJson(readFileSync(streamPath, "utf8"));
  const result = events.filter((e) => e.type === "result").at(-1);
  const gitW = (a: string[]) => execFileSync("git", a, { cwd: workspace, encoding: "utf8", env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin", HOME: homedir(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "baseline", GIT_AUTHOR_EMAIL: "eval@jarvis.invalid", GIT_COMMITTER_NAME: "baseline", GIT_COMMITTER_EMAIL: "eval@jarvis.invalid" } }).trim();
  // The candidate revision: whatever the session left, committed by the runner, not the agent.
  gitW(["add", "-A"]);
  gitW(["commit", "-q", "--allow-empty", "--no-verify", "-m", `baseline result (${runId})`]);
  const finalCommit = gitW(["rev-parse", "HEAD"]);
  const diffStat = gitW(["diff", "--shortstat", snapshot.commit, finalCommit]);

  const out: BaselineRunResult = {
    task: task.id,
    runId,
    resultsDir,
    workspace,
    exitCode: code,
    timedOut,
    durationMs,
    init: initInfo(events),
    resultSubtype: typeof result?.subtype === "string" ? result.subtype : undefined,
    numTurns: typeof result?.num_turns === "number" ? result.num_turns : undefined,
    toolCalls: toolCalls(events).length,
    rateLimits: rateLimits(events),
    finalCommit,
    diffStat,
    snapshot,
  };
  writeFileSync(join(resultsDir, "summary.json"), `${JSON.stringify(out, null, 2)}\n`);
  return out;
}
