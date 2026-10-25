import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeWeb } from "../../packages/cli/src/lanes/browser.ts";
import { verifyWebObservation } from "../../packages/cli/src/lanes/verify.ts";
import * as toolchain from "../../packages/cli/src/lanes/toolchain.ts";
import * as desktop from "../../packages/cli/src/lanes/desktop-observe.ts";
import type { SessionSpec } from "../../packages/cli/src/proc/session.ts";
import { fakeToolchain } from "../fixtures/qa/toolchain.ts";

const roots: string[] = [];
const temp = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "qa-followup-"))); roots.push(dir); return dir; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const ok = { code: 0, timedOut: false, overflowed: false, durationMs: 1, stdout: "", stderr: "" };
const axe = { version: "4.10.3", violations: [], incomplete: [] };
function browser(change = "") {
  const url = "http://127.0.0.1:3000/"; const childUrl = "http://localhost:3000/embed"; let reads = 0;
  const mainFrame = { url: () => url, parentFrame: () => null, frameElement: async () => ({ getAttribute: async () => null }) };
  const childFrame = { url: () => change === "blank" ? "about:blank" : change === "url" && reads > 1 ? childUrl + "/new" : childUrl, parentFrame: () => mainFrame, frameElement: async () => ({ getAttribute: async () => childUrl }) };
  const main = vi.fn(async (method: string): Promise<unknown> => method === "Page.getFrameTree" ? { frameTree: { frame: { id: "main", url, loaderId: "main-loader" } } } : method === "Target.getTargets" ? { targetInfos: change === "missing" ? [] : [{ type: "iframe", targetId: "oop", url: childUrl }] } : method === "Page.createIsolatedWorld" ? { executionContextId: 1 } : method === "Runtime.evaluate" ? { result: { value: axe } } : {});
  const child = vi.fn(async (method: string): Promise<unknown> => {
    if (method === "Page.getFrameTree") {
      reads++;
      return { frameTree: { frame: { id: change === "missing" ? "main" : "oop", parentId: "main", url: change === "blank" ? "about:blank" : change === "url" && reads > 1 ? childUrl + "/new" : childUrl, loaderId: change === "loader" && reads > 1 ? "new-loader" : "child-loader" } } };
    }
    if (method === "Page.createIsolatedWorld") return { executionContextId: 9 };
    if (method === "Runtime.evaluate") return { result: { value: { ...axe, violations: [{ id: "image-alt", impact: "serious" }] } } };
    return {};
  });
  const attach = vi.fn(async (target: unknown) => ({ send: target === childFrame ? child : main, detach: async () => {} }));
  const page = { frames: () => change === "unlisted" ? [mainFrame] : [mainFrame, childFrame], goto: async () => {}, url: () => url, locator: () => ({ ariaSnapshot: async () => "tree" }), context: () => ({ newCDPSession: attach }), screenshot: async () => Buffer.from("image"), close: async () => {} };
  return { url, child, childFrame, attach, runtime: { launch: async () => ({ newPage: async () => page, close: async () => {} }), axeSource: "/* trusted axe */" } };
}
function bundle() {
  const sourceBundle = join(temp(), "Chromium.app"); mkdirSync(join(sourceBundle, "Frameworks/Versions/A"), { recursive: true }); mkdirSync(join(sourceBundle, "Contents/MacOS"), { recursive: true });
  writeFileSync(join(sourceBundle, "Contents/MacOS/Chromium"), "fake browser"); writeFileSync(join(sourceBundle, "Frameworks/Versions/A/lib"), "fake library"); symlinkSync("A", join(sourceBundle, "Frameworks/Versions/Current"));
  const approved = fakeToolchain(temp()); const manifestPath = join(approved.toolchain.root, "manifest.json");
  return { sourceBundle, approved, manifestPath, input: { sourceBundle, destination: join(approved.toolchain.root, "Chromium.app"), executable: "Contents/MacOS/Chromium", manifestPath } };
}

