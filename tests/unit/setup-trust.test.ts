import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { envFileSecretsWriter } from "../../packages/cli/src/broker/secrets.ts";
import { pinnedClaudeBin } from "../../packages/cli/src/config/pins.ts";
import { checkTrustedDir, checkTrustedTree, writePrivateAtomic } from "../../packages/cli/src/config/private-file.ts";
import { assembleTaskPlugin, TASK_SKILLS } from "../../packages/cli/src/harness/claude/task-plugin.ts";
import { runSetup, type SetupDeps } from "../../packages/cli/src/setup/setup.ts";
import { taskPluginSource } from "../../packages/cli/src/setup/plugin.ts";
import { InterruptedError, type Tty } from "../../packages/cli/src/setup/tty.ts";

// Codex review of the setup branch: an untrusted runner folder lets another local user swap in plugin
// hooks that run outside the sandbox. Every runner folder must be ours and writable only by us.
const PLUGIN = fileURLToPath(new URL("../../plugin", import.meta.url));
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SKILLS = fileURLToPath(new URL("../../skills", import.meta.url));
const UID = process.getuid?.() ?? 0;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) { chmodTree(dir); rmSync(dir, { recursive: true, force: true }); }
});
function chmodTree(dir: string) {
  try { if (lstatSync(dir).isDirectory() && !lstatSync(dir).isSymbolicLink()) { chmodSync(dir, 0o700); for (const n of readdirSync(dir)) chmodTree(join(dir, n)); } } catch { /* gone */ }
}
async function failure(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error) { return error; }
  return undefined;
}
function makeHome() { const home = mkdtempSync(join(tmpdir(), "jarvis-trust-")); dirs.push(home); return home; }
function quietTty(lines: string[] = ["n", "", "", "", "", "", "n"]) {
  const calls: string[] = [];
  const tty: Tty = {
    ask: async (p) => { calls.push(p); const v = lines.shift(); if (v === undefined) throw new InterruptedError(); return v; },
    askHidden: async (p) => { calls.push(p); throw new InterruptedError(); },
    close: () => {},
  };
  return { tty, calls };
}
function deps(home: string, tty: Tty, extra: Partial<SetupDeps> = {}): SetupDeps {
  const claude = pinnedClaudeBin(home);
  return {
    home, tty, print: () => {}, pluginSource: PLUGIN, repoRoot: REPO,
    secrets: { location: "fake", prepare: () => {}, set: () => {} },
    exists: (p) => p === claude || existsSync(p), exec: () => "2.1.309 (Claude Code)", ...extra,
  };
}
const statePath = (home: string) => join(home, ".jarvis", "setup-state.json");

it("checkTrustedDir accepts our own private folder and refuses group or world write, a symlink and another owner", () => {
  const home = makeHome(); const d = join(home, "d"); mkdirSync(d, { mode: 0o700 });
  expect(() => checkTrustedDir(d)).not.toThrow();
  chmodSync(d, 0o755); expect(() => checkTrustedDir(d)).not.toThrow();
  chmodSync(d, 0o775); expect(String((() => { try { checkTrustedDir(d); } catch (e) { return e; } })())).toMatch(/writable by others/);
  chmodSync(d, 0o707); expect(() => checkTrustedDir(d)).toThrow(/writable by others/);
  chmodSync(d, 0o700); expect(() => checkTrustedDir(d, { uid: UID + 1 })).toThrow(/owned by/);
  symlinkSync(d, join(home, "link")); expect(() => checkTrustedDir(join(home, "link"))).toThrow(/symlink/);
});

it("writePrivateAtomic refuses a parent folder others can write or that someone else owns", () => {
  const home = makeHome(); const d = join(home, "d"); mkdirSync(d, { mode: 0o700 });
  writePrivateAtomic(join(d, "a.json"), "{}\n");
  expect(lstatSync(join(d, "a.json")).mode & 0o777).toBe(0o600);
  chmodSync(d, 0o770);
  expect(() => writePrivateAtomic(join(d, "b.json"), "{}\n")).toThrow(/writable by others/);
  chmodSync(d, 0o700);
  expect(() => writePrivateAtomic(join(d, "b.json"), "{}\n", { uid: UID + 1 })).toThrow(/owned by/);
  expect(existsSync(join(d, "b.json"))).toBe(false);
});

