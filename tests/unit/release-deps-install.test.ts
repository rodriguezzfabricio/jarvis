import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runSession } from "../../packages/cli/src/proc/session.ts";
import type { SandboxedRun } from "../../packages/cli/src/sandbox/srt.ts";
import { shortTmp } from "../helpers.ts";

const root = shortTmp("deps-install-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let serial = 0;
async function fixture(manager = "npm", mode = "ok") {
  const dir = join(root, String(++serial)), scratch = join(dir, "scratch"), checkout = join(scratch, "checkout"), evidenceDir = join(dir, "evidence"), tools = join(dir, "tools");
  for (const d of [checkout, evidenceDir, tools]) mkdirSync(d, { recursive: true });
  const version = manager === "npm" ? "11.19.0" : "11.7.0";
  writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: "tiny", version: "1.0.0", packageManager: `${manager}@${version}`, scripts: { postinstall: "touch SHOULD_NOT_EXIST" } }));
  writeFileSync(join(checkout, manager === "npm" ? "package-lock.json" : "pnpm-lock.yaml"), manager === "npm" ? JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }) : "lockfileVersion: '9.0'\nimporters:\n  .: {}\npackages: {}\nsnapshots: {}\n");
  const bin = join(tools, "fake-pm.cjs");
  writeFileSync(bin, `const fs = require('node:fs'), path = require('node:path');
    if (process.argv.includes('--store-dir') && (!process.argv[process.argv.indexOf('--store-dir')+1] || process.argv[process.argv.indexOf('--store-dir')+1].startsWith('--'))) process.exit(21);
    if (process.argv.includes('--version')) { console.log('${mode === "wrong-version" ? "0.0.0" : version}'); process.exit(0); }
    const args = process.argv.slice(2);
    if (!args.includes('--ignore-scripts') || process.env.npm_config_ignore_scripts !== 'true') fs.writeFileSync('SHOULD_NOT_EXIST','script ran');
    if (process.env.npm_config_userconfig !== '/dev/null' || process.env.npm_config_globalconfig === '/dev/null' || !process.env.npm_config_globalconfig.startsWith(process.env.HOME) || fs.readFileSync(process.env.npm_config_globalconfig, 'utf8') !== '') process.exit(20);
    fs.mkdirSync('node_modules', {recursive:true});
    if ('${mode}' === 'size' || '${mode}' === 'live-size') fs.writeFileSync('node_modules/large', 'x'.repeat(1024));
    else if ('${mode}' === 'count') for(let i=0;i<20;i++) fs.writeFileSync('node_modules/'+i,'x');
    else if ('${mode}' === 'escape') fs.symlinkSync('/etc', 'node_modules/escape');
    else if ('${mode}' === 'output') console.log('x'.repeat(4096));
    else fs.writeFileSync('node_modules/tiny.js', fs.readFileSync(path.join(process.env.npm_config_cache,'fake-registry')));
    if ('${mode}' === 'timeout' || '${mode}' === 'live-size') setInterval(()=>{},100);
    if ('${mode}' === 'exit') process.exit(2);
  `);
  const calls: SandboxedRun[] = [], requests: string[] = [];
  const registry = (host: string) => { requests.push(host); if (host !== "registry.npmjs.org") throw new Error("fake registry denied host"); return "export const value = 1;"; };
  const sandbox = async (r: SandboxedRun) => {
    calls.push(r);
    // No actual socket: this seam supplies fake registry bytes only when the policy permits the host.
    const host = r.policy.allowedDomains?.[0] ?? "denied";
    mkdirSync(r.env.npm_config_cache!, { recursive: true });
    writeFileSync(join(r.env.npm_config_cache!, "fake-registry"), registry(host));
    return runSession({ bin: "/bin/sh", args: ["-c", r.command], cwd: r.cwd, env: r.env, timeoutMs: r.timeoutMs, ...(r.maxOutputBytes !== undefined ? { maxOutputBytes: r.maxOutputBytes } : {}), ...(r.stdoutPath ? { stdoutPath: r.stdoutPath } : {}), ...(r.stderrPath ? { stderrPath: r.stderrPath } : {}), killGraceMs: 50 });
  };
  const pins = { node: process.execPath, nodeVersion: process.versions.node, npm: { bin, root: tools, version: "11.19.0" }, pnpm: { bin, root: tools, version: "11.7.0" } };
  const input = { checkout, scratch, evidenceDir, policy: { denyRead: [root], allowRead: [scratch], allowWrite: [checkout] }, pins, sandbox };
  const run = async (limits = {}) => (await import("../../packages/cli/src/release/deps.ts")).installDependencies({ ...input, limits });
  return { input, run, calls, requests, checkout, bin };
}

