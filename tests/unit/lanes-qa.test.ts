import { realpathSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionOutcome, SessionSpec } from "../../packages/cli/src/proc/session.ts";
import type { GateInput, GateResult } from "../../packages/cli/src/checks/gate.ts";
import { runMaestro, runPlaywright, type QaOptions } from "../../packages/cli/src/lanes/qa.ts";
import { runLaneChecks } from "../../packages/cli/src/lanes/gates.ts";
import { fakeToolchain } from "../fixtures/qa/toolchain.ts";
import { observeWeb, type BrowserRuntime } from "../../packages/cli/src/lanes/browser.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = () => { const r = mkdtempSync(join(tmpdir(), "jarvis-qa-")); roots.push(r); return r; };
const ok: SessionOutcome = { code: 0, timedOut: false, overflowed: false, durationMs: 1, stdout: "project tests claimed success", stderr: "" };
function setup() {
  const repo = root();
  const spawn = vi.fn<(spec: SessionSpec) => Promise<SessionOutcome>>().mockResolvedValue(ok);
  const approved = fakeToolchain(root());
  const opts: QaOptions = { ...approved, repo, nodeBin: process.execPath, env: { PATH: "/usr/bin:/bin", HOME: repo }, spawn };
  return { repo, spawn, opts };
}
function tool(repo: string, path: string) {
  const file = join(repo, "node_modules", path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "// Fake tool. Tests never execute it.\n");
  return file;
}