it("checkTrustedTree refuses a symlink, a group-writable file or a foreign owner anywhere in the tree", () => {
  const home = makeHome(); const root = join(home, "t"); mkdirSync(join(root, "a", "b"), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "a", "b", "f.txt"), "x", { mode: 0o600 });
  expect(() => checkTrustedTree(root)).not.toThrow();
  chmodSync(join(root, "a", "b", "f.txt"), 0o620); expect(() => checkTrustedTree(root)).toThrow(/writable by others/);
  chmodSync(join(root, "a", "b", "f.txt"), 0o600);
  expect(() => checkTrustedTree(root, { uid: UID + 1 })).toThrow(/owned by/);
  symlinkSync(join(home, "elsewhere"), join(root, "a", "link")); expect(() => checkTrustedTree(root)).toThrow(/symlink/);
});

it.each([
  ["~/.jarvis is group-writable", (h: string) => { mkdirSync(join(h, ".jarvis"), { mode: 0o700 }); chmodSync(join(h, ".jarvis"), 0o770); }],
  ["~/.jarvis is world-writable", (h: string) => { mkdirSync(join(h, ".jarvis"), { mode: 0o700 }); chmodSync(join(h, ".jarvis"), 0o707); }],
  ["the home folder is world-writable", (h: string) => { chmodSync(h, 0o777); }],
  ["~/.jarvis/secrets is group-writable", (h: string) => { mkdirSync(join(h, ".jarvis", "secrets"), { recursive: true, mode: 0o700 }); chmodSync(join(h, ".jarvis", "secrets"), 0o770); }],
  ["~/.jarvis/plugin is world-writable", (h: string) => { mkdirSync(join(h, ".jarvis", "plugin"), { recursive: true, mode: 0o700 }); chmodSync(join(h, ".jarvis", "plugin"), 0o777); }],
  ["~/.jarvis/memory is group-writable", (h: string) => { mkdirSync(join(h, ".jarvis", "memory"), { recursive: true, mode: 0o700 }); chmodSync(join(h, ".jarvis", "memory"), 0o770); }],
])("refuses to start, before asking anything, when %s", async (_label, arrange) => {
  const home = makeHome(); arrange(home);
  const t = quietTty();
  const error = await failure(runSetup(deps(home, t.tty), {}));
  expect(String(error)).toMatch(/writable by others/);
  expect(t.calls).toEqual([]);
  expect(existsSync(statePath(home))).toBe(false);
});

it("refuses to start when a runner folder belongs to another user", async () => {
  const home = makeHome(); mkdirSync(join(home, ".jarvis"), { mode: 0o700 });
  const t = quietTty();
  expect(String(await failure(runSetup(deps(home, t.tty, { uid: UID + 1 }), {})))).toMatch(/owned by/);
  expect(t.calls).toEqual([]);
  expect(existsSync(statePath(home))).toBe(false);
});

it("materializes the repo's plugin and skills as real, owner-only files and verifies them", async () => {
  const home = makeHome();
  expect((await runSetup(deps(home, quietTty().tty), {})).ok).toBe(true);
  const installed = join(home, ".jarvis", "plugin");
  expect(() => checkTrustedTree(installed)).not.toThrow();
  expect(lstatSync(join(installed, "skills")).isDirectory()).toBe(true);
  for (const skill of TASK_SKILLS) expect(readFileSync(join(installed, "skills", skill, "SKILL.md"), "utf8")).toBe(readFileSync(join(SKILLS, skill, "SKILL.md"), "utf8"));
  // The installed copy is the source for each session's plugin, which carries only build and debug.
  const session = join(makeHome(), "session-plugin");
  assembleTaskPlugin(taskPluginSource(join(home, ".jarvis")), session);
  expect(readdirSync(join(session, "skills")).sort()).toEqual([...TASK_SKILLS].sort());
  expect(readFileSync(join(session, "hooks", "tripwire.mjs"), "utf8")).toBe(readFileSync(join(PLUGIN, "hooks", "tripwire.mjs"), "utf8"));
});

