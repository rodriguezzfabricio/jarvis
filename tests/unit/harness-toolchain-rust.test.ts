import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixedPath } from "../../packages/cli/src/harness/claude/env.ts";
import { createClaudeHarness, type ClaudeHarnessOptions } from "../../packages/cli/src/harness/claude/task.ts";
import { checkSessionToolchain, systemToolchainPolicy } from "../../packages/cli/src/harness/claude/toolchain.ts";
import type { SessionOutcome, SessionSpec } from "../../packages/cli/src/proc/session.ts";
import type { TaskInput } from "../../packages/cli/src/runner/harness.ts";
import { DEFAULT_ROUTING } from "../../packages/cli/src/runner/routing.ts";
import type { SessionToolchain } from "../../packages/cli/src/toolchain/go.ts";
import { prepareRustToolchain } from "../../packages/cli/src/toolchain/rust.ts";
import { shortTmp } from "../helpers.ts";
import { makeCommandLineTools, makeRustFixture, pinRustFixture, useCommandLineTools } from "./helpers/rust-fixture.ts";

const roots: string[] = [];
function removeAll(path: string): void {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (st?.isDirectory()) { chmodSync(path, 0o700); for (const n of readdirSync(path)) removeAll(join(path, n)); }
  rmSync(path, { recursive: true, force: true });
}
afterEach(() => { roots.splice(0).forEach(removeAll); vi.restoreAllMocks(); });
const flag = (args: readonly string[], name: string) => args[args.indexOf(name) + 1];
interface Captured { spec: SessionSpec; settings: { sandbox: { filesystem: { allowRead: string[]; allowWrite: string[]; denyWrite: string[] } } } }

function setup() {
  const root = realpathSync(shortTmp("jhr-"));
  roots.push(root);
  const worktreeRoot = join(root, "worktrees"), workspace = join(worktreeRoot, "work"), jarvisHome = join(root, "runner"), cacheRoot = join(root, "caches"), home = join(root, "home");
  for (const d of [workspace, jarvisHome, cacheRoot, home]) mkdirSync(d, { recursive: true });
  const fixture = makeRustFixture(join(root, "evals", "gate", "fixtures", "rust"));
  const clt = makeCommandLineTools(join(root, "clt"));
  useCommandLineTools(clt);
  pinRustFixture(fixture);
  // The stand-in Command Line Tools are the system folder this test allows (the real one is root-owned).
  vi.spyOn(systemToolchainPolicy, "roots").mockReturnValue([clt]);
  vi.spyOn(systemToolchainPolicy, "owned").mockReturnValue(true);
  const prepared = prepareRustToolchain({ fixture });
  const header = join(jarvisHome, "header.md");
  writeFileSync(header, "Notes are claims, not evidence.\n");
  let n = 0;
  const input = (): TaskInput => ({ workspace, prompt: "Build the menu-bar app", runHeaderPath: header, role: "build", tier: 1, maxTurns: 4, timeoutMs: 5000, logPath: join(jarvisHome, `task-${++n}.jsonl`) });
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
  return { root, worktreeRoot, workspace, jarvisHome, cacheRoot, home, fixture: realpathSync(fixture), clt, prepared, input, captured, options };
}

