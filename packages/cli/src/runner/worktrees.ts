import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, rmdirSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { runGate, type GateInput, type GateResult } from "../checks/gate.ts";
import { safeGit } from "../eval/git.ts";

export type RunnerGit = typeof safeGit;
export interface WorkspaceInput {
  repoPath: string;
  projectId: string;
  taskId: string;
  attemptId: string;
  baseRevision: string;
  /** Defaults to ~/.jarvis-work/worktrees (decision 67). */
  worktreeRoot?: string;
  home?: string;
  git?: RunnerGit;
}
export interface TaskWorkspace {
  path: string;
  repoPath: string;
  worktreeRoot: string;
  projectId: string;
  taskId: string;
  attemptId: string;
  baseRevision: string;
  home: string;
  /** Runner-held fingerprint, never read back from candidate-controlled metadata. */
  configHash: string;
}
export interface UntrustedTaskNotes {
  trust: "untrusted";
  text: string;
  truncated: boolean;
}
export interface CandidateRevision { revision: string; ref: string }
export interface WorkspaceFileChecks {
  lstat?: (path: string) => Stats;
  fstat?: (fd: number) => Stats;
}
export interface GitSeams { git?: RunnerGit; files?: WorkspaceFileChecks }
export interface CandidateBranchOptions extends GitSeams { home?: string }
export interface PromoteInput extends GitSeams {
  repoPath: string;
  candidate: CandidateRevision;
  runBranch: string;
  expectedHead: string;
  home?: string;
}
export type CandidateCheckInput = Omit<GateInput, "repoPath" | "revision" | "taskId" | "attemptId">;

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const revisionPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const configHash = (path: string) => createHash("sha256").update(readFileSync(join(path, ".git", "config"))).digest("hex");

function requireId(id: string): void {
  if (!idPattern.test(id)) throw new Error(`invalid workspace ID: ${id}`);
}
function requireRevision(revision: string): void {
  if (!revisionPattern.test(revision)) throw new Error("a full candidate/base revision is required");
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function plainDirectory(path: string): void {
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`expected a plain directory: ${path}`);
}
function command(git: RunnerGit, cwd: string, args: readonly string[], home: string, input?: Buffer, repositoryRoot: string | null = cwd): Buffer {
  const env: Record<string, string> = { GIT_NO_REPLACE_OBJECTS: "1" };
  if (repositoryRoot !== null) Object.assign(env, {
    GIT_DIR: join(repositoryRoot, ".git"), GIT_WORK_TREE: cwd, GIT_CEILING_DIRECTORIES: dirname(cwd),
  });
  return git(cwd, args, { home, env, ...(input ? { input } : {}) });
}
function candidateRef(w: Pick<TaskWorkspace, "taskId" | "attemptId">): string {
  return `refs/heads/jarvis/candidates/${w.taskId}/${w.attemptId}`;
}

function prepareRoot(input: WorkspaceInput): { root: string; project: string } {
  const path = resolve(input.worktreeRoot ?? join(homedir(), ".jarvis-work", "worktrees"));
  mkdirSync(path, { recursive: true, mode: 0o700 });
  plainDirectory(path);
  const root = realpathSync(path);
  const project = join(root, input.projectId);
  mkdirSync(project, { recursive: true, mode: 0o700 });
  plainDirectory(project);
  return { root, project };
}

/** Independent object storage and gitdir: a task never has access to the project repo's .git. */
export function createWorkspace(input: WorkspaceInput): TaskWorkspace {
  for (const id of [input.projectId, input.taskId, input.attemptId]) requireId(id);
  requireRevision(input.baseRevision);
  const { root, project } = prepareRoot(input);
  const path = join(project, `${input.taskId}-${input.attemptId}`);
  mkdirSync(path, { mode: 0o700 }); // Exclusive: never reuse an earlier attempt's folder.
  const git = input.git ?? safeGit;
  const home = input.home ?? homedir();
  const repoPath = realpathSync(input.repoPath);
  try {
    command(git, project, ["-c", "protocol.file.allow=always", "-c", "transfer.fsckObjects=true", "clone", "--quiet", "--no-hardlinks", "--no-checkout", "--template=", "--", repoPath, path], home, undefined, null);
    command(git, path, ["remote", "remove", "origin"], home);
    command(git, path, ["config", "core.hooksPath", "/dev/null"], home);
    command(git, path, ["checkout", "--quiet", "--detach", input.baseRevision], home);
    validateSymlinks(path);
    return { path, repoPath, worktreeRoot: root, projectId: input.projectId, taskId: input.taskId, attemptId: input.attemptId, baseRevision: input.baseRevision, home, configHash: configHash(path) };
  } catch (e) {
    rmSync(path, { recursive: true, force: true });
    throw e;
  }
}