it.each([
  ["a hook replaced by a symlink", (p: string, h: string) => { const evil = join(h, "evil.mjs"); writeFileSync(evil, "// evil\n"); rmSync(join(p, "hooks", "tripwire.mjs")); symlinkSync(evil, join(p, "hooks", "tripwire.mjs")); }],
  ["a hook made group-writable", (p: string) => { chmodSync(join(p, "hooks", "tripwire.mjs"), 0o660); }],
  ["the hooks folder made world-writable", (p: string) => { chmodSync(join(p, "hooks"), 0o777); }],
  ["the whole plugin swapped for a symlink", (p: string, h: string) => { const evil = join(h, "evil-plugin"); mkdirSync(evil); rmSync(p, { recursive: true }); symlinkSync(evil, p); }],
])("refuses a substituted plugin: %s", async (_label, tamper) => {
  const home = makeHome();
  await runSetup(deps(home, quietTty().tty), {});
  const installed = join(home, ".jarvis", "plugin");
  tamper(installed, home);
  expect(String((() => { try { taskPluginSource(join(home, ".jarvis")); } catch (e) { return e; } })())).toMatch(/symlink|writable by others/);
  const t = quietTty([]);
  expect(String(await failure(runSetup(deps(home, t.tty), {})))).toMatch(/symlink|writable by others/);
  expect(t.calls).toEqual([]);
});

it("refuses a source plugin whose links leave its own repository", async () => {
  const home = makeHome();
  const repo = join(makeHome(), "repo"); const source = join(repo, "plugin");
  mkdirSync(join(repo, "skills"), { recursive: true });
  for (const rel of [".claude-plugin", "hooks"]) mkdirSync(join(source, rel), { recursive: true });
  for (const rel of [".claude-plugin/plugin.json", "hooks/hooks.json", "hooks/session-start.mjs", "hooks/tripwire.mjs"]) writeFileSync(join(source, rel), readFileSync(join(PLUGIN, rel)));
  const outside = join(makeHome(), "outside-skills"); mkdirSync(join(outside, "build"), { recursive: true }); writeFileSync(join(outside, "build", "SKILL.md"), "evil");
  symlinkSync(outside, join(source, "skills"));
  const r = await runSetup(deps(home, quietTty().tty, { pluginSource: source }), {});
  expect(r.ok).toBe(false);
  expect(r.state.steps.plugin?.detail).toMatch(/outside/);
  expect(existsSync(join(home, ".jarvis", "plugin"))).toBe(false);
});

it("the secrets writer refuses a folder or file owned by someone else (injected owner)", () => {
  const home = makeHome(); mkdirSync(join(home, ".jarvis"), { mode: 0o700 });
  const file = join(home, ".jarvis", "secrets", "house-stack.accounts.env");
  envFileSecretsWriter(file).prepare();
  envFileSecretsWriter(file).set("A_TOKEN", "abcdefgh1234", { brokerOnly: true });
  const before = readFileSync(file, "utf8");
  const foreign = envFileSecretsWriter(file, { uid: UID + 1 });
  expect(() => foreign.prepare()).toThrow(/belong to the current user/);
  expect(() => foreign.set("B_TOKEN", "abcdefgh5678", { brokerOnly: true })).toThrow(/belong to the current user/);
  expect(readFileSync(file, "utf8")).toBe(before);
  vi.restoreAllMocks();
});

it("a source without the build-loop skills is refused before it replaces the installed copy", async () => {
  const home = makeHome();
  await runSetup(deps(home, quietTty().tty), {});
  const installed = join(home, ".jarvis", "plugin");
  const before = readFileSync(join(installed, "skills", "build", "SKILL.md"), "utf8");
  const repo = join(makeHome(), "repo"); const source = join(repo, "plugin");
  for (const rel of [".claude-plugin", "hooks"]) mkdirSync(join(source, rel), { recursive: true });
  for (const rel of [".claude-plugin/plugin.json", "hooks/hooks.json", "hooks/session-start.mjs", "hooks/tripwire.mjs"]) writeFileSync(join(source, rel), readFileSync(join(PLUGIN, rel)));
  const r = await runSetup(deps(home, quietTty([]).tty, { pluginSource: source }), { redo: ["plugin"] });
  expect(r.ok).toBe(false);
  expect(r.state.steps.plugin?.detail).toMatch(/build skill/);
  expect(existsSync(join(installed, "skills", "build", "SKILL.md"))).toBe(true);
  expect(readFileSync(join(installed, "skills", "build", "SKILL.md"), "utf8")).toBe(before);
  expect(readdirSync(join(home, ".jarvis")).filter((x) => x.startsWith(".plugin"))).toEqual([]);
});
