import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pinnedClaudeBin } from "../../config/pins.ts";
import type { Harness, TaskInput, TaskOutcome, TaskResult } from "../../runner/harness.ts";
import { routeTask, validateRouting, type RoutingTable } from "../../runner/routing.ts";
import { assertSafeTaskArgs, buildTaskArgs } from "./args.ts";
import { buildChildEnv } from "./env.ts";
import { runSession, type SessionOutcome, type SessionSpec } from "./session.ts";
import { cacheEnv, makeSessionTmpDir, sessionTmpEnv, writeTaskSettings, type TaskSettingsInput } from "./settings.ts";
import { hitRateLimitError, parseStreamJson, rateLimits, usageWaitUntil } from "./streamjson.ts";
import { assembleTaskPlugin, checkTaskPluginSource } from "./task-plugin.ts";
import { sessionUsage } from "./usage.ts";

export interface TaskPreflight {
  ok: boolean;
  usageWaitUntil?: number;
}

export interface ClaudeHarnessOptions {
  jarvisHome: string;
  /** Parent for fresh, empty per-session caches; outside the worktree and runner folder. */
  cacheRoot: string;
  /** Only real paths strictly below this root may be task workspaces. */
  worktreeRoot: string;
  allowedDomains: readonly string[];
  /** startBrokerServer(...).socketPath: the bound address, never its public alias (decision 78). */
  brokerSocket?: string;
  /**
   * The Jarvis install (the folder holding packages/cli/src/cli.ts and its node_modules) whose CLI sessions run
   * as `jarvis act`. Reopened read-only; it must not overlap the worktrees, caches or runner folder.
   */
  installDir?: string;
  /** The repo's plugin/; each session gets its own runner-owned copy with only the task skills (task-plugin.ts). */
  pluginDir?: string;
  home?: string;
  parentEnv?: Readonly<Record<string, string | undefined>>;
  /** Trusted snapshot loaded once by the runner at run start. */
  routing: RoutingTable;
  /** Test seams. Production resolves the real pinned binary and removes owned directories. */
  binaryRealpath?: (path: string) => string;
  cleanup?: (path: string) => void;
  /** Required live canary/doctor preflight, called before every session. Tests inject a fake. */
  preflight: (input: TaskInput) => Promise<TaskPreflight>;
  /** Test seam: production makes a short private folder under /private/tmp (decision 93). */
  sessionTmpDir?: () => string;
  /** Process seam for tests; production always uses runSession and the absolute pin. */
  session?: (spec: SessionSpec) => Promise<SessionOutcome>;
}

const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
const emptyResult = (): TaskResult => ({ exitCode: null, durationMs: 0, usage: [], usageWaitUntil: undefined });

function runnerOwnedPath(path: string, jarvisHome: string): void {
  if (!isAbsolute(path) || !under(resolve(path), jarvisHome) || !under(realpathSync(path), jarvisHome)) throw new Error("session configuration must be in the runner-owned folder");
}

function protectedPaths(input: TaskInput, jarvisHome: string, pluginDir?: string, agentWritable: readonly string[] = []): void {
  runnerOwnedPath(input.runHeaderPath, jarvisHome);
  if (pluginDir) checkTaskPluginSource(pluginDir, agentWritable);
  if (!isAbsolute(input.logPath) || !under(resolve(input.logPath), jarvisHome)) throw new Error("task log must be in the runner-owned folder");
  mkdirSync(dirname(input.logPath), { recursive: true, mode: 0o700 });
  if (!under(realpathSync(dirname(input.logPath)), jarvisHome)) throw new Error("task log parent escapes the runner-owned folder");
  if (lstatSync(input.logPath, { throwIfNoEntry: false }) || lstatSync(`${input.logPath}.stderr`, { throwIfNoEntry: false })) throw new Error("task log paths must be fresh");
}

