import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pinnedClaudeBin } from "../../packages/cli/src/config/pins.ts";
import { checkPlugin } from "../../packages/cli/src/doctor/foundation.ts";
import { notifyConfigSchema } from "../../packages/cli/src/intake/commands.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import type { Action, Message, Notifier } from "../../packages/cli/src/notify/notifier.ts";
import { NtfyNotifier, type NtfyOptions } from "../../packages/cli/src/notify/ntfy.ts";
import { envFileSecrets, envFileSecretsWriter, type SecretsWriter } from "../../packages/cli/src/broker/secrets.ts";
import { runSetup, type SetupDeps } from "../../packages/cli/src/setup/setup.ts";
import { STEPS } from "../../packages/cli/src/setup/state.ts";
import { InterruptedError, type Tty } from "../../packages/cli/src/setup/tty.ts";

/** The rejection of a promise, or undefined: a mismatch then fails as a plain assertion. */
async function failure(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error) { return error; }
  return undefined;
}

const PLUGIN = fileURLToPath(new URL("../../plugin", import.meta.url));
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SENTINEL = "SENTINEL-c0ffee-TOKEN-0123456789";
const dirs: string[] = [];
let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchSpy = vi.fn(async () => { throw new Error("setup must not reach the network"); }); vi.stubGlobal("fetch", fetchSpy); });
afterEach(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A scripted terminal: ordinary answers and hidden answers come from separate queues; running out is Ctrl-C. */
function fakeTty(lines: string[], hidden: string[]) {
  const calls: { kind: "ask" | "hidden"; prompt: string }[] = [];
  const tty: Tty = {
    ask: async (prompt) => { calls.push({ kind: "ask", prompt }); const v = lines.shift(); if (v === undefined) throw new InterruptedError(); return v; },
    askHidden: async (prompt) => { calls.push({ kind: "hidden", prompt }); const v = hidden.shift(); if (v === undefined) throw new InterruptedError(); return v; },
    close: () => {},
  };
  return { tty, calls, lines, hidden };
}
function fakeSecrets() {
  const stored = new Map<string, { value: string; brokerOnly: boolean }>();
  const backend: SecretsWriter = { location: "the fake secrets backend", prepare: vi.fn(), set: vi.fn((key: string, value: string, meta: { brokerOnly: boolean }) => { stored.set(key, { value, ...meta }); }) };
  return { backend, stored };
}
function fakeNotifier() {
  const sent: { message: Message; actions: readonly Action[] }[] = [];
  const configs: NtfyOptions[] = [];
  const notifier: Notifier = { send: async (message, actions) => { sent.push({ message, actions }); }, poll: async () => [] };
  return { sent, configs, createNotifier: (config: NtfyOptions) => { configs.push(config); return notifier; } };
}
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "jarvis-setup-")); dirs.push(home);
  return home;
}
function deps(home: string, tty: Tty, extra: Partial<SetupDeps> = {}) {
  const out: string[] = [];
  const claude = pinnedClaudeBin(home);
  const d: SetupDeps = {
    home, tty, print: (text) => { out.push(text); }, pluginSource: PLUGIN, repoRoot: REPO,
    exists: (p) => p === claude || existsSync(p), exec: () => "2.1.309 (Claude Code)", ...extra,
  };
  return { d, out, text: () => out.join("\n") };
}
const TASTE = ["Linear, Things, Stripe", "A generic AI landing page", "serious", "", "Papyrus", "macOS, iOS"];
/** The answers for a complete first run: github stored, vercel stored, neon skipped, cloudflare stored, expo skipped, oauth stored, taste saved. */
function fullAnswers(token = SENTINEL) {
  return {
    lines: ["y", "vercel", "", "y", "n", "y", "y", ...TASTE],
    hidden: [token, `${token}-vercel`, `${token}-cf`, `${token}-oauth-id`, `${token}-oauth-secret`],
  };
}
function filesUnder(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name); const st = lstatSync(path);
    if (st.isDirectory()) out.push(...filesUnder(path)); else if (st.isFile()) out.push(path);
  }
  return out;
}
/** The saved state; a missing file reads as no steps, so a wrong count fails as an assertion. */
const state = (home: string) => (existsSync(join(home, ".jarvis", "setup-state.json")) ? JSON.parse(readFileSync(join(home, ".jarvis", "setup-state.json"), "utf8")) : { steps: {} }) as { steps: Record<string, { status: string; detail: string; provider?: string; secrets?: { key: string; tier: string; brokerOnly: boolean }[] }> };

