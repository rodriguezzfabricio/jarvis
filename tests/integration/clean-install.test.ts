import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLAUDE_CODE_VERSION, CODEX_VERSION } from "../../packages/cli/src/config/pins.ts";
import { shortTmp } from "../helpers.ts";
import { namedSkills, repoSkills } from "../plugin-skills.ts";

/**
 * Stage 7's clean install (architecture §8): HEAD exported with git archive (plus uncommitted
 * edits to tracked files), installed by
 * scripts/install.sh into a temp prefix with HOME pointed at a temp folder, then used from the
 * installed launcher. No network: pnpm runs --offline from the existing store, corepack may not
 * download, and the registry is unreachable. The pinned Claude Code is a fake at the pinned path
 * that answers only `--version` and the `plugin` commands. Prerequisites that are missing skip the
 * tests with the reason.
 */

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const installScript = join(repoRoot, "scripts", "install.sh");
const fakePlugin = fileURLToPath(new URL("../fixtures/fake-claude-plugin.mjs", import.meta.url));
const MARKER = "# jarvis launcher, written by scripts/install.sh";

let root = "";
let repo = "";
let home = "";
let prefix = "";
let env: Record<string, string> = {};
let skipReason = "";
let installed = false;

const sh = (cmd: string, opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => spawnSync("/bin/sh", ["-c", cmd], { encoding: "utf8", ...opts });
const install = (args: string[], p = prefix): SpawnSyncReturns<string> =>
  spawnSync("/bin/sh", [join(repo, "scripts", "install.sh"), "--prefix", p, "--offline", ...args], { cwd: root, env, encoding: "utf8", timeout: 120_000 });
const output = (r: SpawnSyncReturns<string>) => `${r.stdout}\n${r.stderr}`;
const calls = (): { args: string[]; envKeys: string[] }[] => {
  const log = join(home, ".fake-claude", "calls.jsonl");
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { args: string[]; envKeys: string[] }) : [];
};
const changingCalls = () => calls().filter((c) => !(c.args.length === 1 && c.args[0] === "--version") && !c.args.includes("list"));

function prerequisites(): string {
  if (process.platform !== "darwin") return "Jarvis v1 installs on macOS only";
  if (!process.versions.node.startsWith("24.")) return `needs Node 24, running ${process.versions.node}`;
  const pnpm = sh("command -v pnpm").stdout.trim();
  if (!pnpm) return "pnpm is not on PATH";
  if (sh("command -v git").status !== 0) return "git is not on PATH";
  const store = sh("pnpm store path", { cwd: repoRoot }).stdout.trim();
  if (!store || !existsSync(store)) return "no local pnpm store to install from offline";
  env = {
    HOME: home,
    USER: process.env.USER ?? "jarvis-test",
    LANG: "en_US.UTF-8",
    TMPDIR: root,
    PATH: [join(prefix, "bin"), dirname(process.execPath), dirname(pnpm), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    // pnpm through corepack: reuse the downloaded pnpm, never fetch one.
    COREPACK_HOME: process.env.COREPACK_HOME ?? join(homedir(), ".cache", "node", "corepack"),
    COREPACK_ENABLE_NETWORK: "0",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    // Packages come only from the existing store. The supply-chain re-verification of the lockfile
    // needs the registry, so this test trusts the committed lockfile; a real install verifies it.
    pnpm_config_store_dir: store.replace(/\/v\d+\/?$/, ""),
    pnpm_config_trust_lockfile: "true",
    pnpm_config_registry: "http://127.0.0.1:9/",
    pnpm_config_fetch_retries: "0",
    pnpm_config_fetch_timeout: "3000",
    // Variables that must not reach the pinned Claude Code the installer runs (decision 58).
    JARVIS_LEAK_CANARY: "leaked",
    CLAUDE_CONFIG_DIR: join(root, "not-the-claude-config"),
  };
  const v = spawnSync(pnpm, ["--version"], { cwd: repo, env, encoding: "utf8", timeout: 30_000 });
  if (v.status !== 0) return `pnpm can't start without the network: ${output(v).trim().slice(0, 200)}`;
  return "";
}

beforeAll(() => {
  root = shortTmp("jci-");
  repo = join(root, "repo");
  home = join(root, "home");
  prefix = join(root, "prefix");
  mkdirSync(repo);
  mkdirSync(home);
  // HEAD as a friend would clone it, plus any uncommitted edits to tracked files (so a broken
  // installer in the working tree, or a mutation check's edit, is what gets installed).
  // `git stash create` writes a commit object only: no ref, no stash entry, no working-tree change.
  const gitIdent = ["-c", "user.name=jarvis-test", "-c", "user.email=jarvis-test@localhost", "-c", "core.hooksPath=/dev/null"];
  const dirty = spawnSync("git", [...gitIdent, "stash", "create"], { cwd: repoRoot, encoding: "utf8" });
  const revision = dirty.status === 0 && dirty.stdout.trim() ? dirty.stdout.trim() : "HEAD";
  const tar = join(root, "head.tar");
  const archived = spawnSync("git", ["archive", "--format=tar", "-o", tar, revision], { cwd: repoRoot, encoding: "utf8" });
  if (archived.status !== 0) { skipReason = `git archive failed: ${archived.stderr}`; return; }
  const extracted = spawnSync("tar", ["-xf", tar, "-C", repo], { encoding: "utf8" });
  if (extracted.status !== 0) { skipReason = `tar failed: ${extracted.stderr}`; return; }
  if (!existsSync(join(repo, "scripts", "install.sh"))) { skipReason = "scripts/install.sh is not committed at HEAD yet"; return; }
  skipReason = prerequisites();
  // The pinned Claude Code, faked at its pinned path inside the temp HOME. The wrapper drops the
  // variables /bin/sh itself adds, so the fake logs the environment the installer gave it.
  const pinned = join(home, ".local", "share", "claude", "versions", CLAUDE_CODE_VERSION);
  mkdirSync(dirname(pinned), { recursive: true });
  writeFileSync(pinned, `#!/bin/sh\nexec /usr/bin/env -u PWD -u OLDPWD -u SHLVL '${process.execPath}' '${fakePlugin}' "$@"\n`);
  chmodSync(pinned, 0o755);
}, 120_000);

// Removing a whole install (node_modules included) can outlast the default hook timeout under a busy full run.
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); }, 120_000);

