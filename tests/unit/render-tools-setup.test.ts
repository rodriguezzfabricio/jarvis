import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it, vi } from "vitest";
import * as accounts from "../../packages/cli/src/setup/accounts.ts";
import { verifyProviderCli } from "../../packages/cli/src/release/provider-cli.ts";
import { RENDER_TOOL_PINS } from "../../packages/cli/src/config/pins.ts";
import { renderTools } from "../../packages/cli/src/release/render-tools.ts";
import { toolDoctorChecks } from "../../packages/cli/src/doctor/tools.ts";
import type { SessionSpec } from "../../packages/cli/src/proc/session.ts";

const root = mkdtempSync(join(tmpdir(), "render-tools-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const tools = [{ bin: "/bin/echo", version: "git version 2.50.1", args: ["--version"] }, { bin: "/usr/bin/ssh", version: "OpenSSH_10.2p1, LibreSSL 3.3.6", args: ["-V"] }];
const input = { provider: "render" as const, home: root, providerHome: root, providerCwd: root, untrusted: [] };
const ok = (stdout = "", stderr = "") => ({ code: 0, timedOut: false, overflowed: false, durationMs: 0, stdout, stderr });

describe("Render tools in registry consumers", () => {
  it("verifies native git and ssh without Node, credentials or public HOME/cwd", async () => {
    const calls: SessionSpec[] = [];
    const result = await verifyProviderCli(input, { nativeTools: tools, run: async s => {
      calls.push(s); expect(readdirSync(s.cwd)).toEqual([]); expect(readdirSync(s.env.HOME!)).toEqual([]);
      expect(s.env).toEqual({ PATH: "/usr/bin:/bin", HOME: s.env.HOME, CI: "1" });
      return s.args.includes("-V") ? ok("", tools[1]!.version) : ok(tools[0]!.version);
    } });
    expect(result).toMatchObject({ ok: true, version: tools[0]!.version, ssh: { bin: "/usr/bin/ssh", version: tools[1]!.version } });
    expect(result).not.toHaveProperty("interpreter"); expect(calls.map(s => s.args)).toEqual([["--version"], ["-V"]]);
    expect(calls.some(s => existsSync(s.cwd) || existsSync(s.env.HOME!))).toBe(false);
  });
  it("takes Git and SSH from config/pins.ts by absolute path, never PATH", () => {
    expect(RENDER_TOOL_PINS.git.bin).toBe("/Applications/Xcode.app/Contents/Developer/usr/bin/git");
    expect(RENDER_TOOL_PINS.ssh.bin).toBe("/usr/bin/ssh");
    expect(renderTools()).toEqual([{ ...RENDER_TOOL_PINS.git, args: ["--version"] }, { ...RENDER_TOOL_PINS.ssh, args: ["-V"] }]);
    expect(renderTools({ git: { bin: "git", version: "git version 2.50.1" }, ssh: RENDER_TOOL_PINS.ssh })).toBeUndefined();
  });
  it("refuses an unpinned or wrong native tool and tools under an untrusted root", async () => {
    expect(await verifyProviderCli(input, { nativeTools: [] })).toMatchObject({ ok: false });
    expect(await verifyProviderCli(input, { nativeTools: tools, run: async () => ok("wrong") })).toMatchObject({ ok: false });
    const run = vi.fn(async () => ok());
    expect(await verifyProviderCli({ ...input, untrusted: ["/bin"] }, { nativeTools: tools, run })).toMatchObject({ ok: false }); expect(run).not.toHaveBeenCalled();
  });
  it("doctor checks the same two native tools and refuses the wrong SSH version", async () => {
    const exec = vi.fn((bin: string, args: string[], env?: Record<string, string>) => {
      if (bin === "/bin/echo" || bin === "/usr/bin/ssh") { expect(env?.HOME).toBeDefined(); return args[0] === "-V" ? tools[1]!.version : tools[0]!.version; }
      throw new Error("not installed");
    });
    const nativeCalls: SessionSpec[] = [];
    const providerRun = async (s: SessionSpec) => { nativeCalls.push(s); return s.args[0] === "-V" ? ok("", exec(s.bin, [...s.args], s.env)) : ok(exec(s.bin, [...s.args], s.env)); };
    const deps = { repoPath: root, home: root, exec: () => { throw new Error("stdout-only exec cannot verify ssh"); }, providerRun, exists: () => true, providerTools: { render: tools } };
    expect((await toolDoctorChecks(deps)).find(c => c.name === "deploy.render")).toMatchObject({ level: "pass" });
    expect(exec.mock.calls.filter(([bin]) => ["/bin/echo", "/usr/bin/ssh"].includes(bin)).map(([bin, args]) => [bin, args])).toEqual([["/bin/echo", ["--version"]], ["/usr/bin/ssh", ["-V"]]]);
    expect(nativeCalls).toHaveLength(2);
    for (const s of nativeCalls) { expect(existsSync(s.cwd)).toBe(false); expect(existsSync(s.env.HOME!)).toBe(false); }
    expect((await toolDoctorChecks({ ...deps, providerRun: async () => ok("wrong"), required: ["deploy.render"] })).find(c => c.name === "deploy.render")).toMatchObject({ level: "fail" });
  });
});

describe("Render setup", () => {
  it("offers Render and generates two broker-only keys, printing only public keys and manual setup steps", async () => {
    expect(accounts.DEPLOY).toHaveProperty("render");
    const stored: { key: string; value: string; meta: { brokerOnly: boolean } }[] = [], printed: string[] = [], calls: SessionSpec[] = [];
    const result = await accounts.setupRenderAccount({ privateRoot: root, print: s => printed.push(s),
      secrets: { location: "fake backend", prepare() {}, set: (key, value, meta) => { stored.push({ key, value, meta }); } },
      run: async s => {
        calls.push(s); expect(s.bin).toBe("/usr/bin/ssh-keygen"); expect(s.args).toEqual(expect.arrayContaining(["-t", "ed25519", "-N", ""]));
        expect(statSync(s.cwd).mode & 0o077).toBe(0); expect(s.env).toEqual({ PATH: "/usr/bin:/bin", HOME: s.cwd });
        const file = s.args[s.args.indexOf("-f") + 1]!; writeFileSync(file, `DUMMY private ${calls.length}\n`, { mode: 0o600 }); writeFileSync(`${file}.pub`, `ssh-ed25519 DUMMY-public-${calls.length}\n`); return ok();
      } });
    expect(result).toMatchObject({ status: "done", provider: "render" }); expect(calls).toHaveLength(2);
    expect(stored.map(s => s.key)).toEqual(["RENDER_PREVIEW_DEPLOY_KEY", "RENDER_PRODUCTION_DEPLOY_KEY"]);
    expect(stored.every(s => s.meta.brokerOnly)).toBe(true); expect(stored[0]!.value).not.toBe(stored[1]!.value);
    for (const s of stored) { expect(printed.join("\n")).not.toContain(s.value); expect(Buffer.from(s.value, "base64").toString()).toContain("DUMMY private"); }
    expect(printed.join("\n")).toContain("DUMMY-public-1"); expect(printed.join("\n")).toContain("DUMMY-public-2");
    expect(printed.join("\n")).toMatch(/private repositor/); expect(printed.join("\n")).toContain("write"); expect(printed.join("\n")).toContain("Build Command");
    expect(calls.some(s => existsSync(s.cwd))).toBe(false);
  });
  it("stores no key if generation fails and removes private temporary files", async () => {
    const set = vi.fn(); let cwd = "";
    await expect(accounts.setupRenderAccount({ privateRoot: root, print() {}, secrets: { location: "fake", prepare() {}, set }, run: async s => { cwd = s.cwd; return { ...ok(), code: 1 }; } })).rejects.toThrow();
    expect(set).not.toHaveBeenCalled(); expect(existsSync(cwd)).toBe(false);
  });
});
