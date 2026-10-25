import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDoctor, doctorExitCode } from "../../packages/cli/src/doctor/doctor.ts";
import { toolDoctorChecks } from "../../packages/cli/src/doctor/tools.ts";
import { fakeToolchain } from "../fixtures/qa/toolchain.ts";
import { pinnedMaestroBin } from "../../packages/cli/src/config/pins.ts";

const roots: string[] = [];
const temp = () => { const p = mkdtempSync(join(tmpdir(), "doctor-tools-")); roots.push(p); return p; };
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
const output = { code: 0, timedOut: false, overflowed: false, durationMs: 1, stdout: "", stderr: "" };
function setup() {
  const repo = temp(); const approved = fakeToolchain(temp());
  const exec = vi.fn((bin: string, args: string[]) => bin.endsWith("maestro") ? "2.11.0\n" : bin.endsWith("tauri") ? "tauri-cli 2.9.1\n" : args.includes("-p") ? "/Library/Developer/CommandLineTools\n" : "package-id: com.apple.pkg.CLTools_Executables\nversion: 26.0.0.0.1.1757719678\n");
  const spawn = vi.fn(async () => ({ ...output, stdout: "1.2.3\n" }));
  const options = { home: "/fake-home", repoPath: repo, platform: "darwin" as const, exec, exists: () => true, tauriBin: "/tools/tauri", toolchain: approved.toolchain, scannerPins: { gitleaks: { bin: "/tools/gitleaks", version: "1.2.3", args: [] } }, scannerDeps: { spawn } };
  return { repo, approved, exec, spawn, options };
}
describe("optional lane tools in doctor", () => {
  it("reuses security version checks and reports exact native versions and an approved manifest", async () => {
    const { exec, spawn, options } = setup(); const checks = await toolDoctorChecks(options);
    expect(checks.find(c => c.name === "security.gitleaks")).toMatchObject({ level: "pass", detail: expect.stringContaining("1.2.3") });
    expect(spawn).toHaveBeenCalledOnce();
    expect(checks.find(c => c.name === "maestro")).toMatchObject({ level: "pass", detail: expect.stringContaining("2.11.0") });
    expect(exec).toHaveBeenCalledWith(pinnedMaestroBin("/fake-home"), ["--version"]);
    expect(checks.find(c => c.name === "xcode_clt")).toMatchObject({ level: "pass", detail: expect.stringContaining("26.0.0.0.1.1757719678") });
    expect(checks.find(c => c.name === "tauri")).toMatchObject({ level: "pass", detail: expect.stringContaining("2.9.1") });
    expect(checks.find(c => c.name === "qa_toolchain")).toMatchObject({ level: "pass", detail: expect.stringContaining("Playwright 1.58.0; axe 4.10.3") });
    expect(exec.mock.calls.every(([bin]) => bin.startsWith("/"))).toBe(true);
  });
  it("warns for optional missing tools and fails only tools explicitly required by a lane", async () => {
    const { options } = setup();
    const missing = { ...options, exists: () => false, exec: () => { throw Error("missing"); }, scannerPins: {}, toolchain: undefined };
    const checks = await toolDoctorChecks(missing);
    expect(checks.map(c => c.name)).toEqual(["security.gitleaks", "security.semgrep", "security.osv-scanner", "maestro", "xcode_clt", "tauri", "qa_toolchain"]);
    expect(checks.every(c => c.level === "warn")).toBe(true); expect(doctorExitCode(checks)).toBe(0);
    const required = await toolDoctorChecks({ ...missing, required: ["maestro", "security.semgrep", "qa_toolchain"] });
    expect(required.filter(c => c.level === "fail").map(c => c.name)).toEqual(["security.semgrep", "maestro", "qa_toolchain"]);
  });
  it("does not mistake malformed output or a tampered manifest for an installed tool", async () => {
    const { options, approved } = setup();
    const { writeFileSync } = await import("node:fs"); writeFileSync(join(approved.toolchain.root, "axe.js"), "tampered");
    const checks = await toolDoctorChecks({ ...options, exec: () => "installed\n" });
    expect(checks.filter(c => ["maestro", "tauri", "xcode_clt", "qa_toolchain"].includes(c.name)).every(c => c.level === "warn")).toBe(true);
  });
  it("discovers approved manifests under runner fixtures and warns on unreadable discovery roots", async () => {
    const { options } = setup(); const projects = temp();
    fakeToolchain(join(projects, "project-one"));
    expect((await toolDoctorChecks({ ...options, toolchain: undefined, projectsRoot: projects })).find(c => c.name === "qa_toolchain")).toMatchObject({ level: "pass" });
    const { writeFileSync } = await import("node:fs"); const file = join(temp(), "file"); writeFileSync(file, "not a directory");
    expect((await toolDoctorChecks({ ...options, toolchain: undefined, projectsRoot: file })).find(c => c.name === "qa_toolchain")).toMatchObject({ level: "warn" });
  });
  it("finds the home project's fixtures without a foundation block", async () => {
    const home = temp(); const repo = temp(); fakeToolchain(join(home, ".jarvis/projects/one"));
    const checks = await runDoctor({ home, repoPath: repo, platform: "linux", env: {}, exists: () => false, exec: () => { throw Error("missing"); }, freeBytes: () => 100 * 1024 ** 3 });
    expect(checks.find(c => c.name === "qa_toolchain")).toMatchObject({ level: "pass" });
  });
  it("wires optional tools into runDoctor without requiring the tools block", async () => {
    const checks = await runDoctor({ home: "/fake-home", repoPath: temp(), platform: "linux", env: {}, exists: () => false, exec: () => { throw Error("missing"); }, freeBytes: () => 100 * 1024 ** 3 });
    expect(checks.find(c => c.name === "maestro")?.level).toBe("warn");
    expect(checks.find(c => c.name === "security.osv-scanner")?.level).toBe("warn");
  });
});

describe("review: read-only doctor ledger access", () => {
  it("does not open or use a ledger writer while inspecting an approved toolchain", async () => {
    const { options } = setup();
    const { Ledger } = await import("../../packages/cli/src/ledger/ledger.ts");
    const open = vi.spyOn(Ledger, "open").mockImplementation(() => { throw Error("doctor opened a writer"); });
    const entries = vi.spyOn(Ledger.prototype, "entries").mockImplementation(() => { throw Error("doctor used a locking reader"); });
    try {
      expect((await toolDoctorChecks(options)).find(c => c.name === "qa_toolchain")).toMatchObject({ level: "pass" });
      expect(open).not.toHaveBeenCalled(); expect(entries).not.toHaveBeenCalled();
    } finally { open.mockRestore(); entries.mockRestore(); }
  });
});
