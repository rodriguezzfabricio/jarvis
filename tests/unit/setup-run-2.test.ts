// Setup run tests, part 2 of 2 (notify.json, the Claude check, the plugin, the taste profile). The tests are split over two files so they run in parallel;
// the shared fixture is tests/unit/helpers/setup-run-fixture.ts.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { notifyConfigSchema } from "../../packages/cli/src/intake/commands.ts";
import { envFileSecretsWriter, type SecretsWriter } from "../../packages/cli/src/broker/secrets.ts";
import { runSetup } from "../../packages/cli/src/setup/setup.ts";
import { PLUGIN, TASTE, deps, failure, fakeNotifier, fakeSecrets, fakeTty, installSetupHooks, makeHome, state } from "./helpers/setup-run-fixture.ts";

installSetupHooks();

it("keeps an existing notify.json the phone already subscribes to, unless --redo ntfy", async () => {
  const home = makeHome(); mkdirSync(join(home, ".jarvis"), { mode: 0o700 });
  const path = join(home, ".jarvis", "notify.json");
  const existing = `${JSON.stringify({ baseUrl: "https://ntfy.sh", topic: "jarvis-existingtopic0123456789ab", replyTopic: "jarvis-existingtopic0123456789ab-reply" })}\n`;
  writeFileSync(path, existing, { mode: 0o600 });
  const answers = () => fakeTty(["n", "", "", "", "", "", "n"], []).tty;
  await runSetup(deps(home, answers(), { secrets: fakeSecrets().backend }).d, {});
  expect(readFileSync(path, "utf8")).toBe(existing);
  expect(state(home).steps.ntfy?.detail).toMatch(/kept/i);
  const r = deps(home, answers(), { secrets: fakeSecrets().backend });
  await runSetup(r.d, { redo: ["ntfy"] });
  expect(readFileSync(path, "utf8")).not.toBe(existing);
  expect(r.text()).toMatch(/unsubscribe/i);
});

it("keeps the stage 0 notify.json (backend, server, topic, reply_topic) as it is, and --send-test uses its topics", async () => {
  const home = makeHome(); mkdirSync(join(home, ".jarvis"), { mode: 0o700 });
  const path = join(home, ".jarvis", "notify.json");
  const stage0 = `${JSON.stringify({ backend: "ntfy", server: "https://ntfy.sh", topic: "jarvis-stagezerotopic0123456789", reply_topic: "jarvis-stagezerotopic0123456789-reply" })}\n`;
  writeFileSync(path, stage0, { mode: 0o600 });
  await runSetup(deps(home, fakeTty(["n", "", "", "", "", "", "n"], []).tty, { secrets: fakeSecrets().backend }).d, {});
  expect(readFileSync(path, "utf8")).toBe(stage0);
  expect(state(home).steps.ntfy).toMatchObject({ status: "done", detail: expect.stringMatching(/kept/i) });
  const n = fakeNotifier();
  expect((await runSetup(deps(home, fakeTty([], []).tty, { secrets: fakeSecrets().backend, createNotifier: n.createNotifier }).d, { sendTest: true })).ok).toBe(true);
  expect(n.configs).toEqual([{ baseUrl: "https://ntfy.sh", topic: "jarvis-stagezerotopic0123456789", replyTopic: "jarvis-stagezerotopic0123456789-reply" }]);
});

it("refuses an invalid or symlinked notify.json without changing it", async () => {
  for (const kind of ["invalid", "symlink"] as const) {
    const home = makeHome(); mkdirSync(join(home, ".jarvis"), { mode: 0o700 });
    const path = join(home, ".jarvis", "notify.json"); const outside = join(home, "outside.json");
    if (kind === "invalid") writeFileSync(path, "{\"topic\":1}", { mode: 0o600 });
    else { writeFileSync(outside, "keep"); symlinkSync(outside, path); }
    const result = await runSetup(deps(home, fakeTty(["n", "", "", "", "", "", "n"], []).tty, { secrets: fakeSecrets().backend }).d, kind === "symlink" ? { redo: ["ntfy"] } : {});
    expect(result.ok).toBe(false);
    expect(state(home).steps.ntfy?.status).toBe("failed");
    if (kind === "invalid") expect(readFileSync(path, "utf8")).toBe("{\"topic\":1}");
    else { expect(lstatSync(path).isSymbolicLink()).toBe(true); expect(readFileSync(outside, "utf8")).toBe("keep"); }
  }
});