describe("review: OOPIF and document identity", () => {
  it("attaches to an iframe target omitted from the main frame tree and rejects its axe violation", async () => {
    const fake = browser(); const pending = observeWeb(fake.url, fake.runtime);
    await expect(pending).resolves.toMatchObject({ kind: "qa-browser" }); const raw = await pending;
    expect(fake.attach).toHaveBeenCalledWith(fake.childFrame);
    expect(fake.child).toHaveBeenCalledWith("Runtime.evaluate", expect.objectContaining({ contextId: 9 }));
    expect(raw.pages[0]).toMatchObject({ frameCount: 2, frames: [{ id: "main" }, { id: "oop", url: "http://localhost:3000/embed", loaderId: "child-loader" }] });
    expect(verifyWebObservation(raw, { url: fake.url, axeVersion: axe.version }).ok).toBe(false);
  });
  it.each(["missing", "unlisted"])("fails divergent Playwright, CDP and iframe target sets: %s", async mode => {
    const fake = browser(mode); await expect(observeWeb(fake.url, fake.runtime)).rejects.toThrow(/frame|target/);
  });
  it.each(["url", "loader", "blank"])("fails navigation or a src frame still blank: %s", async mode => {
    const fake = browser(mode); await expect(observeWeb(fake.url, fake.runtime)).rejects.toThrow(/frame|document|blank/);
  });
});
describe("review: Chromium materialization", () => {
  it("dereferences internal framework aliases, hashes all resulting files, and smoke launches before approval", async () => {
    const fixture = bundle(); const spawn = vi.fn(async (_spec: SessionSpec) => ok);
    expect(toolchain.installChromiumBundle).toBeTypeOf("function");
    await expect(toolchain.installChromiumBundle(fixture.input, { spawn })).resolves.toHaveProperty("chromiumExecutable");
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({ bin: join(fixture.input.destination, fixture.input.executable), args: expect.arrayContaining(["--headless=new", "about:blank"]) });
    const walk = (dir: string) => { for (const name of readdirSync(dir)) { const path = join(dir, name); expect(lstatSync(path).isSymbolicLink()).toBe(false); if (lstatSync(path).isDirectory()) walk(path); } }; walk(fixture.input.destination);
    const manifest = JSON.parse(readFileSync(fixture.manifestPath, "utf8"));
    expect(manifest.chromium.files["Frameworks/Versions/Current/lib"]).toBe(hash(join(fixture.input.destination, "Frameworks/Versions/Current/lib")));
    fixture.approved.toolchain.store.approve(fixture.approved.toolchain.ledger, "materialized browser reviewed");
    expect(toolchain.readQaToolchain(fixture.approved.toolchain, temp()).chromiumExecutable).toBe(join(fixture.input.destination, fixture.input.executable));
  });
  it.each(["escape", "cycle", "missing"])("refuses a source bundle with %s links and leaves the manifest untouched", async mode => {
    const fixture = bundle(); const before = readFileSync(fixture.manifestPath, "utf8");
    symlinkSync(mode === "escape" ? temp() : mode === "cycle" ? "." : "not-present", join(fixture.sourceBundle, "bad")); const spawn = vi.fn(async (_spec: SessionSpec) => ok);
    expect(toolchain.installChromiumBundle).toBeTypeOf("function");
    await expect(toolchain.installChromiumBundle(fixture.input, { spawn })).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled(); expect(readFileSync(fixture.manifestPath, "utf8")).toBe(before); expect(existsSync(fixture.input.destination)).toBe(false);
  });
  it("does not record a browser that fails its launch, and installed toolchains reject every symlink", async () => {
    const fixture = bundle(); const before = readFileSync(fixture.manifestPath, "utf8");
    expect(toolchain.installChromiumBundle).toBeTypeOf("function");
    await expect(toolchain.installChromiumBundle(fixture.input, { spawn: async () => ({ ...ok, code: 1 }) })).rejects.toThrow(/launch/);
    expect(readFileSync(fixture.manifestPath, "utf8")).toBe(before); expect(existsSync(fixture.input.destination)).toBe(false);
    symlinkSync("chromium", join(fixture.approved.toolchain.root, "alias"));
    expect(() => toolchain.verifyQaToolchain(fixture.manifestPath, hash(fixture.manifestPath), temp())).toThrow(/symlink/);
  });
});
describe("review: sandbox build and native probe separation", () => {
  const plan = { nodeBin: process.execPath, tauriBin: "/tools/tauri", build: { bin: "/tools/npm", args: ["run", "tauri:build"] }, bundle: "target/Matches.app", stayUpMs: 100, shutdownMs: 100, buildTimeoutMs: 1000 };
  it("runs only the offline build inside the case sandbox and explicitly reports download requirements", async () => {
    const spawn = vi.fn(async (_spec: SessionSpec) => ({ ...ok, code: 1, stderr: "failed to download crate: attempting to make an HTTP request, but --offline was specified" }));
    expect(desktop.observeDesktopBuild).toBeTypeOf("function");
    const raw = await desktop.observeDesktopBuild(temp(), plan, {}, { spawn, exists: () => true });
    expect(raw).toMatchObject({ kind: "qa-desktop-build", status: "not run", reason: "not run: desktop build needs network" });
    expect(spawn).toHaveBeenCalledOnce(); expect(spawn.mock.calls[0]?.[0]).toMatchObject({ bin: plan.build.bin, env: { CARGO_NET_OFFLINE: "true", npm_config_offline: "true" } });
  });
  it.each([
    "error: no matching package named tauri found; location searched: crates.io index; using offline mode (--offline)",
    "Request to registry has been blocked because of your configuration settings: enableNetwork is false",
  ])("reports unavailable offline build dependencies: %s", async stderr => {
    expect(await desktop.observeDesktopBuild(temp(), plan, {}, { exists: () => true, spawn: async () => ({ ...ok, code: 1, stderr }) })).toMatchObject({ status: "not run", reason: "not run: desktop build needs network" });
  });
  it("accepts only a bundle path inside runner build output; fixed probes receive only a numeric PID", async () => {
    const root = temp(); const app = join(root, 'app; malicious " text.app'); mkdirSync(app);
    const launch = vi.fn(async (_bundle: string) => ({ pid: 123, alive: () => true, waitForExit: async () => ({ code: 0, signal: null }), stop: vi.fn(async () => {}) }));
    const spawn = vi.fn(async (_spec: SessionSpec) => ({ ...ok, stdout: "true\n" })); let now = 0;
    expect(desktop.probeDesktop).toBeTypeOf("function");
    const raw = await desktop.probeDesktop(app, { outputRoot: root, stayUpMs: 100, shutdownMs: 100 }, { launch, spawn, now: () => now, sleep: async ms => { now += ms; } });
    expect(raw.status).toBe("observed"); expect(launch).toHaveBeenCalledExactlyOnceWith(app);
    for (const [spec] of spawn.mock.calls) { expect(spec.bin).toBe("/usr/bin/osascript"); expect(spec.args.at(-1)).toBe("123"); expect(spec.args.join(" ")).not.toContain("malicious"); }
    const outside = join(temp(), "outside.app"); mkdirSync(outside);
    await expect(desktop.probeDesktop(outside, { outputRoot: root, stayUpMs: 100, shutdownMs: 100 }, { launch, spawn })).rejects.toThrow(/output|bundle/);
    await expect(desktop.probeDesktop({ bundle: app, script: "malicious" } as unknown as string, { outputRoot: root, stayUpMs: 100, shutdownMs: 100 }, { launch, spawn })).rejects.toThrow(/bundle/);
    expect(launch).toHaveBeenCalledOnce();
  });
});
