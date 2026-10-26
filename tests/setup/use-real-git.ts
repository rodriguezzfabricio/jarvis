// Where a test (or the code under test) starts a bare `git` and PATH would find macOS's /usr/bin/git shim,
// useRealGit(path, shimEnv) makes this process start the git binary the shim would have run instead, with
// the same arguments and the same environment, plus the few SDK variables the shim adds to what git passes on
// (tests/setup/real-git-global.ts finds them), so even the processes git starts see what they would have
// seen. Only the shim's lookup (about 14 ms of CPU per spawn) is skipped. A spawn that names any other git,
// finds a different one first on PATH, or uses a shell is left alone. One visible difference: an error from
// a failed git names the real binary's path ("Command failed: /Applications/Xcode.app/.../git ...") instead
// of "git", so a test that matches that text should match the arguments.
// tests/setup/real-git.ts calls it for every test file. Worker threads and child Node processes have their
// own module instances and are not covered; a worker that starts git calls useRealGit itself (with the
// `realGit` and `shimEnv` a test passes along from inject()).
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

type Options = { env?: Record<string, string | undefined>; shell?: unknown };
const isOptions = (a: unknown): a is Options => typeof a === "object" && a !== null && !Array.isArray(a);

export function useRealGit(realGit: string, shimEnv: Record<string, string> = {}): void {
  const marks = cp as unknown as Record<symbol, true>;
  if (!realGit || marks[installed]) return;
  marks[installed] = true;
  const cache = new Map<string, boolean>();
  /** The call to make: the real git in place of a bare `git` that would find the shim, with the variables the shim adds. */
  const swap = (file: unknown, rest: unknown[]): [unknown, unknown[]] => {
    if (file !== "git") return [file, rest];
    const at = Array.isArray(rest[0]) ? 1 : 0; // (file, args?, options?, callback?)
    const options = isOptions(rest[at]) ? rest[at] as Options : undefined;
    if (options?.shell) return [file, rest];
    // The PATH a spawn searches: its own env's (Node falls back to /usr/bin:/bin when that env has none), else this process's.
    const path = options?.env ? (options.env.PATH ?? "/usr/bin:/bin") : (process.env.PATH ?? "");
    if (!findsShim(path, cache)) return [file, rest];
    const env = { ...(options?.env ?? process.env) };
    for (const [key, value] of Object.entries(shimEnv)) if (env[key] === undefined) env[key] = value;
    const next = [...rest];
    next.splice(at, options ? 1 : 0, { ...options, env });
    return [realGit, next];
  };
  const target = cp as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of ["execFileSync", "spawnSync", "spawn", "execFile"]) {
    const original = target[name]!;
    const wrapper = function (this: unknown, file: unknown, ...rest: unknown[]) {
      const [bin, args] = swap(file, rest);
      return original.call(this, bin, ...args);
    };
    // execFile has a promisified form of its own (util.promisify); keep it, with the same swap.
    const custom = (original as unknown as Record<symbol, ((...args: unknown[]) => unknown) | undefined>)[promisify.custom];
    if (custom) (wrapper as unknown as Record<symbol, unknown>)[promisify.custom] = (file: unknown, ...rest: unknown[]) => { const [bin, args] = swap(file, rest); return custom(bin, ...args); };
    target[name] = wrapper;
  }
  syncBuiltinESMExports();
}
