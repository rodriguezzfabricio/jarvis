import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pinnedClaudeBin } from "../../packages/cli/src/config/pins.ts";
import { BUILD_TOOLS } from "../../packages/cli/src/harness/claude/args.ts";
import { buildTaskSettings, claudeUidTmp, CLAUDE_TMP_MAX_BYTES, SYSTEM_TEMP_ROOTS } from "../../packages/cli/src/harness/claude/settings.ts";
import { createClaudeHarness, type ClaudeHarnessOptions } from "../../packages/cli/src/harness/claude/task.ts";
import { runSession, type SessionSpec, type SessionOutcome } from "../../packages/cli/src/proc/session.ts";
import { DEFAULT_ROUTING } from "../../packages/cli/src/runner/routing.ts";
import type { TaskInput } from "../../packages/cli/src/runner/harness.ts";

const roots: string[] = [];
const fake = resolve("tests/fixtures/fake-claude.mjs");
// Fault injections deliberately break production cleanup; restore only this test's fixtures.
function removeFixture(path: string): void {
  if (lstatSync(path).isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) removeFixture(join(path, name));
  }
  rmSync(path, { recursive: true, force: true });
}
afterEach(() => roots.splice(0).forEach(removeFixture));
const flag = (args: readonly string[], name: string) => args[args.indexOf(name) + 1];
function setup() {
  const root = mkdtempSync(join(realpathSync("/tmp"), "jarvis-task-")); roots.push(root);
  const worktreeRoot = join(root, "worktrees"); mkdirSync(worktreeRoot);
  const workspace = join(worktreeRoot, "work"), jarvisHome = join(root, "runner"), cacheRoot = join(root, "caches"), home = join(root, "home");
  for (const d of [workspace, jarvisHome, cacheRoot, home]) mkdirSync(d);
  const runHeaderPath = join(jarvisHome, "header.md"); writeFileSync(runHeaderPath, "Notes are claims, not evidence.\n");
  const input: TaskInput = { workspace, prompt: "Build the parser", runHeaderPath, role: "build", tier: 1, maxTurns: 4, timeoutMs: 5000, logPath: join(jarvisHome, "task.jsonl") };
  const specs: SessionSpec[] = [];
  const spawned: SessionSpec[] = [];
  const settingsSnapshots: ReturnType<typeof buildTaskSettings>[] = [];
  const mcpSnapshots: unknown[] = [];
  const preflight = vi.fn(async () => ({ ok: true }));
  const session = async (spec: SessionSpec): Promise<SessionOutcome> => {
    specs.push(spec);
    settingsSnapshots.push(JSON.parse(readFileSync(flag(spec.args, "--settings")!, "utf8")));
    mcpSnapshots.push(JSON.parse(readFileSync(flag(spec.args, "--mcp-config")!, "utf8")));
    const actual = { ...spec, bin: process.execPath, args: [fake, ...spec.args], env: { ...spec.env, FAKE_CLAUDE_MODE: "baseline" } };
    spawned.push(actual);
    return runSession(actual);
  };
  const options: ClaudeHarnessOptions = { jarvisHome, cacheRoot, worktreeRoot, routing: structuredClone(DEFAULT_ROUTING), binaryRealpath: (path: string) => path, home, parentEnv: { HOME: home, USER: "tester", TMPDIR: "/private/tmp/untrusted", PATH: "/untrusted", NODE_OPTIONS: "--invalid", HTTPS_PROXY: "http://untrusted.invalid", CLAUDE_CONFIG_DIR: "/untrusted/config", CLAUDE_CODE_USE_OPENAI: "1", ANTHROPIC_API_KEY: "sk-test-not-real", ANTHROPIC_AUTH_TOKEN: "not-real-auth", CLAUDE_CODE_OAUTH_TOKEN: "not-real-oauth", AWS_ACCESS_KEY_ID: "not-real-aws" }, allowedDomains: ["registry.npmjs.org"], brokerSocket: join(jarvisHome, ".bound.sock"), preflight, session };
  return { root, input, options, specs, spawned, preflight, settingsSnapshots, mcpSnapshots };
}
async function launched() {
  const s = setup();
  const outcome = await createClaudeHarness(s.options).runTask(s.input);
  expect(outcome.status).toBe("finished");
  const spec = s.spawned[0]!;
  const settings = s.settingsSnapshots[0]!;
  return { ...s, spec, settings, outcome };
}

