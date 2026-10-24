import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildTaskArgs } from "../../packages/cli/src/harness/claude/args.ts";
import { buildChildEnv } from "../../packages/cli/src/harness/claude/env.ts";
import { cacheEnv, writeTaskSettings } from "../../packages/cli/src/harness/claude/settings.ts";
import { parseStreamJson, rateLimits, toolCalls, usageWaitUntil } from "../../packages/cli/src/harness/claude/streamjson.ts";
import { runSession } from "../../packages/cli/src/proc/session.ts";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { createE2EProject, sessionCalls, type E2EProject, type E2EOptions } from "./e2e-helpers.ts";

// The fake's scenario mode, launched the way harness/claude/task.ts launches a task session: the
// absolute pin under a temp HOME, buildTaskArgs, writeTaskSettings, and buildChildEnv's allowlist.
const projects: E2EProject[] = [];
afterEach(() => projects.splice(0).forEach((p) => p.cleanup()));
const project = (scenario: E2EOptions["scenario"]) => { const p = createE2EProject({ scenario }); projects.push(p); return p; };

let n = 0;
function workspace(p: E2EProject): string {
  const w = join(p.worktreeRoot, `w${++n}`);
  safeGit(p.worktreeRoot, ["-c", "protocol.file.allow=always", "clone", "--quiet", "--", p.repoPath, w], { home: p.gitHome });
  return w;
}

async function launch(p: E2EProject, task: string, o: { cwd?: string; timeoutMs?: number; mutateArgs?: (a: string[]) => string[] } = {}) {
  const cwd = o.cwd ?? workspace(p);
  const session = mkdtempSync(join(p.jarvisHome, "task-"));
  const cacheDir = mkdtempSync(join(realpathSync(p.cacheRoot), "task-"));
  const settingsPath = join(session, "settings.json");
  const mcpConfigPath = join(session, "mcp.json");
  const runHeaderPath = join(session, "header.md");
  writeTaskSettings(settingsPath, { worktree: realpathSync(cwd), jarvisHome: realpathSync(p.jarvisHome), cacheDir, allowedDomains: [] });
  writeFileSync(mcpConfigPath, '{"mcpServers":{}}\n');
  writeFileSync(runHeaderPath, `Jarvis run: r1\nSpec version: 1\nTask: ${task}\n`);
  const args = buildTaskArgs({ prompt: `Task: ${task}\nGoal: see the spec`, settingsPath, mcpConfigPath, model: "claude-sonnet-5-5", maxTurns: 10, runHeaderPath });
  const logPath = join(session, "task.jsonl");
  const env = buildChildEnv({ HOME: p.home, USER: "e2e", ANTHROPIC_API_KEY: "must-not-pass" }, { ...cacheEnv(cacheDir), TMPDIR: cacheDir });
  const r = await runSession({ bin: p.claudeBin, args: o.mutateArgs ? o.mutateArgs(args) : args, cwd, env, timeoutMs: o.timeoutMs ?? 15_000, stdoutPath: logPath, stderrPath: `${logPath}.stderr`, killGraceMs: 1_000 });
  const events = parseStreamJson(readFileSync(logPath, "utf8"));
  return { ...r, cwd, events, stderrText: readFileSync(`${logPath}.stderr`, "utf8") };
}

