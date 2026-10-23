import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Sanitized snapshots for golden tasks (02-golden-tasks.md, "How every task runs"):
 * the task's starting files exported into a brand-new repo with one commit, no history,
 * no remotes, planted fixes undone in the files, and secret-looking env values blanked.
 */

export interface SnapshotInput {
  /** Omit for an empty starting folder (new products). */
  sourceRepo?: string;
  rev?: string;
  /** Commits whose changes are undone in the exported files (planted regressions). */
  revert?: readonly string[];
  dest: string;
}

export interface SnapshotManifest {
  sourceRev: string | null;
  reverted: string[];
  redactions: { file: string; keys: string[] }[];
  commit: string;
  createdAt: string;
}

const SECRET_KEY = /(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE|CREDENTIAL|AUTH)/i;

/** Blank the values of secret-looking keys in a dotenv file. Comments and other keys are kept. */
export function redactEnvText(text: string): { text: string; keys: string[] } {
  const keys: string[] = [];
  const out = text.split("\n").map((line) => {
    const m = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) return line;
    const [, pre, key, value] = m as unknown as [string, string, string, string];
    if (SECRET_KEY.test(key) && value.trim() !== "") {
      keys.push(key);
      return `${pre}${key}=`;
    }
    return line;
  });
  return { text: out.join("\n"), keys };
}

const SNAP_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "jarvis-eval",
  GIT_AUTHOR_EMAIL: "eval@jarvis.invalid",
  GIT_COMMITTER_NAME: "jarvis-eval",
  GIT_COMMITTER_EMAIL: "eval@jarvis.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

function git(cwd: string, args: string[], input?: Buffer): Buffer {
  return execFileSync("git", args, { cwd, input, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/", ...SNAP_ENV }, maxBuffer: 1024 ** 3 });
}

function findEnvFiles(dir: string, root: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) findEnvFiles(p, root, out);
    else if (e.isFile() && /^\.env(\..+)?$/.test(e.name)) out.push(relative(root, p));
  }
  return out.sort();
}

export async function createSnapshot(input: SnapshotInput): Promise<SnapshotManifest> {
  const { dest } = input;
  if (existsSync(dest) && readdirSync(dest).length > 0) throw new Error(`snapshot destination must be empty: ${dest}`);
  mkdirSync(dest, { recursive: true });
  const reverted: string[] = [];
  let sourceRev: string | null = null;

  if (input.sourceRepo) {
    if (!input.rev) throw new Error("rev is required with sourceRepo");
    sourceRev = git(input.sourceRepo, ["rev-parse", `${input.rev}^{commit}`]).toString().trim();
    // Only tracked files at that revision: untracked .env files never leave the source repo.
    const tar = git(input.sourceRepo, ["archive", "--format=tar", sourceRev]);
    execFileSync("tar", ["-x", "-f", "-", "-C", dest], { input: tar, maxBuffer: 1024 ** 3 });
    for (const c of input.revert ?? []) {
      const full = git(input.sourceRepo, ["rev-parse", `${c}^{commit}`]).toString().trim();
      const patch = git(input.sourceRepo, ["diff", "--binary", `${full}^`, full]);
      git(dest, ["apply", "-R", "--whitespace=nowarn", "-"], patch);
      reverted.push(full);
    }
  }

  const redactions: SnapshotManifest["redactions"] = [];
  for (const rel of findEnvFiles(dest, dest)) {
    const p = join(dest, rel);
    const r = redactEnvText(readFileSync(p, "utf8"));
    if (r.keys.length) {
      writeFileSync(p, r.text);
      redactions.push({ file: rel, keys: r.keys });
    }
  }

  git(dest, ["init", "-q", "-b", "main"]);
  git(dest, ["add", "-A"]);
  git(dest, ["commit", "-q", "--allow-empty", "--no-verify", "-m", "snapshot"]);
  const commit = git(dest, ["rev-parse", "HEAD"]).toString().trim();
  if (git(dest, ["remote"]).toString().trim() !== "") throw new Error("snapshot must have no remotes");
  return { sourceRev, reverted, redactions, commit, createdAt: new Date().toISOString() };
}
