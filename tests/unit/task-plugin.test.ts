import { execFileSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assembleTaskPlugin, TASK_SKILLS } from "../../packages/cli/src/harness/claude/task-plugin.ts";
import { createClaudeHarness, type ClaudeHarnessOptions } from "../../packages/cli/src/harness/claude/task.ts";
import type { SessionOutcome, SessionSpec } from "../../packages/cli/src/proc/session.ts";
import type { TaskInput } from "../../packages/cli/src/runner/harness.ts";
import { DEFAULT_ROUTING } from "../../packages/cli/src/runner/routing.ts";

/**
 * Task sessions get a runner-owned plugin of their own (architecture §3.1, §5): the manifest, the
 * exact hooks, and only the build and debug skills, copied as real files without their evals.
 * Intake, spec, architect and the rest belong to the interactive session, not to task sessions.
 */
const repoPlugin = realpathSync(fileURLToPath(new URL("../../plugin", import.meta.url)));
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));
const tmp = () => { const r = mkdtempSync(join(realpathSync("/tmp"), "jtp-")); roots.push(r); return r; };

/** Every path below `dir`, with its kind: "f" file, "d" directory, "l" link, "o" anything else. */
function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    for (const name of readdirSync(p).sort()) {
      const full = join(p, name);
      const st = lstatSync(full);
      const kind = st.isSymbolicLink() ? "l" : st.isDirectory() ? "d" : st.isFile() ? "f" : "o";
      out.push(`${kind} ${relative(dir, full)}`);
      if (kind === "d") walk(full);
    }
  };
  walk(dir);
  return out;
}

const EXPECTED = [
  "d .claude-plugin", "f .claude-plugin/plugin.json",
  "d hooks", "f hooks/hooks.json", "f hooks/session-start.mjs", "f hooks/tripwire.mjs",
  "d skills", "d skills/build", "f skills/build/SKILL.md", "d skills/debug", "f skills/debug/SKILL.md",
];
const SAME_BYTES = [".claude-plugin/plugin.json", "hooks/hooks.json", "hooks/session-start.mjs", "hooks/tripwire.mjs", "skills/build/SKILL.md", "skills/debug/SKILL.md"];

describe("assembleTaskPlugin", () => {
  it("copies the manifest, the exact hooks and only build and debug, as real files without evals", () => {
    expect([...TASK_SKILLS]).toEqual(["build", "debug"]);
    const dest = join(tmp(), "plugin");
    expect(assembleTaskPlugin(repoPlugin, dest)).toBe(dest);
    expect(tree(dest)).toEqual(EXPECTED);
    for (const rel of SAME_BYTES) expect(readFileSync(join(dest, rel), "utf8"), rel).toBe(readFileSync(join(repoPlugin, rel), "utf8"));
  });

  it("refuses a destination that already exists", () => {
    const dest = join(tmp(), "plugin");
    mkdirSync(dest);
    expect(() => assembleTaskPlugin(repoPlugin, dest)).toThrow(/exists/);
  });

  it("refuses a source without a task skill, or with something other than files and folders", () => {
    const root = tmp();
    const source = join(root, "source");
    cpSync(repoPlugin, source, { recursive: true, dereference: true, verbatimSymlinks: false });
    // cpSync leaves the nested skills link as a link; make it a real folder for this fixture.
    rmSync(join(source, "skills"), { recursive: true, force: true });
    mkdirSync(join(source, "skills"));
    cpSync(join(repoPlugin, "skills", "build"), join(source, "skills", "build"), { recursive: true });
    expect(() => assembleTaskPlugin(source, join(root, "a"))).toThrow(/debug/);
    cpSync(join(repoPlugin, "skills", "debug"), join(source, "skills", "debug"), { recursive: true });
    expect(assembleTaskPlugin(source, join(root, "b"))).toBe(join(root, "b"));
    execFileSync("mkfifo", [join(source, "skills", "debug", "pipe")]);
    expect(() => assembleTaskPlugin(source, join(root, "c"))).toThrow(/regular/);
  });
});

function setup() {
  const root = tmp();
  const worktreeRoot = join(root, "worktrees"); mkdirSync(worktreeRoot);
  const workspace = join(worktreeRoot, "work"), jarvisHome = join(root, "runner"), cacheRoot = join(root, "caches"), home = join(root, "home");
  for (const d of [workspace, jarvisHome, cacheRoot, home]) mkdirSync(d);
  const runHeaderPath = join(jarvisHome, "header.md"); writeFileSync(runHeaderPath, "header\n");
  const input: TaskInput = { workspace, prompt: "Build the parser", runHeaderPath, role: "build", tier: 1, maxTurns: 4, timeoutMs: 5000, logPath: join(jarvisHome, "task.jsonl") };
  const seen: { pluginDir: string | undefined; tree: string[] }[] = [];
  const session = async (spec: SessionSpec): Promise<SessionOutcome> => {
    const i = spec.args.indexOf("--plugin-dir");
    const pluginDir = i >= 0 ? spec.args[i + 1] : undefined;
    seen.push({ pluginDir, tree: pluginDir ? tree(pluginDir) : [] });
    // No process: this test is about what the session is given. A successful result line is enough.
    const stdout = `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`;
    writeFileSync(spec.stdoutPath!, stdout, { flag: "wx" });
    writeFileSync(spec.stderrPath!, "", { flag: "wx" });
    return { code: 0, timedOut: false, overflowed: false, durationMs: 1, stdout, stderr: "" };
  };
  const options: ClaudeHarnessOptions = {
    jarvisHome, cacheRoot, worktreeRoot, routing: structuredClone(DEFAULT_ROUTING), binaryRealpath: (p: string) => p, home,
    parentEnv: { HOME: home, USER: "tester" }, allowedDomains: [], preflight: vi.fn(async () => ({ ok: true })), session, pluginDir: repoPlugin,
  };
  return { root, input, options, seen, jarvisHome, workspace, cacheRoot };
}

describe("task sessions load the task plugin", () => {
  it("passes a fresh runner-owned copy with only build and debug, never the repo's plugin, and removes it afterwards", async () => {
    const s = setup();
    const outcome = await createClaudeHarness(s.options).runTask(s.input);
    expect(outcome.status, JSON.stringify(outcome)).toBe("finished");
    expect(s.seen).toHaveLength(1);
    const { pluginDir, tree: seenTree } = s.seen[0]!;
    expect(pluginDir).toBeDefined();
    expect(pluginDir).not.toBe(repoPlugin);
    expect(pluginDir!.startsWith(`${realpathSync(s.jarvisHome)}/`), pluginDir).toBe(true);
    expect(seenTree).toEqual(EXPECTED);
    expect(() => lstatSync(pluginDir!)).toThrow();
  });

  it.each(["in-work", "in-cache"])("refuses a plugin source agents can write: %s", async (where) => {
    const s = setup();
    // A complete, valid plugin, so only its location can be the reason for refusing it.
    const source = assembleTaskPlugin(repoPlugin, join(where === "in-work" ? s.workspace : s.cacheRoot, "plugin"));
    s.options.pluginDir = source;
    expect(await createClaudeHarness({ ...s.options, pluginDir: assembleTaskPlugin(repoPlugin, join(s.root, "outside-plugin")) }).runTask({ ...s.input, logPath: join(s.jarvisHome, "control.jsonl") })).toMatchObject({ status: "finished" });
    s.seen.length = 0;
    const outcome = await createClaudeHarness(s.options).runTask(s.input);
    expect(outcome.status).toBe("refused");
    expect(s.seen).toEqual([]);
  });
});
