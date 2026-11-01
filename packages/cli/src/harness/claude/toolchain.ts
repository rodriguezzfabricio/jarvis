import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { SessionToolchain } from "../../toolchain/go.ts";

/**
 * A pinned toolchain in a task session (decisions 123 and 164): what the session reads but never writes, what goes
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
const TOOLCHAIN_ENV = new Set([
  // Go (decision 123).
  "GOTOOLCHAIN", "GOMODCACHE", "GOPROXY", "GOSUMDB", "GOFLAGS", "CGO_ENABLED",
  // Rust (decision 164): Cargo's config and crates, no network, and the SDK clang links against.
  "CARGO_HOME", "CARGO_NET_OFFLINE", "SDKROOT", "DEVELOPER_DIR",
]);

/**
 * The system folders a toolchain may name besides its own read-only ones (decision 164): only the Command Line
 * Tools, which Rust links through, and only while they are root-owned and writable by nobody else. Tests replace
 * these, since a test can't make a root-owned folder.
 */
export const systemToolchainPolicy = {
  roots: (): readonly string[] => ["/Library/Developer/CommandLineTools"],
  owned: (path: string): boolean => { const st = lstatSync(path); return st.uid === 0 && (st.mode & 0o022) === 0; },
};

const under = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);

/** `writable`: the worktree and cache roots, the runner folder, and any other folder sessions write. */
export function checkSessionToolchain(t: SessionToolchain | undefined, writable: readonly string[]): ToolchainParts {
  if (t === undefined) return { readOnlyDirs: [], pathPrefix: [], env: {} };
  for (const d of t.readOnlyDirs) {
    const st = isAbsolute(d) ? lstatSync(d, { throwIfNoEntry: false }) : undefined;
    if (!st?.isDirectory() || realpathSync(d) !== d) throw new Error(`a toolchain folder must be an existing absolute real path, not a link: ${d}`);
    for (const w of writable) if (under(d, w) || under(w, d)) throw new Error(`a toolchain folder must not overlap a folder sessions write or the runner folder: ${d}`);
  }
  // Decision 164: system folders only from the fixed list, as their real, root-owned selves, and never writable.
  const system = t.systemDirs ?? [];
  for (const d of system) {
    const allowed = systemToolchainPolicy.roots().includes(d) && lstatSync(d, { throwIfNoEntry: false })?.isDirectory() === true && realpathSync(d) === d;
    if (!allowed) throw new Error(`a toolchain's system folder ${d} is not one a toolchain may use (${systemToolchainPolicy.roots().join(", ")})`);
    if (!systemToolchainPolicy.owned(d)) throw new Error(`a toolchain's system folder must be owned by root and writable by nobody else: ${d}`);
    if (writable.some((w) => under(d, w) || under(w, d))) throw new Error(`a toolchain's system folder must not overlap a folder sessions write or the runner folder: ${d}`);
  }
  const inside = (p: string) => [...t.readOnlyDirs, ...system].some((d) => under(p, d));
  for (const p of t.pathPrefix) if (!isAbsolute(p) || p.includes(":") || !inside(p)) throw new Error(`a toolchain PATH entry must lie inside its read-only folders: ${p}`);
  for (const [k, v] of Object.entries(t.env)) {
    if (!TOOLCHAIN_ENV.has(k)) throw new Error(`a toolchain may not set ${k}`);
    if (isAbsolute(v) && !inside(v)) throw new Error(`a toolchain's ${k} must point inside its read-only folders: ${v}`);
  }
  // System folders are reopened read-only too, so the session's read block (decision 69) can't hide what it runs.
  return { readOnlyDirs: [...t.readOnlyDirs, ...system], pathPrefix: [...t.pathPrefix], env: { ...t.env } };
}

/** The toolchain's variables, and its PATH entries between `head` (the jarvis launcher) and the fixed PATH. */
export function toolchainEnv(parts: ToolchainParts, head: readonly string[], rest: string): Record<string, string> {
  return { ...parts.env, ...(parts.pathPrefix.length ? { PATH: [...head, ...parts.pathPrefix, rest].join(":") } : {}) };
}
