import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { goModToolchain, goPlatform, prepareGoToolchain, removeGoToolchain, toolchainHost } from "../../packages/cli/src/toolchain/go.ts";
import { shortTmp } from "../helpers.ts";
import { FIXTURE_GO, makeGoFixture, pinFixtureToolchain, toolchainModule } from "./helpers/go-fixture.ts";

const roots: string[] = [];
function removeAll(path: string): void {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (st?.isDirectory()) { chmodSync(path, 0o700); for (const n of readdirSync(path)) removeAll(join(path, n)); }
  rmSync(path, { recursive: true, force: true });
}
afterEach(() => { roots.splice(0).forEach(removeAll); vi.restoreAllMocks(); });
// The disk floor has its own test (toolchain-zip.test.ts); here the host's free disk must not decide the outcome.
beforeEach(() => { vi.spyOn(toolchainHost, "freeBytes").mockReturnValue(1e15); pinFixtureToolchain(); });

function setup(goMod: string | null = `module example.com/app\n\ngo 1.26.10\n`) {
  const root = shortTmp("jtg-");
  roots.push(root);
  const workspace = join(root, "ws");
  mkdirSync(workspace);
  if (goMod !== null) writeFileSync(join(workspace, "go.mod"), goMod);
  const fixture = makeGoFixture(join(root, "evals", "gate", "fixtures", "gomodcache"));
  const dest = join(root, "work", "toolchains", "05", "run-1");
  return { root, workspace, fixture, dest };
}
/** prepareGoToolchain where it must not throw: a throw is an assertion failure, not an error. */
function prepared(i: Parameters<typeof prepareGoToolchain>[0]): ReturnType<typeof prepareGoToolchain> {
  let p: ReturnType<typeof prepareGoToolchain> | undefined;
  expect(() => { p = prepareGoToolchain(i); }).not.toThrow();
  return p!;
}

