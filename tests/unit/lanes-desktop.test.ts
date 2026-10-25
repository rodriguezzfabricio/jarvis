import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChecksStore } from "../../packages/cli/src/checks/store.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { installDesktopChecks, runDesktop } from "../../packages/cli/src/lanes/desktop.ts";
import { observeDesktopBuild, probeDesktop } from "../../packages/cli/src/lanes/desktop-observe.ts";
import { verifyDesktopEvidence, verifyDesktopObservation, verifyNativeObservation } from "../../packages/cli/src/lanes/desktop-verify.ts";
import type { DesktopPlan } from "../../packages/cli/src/lanes/desktop-types.ts";
import type { SessionOutcome, SessionSpec } from "../../packages/cli/src/proc/session.ts";
const roots: string[] = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), "qa-desktop-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const ok: SessionOutcome = { code: 0, timedOut: false, overflowed: false, durationMs: 1, stdout: "", stderr: "" };
const plan: DesktopPlan = { nodeBin: process.execPath, tauriBin: "/tools/tauri", build: { bin: "/tools/npm", args: ["run", "tauri:build"] }, bundle: "target/Matches.app", stayUpMs: 100, shutdownMs: 100, buildTimeoutMs: 1000 };
function native() {
  const root = temp(); const bundle = join(root, "Matches.app"); mkdirSync(bundle); let now = 0; let running = true;
  const stop = vi.fn(async () => { running = false; });
  const launch = vi.fn(async (_bundle: string) => ({ pid: 123, alive: () => running, waitForExit: async () => ({ code: 0, signal: null }), stop }));
  const spawn = vi.fn(async (_spec: SessionSpec) => ({ ...ok, stdout: "true\n" }));
  return { root, bundle, stop, spawn, launch, deps: { launch, spawn, now: () => now, sleep: async (ms: number) => { now += ms; } }, policy: { outputRoot: root, stayUpMs: 100, shutdownMs: 100 }, exit: () => { running = false; } };
}
describe("desktop build and runner native observations", () => {
  it("installs build-only fixtures without approval or overwriting", () => {
    const project = temp(); const store = new ChecksStore(project); const ledger = Ledger.open(project); installDesktopChecks(store, plan);
    expect(store.verify(ledger).ok).toBe(false); store.approve(ledger, "reviewed"); expect(store.verify(ledger).ok).toBe(true);
    const worker = readFileSync(join(store.checksDir, "fixtures/desktop/lanes/desktop-worker.ts"), "utf8"); expect(worker).toContain("observeDesktopBuild"); expect(worker).not.toContain("probeDesktop"); expect(() => installDesktopChecks(store, plan)).toThrow(/already/);
  });
  it("does not run a gate for missing tools or tampered checks", async () => {
    const projectDir = temp(); const store = new ChecksStore(projectDir); const ledger = Ledger.open(projectDir); installDesktopChecks(store, plan); store.approve(ledger, "reviewed");
    const input = { projectDir, store, ledger, workRoot: temp(), repoPath: temp(), jarvisHome: temp(), revision: "a".repeat(40), taskId: "task", attemptId: "one" };
    // A gate that answers (a failed build), so a mutated platform check fails an assertion instead of crashing.
    const gate = vi.fn(async () => ({ status: "fail" as const, evidenceDir: temp() }));
    expect((await runDesktop(input, { gate, platform: "darwin", exists: () => false })).status).toBe("not run"); writeFileSync(join(store.checksDir, "desktop/plan.json"), "{}"); expect((await runDesktop(input, { gate })).status).toBe("tampered"); expect(gate).not.toHaveBeenCalled();
  });
  it.each([{ code: 1 }, { code: null }, { timedOut: true }, { overflowed: true }])("fails bounded build outcomes %j", async change => {
    const raw = await observeDesktopBuild(temp(), plan, {}, { exists: () => true, spawn: async () => ({ ...ok, ...change }) }); expect(raw.status).toBe("fail"); expect(verifyDesktopObservation(raw, plan).ok).toBe(false);
  });
  it("rejects build environment injection and unsafe plans", async () => {
    await expect(observeDesktopBuild(temp(), plan, { NODE_OPTIONS: "--import=fake" })).rejects.toThrow(/environment/);
    for (const bad of [{ ...plan, bundle: "../escape.app" }, { ...plan, stayUpMs: 0 }, { ...plan, shutdownMs: Infinity }, { ...plan, tauriBin: "tauri" }]) expect(() => installDesktopChecks(new ChecksStore(temp()), bad)).toThrow();
  });
  it("observes native survival, the status item and clean shutdown, then always cleans up", async () => {
    const s = native(); const raw = await probeDesktop(s.bundle, s.policy, s.deps); expect(raw).toMatchObject({ status: "observed", menuBar: true, stayedUpMs: 100, shutdown: { code: 0, signal: null } }); expect(verifyNativeObservation(raw, 100).ok).toBe(true); expect(s.stop).toHaveBeenCalledOnce();
  });
  it("refuses to launch a native bundle without an injected sandboxed launcher", async () => {
    const s = native(); const { launch: _launch, ...unsandboxed } = s.deps;
    await expect(probeDesktop(s.bundle, s.policy, unsandboxed)).rejects.toThrow(/sandboxed native launcher/); expect(s.spawn).not.toHaveBeenCalled();
  });
  it("fails early exit, missing menu items and unclean shutdown", async () => {
    const early = native(); early.exit(); expect((await probeDesktop(early.bundle, early.policy, early.deps)).status).toBe("fail"); expect(early.stop).toHaveBeenCalledOnce();
    const menu = native(); menu.spawn.mockResolvedValue({ ...ok, stdout: "false" }); expect((await probeDesktop(menu.bundle, menu.policy, menu.deps)).status).toBe("fail"); expect(menu.stop).toHaveBeenCalledOnce();
    const dirty = native(); expect((await probeDesktop(dirty.bundle, dirty.policy, { ...dirty.deps, launch: async () => ({ pid: 123, alive: () => true, waitForExit: async () => ({ code: null, signal: "SIGKILL" }), stop: dirty.stop }) })).status).toBe("fail"); expect(dirty.stop).toHaveBeenCalledOnce();
  });
  it("keeps completion proof separate from the sandbox build process", async () => {
    const root = temp(); mkdirSync(join(root, "desktop")); const raw = { kind: "qa-desktop-build", status: "observed", bundle: plan.bundle, build: { code: 0, timedOut: false, overflowed: false } };
    writeFileSync(join(root, "desktop/stdout"), JSON.stringify(raw)); writeFileSync(join(root, "desktop/code"), "0"); writeFileSync(join(root, "nonce"), "test-nonce"); expect(verifyDesktopEvidence(root, plan, join(root, "nonce"))).toBe("JARVIS-CHECK-COMPLETE test-nonce");
    writeFileSync(join(root, "desktop/code"), "signal"); expect(() => verifyDesktopEvidence(root, plan, join(root, "nonce"))).toThrow(); expect(verifyDesktopObservation({ ...raw, status: "not run" }, plan).ok).toBe(false);
  });
});
