import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { envFileSecretsWriter } from "../../packages/cli/src/broker/secrets.ts";
import { pinnedClaudeBin } from "../../packages/cli/src/config/pins.ts";
import { checkAclOutput, checkTrustedDir, lsAcl, writePrivateAtomic } from "../../packages/cli/src/config/private-file.ts";
import { runSetup, type SetupDeps } from "../../packages/cli/src/setup/setup.ts";
import { InterruptedError, type Tty } from "../../packages/cli/src/setup/tty.ts";

// Codex re-check of the setup branch: on macOS a folder with the right owner and mode 0700 can still carry
// an (inheritable) ACL that gives another user access, and new 0600 files inherit it. Any allow entry for
// anyone but the owner is refused; deny entries (the standard home-folder one) are accepted; anything that
// can't be read or parsed is refused.
const PLUGIN = fileURLToPath(new URL("../../plugin", import.meta.url));
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const ME = "fabricio";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const makeHome = () => { const h = mkdtempSync(join(tmpdir(), "jarvis-acl-")); dirs.push(h); return h; };
const head = (path: string) => `drwx------  9 ${ME}  staff  288 Oct 24 12:05 ${path}\n`;
const HOME_DENY = " 0: group:everyone deny delete";
const OTHER_ALLOW = " 0: user:other allow read,write,append,file_inherit,directory_inherit";
const OTHER_INHERITED = " 0: user:other inherited allow read,write,append";
function refusal(fn: () => unknown): string {
  try { fn(); } catch (error) { return String(error); }
  return "";
}
async function failure(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error) { return error; }
  return undefined;
}

it("accepts no ACL, the standard home-folder deny entry and the owner's own allow entry", () => {
  expect(refusal(() => checkAclOutput("/x", head("/x")))).toBe("");
  expect(refusal(() => checkAclOutput("/x", `${head("/x")}${HOME_DENY}\n`))).toBe("");
  expect(refusal(() => checkAclOutput("/x", `${head("/x")} 0: user:${ME} allow read,write\n 1: group:staff deny write\n`))).toBe("");
});

it.each([
  ["another user allowed", OTHER_ALLOW],
  ["another user allowed by an inherited entry", OTHER_INHERITED],
  ["a group allowed", " 0: group:staff allow read"],
  ["everyone allowed", " 0: group:everyone allow read"],
])("refuses an ACL with %s", (_label, entry) => {
  expect(refusal(() => checkAclOutput("/x", `${head("/x")}${HOME_DENY}\n${entry}\n`))).toMatch(/ACL/);
});

it("fails closed on an entry it can't parse or output without an owner", () => {
  expect(refusal(() => checkAclOutput("/x", `${head("/x")} 0: something unexpected\n`))).toMatch(/ACL/);
  expect(refusal(() => checkAclOutput("/x", ""))).toMatch(/ACL/);
});

function quietTty() {
  const calls: string[] = []; const lines = ["n", "", "", "", "", "", "n"];
  const tty: Tty = {
    ask: async (p) => { calls.push(p); const v = lines.shift(); if (v === undefined) throw new InterruptedError(); return v; },
    askHidden: async (p) => { calls.push(p); throw new InterruptedError(); },
    close: () => {},
  };
  return { tty, calls };
}
function deps(home: string, tty: Tty, acl: (path: string) => string): SetupDeps {
  const claude = pinnedClaudeBin(home);
  return {
    home, tty, print: () => {}, pluginSource: PLUGIN, repoRoot: REPO, acl,
    secrets: { location: "fake", prepare: () => {}, set: () => {} },
    exists: (p) => p === claude || existsSync(p), exec: () => "2.1.309 (Claude Code)",
  };
}

it("setup accepts the home folder's standard deny entry", async () => {
  const home = makeHome();
  const acl = (p: string) => p === home ? `${head(p)}${HOME_DENY}\n` : head(p);
  expect((await runSetup(deps(home, quietTty().tty, acl), {})).ok).toBe(true);
});

it.each([["the home folder", ""], ["~/.jarvis", ".jarvis"], ["~/.jarvis/secrets", ".jarvis/secrets"]])("setup refuses %s with an inherited allow ACL before asking anything", async (_label, rel) => {
  const home = makeHome(); mkdirSync(join(home, ".jarvis", "secrets"), { recursive: true, mode: 0o700 });
  const target = rel === "" ? home : join(home, rel);
  const acl = (p: string) => p === target ? `${head(p)}${OTHER_INHERITED}\n` : head(p);
  const t = quietTty();
  expect(String(await failure(runSetup(deps(home, t.tty, acl), {})))).toMatch(/ACL/);
  expect(t.calls).toEqual([]);
  expect(existsSync(join(home, ".jarvis", "setup-state.json"))).toBe(false);
});

it("setup fails closed when the ACL can't be read", async () => {
  const home = makeHome(); const t = quietTty();
  const acl = () => { throw new Error("could not read the ACL"); };
  expect(String(await failure(runSetup(deps(home, t.tty, acl), {})))).toMatch(/ACL/);
  expect(t.calls).toEqual([]);
});

it("a new file that shows an ACL is refused before anything is written to it, and removed", () => {
  const home = makeHome(); const seen: string[] = [];
  const acl = (p: string) => { seen.push(p); return p.endsWith(".tmp") ? `-rw-------  1 ${ME}  staff  0 Oct 24 12:05 ${p}\n${OTHER_INHERITED}\n` : head(p); };
  expect(refusal(() => writePrivateAtomic(join(home, "secret.env"), "TOKEN=SENTINEL-acl-0123456789\n", { acl }))).toMatch(/ACL/);
  expect(seen.some((p) => p.endsWith(".tmp"))).toBe(true);
  expect(readdirSync(home)).toEqual([]);
});

it("the secrets writer refuses a secrets folder with an allow ACL", () => {
  const home = makeHome(); mkdirSync(join(home, ".jarvis", "secrets"), { recursive: true, mode: 0o700 });
  const file = join(home, ".jarvis", "secrets", "house-stack.accounts.env");
  const acl = (p: string) => p.endsWith("secrets") ? `${head(p)}${OTHER_ALLOW}\n` : head(p);
  expect(refusal(() => envFileSecretsWriter(file, { acl }).prepare())).toMatch(/ACL/);
  expect(refusal(() => envFileSecretsWriter(file, { acl }).set("A_TOKEN", "abcdefgh1234", { brokerOnly: true }))).toMatch(/ACL/);
  expect(existsSync(file)).toBe(false);
});

it.runIf(process.platform === "darwin")("live: the real /bin/ls -lde sees an allow ACL added with chmod +a, and the folder is refused", () => {
  const dir = makeHome();
  writeFileSync(join(dir, "test.txt"), "x", { mode: 0o600 });
  expect(refusal(() => checkTrustedDir(dir))).toBe("");
  const r = spawnSync("/bin/chmod", ["+a", "everyone allow read", dir], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
  expect(r.status, r.stderr).toBe(0);
  expect(lsAcl(dir)).toMatch(/^ 0: group:everyone allow (read|list)\b/m); // a folder shows read as list
  expect(refusal(() => checkTrustedDir(dir))).toMatch(/ACL/);
  expect(refusal(() => writePrivateAtomic(join(dir, "a.json"), "{}\n"))).toMatch(/ACL/);
  expect(existsSync(join(dir, "a.json"))).toBe(false);
});
