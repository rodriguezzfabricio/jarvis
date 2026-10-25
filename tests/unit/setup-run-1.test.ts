// Setup run tests, part 1 of 2 (first run, secrets, resume, redo, skipped accounts). The tests are split over two files so they run in parallel;
// the shared fixture is tests/unit/helpers/setup-run-fixture.ts.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { checkPlugin } from "../../packages/cli/src/doctor/foundation.ts";
import { notifyConfigSchema } from "../../packages/cli/src/intake/commands.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { NtfyNotifier } from "../../packages/cli/src/notify/ntfy.ts";
import { envFileSecrets } from "../../packages/cli/src/broker/secrets.ts";
import { runSetup } from "../../packages/cli/src/setup/setup.ts";
import { STEPS } from "../../packages/cli/src/setup/state.ts";
import { InterruptedError } from "../../packages/cli/src/setup/tty.ts";
import { SENTINEL, deps, failure, fakeNotifier, fakeSecrets, fakeTty, fetchSpy, filesUnder, fullAnswers, installSetupHooks, makeHome, state } from "./helpers/setup-run-fixture.ts";

installSetupHooks();

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
