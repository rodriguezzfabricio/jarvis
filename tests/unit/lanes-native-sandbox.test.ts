import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchSandboxedDesktop, nativeSeatbeltProfile, NativeSandboxUnavailable } from "../../packages/cli/src/lanes/desktop-sandbox.ts";
import type { NativeSandboxDeps } from "../../packages/cli/src/lanes/desktop-sandbox.ts";
import type { SessionOutcome, SessionSpec } from "../../packages/cli/src/proc/session.ts";
import { probeDesktop } from "../../packages/cli/src/lanes/desktop-observe.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const outcome = (changes: Partial<SessionOutcome> = {}): SessionOutcome => ({ code: 0, timedOut: false, overflowed: false, durationMs: 1, stdout: "", stderr: "", ...changes });
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "native-sandbox-"))); roots.push(root);
  const home = join(root, "runner"), workRoot = join(home, "work"), bundle = join(workRoot, "Test.app");
  mkdirSync(join(bundle, "Contents/MacOS"), { recursive: true }); mkdirSync(join(home, ".jarvis"));
  writeFileSync(join(bundle, "Contents/Info.plist"), "fake plist"); writeFileSync(join(bundle, "Contents/MacOS/Test"), "fake binary", { mode: 0o700 });
  const calls: SessionSpec[] = [];
  const session = vi.fn(async (spec: SessionSpec) => {
    calls.push(spec);
    if (spec.args[2] === "/usr/bin/plutil") return outcome({ stdout: "Test\n" });
    const path = spec.args.at(-1)!;
    return path.endsWith("denied-canary") ? outcome({ code: 1, stderr: "Operation not permitted" }) : outcome({ stdout: readFileSync(path, "utf8") });
  });
  const child = { pid: 4321, alive: () => true, waitForExit: vi.fn(async () => ({ code: 0, signal: null })), stop: vi.fn(async () => {}) };
  const launch = vi.fn(async (_spec: SessionSpec) => child);
  const isolateInput = vi.fn((spec: SessionSpec) => spec);
  const deps: NativeSandboxDeps = { session, launch, platform: "darwin", exists: () => true, isolateInput };
  return { root, home, workRoot, bundle, session, launch, child, calls, deps, options: { home, workRoot } };
}
const policy = { bundle: "/Users/test/work/Test.app", scratch: "/Users/test/work/native-private-123", home: "/Users/test", hostTmp: "/custom-temp" };
describe("native Seatbelt policy", () => {
  it("closes reads, writes and network; opens only the bundle and private home/temp", () => {
    const text = nativeSeatbeltProfile(policy);
    expect(text).toContain("(deny default)"); expect(text).toContain("(deny network*)");
    expect(text).toContain('(allow file-read* file-map-executable (subpath "/Users/test/work/Test.app"))');
    expect(text).toContain('(allow file-read* file-write* (subpath "/Users/test/work/native-private-123/home") (subpath "/Users/test/work/native-private-123/tmp"))');
    expect(text).not.toContain('(allow file-read* (subpath "/Users/test")');
    for (const path of ["/Users/test", "/private/tmp", "/tmp", "/private/var/tmp", "/var/tmp", "/private/var/folders", "/var/folders", "/custom-temp"]) {
      expect(text).toContain(`(require-all (subpath "${path}") (require-not`);
    }
    expect(text).toContain('(deny file-read* file-write* file-map-executable (subpath "/Users/test/.jarvis"))');
    expect(text).not.toMatch(/\(allow network|\(allow mach-lookup\)|launchservices|appleevent|cfprefsd|securityd/);
    expect(text).not.toContain('(subpath "/")');
    expect(text).toContain('(allow signal (target same-sandbox))');
    expect(text).not.toContain('(allow file-write* (subpath "/Users/test/work/Test.app"))');
  });
  it("opens the root folder itself, never below it: dyld reads it, and without it every binary aborts (live test)", () => {
    const text = nativeSeatbeltProfile(policy);
    expect(text).toMatch(/^\(allow file-read\* [^\n]*\(literal "\/"\)/m);
    expect(text).not.toMatch(/\(subpath "\/"\)|\(allow file-write\*[^\n]*\(literal "\/"\)/);
  });
  it.each(["relative.app", '/bad"path.app', "/bad\\path.app", "/bad\npath.app", "/bad\u007fpath.app", "/bad/../path.app"])("rejects unsafe profile path %j", bundle => {
    expect(() => nativeSeatbeltProfile({ ...policy, bundle })).toThrow(NativeSandboxUnavailable);
  });
  it.each([
    { bundle: "/Users/test" }, { bundle: "/Users/test/.jarvis/Test.app" },
    { scratch: "/Users/test/.jarvis/private" }, { scratch: "/Users/test/work/Test.app/private" },
    { scratch: "/Users/test/work" }, { bundle: "/" }, { scratch: "/tmp" },
  ])("rejects broad, overlapping or runner-private grants %j", changes => {
    expect(() => nativeSeatbeltProfile({ ...policy, ...changes })).toThrow(NativeSandboxUnavailable);
  });
});
describe("sandboxed native launcher", () => {
  it("proves both canaries before launching directly via sandbox-exec and preserves the app PID", async () => {
    const s = setup(); const launched = launchSandboxedDesktop(s.bundle, s.options, s.deps);
    await expect(launched).resolves.toMatchObject({ pid: 4321 }); const app = await launched;
    expect(s.calls).toHaveLength(3); expect(s.launch).toHaveBeenCalledOnce();
    const spec = s.launch.mock.calls[0]![0], profile = spec.args[1]!;
    expect(spec.bin).toBe("/usr/bin/sandbox-exec"); expect(spec.args).toEqual(["-f", profile, join(s.bundle, "Contents/MacOS/Test")]);
    expect(s.calls.every(call => call.bin === spec.bin && call.args[1] === profile)).toBe(true);
    expect(s.calls[0]!.args.at(-1)).toMatch(/denied-canary$/); expect(s.calls[1]!.args.at(-1)).toMatch(/allowed-canary$/);
    expect(spec.cwd).toBe(s.bundle); expect(spec.env).toEqual({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: join(dirname(profile), "home"), TMPDIR: join(dirname(profile), "tmp"), LANG: "en_US.UTF-8" });
    expect(readFileSync(profile, "utf8")).toBe(nativeSeatbeltProfile({ bundle: s.bundle, scratch: dirname(profile), home: s.home }));
    expect(app.pid).toBe(4321); expect(app.alive()).toBe(true); await app.waitForExit(100); expect(s.child.waitForExit).toHaveBeenCalledWith(100);
    await app.stop(); expect(s.child.stop).toHaveBeenCalledOnce(); expect(existsSync(dirname(profile))).toBe(false);
  });
  it.each(["linux", "win32"] as const)("refuses %s without launching", async platform => {
    const s = setup(); await expect(launchSandboxedDesktop(s.bundle, s.options, { ...s.deps, platform })).rejects.toThrow(NativeSandboxUnavailable); expect(s.session).not.toHaveBeenCalled(); expect(s.launch).not.toHaveBeenCalled();
  });
  it("refuses without input isolation: under the runner's responsibility the app's synthetic keystrokes reach the session", async () => {
    const s = setup(); const { isolateInput: _none, ...deps } = s.deps;
    await expect(launchSandboxedDesktop(s.bundle, s.options, deps)).rejects.toThrow(/input isolation/);
    expect(s.session).not.toHaveBeenCalled(); expect(s.launch).not.toHaveBeenCalled();
    expect(readdirSync(s.workRoot).filter(name => name.startsWith("native-private-"))).toEqual([]);
  });
  it("runs every sandboxed command through input isolation, the app included", async () => {
    const s = setup(); const ISOLATE = "/fake/isolate";
    const isolateInput = vi.fn((spec: SessionSpec): SessionSpec => ({ ...spec, bin: ISOLATE, args: [spec.bin, ...spec.args] }));
    const session = vi.fn(async (spec: SessionSpec) => {
      const inner = { ...spec, bin: spec.args[0]!, args: spec.args.slice(1) };
      return s.session(inner);
    });
    const app = await launchSandboxedDesktop(s.bundle, s.options, { ...s.deps, session, isolateInput });
    expect(isolateInput).toHaveBeenCalledTimes(4);
    expect(session.mock.calls.every(([spec]) => spec.bin === ISOLATE && spec.args[0] === "/usr/bin/sandbox-exec")).toBe(true);
    const launched = s.launch.mock.calls[0]![0];
    expect(launched.bin).toBe(ISOLATE); expect(launched.args).toEqual(["/usr/bin/sandbox-exec", "-f", s.calls[0]!.args[1], join(s.bundle, "Contents/MacOS/Test")]);
    await app.stop();
  });
  it("treats an input isolation failure as unavailable confinement and leaves nothing behind", async () => {
    const s = setup(); const isolateInput = () => { throw new Error("responsibility not disclaimed"); };
    await expect(launchSandboxedDesktop(s.bundle, s.options, { ...s.deps, isolateInput })).rejects.toThrow(NativeSandboxUnavailable);
    expect(s.launch).not.toHaveBeenCalled(); expect(readdirSync(s.workRoot).filter(name => name.startsWith("native-private-"))).toEqual([]);
  });
  it("refuses missing sandbox-exec", async () => {
    const s = setup(); await expect(launchSandboxedDesktop(s.bundle, s.options, { ...s.deps, exists: () => false })).rejects.toThrow(/sandbox-exec/); expect(s.session).not.toHaveBeenCalled();
  });
  it.each([
    ["readable denied file", 0, { code: 0 }], ["leaked token despite failure", 0, { leak: true }], ["partial denied read", 0, { stdout: "partial" }],
    ["negative timeout", 0, { timedOut: true }], ["negative overflow", 0, { overflowed: true }], ["negative signal", 0, { code: null }],
    ["unapplied profile", 1, { code: 71 }], ["wrong positive output", 1, { stdout: "wrong" }],
    ["positive timeout", 1, { timedOut: true }], ["positive overflow", 1, { overflowed: true }],
    ["plutil failed", 2, { code: 1 }], ["plutil overflow", 2, { overflowed: true }], ["plutil timeout", 2, { timedOut: true }],
  ] as const)("fails closed for %s and removes private files", async (_name, at, changes) => {
    const s = setup(); let count = 0;
    const session = async (spec: SessionSpec) => { const result = await s.session(spec); if (count++ !== at) return result; return { ...result, ...changes, ...("leak" in changes ? { stdout: readFileSync(spec.args.at(-1)!, "utf8") } : {}) }; };
    await expect(launchSandboxedDesktop(s.bundle, s.options, { ...s.deps, session })).rejects.toThrow(NativeSandboxUnavailable);
    expect(s.launch).not.toHaveBeenCalled(); expect(existsSync(dirname(s.calls[0]!.args[1]!))).toBe(false);
  });
  it.each(["../outside", "/bin/sh", "Test\nOther", "", "missing"])("refuses executable %j from candidate plist", async name => {
    const s = setup(); writeFileSync(join(s.bundle, "Contents/outside"), "fake", { mode: 0o700 });
    const session = async (spec: SessionSpec) => spec.args[2] === "/usr/bin/plutil" ? outcome({ stdout: name }) : s.session(spec);
    await expect(launchSandboxedDesktop(s.bundle, s.options, { ...s.deps, session })).rejects.toThrow(NativeSandboxUnavailable); expect(s.launch).not.toHaveBeenCalled();
  });
  it.each(["outside", "bundle symlink", "symlink", "hardlink", "not executable", "missing plist"])("refuses unsafe bundle: %s", async kind => {
    const s = setup(); let bundle = s.bundle;
    if (kind === "outside") { bundle = join(s.home, "Outside.app"); renameSync(s.bundle, bundle); }
    if (kind === "bundle symlink") { bundle = join(s.workRoot, "Alias.app"); symlinkSync(s.bundle, bundle); }
    if (kind === "symlink") symlinkSync(s.home, join(s.bundle, "escape"));
    if (kind === "hardlink") { writeFileSync(join(s.home, "canary"), "fake"); linkSync(join(s.home, "canary"), join(s.bundle, "alias")); }
    if (kind === "not executable") { rmSync(join(s.bundle, "Contents/MacOS/Test")); writeFileSync(join(s.bundle, "Contents/MacOS/Test"), "no exec", { mode: 0o600 }); }
    if (kind === "missing plist") rmSync(join(s.bundle, "Contents/Info.plist"));
    await expect(launchSandboxedDesktop(bundle, s.options, s.deps)).rejects.toThrow(NativeSandboxUnavailable); expect(s.launch).not.toHaveBeenCalled();
  });
  it("refuses a symlinked runner .jarvis destination even outside HOME", async () => {
    const s = setup(); const workRoot = join(s.root, "external-work"); renameSync(s.workRoot, workRoot);
    rmSync(join(s.home, ".jarvis"), { recursive: true }); symlinkSync(workRoot, join(s.home, ".jarvis"));
    await expect(launchSandboxedDesktop(join(workRoot, "Test.app"), { home: s.home, workRoot }, s.deps)).rejects.toThrow(NativeSandboxUnavailable); expect(s.launch).not.toHaveBeenCalled();
  });
  it("cleans up on spawn failure but keeps confinement files when group cleanup fails", async () => {
    const s = setup(); s.launch.mockRejectedValueOnce(new Error("spawn unavailable"));
    await expect(launchSandboxedDesktop(s.bundle, s.options, s.deps)).rejects.toThrow(NativeSandboxUnavailable); expect(existsSync(dirname(s.calls[0]!.args[1]!))).toBe(false);
    const app = await launchSandboxedDesktop(s.bundle, s.options, s.deps); const profile = s.launch.mock.calls.at(-1)![0].args[1]!;
    s.child.stop.mockRejectedValueOnce(new Error("group survived")); await expect(app.stop()).rejects.toThrow("group survived"); expect(existsSync(profile)).toBe(true);
    await app.stop(); expect(existsSync(profile)).toBe(false);
  });
  it("passes its own PID through the fixed probes, and releases resources", async () => {
    const s = setup(); let time = 0;
    const spawn = vi.fn(async (_spec: SessionSpec) => outcome({ stdout: "true" }));
    const observed = await probeDesktop(s.bundle, { outputRoot: s.workRoot, stayUpMs: 10, shutdownMs: 10 }, { launch: b => launchSandboxedDesktop(b, s.options, s.deps), now: () => time, sleep: async ms => { time += ms; }, spawn });
    expect(observed.status).toBe("observed"); expect(spawn.mock.calls).toHaveLength(2);
    expect(spawn.mock.calls.every(([spec]) => spec.args.at(-1) === "4321")).toBe(true);
    expect(s.child.stop).toHaveBeenCalledOnce();
  });
  it("propagates confinement unavailability instead of turning it into a native failure", async () => {
    const s = setup(); const spawn = vi.fn();
    await expect(probeDesktop(s.bundle, { outputRoot: s.workRoot, stayUpMs: 10, shutdownMs: 10 }, { launch: async () => { throw new NativeSandboxUnavailable("nested profile"); }, spawn })).rejects.toThrow(NativeSandboxUnavailable); expect(spawn).not.toHaveBeenCalled();
  });
});
