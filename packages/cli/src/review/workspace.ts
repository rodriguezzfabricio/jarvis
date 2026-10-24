import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { safeGit } from "../eval/git.ts";

export type ReviewGit = typeof safeGit;
export function prepareCheckout(repo: string, revision: string, base: string, directory: string, home: string, git: ReviewGit = safeGit): { workspace: string; diff: string } {
  if (!/^[a-f0-9]{40}$/.test(revision) || !/^[a-f0-9]{40}$/.test(base)) throw new Error("review revisions must be full commit hashes");
  const workspace = join(directory, "checkout");
  git(directory, ["-c", "protocol.file.allow=always", "-c", "transfer.fsckObjects=true", "clone", "--quiet", "--no-local", "--no-checkout", "--", repo, workspace], { home });
  git(workspace, ["checkout", "--quiet", "--detach", revision], { home });
  if (git(workspace, ["rev-parse", "HEAD"], { home }).toString().trim() !== revision) throw new Error("review checkout revision mismatch");
  const diff = git(workspace, ["diff", "--no-ext-diff", "--no-textconv", `${base}..${revision}`, "--", ".", ":(exclude).jarvis"], { home }).toString();
  // History includes commit messages and builder notes; reviewers need only code and the runner's diff.
  rmSync(join(workspace, ".git"), { recursive: true, force: true });
  rmSync(join(workspace, ".jarvis"), { recursive: true, force: true });
  return { workspace, diff };
}

/** Detects a misbehaving adapter as well as a process that escapes its read-only tool policy. */
export function checkoutHash(root: string): string {
  const hash = createHash("sha256");
  const walk = (path: string, relative: string): void => {
    const stat = lstatSync(path);
    hash.update(JSON.stringify([relative, stat.mode]));
    if (stat.isSymbolicLink()) hash.update(JSON.stringify(readlinkSync(path)));
    else if (stat.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name), `${relative}/${name}`);
    else if (stat.isFile()) hash.update(createHash("sha256").update(readFileSync(path)).digest());
    else throw new Error("unsupported file in review checkout");
  };
  walk(root, "");
  return hash.digest("hex");
}