it("--send-test sends one notification through the notifier with the written topics", async () => {
  const home = makeHome(); const n = fakeNotifier();
  await runSetup(deps(home, fakeTty(["n", "", "", "", "", "", "n"], []).tty, { secrets: fakeSecrets().backend, createNotifier: n.createNotifier }).d, {});
  expect(n.sent).toEqual([]);
  const r = deps(home, fakeTty([], []).tty, { secrets: fakeSecrets().backend, createNotifier: n.createNotifier });
  expect((await runSetup(r.d, { sendTest: true })).ok).toBe(true);
  const config = notifyConfigSchema.parse(JSON.parse(readFileSync(join(home, ".jarvis", "notify.json"), "utf8")));
  expect(n.configs).toHaveLength(1);
  expect(n.configs[0]).toMatchObject({ baseUrl: config.baseUrl, topic: config.topic, replyTopic: config.replyTopic });
  expect(n.sent).toHaveLength(1);
  expect(n.sent[0]?.actions).toEqual([]);
  expect(n.sent[0]?.message.text).toMatch(/test/i);
  const failing = deps(home, fakeTty([], []).tty, { secrets: fakeSecrets().backend, createNotifier: () => ({ send: async () => { throw new Error("ntfy publish HTTP 500"); }, poll: async () => [] }) });
  expect((await runSetup(failing.d, { sendTest: true })).ok).toBe(false);
  expect(failing.text()).toMatch(/test notification failed/i);
});

it("a wrong or missing Claude Code fails its step, and the next run checks again", async () => {
  const home = makeHome(); const s = fakeSecrets();
  const answers = () => fakeTty(["n", "", "", "", "", "", "n"], []).tty;
  const r = deps(home, answers(), { secrets: s.backend, exec: () => "2.1.270 (Claude Code)" });
  const result = await runSetup(r.d, {});
  expect(result.ok).toBe(false); expect(result.pending).toEqual(["claude"]);
  expect(state(home).steps.claude?.status).toBe("failed");
  expect(r.text()).toMatch(/2\.1\.270/);
  const missing = deps(home, fakeTty([], []).tty, { secrets: s.backend, exists: () => false });
  expect((await runSetup(missing.d, {})).ok).toBe(false);
  expect(missing.text()).toMatch(/missing/);
  const fixed = deps(home, fakeTty([], []).tty, { secrets: s.backend });
  expect((await runSetup(fixed.d, {})).ok).toBe(true);
  expect(state(home).steps.claude?.status).toBe("done");
});

it("a broken plugin source fails the plugin step and leaves no half-installed copy; a symlinked install folder is refused", async () => {
  const home = makeHome();
  const broken = join(makeHome(), "plugin"); mkdirSync(join(broken, ".claude-plugin"), { recursive: true });
  writeFileSync(join(broken, ".claude-plugin", "plugin.json"), "{\"name\":\"jarvis\",\"version\":\"0.1.0\"}");
  const r = deps(home, fakeTty(["n", "", "", "", "", "", "n"], []).tty, { secrets: fakeSecrets().backend, pluginSource: broken });
  expect((await runSetup(r.d, {})).ok).toBe(false);
  expect(state(home).steps.plugin?.status).toBe("failed");
  expect(existsSync(join(home, ".jarvis", "plugin"))).toBe(false);

  const other = makeHome(); mkdirSync(join(other, ".jarvis"), { mode: 0o700 });
  const elsewhere = join(other, "elsewhere"); mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(other, ".jarvis", "plugin"));
  // An installed plugin that is a symlink is refused before anything is asked (Codex review, finding 1).
  const otherTty = fakeTty(["n", "", "", "", "", "", "n"], []);
  expect(String(await failure(runSetup(deps(other, otherTty.tty, { secrets: fakeSecrets().backend }).d, {})))).toMatch(/symlink/i);
  expect(otherTty.calls).toEqual([]);
  expect(readdirSync(elsewhere)).toEqual([]);
});

it("--redo plugin replaces an installed copy with the repo's plugin", async () => {
  const home = makeHome(); const s = fakeSecrets();
  await runSetup(deps(home, fakeTty(["n", "", "", "", "", "", "n"], []).tty, { secrets: s.backend }).d, {});
  const tripwire = join(home, ".jarvis", "plugin", "hooks", "tripwire.mjs");
  writeFileSync(tripwire, "// stale\n");
  await runSetup(deps(home, fakeTty([], []).tty, { secrets: s.backend }).d, { redo: ["plugin"] });
  expect(readFileSync(tripwire, "utf8")).toBe(readFileSync(join(PLUGIN, "hooks", "tripwire.mjs"), "utf8"));
  expect(readdirSync(join(home, ".jarvis")).filter((x) => x.startsWith(".plugin"))).toEqual([]);
});

