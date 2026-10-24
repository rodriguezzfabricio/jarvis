import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface ProjectOptions { option?: string; env: Record<string, string | undefined>; cwd: string }

/** Walking markers avoids running project hooks or loading Git configuration. A .git file also
 * marks a linked worktree; its contents are never executed or used to choose the project root. */
export function projectRoot(repoDir: string): string {
  let directory = realpathSync.native(repoDir);
  for (;;) {
    const marker = lstatSync(join(directory, ".git"), { throwIfNoEntry: false });
    if (marker?.isSymbolicLink()) throw new Error("Project .git marker may not be a symlink");
    if (marker?.isDirectory() || marker?.isFile()) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Project directory is not inside a Git repository");
    directory = parent;
  }
}
export function projectId(repoDir: string): string {
  const root = projectRoot(repoDir);
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return `${basename(root)}-${hash}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}
export function resolveProject(options: ProjectOptions): string {
  const id = options.option ?? options.env.JARVIS_PROJECT ?? projectId(options.cwd);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid project id");
  return id;
}
