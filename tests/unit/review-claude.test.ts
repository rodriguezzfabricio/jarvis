import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaudeReviewer } from "../../packages/cli/src/harness/claude/review.ts";
import { pinnedClaudeBin } from "../../packages/cli/src/config/pins.ts";
import { buildTaskSettings } from "../../packages/cli/src/harness/claude/settings.ts";
import { runSession, type SessionSpec } from "../../packages/cli/src/proc/session.ts";
import type { ReviewerInput } from "../../packages/cli/src/review/types.ts";
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const flag = (s: SessionSpec, k: string) => s.args[s.args.indexOf(k) + 1]!;
function setup(steps: unknown[] = [{ result: { text: '{"findings":[]}' } }], fixtureEnv: Record<string, string> = {}, exitOnTerm = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "review-claude-"))); roots.push(root);
  const jarvisHome = join(root, "runner"), workRoot = join(root, "work"), cacheRoot = join(root, "cache"), home = join(root, "home");
  for (const d of [jarvisHome, workRoot, cacheRoot, home]) mkdirSync(d);
  const workspace = join(workRoot, "checkout"); mkdirSync(workspace);
  const outputDir = join(jarvisHome, "out"); mkdirSync(outputDir);
  const scenario = join(root, "scenario.json");
  writeFileSync(scenario, JSON.stringify({ sessions: [{ steps }] }));
  const input: ReviewerInput = { workspace, outputDir, prompt: "spec and criteria and evidence", model: "claude-opus-5-5", effort: "high", maxTurns: 8, timeoutMs: 5000 };
  const specs: SessionSpec[] = []; const settings: ReturnType<typeof buildTaskSettings>[] = [];
  const preflight = vi.fn(async () => ({ ok: true }));
  const options = { jarvisHome, workRoot, cacheRoot, home, preflight, binaryRealpath: (p: string) => p,
    session: async (s: SessionSpec) => {
      specs.push(s); settings.push(JSON.parse(readFileSync(flag(s, "--settings"), "utf8")));
      return runSession({ ...s, bin: process.execPath, args: [...(exitOnTerm ? ["--import", "data:text/javascript,process.on('SIGTERM',()=>process.exit(0))"] : []), resolve("tests/fixtures/fake-claude.mjs"), ...s.args], env: { ...s.env, FAKE_CLAUDE_SCENARIO: scenario, ...fixtureEnv }, killGraceMs: 30 });
    },
  };
  return { root, options, input, specs, settings, preflight };
}
describe("fresh Claude review sessions", () => {
  it("uses only read tools and reuses the exact permanent settings policy", async () => {
    const s = setup(); const r = await createClaudeReviewer(s.options)(s.input);
    expect(r.error).toBeUndefined(); expect(r.rawVerdict).toBe('{"findings":[]}');
    const spec = s.specs[0]!; const settings = s.settings[0]!;
    expect(spec.bin).toBe(pinnedClaudeBin());
    expect(flag(spec, "--tools")).toBe("Read,Glob,Grep");
    for (const f of ["--restricted", "--strict-mcp-config", "--no-session-persistence"]) expect(spec.args).toContain(f);
    expect(flag(spec, "--permission-mode")).toBe("dontAsk"); expect(flag(spec, "--permission-prompts")).toBe("none");
    expect(spec.args).not.toContain("--setting-sources");
    expect(flag(spec, "--model")).toBe("claude-opus-5-5");
    expect(flag(spec, "--effort")).toBe("high");
    expect(JSON.parse(readFileSync(join(s.input.outputDir, "mcp.json"), "utf8"))).toEqual({ mcpServers: {} });
    const cacheRoot = realpathSync(s.options.cacheRoot);
    const cache = settings.sandbox.filesystem.allowRead.find((p: string) => p.startsWith(`${cacheRoot}/`))!;
    const sessionTmpDir = spec.env.CLAUDE_CODE_TMPDIR!;
    expect(sessionTmpDir).toMatch(/^\/private\/tmp\/jt-/);
    expect(settings).toEqual(buildTaskSettings({ worktree: s.input.workspace, jarvisHome: s.options.jarvisHome, cacheDir: cache, sessionTmpDir, allowedDomains: [] }));
    expect(existsSync(sessionTmpDir)).toBe(false); // removed after the session
    expect(settings.sandbox.failIfUnavailable).toBe(true);
    expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
    expect(settings.autoMemoryEnabled).toBe(false);
    expect(settings.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    expect(settings.sandbox.network).toEqual({ allowedDomains: [], allowUnixSockets: [] });
    expect(Object.keys(spec.env)).not.toContain("FAKE_CLAUDE_SCENARIO");
    expect(readdirSync(s.options.cacheRoot)).toEqual([]);
  });
  it("refuses a failed live preflight without starting a process", async () => {
    const s = setup(); s.preflight.mockResolvedValue({ ok: false });
    expect((await createClaudeReviewer(s.options)(s.input)).error).toMatch(/preflight/);
    expect(s.specs).toHaveLength(0);
  });
  it("cannot turn a write tool attempt into a passing verdict", async () => {
    const s = setup([{ event: { type: "assistant", message: { content: [{ type: "tool_use", id: "evil", name: "Write", input: { file_path: "owned" } }] } } }, { result: { text: '{"findings":[]}' } }]);
    expect((await createClaudeReviewer(s.options)(s.input)).error).toMatch(/read-only/);
    expect(existsSync(join(s.input.workspace, "owned"))).toBe(false);
  });
  it.each([{ steps: [{ hang: true }] }, { steps: [{ result: { text: "garbage" } }] }, { steps: [{ rateLimit: { status: "rejected" } }, { result: { text: '{"findings":[]}' } }] }])("fails or returns invalid text for fault %j", async ({ steps }) => {
    const s = setup(steps); s.input.timeoutMs = 200;
    const r = await createClaudeReviewer(s.options)(s.input);
    expect(r.error || r.rawVerdict === "garbage").toBeTruthy();
  });
  it("validates the final args after appending effort, before spawning", async () => {
    const s = setup(); s.input.effort = "--resume" as ReviewerInput["effort"];
    expect((await createClaudeReviewer(s.options)(s.input)).error).toMatch(/must not contain --resume/);
    expect(s.specs).toHaveLength(0);
  });
  it("resolves HOME before passing it to a reviewer", async () => {
    const s = setup(); const alias = join(s.root, "home-alias"); symlinkSync(s.options.home, alias);
    s.options.home = alias;
    expect((await createClaudeReviewer(s.options)(s.input)).error).toBeUndefined();
    expect(s.specs[0]!.env.HOME).toBe(realpathSync(alias));
  });
  it.each(["workRoot", "cacheRoot", "jarvisHome"] as const)("rejects HOME in %s before spawning", async (root) => {
    const s = setup(); s.options.home = s.options[root];
    expect((await createClaudeReviewer(s.options)(s.input)).error).toMatch(/home/i);
    expect(s.specs).toHaveLength(0);
  });
  it.each([{ FAKE_CLAUDE_VERSION: "2.1.310" }, { FAKE_CLAUDE_MODE: "memory-on" }])("rejects unsafe init %j", async (env) => {
    const s = setup(undefined, env);
    expect((await createClaudeReviewer(s.options)(s.input)).error).toMatch(/initialization mismatch/);
  });
  it("rejects a success result followed by a hang even when shutdown exits zero", async () => {
    const s = setup([{ result: { text: '{"findings":[]}' } }, { hang: true }], {}, true);
    s.input.timeoutMs = 500;
    expect((await createClaudeReviewer(s.options)(s.input)).error).toMatch(/timed out/);
  });
  it("rejects output paths in the checkout", async () => {
    const s = setup(); s.input.outputDir = s.input.workspace;
    expect((await createClaudeReviewer(s.options)(s.input)).error).toMatch(/runner/);
    expect(s.specs).toHaveLength(0);
  });
});
