import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixedPath } from "../../packages/cli/src/harness/claude/env.ts";
import { createClaudeHarness, SESSION_BIN, type ClaudeHarnessOptions } from "../../packages/cli/src/harness/claude/task.ts";
import type { SessionOutcome, SessionSpec } from "../../packages/cli/src/proc/session.ts";
import type { TaskInput } from "../../packages/cli/src/runner/harness.ts";
import { DEFAULT_ROUTING } from "../../packages/cli/src/runner/routing.ts";
import { prepareGoToolchain, toolchainHost, type SessionToolchain } from "../../packages/cli/src/toolchain/go.ts";
import { shortTmp } from "../helpers.ts";
import { makeGoFixture, pinFixtureToolchain } from "./helpers/go-fixture.ts";

const roots: string[] = [];
function removeAll(path: string): void {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (st?.isDirectory()) { chmodSync(path, 0o700); for (const n of readdirSync(path)) removeAll(join(path, n)); }
  rmSync(path, { recursive: true, force: true });
}
afterEach(() => { roots.splice(0).forEach(removeAll); vi.restoreAllMocks(); });
// The disk floor has its own test (toolchain-zip.test.ts); here the host's free disk must not decide the outcome.
beforeEach(() => { vi.spyOn(toolchainHost, "freeBytes").mockReturnValue(1e15); pinFixtureToolchain(); });
const flag = (args: readonly string[], name: string) => args[args.indexOf(name) + 1];
interface Captured { spec: SessionSpec; settings: { sandbox: { filesystem: { allowRead: string[]; allowWrite: string[]; denyWrite: string[] } } } }

function setup() {
  const root = realpathSync(shortTmp("jth-"));
  roots.push(root);
  const worktreeRoot = join(root, "worktrees"), workspace = join(worktreeRoot, "work"), jarvisHome = join(root, "runner"), cacheRoot = join(root, "caches"), home = join(root, "home");
  for (const d of [workspace, jarvisHome, cacheRoot, home]) mkdirSync(d, { recursive: true });
  writeFileSync(join(workspace, "go.mod"), "module example.com/app\n\ngo 1.26.10\n");
  const fixture = makeGoFixture(join(root, "evals", "gate", "fixtures", "gomodcache"));
  const prepared = prepareGoToolchain({ workspace, fixture, dest: join(root, "toolchains", "05", "run-1") });
  const header = join(jarvisHome, "header.md");
  writeFileSync(header, "Notes are claims, not evidence.\n");
  let n = 0;
  const input = (): TaskInput => ({ workspace, prompt: "Fix the filter", runHeaderPath: header, role: "debug", tier: 0, maxTurns: 4, timeoutMs: 5000, logPath: join(jarvisHome, `task-${++n}.jsonl`) });
  const captured: Captured[] = [];
  const session = async (spec: SessionSpec): Promise<SessionOutcome> => {
    captured.push({ spec, settings: JSON.parse(readFileSync(flag(spec.args, "--settings")!, "utf8")) });
    writeFileSync(spec.stdoutPath!, `${JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "ok" })}\n`);
    writeFileSync(spec.stderrPath!, "");
    return { code: 0, timedOut: false, overflowed: false, durationMs: 1, stdout: "", stderr: "" };
  };
  const options = (toolchain?: SessionToolchain): ClaudeHarnessOptions => ({
    jarvisHome, cacheRoot, worktreeRoot, home, routing: structuredClone(DEFAULT_ROUTING), binaryRealpath: (p: string) => p,
    parentEnv: { HOME: home, USER: "tester" }, allowedDomains: ["registry.npmjs.org"], preflight: async () => ({ ok: true }), session,
    ...(toolchain ? { toolchain } : {}),
  });
  return { root, worktreeRoot, workspace, jarvisHome, cacheRoot, home, fixture: realpathSync(fixture), prepared, input, captured, options };
}