describe("a pinned, offline Go for task sessions (decision 123)", () => {
  it("is not needed when the workspace has no go.mod, and creates nothing", () => {
    const s = setup(null);
    expect(prepareGoToolchain({ workspace: s.workspace, fixture: s.fixture, dest: s.dest })).toEqual({ report: { status: "not-needed" } });
    expect(existsSync(s.dest)).toBe(false);
  });

  it("asks for the toolchain go.mod names: its toolchain line, else its go line", () => {
    expect(goModToolchain("module m\n\ngo 1.26.10\n")).toBe("go1.26.10");
    expect(goModToolchain("module m\n\ngo 1.26.10 // pinned\n\ntoolchain go1.26.11\n")).toBe("go1.26.11");
    expect(goModToolchain("module m\ngo 1.22\n")).toBe("go1.22");
    expect(goModToolchain("module m\n")).toBeUndefined();
    // Anything else is never turned into a path.
    expect(goModToolchain("module m\ngo 1.26.10/../../x\n")).toBeUndefined();
    expect(goModToolchain("module m\ntoolchain go1.26.10;rm\n")).toBeUndefined();
  });

  it("gives sessions the fixture's toolchain and module cache, read-only, with nothing to download", () => {
    const s = setup();
    const p = prepareGoToolchain({ workspace: s.workspace, fixture: s.fixture, dest: s.dest });
    const dest = realpathSync(s.dest);
    const fixture = realpathSync(s.fixture);
    expect(p.report).toEqual({ status: "ready", version: FIXTURE_GO, modCache: fixture });
    expect(p.dir).toBe(dest);
    const bin = join(dest, toolchainModule(), "bin");
    expect(p.toolchain).toEqual({
      version: FIXTURE_GO,
      readOnlyDirs: [dest, fixture],
      pathPrefix: [bin],
      env: { GOTOOLCHAIN: "local", GOMODCACHE: fixture, GOPROXY: "off", GOSUMDB: "off", GOFLAGS: "-buildvcs=false -mod=readonly", CGO_ENABLED: "0" },
    });
    // The extracted toolchain runs, and is the one go.mod asked for.
    expect(execFileSync(join(bin, "go"), ["version"]).toString()).toContain(`go version ${FIXTURE_GO}`);
    // The fixture itself is untouched: the toolchain is unpacked outside it.
    expect(existsSync(join(s.fixture, toolchainModule()))).toBe(false);
  });

  it("reports go unavailable when the task has no fixture, and creates nothing", () => {
    const s = setup();
    const none = prepared({ workspace: s.workspace, fixture: undefined, dest: s.dest });
    expect(none.report).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/no Go fixture/) });
    expect(none.toolchain).toBeUndefined();
    const missing = prepared({ workspace: s.workspace, fixture: join(s.root, "nowhere", "gomodcache"), dest: s.dest });
    expect(missing.report).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/no Go fixture at .*nowhere/) });
    expect(existsSync(s.dest)).toBe(false);
  });

  it("reports go unavailable when the fixture lacks the toolchain go.mod asks for", () => {
    const s = setup("module m\n\ngo 1.27.0\n");
    const p = prepared({ workspace: s.workspace, fixture: s.fixture, dest: s.dest });
    expect(p.report).toMatchObject({ status: "unavailable", reason: expect.stringMatching(new RegExp(`go1\\.27\\.0.*${goPlatform()}`)) });
    expect(p.toolchain).toBeUndefined();
    expect(existsSync(s.dest)).toBe(false);
    const nothing = prepared({ workspace: setup("module m\n").workspace, fixture: s.fixture, dest: s.dest });
    expect(nothing.report).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/go version/) });
  });

  it("refuses a fixture that is a symlink", () => {
    const s = setup();
    const link = join(s.root, "linked-gomodcache");
    symlinkSync(s.fixture, link);
    expect(() => prepareGoToolchain({ workspace: s.workspace, fixture: link, dest: s.dest })).toThrow(/refused.*symlink/);
    expect(existsSync(s.dest)).toBe(false);
  });

  it("refuses a fixture reached through a linked folder", () => {
    const s = setup();
    const link = join(s.root, "linked-fixtures");
    symlinkSync(join(s.root, "evals", "gate", "fixtures"), link);
    expect(() => prepareGoToolchain({ workspace: s.workspace, fixture: join(link, "gomodcache"), dest: s.dest })).toThrow(/refused.*link/);
    expect(existsSync(s.dest)).toBe(false);
  });

  it("refuses a fixture that holds a symlink", () => {
    const s = setup();
    symlinkSync("/etc/hosts", join(s.fixture, "example.com", "lib@v1.0.0", "hosts"));
    expect(() => prepareGoToolchain({ workspace: s.workspace, fixture: s.fixture, dest: s.dest })).toThrow(/refused.*symlink.*hosts/);
    expect(existsSync(s.dest)).toBe(false);
  });

  it("refuses a destination inside the fixture, or one that holds it", () => {
    const s = setup();
    expect(() => prepareGoToolchain({ workspace: s.workspace, fixture: s.fixture, dest: join(s.fixture, "toolchain") })).toThrow(/refused.*overlap/);
    expect(() => prepareGoToolchain({ workspace: s.workspace, fixture: s.fixture, dest: join(s.root, "evals") })).toThrow(/refused.*overlap/);
    expect(existsSync(join(s.fixture, "toolchain"))).toBe(false);
  });

  it("removes the unpacked toolchain afterwards, even read-only folders", () => {
    const s = setup();
    const p = prepareGoToolchain({ workspace: s.workspace, fixture: s.fixture, dest: s.dest });
    chmodSync(join(p.dir!, toolchainModule(), "bin"), 0o555);
    expect(() => removeGoToolchain(p.dir!)).not.toThrow();
    expect(existsSync(s.dest)).toBe(false);
    expect(existsSync(s.fixture)).toBe(true);
    expect(() => removeGoToolchain(s.dest)).not.toThrow();
  });
});
