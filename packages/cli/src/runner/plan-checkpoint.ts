import { lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
  const branch = git(["symbolic-ref", "--quiet", "HEAD"]);
  if (!branch.startsWith("refs/heads/")) throw new Error("planning checkpoint needs a checked-out branch");
  const temporary = mkdtempSync(join(tmpdir(), "jarvis-plan-index-"));
  try {
    const index = (args: readonly string[]) => safeGit(repo, args, { home, env: { GIT_INDEX_FILE: join(temporary, "index") } }).toString().trim();
    index(head ? ["read-tree", head] : ["read-tree", "--empty"]);
    // Hash exactly the bytes validated above, without git add or repository clean filters.
    const blobs = paths.map((path) => ({ path, hash: safeGit(repo, ["hash-object", "-w", "--stdin"], { home, input: Buffer.from(contents.get(path)!) }).toString().trim() }));
    for (const { path, hash } of blobs) index(["update-index", "--add", "--cacheinfo", "100644", hash, path]);
    const tree = index(["write-tree"]);
    const unchanged = head !== undefined && tree === git(["rev-parse", `${head}^{tree}`]);
    const revision = unchanged ? head! : git(["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", "Checkpoint Jarvis planning inputs"]);
    if (!unchanged) git(["update-ref", branch, revision, head ?? "0".repeat(revision.length)]);
    // Preserve unrelated staged entries. A failed index write reports an error; a retry repairs these
    // selected entries without another commit. Worktree bytes changed meanwhile remain dirty.
    for (const { path, hash } of blobs) git(["update-index", "--add", "--cacheinfo", "100644", hash, path]);
    return revision;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
