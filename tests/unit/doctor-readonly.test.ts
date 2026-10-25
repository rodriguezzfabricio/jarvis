import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { foundationChecks } from "../../packages/cli/src/doctor/foundation.ts";
import { toolDoctorChecks } from "../../packages/cli/src/doctor/tools.ts";
import { fakeToolchain } from "../fixtures/qa/toolchain.ts";
vi.mock("../../packages/cli/src/sandbox/srt.ts", () => ({ runSandboxed: vi.fn(async () => ({ code: 0, timedOut: false, overflowed: false, durationMs: 1, stdout: "done", stderr: "" })) }));
const roots: string[] = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), "doctor-readonly-")); roots.push(root); return root; };
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
describe("doctor never writes or reclaims a ledger lock", () => {
  it("discovers and verifies toolchains without Ledger.open or Ledger.entries", async () => {
    const home = temp(); const project = join(home, "projects/one"); fakeToolchain(project);
    const open = vi.spyOn(Ledger, "open").mockImplementation(() => { throw Error("writer forbidden"); });
    const entries = vi.spyOn(Ledger.prototype, "entries").mockImplementation(() => { throw Error("locking read forbidden"); });
    const checks = await toolDoctorChecks({ home, repoPath: temp(), exec: () => "", exists: () => false, scannerPins: {}, projectsRoot: join(home, "projects"), platform: "linux" });
    expect(checks.find(c => c.name === "qa_toolchain")).toMatchObject({ level: "pass" }); expect(open).not.toHaveBeenCalled(); expect(entries).not.toHaveBeenCalled(); expect(existsSync(join(project, "ledger.lock"))).toBe(false);
  });
  it("foundation reports an unstable read without acquiring or reclaiming ledger.lock", async () => {
    const home = temp(); const project = join(home, "projects/one"); mkdirSync(project, { recursive: true }); writeFileSync(join(project, "ledger.lock"), "existing lock bytes");
    const open = vi.spyOn(Ledger, "open").mockImplementation(() => { throw Error("writer forbidden"); });
    const before = readdirSync(project);
    const pending = foundationChecks({ jarvisHome: home, pluginDir: temp(), socketPath: "", ledgerVerify: () => ({ ok: false, entries: [], problems: ["contended read"], repairable: [], contended: true }) });
    await expect(pending).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ name: "ledger.one" })])); const checks = await pending;
    expect(checks.find(c => c.name === "ledger.one")).toMatchObject({ detail: expect.stringContaining("contended") }); expect(open).not.toHaveBeenCalled(); expect(readdirSync(project)).toEqual(before); expect(readFileSync(join(project, "ledger.lock"), "utf8")).toBe("existing lock bytes");
  });
});
