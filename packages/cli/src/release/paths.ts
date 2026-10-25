import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

export function within(root: string, path: string, allowRoot = false): boolean {
  const rel = relative(root, path);
  return isAbsolute(root) && isAbsolute(path) && (allowRoot || rel !== "") && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Resolve both sides before enforcing confinement, so a symlink cannot reopen the runner home. */
export function realChild(root: string, path: string, allowRoot = false): string {
  if (!isAbsolute(root) || !isAbsolute(path)) throw new Error("runner roots and paths must be absolute");
  const base = realpathSync(root);
  const actual = realpathSync(path);
  if (!within(base, actual, allowRoot)) throw new Error("path outside runner root");
  return actual;
}
