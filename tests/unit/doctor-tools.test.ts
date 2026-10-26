import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDoctor, doctorExitCode } from "../../packages/cli/src/doctor/doctor.ts";
import { toolDoctorChecks, type ToolDoctorDeps } from "../../packages/cli/src/doctor/tools.ts";
import { fakeToolchain } from "../fixtures/qa/toolchain.ts";
import { pinnedMaestroBin, pinnedSecurityScanners } from "../../packages/cli/src/config/pins.ts";

const roots: string[] = [];
const temp = () => { const p = mkdtempSync(join(tmpdir(), "doctor-tools-")); roots.push(p); return p; };
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
const IMPECCABLE = { bin: "/tools/impeccable", version: "0.1.16", sha256: "e".repeat(64) };
const output = { code: 0, timedOut: false, overflowed: false, durationMs: 1, stdout: "", stderr: "" };
function setup() {
  const repo = temp(); const approved = fakeToolchain(temp());
  const exec = vi.fn((bin: string, args: string[], _env?: Record<string, string>) => bin.endsWith("impeccable") ? "0.1.16+engine\n" : bin.endsWith("maestro") ? "2.11.0\n" : bin.endsWith("tauri") ? "tauri-cli 2.9.1\n" : args.includes("-p") ? "/Library/Developer/CommandLineTools\n" : "package-id: com.apple.pkg.CLTools_Executables\nversion: 26.0.0.0.1.1757719678\n");
  const spawn = vi.fn(async () => ({ ...output, stdout: "1.2.3\n" }));
  const options = { home: "/fake-home", repoPath: repo, platform: "darwin" as const, exec, exists: () => true, tauriBin: "/tools/tauri", impeccablePin: IMPECCABLE, hashFile: () => IMPECCABLE.sha256, toolchain: approved.toolchain, scannerPins: { gitleaks: { bin: "/tools/gitleaks", version: "1.2.3", args: [] } }, scannerDeps: { spawn } };
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
    expect(checks.find(c => c.name === "impeccable")).toMatchObject({ level: "pass", detail: expect.stringContaining(`0.1.16+engine; sha256 ${IMPECCABLE.sha256}`) });
    expect(exec).toHaveBeenCalledWith(IMPECCABLE.bin, ["--version"], { PATH: "/usr/bin:/bin", DO_NOT_TRACK: "1", IMPECCABLE_NO_TELEMETRY: "1" });
    expect(exec.mock.calls.every(([bin]) => bin.startsWith("/"))).toBe(true);
  });
  it("fails missing security scanners and warns for other optional tools", async () => {
    const { options } = setup();
    const missing = { ...options, exists: () => false, exec: () => { throw Error("missing"); }, scannerPins: {}, toolchain: undefined };
    const checks = await toolDoctorChecks(missing);
    expect(checks.map(c => c.name)).toEqual(["security.gitleaks", "security.semgrep", "security.osv-scanner", "maestro", "xcode_clt", "tauri", "impeccable", "qa_toolchain"]);
    expect(checks.filter(c => c.name.startsWith("security.")).every(c => c.level === "fail")).toBe(true);
    expect(checks.filter(c => !c.name.startsWith("security.")).every(c => c.level === "warn")).toBe(true); expect(doctorExitCode(checks)).toBe(1);
    const required = await toolDoctorChecks({ ...missing, required: ["maestro", "security.semgrep", "qa_toolchain"] });
    expect(required.filter(c => c.level === "fail").map(c => c.name)).toEqual(["security.gitleaks", "security.semgrep", "security.osv-scanner", "maestro", "qa_toolchain"]);
  });
  it("accepts only the pinned Impeccable engine file at its exact version (decision 124)", async () => {
    const { options, exec } = setup();
    const level = async (extra: Partial<ToolDoctorDeps>) => (await toolDoctorChecks({ ...options, ...extra })).find(c => c.name === "impeccable");
    expect(await level({ hashFile: () => "f".repeat(64) })).toMatchObject({ level: "warn", detail: expect.stringContaining("differs from the pinned") });
    expect(await level({ exec: (bin: string, args: string[]) => bin.endsWith("impeccable") ? "0.1.17+engine\n" : exec(bin, args) })).toMatchObject({ level: "warn", detail: expect.stringContaining("expected 0.1.16+engine") });
    expect(await level({ exec: (bin: string, args: string[]) => bin.endsWith("impeccable") ? "0.1.16\n" : exec(bin, args) })).toMatchObject({ level: "warn" });
    expect(await level({ impeccablePin: { ...IMPECCABLE, bin: "impeccable" } })).toMatchObject({ level: "warn", detail: expect.stringContaining("unavailable") });
    expect(await level({ exists: (p: string) => p !== IMPECCABLE.bin })).toMatchObject({ level: "warn", detail: expect.stringContaining("unavailable") });
    expect(await level({ hashFile: () => "f".repeat(64), required: ["impeccable"] })).toMatchObject({ level: "fail" });
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
    expect(checks.find(c => c.name === "security.osv-scanner")?.level).toBe("fail");
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

describe("doctor scanner pins (backlog 95)", () => {
  it("probes only pinned paths once and accepts OSV's labelled version among two versions", async () => {
    const { scannerPins: _pins, scannerDeps: _deps, ...options } = setup().options; const pins = pinnedSecurityScanners();
    const exec = vi.fn((bin: string, _args: string[], _env?: Record<string, string>) => {
      const tool = Object.keys(pins).find(tool => pins[tool as keyof typeof pins]?.bin === bin);
      if (tool === "osv-scanner") return "osv-scanner version: 2.7.0\nOSV-Scalibr version: 0.4.1\n";
      return tool ? pins[tool as keyof typeof pins]!.version : "unavailable";
    });
    const checks = await toolDoctorChecks({ ...options, exec });
    expect(checks.filter(c => c.name.startsWith("security.")).map(c => c.level)).toEqual(["pass", "pass", "pass"]);
    for (const [tool, pin] of Object.entries(pins)) {
      expect(exec.mock.calls.filter(([bin]) => bin === pin!.bin).map(([bin, args]) => [bin, args])).toEqual([[pin!.bin, [tool === "gitleaks" ? "version" : "--version"]]]);
    }
    expect(exec.mock.calls.some(([bin]) => bin.startsWith("/fake-home/.local/bin/"))).toBe(false);
    expect(exec.mock.calls.find(([bin]) => bin === pins.semgrep!.bin)?.[2]).toMatchObject({ SSL_CERT_FILE: "/etc/ssl/cert.pem", SEMGREP_ENABLE_VERSION_CHECK: "0" });
  });
  it("fails mismatched versions without required flags and reports expected and found", async () => {
    const { scannerPins: _pins, scannerDeps: _deps, ...options } = setup().options;
    const checks = await toolDoctorChecks({ ...options, exec: () => "9.9.9" });
    for (const [tool, pin] of Object.entries(pinnedSecurityScanners())) {
      expect(checks.find(c => c.name === `security.${tool}`)).toMatchObject({ level: "fail", detail: expect.stringContaining(`expected ${pin!.version}; found 9.9.9`) });
    }
  });
  it("fails missing pinned binaries even when alternate installations exist", async () => {
    const { scannerPins: _pins, scannerDeps: _deps, ...options } = setup().options; const exec = vi.fn((_bin: string, _args: string[]) => "9.9.9");
    const checks = await toolDoctorChecks({ ...options, exists: path => !path.startsWith("/opt/homebrew/bin/"), exec });
    for (const [tool, pin] of Object.entries(pinnedSecurityScanners())) {
      expect(checks.find(c => c.name === `security.${tool}`)).toMatchObject({ level: "fail", detail: expect.stringContaining(`expected ${pin!.version}; found unavailable`) });
    }
    expect(exec.mock.calls.some(([bin]) => /gitleaks|semgrep|osv-scanner/.test(bin))).toBe(false);
  });
});
