import { existsSync, realpathSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPlaywright } from "../../packages/cli/src/lanes/qa.ts";
import { observeWeb } from "../../packages/cli/src/lanes/browser.ts";
import { fakeToolchain } from "../fixtures/qa/toolchain.ts";

const roots: string[] = [];
const temp = () => { const p = mkdtempSync(join(tmpdir(), "qa-toolchain-")); roots.push(p); return p; };
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
function setup() {
  const repo = temp(); const approved = fakeToolchain(temp());
  const spawn = vi.fn().mockResolvedValue({ code: 0, timedOut: false, overflowed: false, stdout: "fake", stderr: "", durationMs: 1 });
  return { repo, approved, spawn, options: { repo, nodeBin: process.execPath, env: { PATH: "/usr/bin:/bin", HOME: repo }, spawn, ...approved } };
}

describe("review: runner-owned locked QA toolchain", () => {
  it("never loads a committed candidate Playwright or axe", async () => {
    const { repo, approved } = setup();
    const marker = join(repo, "candidate-loaded");
    for (const pkg of ["playwright", "axe-core"]) {
      mkdirSync(join(repo, "node_modules", pkg), { recursive: true });
      writeFileSync(join(repo, "node_modules", pkg, "index.js"), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded'); throw new Error('candidate loaded');`);
      writeFileSync(join(repo, "node_modules", pkg, "package.json"), '{"main":"index.js"}');
    }
    const { readQaToolchain, loadBrowserRuntime } = await import("../../packages/cli/src/lanes/toolchain.ts");
    const verified = readQaToolchain(approved.toolchain, repo);
    expect(() => loadBrowserRuntime(verified.manifestPath, verified.manifestHash, repo)).not.toThrow();
    const runtime = loadBrowserRuntime(verified.manifestPath, verified.manifestHash, repo);
    expect(await runtime.launch()).toMatchObject({ trusted: true });
    expect(existsSync(marker)).toBe(false);
    expect(runtime.axeSource).toContain("Fake axe");
  });

  it("launches the hash-locked browser executable rather than a candidate-writable HOME cache", async () => {
    const { repo, approved } = setup();
    const { readQaToolchain, loadBrowserRuntime } = await import("../../packages/cli/src/lanes/toolchain.ts");
    const verified = readQaToolchain(approved.toolchain, repo);
    const runtime = loadBrowserRuntime(verified.manifestPath, verified.manifestHash, repo);
    expect(await runtime.launch()).toMatchObject({ options: { executablePath: realpathSync(join(approved.toolchain.root, "chromium")), args: ["--single-process"] } });
  });

  it("uses only approved runner paths for both CLI and browser tools", async () => {
    const { repo, options, spawn, approved } = setup();
    const result = await runPlaywright(options, { url: "http://localhost:3000", testFiles: ["tests/card.spec.ts"] });
    expect(result.status).toBe("observed");
    expect(spawn.mock.calls[0]![0].args[0]).toBe(realpathSync(join(approved.toolchain.root, "cli.cjs")));
    expect(spawn.mock.calls[1]![0].args).toEqual(expect.arrayContaining([realpathSync(join(approved.toolchain.root, "manifest.json"))]));
    expect(JSON.stringify(spawn.mock.calls)).not.toContain(join(repo, "node_modules"));
  });

  it("does not fall back to candidate tools when no toolchain is approved", async () => {
    const { repo, options, spawn } = setup();
    mkdirSync(join(repo, "node_modules", "playwright"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "playwright", "cli.js"), "fake");
    expect((await runPlaywright({ ...options, toolchain: undefined }, { url: "http://localhost:3000" })).status).toBe("not run");
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["cli.cjs", "axe.js", "manifest.json", "playwright-package.json"])("rejects tampered %s before spawn", async file => {
    const { options, approved, spawn } = setup();
    writeFileSync(join(approved.toolchain.root, file), "tampered");
    await expect(runPlaywright(options, { url: "http://localhost:3000" })).rejects.toThrow(/lock|approved|changed|tamper/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a toolchain inside the candidate, symlinked files, and mismatched package pins", async () => {
    const { repo, approved } = setup();
    const { readQaToolchain } = await import("../../packages/cli/src/lanes/toolchain.ts");
    expect(() => readQaToolchain(approved.toolchain, approved.toolchain.root)).toThrow();
    rmSync(realpathSync(join(approved.toolchain.root, "cli.cjs")));
    symlinkSync(join(repo, "candidate.cjs"), join(approved.toolchain.root, "cli.cjs"));
    expect(() => readQaToolchain(approved.toolchain, repo)).toThrow();
    const other = fakeToolchain(temp());
    const manifest = { ...other.manifest, axe: { ...other.manifest.axe, version: "9.9.9" } };
    writeFileSync(join(other.toolchain.root, "manifest.json"), JSON.stringify(manifest));
    other.toolchain.store.approve(other.toolchain.ledger, "intentional bad pin fixture");
    expect(() => readQaToolchain(other.toolchain, repo)).toThrow(/version|pin/i);
  });

  it("driver verifies the approved manifest digest and all tool file hashes", async () => {
    const { repo, approved } = setup();
    const { loadBrowserRuntime } = await import("../../packages/cli/src/lanes/toolchain.ts");
    const path = join(approved.toolchain.root, "manifest.json");
    const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
    expect(() => loadBrowserRuntime(path, hash, approved.toolchain.root)).toThrow();
    expect(() => loadBrowserRuntime(path, "0".repeat(64), repo)).toThrow();
    writeFileSync(join(approved.toolchain.root, "axe.js"), "fake altered source");
    expect(() => loadBrowserRuntime(path, hash, repo)).toThrow();
  });

  it("cannot rehash altered tools and their manifest without a new checks approval", async () => {
    const { options, approved, spawn } = setup();
    const content = "// attacker replacement CLI\n";
    writeFileSync(join(approved.toolchain.root, "cli.cjs"), content);
    const manifest = { ...approved.manifest, files: { ...approved.manifest.files, "cli.cjs": createHash("sha256").update(content).digest("hex") } };
    writeFileSync(join(approved.toolchain.root, "manifest.json"), JSON.stringify(manifest));
    await expect(runPlaywright(options, { url: "http://localhost:3000" })).rejects.toThrow(/lock|approved/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a browser driver from the checkout", async () => {
    const { repo, options, spawn } = setup();
    const driver = join(repo, "driver.ts"); writeFileSync(driver, "fake");
    await expect(runPlaywright({ ...options, browserDriver: driver }, { url: "http://localhost:3000" })).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("review: axe runs in an isolated world", () => {
  it("never evaluates axe in the page world and records the final URL", async () => {
    let finalUrl = "http://localhost:3000/";
    const send = vi.fn(async (method: string) => method === "Page.getFrameTree" ? { frameTree: { frame: { id: "frame-1", url: "http://localhost:3000/", loaderId: "loader" } } } : method === "Page.createIsolatedWorld" ? { executionContextId: 7 } : method === "Runtime.evaluate" ? { result: { value: { version: "4.10.3", violations: [], incomplete: [] } } } : method === "Target.getTargets" ? { targetInfos: [] } : {});
    const detach = vi.fn(async () => {});
    const page = {
      frames: () => [{ url: () => "http://localhost:3000/", parentFrame: () => null, frameElement: async () => ({ getAttribute: async () => null }) }],
      goto: async () => { finalUrl = "http://localhost:3000/"; }, url: () => finalUrl,
      locator: () => ({ ariaSnapshot: async () => "tree" }),
      context: () => ({ newCDPSession: async () => ({ send, detach }) }),
      evaluate: vi.fn(() => { throw new Error("unsafe main world"); }),
      addScriptTag: vi.fn(() => { throw new Error("unsafe injection"); }),
      screenshot: async () => { finalUrl = "http://localhost:3000/login"; return Buffer.from("fake"); }, close: async () => {},
    };
    const raw = await observeWeb("http://localhost:3000", { launch: async () => ({ newPage: async () => page, close: async () => {} }), axeSource: "/* fake trusted axe */" });
    expect(send).toHaveBeenCalledWith("Page.createIsolatedWorld", expect.objectContaining({ frameId: "frame-1", worldName: "jarvis-axe" }));
    expect(send).toHaveBeenCalledWith("Runtime.evaluate", expect.objectContaining({ contextId: 7, awaitPromise: true, returnByValue: true }));
    expect(page.evaluate).not.toHaveBeenCalled(); expect(page.addScriptTag).not.toHaveBeenCalled();
    expect(raw.pages[0]?.url).toBe("http://localhost:3000/login");
    expect(detach).toHaveBeenCalledTimes(3);
  });
});

describe("review: one Chromium per viewport (--single-process survives a single page)", () => {
  // Measured on the pinned headless shell (Oct 26): with --single-process the second browser.newPage() dies with
  // SIGTRAP, whether or not the first page was closed. loadBrowserRuntime always passes the flag, so observeWeb
  // must never ask one browser for a second page.
  function singlePageBrowsers(failOn?: number) {
    const events: string[] = []; const widths: number[] = []; let launches = 0;
    const send = async (method: string) => method === "Page.getFrameTree" ? { frameTree: { frame: { id: "frame-1", url: "http://localhost:3000/", loaderId: "loader" } } } : method === "Page.createIsolatedWorld" ? { executionContextId: 7 } : method === "Runtime.evaluate" ? { result: { value: { version: "4.10.3", violations: [], incomplete: [] } } } : method === "Target.getTargets" ? { targetInfos: [] } : {};
    const page = {
      frames: () => [{ url: () => "http://localhost:3000/", parentFrame: () => null, frameElement: async () => ({ getAttribute: async () => null }) }],
      goto: async () => {}, url: () => "http://localhost:3000/", locator: () => ({ ariaSnapshot: async () => "tree" }),
      context: () => ({ newCDPSession: async () => ({ send, detach: async () => {} }) }),
      screenshot: async () => Buffer.from("fake"), close: async () => { events.push("page closed"); },
    };
    const launch = async () => {
      const id = ++launches; let pages = 0; events.push(`launch ${id}`);
      return {
        newPage: async (options: { viewport: { width: number } }) => {
          if (id === failOn) throw new Error("viewport failed");
          if (++pages > 1) throw new Error("Target page, context or browser has been closed");
          widths.push(options.viewport.width); return page;
        },
        close: async () => { events.push(`browser ${id} closed`); },
      };
    };
    return { events, widths, runtime: { launch, axeSource: "/* fake trusted axe */" } };
  }

  it("launches a fresh browser for each of the three viewports and closes every one", async () => {
    const fake = singlePageBrowsers();
    const raw = await observeWeb("http://localhost:3000", fake.runtime);
    expect(raw.pages.map(p => p.width)).toEqual([375, 768, 1440]);
    expect(fake.widths).toEqual([375, 768, 1440]);
    expect(fake.events).toEqual(["launch 1", "page closed", "browser 1 closed", "launch 2", "page closed", "browser 2 closed", "launch 3", "page closed", "browser 3 closed"]);
  });

  it("closes the browser of a viewport that fails, and launches no more", async () => {
    const fake = singlePageBrowsers(2);
    await expect(observeWeb("http://localhost:3000", fake.runtime)).rejects.toThrow("viewport failed");
    expect(fake.events).toEqual(["launch 1", "page closed", "browser 1 closed", "launch 2", "browser 2 closed"]);
  });
});