describe("scripts/install.sh, as written", () => {
  const text = readFileSync(installScript, "utf8");

  it("never escalates, downloads, or installs Claude Code or Codex itself", () => {
    expect(text).not.toMatch(/\bsudo\s/);
    expect(text).not.toMatch(/\b(curl|wget)\b/);
    expect(text).not.toMatch(/\bnpm\s+(i|install)\b/);
    expect(text).not.toMatch(/\bbrew\s+install\s+(?!node|pnpm)/);
    expect(text).not.toMatch(/claude_clean\s+(install|update|login|setup-token)\b/);
  });

  it("checks the same pins as packages/cli/src/config/pins.ts", () => {
    expect(text).toContain(`CLAUDE_VERSION="${CLAUDE_CODE_VERSION}"`);
    expect(text).toContain(`CODEX_VERSION="${CODEX_VERSION}"`);
    expect(text).toContain('CLAUDE_BIN="$HOME/.local/share/claude/versions/$CLAUDE_VERSION"');
    expect(text).toContain('CODEX_BIN="$HOME/.npm-global/bin/codex"');
  });
});

describe("clean install from git archive HEAD", () => {
  it("--dry-run reports every step and changes nothing", (ctx) => {
    if (skipReason) ctx.skip(skipReason);
    const r = install(["--dry-run"]);
    expect(r.status, output(r)).toBe(0);
    expect(r.stdout).toContain("Dry run: nothing will be changed.");
    expect(r.stdout).toContain(`[dry-run] would run: (cd ${realpathSync(repo)} && pnpm install --frozen-lockfile --offline)`);
    expect(r.stdout).toContain(`[dry-run] would write ${join(prefix, "bin", "jarvis")}`);
    expect(r.stdout).toContain(`plugin marketplace add ${realpathSync(repo)} --scope user`);
    expect(r.stdout).toContain("plugin install jarvis@jarvis --scope user");
    expect(r.stdout).toContain(`[dry-run] would run: ${join(prefix, "bin", "jarvis")} doctor`);
    expect(existsSync(join(repo, "node_modules"))).toBe(false);
    expect(existsSync(prefix)).toBe(false);
    expect(changingCalls()).toEqual([]);
  });

  it("installs dependencies, the launcher and the plugin, then runs doctor", (ctx) => {
    if (skipReason) ctx.skip(skipReason);
    const r = install([]);
    if (r.status !== 0 && /ERR_PNPM_NO_OFFLINE_TARBALL|offline mode/.test(output(r))) ctx.skip("the local pnpm store lacks some locked packages; run pnpm install once with the network");
    expect(r.status, output(r)).toBe(0);
    installed = true;
    expect(existsSync(join(repo, "packages", "cli", "node_modules", "commander"))).toBe(true);
    const launcher = readFileSync(join(prefix, "bin", "jarvis"), "utf8");
    expect(launcher.split("\n").slice(0, 3)).toEqual([
      "#!/bin/sh",
      MARKER,
      `exec '${process.execPath}' '${join(realpathSync(repo), "packages", "cli", "src", "cli.ts")}' "$@"`,
    ]);
    expect(changingCalls().map((c) => c.args)).toEqual([
      ["plugin", "marketplace", "add", realpathSync(repo), "--scope", "user"],
      ["plugin", "install", "jarvis@jarvis", "--scope", "user"],
    ]);
    // The pinned Claude Code ran with the allowlisted environment only (decision 58); macOS adds
    // __CF_USER_TEXT_ENCODING to every process (decision 66).
    for (const c of calls().filter((x) => x.args[0] === "plugin")) {
      expect(c.envKeys.filter((k) => k !== "__CF_USER_TEXT_ENCODING")).toEqual(["HOME", "LANG", "PATH", "SHELL", "TMPDIR", "USER"]);
    }
    // Doctor ran from the installed launcher and found the pinned binary.
    expect(r.stdout).toMatch(/Running jarvis doctor/);
    expect(r.stdout).toMatch(/ok\s+claude_pinned/);
    expect(r.stdout).toMatch(/warn\s+canary_probe\s+not run/);
  }, 120_000);

  it("the installed plugin carries every skill /jarvis names, as real files", (ctx) => {
    if (skipReason || !installed) ctx.skip(skipReason || "the install step did not run");
    // The archive kept plugin/skills as a link; the install copy (symlinks followed) holds the files.
    expect(lstatSync(join(repo, "plugin", "skills")).isSymbolicLink()).toBe(true);
    const state = JSON.parse(readFileSync(join(home, ".fake-claude", "state.json"), "utf8")) as { plugins: { id: string; installPath: string }[] };
    const plugin = state.plugins.find((p) => p.id === "jarvis@jarvis");
    expect(plugin).toBeDefined();
    const skills = [...new Set([...namedSkills(repo), ...repoSkills(repo)])];
    expect(namedSkills(repo).length).toBeGreaterThan(0);
    // Real files inside the install copy: a link back into the checkout would break when it moves.
    const inside = `${realpathSync(plugin!.installPath)}/`;
    expect(lstatSync(join(plugin!.installPath, "skills")).isSymbolicLink()).toBe(false);
    for (const s of skills) {
      const file = join(plugin!.installPath, "skills", s, "SKILL.md");
      expect(existsSync(file) && lstatSync(file).isFile() && realpathSync(file).startsWith(inside), file).toBe(true);
    }
  });

  it("is idempotent: a second run changes nothing it already did", (ctx) => {
    if (skipReason || !installed) ctx.skip(skipReason || "the install step did not run");
    const before = readFileSync(join(prefix, "bin", "jarvis"), "utf8");
    const changing = changingCalls().length;
    const r = install(["--no-doctor"]);
    expect(r.status, output(r)).toBe(0);
    expect(r.stdout).toContain("found an earlier Jarvis launcher; it will be rewritten");
    expect(r.stdout).toContain("marketplace 'jarvis' already points at this checkout");
    expect(r.stdout).toContain("plugin jarvis@jarvis already installed and enabled");
    expect(readFileSync(join(prefix, "bin", "jarvis"), "utf8")).toBe(before);
    expect(changingCalls()).toHaveLength(changing);
  }, 120_000);

  it("the installed jarvis runs --help and doctor", (ctx) => {
    if (skipReason || !installed) ctx.skip(skipReason || "the install step did not run");
    const bin = join(prefix, "bin", "jarvis");
    const help = spawnSync(bin, ["--help"], { cwd: root, env, encoding: "utf8" });
    expect(help.status, output(help)).toBe(0);
    expect(help.stdout).toContain("Usage: jarvis");
    expect(help.stdout).toMatch(/^\s+doctor \[options\]/m);
    const doctor = spawnSync(bin, ["doctor", "--json"], { cwd: repo, env, encoding: "utf8", timeout: 60_000 });
    expect([0, 1], output(doctor)).toContain(doctor.status);
    const checks = JSON.parse(doctor.stdout) as { name: string; level: string }[];
    const byName = new Map(checks.map((c) => [c.name, c.level]));
    expect(byName.get("claude_pinned")).toBe("pass");
    expect(byName.get("codex_pinned")).toBe("warn"); // not installed in the temp HOME
    expect(byName.get("plugin")).toBe("pass");
    expect(byName.get("canary_probe")).toBe("warn");
  }, 60_000);

  it("refuses to overwrite a jarvis command it didn't write", (ctx) => {
    if (skipReason) ctx.skip(skipReason);
    const other = join(root, "other-prefix");
    mkdirSync(join(other, "bin"), { recursive: true });
    writeFileSync(join(other, "bin", "jarvis"), "#!/bin/sh\necho someone else's jarvis\n");
    const r = install(["--dry-run"], other);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("was not written by this installer");
    expect(readFileSync(join(other, "bin", "jarvis"), "utf8")).toBe("#!/bin/sh\necho someone else's jarvis\n");
  });
});