describe("runner-owned dependency execution", () => {
  it.each(["npm", "pnpm"])("runs pinned %s without scripts in the restricted network sandbox", async manager => {
    const f = await fixture(manager); const promise = f.run(); await expect(promise).resolves.toMatchObject({ manager }); const result = await promise;
    expect(result).toMatchObject({ manager }); expect(f.calls).toHaveLength(1);
    const r = f.calls[0]!;
    expect(r.command).toContain(process.execPath); expect(r.command).toContain(f.bin);
    expect(r.policy.allowedDomains).toEqual(["registry.npmjs.org"]);
    expect(r.policy.allowLocalBinding).toBe(false); expect(r.policy.allowUnixSockets).toEqual([]);
    expect(r.policy.denyRead).toEqual(f.input.policy.denyRead);
    expect(r.policy.allowWrite).not.toContain(f.input.pins.npm.root);
    expect(r.timeoutMs).toBe(300_000); expect(r.maxOutputBytes).toBe(4 * 1024 * 1024);
    expect(r.env.HOME).toMatch(/dependency-home$/); expect(r.env.npm_config_cache).toMatch(/dependency-cache$/);
    expect(r.env.npm_config_ignore_scripts).toBe("true"); expect(r.env.npm_config_registry).toBe("https://registry.npmjs.org/");
    expect(r.env.npm_config_globalconfig).toBe(join(r.env.HOME!, "global.npmrc"));
    expect(r.env.PATH).toBe("/usr/bin:/bin"); expect(r.env.NODE_OPTIONS).toBeUndefined();
    expect(f.requests).toEqual(["registry.npmjs.org"]);
    expect(existsSync(join(f.checkout, "SHOULD_NOT_EXIST"))).toBe(false);
    expect(readFileSync(join(f.checkout, "node_modules/tiny.js"), "utf8")).toContain("value = 1");
    expect(r.command).toContain(manager === "npm" ? 'ci' : '--frozen-lockfile');
    if (manager === "pnpm") expect(r.command).toContain('--ignore-pnpmfile');
  });
  it.each([
    ["size", { maxBytes: 512 }, /size/], ["count", { maxFiles: 8 }, /file count/],
    ["live-size", { maxBytes: 512, timeoutMs: 2000 }, /size/],
    ["timeout", { timeoutMs: 100 }, /timed out/], ["output", { maxOutputBytes: 64 }, /output/],
    ["exit", {}, /exited/], ["escape", {}, /outside/], ["wrong-version", {}, /pin/],
  ])("refuses %s and never reports success", async (mode, limits, reason) => {
    const f = await fixture("npm", mode); await expect(f.run(limits)).rejects.toThrow(reason);
  });
  it("refuses a candidate-owned tool pin before any sandbox process", async () => {
    const f = await fixture(); f.input.pins.npm.bin = join(f.checkout, "package.json"); f.input.pins.npm.root = f.checkout;
    await expect(f.run()).rejects.toThrow(/pin/); expect(f.calls).toEqual([]);
  });
  it("refuses a relative tool pin before any sandbox process", async () => {
    const f = await fixture(); f.input.pins.npm.bin = "npm";
    await expect(f.run()).rejects.toThrow(/pin/); expect(f.calls).toEqual([]);
  });
  it("refuses a declared version that differs from the runner pin", async () => {
    const f = await fixture(); f.input.pins.npm.version = "0.0.0";
    await expect(f.run()).rejects.toThrow(/pin/); expect(f.calls).toEqual([]);
  });
});