it("runs every step once: accounts through the secrets backend, ntfy topics, taste, the Claude check and the plugin", async () => {
  const home = makeHome(); const a = fullAnswers(); const t = fakeTty(a.lines, a.hidden); const s = fakeSecrets(); const n = fakeNotifier();
  const r = deps(home, t.tty, { secrets: s.backend, createNotifier: n.createNotifier });
  const result = await runSetup(r.d, {});
  expect(result.ok).toBe(true);
  expect(t.lines).toEqual([]); expect(t.hidden).toEqual([]);
  const st = state(home);
  expect(Object.keys(st.steps).sort()).toEqual([...STEPS].sort());
  expect(Object.fromEntries(Object.entries(st.steps).map(([k, v]) => [k, v.status]))).toEqual({
    claude: "done", secrets: "done", "accounts.github": "done", "accounts.deploy": "done", "accounts.neon": "skipped", "accounts.cloudflare": "done",
    "accounts.expo": "skipped", "accounts.oauth": "done", ntfy: "done", taste: "done", plugin: "done",
  });
  expect(st.steps["accounts.deploy"]?.provider).toBe("vercel");
  // Production tokens are broker-only; the development OAuth app is preview-tier.
  expect(s.stored.get("GITHUB_TOKEN")).toEqual({ value: SENTINEL, brokerOnly: true });
  expect(s.stored.get("VERCEL_TOKEN")).toEqual({ value: `${SENTINEL}-vercel`, brokerOnly: true });
  expect(s.stored.get("CLOUDFLARE_API_TOKEN")).toEqual({ value: `${SENTINEL}-cf`, brokerOnly: true });
  expect(s.stored.get("OAUTH_DEV_CLIENT_SECRET")).toEqual({ value: `${SENTINEL}-oauth-secret`, brokerOnly: false });
  expect([...s.stored.keys()].sort()).toEqual(["CLOUDFLARE_API_TOKEN", "GITHUB_TOKEN", "OAUTH_DEV_CLIENT_ID", "OAUTH_DEV_CLIENT_SECRET", "VERCEL_TOKEN"]);
  expect(st.steps["accounts.github"]?.secrets).toEqual([{ key: "GITHUB_TOKEN", tier: "production", brokerOnly: true }]);
  expect(st.steps["accounts.oauth"]?.secrets).toEqual([{ key: "OAUTH_DEV_CLIENT_ID", tier: "preview", brokerOnly: false }, { key: "OAUTH_DEV_CLIENT_SECRET", tier: "preview", brokerOnly: false }]);
  // Every token prompt is hidden, and nothing else is.
  expect(t.calls.filter((c) => c.kind === "hidden")).toHaveLength(5);
  for (const c of t.calls.filter((x) => x.kind === "ask")) expect(c.prompt).not.toMatch(/token:|secret:|client id:/i);
  // The minimal scope is printed for each account.
  expect(r.text()).toMatch(/Contents: read and write/); expect(r.text()).toMatch(/Workers Scripts: Edit/);
  expect(r.text()).toMatch(/can't be limited to preview/i);
  // No network during setup, and no test notification without --send-test.
  expect(fetchSpy).not.toHaveBeenCalled(); expect(n.configs).toEqual([]);
  // The taste profile went through saveTaste.
  const taste = JSON.parse(readFileSync(join(home, ".jarvis/memory/user/taste.json"), "utf8"));
  expect(taste).toEqual({ admired: ["Linear", "Things", "Stripe"], aiMade: "A generic AI landing page", tone: "serious", dislikedColors: [], dislikedFonts: ["Papyrus"], platforms: ["macOS", "iOS"] });
  // The plugin is installed where task sessions load it and passes doctor's plugin check.
  expect(checkPlugin(join(home, ".jarvis", "plugin")).level).toBe("pass");
  expect(r.text()).toContain("/plugin install jarvis@jarvis");
  expect(lstatSync(join(home, ".jarvis", "setup-state.json")).mode & 0o777).toBe(0o600);
  expect(readdirSync(join(home, ".jarvis")).filter((x) => x.includes("tmp"))).toEqual([]);
});

it("never writes, prints or logs a token: a sentinel appears nowhere but the secrets backend", async () => {
  const home = makeHome();
  const ledgerDir = join(home, ".jarvis", "projects", "demo"); mkdirSync(ledgerDir, { recursive: true, mode: 0o700 });
  Ledger.open(ledgerDir).append({ kind: "steer", actor: "runner", data: { note: "before setup" } });
  const ledgerBefore = readFileSync(join(ledgerDir, "ledger.jsonl"), "utf8");
  const a = fullAnswers(); const t = fakeTty(a.lines, a.hidden);
  // The real env-file backend, so the only place the sentinel may land is the secrets file.
  const r = deps(home, t.tty, { createNotifier: fakeNotifier().createNotifier });
  expect((await runSetup(r.d, { sendTest: true })).ok).toBe(true);
  expect(r.text()).not.toContain(SENTINEL);
  const secretsFile = join(home, ".jarvis", "secrets", "house-stack.accounts.env");
  const holding = filesUnder(home).filter((f) => readFileSync(f).includes(Buffer.from(SENTINEL)));
  expect(holding).toEqual([secretsFile]);
  expect(statSync(secretsFile).mode & 0o777).toBe(0o600);
  expect(envFileSecrets(secretsFile).get("GITHUB_TOKEN")).toBe(SENTINEL);
  expect(readFileSync(join(ledgerDir, "ledger.jsonl"), "utf8")).toBe(ledgerBefore);
  expect(readFileSync(secretsFile, "utf8")).toMatch(/^# broker-only: GITHUB_TOKEN$/m);
});

it("an invalid token is asked again and never echoed", async () => {
  const home = makeHome();
  const bad = `${SENTINEL} with spaces`;
  const t = fakeTty(["y", ""], [bad, SENTINEL]); const s = fakeSecrets();
  const r = deps(home, t.tty, { secrets: s.backend });
  expect(await failure(runSetup(r.d, {}))).toBeInstanceOf(InterruptedError);
  expect(s.stored.get("GITHUB_TOKEN")?.value).toBe(SENTINEL);
  expect(r.text()).not.toContain(SENTINEL);
  expect(r.text()).toMatch(/doesn't look like a token/i);
});

it("re-running skips finished steps and asks nothing", async () => {
  const home = makeHome(); const a = fullAnswers(); const s = fakeSecrets();
  await runSetup(deps(home, fakeTty(a.lines, a.hidden).tty, { secrets: s.backend }).d, {});
  const before = readFileSync(join(home, ".jarvis", "setup-state.json"), "utf8");
  const again = fakeTty([], []); const r = deps(home, again.tty, { secrets: s.backend });
  expect((await runSetup(r.d, {})).ok).toBe(true);
  expect(again.calls).toEqual([]);
  expect(r.text()).toMatch(/accounts\.github: done earlier/);
  expect(r.text()).toMatch(/accounts\.neon: skipped earlier/);
  expect(readFileSync(join(home, ".jarvis", "setup-state.json"), "utf8")).toBe(before);
});

it("an interrupted run resumes at the step it stopped in", async () => {
  const home = makeHome(); const s = fakeSecrets();
  // Ctrl-C at the deploy question: claude, secrets and github are finished.
  const first = fakeTty(["y"], [SENTINEL]);
  expect(await failure(runSetup(deps(home, first.tty, { secrets: s.backend }).d, {}))).toBeInstanceOf(InterruptedError);
  expect(Object.keys(state(home).steps).sort()).toEqual(["accounts.github", "claude", "secrets"]);
  const a = fullAnswers();
  const second = fakeTty(a.lines.slice(1), a.hidden.slice(1));
  expect((await runSetup(deps(home, second.tty, { secrets: s.backend }).d, {})).ok).toBe(true);
  expect(second.calls[0]?.prompt).toMatch(/Vercel or Netlify/);
  expect(second.calls.some((c) => /GitHub/.test(c.prompt))).toBe(false);
  expect(Object.keys(state(home).steps)).toHaveLength(STEPS.length);
});

it("a crash while saving progress keeps the previous state file intact, and the run resumes", async () => {
  const home = makeHome(); const s = fakeSecrets();
  let saves = 0;
  const rename = vi.fn((from: import("node:fs").PathLike, to: import("node:fs").PathLike) => { if (++saves === 3) throw new Error("rename fault"); renameSync(from, to); });
  const first = fakeTty(["y"], [SENTINEL]);
  expect(String(await failure(runSetup(deps(home, first.tty, { secrets: s.backend, rename }).d, {})))).toMatch("rename fault");
  expect(Object.keys(state(home).steps).sort()).toEqual(["claude", "secrets"]);
  expect(readdirSync(join(home, ".jarvis")).filter((x) => x.includes("tmp"))).toEqual([]);
  const a = fullAnswers();
  const second = fakeTty(a.lines, a.hidden);
  expect((await runSetup(deps(home, second.tty, { secrets: s.backend }).d, {})).ok).toBe(true);
  expect(second.calls[0]?.prompt).toMatch(/GitHub/);
});

it("refuses a symlinked state file or runner folder before asking anything", async () => {
  const home = makeHome(); mkdirSync(join(home, ".jarvis"), { mode: 0o700 });
  const outside = join(home, "outside.json"); writeFileSync(outside, "{\"untouched\":true}");
  symlinkSync(outside, join(home, ".jarvis", "setup-state.json"));
  const t = fakeTty(["y"], [SENTINEL]);
  expect(String(await failure(runSetup(deps(home, t.tty, { secrets: fakeSecrets().backend }).d, {})))).toMatch(/symlink/i);
  expect(t.calls).toEqual([]);
  expect(readFileSync(outside, "utf8")).toBe("{\"untouched\":true}");
  rmSync(join(home, ".jarvis", "setup-state.json"));
  symlinkSync(join(home, "missing.json"), join(home, ".jarvis", "setup-state.json"));
  expect(String(await failure(runSetup(deps(home, t.tty, { secrets: fakeSecrets().backend }).d, {})))).toMatch(/symlink/i);
  expect(existsSync(join(home, "missing.json"))).toBe(false);

  const other = makeHome(); mkdirSync(join(other, "real-jarvis"), { mode: 0o700 }); symlinkSync(join(other, "real-jarvis"), join(other, ".jarvis"));
  expect(String(await failure(runSetup(deps(other, t.tty, { secrets: fakeSecrets().backend }).d, {})))).toMatch(/symlink/i);
  expect(readdirSync(join(other, "real-jarvis"))).toEqual([]);
  expect(t.calls).toEqual([]);
});

it("refuses a corrupt state file instead of starting over", async () => {
  const home = makeHome(); mkdirSync(join(home, ".jarvis"), { mode: 0o700 });
  writeFileSync(join(home, ".jarvis", "setup-state.json"), "{\"version\":1,\"steps\":{\"accounts.github\":{\"status\":\"maybe\"}}}", { mode: 0o600 });
  const t = fakeTty([], []);
  expect(String(await failure(runSetup(deps(home, t.tty, { secrets: fakeSecrets().backend }).d, {})))).toMatch(/setup-state\.json/);
  expect(t.calls).toEqual([]);
});

it("--redo runs a finished step again; 'accounts' means every account; unknown steps are refused", async () => {
  const home = makeHome(); const a = fullAnswers(); const s = fakeSecrets();
  await runSetup(deps(home, fakeTty(a.lines, a.hidden).tty, { secrets: s.backend }).d, {});
  const one = fakeTty(["y"], ["ghp_replacement-0123456789"]);
  expect((await runSetup(deps(home, one.tty, { secrets: s.backend }).d, { redo: ["accounts.github"] })).ok).toBe(true);
  expect(one.calls.map((c) => c.kind)).toEqual(["ask", "hidden"]);
  expect(s.stored.get("GITHUB_TOKEN")?.value).toBe("ghp_replacement-0123456789");
  const all = fakeTty(["n", "", "n", "n", "n", "n"], []);
  await runSetup(deps(home, all.tty, { secrets: s.backend }).d, { redo: ["accounts"] });
  expect(all.calls).toHaveLength(6);
  for (const step of ["accounts.github", "accounts.deploy", "accounts.neon", "accounts.cloudflare", "accounts.expo", "accounts.oauth"]) expect(state(home).steps[step]?.status).toBe("skipped");
  expect(String(await failure(runSetup(deps(home, fakeTty([], []).tty, { secrets: s.backend }).d, { redo: ["acounts"] })))).toMatch(/unknown setup step/i);
});

it("records a skipped account as skipped, stores nothing, and says Jarvis develops locally (decision 43)", async () => {
  const home = makeHome(); const s = fakeSecrets();
  const t = fakeTty(["n", "", "", "", "", "", "n"], []);
  expect((await runSetup(deps(home, t.tty, { secrets: s.backend }).d, {})).ok).toBe(true);
  expect(s.stored.size).toBe(0);
  for (const step of ["accounts.github", "accounts.deploy", "accounts.neon", "accounts.cloudflare", "accounts.expo", "accounts.oauth"]) {
    expect(state(home).steps[step]?.status).toBe("skipped");
    expect(state(home).steps[step]?.detail).toMatch(/local services/);
  }
  expect(state(home).steps.taste?.status).toBe("skipped");
  // An empty hidden answer also skips the account without storing anything.
  const empty = fakeTty(["y"], [""]);
  expect(await runSetup(deps(home, empty.tty, { secrets: s.backend }).d, { redo: ["accounts.github"] }).then((r) => r.ok)).toBe(true);
  expect(state(home).steps["accounts.github"]?.status).toBe("skipped");
  expect(s.stored.size).toBe(0);
});

it("writes notify.json with fresh random topics in the format intake reads, owner-only", async () => {
  const homes = [makeHome(), makeHome()];
  const configs = [];
  for (const home of homes) {
    const r = deps(home, fakeTty(["n", "", "", "", "", "", "n"], []).tty, { secrets: fakeSecrets().backend });
    await runSetup(r.d, {});
    const path = join(home, ".jarvis", "notify.json");
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    const config = notifyConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    expect(() => new NtfyNotifier({ baseUrl: config.baseUrl, topic: config.topic, replyTopic: config.replyTopic })).not.toThrow();
    expect(config.baseUrl).toBe("https://ntfy.sh");
    expect(config.topic).toMatch(/^jarvis-[a-z0-9]{24}$/);
    expect(config.replyTopic).toBe(`${config.topic}-reply`);
    expect(new Set(config.topic.slice(7)).size).toBeGreaterThan(5);
    expect(r.text()).toContain(config.topic); expect(r.text()).toContain(config.replyTopic);
    expect(r.text()).toMatch(/ntfy app/i);
    configs.push(config);
  }
  expect(configs[0]?.topic).not.toBe(configs[1]?.topic);
});

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
