import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChecksStore } from "../../packages/cli/src/checks/store.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { installDesktopChecks, runDesktop } from "../../packages/cli/src/lanes/desktop.ts";
import type { DesktopGateInput } from "../../packages/cli/src/lanes/desktop.ts";
import type { GateResult } from "../../packages/cli/src/checks/gate.ts";
const roots: string[] = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), "qa-split-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const plan = { nodeBin: process.execPath, tauriBin: "/tools/tauri", build: { bin: "/tools/npm", args: ["run", "tauri:build"] }, bundle: "target/Matches.app", executable: "Matches", bundleId: "test.jarvis.matches", stayUpMs: 100, shutdownMs: 100, buildTimeoutMs: 1000 };
function setup() {
  const projectDir = temp(); const store = new ChecksStore(projectDir); const ledger = Ledger.open(projectDir); installDesktopChecks(store, plan); store.approve(ledger, "reviewed");
  const checkout = temp(); mkdirSync(join(checkout, plan.bundle, "Contents/MacOS"), { recursive: true }); writeFileSync(join(checkout, plan.bundle, "Contents/MacOS/Matches"), "fake app"); writeFileSync(join(checkout, plan.bundle, "Contents/Info.plist"), "fake plist");
  const evidenceDir = temp();
  const probe = vi.fn(async (_bundle: string, _policy: { outputRoot: string; stayUpMs: number; shutdownMs: number }) => ({ kind: "qa-desktop-native" as const, status: "observed" as const, pid: 123, stayedUpMs: 100, menuBar: true, shutdown: { code: 0, signal: null } }));
  const input = { projectDir, store, ledger, repoPath: temp(), workRoot: temp(), jarvisHome: temp(), revision: "a".repeat(40), taskId: "desktop", attemptId: "one" };
  return { store, ledger, checkout, evidenceDir, probe, input };
}
describe("native smoke uses a runner-owned artifact handoff after the build gate", () => {
  it("copies the built app after cases stop, probes only after the gate passes, and records runner evidence", async () => {
    const s = setup(); const events: string[] = [];
    const gate = vi.fn(async (g: DesktopGateInput) => { expect(g.afterCases).toBeTypeOf("function"); expect(g.check.allowLocalBinding).not.toBe(true); expect(g.extraEnv).toEqual({}); await g.afterCases!(s.checkout); expect(s.probe).not.toHaveBeenCalled(); events.push("build"); return { status: "pass", evidenceDir: s.evidenceDir } as GateResult; });
    const probe = vi.fn(async (bundle: string, policy: { outputRoot: string; stayUpMs: number; shutdownMs: number }) => { events.push("native"); expect(bundle).toContain(policy.outputRoot); expect(bundle).not.toContain(s.checkout); return s.probe(bundle, policy); });
    expect((await runDesktop(s.input, { gate, probe, exists: () => true, platform: "darwin" })).status).toBe("pass");
    expect(events).toEqual(["build", "native"]); expect(probe).toHaveBeenCalledOnce();
    const last = s.ledger.entries().at(-1)!; expect(last.kind).toBe("gate_result"); expect(last.data).toMatchObject({ check: "native-smoke", revision: s.input.revision, status: "pass" });
    expect(existsSync(join(s.evidenceDir, "native-observation.json"))).toBe(true); expect(existsSync(probe.mock.calls[0]![0])).toBe(false);
    expect(readFileSync(join(s.store.checksDir, "fixtures/desktop/lanes/desktop-worker.ts"), "utf8")).not.toContain("probeDesktop");
  });
  it.each(["fail", "tampered"] as const)("never launches after a %s build gate", async status => {
    const s = setup(); const gate = vi.fn(async (g: DesktopGateInput) => { await g.afterCases(s.checkout); return { status, evidenceDir: s.evidenceDir } as GateResult; });
    expect((await runDesktop(s.input, { gate, probe: s.probe, exists: () => true, platform: "darwin" })).status).toBe(status); expect(s.probe).not.toHaveBeenCalled();
  });
  it("a passing build without the artifact hook cannot count as native coverage", async () => {
    const s = setup(); const gate = vi.fn(async () => ({ status: "pass", evidenceDir: s.evidenceDir } as GateResult));
    expect(await runDesktop(s.input, { gate, probe: s.probe, exists: () => true, platform: "darwin" })).toMatchObject({ status: "not run" }); expect(s.probe).not.toHaveBeenCalled();
  });
  it("keeps native failures as failures and explicitly reports offline download requirements", async () => {
    const s = setup(); const gate = vi.fn(async (g: DesktopGateInput) => { await g.afterCases!(s.checkout); return { status: "pass", evidenceDir: s.evidenceDir } as GateResult; });
    expect((await runDesktop(s.input, { gate, probe: async () => ({ kind: "qa-desktop-native", status: "fail", reason: "no menu" }), exists: () => true, platform: "darwin" })).status).toBe("fail");
    const dir = join(s.evidenceDir, "cases/desktop"); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "stdout"), JSON.stringify({ kind: "qa-desktop-build", status: "not run", reason: "not run: desktop build needs network" }));
    expect(await runDesktop(s.input, { gate: async () => ({ status: "fail", evidenceDir: s.evidenceDir } as GateResult), probe: s.probe, exists: () => true, platform: "darwin" })).toMatchObject({ status: "not run", reason: "not run: desktop build needs network" });
  });
});
