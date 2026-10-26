// Where a test (or the code under test) starts a bare `git` and PATH would find macOS's /usr/bin/git shim,
// useRealGit(path) makes this process start the git binary the shim would have run instead. Same binary,
// same arguments, same environment; only the shim's lookup (about 14 ms of CPU per spawn) is skipped. A
// spawn that names any other git, finds a different one first on PATH, or uses a shell is left alone.
// tests/setup/real-git.ts calls it for every test file. Worker threads and child Node processes have their
// own module instances and are not covered; a worker that starts git calls useRealGit itself (the path is
// tests/setup/real-git-global.ts's `realGit`, which a test passes along with inject("realGit")).
import cp from "node:child_process";
import { accessSync, constants } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const SHIM = "/usr/bin/git";
const installed = Symbol.for("jarvis.realGit");

/** True if a spawn with this PATH would run the shim: the first `git` on it is /usr/bin/git. */
function findsShim(path: string, cache: Map<string, boolean>): boolean {
  let found = cache.get(path);
  if (found === undefined) {
    found = false;
    for (const dir of path.split(delimiter)) {
      const candidate = join(dir || ".", "git");
      try {
        accessSync(candidate, constants.X_OK);
        found = candidate === SHIM;
        break;
      } catch {
        // not here
      }
    }
    cache.set(path, found);
  }
  return found;
}

export function useRealGit(realGit: string): void {
  const marks = cp as unknown as Record<symbol, true>;
  if (!realGit || marks[installed]) return;
  marks[installed] = true;
  const cache = new Map<string, boolean>();
  /** The binary to run: the real git in place of a bare `git` that would find the shim. */
  const swap = (file: unknown, rest: unknown[]): unknown => {
    if (file !== "git") return file;
    const options = rest.find((a): a is { env?: Record<string, string | undefined>; shell?: unknown } => typeof a === "object" && a !== null && !Array.isArray(a));
    if (options?.shell) return file;
    // The PATH a spawn searches: its own env's (Node falls back to /usr/bin:/bin when that env has none), else this process's.
    const path = options?.env ? (options.env.PATH ?? "/usr/bin:/bin") : (process.env.PATH ?? "");
    return findsShim(path, cache) ? realGit : file;
  };
  const target = cp as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of ["execFileSync", "spawnSync", "spawn", "execFile"]) {
    const original = target[name]!;
    const wrapper = function (this: unknown, file: unknown, ...rest: unknown[]) {
      return original.call(this, swap(file, rest), ...rest);
    };
    // execFile has a promisified form of its own (util.promisify); keep it, with the same swap.
    const custom = (original as unknown as Record<symbol, ((...args: unknown[]) => unknown) | undefined>)[promisify.custom];
    if (custom) (wrapper as unknown as Record<symbol, unknown>)[promisify.custom] = (file: unknown, ...rest: unknown[]) => custom(swap(file, rest), ...rest);
    target[name] = wrapper;
  }
  syncBuiltinESMExports();
}