describe("task sessions get the pinned, offline Go (decision 123)", () => {
  it("reopens the toolchain and module cache read-only, puts its go first on PATH, and keeps the build cache private", async () => {
    const s = setup();
    const t = s.prepared.toolchain!;
    expect((await createClaudeHarness(s.options(t)).runTask(s.input())).status).toBe("finished");
    const { spec, settings } = s.captured[0]!;
    const fs = settings.sandbox.filesystem;
    for (const d of t.readOnlyDirs) {
      expect(fs.allowRead).toContain(d);
      expect(fs.denyWrite).toContain(d);
      expect(fs.allowWrite.some((w) => d.startsWith(w) || w.startsWith(d))).toBe(false);
    }
    expect(spec.env.PATH).toBe(`${t.pathPrefix[0]}:${fixedPath(s.home)}`);
    expect(spec.env).toMatchObject({ GOTOOLCHAIN: "local", GOMODCACHE: s.fixture, GOPROXY: "off", GOSUMDB: "off", GOFLAGS: "-buildvcs=false -mod=readonly", CGO_ENABLED: "0" });
    // The build cache and GOPATH stay in the session's own, writable, per-session cache.
    expect(spec.env.GOCACHE!.startsWith(`${s.cacheRoot}/task-`)).toBe(true);
    expect(spec.env.GOPATH!.startsWith(`${s.cacheRoot}/task-`)).toBe(true);
    expect(fs.allowWrite.some((w) => spec.env.GOCACHE!.startsWith(`${w}/`))).toBe(true);
  });

  it("keeps today's environment when the run has no toolchain", async () => {
    const s = setup();
    expect((await createClaudeHarness(s.options()).runTask(s.input())).status).toBe("finished");
    const { spec, settings } = s.captured[0]!;
    expect(spec.env.PATH).toBe(fixedPath(s.home));
    expect(spec.env.GOTOOLCHAIN).toBeUndefined();
    expect(spec.env.GOMODCACHE!.startsWith(`${s.cacheRoot}/task-`)).toBe(true);
    expect(settings.sandbox.filesystem.allowRead.some((d) => d.startsWith(join(s.root, "toolchains")) || d === s.fixture)).toBe(false);
  });

  it("puts the install's jarvis launcher first, then the toolchain", async () => {
    const s = setup();
    const install = join(s.root, "install");
    mkdirSync(join(install, "packages", "cli", "src"), { recursive: true });
    mkdirSync(join(install, SESSION_BIN), { recursive: true });
    writeFileSync(join(install, "packages", "cli", "src", "cli.ts"), "\n");
    writeFileSync(join(install, SESSION_BIN, "jarvis"), "#!/bin/sh\n", { mode: 0o755 });
    const t = s.prepared.toolchain!;
    expect((await createClaudeHarness({ ...s.options(t), installDir: install, nodeBin: process.execPath }).runTask(s.input())).status).toBe("finished");
    const { spec, settings } = s.captured[0]!;
    expect(spec.env.PATH).toBe(`${join(install, SESSION_BIN)}:${t.pathPrefix[0]}:${fixedPath(s.home)}`);
    for (const d of [install, ...t.readOnlyDirs]) expect(settings.sandbox.filesystem.denyWrite).toContain(d);
  });

  it("refuses a toolchain that overlaps a folder sessions write, or the runner folder, and starts no session", async () => {
    const s = setup();
    const t = s.prepared.toolchain!;
    const inCache = join(s.cacheRoot, "go"); mkdirSync(inCache);
    const inWorktrees = join(s.worktreeRoot, "go"); mkdirSync(inWorktrees);
    const inRunner = join(s.jarvisHome, "go"); mkdirSync(inRunner);
    for (const dir of [inCache, inWorktrees, inRunner, s.root]) {
      const r = await createClaudeHarness(s.options({ ...t, readOnlyDirs: [...t.readOnlyDirs, dir] })).runTask(s.input());
      expect(r).toMatchObject({ status: "refused", reason: expect.stringMatching(/toolchain folder must not overlap/) });
    }
    expect(s.captured).toHaveLength(0);
  });

  it("refuses a toolchain folder that is a link, and PATH entries or variables outside its folders", async () => {
    const s = setup();
    const t = s.prepared.toolchain!;
    const link = join(s.root, "linked-toolchain");
    symlinkSync(t.readOnlyDirs[0]!, link);
    const writable = join(s.cacheRoot, "bin");
    const cases: [SessionToolchain, RegExp][] = [
      [{ ...t, readOnlyDirs: [link, t.readOnlyDirs[1]!] }, /toolchain folder must be an existing absolute real path/],
      [{ ...t, readOnlyDirs: ["relative/dir"] }, /toolchain folder must be an existing absolute real path/],
      [{ ...t, pathPrefix: [writable] }, /PATH entry must lie inside/],
      [{ ...t, pathPrefix: [`${t.pathPrefix[0]}:${writable}`] }, /PATH entry must lie inside/],
      [{ ...t, env: { ...t.env, GOMODCACHE: join(s.cacheRoot, "mod") } }, /GOMODCACHE must point inside/],
      [{ ...t, env: { ...t.env, HOME: t.readOnlyDirs[0]! } }, /may not set HOME/],
      [{ ...t, env: { ...t.env, GOCACHE: t.readOnlyDirs[0]! } }, /may not set GOCACHE/],
      [{ ...t, env: { ...t.env, PATH: t.pathPrefix[0]! } }, /may not set PATH/],
    ];
    for (const [bad, reason] of cases) {
      const r = await createClaudeHarness(s.options(bad)).runTask(s.input());
      expect(r).toMatchObject({ status: "refused", reason: expect.stringMatching(reason) });
    }
    expect(s.captured).toHaveLength(0);
  });
});