describe("QA commands use only discovered local tools and report honest coverage", () => {
  it("does not spawn or install when Playwright or a web target is absent", async () => {
    const { opts, spawn } = setup();
    expect((await runPlaywright({ ...opts, toolchain: undefined }, { url: "http://127.0.0.1:3000" })).status).toBe("not run");
    expect((await runPlaywright(opts)).status).toBe("not run");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("runs the project's own tests then the axe driver, with argv, clean env and a timeout", async () => {
    const { repo, opts, spawn } = setup();
    const cli = realpathSync(join(opts.toolchain!.root, "cli.cjs"));
    tool(repo, "axe-core/axe.min.js");
    const result = await runPlaywright(opts, { url: "http://127.0.0.1:3000/habits", testFiles: ["tests/habits.spec.ts"] });
    expect(result.status).toBe("observed");
    expect(result.verified).toBe(false);
    expect(result.checks.map(c => c.name)).toEqual(["playwright", "axe"]);
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({ bin: process.execPath, args: [cli, "test", "tests/habits.spec.ts", "--reporter=json"], cwd: repo, env: opts.env, timeoutMs: 120_000, maxOutputBytes: 16 * 1024 * 1024 });
    expect(spawn.mock.calls[1]?.[0].args).toEqual(expect.arrayContaining(["http://127.0.0.1:3000/habits"]));
    expect(JSON.stringify(spawn.mock.calls)).not.toContain("npx");
  });

  it("rejects a missing approved axe source before any process", async () => {
    const { repo, opts, spawn } = setup();
    tool(repo, "playwright/cli.js");
    rmSync(join(opts.toolchain!.root, "axe.js"));
    await expect(runPlaywright(opts, { url: "http://localhost:3000" })).rejects.toThrow(/lock|approved/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    { ...ok, code: 1 }, { ...ok, code: null }, { ...ok, timedOut: true }, { ...ok, overflowed: true },
  ])("does not accept failed, signalled, timed out or truncated runs: %j", async outcome => {
    const { repo, opts, spawn } = setup();
    tool(repo, "playwright/cli.js"); tool(repo, "axe-core/axe.min.js");
    spawn.mockResolvedValue(outcome);
    expect((await runPlaywright(opts, { url: "http://localhost:3000" })).status).toBe("fail");
  });

  it("keeps spawn errors explicit", async () => {
    const { repo, opts, spawn } = setup();
    tool(repo, "playwright/cli.js"); tool(repo, "axe-core/axe.min.js");
    spawn.mockRejectedValue(new Error("could not launch"));
    expect((await runPlaywright(opts, { url: "http://localhost:3000" })).status).toBe("error");
  });

  it("rejects external targets, option injection and inherited credentials before spawning", async () => {
    const { repo, opts, spawn } = setup();
    tool(repo, "playwright/cli.js");
    await expect(runPlaywright(opts, { url: "https://example.com" })).rejects.toThrow();
    await expect(runPlaywright(opts, { url: "http://user:pass@localhost:3000" })).rejects.toThrow();
    await expect(runPlaywright(opts, { url: "http://localhost:3000", testFiles: ["--config=evil"] })).rejects.toThrow();
    await expect(runPlaywright({ ...opts, env: { ...opts.env, NODE_OPTIONS: "--import=evil" } }, { url: "http://localhost:3000" })).rejects.toThrow();
    await expect(runPlaywright({ ...opts, env: { ...opts.env, API_KEY: "fake-not-a-credential" } }, { url: "http://localhost:3000" })).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("requires a built app, simulator, installed Maestro and flows for native evidence", async () => {
    const { opts, spawn } = setup();
    expect((await runMaestro(opts, undefined, true)).status).toBe("web-only");
    expect((await runMaestro(opts)).status).toBe("not run");
    expect((await runMaestro(opts, { simulatorId: "sim-1", appId: "test.app", builtApp: false, flows: ["flows/drafts.yaml"] })).status).toBe("not run");
    expect((await runMaestro(opts, { simulatorId: "sim-1", appId: "test.app", builtApp: true, flows: [] })).status).toBe("not run");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("uses the absolute doctor-supplied Maestro path and the selected iOS simulator", async () => {
    const { repo, opts, spawn } = setup();
    const maestroBin = join(repo, "maestro"); writeFileSync(maestroBin, "fake");
    const result = await runMaestro({ ...opts, maestroBin }, { simulatorId: "sim-1", appId: "test.app", builtApp: true, flows: ["flows/drafts.yaml"] });
    expect(result.status).toBe("observed");
    expect(result.verified).toBe(false);
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({ bin: maestroBin, args: ["--device", "sim-1", "test", "flows/drafts.yaml"], cwd: repo });
    await expect(runMaestro({ ...opts, maestroBin: "maestro" }, { simulatorId: "sim-1", appId: "test.app", builtApp: true, flows: ["flows/drafts.yaml"] })).rejects.toThrow();
  });

  it("reports absent Maestro on a built native target as not run, and does not let web-only hide a failure", async () => {
    const { repo, opts, spawn } = setup();
    const target = { simulatorId: "sim-1", appId: "test.app", builtApp: true, flows: ["flows/drafts.yaml"] };
    expect((await runMaestro(opts, target, true)).status).toBe("web-only");
    const maestroBin = join(repo, "maestro"); writeFileSync(maestroBin, "fake");
    spawn.mockResolvedValue({ ...ok, code: 1 });
    expect((await runMaestro({ ...opts, maestroBin }, target, true)).status).toBe("fail");
  });
});

describe("runner-owned browser observations", () => {
  it("reads the accessibility tree first, runs axe and captures three viewport sizes", async () => {
    const events: string[] = [];
    const page = {
      goto: vi.fn(async () => { events.push("goto"); }),
      locator: () => ({ ariaSnapshot: async () => { events.push("tree"); return "- button Record observation"; } }),
      url: () => "http://localhost:3000/",
      context: () => ({ newCDPSession: async () => ({
        send: async (method: string) => {
          if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
          if (method === "Page.createIsolatedWorld") { events.push("axe-world"); return { executionContextId: 1 }; }
          if (method === "Runtime.evaluate") { events.push("axe"); return { result: { value: { version: "4.10.3", violations: [{ id: "color-contrast", impact: "serious" }] } } }; }
          return {};
        }, detach: async () => {},
      }) }),
      screenshot: vi.fn(async () => { events.push("screenshot"); return Buffer.from("fake-image"); }),
      close: vi.fn(async () => {}),
    };
    const browser = { newPage: vi.fn(async () => page), close: vi.fn(async () => {}) };
    const runtime: BrowserRuntime = { launch: async () => browser, axeSource: "/* fake axe */" };
    const result = await observeWeb("http://localhost:3000", runtime);
    expect(events.slice(0, 5)).toEqual(["goto", "tree", "axe-world", "axe", "screenshot"]);
    expect(result.pages.map(p => p.width)).toEqual([375, 768, 1440]);
    expect(result.pages[0]).toMatchObject({ accessibilityTree: "- button Record observation", axe: { violations: [{ impact: "serious", id: "color-contrast" }] }, screenshot: Buffer.from("fake-image").toString("base64") });
    expect(browser.close).toHaveBeenCalledOnce();
    expect(page.close).toHaveBeenCalledTimes(3);
  });

  it("closes the browser on navigation errors and rejects a non-local target", async () => {
    const close = vi.fn(async () => {});
    const runtime = { launch: async () => ({ newPage: async () => { throw new Error("no target"); }, close }), axeSource: "fake" };
    await expect(observeWeb("http://localhost:3000", runtime)).rejects.toThrow("no target");
    expect(close).toHaveBeenCalledOnce();
    await expect(observeWeb("https://example.com", runtime)).rejects.toThrow();
  });
});

describe("protected lane checks reuse runGate", () => {
  it("never converts a missing protected definition to a pass", async () => {
    const gate = vi.fn<(input: GateInput) => Promise<GateResult>>();
    const result = await runLaneChecks({ selections: [{ lane: "QA", files: ["src/a.ts"], checks: ["protected-checks"] }], definitions: {}, input: {} as Omit<GateInput, "check"> }, gate);
    expect(result).toEqual([{ check: "protected-checks", status: "not run", reason: "no protected definition" }]);
    expect(gate).not.toHaveBeenCalled();
  });

  it("runs shared checks once and preserves the gate's tampered/fail statuses", async () => {
    const check = { name: "acceptance", cases: [{ id: "flow", command: "protected driver" }], verify: "protected verifier", timeoutMs: 1000 };
    const gate = vi.fn<(input: GateInput) => Promise<GateResult>>().mockResolvedValue({ status: "tampered" } as GateResult);
    const input = { revision: "abc" } as Omit<GateInput, "check">;
    const result = await runLaneChecks({ selections: [{ lane: "QA", files: ["src/a.ts"], checks: ["protected-checks", "protected-checks"] }], definitions: { "protected-checks": check }, input }, gate);
    expect(gate).toHaveBeenCalledExactlyOnceWith({ ...input, check });
    expect(result[0]?.status).toBe("tampered");
  });
});
