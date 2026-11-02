import { lstatSync, mkdtempSync, opendirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { safeGit } from "../eval/git.ts";
import { listVersions, checkSpec } from "../spec/index.ts";
import { readPlanningFile } from "./checks-author.ts";

/** Git may write objects, refs, logs and indexes below its metadata root. None may redirect. */
function assertGitStorage(root: string): void {
  let entries = 0;
  const walk = (path: string, depth: number): void => {
    if (depth > 40) throw new Error("Git storage exceeds directory depth limit");
    const directory = opendirSync(path);
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        if (++entries > 100_000) throw new Error("Git storage exceeds entry limit");
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error("Git storage must contain regular files and directories without symlinks");
        if (entry.isDirectory()) walk(join(path, entry.name), depth + 1);
      }
    } finally { directory.closeSync(); }
  };
  walk(root, 0);
}

function assertGitMarker(repo: string): void {
  const marker = lstatSync(join(repo, ".git"), { throwIfNoEntry: false });
  if (marker?.isSymbolicLink()) throw new Error("Project .git marker may not be a symlink");
  if (marker?.isDirectory() && lstatSync(join(repo, ".git/commondir"), { throwIfNoEntry: false })) throw new Error("Directory .git may not redirect common storage");
  if (marker?.isDirectory()) assertGitStorage(join(repo, ".git"));
  if (marker && !marker.isDirectory()) {
    if (!marker.isFile()) throw new Error("Project .git marker must name a repository or linked worktree");
    try {
      const pointer = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(readPlanningFile(repo, ".git", 4096));
      if (!pointer) throw new Error("invalid pointer");
      const gitdir = realpathSync(resolve(repo, pointer[1]!));
      const common = realpathSync(resolve(gitdir, readPlanningFile(gitdir, "commondir", 4096).trim()));
      if (dirname(gitdir) !== join(common, "worktrees") || !basename(gitdir) || lstatSync(join(common, "commondir"), { throwIfNoEntry: false })) throw new Error("unregistered common storage");
      const backlink = readPlanningFile(gitdir, "gitdir", 4096).trim();
      if (realpathSync(resolve(gitdir, backlink)) !== join(repo, ".git")) throw new Error("foreign pointer");
      assertGitStorage(common);
    } catch { throw new Error("Project .git file must belong to this linked worktree"); }
  }
}

/** Supply project identity before intake. This command never stages or commits a file. */
export function initializePlanningRepository(repoPath: string, home: string): string {
  const repo = realpathSync(repoPath);
  assertGitMarker(repo);
  let top: string | undefined;
  try { top = safeGit(repo, ["rev-parse", "--show-toplevel"], { home }).toString().trim(); }
  catch (error) { if (lstatSync(join(repo, ".git"), { throwIfNoEntry: false })) throw error; }
  if (top !== undefined && realpathSync(top) !== repo) throw new Error("planning initialization must run at the project repository root");
  if (top === undefined) safeGit(repo, ["init", "--quiet", "-b", "main"], { home });
  return repo;
}

/** Commit planning inputs before their independent reviews. Never stage product code or .jarvis.
 * Interactive sessions cannot make a candidate commit; this narrow runner command supplies the
 * missing transition from confirmed documents to committed, reviewable planning inputs. */
export function checkpointPlan(repoPath: string, home: string): string {
  const repo = realpathSync(repoPath);
  assertGitMarker(repo);
  const versions = listVersions(repo);
  if (!versions.length) throw new Error("planning checkpoint needs a valid spec history: no versions");
  const paths = versions.map((v) => relative(repo, v.path));
  for (const path of ["PRODUCT.md", "DESIGN.md", "docs/decisions.md"]) if (lstatSync(join(repo, path), { throwIfNoEntry: false })) paths.push(path);
  for (const folder of ["docs/research", "docs/intake"]) {
    const st = lstatSync(join(repo, folder), { throwIfNoEntry: false });
    if (!st) continue;
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${folder} must be a directory without symlinks`);
    for (const name of readdirSync(join(repo, folder)).sort()) if (/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/.test(name)) paths.push(`${folder}/${name}`);
  }
  if (paths.length > 256) throw new Error("planning checkpoint exceeds 256 documents");
  const contents = new Map<string, string>();
  let bytes = 0;
  for (const path of paths) {
    const content = readPlanningFile(repo, path);
    bytes += Buffer.byteLength(content);
    if (bytes > 4 * 1024 * 1024) throw new Error("planning checkpoint exceeds 4 MiB");
    contents.set(path, content);
  }
  let previous = 0;
  for (const version of versions) {
    const path = relative(repo, version.path);
    if (version.version !== previous + 1) throw new Error(`planning checkpoint needs a valid spec history: Missing v${previous + 1}.md before v${version.version}.md`);
    previous = version.version;
    const checked = checkSpec(contents.get(path)!, path);
    if (!checked.ok) throw new Error(`planning checkpoint needs a valid spec history: ${checked.problems.map((p) => p.message).join("; ")}`);
    if (checked.spec.status === "draft") throw new Error(`${path} is draft; finish confirmation before checkpointing`);
  }
  const git = (args: readonly string[]) => safeGit(repo, args, { home }).toString().trim();
  initializePlanningRepository(repo, home);
  let head: string | undefined;
  try { head = git(["rev-parse", "--verify", "HEAD^{commit}"]); } catch { /* Unborn repository. */ }
  if (head) {
    const previous = safeGit(repo, ["ls-tree", "-r", "--name-only", head, "--", "docs/spec"], { home, maxBuffer: 256 * 1024 }).toString().trim().split("\n").filter((path) => /^docs\/spec\/v[1-9]\d*\.md$/.test(path));
    if (previous.length > 256) throw new Error("committed planning history exceeds 256 documents");
    let historicalBytes = 0;
    for (const path of previous) {
      const size = Number(git(["cat-file", "-s", `${head}:${path}`]));
      if (!Number.isSafeInteger(size) || size < 0 || size > 256 * 1024 || (historicalBytes += size) > 4 * 1024 * 1024) throw new Error("committed planning history exceeds byte limit");
      const old = safeGit(repo, ["show", `${head}:${path}`], { home, maxBuffer: 256 * 1024 }).toString();
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
