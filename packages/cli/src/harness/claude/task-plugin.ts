import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * The plugin a task session loads with --plugin-dir (architecture §3.1, §5). The repo's plugin carries
 * every skill for the interactive session; a task session gets only the build-loop skills, the
 * manifest and the exact hooks, copied as real files into a runner-owned folder per session.
 * Skill evals stay behind: they are grading material, not instructions for the builder.
 */
export const TASK_SKILLS = ["build", "debug"] as const;
const TASK_FILES = [".claude-plugin/plugin.json", "hooks/hooks.json", "hooks/session-start.mjs", "hooks/tripwire.mjs"] as const;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 256;

const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/** A plugin source must not be somewhere a task session can write (worktrees, caches). */
export function checkTaskPluginSource(source: string, agentWritable: readonly string[]): void {
  if (!isAbsolute(source)) throw new Error("plugin source must be an absolute path");
  const real = realpathSync(source);
  for (const root of agentWritable) {
    if (under(resolve(source), root) || under(real, root)) throw new Error("plugin source must be outside worktrees and caches");
  }
}

/** Copies the task plugin from `source` (the repo's plugin/) into the new folder `dest`; returns `dest`. */
export function assembleTaskPlugin(source: string, dest: string): string {
  if (statSync(dest, { throwIfNoEntry: false })) throw new Error(`task plugin folder already exists: ${dest}`);
  const root = realpathSync(source);
  let files = 0;
  let bytes = 0;
  const copyFile = (from: string, to: string) => {
    const st = statSync(from); // follows links: plugin/skills is a link to ../skills
    if (!st.isFile()) throw new Error(`task plugin entries must be regular files or folders: ${from}`);
    if (st.size > MAX_FILE_BYTES || (bytes += st.size) > MAX_TOTAL_BYTES || ++files > MAX_FILES) throw new Error("task plugin is too large");
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    writeFileSync(to, readFileSync(from), { mode: 0o600, flag: "wx" });
  };
  const copyDir = (from: string, to: string, skip: readonly string[] = []) => {
    mkdirSync(to, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(from).sort()) {
      if (skip.includes(name)) continue;
      const path = join(from, name);
      if (statSync(path).isDirectory()) copyDir(path, join(to, name));
      else copyFile(path, join(to, name));
    }
  };
  mkdirSync(dest, { mode: 0o700 });
  for (const rel of TASK_FILES) copyFile(join(root, rel), join(dest, rel));
  for (const skill of TASK_SKILLS) {
    const from = join(root, "skills", skill);
    if (!statSync(from, { throwIfNoEntry: false })?.isDirectory() || !statSync(join(from, "SKILL.md"), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`task plugin source is missing the ${skill} skill`);
    }
    copyDir(from, join(dest, "skills", skill), ["evals"]);
  }
  return dest;
}