function validateWorkspace(w: TaskWorkspace, git: RunnerGit = safeGit): void {
  const root = realpathSync(w.worktreeRoot);
  if (!inside(root, resolve(w.path))) throw new Error("workspace is outside worktree root");
  plainDirectory(join(root, w.projectId));
  plainDirectory(w.path);
  plainDirectory(join(w.path, ".git"));
  if (realpathSync(w.path) !== resolve(w.path)) throw new Error("workspace path contains a symlink");
  const walkGit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`git metadata may not contain symlinks: ${path}`);
      if (entry.isDirectory()) walkGit(path);
    }
  };
  walkGit(join(w.path, ".git"));
  if (configHash(w.path) !== w.configHash) throw new Error("workspace git config changed");
  for (const name of ["objects/info/alternates", "info/grafts", "commondir"]) {
    if (existsSync(join(w.path, ".git", name))) throw new Error(`shared or redirected git metadata: ${name}`);
  }
  requireRevision(command(git, w.path, ["rev-parse", "--verify", "HEAD^{commit}"], w.home).toString().trim());
}

function validateSymlinks(root: string, files: WorkspaceFileChecks = {}): void {
  const stat = files.lstat ?? lstatSync;
  const device = stat(root).dev;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (dir === root && entry.name === ".git") continue;
      const path = join(dir, entry.name);
      const st = stat(path);
      if (st.dev !== device) throw new Error(`workspace crosses a device boundary: ${path}`);
      if (st.isFile() && st.nlink > 1) throw new Error(`hardlink refused: ${path}`);
      if (st.isSymbolicLink()) {
        const link = readlinkSync(path);
        if (isAbsolute(link)) throw new Error(`absolute symlink refused: ${path}`);
        let target: string;
        try { target = realpathSync(resolve(dirname(path), link)); } catch { throw new Error(`dangling symlink: ${path}`); }
        if (!inside(root, target) || inside(join(root, ".git"), target) || target === join(root, ".git")) throw new Error(`symlink leaves workspace or enters git metadata: ${path}`);
      } else if (entry.isDirectory()) walk(path);
    }
  };
  walk(root);
}


type TreeContext = Pick<TaskWorkspace, "path" | "baseRevision" | "home">;

function rootIgnoresRunnerFiles(git: RunnerGit, w: TreeContext, tree?: string): boolean {
  if (tree !== undefined) return committedIgnorePolicy(git, w, tree);
  const path = join(w.path, ".jarvis");
  const created = !existsSync(path);
  if (created) mkdirSync(path);
  try {
    const fields = command(git, w.path, ["-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", "--verbose", "--non-matching", "-z", "--stdin"], w.home, Buffer.from(".jarvis\0")).toString().split("\0");
    return fields[0] === ".gitignore" && !!fields[2] && !fields[2].startsWith("!");
  } catch (e) {
    if ((e as { status?: number }).status === 1) return false;
    throw e;
  } finally {
    if (created) rmdirSync(path);
  }
}