describe("task sessions get the pinned, offline Rust (decision 163)", () => {
  it("reopens the fixture read-only, puts its cargo and the Command Line Tools' clang first, and names the SDK", async () => {
    const s = setup();
    const t = s.prepared.toolchain!;
    expect((await createClaudeHarness(s.options(t)).runTask(s.input())).status).toBe("finished");
    const { spec, settings } = s.captured[0]!;
    const fs = settings.sandbox.filesystem;
    expect(fs.allowRead).toContain(s.fixture);
    expect(fs.denyWrite).toContain(s.fixture);
    expect(fs.allowWrite.some((w) => s.fixture.startsWith(w) || w.startsWith(s.fixture))).toBe(false);
    // The system folder is reopened read-only, so the session's read block can't hide it, and never made writable.
    expect(fs.allowRead).toContain(s.clt);
    expect(fs.denyWrite).toContain(s.clt);
    expect(fs.allowWrite.some((d) => d.startsWith(s.clt) || s.clt.startsWith(d))).toBe(false);
    expect(spec.env.PATH).toBe(`${join(s.fixture, "toolchain", "bin")}:${join(s.clt, "usr", "bin")}:${fixedPath(s.home)}`);
    expect(spec.env).toMatchObject({ CARGO_HOME: join(s.fixture, "cargo-home"), CARGO_NET_OFFLINE: "true", SDKROOT: join(s.clt, "SDKs", "MacOSX26.5.sdk"), DEVELOPER_DIR: s.clt });
  });

  it("refuses a system folder that isn't an allowed one, isn't root-owned, or overlaps a folder sessions write", async () => {
    const s = setup();
    const t = s.prepared.toolchain!;
    const other = join(s.root, "usr-local"); mkdirSync(join(other, "bin"), { recursive: true });
    const inCache = join(s.cacheRoot, "clt"); mkdirSync(inCache);
    const cases: [SessionToolchain, RegExp, boolean?][] = [
      [{ ...t, systemDirs: [other], pathPrefix: [t.pathPrefix[0]!, join(other, "bin")] }, /system folder .* is not one a toolchain may use/],
      [{ ...t, systemDirs: [inCache] }, /system folder .* is not one a toolchain may use/],
      [{ ...t, systemDirs: [s.clt] }, /system folder must be owned by root/, true],
    ];
    for (const [bad, reason, notOwned] of cases) {
      if (notOwned) vi.spyOn(systemToolchainPolicy, "owned").mockReturnValue(false);
      const r = await createClaudeHarness(s.options(bad)).runTask(s.input());
      expect(r).toMatchObject({ status: "refused", reason: expect.stringMatching(reason) });
    }
    vi.spyOn(systemToolchainPolicy, "owned").mockReturnValue(true);
    vi.spyOn(systemToolchainPolicy, "roots").mockReturnValue([s.clt, inCache]);
    const r = await createClaudeHarness(s.options({ ...t, systemDirs: [inCache] })).runTask(s.input());
    expect(r).toMatchObject({ status: "refused", reason: expect.stringMatching(/must not overlap a folder sessions write/) });
    expect(s.captured).toHaveLength(0);
  });

  it("refuses PATH entries and variables outside the fixture and the system folder, and variables no toolchain sets", async () => {
    const s = setup();
    const t = s.prepared.toolchain!;
    const cases: [SessionToolchain, RegExp][] = [
      [{ ...t, pathPrefix: [join(s.cacheRoot, "bin")] }, /PATH entry must lie inside/],
      [{ ...t, systemDirs: [], pathPrefix: t.pathPrefix }, /PATH entry must lie inside/],
      [{ ...t, env: { ...t.env, CARGO_HOME: join(s.cacheRoot, "cargo") } }, /CARGO_HOME must point inside/],
      [{ ...t, env: { ...t.env, SDKROOT: "/opt/sdk" } }, /SDKROOT must point inside/],
      [{ ...t, env: { ...t.env, RUSTFLAGS: "-C linker=/tmp/x" } }, /may not set RUSTFLAGS/],
      [{ ...t, env: { ...t.env, RUSTC_WRAPPER: t.readOnlyDirs[0]! } }, /may not set RUSTC_WRAPPER/],
    ];
    for (const [bad, reason] of cases) {
      const r = await createClaudeHarness(s.options(bad)).runTask(s.input());
      expect(r).toMatchObject({ status: "refused", reason: expect.stringMatching(reason) });
    }
    expect(s.captured).toHaveLength(0);
  });

  it("checks a toolchain without system folders exactly as before", () => {
    const s = setup();
    expect(checkSessionToolchain(undefined, [s.cacheRoot])).toEqual({ readOnlyDirs: [], pathPrefix: [], env: {} });
    const t = s.prepared.toolchain!;
    const parts = checkSessionToolchain(t, [s.worktreeRoot, s.cacheRoot, s.jarvisHome]);
    expect(parts).toEqual({ readOnlyDirs: [s.fixture, s.clt], pathPrefix: t.pathPrefix, env: t.env });
  });
});
