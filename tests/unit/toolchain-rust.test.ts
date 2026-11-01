import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeSessionToolchains, prepareRustToolchain, rustFixtureDigest, rustHost, rustTarget } from "../../packages/cli/src/toolchain/rust.ts";
import { shortTmp } from "../helpers.ts";
import { FIXTURE_RUST, FIXTURE_TARGET, makeCommandLineTools, makeRustFixture, pinRustFixture, useCommandLineTools } from "./helpers/rust-fixture.ts";

const roots: string[] = [];
function removeAll(path: string): void {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (st?.isDirectory()) { chmodSync(path, 0o700); for (const n of readdirSync(path)) removeAll(join(path, n)); }
  rmSync(path, { recursive: true, force: true });
}
afterEach(() => { roots.splice(0).forEach(removeAll); vi.restoreAllMocks(); });

function setup() {
  const root = realpathSync(shortTmp("jtr-"));
  roots.push(root);
  const fixture = makeRustFixture(join(root, "evals", "gate", "fixtures", "rust"));
  const clt = makeCommandLineTools(join(root, "clt"));
  useCommandLineTools(clt);
  pinRustFixture(fixture);
  return { root, fixture, clt };
}
beforeEach(() => { vi.restoreAllMocks(); });

/** prepareRustToolchain where it must not throw: a throw is an assertion failure, not an error. */
function prepared(fixture: string | undefined): ReturnType<typeof prepareRustToolchain> {
  let p: ReturnType<typeof prepareRustToolchain> | undefined;
  expect(() => { p = prepareRustToolchain({ fixture }); }).not.toThrow();
  return p!;
}

