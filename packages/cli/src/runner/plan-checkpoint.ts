import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { safeGit } from "../eval/git.ts";
import { checkRepository, checkSpec } from "../spec/index.ts";
import { readPlanningFile } from "./checks-author.ts";

/** Commit planning inputs before their independent reviews. Never stage product code or .jarvis.
 * Interactive sessions cannot make a candidate commit; this narrow runner command supplies the
 * missing transition from confirmed documents to committed, reviewable planning inputs. */
export function checkpointPlan(repoPath: string, home: string): string {
  const repo = realpathSync(repoPath);
  const checked = checkRepository(repo);
  if (!checked.ok || !checked.versions.length) throw new Error(`planning checkpoint needs a valid spec history: ${checked.problems.map((p) => p.message).join("; ")}`);
  const paths = checked.versions.map((v) => relative(repo, v.path));
  for (const path of ["PRODUCT.md", "DESIGN.md", "docs/decisions.md"]) if (lstatSync(join(repo, path), { throwIfNoEntry: false })) paths.push(path);
  for (const folder of ["docs/research", "docs/intake"]) {
    const st = lstatSync(join(repo, folder), { throwIfNoEntry: false });
    if (!st) continue;
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${folder} must be a directory without symlinks`);
    for (const name of readdirSync(join(repo, folder)).sort()) if (/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/.test(name)) paths.push(`${folder}/${name}`);
  }
  if (paths.length > 256) throw new Error("planning checkpoint exceeds 256 documents");
  const contents = new Map(paths.map((path) => [path, readPlanningFile(repo, path)]));
  if ([...contents.values()].reduce((n, text) => n + Buffer.byteLength(text), 0) > 4 * 1024 * 1024) throw new Error("planning checkpoint exceeds 4 MiB");
  for (const version of checked.versions) {
    const path = relative(repo, version.path);
    if (checkSpec(contents.get(path)!, path).spec?.status === "draft") throw new Error(`${path} is draft; finish confirmation before checkpointing`);
  }
  const git = (args: readonly string[]) => safeGit(repo, args, { home }).toString().trim();
  let top: string | undefined;
  try { top = git(["rev-parse", "--show-toplevel"]); } catch { /* A new product may not have a repository yet. */ }
  if (top !== undefined && realpathSync(top) !== repo) throw new Error("planning checkpoint must run at the project repository root");
  if (top === undefined) git(["init", "--quiet", "-b", "main"]);
  let head: string | undefined;
  try { head = git(["rev-parse", "--verify", "HEAD^{commit}"]); } catch { /* Unborn repository. */ }
  if (head) {
    const previous = git(["ls-tree", "-r", "--name-only", head, "--", "docs/spec"]).split("\n").filter((path) => /^docs\/spec\/v[1-9]\d*\.md$/.test(path));
    for (const path of previous) {
      const old = safeGit(repo, ["show", `${head}:${path}`], { home }).toString();
      const oldStatus = checkSpec(old, path).spec?.status;
      if (oldStatus !== "confirmed" && oldStatus !== "unconfirmed") continue;
      const current = contents.get(path);
      if (current !== old && !(oldStatus === "unconfirmed" && current === old.replace(/^status: unconfirmed$/m, "status: confirmed"))) {
        throw new Error(`${path} is already approved; record changed content in a new spec version`);
      }
    }
  }
  const specs = paths.map((path) => `:(literal)${path}`);
  if (head && git(["status", "--porcelain", "--untracked-files=all", "--", ...specs]) === "") return head;
  // An initial empty commit lets --only preserve unrelated staged work even in an unborn repo.
  if (!head) git(["commit", "--allow-empty", "--only", "--quiet", "-m", "Initialize Jarvis planning"]);
  git(["add", "--", ...specs]);
  git(["commit", "--only", "--quiet", "-m", "Checkpoint Jarvis planning inputs", "--", ...specs]);
  return git(["rev-parse", "HEAD"]);
}
