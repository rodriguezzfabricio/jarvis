import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
export const insideTree = (root: string, path: string): boolean => { const rel = relative(root, path); return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)); };
export const fileHash = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Source aliases become independent real files. Every resolved source must remain in the source tree. */
export function materializeTree(source: string, destination: string): Record<string, string> {
  const root = realpathSync(source);
  if (!statSync(root).isDirectory() || existsSync(destination) || insideTree(root, destination)) throw new Error("invalid materialization destination");
  const files: Record<string, string> = Object.create(null) as Record<string, string>;
  const walk = (from: string, to: string, parents: Set<string>) => {
    const real = realpathSync(from);
    if (!insideTree(root, real)) throw new Error("bundle source escapes its tree");
    const stat = statSync(real);
    if (stat.isDirectory()) {
      if (parents.has(real)) throw new Error("cyclic bundle source link");
      mkdirSync(to, { mode: 0o700 });
      for (const name of readdirSync(real)) walk(join(real, name), join(to, name), new Set([...parents, real]));
      chmodSync(to, stat.mode & 0o777);
    } else {
      if (!stat.isFile()) throw new Error("bundle contains a special file");
      copyFileSync(real, to); chmodSync(to, stat.mode & 0o777);
      files[relative(destination, to)] = fileHash(to);
    }
  };
  try { walk(root, destination, new Set()); return files; }
  catch (error) { rmSync(destination, { recursive: true, force: true }); throw error; }
}

export function assertNoBundleLinks(root: string): void {
  for (const name of readdirSync(root)) {
    const path = join(root, name); const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("installed bundles must be symlink-free");
    if (stat.isDirectory()) assertNoBundleLinks(path);
    else if (!stat.isFile()) throw new Error("installed bundle contains a special file");
  }
}
