import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Ledger, LedgerTamperError } from "../../packages/cli/src/ledger/ledger.ts";
import { register as registerSteer } from "../../packages/cli/src/commands/steer.ts";
import { readRunStatus, register as registerStatus } from "../../packages/cli/src/commands/status.ts";

const commanderPath = createRequire(new URL("../../packages/cli/package.json", import.meta.url)).resolve("commander");
const { Command } = await import(pathToFileURL(commanderPath).href) as typeof import("../../packages/cli/node_modules/commander/typings/index.js");
const roots: string[] = [];
const fresh = () => { const root = mkdtempSync(join(tmpdir(), "jarvis-command-")); roots.push(root); return root; };
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
const program = () => new Command().exitOverride().configureOutput({ writeErr: () => undefined });

describe("project-bound steer and read-only status", () => {
  it.each(["flag", "env"] as const)("steer selects the protected project through %s and prints the file it wrote", async (source) => {
    const jarvisHome = fresh(); const output: string[] = []; const cli = program();
    registerSteer(cli, { jarvisHome, env: source === "env" ? { JARVIS_PROJECT: "demo" } : {}, output: (s) => output.push(s) });
    await cli.parseAsync(["steer", "approve email.send", ...(source === "flag" ? ["--project", "demo"] : [])], { from: "user" });
    const dir = join(jarvisHome, "projects", "demo", "inbox"); const [file] = readdirSync(dir);
    expect(JSON.parse(readFileSync(join(dir, file!), "utf8"))).toEqual({ note: "approve email.send" });
    expect(output.join(" ")).toContain(join(dir, file!));
    expect(readdirSync(join(jarvisHome, "projects", "demo"))).toEqual(["inbox"]);
  });

  it("requires an explicit project or JARVIS_PROJECT and rejects traversal", async () => {
    const jarvisHome = fresh();
    for (const args of [["steer", "note"], ["steer", "note", "--project", "../bad"]]) {
      const cli = program(); registerSteer(cli, { jarvisHome, env: {}, output: () => undefined });
      await expect(cli.parseAsync(args, { from: "user" })).rejects.toThrow();
    }
    expect(readdirSync(jarvisHome)).toEqual([]);
  });

  it("status returns runner-core RunState and changes no files", async () => {
    const jarvisHome = fresh(); const dir = join(jarvisHome, "projects", "demo"); const ledger = Ledger.open(dir);
    ledger.append({ kind: "task_created", actor: "runner", task_id: "T1", data: { title: "Login", storyIds: ["S1"] } });
    const before = readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), "utf8")]);
    const result = readRunStatus(dir, { now: () => 123 });
    expect(result.status).toBe("ready");
    if (result.status === "ready") expect(result.state.tasks.T1?.definition.storyIds).toEqual(["S1"]);
    const cli = program(); const output: string[] = []; registerStatus(cli, { jarvisHome, now: () => 123, env: {}, output: (s) => output.push(s) });
    await cli.parseAsync(["status", "--project", "demo"], { from: "user" });
    expect(output.join(" ")).toContain("T1"); expect(output.join(" ")).toContain("not-reached");
    expect(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), "utf8")])).toEqual(before);
  });

  it("reports contention separately from ledger tampering", async () => {
    const jarvisHome = fresh(); const dir = join(jarvisHome, "projects", "demo"); Ledger.open(dir).append({ kind: "steer", actor: "runner", data: { note: "T1" } });
    const verify = () => ({ ok: false, contended: true, entries: [], repairable: [], problems: ["writers kept the ledger moving"] });
    expect(() => readRunStatus(dir, { verify })).not.toThrow();
    expect(readRunStatus(dir, { verify })).toMatchObject({ status: "contended" });
    const cli = program(); const output: string[] = []; registerStatus(cli, { jarvisHome, env: {}, verify, output: (s) => output.push(s) });
    await cli.parseAsync(["status", "--project", "demo"], { from: "user" });
    expect(output.join(" ")).toMatch(/contended/i); expect(output.join(" ")).not.toMatch(/tamper/i);
  });

  it("still fails closed on tampering and never creates unknown projects", async () => {
    const jarvisHome = fresh(); const dir = join(jarvisHome, "projects", "demo"); const ledger = Ledger.open(dir);
    ledger.append({ kind: "steer", actor: "runner", data: { note: "original" } }); writeFileSync(join(dir, "head.hash"), "f".repeat(64));
    expect(() => readRunStatus(dir)).toThrow(LedgerTamperError);
    const cli = program(); registerStatus(cli, { jarvisHome, env: {}, output: () => undefined });
    await expect(cli.parseAsync(["status", "--project", "missing"], { from: "user" })).rejects.toThrow();
    expect(readdirSync(join(jarvisHome, "projects"))).toEqual(["demo"]);
  });
});
