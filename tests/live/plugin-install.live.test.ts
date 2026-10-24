import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { pinnedClaudeBin } from "../../packages/cli/src/config/pins.ts";
import { shortTmp } from "../helpers.ts";
import { namedSkills, repoSkills } from "../plugin-skills.ts";

/**
 * The real pinned Claude Code installs the Jarvis plugin the way scripts/install.sh does, into a temp
 * HOME, and the installed copy carries the skills: 2.1.309 follows the plugin/skills -> ../skills link
 * when it copies the plugin into its cache. Plugin commands only, so no plan usage and no login; only
 * with JARVIS_LIVE=1 because it runs the real binary.
 */
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const root = shortTmp("jpl-");
afterAll(() => rmSync(root, { recursive: true, force: true }), 60_000);

describe.skipIf(process.env.JARVIS_LIVE !== "1" || !existsSync(pinnedClaudeBin()))("live plugin install on the pinned Claude Code", () => {
  it("installs jarvis@jarvis from a checkout and its cache copy holds every skill as real files", () => {
    const repo = join(root, "repo");
    const home = join(root, "home");
    mkdirSync(repo);
    mkdirSync(home);
    const tar = join(root, "head.tar");
    execFileSync("git", ["archive", "--format=tar", "-o", tar, "HEAD"], { cwd: repoRoot });
    execFileSync("tar", ["-xf", tar, "-C", repo]);
    const env = { HOME: home, USER: process.env.USER ?? "jarvis-test", LANG: "en_US.UTF-8", TMPDIR: root, SHELL: "/bin/sh", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
    const claude = (...args: string[]) => {
      const r = spawnSync(pinnedClaudeBin(), args, { env, encoding: "utf8", timeout: 120_000 });
      expect(r.status, `${args.join(" ")}\n${r.stdout}\n${r.stderr}`).toBe(0);
      return r.stdout;
    };
    claude("plugin", "marketplace", "add", repo, "--scope", "user");
    claude("plugin", "install", "jarvis@jarvis", "--scope", "user");
    const plugins = JSON.parse(claude("plugin", "list", "--json")) as { id: string; scope: string; installPath: string }[];
    const plugin = plugins.find((p) => p.id === "jarvis@jarvis" && p.scope === "user");
    expect(plugin).toBeDefined();
    const skills = [...new Set([...namedSkills(repo), ...repoSkills(repo)])];
    expect(skills.length).toBeGreaterThan(0);
    // Real files inside the install copy: a link back into the checkout would break when it moves.
    const inside = `${realpathSync(plugin!.installPath)}/`;
    expect(lstatSync(join(plugin!.installPath, "skills")).isSymbolicLink()).toBe(false);
    for (const s of skills) {
      const file = join(plugin!.installPath, "skills", s, "SKILL.md");
      expect(existsSync(file) && lstatSync(file).isFile() && realpathSync(file).startsWith(inside), file).toBe(true);
    }
    const details = claude("plugin", "details", "jarvis@jarvis");
    const listed = /Skills \(\d+\)\s+(.*)/.exec(details)?.[1]?.split(/,\s*/) ?? [];
    for (const s of skills) expect(listed, s).toContain(s);
  }, 300_000);
});