describe("Claude task safety envelope", () => {
  it("requires fail-closed sandbox settings in the file used by the spawned fake", async () => {
    const { settings } = await launched();
    expect(settings.sandbox.enabled).toBe(true);
    expect(settings.sandbox.failIfUnavailable).toBe(true);
    expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
    expect(settings.sandbox.network).toMatchObject({ allowedDomains: ["registry.npmjs.org"] });
  });

  it("uses restricted mode and exactly BUILD_TOOLS, with no setting sources or project hooks", async () => {
    const s = setup();
    const marker = join(s.root, "hook-ran");
    mkdirSync(join(s.input.workspace, ".claude"));
    writeFileSync(join(s.input.workspace, ".claude/settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `touch ${marker}` }] }] } }));
    expect((await createClaudeHarness(s.options).runTask(s.input)).status).toBe("finished");
    const args = s.spawned[0]!.args;
    expect(args.filter((a) => a === "--restricted")).toHaveLength(1);
    expect(flag(args, "--tools")).toBe(BUILD_TOOLS.join(","));
    expect(args.some((a) => a.startsWith("--setting-sources"))).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it("passes dontAsk, no prompts, strict empty MCP and no persistence on the actual argv", async () => {
    const { spec, input, mcpSnapshots } = await launched();
    expect(flag(spec.args, "--permission-mode")).toBe("dontAsk");
    expect(flag(spec.args, "--permission-prompts")).toBe("none");
    expect(spec.args).toContain("--strict-mcp-config");
    expect(spec.args).toContain("--no-session-persistence");
    expect(mcpSnapshots[0]).toEqual({ mcpServers: {} });
    expect(flag(spec.args, "--append-system-prompt-file")).toBe(input.runHeaderPath);
    expect(flag(spec.args, "--max-turns")).toBe("4");
    expect(flag(spec.args, "-p")).toBe(input.prompt);
  });

  it("disables auto memory in the actual settings and fake init event", async () => {
    const { settings, input } = await launched();
    expect(settings.autoMemoryEnabled).toBe(false);
    const init = JSON.parse(readFileSync(input.logPath, "utf8").split("\n")[0]!);
    expect(init.memory_paths).toBeUndefined();
    expect(init.apiKeySource).toBe("none");
  });

  it("blocks outside reads, reopens only its private cache and uses the bound broker address", async () => {
    const { settings, spec, options, input } = await launched();
    expect(settings.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    // Decision 93: the system temp roots are denied; this test's workspace lives under one, so it is reopened.
    expect(settings.sandbox.filesystem.denyRead).toEqual([options.jarvisHome, ...SYSTEM_TEMP_ROOTS]);
    const cache = settings.sandbox.filesystem.allowRead[1]!;
    expect(dirname(cache)).toBe(options.cacheRoot);
    // Claude Code's own temp root: short and private, or it falls back to the shared /tmp/claude-<uid>.
    const sessionTmp = String(spec.env.CLAUDE_CODE_TMPDIR);
    expect(settings.sandbox.filesystem.allowRead).toEqual([input.workspace, cache, sessionTmp]);
    expect(settings.sandbox.filesystem.allowWrite).toEqual([cache, sessionTmp]);
    expect(sessionTmp).toMatch(/^\/private\/tmp\/jt-/);
    expect(Buffer.byteLength(claudeUidTmp(sessionTmp))).toBeLessThanOrEqual(CLAUDE_TMP_MAX_BYTES);
    expect(existsSync(sessionTmp)).toBe(false);
    expect(settings.sandbox.filesystem.denyWrite).toEqual([options.jarvisHome, join(input.workspace, ".git/hooks"), join(input.workspace, ".git/config"), join(input.workspace, ".claude")]);
    expect(settings.permissions.deny).toContain(`Read(/${options.jarvisHome}/**)`);
    expect(settings.sandbox.network.allowUnixSockets).toEqual([options.brokerSocket]);
    expect(spec.env.JARVIS_BROKER_SOCKET).toBe(options.brokerSocket);
    expect(spec.env.TMPDIR).toBe(join(cache, "tmp"));
    expect(spec.env.GOCACHE).toBe(join(cache, "go/build"));
    expect(existsSync(cache)).toBe(false);
  });

  it("does not dispatch unless the injected live preflight passes", async () => {
    const s = setup();
    const harness = createClaudeHarness({ ...s.options, preflight: async () => ({ ok: false }) });
    expect(await harness.runTask(s.input)).toMatchObject({ status: "refused", reason: expect.stringMatching(/preflight/i) });
    expect(s.specs).toEqual([]);
    expect(existsSync(s.input.logPath)).toBe(false);
  });

  it("runs preflight before each fresh session and allocates distinct caches", async () => {
    const s = setup();
    const harness = createClaudeHarness(s.options);
    await harness.runTask(s.input);
    await harness.runTask({ ...s.input, logPath: join(s.options.jarvisHome, "second.jsonl") });
    expect(s.preflight).toHaveBeenCalledTimes(2);
    expect(s.specs).toHaveLength(2);
    expect(s.specs[0]!.env.GOCACHE).not.toBe(s.specs[1]!.env.GOCACHE);
    expect(flag(s.specs[0]!.args, "--settings")).not.toBe(flag(s.specs[1]!.args, "--settings"));
    expect(s.specs.every((x) => !x.args.includes("--resume") && !x.args.includes("--continue"))).toBe(true);
  });

  it("uses the absolute pin, routing model and effort, an allowlist environment and the requested workspace", async () => {
    const { spec, specs, options, input } = await launched();
    expect(specs[0]!.bin).toBe(pinnedClaudeBin(homedir()));
    expect(spec.cwd).toBe(input.workspace);
    expect(flag(spec.args, "--model")).toBe("claude-sonnet-5-5");
    expect(flag(spec.args, "--effort")).toBe("medium");
    expect(spec.timeoutMs).toBe(input.timeoutMs);
    for (const key of ["NODE_OPTIONS", "HTTPS_PROXY", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_USE_OPENAI", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) expect(spec.env[key]).toBeUndefined();
    expect(spec.env.PATH).not.toContain("/untrusted");
    expect(spec.env.HOME).toBe(options.home);
    expect(spec.env.JARVIS_SESSION, "the tripwire enforces in Jarvis sessions only").toBe("1");
    expect(Object.keys(specs[0]!.env).sort()).toEqual([
      "CLAUDE_CODE_TMPDIR", "GOCACHE", "GOMODCACHE", "GOPATH", "GOTELEMETRY", "HOME", "JARVIS_BROKER_SOCKET", "JARVIS_SESSION", "PATH", "TMPDIR", "USER", "XDG_CACHE_HOME", "npm_config_cache", "npm_config_store_dir",
    ].sort());
    expect(spec.stdoutPath).toBe(input.logPath);
    expect(spec.stderrPath).toBe(`${input.logPath}.stderr`);
    expect(spec.maxOutputBytes).toBeGreaterThan(0);
  });
});

describe("task outcomes", () => {
  it("detects a rejected rate_limit_event even though the fake exits zero with success", async () => {
    const s = setup();
    const session = (spec: SessionSpec) => runSession({ ...spec, bin: process.execPath, args: [fake, ...spec.args], env: { ...spec.env, FAKE_CLAUDE_MODE: "rejected" } });
    const outcome = await createClaudeHarness({ ...s.options, session }).runTask(s.input);
    expect(outcome).toMatchObject({ status: "usage-limited", exitCode: 0, resetAt: 1792790000, usageWaitUntil: 1792790000 });
    expect(outcome.usage[0]?.windows.five_hour?.utilization).toBe(1);
  });

  it("keeps a rejected window's later reset when another event follows it", async () => {
    const s = setup();
    const events = [
      { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 2000 } },
      { type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1500 } },
      { type: "result", subtype: "success" },
    ];
    const session = async (spec: SessionSpec) => {
      writeFileSync(spec.stdoutPath!, events.map((e) => JSON.stringify(e)).join("\n"));
      return { code: 0, timedOut: false, overflowed: false, durationMs: 7, stdout: "", stderr: "" };
    };
    expect(await createClaudeHarness({ ...s.options, session }).runTask(s.input)).toMatchObject({ status: "usage-limited", resetAt: 2000 });
  });

  it.each([
    ["assistant-only limit", [{ type: "assistant", error: "rate_limit" }, { type: "result", subtype: "success" }], 0, "usage-limited"],
    ["plain process error", [{ type: "result", subtype: "success" }], 1, "error"],
    ["result error", [{ type: "result", subtype: "error_max_turns", is_error: true }], 0, "error"],
    ["missing result", [], 0, "error"],
    ["near-full window", [{ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", unifiedWindows: { five_hour: { utilization: 0.9, resetsAt: 2000 } } } }, { type: "result", subtype: "success" }], 0, "finished"],
  ] as const)("classifies %s without inferring usage from an exit code", async (_label, events, code, status) => {
    const s = setup();
    const session = async (spec: SessionSpec) => {
      writeFileSync(spec.stdoutPath!, events.map((e) => JSON.stringify(e)).join("\n"));
      return { code, timedOut: false, overflowed: false, durationMs: 7, stdout: "", stderr: "" };
    };
    const outcome = await createClaudeHarness({ ...s.options, session }).runTask(s.input);
    expect(outcome.status).toBe(status);
    if (_label === "near-full window") expect(outcome.usageWaitUntil).toBe(2000);
    if (_label === "assistant-only limit") expect(outcome).toMatchObject({ resetAt: undefined });
  });

  it.each([[true, false, "timeout"], [false, true, "error"]] as const)("handles timeout=%s and overflow=%s", async (timedOut, overflowed, status) => {
    const s = setup();
    const session = async (spec: SessionSpec) => {
      writeFileSync(spec.stdoutPath!, '{"type":"result","subtype":"success"}\n');
      return { code: 0, timedOut, overflowed, durationMs: 10, stdout: "", stderr: "" };
    };
    expect((await createClaudeHarness({ ...s.options, session }).runTask(s.input)).status).toBe(status);
  });

  it("reports spawn/capture failures and removes its cache on errors", async () => {
    const s = setup();
    let cache: string | undefined;
    const session = async (spec: SessionSpec): Promise<SessionOutcome> => { cache = dirname(spec.env.GOCACHE!); throw new Error("capture failed"); };
    expect(await createClaudeHarness({ ...s.options, session }).runTask(s.input)).toMatchObject({ status: "error", message: "capture failed" });
    expect(existsSync(dirname(cache!))).toBe(false);
  });

  it.each([false, true])("does not start work when preflight reports a usage wait (ok=%s)", async (ok) => {
    const s = setup();
    const outcome = await createClaudeHarness({ ...s.options, preflight: async () => ({ ok, usageWaitUntil: 2000 }) }).runTask(s.input);
    expect(outcome).toMatchObject({ status: "usage-limited", resetAt: 2000 });
    expect(s.specs).toEqual([]);
  });

  it.each(["log", "header", "log-symlink", "dangling-log-symlink", "header-alias-in-work", "plugin-in-work", "cache-inside-work", "invalid-timeout"])("refuses unsafe session paths or limits: %s", async (kind) => {
    const s = setup();
    if (kind === "log") s.input.logPath = join(s.input.workspace, "output.jsonl");
    if (kind === "header") { s.input.runHeaderPath = join(s.input.workspace, "header.md"); writeFileSync(s.input.runHeaderPath, "header"); }
    if (kind === "log-symlink") { const target = join(s.root, "outside.txt"); writeFileSync(target, "unchanged"); symlinkSync(target, s.input.logPath); }
    if (kind === "dangling-log-symlink") symlinkSync(join(s.root, "new-outside.txt"), s.input.logPath);
    if (kind === "header-alias-in-work") { const alias = join(s.input.workspace, "header-alias.md"); symlinkSync(s.input.runHeaderPath, alias); s.input.runHeaderPath = alias; }
    if (kind === "plugin-in-work") { s.options.pluginDir = join(s.input.workspace, "plugin"); mkdirSync(s.options.pluginDir); }
    if (kind === "cache-inside-work") s.options.cacheRoot = s.input.workspace;
    if (kind === "invalid-timeout") s.input.timeoutMs = 0;
    const outcome = await createClaudeHarness(s.options).runTask(s.input);
    expect(outcome.status).toBe("refused");
    expect(s.specs).toEqual([]);
  });
});


describe("review regressions", () => {
  it("ignores an agent-written routing override on every dispatch", async () => {
    const s = setup();
    const override = structuredClone(DEFAULT_ROUTING) as import("../../packages/cli/src/runner/routing.ts").RoutingTable; override.tiers.strong.model = "claude-haiku-5-5"; override.escalate_on = [];
    writeFileSync(join(s.input.workspace, ".jarvis-routing.json"), JSON.stringify(override));
    // Deliberately omit the snapshot: a runtime caller must be refused, never fall back to work.
    const { routing: _routing, ...missing } = s.options;
    const outcome = await createClaudeHarness(missing as ClaudeHarnessOptions).runTask({ ...s.input, role: "review", tier: 2 });
    expect(outcome.status).toBe("refused");
    expect(s.specs).toEqual([]);
  });

  it("uses a captured routing snapshot even when the worktree or caller changes", async () => {
    const s = setup();
    const harness = createClaudeHarness(s.options);
    s.options.routing.tiers.strong.model = "claude-haiku-5-5";
    writeFileSync(join(s.input.workspace, ".jarvis-routing.json"), JSON.stringify(s.options.routing));
    expect((await harness.runTask({ ...s.input, role: "review", tier: 2 })).status).toBe("finished");
    expect(flag(s.specs[0]!.args, "--model")).toBe("claude-opus-5-5");
  });

  it("removes read-only Go cache directories and session configuration after the session", async () => {
    const s = setup();
    let cache = "", sessionDir = "";
    const session = async (spec: SessionSpec) => {
      cache = dirname(dirname(spec.env.GOCACHE!));
      sessionDir = dirname(flag(spec.args, "--settings")!);
      const nested = join(cache, "go/mod/example/pkg");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, "file.txt"), "module");
      for (const p of [nested, dirname(nested), dirname(dirname(nested))]) chmodSync(p, 0o555);
      return s.options.session!(spec);
    };
    const outcome = await createClaudeHarness({ ...s.options, session }).runTask(s.input);
    expect(outcome.status).toBe("finished");
    expect(existsSync(cache)).toBe(false);
    expect(existsSync(sessionDir)).toBe(false);
  });

  it.each(["finished", "timeout", "usage-limited", "error"] as const)("keeps the %s outcome when cleanup fails, and still cleans the session folder", async (status) => {
    const s = setup();
    let sessionDir = "";
    const session = async (spec: SessionSpec) => {
      sessionDir = dirname(flag(spec.args, "--settings")!);
      writeFileSync(spec.stdoutPath!, status === "usage-limited" ? '{"type":"assistant","error":"rate_limit"}\n' : '{"type":"result","subtype":"success"}\n');
      return { code: status === "error" ? 1 : 0, timedOut: status === "timeout", overflowed: false, durationMs: 9, stdout: "", stderr: "" };
    };
    const cleanup = (path: string) => {
      if (dirname(path) === s.options.cacheRoot) throw new Error("ENOTEMPTY injected");
      rmSync(path, { recursive: true, force: true });
    };
    const outcome = await createClaudeHarness({ ...s.options, session, cleanup }).runTask(s.input);
    expect(outcome).toMatchObject({ status, durationMs: 9, cleanupErrors: [expect.stringContaining("ENOTEMPTY injected")] });
    expect(existsSync(sessionDir)).toBe(false);
  });

  it("cleanup never follows a symlink to a read-only folder outside the cache", async () => {
    const s = setup();
    const outside = join(s.root, "outside"); mkdirSync(outside); writeFileSync(join(outside, "keep"), "keep"); chmodSync(outside, 0o555);
    try {
      const session = async (spec: SessionSpec) => {
        symlinkSync(outside, join(dirname(dirname(spec.env.GOCACHE!)), "link"));
        return s.options.session!(spec);
      };
      expect((await createClaudeHarness({ ...s.options, session }).runTask(s.input)).status).toBe("finished");
      expect(readFileSync(join(outside, "keep"), "utf8")).toBe("keep");
      expect((await import("node:fs")).statSync(outside).mode & 0o777).toBe(0o555);
    } finally { chmodSync(outside, 0o755); }
  });

  it.each(["work", "cache", "runner"])("refuses a session home under %s", async (location) => {
    const s = setup();
    s.options.home = location === "work" ? s.input.workspace : location === "cache" ? s.options.cacheRoot : s.options.jarvisHome;
    const outcome = await createClaudeHarness(s.options).runTask(s.input);
    expect(outcome).toMatchObject({ status: "refused", reason: expect.stringMatching(/home/i) });
    expect(s.specs).toEqual([]);
  });

  it.each(["work", "cache", "runner"])("refuses a pinned binary resolving under %s", async (location) => {
    const s = setup();
    const target = location === "work" ? s.input.workspace : location === "cache" ? s.options.cacheRoot : s.options.jarvisHome;
    const outcome = await createClaudeHarness({ ...s.options, binaryRealpath: () => join(target, "claude") }).runTask(s.input);
    expect(outcome).toMatchObject({ status: "refused", reason: expect.stringMatching(/binary/i) });
    expect(s.specs).toEqual([]);
  });

  it.each(["routing", "workspace", "workspace-alias"])("refuses invalid %s before dispatch", async (kind) => {
    const s = setup();
    if (kind === "routing") s.options.routing.tiers.fast.model = "sonnet";
    if (kind === "workspace") s.options.worktreeRoot = s.options.cacheRoot;
    if (kind === "workspace-alias") {
      const outside = mkdtempSync(join(realpathSync("/tmp"), "jarvis-outside-work-")); roots.push(outside);
      const alias = join(s.root, "aliased-work"); symlinkSync(outside, alias); s.input.workspace = alias;
    }
    const outcome = await createClaudeHarness(s.options).runTask(s.input);
    expect(outcome).toMatchObject({ status: "refused", reason: expect.any(String) });
    expect(s.specs).toEqual([]);
  });
});

describe("task lifecycle and session reports for the loop", () => {
  const scripted = (events: readonly object[], seen: SessionSpec[] = []) => async (spec: SessionSpec): Promise<SessionOutcome> => {
    seen.push(spec);
    writeFileSync(spec.stdoutPath!, events.map((e) => JSON.stringify(e)).join("\n"));
    return { code: 0, timedOut: false, overflowed: false, durationMs: 7, stdout: "", stderr: "" };
  };

  it("forwards onSpawn and onGroupExit to the session spec unchanged", async () => {
    const s = setup();
    const seen: SessionSpec[] = [];
    const onSpawn = (_id: number) => true;
    const onGroupExit = (_id: number) => {};
    await createClaudeHarness({ ...s.options, session: scripted([{ type: "result", subtype: "success" }], seen) }).runTask({ ...s.input, onSpawn, onGroupExit });
    expect(seen[0]!.onSpawn).toBe(onSpawn);
    expect(seen[0]!.onGroupExit).toBe(onGroupExit);
  });

  it("passes no lifecycle hooks when the caller gives none", async () => {
    const s = setup();
    const seen: SessionSpec[] = [];
    await createClaudeHarness({ ...s.options, session: scripted([{ type: "result", subtype: "success" }], seen) }).runTask(s.input);
    expect("onSpawn" in seen[0]!).toBe(false);
    expect("onGroupExit" in seen[0]!).toBe(false);
  });

  it("reports the last result's text as finalMessage, and none without a string result", async () => {
    const s = setup();
    const events = [{ type: "result", subtype: "success", result: "first" }, { type: "result", subtype: "success", result: "Built the parser." }];
    expect(await createClaudeHarness({ ...s.options, session: scripted(events) }).runTask(s.input)).toMatchObject({ status: "finished", finalMessage: "Built the parser." });
    const t = setup();
    const none = await createClaudeHarness({ ...t.options, session: scripted([{ type: "result", subtype: "success", result: 7 }]) }).runTask(t.input);
    expect(none).not.toHaveProperty("finalMessage");
  });

  it("reports what the stream says the session used, for the usage log", async () => {
    const s = setup();
    const events = [
      { type: "system", subtype: "init", model: "claude-sonnet-5-5" },
      { type: "result", subtype: "success", result: "ok", num_turns: 3, total_cost_usd: 0.25, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 } },
    ];
    const outcome = await createClaudeHarness({ ...s.options, session: scripted(events) }).runTask(s.input);
    expect(outcome.sessionUsage).toEqual({ reportedModel: "claude-sonnet-5-5", inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, costUsd: 0.25, turns: 3, complete: true });
  });

  it("reports no session usage when no session started", async () => {
    const s = setup();
    s.preflight.mockResolvedValueOnce({ ok: false });
    expect(await createClaudeHarness(s.options).runTask(s.input)).not.toHaveProperty("sessionUsage");
  });
});
