// Vitest globalSetup (vitest.config.ts): finds the real git binary once per run, for tests/setup/real-git.ts.
// On macOS, /usr/bin/git is a shim that looks up the active developer directory and then runs the git in
// it. Every spawn through the shim costs about three times the CPU of the real git (measured: about 22 ms
// against about 8 ms for `git rev-parse`), and the suite starts thousands of them.
//
// The shim also puts a few SDK variables (CPATH, LIBRARY_PATH, MANPATH, SDKROOT) into the environment it
// passes on, which only processes git itself starts (hooks, fsmonitor, aliases, filters) can see. So that the
// redirect changes nothing for them, this finds out exactly what the shim adds, by asking both binaries for
// their environment, and tests/setup/use-real-git.ts adds the same variables. If the two environments differ
// in any other way, the redirect stays off.
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** Absolute path of the git the /usr/bin/git shim would run, or "" when there is nothing to swap. */
    realGit: string;
    /** The variables the shim adds to git's environment (and the redirect must add too). */
    shimEnv: Record<string, string>;
  }
}

/** The environment a process started by git (an alias that runs env) sees, from `bin` run with a clean environment. */
function childEnvironment(bin: string, home: string): Map<string, string> {
  const env = { PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const out = execFileSync(bin, ["-c", "alias.e=!env", "e"], { cwd: home, env, encoding: "utf8" });
  return new Map(out.split("\n").filter((l) => l.includes("=") && !l.startsWith("_=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}

export default function setup(project: TestProject): void {
  let realGit = "";
  let shimEnv: Record<string, string> = {};
  if (process.platform === "darwin") {
    const home = mkdtempSync(join(tmpdir(), "jarvis-shim-"));
    try {
      // The shim's own rule: DEVELOPER_DIR when set, otherwise what xcode-select reports.
      const developerDir = process.env.DEVELOPER_DIR || execFileSync("/usr/bin/xcode-select", ["-p"], { encoding: "utf8" }).trim();
      const candidate = `${developerDir}/usr/bin/git`;
      accessSync(candidate, constants.X_OK);
      const viaShim = childEnvironment("/usr/bin/git", home);
      const direct = childEnvironment(candidate, home);
      const changed = [...direct].filter(([key, value]) => viaShim.get(key) !== value);
      if (changed.length === 0) {
        realGit = candidate;
        shimEnv = Object.fromEntries([...viaShim].filter(([key]) => !direct.has(key)));
      }
    } catch {
      // No developer directory, or the environments could not be compared: leave the shim in place.
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
  project.provide("realGit", realGit);
  project.provide("shimEnv", shimEnv);
}