function taskOutcome(result: SessionOutcome, logPath: string): TaskOutcome {
  const events = parseStreamJson(readFileSync(logPath, "utf8"));
  const infos = rateLimits(events);
  const limitedByError = hitRateLimitError(events);
  const limited = infos.some((i) => i.status === "rejected") || limitedByError;
  const rejected = infos.filter((i) => i.status === "rejected");
  const waits = [usageWaitUntil(infos, { limitedByError }), ...rejected.map((i) => usageWaitUntil([i]))]
    .filter((at): at is number => at !== undefined);
  const waitUntil = waits.length ? Math.max(...waits) : undefined;
  // The builder's own last words: a claim for the report when it wrote no notes, never evidence.
  const finalMessage = events.filter((e) => e.type === "result").at(-1)?.result;
  const base: TaskResult = {
    exitCode: result.code, durationMs: result.durationMs,
    usage: infos.map((i) => ({ windows: i.windows })), usageWaitUntil: waitUntil,
    sessionUsage: sessionUsage(events),
    ...(typeof finalMessage === "string" ? { finalMessage } : {}),
  };
  if (result.overflowed) return { ...base, status: "error", message: "task output exceeded its capture limit" };
  if (limited) {
    const resetInfos = rejected.length ? rejected : infos.slice(-1);
    const hasReset = resetInfos.some((i) => i.resetsAt !== undefined || Object.values(i.windows).some((w) => w.resetsAt !== undefined));
    return { ...base, status: "usage-limited", resetAt: hasReset ? waitUntil : undefined };
  }
  if (result.timedOut) return { ...base, status: "timeout" };
  const final = events.filter((e) => e.type === "result").at(-1);
  if (result.code !== 0 || final?.subtype !== "success" || final.is_error === true) {
    return { ...base, status: "error", message: `task session failed (exit ${result.code}, result ${String(final?.subtype ?? "missing")})` };
  }
  return { ...base, status: "finished" };
}

function writableDirectories(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
  chmodSync(path, stat.mode | 0o700);
  for (const name of readdirSync(path)) writableDirectories(join(path, name));
}

function removeTaskDirectory(path: string): void {
  writableDirectories(path);
  rmSync(path, { recursive: true, force: true });
}

function trustedInstall(installDir: string, roots: readonly string[]): string {
  if (!isAbsolute(installDir) || realpathSync(installDir) !== installDir) throw new Error("the Jarvis install must be an absolute real path");
  if (!lstatSync(join(installDir, "packages", "cli", "src", "cli.ts"), { throwIfNoEntry: false })?.isFile()) throw new Error("the Jarvis install has no packages/cli/src/cli.ts");
  for (const root of roots) if (under(installDir, root) || under(root, installDir)) throw new Error("the Jarvis install must not overlap the worktrees, caches or runner folder");
  return installDir;
}

function trustedLocations(input: TaskInput, opts: ClaudeHarnessOptions): { worktree: string; jarvisHome: string; cacheRoot: string; home: string; binary: string; installDir?: string } {
  const worktree = realpathSync(input.workspace);
  const worktreeRoot = realpathSync(opts.worktreeRoot);
  if (!isAbsolute(input.workspace) || worktree === worktreeRoot || !under(worktree, worktreeRoot)) throw new Error("workspace must be below the worktree root");
  const jarvisHome = realpathSync(opts.jarvisHome);
  const cacheRoot = realpathSync(opts.cacheRoot);
  const home = realpathSync(opts.home ?? homedir());
  const binary = pinnedClaudeBin(homedir());
  const binaryTarget = (opts.binaryRealpath ?? realpathSync)(binary);
  for (const root of [worktreeRoot, cacheRoot, jarvisHome]) {
    if (under(home, root)) throw new Error("session home must be outside worktrees, cache and jarvisHome");
    if (!isAbsolute(binaryTarget) || under(resolve(binaryTarget), root)) throw new Error("pinned binary must resolve outside worktrees, cache and jarvisHome");
  }
  const installDir = opts.installDir === undefined ? undefined : trustedInstall(opts.installDir, [worktreeRoot, cacheRoot, jarvisHome]);
  return { worktree, jarvisHome, cacheRoot, home, binary, ...(installDir ? { installDir } : {}) };
}

