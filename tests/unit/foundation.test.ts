import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Broker } from "../../packages/cli/src/broker/broker.ts";
import { startBrokerServer } from "../../packages/cli/src/broker/server.ts";
import { ChecksStore } from "../../packages/cli/src/checks/store.ts";
import { foundationChecks } from "../../packages/cli/src/doctor/foundation.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { shortTmp } from "../helpers.ts";

const root = shortTmp("jtd-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const pluginDir = fileURLToPath(new URL("../../plugin", import.meta.url));
const level = (cs: { name: string; level: string }[], n: string) => cs.find((c) => c.name === n)?.level;

describe("doctor foundation checks (stage 1)", () => {
  it.each([
    ["missing SessionStart", (hooks: Record<string, unknown>) => { delete hooks.SessionStart; }],
    ["empty PreToolUse", (hooks: Record<string, unknown>) => { hooks.PreToolUse = []; }],
    ["empty nested PreToolUse hooks", (hooks: Record<string, unknown>) => {
      hooks.PreToolUse = [{ matcher: "Bash|Read|Edit|Write|Glob|Grep", hooks: [] }];
    }],
    ["wrong PreToolUse matcher", (hooks: Record<string, unknown>) => {
      hooks.PreToolUse = [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/tripwire.mjs"' }] }];
    }],
    ["asynchronous tripwire", (hooks: Record<string, unknown>) => {
      hooks.PreToolUse = [{ matcher: "Bash|Read|Edit|Write|Glob|Grep", hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/tripwire.mjs"', async: true }] }];
    }],
    ["tripwire with tiny timeout", (hooks: Record<string, unknown>) => {
      hooks.PreToolUse = [{ matcher: "Bash|Read|Edit|Write|Glob|Grep", hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/tripwire.mjs"', timeout: 1 }] }];
    }],
    ["unexpected hook command", (hooks: Record<string, unknown>) => {
      hooks.PreToolUse = [{ matcher: "Bash|Read|Edit|Write|Glob|Grep", hooks: [{ type: "command", command: "node other.mjs" }] }];
    }],
    ["unexpected SessionStart command", (hooks: Record<string, unknown>) => {
      hooks.SessionStart = [{ hooks: [{ type: "command", command: "node other.mjs" }] }];
    }],
    ["restrictive SessionStart matcher", (hooks: Record<string, unknown>) => {
      hooks.SessionStart = [{ matcher: "resume", hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"' }] }];
    }],
    ["empty nested SessionStart hooks", (hooks: Record<string, unknown>) => {
      hooks.SessionStart = [{ hooks: [] }];
    }],
    ["missing required SessionStart script", (_hooks: Record<string, unknown>) => {}, "session-start.mjs"],
  ])("fails when the plugin has %s", async (_case, mutate, missingScript?: string) => {
    const dir = join(root, `plugin-${Math.random()}`);
    mkdirSync(join(dir, "hooks"), { recursive: true });
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    const manifest = JSON.parse(readFileSync(join(pluginDir, "hooks", "hooks.json"), "utf8")) as { hooks: Record<string, unknown> };
    mutate(manifest.hooks);
    writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify(manifest));
    writeFileSync(join(dir, "hooks", "tripwire.mjs"), "");
    writeFileSync(join(dir, "hooks", "session-start.mjs"), "");
    if (missingScript) rmSync(join(dir, "hooks", missingScript));
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), readFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8"));
    const cs = await foundationChecks({ jarvisHome: join(root, "empty"), pluginDir: dir, socketPath: join(root, "none.sock") });
    expect(level(cs, "plugin")).toBe("fail");
  });

  it("fails when the plugin manifest has the wrong name or lacks a version", async () => {
    const dir = join(root, "plugin-invalid-manifest");
    mkdirSync(join(dir, "hooks"), { recursive: true });
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(dir, "hooks", "hooks.json"), readFileSync(join(pluginDir, "hooks", "hooks.json"), "utf8"));
    writeFileSync(join(dir, "hooks", "tripwire.mjs"), "");
    writeFileSync(join(dir, "hooks", "session-start.mjs"), "");
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "other" }));
    const cs = await foundationChecks({ jarvisHome: join(root, "empty"), pluginDir: dir, socketPath: join(root, "none.sock") });
    expect(level(cs, "plugin")).toBe("fail");
  });

  it("passes on an intact foundation, with a live broker and a working checks sandbox", async () => {
    const jh = join(root, "jh1");
    const l = Ledger.open(join(jh, "projects", "p"));
    l.append({ kind: "steer", actor: "runner", data: {} });
    mkdirSync(join(jh, "secrets"), { recursive: true });
    writeFileSync(join(jh, "secrets", "p.env"), "X=1\n", { mode: 0o600 });
    const sock = join(jh, "b.sock");
    const server = await startBrokerServer(new Broker({ ledger: l, project: "p", adapters: [], secrets: { get: () => undefined } }), sock);
    try {
      const cs = await foundationChecks({ jarvisHome: jh, pluginDir, socketPath: sock });
      expect(cs.filter((c) => c.level === "fail")).toEqual([]);
      expect(level(cs, "broker")).toBe("pass");
      expect(level(cs, "plugin")).toBe("pass");
      if (process.platform === "darwin") expect(level(cs, "checks_sandbox")).toBe("pass");
    } finally {
      await server.close();
    }
  });

  // Codex review 7, medium: an approved project whose checks.lock was deleted must not look healthy.
  it("fails when an approved project's checks.lock is missing", async () => {
    const jh = join(root, "jh3");
    const dir = join(jh, "projects", "p");
    const l = Ledger.open(dir);
    mkdirSync(join(dir, "checks"), { recursive: true });
    writeFileSync(join(dir, "checks", "unit.sh"), "exit 1\n");
    new ChecksStore(dir).approve(l, "v1");
    rmSync(join(dir, "checks.lock"));
    const cs = await foundationChecks({ jarvisHome: jh, pluginDir, socketPath: join(jh, "none.sock") });
    expect(level(cs, "checks.p")).toBe("fail");
  });

  it("fails on a tampered ledger and an over-readable secrets file", async () => {
    const jh = join(root, "jh2");
    const dir = join(jh, "projects", "p");
    Ledger.open(dir).append({ kind: "steer", actor: "runner", data: { a: 1 } });
    writeFileSync(join(dir, "ledger.jsonl"), '{"seq":1}\n');
    mkdirSync(join(jh, "secrets"), { recursive: true });
    writeFileSync(join(jh, "secrets", "p.env"), "X=1\n", { mode: 0o644 });
    const cs = await foundationChecks({ jarvisHome: jh, pluginDir, socketPath: join(jh, "none.sock") });
    expect(level(cs, "ledger.p")).toBe("fail");
    expect(level(cs, "secrets.p.env")).toBe("fail");
    expect(level(cs, "broker")).toBe("warn");
  });
});