describe("fake claude scenario mode", { timeout: 60_000 }, () => {
  it("acts out a task's session in its cwd: files, notes, stream-json, a success result", async () => {
    const p = project("happy");
    const r = await launch(p, "T1");
    expect(r.code, r.stderrText).toBe(0);
    expect(readFileSync(join(r.cwd, "src/multiply.mjs"), "utf8")).toContain("return a * b;");
    expect(readFileSync(join(r.cwd, ".jarvis/notes/T1.md"), "utf8")).toMatch(/Added multiply/);
    expect(existsSync(join(r.cwd, "src/clamp.mjs"))).toBe(false);
    expect(r.events[0]).toMatchObject({ type: "system", subtype: "init", model: "claude-sonnet-5-5" });
    expect(r.events[0]!.memory_paths).toBeUndefined();
    expect(toolCalls(r.events).map((c) => c.name)).toEqual(["Write", "Write", "Bash", "Write"]);
    expect(r.events.at(-1)).toMatchObject({ type: "result", subtype: "success", is_error: false, result: "Added multiply." });
    expect(rateLimits(r.events).map((i) => i.status)).toEqual(["allowed"]);
    expect(sessionCalls(p)).toMatchObject([{ n: 1, session: "T1-good", task: "T1", envelope: [] }]);
  });

  it("uses each session once, in order per task, and fails loudly when none is left", async () => {
    const p = project("repair");
    expect(readFileSync(join((await launch(p, "T1")).cwd, "src/multiply.mjs"), "utf8")).toContain("a + b");
    expect(readFileSync(join((await launch(p, "T2")).cwd, "src/clamp.mjs"), "utf8")).toContain("Math.min");
    expect(readFileSync(join((await launch(p, "T1")).cwd, "src/multiply.mjs"), "utf8")).toContain("a * b");
    const extra = await launch(p, "T1");
    expect(extra.code).toBe(1);
    expect(extra.events.at(-1)).toMatchObject({ type: "result", is_error: true });
    expect(sessionCalls(p).map((c) => c.session)).toEqual(["T1-wrong-sum", "T2-good", "T1-repair-good", null]);
  });

  it("reports a usage-limit rejection the way decision 62 describes: rejected event, success result, exit 0", async () => {
    const p = project("usage-limit");
    const before = Math.floor(Date.now() / 1000);
    const r = await launch(p, "T1");
    expect(r.code).toBe(0);
    expect(r.events.at(-1)).toMatchObject({ type: "result", subtype: "success", result: "" });
    const infos = rateLimits(r.events);
    expect(infos.map((i) => i.status)).toEqual(["allowed", "rejected"]);
    const rejected = infos[1]!;
    expect(rejected.resetsAt! - before).toBeGreaterThanOrEqual(1);
    expect(rejected.resetsAt! - before).toBeLessThanOrEqual(5);
    expect(rejected.windows.five_hour?.utilization).toBe(1);
    expect(usageWaitUntil(infos)).toBe(rejected.resetsAt);
    expect(r.events.some((e) => e.type === "assistant" && e.error === "rate_limit")).toBe(true);
    const resumed = await launch(p, "T1");
    expect(rateLimits(resumed.events).map((i) => i.status)).toEqual(["allowed"]);
    expect(readFileSync(join(resumed.cwd, "src/multiply.mjs"), "utf8")).toContain("a * b");
  });

  it("hangs until the session's timeout stops it", async () => {
    const p = project("timeout");
    const r = await launch(p, "T1", { timeoutMs: 1_500 });
    expect(r.timedOut).toBe(true);
    expect(r.events.some((e) => e.type === "result")).toBe(false);
  });

  it("writes outside the workspace only when a step says escape (the tamper scenario's protected check)", async () => {
    const p = project("tamper");
    expect(p.store.verify(p.ledger).ok).toBe(true);
    const r = await launch(p, "T1");
    expect(r.code).toBe(0);
    expect(readFileSync(join(p.store.checksDir, "expected/ac1.txt"), "utf8")).toContain("multiply(2,3)=5");
    expect(p.store.verify(p.ledger).problems).toContain("check changed: expected/ac1.txt");

    const q = project({ sessions: [{ name: "sneaky", steps: [{ write: "../outside.txt", content: "x" }] }] });
    const s = await launch(q, "T1");
    expect(s.code).not.toBe(0);
    expect(existsSync(join(s.cwd, "..", "outside.txt"))).toBe(false);
    const g = project({ sessions: [{ name: "git", steps: [{ write: ".git/hooks/pre-commit", content: "x" }] }] });
    const h = await launch(g, "T1");
    expect(h.code).not.toBe(0);
    expect(existsSync(join(h.cwd, ".git/hooks/pre-commit"))).toBe(false);
  });

  it("refuses to act on a launch without the safety envelope, and never sees the credential", async () => {
    const p = project("happy");
    const cwd = workspace(p);
    const r = await launch(p, "T1", { cwd, mutateArgs: (a) => a.filter((x) => x !== "--restricted") });
    expect(r.code).toBe(3);
    expect(existsSync(join(cwd, "src/multiply.mjs"))).toBe(false);
    const [call] = sessionCalls(p);
    expect(call!.envelope).toEqual(["--restricted exactly once"]);
    expect(call!.session).toBeNull();
    // buildChildEnv dropped ANTHROPIC_API_KEY, so the launch above was refused only for --restricted.
    const ok = await launch(p, "T1");
    expect(ok.code).toBe(0);
    expect(ok.events[0]).toMatchObject({ apiKeySource: "none" });
  });

  it("supports edit, delete, raw events, sleeps and explicit exits", async () => {
    const p = project({
      sessions: [{
        name: "misc", task: "T9", rateLimitAtStart: false,
        steps: [
          { write: "a.txt", content: "one two\n" },
          { edit: "a.txt", old: "two", new: "three" },
          { edit: "a.txt", old: "absent", new: "x" },
          { write: "b.txt", content: "gone\n" },
          { delete: "b.txt" },
          { event: { type: "assistant", message: { content: [{ type: "text", text: "raw" }] } } },
          { sleepMs: 50 },
          { exit: 7 },
        ],
      }],
    });
    const r = await launch(p, "T9");
    expect(r.code).toBe(7);
    expect(readFileSync(join(r.cwd, "a.txt"), "utf8")).toBe("one three\n");
    expect(existsSync(join(r.cwd, "b.txt"))).toBe(false);
    const results = r.events.filter((e) => e.type === "user").map((e) => (e.message as { content: { is_error: boolean }[] }).content[0]!.is_error);
    expect(results).toEqual([false, false, true, false, false]);
    expect(rateLimits(r.events)).toEqual([]);
    expect(r.events.some((e) => e.type === "result")).toBe(false);
  });
});