function prepareTask(input: TaskInput, opts: ClaudeHarnessOptions, routing: RoutingTable, locations: ReturnType<typeof trustedLocations>, cacheDir: string, sessionDir: string, sessionTmpDir: string): SessionSpec {
  const { worktree, jarvisHome, home, binary } = locations;
  const settingsPath = join(sessionDir, "settings.json");
  const mcpPath = join(sessionDir, "mcp.json");
  const context: TaskSettingsInput = {
    worktree, jarvisHome, cacheDir, sessionTmpDir, allowedDomains: opts.allowedDomains,
    // `jarvis act` loads the installed CLI: read-only, and only that folder.
    ...(locations.installDir ? { readOnlyDirs: [locations.installDir] } : {}),
    ...(opts.brokerSocket ? { brokerSocket: opts.brokerSocket } : {}),
  };
  writeTaskSettings(settingsPath, context);
  writeFileSync(mcpPath, '{"mcpServers":{}}\n', { mode: 0o600 });
  const route = routeTask(input.role, input.tier, input.failure, routing);
  const args = assertSafeTaskArgs([
    ...buildTaskArgs({
      prompt: input.prompt, settingsPath, mcpConfigPath: mcpPath, model: route.model, maxTurns: input.maxTurns,
      runHeaderPath: input.runHeaderPath, ...(opts.pluginDir ? { pluginDir: assembleTaskPlugin(opts.pluginDir, join(sessionDir, "plugin")) } : {}),
    }),
    "--effort", route.effort,
  ]);
  const tmpDir = join(cacheDir, "tmp");
  mkdirSync(tmpDir, { mode: 0o700 });
  const env = buildChildEnv({ ...(opts.parentEnv ?? process.env), HOME: home }, {
    ...cacheEnv(cacheDir), ...sessionTmpEnv(sessionTmpDir),
    ...(opts.brokerSocket ? { JARVIS_BROKER_SOCKET: opts.brokerSocket } : {}),
    JARVIS_SESSION: "1", // the plugin's tripwire enforces in Jarvis sessions only
  });
  return {
    bin: binary, args, cwd: worktree, env, timeoutMs: input.timeoutMs,
    stdoutPath: input.logPath, stderrPath: `${input.logPath}.stderr`, maxOutputBytes: 16 * 1024 * 1024,
    ...(input.onSpawn ? { onSpawn: input.onSpawn } : {}),
    ...(input.onGroupExit ? { onGroupExit: input.onGroupExit } : {}),
  };
}

function cleanupDirectories(paths: readonly string[], cleanup: (path: string) => void): string[] {
  const errors: string[] = [];
  for (const path of paths) {
    try { cleanup(path); } catch (e) { errors.push(`${path}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return errors;
}

/** The adapter owns session setup and cleanup; refused setup never spends a repair attempt. */
export function createClaudeHarness(opts: ClaudeHarnessOptions): Harness {
  let routing: RoutingTable | undefined;
  let routingError: string | undefined;
  try { routing = validateRouting(opts.routing); } catch (e) { routingError = e instanceof Error ? e.message : String(e); }
  return {
    async runTask(input) {
      const owned: string[] = [];
      let dispatched = false;
      let outcome: TaskOutcome;
      try {
        if (!routing) throw new Error(routingError ?? "routing snapshot is required");
        if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 2_147_483_647) throw new Error("invalid task timeout");
        const locations = trustedLocations(input, opts);
        protectedPaths(input, locations.jarvisHome, opts.pluginDir, [realpathSync(opts.worktreeRoot), locations.cacheRoot]);
        const preflight = await opts.preflight(input);
        if (preflight.usageWaitUntil !== undefined) return { ...emptyResult(), status: "usage-limited", resetAt: preflight.usageWaitUntil, usageWaitUntil: preflight.usageWaitUntil };
        if (!preflight.ok) throw new Error("live preflight failed; no task session started");
        const cacheDir = mkdtempSync(join(locations.cacheRoot, "task-")); owned.push(cacheDir);
        const sessionDir = mkdtempSync(join(locations.jarvisHome, "task-")); owned.push(sessionDir);
        const sessionTmpDir = (opts.sessionTmpDir ?? makeSessionTmpDir)(); owned.push(sessionTmpDir);
        const spec = prepareTask(input, opts, routing, locations, cacheDir, sessionDir, sessionTmpDir);
        dispatched = true;
        outcome = taskOutcome(await (opts.session ?? runSession)(spec), input.logPath);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        outcome = dispatched ? { ...emptyResult(), status: "error", message: reason } : { ...emptyResult(), status: "refused", reason };
      }
      const cleanupErrors = cleanupDirectories(owned, opts.cleanup ?? removeTaskDirectory);
      return cleanupErrors.length ? { ...outcome, cleanupErrors } : outcome;
    },
  };
}