it("offers the taste profile once: declining is recorded, and an existing profile counts as done", async () => {
  const home = makeHome(); const s = fakeSecrets();
  await runSetup(deps(home, fakeTty(["n", "", "", "", "", "", "n"], []).tty, { secrets: s.backend }).d, {});
  expect(state(home).steps.taste?.status).toBe("skipped");
  expect(existsSync(join(home, ".jarvis/memory/user/taste.json"))).toBe(false);
  // An invalid profile (two admired apps) is asked again, then saved.
  const retry = fakeTty(["y", "One, Two", "AI app", "serious", "", "", "web", ...TASTE], []);
  await runSetup(deps(home, retry.tty, { secrets: s.backend }).d, { redo: ["taste"] });
  expect(state(home).steps.taste?.status).toBe("done");
  expect(JSON.parse(readFileSync(join(home, ".jarvis/memory/user/taste.json"), "utf8")).admired).toEqual(["Linear", "Things", "Stripe"]);
  const other = makeHome(); mkdirSync(join(other, ".jarvis/memory/user"), { recursive: true, mode: 0o700 });
  writeFileSync(join(other, ".jarvis/memory/user/taste.json"), "{}");
  const t = fakeTty(["n", "", "", "", "", ""], []);
  await runSetup(deps(other, t.tty, { secrets: s.backend }).d, {});
  expect(t.calls.some((c) => /taste/i.test(c.prompt))).toBe(false);
  expect(state(other).steps.taste?.status).toBe("done");
});

it("leaves accounts unfinished when the secrets backend can't be prepared", async () => {
  const home = makeHome();
  const backend: SecretsWriter = { location: "broken", prepare: () => { throw new Error("secrets folder must be owner only"); }, set: vi.fn() };
  // Enough answers to skip every account, so a run that wrongly asks still finishes and the assertions decide.
  const r = deps(home, fakeTty(["n", "", "", "", "", "", "n"], []).tty, { secrets: backend });
  const result = await runSetup(r.d, {});
  expect(result.ok).toBe(false);
  expect(state(home).steps.secrets?.status).toBe("failed");
  expect(state(home).steps["accounts.github"]?.status).toBe("failed");
  expect(backend.set).not.toHaveBeenCalled();
  expect(result.pending).toContain("accounts.github");
});

it("the real env-file writer is the default backend", () => {
  const w = envFileSecretsWriter("/nonexistent/x.env");
  expect(w.location).toBe("/nonexistent/x.env");
});

it("accounts.deploy offers Render and hands it to the key-generating Render step with the runner home and the secrets backend", async () => {
  const home = makeHome(); const s = fakeSecrets(); const n = fakeNotifier();
  const lines = ["y", "render", "", "y", "n", "y", "y", ...TASTE];
  const hidden = ["SENTINEL-github-0123456789", "SENTINEL-cf-0123456789", "SENTINEL-oauth-id-0123", "SENTINEL-oauth-secret-0123"];
  const t = fakeTty(lines, hidden); const calls: { privateRoot: string; secrets: SecretsWriter }[] = [];
  const renderSetup = async (o: { privateRoot: string; secrets: SecretsWriter; print(text: string): void }) => {
    calls.push({ privateRoot: o.privateRoot, secrets: o.secrets }); o.print("Preview public deploy key: ssh-ed25519 DUMMY-public");
    o.secrets.set("RENDER_PREVIEW_DEPLOY_KEY", "RFVNTVkgcHJldmlldw==", { brokerOnly: true }); o.secrets.set("RENDER_PRODUCTION_DEPLOY_KEY", "RFVNTVkgcHJvZHVjdGlvbg==", { brokerOnly: true });
    return { status: "done" as const, provider: "render", detail: "generated two broker-only repository deploy keys",
      secrets: [{ key: "RENDER_PREVIEW_DEPLOY_KEY", tier: "preview" as const, brokerOnly: true }, { key: "RENDER_PRODUCTION_DEPLOY_KEY", tier: "production" as const, brokerOnly: true }] };
  };
  const r = deps(home, t.tty, { secrets: s.backend, createNotifier: n.createNotifier, renderSetup });
  expect((await runSetup(r.d, {})).ok).toBe(true);
  expect(t.calls.find((c) => c.prompt.startsWith("Deploy host"))?.prompt).toMatch(/render/i);
  expect(calls).toEqual([{ privateRoot: join(home, ".jarvis"), secrets: s.backend }]);
  const step = state(home).steps["accounts.deploy"];
  expect(step).toMatchObject({ status: "done", provider: "render" });
  expect(step?.secrets).toEqual([{ key: "RENDER_PREVIEW_DEPLOY_KEY", tier: "preview", brokerOnly: true }, { key: "RENDER_PRODUCTION_DEPLOY_KEY", tier: "production", brokerOnly: true }]);
  expect(s.stored.get("RENDER_PRODUCTION_DEPLOY_KEY")).toEqual({ value: "RFVNTVkgcHJvZHVjdGlvbg==", brokerOnly: true });
  expect(r.text()).toContain("DUMMY-public");
});