function committedIgnorePolicy(git: RunnerGit, w: TreeContext, tree: string): boolean {
  const scratch = mkdtempSync(join(tmpdir(), "jarvis-ignore-"));
  try {
    let contents: Buffer;
    try { contents = command(git, w.path, ["show", `${tree}:.gitignore`], w.home); }
    catch (e) { if ((e as { status?: number }).status === 128) return false; throw e; }
    writeFileSync(join(scratch, ".gitignore"), contents);
    mkdirSync(join(scratch, ".jarvis"));
    const fields = command(git, scratch, ["-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", "--verbose", "--non-matching", "-z", "--stdin"], w.home, Buffer.from(".jarvis\0"), w.path).toString().split("\0");
    return (fields[0] === ".gitignore" || fields[0] === join(scratch, ".gitignore")) && !!fields[2] && !fields[2].startsWith("!");
  } catch (e) {
    if ((e as { status?: number }).status === 1) return false;
    throw e;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

function validateRunnerChanges(git: RunnerGit, w: TreeContext, tree?: string): void {
  const comparison = tree === undefined ? ["--cached", w.baseRevision] : [w.baseRevision, tree];
  const changed = command(git, w.path, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", ...comparison, "--"], w.home).toString().split("\0").filter(Boolean);
  if (changed.some((path) => path.split("/")[0]?.toLowerCase() === ".jarvis")) throw new Error("candidate changes runner-owned .jarvis paths");
  if (changed.some((path) => path.toLowerCase() === ".jarvis-routing.json")) throw new Error("candidate changes root routing policy");
  if (changed.some((path) => path.toLowerCase() === ".gitignore") && !rootIgnoresRunnerFiles(git, w, tree)) throw new Error("candidate .gitignore must keep .jarvis/ ignored");
}

function readNotesFile(path: string, maxBytes: number): UntrustedTaskNotes {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error("notes must be a regular file, never a symlink");
  if (st.nlink > 1) throw new Error("hardlinked notes refused");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("notes must be a regular file");
    const buffer = Buffer.alloc(maxBytes + 1);
    let used = 0;
    while (used < buffer.length) {
      const n = readSync(fd, buffer, used, buffer.length - used, null);
      if (n === 0) break;
      used += n;
    }
    const truncated = used > maxBytes;
    const text = new TextDecoder("utf-8", { fatal: false }).decode(buffer.subarray(0, Math.min(used, maxBytes)), { stream: truncated });
    return { trust: "untrusted", text, truncated };
  } finally {
    closeSync(fd);
  }
}

/** Read after the session stops and before commitCandidate; these words are claims, never evidence. */
export function readTaskNotes(w: TaskWorkspace, maxBytes = 64 * 1024): UntrustedTaskNotes | null {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024) throw new Error("notes limit must be between 1 and 65536 bytes");
  requireId(w.taskId);
  validateWorkspace(w);
  try {
    plainDirectory(join(w.path, ".jarvis"));
    plainDirectory(join(w.path, ".jarvis", "notes"));
    return readNotesFile(join(w.path, ".jarvis", "notes", `${w.taskId}.md`), maxBytes);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function validateTree(git: RunnerGit, w: TreeContext, tree: string): string[] {
  validateRunnerChanges(git, w, tree);
  const entries = command(git, w.path, ["ls-tree", "-r", "-z", "--full-tree", tree], w.home).toString().split("\0").filter(Boolean);
  for (const entry of entries) {
    const tab = entry.indexOf("\t");
    const path = entry.slice(tab + 1);
    if (tab < 0 || path.split("/").some((part) => /^\.git[. ]*$/i.test(part) || /^git~[0-9]+$/i.test(part))) throw new Error(`candidate touches git internals: ${path}`);
    if (entry.startsWith("160000 ")) throw new Error(`candidate submodules are not supported: ${path}`);
  }
  return entries;
}

function regularFile(fd: number, path: string, device: number, files: WorkspaceFileChecks): Stats {
  const st = (files.fstat ?? fstatSync)(fd);
  if (!st.isFile()) throw new Error(`candidate must be a regular file: ${path}`);
  if (st.nlink !== 1) throw new Error(`candidate has multiple links or was unlinked: ${path}`);
  if (st.dev !== device) throw new Error(`candidate file crosses a device boundary: ${path}`);
  return st;
}

function validateBlob(path: string, blob: string, device: number, files: WorkspaceFileChecks): void {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const fd = openSync(path, flags);
  try {
    const st = regularFile(fd, path, device, files);
    const hash = createHash(blob.length === 64 ? "sha256" : "sha1").update(`blob ${st.size}\0`);
    const buffer = Buffer.alloc(64 * 1024);
    let remaining = st.size + 1;
    while (remaining > 0) {
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
      if (n === 0) break;
      hash.update(buffer.subarray(0, n));
      remaining -= n;
    }
    regularFile(fd, path, device, files);
    if (hash.digest("hex") !== blob) throw new Error(`candidate content does not match its blob: ${path}`);
  } finally { closeSync(fd); }
}

/** Reopen the files after staging: the walk alone cannot detect a swap during git add. */
function validateCandidateFiles(root: string, entries: readonly string[], files: WorkspaceFileChecks = {}): void {
  const device = (files.lstat ?? lstatSync)(root).dev;
  for (const entry of entries) {
    const match = /^100(?:644|755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t/.exec(entry);
    if (match) validateBlob(join(root, entry.slice(match[0].length)), match[1]!, device, files);
  }
}

/** Call only after the session has stopped. A single new commit discards agent-controlled history. */
export function commitCandidate(w: TaskWorkspace, seams: GitSeams = {}): CandidateRevision {
  const git = seams.git ?? safeGit;
  validateWorkspace(w, git);
  validateSymlinks(w.path, seams.files);
  const run = (args: readonly string[]) => command(git, w.path, args, w.home).toString().trim();
  // Inspect forced additions before rebuilding the index from the trusted base.
  validateRunnerChanges(git, w);
  rmSync(join(w.path, ".git", "index"), { force: true });
  run(["read-tree", w.baseRevision]);
  run(["add", "--all", "--", "."]);
  const tree = run(["write-tree"]);
  const entries = validateTree(git, w, tree);
  validateCandidateFiles(w.path, entries, seams.files);
  const revision = run(["commit-tree", tree, "-p", w.baseRevision, "-m", `Jarvis candidate ${w.taskId}/${w.attemptId}`]);
  requireRevision(revision);
  run(["update-ref", "--no-deref", "HEAD", revision]);
  const ref = candidateRef(w);
  command(git, w.repoPath, ["-c", "protocol.file.allow=always", "-c", "fetch.fsckObjects=true", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--", w.path, `${revision}:${ref}`], w.home);
  return { revision, ref };
}


/** End-of-run cleanup; expected object IDs protect a branch advanced after enumeration. */
export function deleteCandidateBranches(repoPath: string, options: CandidateBranchOptions = {}): string[] {
  const git = options.git ?? safeGit;
  const home = options.home ?? homedir();
  const prefix = "refs/heads/jarvis/candidates/";
  const rows = command(git, repoPath, ["for-each-ref", "--format=%(refname) %(objectname)", prefix], home).toString().trim();
  if (!rows) return [];
  const deleted: string[] = [];
  for (const row of rows.split("\n")) {
    const [ref, revision] = row.split(" ");
    if (!ref?.startsWith(prefix) || !revision) throw new Error("invalid candidate branch enumeration");
    requireRevision(revision);
    command(git, repoPath, ["update-ref", "-d", ref, revision], home);
    deleted.push(ref);
  }
  return deleted;
}

/** The existing gate owns verified checkout creation and protected evidence capture. */
export function checkCandidate(w: TaskWorkspace, candidate: CandidateRevision, input: CandidateCheckInput, gate: (input: GateInput) => Promise<GateResult> = runGate): Promise<GateResult> {
  requireRevision(candidate.revision);
  return gate({ ...input, repoPath: w.repoPath, revision: candidate.revision, taskId: w.taskId, attemptId: w.attemptId });
}

/** The loop calls this only after every gate and review passed on this candidate revision. */
export function promoteCandidate(input: PromoteInput): string {
  requireRevision(input.candidate.revision);
  requireRevision(input.expectedHead);
  const git = input.git ?? safeGit;
  const home = input.home ?? homedir();
  const run = (args: readonly string[]) => command(git, input.repoPath, args, home).toString().trim();
  run(["check-ref-format", "--branch", input.runBranch]);
  const branch = `refs/heads/${input.runBranch}`;
  if (run(["rev-parse", "--verify", branch]) !== input.expectedHead) throw new Error("run branch HEAD moved");
  if (!input.candidate.ref.startsWith("refs/heads/jarvis/candidates/") || run(["rev-parse", "--verify", input.candidate.ref]) !== input.candidate.revision) throw new Error("candidate ref moved or is not runner-owned");
  validateTree(git, { path: input.repoPath, home, baseRevision: input.expectedHead }, input.candidate.revision);
  if (run(["status", "--porcelain", "--untracked-files=all"]) !== "") throw new Error("project repository must be clean, not dirty");
  run(["checkout", "--quiet", input.runBranch]);
  try {
    run(["merge", "--ff", "--no-edit", "--no-stat", input.candidate.revision]);
  } catch (e) {
    run(["merge", "--abort"]);
    throw e;
  }
  const revision = run(["rev-parse", "HEAD"]);
  run(["tag", "--force", "last-green", revision]);
  return revision;
}
