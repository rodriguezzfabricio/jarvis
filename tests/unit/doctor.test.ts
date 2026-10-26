import { pinnedSecurityScanners } from "../../packages/cli/src/config/pins.ts";
import { describe, expect, it } from "vitest";
import { allowsUnattended, doctorExitCode, runDoctor, type DoctorDeps } from "../../packages/cli/src/doctor/doctor.ts";

const GB = 1024 ** 3;
type Probe = NonNullable<DoctorDeps["probe"]>;
const okProbe: Probe = async () => ({ ok: true, exitCode: 0, checks: [{ name: "secret_not_read", ok: true, detail: "" }] });
const badProbe: Probe = async () => ({ ok: false, exitCode: 0, checks: [{ name: "secret_not_read", ok: false, detail: "leak" }] });

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    home: "/Users/f",
    env: { HOME: "/Users/f", USER: "f" },
    platform: "darwin",
    repoPath: process.cwd(),
    exists: () => true,
    exec: (bin) => Object.values(pinnedSecurityScanners()).find(pin => pin?.bin === bin)?.version ?? (bin.endsWith("2.1.309") ? "2.1.309 (Claude Code)\n" : bin.endsWith("codex") ? "codex-cli 0.164.0\n" : "0\n"),
    freeBytes: () => 100 * GB,
    live: true,
    probe: okProbe,
    ...over,
  };
}
const level = (cs: Awaited<ReturnType<typeof runDoctor>>, n: string) => cs.find((c) => c.name === n)?.level;

describe("jarvis doctor", () => {
  it("passes on a healthy machine and allows unattended runs", async () => {
    const cs = await runDoctor(deps());
    expect(doctorExitCode(cs)).toBe(0);
    expect(allowsUnattended(cs)).toBe(true);
  });

  it("requires the live canary probe before unattended runs (decision 59)", async () => {
    const notLive = await runDoctor(deps({ live: false }));
    expect(allowsUnattended(notLive)).toBe(false);
    const failing = await runDoctor(deps({ probe: badProbe }));
    expect(level(failing, "canary_probe")).toBe("fail");
    expect(allowsUnattended(failing)).toBe(false);
  });

  it("fails on a Claude Code version other than the pin (decision 57)", async () => {
    const cs = await runDoctor(deps({ exec: (b) => (b.endsWith("2.1.309") ? "2.1.270 (Claude Code)" : "0") }));
    expect(level(cs, "claude_pinned")).toBe("fail");
  });

  it("applies the disk floor and the single-writer threshold (decision 63)", async () => {
    expect(level(await runDoctor(deps({ freeBytes: () => 19 * GB })), "disk_free")).toBe("fail");
    expect(level(await runDoctor(deps({ freeBytes: () => 29 * GB })), "disk_free")).toBe("warn");
    expect(level(await runDoctor(deps({ freeBytes: () => 41 * GB })), "disk_free")).toBe("pass");
  });

  it("fails when iCloud sync covers the repo (decision 64)", async () => {
    const cs = await runDoctor(deps({ repoPath: "/Users/f/Desktop/jarvis", exec: (b) => Object.values(pinnedSecurityScanners()).find(pin => pin?.bin === b)?.version ?? (b === "/usr/bin/defaults" ? "1" : b.endsWith("codex") ? "codex-cli 0.164.0" : "2.1.309 (Claude Code)") }));
    expect(level(cs, "icloud_sync")).toBe("fail");
  });

  it("warns about rerouting variables in the shell but keeps them out of sessions (decision 58)", async () => {
    const cs = await runDoctor(deps({ env: { HOME: "/Users/f", CLAUDE_CODE_USE_OPENAI: "1", ANTHROPIC_API_KEY: "x" } }));
    expect(level(cs, "parent_env")).toBe("warn");
    expect(level(cs, "child_env_clean")).toBe("pass");
  });
});
