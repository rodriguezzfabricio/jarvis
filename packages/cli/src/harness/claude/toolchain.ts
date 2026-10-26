import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { SessionToolchain } from "../../toolchain/go.ts";

/**
 * A pinned toolchain in a task session (decision 123): what the session reads but never writes, what goes
 * on its PATH, and the toolchain's own variables. Checked before any session gets it, because the session
 * runs what is there: its folders must not overlap any folder a session (this one or another) can write,
 * or the runner folder, and its PATH entries and paths must lie inside them.
 */
export interface ToolchainParts {
  readOnlyDirs: string[];
  pathPrefix: string[];
  env: Record<string, string>;
}

/** The only variables a toolchain may set; everything else in a session's environment stays the runner's. */
const TOOLCHAIN_ENV = new Set(["GOTOOLCHAIN", "GOMODCACHE", "GOPROXY", "GOSUMDB", "GOFLAGS", "CGO_ENABLED"]);

const under = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);

/** `writable`: the worktree and cache roots, the runner folder, and any other folder sessions write. */
export function checkSessionToolchain(t: SessionToolchain | undefined, writable: readonly string[]): ToolchainParts {
  if (t === undefined) return { readOnlyDirs: [], pathPrefix: [], env: {} };
  for (const d of t.readOnlyDirs) {
    const st = isAbsolute(d) ? lstatSync(d, { throwIfNoEntry: false }) : undefined;
    if (!st?.isDirectory() || realpathSync(d) !== d) throw new Error(`a toolchain folder must be an existing absolute real path, not a link: ${d}`);
    for (const w of writable) if (under(d, w) || under(w, d)) throw new Error(`a toolchain folder must not overlap a folder sessions write or the runner folder: ${d}`);
  }
  const inside = (p: string) => t.readOnlyDirs.some((d) => under(p, d));
  for (const p of t.pathPrefix) if (!isAbsolute(p) || p.includes(":") || !inside(p)) throw new Error(`a toolchain PATH entry must lie inside its read-only folders: ${p}`);
  for (const [k, v] of Object.entries(t.env)) {
    if (!TOOLCHAIN_ENV.has(k)) throw new Error(`a toolchain may not set ${k}`);
    if (isAbsolute(v) && !inside(v)) throw new Error(`a toolchain's ${k} must point inside its read-only folders: ${v}`);
  }
  return { readOnlyDirs: [...t.readOnlyDirs], pathPrefix: [...t.pathPrefix], env: { ...t.env } };
}

/** The toolchain's variables, and its PATH entries between `head` (the jarvis launcher) and the fixed PATH. */
export function toolchainEnv(parts: ToolchainParts, head: readonly string[], rest: string): Record<string, string> {
  return { ...parts.env, ...(parts.pathPrefix.length ? { PATH: [...head, ...parts.pathPrefix, rest].join(":") } : {}) };
}
