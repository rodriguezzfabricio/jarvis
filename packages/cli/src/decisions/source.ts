import { realpathSync } from "node:fs";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";

/** Syntax is checked even by the pure parser; filesystem checks belong to the repository writer. */
export function isRepoRelativeSource(value: string): boolean {
  if (value.trim() !== value || /[\p{Cc}\u2028\u2029]/u.test(value) || value.includes("\\")) return false;
  const parts = value.split("#");
  const path = parts[0]!;
  return parts.length <= 2 && (parts.length === 1 || parts[1] !== "") && path.length > 0
    && !path.startsWith("/") && !/^[a-z]:/i.test(path) && posix.normalize(path) === path
    && path.split("/").every((part) => part !== ".." && part !== "." && part !== "");
}

export function validateSource(repo: string, source: string): void {
  if (!isRepoRelativeSource(source)) throw new Error("Source must be a normalized repo-relative path with an optional anchor");
  const root = realpathSync(repo);
  let target: string;
  try { target = realpathSync(resolve(root, source.split("#")[0]!)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Source must exist: ${source}`);
    throw error;
  }
  const path = relative(root, target);
  if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error(`Source must stay inside the repo: ${source}`);
}