describe("a pinned, offline Rust for task sessions (decision 164)", () => {
  it("is not needed when the task has no Rust fixture", () => {
    const s = setup();
    expect(prepared(undefined)).toEqual({ report: { status: "not-needed" } });
    expect(prepared(join(s.root, "evals", "gate", "fixtures", "absent"))).toEqual({ report: { status: "not-needed" } });
  });

  it("gives sessions the fixture's toolchain and crates read-only, offline, linking through the Command Line Tools", () => {
    const s = setup();
    const p = prepared(s.fixture);
    expect(p.report).toEqual({ status: "ready", rust: FIXTURE_RUST, target: FIXTURE_TARGET, tauriCli: "2.12.3", fixture: s.fixture });
    const t = p.toolchain!;
    expect(t.version).toBe(`rust ${FIXTURE_RUST}`);
    expect(t.readOnlyDirs).toEqual([s.fixture]);
    expect(t.systemDirs).toEqual([s.clt]);
    // The fixture's cargo first, then the Command Line Tools' clang ahead of /usr/bin's xcrun shims.
    expect(t.pathPrefix).toEqual([join(s.fixture, "toolchain", "bin"), join(s.clt, "usr", "bin")]);
    expect(t.env).toEqual({
      CARGO_HOME: join(s.fixture, "cargo-home"),
      CARGO_NET_OFFLINE: "true",
      // The SDK by its real path: MacOSX.sdk is a link to the installed version.
      SDKROOT: join(s.clt, "SDKs", "MacOSX26.5.sdk"),
      DEVELOPER_DIR: s.clt,
    });
  });

  it("hashes every file's path and bytes, the way shasum lists them", () => {
    const s = setup();
    const listing = execFileSync("/bin/sh", ["-c", "find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256"], { cwd: s.fixture });
    expect(rustFixtureDigest(s.fixture)).toBe(createHash("sha256").update(listing).digest("hex"));
  });

  it("refuses a fixture whose bytes are not the pinned ones, before any session", () => {
    const s = setup();
    appendFileSync(join(s.fixture, "vendor", "serde-1.0.228", "src", "lib.rs"), "pub fn planted() {}\n");
    expect(() => prepareRustToolchain({ fixture: s.fixture })).toThrow(/refused: .*not the pinned/);
  });

  it("refuses a fixture with a file added or renamed", () => {
    const s = setup();
    writeFileSync(join(s.fixture, "toolchain", "bin", "extra"), "#!/bin/sh\n", { mode: 0o755 });
    expect(() => prepareRustToolchain({ fixture: s.fixture })).toThrow(/refused: .*not the pinned/);
    rmSync(join(s.fixture, "toolchain", "bin", "extra"));
    expect(() => prepareRustToolchain({ fixture: s.fixture })).not.toThrow();
  });

  it("refuses a version with no pin, and a fixture for another platform", () => {
    const s = setup();
    pinRustFixture(s.fixture, "1.98.0");
    expect(() => prepareRustToolchain({ fixture: s.fixture })).toThrow(/refused: .*no pinned Rust fixture for 1\.99\.1 aarch64-apple-darwin/);
    const other = makeRustFixture(join(s.root, "other"), { rust: FIXTURE_RUST, target: "x86_64-apple-darwin", tauriCli: "2.12.3" });
    pinRustFixture(other, FIXTURE_RUST, "x86_64-apple-darwin");
    expect(() => prepareRustToolchain({ fixture: other })).toThrow(/refused: .*for x86_64-apple-darwin, and this machine is aarch64-apple-darwin/);
  });

  it("refuses a missing or malformed fixture.json, and never builds a key from it", () => {
    const s = setup();
    for (const info of ["not json", JSON.stringify({ rust: "1.99.1/../../x", target: FIXTURE_TARGET, tauriCli: "2.12.3" }), JSON.stringify({ rust: FIXTURE_RUST, target: FIXTURE_TARGET })]) {
      writeFileSync(join(s.fixture, "fixture.json"), info);
      expect(() => prepareRustToolchain({ fixture: s.fixture })).toThrow(/refused: .*fixture\.json/);
    }
    rmSync(join(s.fixture, "fixture.json"));
    expect(() => prepareRustToolchain({ fixture: s.fixture })).toThrow(/refused: .*fixture\.json/);
  });

  it("refuses a fixture that is a symlink, is reached through one, or holds one", () => {
    const s = setup();
    const link = join(s.root, "linked-rust");
    symlinkSync(s.fixture, link);
    expect(() => prepareRustToolchain({ fixture: link })).toThrow(/refused: .*symlink/);
    const parent = join(s.root, "linked-fixtures");
    symlinkSync(join(s.root, "evals", "gate", "fixtures"), parent);
    expect(() => prepareRustToolchain({ fixture: join(parent, "rust") })).toThrow(/refused: .*linked folder/);
    symlinkSync("/etc/hosts", join(s.fixture, "vendor", "hosts"));
    expect(() => prepareRustToolchain({ fixture: s.fixture })).toThrow(/refused: .*symlink.*hosts/);
  });

  it("refuses a fixture that holds a special file", () => {
    const s = setup();
    execFileSync("/usr/bin/mkfifo", [join(s.fixture, "vendor", "pipe")]);
    expect(() => prepareRustToolchain({ fixture: s.fixture })).toThrow(/refused: .*neither a file nor a folder/);
  });

  it("refuses a pinned fixture that lacks cargo, rustc, the Tauri CLI or the vendored crates", () => {
    for (const missing of [join("toolchain", "bin", "cargo"), join("toolchain", "bin", "rustc"), join("toolchain", "bin", "cargo-tauri"), join("cargo-home", "config.toml"), "vendor"]) {
      const s = setup();
      rmSync(join(s.fixture, missing), { recursive: true });
      pinRustFixture(s.fixture);
      expect(() => prepareRustToolchain({ fixture: s.fixture }), missing).toThrow(/refused: .*(lacks|not executable)/);
    }
    const s = setup();
    chmodSync(join(s.fixture, "toolchain", "bin", "cargo"), 0o644);
    pinRustFixture(s.fixture);
    expect(() => prepareRustToolchain({ fixture: s.fixture })).toThrow(/refused: .*not executable/);
  });

  it("refuses when the Command Line Tools are missing, not system-owned, or their SDK leads outside them", () => {
    const s = setup();
    rmSync(join(s.clt, "usr", "bin", "clang"));
    expect(() => prepareRustToolchain({ fixture: s.fixture })).toThrow(/refused: .*Command Line Tools/);
    makeCommandLineTools(join(s.root, "clt2"));
    useCommandLineTools(join(s.root, "clt2"));
    vi.spyOn(rustHost, "systemOwned").mockReturnValue(false);
    expect(() => prepareRustToolchain({ fixture: s.fixture })).toThrow(/refused: .*Command Line Tools.*owned/);
    const clt3 = join(s.root, "clt3");
    mkdirSync(join(clt3, "usr", "bin"), { recursive: true });
    writeFileSync(join(clt3, "usr", "bin", "clang"), "#!/bin/sh\n", { mode: 0o755 });
    mkdirSync(join(clt3, "SDKs"));
    symlinkSync(s.fixture, join(clt3, "SDKs", "MacOSX.sdk"));
    useCommandLineTools(clt3);
    expect(() => prepareRustToolchain({ fixture: s.fixture })).toThrow(/refused: .*SDK/);
  });

  it("refuses when the fixture overlaps the Command Line Tools folder", () => {
    const s = setup();
    useCommandLineTools(s.root);
    makeCommandLineTools(s.root);
    expect(() => prepareRustToolchain({ fixture: s.fixture })).toThrow(/refused: .*overlap/);
  });

  it("names this machine's Rust target, and none for a platform it doesn't build on", () => {
    expect(rustTarget("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(rustTarget("darwin", "x64")).toBe("x86_64-apple-darwin");
    expect(rustTarget("linux", "x64")).toBeUndefined();
  });
});

describe("a session can get Go and Rust together", () => {
  const go = { version: "go1.26.10", readOnlyDirs: ["/g/tc", "/g/mod"], pathPrefix: ["/g/tc/bin"], env: { GOTOOLCHAIN: "local", GOPROXY: "off" } };
  const rust = { version: "rust 1.99.1", readOnlyDirs: ["/r"], systemDirs: ["/clt"], pathPrefix: ["/r/toolchain/bin", "/clt/usr/bin"], env: { CARGO_HOME: "/r/cargo-home" } };

  it("merges folders, PATH entries and variables, and keeps either alone as it is", () => {
    expect(mergeSessionToolchains(undefined, undefined)).toBeUndefined();
    expect(mergeSessionToolchains(go, undefined)).toEqual(go);
    expect(mergeSessionToolchains(undefined, rust)).toEqual(rust);
    expect(mergeSessionToolchains(go, rust)).toEqual({
      version: "go1.26.10, rust 1.99.1",
      readOnlyDirs: ["/g/tc", "/g/mod", "/r"], systemDirs: ["/clt"],
      pathPrefix: ["/g/tc/bin", "/r/toolchain/bin", "/clt/usr/bin"],
      env: { GOTOOLCHAIN: "local", GOPROXY: "off", CARGO_HOME: "/r/cargo-home" },
    });
  });

  it("refuses two toolchains that set the same variable", () => {
    expect(() => mergeSessionToolchains(go, { ...rust, env: { GOPROXY: "on" } })).toThrow(/both set GOPROXY/);
  });
});
