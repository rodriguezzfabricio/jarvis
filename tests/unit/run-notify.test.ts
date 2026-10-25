import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runNotifications } from "../../packages/cli/src/commands/run-notify.ts";
import type { Message, Notifier } from "../../packages/cli/src/notify/notifier.ts";
import type { NtfyOptions } from "../../packages/cli/src/notify/ntfy.ts";
import { shortTmp } from "../helpers.ts";

// `jarvis run` reaches Fabricio through the runner's notifier (decision 50): blocked tasks, long usage
// waits and the end of the run. A missing or broken notifier config never blocks the run (decision 91):
// the run goes on and says the notification wasn't delivered, naming the config, never its contents.
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));
const SECRET_TOPIC = "fake-private-capability-7f3a";
const CONFIG = { baseUrl: "https://example.invalid", topic: SECRET_TOPIC, replyTopic: `${SECRET_TOPIC}-reply` };

function setup(config: unknown = CONFIG, send: Notifier["send"] = async () => {}) {
  const root = shortTmp("j-rnotify-"); roots.push(root);
  const configPath = join(root, "notify.json");
  if (config !== null) writeFileSync(configPath, typeof config === "string" ? config : JSON.stringify(config), { mode: 0o600 });
  const sent: Message[] = [];
  const warnings: string[] = [];
  const created: NtfyOptions[] = [];
  const notifier: Notifier = { send: vi.fn(async (message: Message, actions) => { sent.push(message); await send(message, actions); }), poll: async () => [] };
  const make = (extra: Partial<Parameters<typeof runNotifications>[0]> = {}) => runNotifications({
    configPath, project: "proj-1234abcd", warn: (text) => warnings.push(text),
    createNotifier: (c) => { created.push(c); return notifier; }, ...extra,
  });
  return { root, configPath, sent, warnings, created, notifier, make };
}
const blocked = { taskId: "T1", reason: "protected check changed" };
const usage = { taskId: "T2", resumeAt: Date.UTC(2026, 9, 25, 14, 30), waitMs: 3 * 60 * 60 * 1000 };

