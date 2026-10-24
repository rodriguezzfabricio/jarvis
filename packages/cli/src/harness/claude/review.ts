import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { CLAUDE_CODE_VERSION, pinnedClaudeBin } from "../../config/pins.ts";
import type { Reviewer, ReviewerInput, ReviewerOutput } from "../../review/types.ts";
import { assertSafeTaskArgs, buildTaskArgs } from "./args.ts";
import { buildChildEnv } from "./env.ts";
import { runSession, type SessionOutcome, type SessionSpec } from "./session.ts";
import { cacheEnv, makeSessionTmpDir, sessionTmpEnv, writeTaskSettings } from "./settings.ts";
import { hitRateLimitError, initInfo, parseStreamJson, rateLimits, toolCalls } from "./streamjson.ts";

export interface ClaudeReviewerOptions {
  jarvisHome: string;
  workRoot: string;
  cacheRoot: string;
  home?: string;
  preflight: (input: ReviewerInput) => Promise<{ ok: boolean }>;
  binaryRealpath?: (path: string) => string;
  session?: (spec: SessionSpec) => Promise<SessionOutcome>;
  /** The session's short private temp folder (decision 95); tests inject one. */
  sessionTmpDir?: () => string;
}
const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
const READ_TOOLS = ["Read", "Glob", "Grep"] as const;

function locations(input: ReviewerInput, opts: ClaudeReviewerOptions) {
  const workspace = realpathSync(input.workspace), outputDir = realpathSync(input.outputDir);
  const jarvisHome = realpathSync(opts.jarvisHome), workRoot = realpathSync(opts.workRoot), cacheRoot = realpathSync(opts.cacheRoot);
  if (!isAbsolute(input.workspace) || workspace === workRoot || !under(workspace, workRoot)) throw new Error("review workspace must be below workRoot");
  if (!isAbsolute(input.outputDir) || outputDir === jarvisHome || !under(outputDir, jarvisHome)) throw new Error("review output must be runner-owned");
  if (under(workRoot, jarvisHome) || under(cacheRoot, jarvisHome) || under(jarvisHome, workRoot)) throw new Error("review roots must be separate from runner-owned data");
  const home = realpathSync(opts.home ?? homedir());
  if ([workRoot, cacheRoot, jarvisHome].some((root) => under(home, root))) throw new Error("review HOME must be outside work, cache and runner roots");
  const binary = pinnedClaudeBin();
  const target = (opts.binaryRealpath ?? realpathSync)(binary);
  if (!isAbsolute(target) || [workRoot, cacheRoot, jarvisHome].some((r) => under(target, r))) throw new Error("unsafe pinned reviewer binary");
  return { workspace, outputDir, jarvisHome, cacheRoot, binary, home };
}
function verdictFromSession(result: SessionOutcome, raw: string, model: string): { rawVerdict: string; error?: string } {
  const events = parseStreamJson(raw), init = initInfo(events);
  const final = events.filter((e) => e.type === "result").at(-1);
  if (toolCalls(events).some((c) => !(READ_TOOLS as readonly string[]).includes(c.name))) return { rawVerdict: "", error: "reviewer attempted a tool outside the read-only list" };
  if (init?.claudeCodeVersion !== CLAUDE_CODE_VERSION || init.model !== model || init.permissionMode !== "dontAsk" || init.memoryPaths !== undefined) return { rawVerdict: "", error: "review session initialization mismatch" };
  if (result.code !== 0 || result.timedOut || result.overflowed || final?.subtype !== "success" || final.is_error === true || hitRateLimitError(events) || rateLimits(events).some((r) => r.status === "rejected")) return { rawVerdict: "", error: "Claude review failed or timed out" };
  return typeof final.result === "string" ? { rawVerdict: final.result } : { rawVerdict: "", error: "Claude review returned no verdict" };
}

/** Fresh read-only sessions; task settings reach disk only through the existing policy writer. */
export function createClaudeReviewer(opts: ClaudeReviewerOptions): Reviewer {
  return async (input) => {
    const base = { reviewer: "claude" as const, model: input.model };
    let cache: string | undefined;
    let sessionTmp: string | undefined;
    try {
      const loc = locations(input, opts);
      if (!(await opts.preflight(input)).ok) throw new Error("live preflight failed");
      cache = mkdtempSync(join(loc.cacheRoot, "review-"));
      sessionTmp = (opts.sessionTmpDir ?? makeSessionTmpDir)();
      const settings = join(loc.outputDir, "settings.json"), mcp = join(loc.outputDir, "mcp.json");
      if (existsSync(settings) || existsSync(mcp)) throw new Error("review settings paths must be fresh");
      writeTaskSettings(settings, { worktree: loc.workspace, jarvisHome: loc.jarvisHome, cacheDir: cache, sessionTmpDir: sessionTmp, allowedDomains: [] });
      writeFileSync(mcp, '{"mcpServers":{}}\n', { flag: "wx", mode: 0o600 });
      const args = assertSafeTaskArgs([...buildTaskArgs({ prompt: input.prompt, settingsPath: settings, mcpConfigPath: mcp, model: input.model, maxTurns: input.maxTurns, tools: READ_TOOLS }), "--effort", input.effort]);
      const tmp = join(cache, "tmp"); mkdirSync(tmp, { mode: 0o700 });
      const log = join(loc.outputDir, "events.jsonl"), stderr = join(loc.outputDir, "stderr.txt");
      if (existsSync(log) || existsSync(stderr)) throw new Error("review logs must be fresh");
      const result = await (opts.session ?? runSession)({
        bin: loc.binary, args, cwd: loc.workspace,
        env: buildChildEnv({ HOME: loc.home, USER: process.env.USER }, { ...cacheEnv(cache), ...sessionTmpEnv(sessionTmp), TMPDIR: tmp }),
        timeoutMs: input.timeoutMs, stdoutPath: log, stderrPath: stderr, maxOutputBytes: 16 * 1024 * 1024,
      });
      const raw = readFileSync(log, "utf8");
      return { ...base, rawOutput: JSON.stringify({ stdout: raw, stderr: readFileSync(stderr, "utf8") }), ...verdictFromSession(result, raw, input.model) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...base, rawOutput: JSON.stringify({ error: message }), rawVerdict: "", error: message };
    } finally {
      if (cache) rmSync(cache, { recursive: true, force: true });
      if (sessionTmp) rmSync(sessionTmp, { recursive: true, force: true });
    }
  };
}
