import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkTrustedDir, checkTrustedTree, refuseSymlink, type TrustOptions } from "../config/private-file.ts";
import { checkPlugin } from "../doctor/foundation.ts";
import { TASK_SKILLS } from "../harness/claude/task-plugin.ts";

/**
 * The installed plugin at ~/.jarvis/plugin: the repo's plugin with its skills link materialized as real,
 * owner-only files. It is the source for each task session's own plugin (assembleTaskPlugin keeps only
 * the build-loop skills); only that per-session copy reaches --plugin-dir (Codex review of setup, finding 2).
 */
const MAX_FILES = 2000;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 16;
const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/** Copies source into the new folder dest as real files. Links are followed only if they stay inside source's parent (the repo). */
function materialize(source: string, dest: string): void {
  const bound = realpathSync(dirname(source));
  let files = 0;
  let bytes = 0;
  const walk = (from: string, to: string, depth: number) => {
    if (depth > MAX_DEPTH) throw new Error(`${from} is nested too deeply`);
    mkdirSync(to, { mode: 0o700 });
    for (const name of readdirSync(from).sort()) {
      const path = join(from, name);
      const link = lstatSync(path).isSymbolicLink();
      if (link && !under(realpathSync(path), bound)) throw new Error(`${path} links outside ${bound}`);
      const st = statSync(path);
      if (st.isDirectory()) walk(path, join(to, name), depth + 1);
      else if (st.isFile()) {
        if (++files > MAX_FILES || (bytes += st.size) > MAX_BYTES) throw new Error("the plugin is too large");
        const fd = openSync(link ? realpathSync(path) : path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          if (!fstatSync(fd).isFile()) throw new Error(`${path} must be a regular file`);
          writeFileSync(join(to, name), readFileSync(fd), { mode: 0o600, flag: "wx" });
        } finally { closeSync(fd); }
      } else throw new Error(`${path} must be a regular file or folder`);
    }
  };
  walk(realpathSync(source), dest, 0);
}

/** Doctor's plugin check, the build-loop skills, and a trusted tree: ours, real files, writable only by us. */
function verifyInstalled(dir: string, options: TrustOptions): void {
  checkTrustedTree(dir, options);
  const check = checkPlugin(dir);
  if (check.level !== "pass") throw new Error(`doctor's plugin check failed on ${dir}: ${check.detail}`);
  for (const skill of TASK_SKILLS) {
    if (!lstatSync(join(dir, "skills", skill, "SKILL.md"), { throwIfNoEntry: false })?.isFile()) throw new Error(`${dir} is missing the ${skill} skill`);
  }
}

/** Materializes the repo's plugin into ~/.jarvis/plugin, verifies the staged copy, then swaps it in. */
export function installPlugin(source: string, jarvisDir: string, options: TrustOptions = {}): string {
  checkTrustedDir(jarvisDir, options);
  const dest = join(jarvisDir, "plugin");
  refuseSymlink(dest);
  const sourceCheck = checkPlugin(source);
  if (sourceCheck.level !== "pass") throw new Error(`the repo's plugin at ${source} is incomplete: ${sourceCheck.detail}`);
  const staging = mkdtempSync(join(jarvisDir, ".plugin-new-"));
  const old = join(jarvisDir, `.plugin-old-${staging.slice(staging.lastIndexOf("-") + 1)}`);
  try {
    const staged = join(staging, "plugin");
    materialize(source, staged);
    verifyInstalled(staged, options);
    const existing = lstatSync(dest, { throwIfNoEntry: false });
    if (existing) renameSync(dest, old);
    try {
      renameSync(staged, dest);
    } catch (error) {
      if (existing) renameSync(old, dest);
      throw error;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(old, { recursive: true, force: true });
  }
  verifyInstalled(dest, options);
  return dest;
}

/** The runner passes this to the Claude harness as its plugin source. It refuses a substituted or tampered copy. */
export function taskPluginSource(jarvisDir: string, options: TrustOptions = {}): string {
  checkTrustedDir(jarvisDir, options);
  const dir = join(jarvisDir, "plugin");
  verifyInstalled(dir, options);
  return dir;
}