describe("jarvis run notifications", () => {
  it("sends a blocked task, a long usage wait and the finished run through the configured notifier, without buttons", async () => {
    const s = setup();
    const n = s.make();
    await n.blocked(blocked);
    await n.usageWait(usage);
    await n.finished({ status: "blocked", summary: "not-reached. 1/2 done; 0 Taste decisions to check; 1 blocked. Reply here to steer." });
    expect(s.created).toEqual([{ baseUrl: CONFIG.baseUrl, topic: CONFIG.topic, replyTopic: CONFIG.replyTopic }]);
    expect(s.sent.map((m) => m.kind)).toEqual(["blocked", "usage-wait", "finished"]);
    expect(s.sent[0]!.text).toMatch(/proj-1234abcd.*T1.*blocked.*protected check changed/s);
    expect(s.sent[1]).toMatchObject({ kind: "usage-wait", waitMs: usage.waitMs });
    expect(s.sent[1]!.text).toMatch(/usage limit.*T2/is);
    expect(s.sent[2]!.text).toMatch(/run blocked.*1\/2 done/s);
    for (const call of vi.mocked(s.notifier.send).mock.calls) expect(call[1]).toEqual([]);
    expect(s.warnings).toEqual([]);
  });

  it("says when the run stopped with an error, with no error text in the message", async () => {
    const s = setup();
    await s.make().finished({ status: "error" });
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({ kind: "finished" });
    expect(s.sent[0]!.text).toMatch(/stopped with an error/);
  });

  it("a missing config never blocks: every notice resolves and says it wasn't delivered, naming the config", async () => {
    const s = setup(null);
    const n = s.make();
    expect(s.warnings).toEqual([expect.stringContaining(s.configPath)]);
    expect(s.warnings[0]).toMatch(/Notifications are off for this run/);
    await expect(n.blocked(blocked)).resolves.toBeUndefined();
    await expect(n.usageWait(usage)).resolves.toBeUndefined();
    await expect(n.finished({ status: "complete", summary: "x" })).resolves.toBeUndefined();
    expect(s.created).toEqual([]);
    expect(s.warnings.slice(1)).toHaveLength(3);
    for (const w of s.warnings.slice(1)) {
      expect(w).toMatch(/^Notification not delivered/);
      expect(w).toContain(s.configPath);
    }
  });

  for (const [label, config] of [
    ["not JSON", `{"topic":"${SECRET_TOPIC}"`],
    ["the wrong shape", { ...CONFIG, extra: SECRET_TOPIC }],
    ["missing a topic", { baseUrl: CONFIG.baseUrl, replyTopic: SECRET_TOPIC }],
    ["plain http to a public host", { ...CONFIG, baseUrl: "http://ntfy.example" }],
  ] as const) {
    it(`a broken config (${label}) never blocks and never prints its contents`, async () => {
      const s = setup(config);
      // The production adapter (NtfyNotifier, which validates the URL and topics); nothing is sent.
      const n = runNotifications({ configPath: s.configPath, project: "proj-1234abcd", warn: (text) => s.warnings.push(text) });
      await n.blocked(blocked);
      await n.finished({ status: "complete", summary: "x" });
      expect(s.sent).toEqual([]);
      expect(s.warnings.length).toBeGreaterThanOrEqual(3);
      expect(s.warnings[0]).toMatch(/not a valid notifier configuration/);
      for (const w of s.warnings) {
        expect(w).toContain(s.configPath);
        expect(w).not.toContain(SECRET_TOPIC);
      }
    });
  }

  it("refuses a symlinked config without reading it", async () => {
    const s = setup(null);
    const elsewhere = join(s.root, "elsewhere.json");
    writeFileSync(elsewhere, JSON.stringify(CONFIG));
    symlinkSync(elsewhere, s.configPath);
    await s.make().blocked(blocked);
    expect(s.created).toEqual([]);
    expect(s.warnings[0]).toMatch(/not a valid notifier configuration/);
  });

  it("an unreadable config is broken, not missing, and still never blocks", async () => {
    const s = setup();
    chmodSync(s.configPath, 0o000);
    try {
      await expect(s.make().blocked(blocked)).resolves.toBeUndefined();
      expect(s.created).toEqual([]);
      expect(s.warnings[0]).toMatch(/not a valid notifier configuration/);
    } finally { chmodSync(s.configPath, 0o600); }
  });

  it("a notifier that can't be built is a broken config", async () => {
    const s = setup();
    const n = s.make({ createNotifier: () => { throw new Error(`bad topic ${SECRET_TOPIC}`); } });
    await expect(n.blocked(blocked)).resolves.toBeUndefined();
    expect(s.warnings.join("\n")).not.toContain(SECRET_TOPIC);
    expect(s.warnings[0]).toMatch(/not a valid notifier configuration/);
  });

  it("a failed send never blocks, and its warning names the config but never the topic", async () => {
    const s = setup(CONFIG, async () => { throw new Error(`publish to https://example.invalid/${SECRET_TOPIC} failed\nHTTP 502`); });
    const n = s.make();
    await expect(n.blocked(blocked)).resolves.toBeUndefined();
    await expect(n.usageWait(usage)).resolves.toBeUndefined();
    expect(s.warnings).toHaveLength(2);
    expect(s.warnings[0]).toMatch(/^Notification not delivered \(T1 blocked\)/);
    expect(s.warnings[1]).toMatch(/^Notification not delivered \(usage wait\)/);
    for (const w of s.warnings) {
      expect(w).toContain(s.configPath);
      expect(w).not.toContain(SECRET_TOPIC);
      expect(w).not.toContain("\n");
    }
  });

  it("a send that never answers is given up on, so the loop isn't held", async () => {
    const s = setup(CONFIG, () => new Promise<void>(() => {}));
    const n = s.make({ timeoutMs: 50 });
    const started = Date.now();
    await expect(n.blocked(blocked)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(s.warnings[0]).toMatch(/^Notification not delivered \(T1 blocked\).*timed out/);
  });

  it("reads the config once, at the start of the run", async () => {
    const s = setup();
    const n = s.make();
    rmSync(s.configPath);
    mkdirSync(s.configPath);
    await n.blocked(blocked);
    await n.blocked({ taskId: "T3", reason: "repair budget used up" });
    expect(s.created).toHaveLength(1);
    expect(s.sent.map((m) => m.kind)).toEqual(["blocked", "blocked"]);
  });
});
