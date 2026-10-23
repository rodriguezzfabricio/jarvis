import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { safeGit } from "./git.ts";

/**
 * Sanitized snapshots for golden tasks (02-golden-tasks.md, "How every task runs"): the task's
 * starting files exported into a brand-new repo with one commit, no history, no remotes, planted
 * fixes undone in the files, secret-looking values blanked, and a fail-closed scan for anything
 * that still looks like a real credential.
 */

export interface SnapshotInput {
  /** Omit for an empty starting folder (new products). */
  sourceRepo?: string;
  rev?: string;
  /** Commits whose changes are undone in the exported files (planted regressions). */
  revert?: readonly string[];
  /** Files reviewed by a person and allowed to contain credential-looking text (e.g. test fixtures). */
  allowSecretsIn?: readonly string[];
  dest: string;
}

export interface SnapshotManifest {
  sourceRev: string | null;
  reverted: string[];
  redactions: { file: string; keys: string[] }[];
  removedSymlinks: string[];
  commit: string;
  createdAt: string;
}

const SECRET_KEY = /(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE|CREDENTIAL|AUTH|_KEY$)/i;
const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|db|postgres|redis|minio|mailhog|host\.docker\.internal)$/i;
const CRED_URL = /([a-z][a-z0-9+.-]*:\/\/)([^\s/:@'"]+):([^\s/@'"]+)@([^\s/:'"?#]+)/gi;

/** Credential URLs pointing anywhere but local dev services keep their host and lose user:password. */
function redactCredUrls(v: string): string {
  return v.replace(CRED_URL, (m, scheme: string, _u: string, _p: string, host: string) => (LOCAL_HOSTS.test(host) ? m : `${scheme}REDACTED:REDACTED@${host}`));
}

/**
 * Blank the values of secret-looking keys in a dotenv file, including quoted multi-line values,
 * and strip user:password from non-local credential URLs. Comments and other keys are kept.
 */
export function redactEnvText(text: string): { text: string; keys: string[] } {
  const keys: string[] = [];
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    const pre = m[1] ?? "";
    const key = m[2] ?? "";
    let value = m[3] ?? "";
    // A quoted value that opens but doesn't close on this line continues on the next lines.
    const q = value.trimStart()[0];
    if ((q === '"' || q === "'") && value.trim().length > 0 && !(value.trim().length > 1 && value.trim().endsWith(q))) {
      while (i + 1 < lines.length) {
        i++;
        value += `\n${lines[i] ?? ""}`;
        if ((lines[i] ?? "").trimEnd().endsWith(q)) break;
      }
    }
    if (SECRET_KEY.test(key) && value.trim() !== "" && value.trim() !== '""' && value.trim() !== "''") {
      keys.push(key);
      out.push(`${pre}${key}=`);
      continue;
    }
    const red = redactCredUrls(value);
    if (red !== value) keys.push(key);
    out.push(`${pre}${key}=${red}`);
  }
  return { text: out.join("\n"), keys };
}

/** Patterns that mean "a real credential is probably here". Dummy PEM bodies (like "test") don't match. */
const CREDENTIAL_PATTERNS: readonly [string, RegExp][] = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----\s*[A-Za-z0-9+/=\s]{100,}-----END/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["OpenAI/Anthropic-style key", /\bsk-(ant-)?[A-Za-z0-9_-]{32,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Stripe live key", /\b[rs]k_live_[0-9A-Za-z]{20,}\b/],
];

export function findCredentials(text: string): string[] {
  return CREDENTIAL_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

function walk(dir: string, root: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" && dir === root) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, root, out);
    else out.push(relative(root, p));
  }
  return out.sort();
}

export async function createSnapshot(input: SnapshotInput): Promise<SnapshotManifest> {
  const { dest } = input;
  if (existsSync(dest) && readdirSync(dest).length > 0) throw new Error(`snapshot destination must be empty: ${dest}`);
  mkdirSync(dest, { recursive: true });
  const home = process.env.HOME ?? "/";
  const reverted: string[] = [];
  let sourceRev: string | null = null;

  if (input.sourceRepo) {
    if (!input.rev) throw new Error("rev is required with sourceRepo");
    sourceRev = safeGit(input.sourceRepo, ["rev-parse", `${input.rev}^{commit}`], { home }).toString().trim();
    // Only tracked files at that revision: untracked .env files never leave the source repo.
    const tar = safeGit(input.sourceRepo, ["archive", "--format=tar", sourceRev], { home });
    execFileSync("tar", ["-x", "-f", "-", "-C", dest], { input: tar, maxBuffer: 1024 ** 3 });
    for (const c of input.revert ?? []) {
      const full = safeGit(input.sourceRepo, ["rev-parse", `${c}^{commit}`], { home }).toString().trim();
      const patch = safeGit(input.sourceRepo, ["diff", "--binary", `${full}^`, full], { home });
      execFileSync("git", ["-c", "core.hooksPath=/dev/null", "apply", "-R", "--whitespace=nowarn", "-"], { cwd: dest, input: patch, env: { PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
      reverted.push(full);
    }
  }

  // Symlinks that point outside the snapshot would reopen the source machine; remove them.
  const removedSymlinks: string[] = [];
  const redactions: SnapshotManifest["redactions"] = [];
  const found: string[] = [];
  const allowed = new Set(input.allowSecretsIn ?? []);
  for (const rel of walk(dest, dest)) {
    const p = join(dest, rel);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) {
      const target = readlinkSync(p);
      const abs = isAbsolute(target) ? target : resolve(dirname(p), target);
      if (abs !== dest && !abs.startsWith(`${dest}/`)) {
        rmSync(p);
        removedSymlinks.push(rel);
      }
      continue;
    }
    if (!st.isFile() || st.size > 5 * 1024 * 1024) continue;
    const name = rel.split("/").at(-1) ?? "";
    let text = readFileSync(p, "utf8");
    if (text.includes("\u0000")) continue; // binary
    if (/^\.env(\..+)?$/.test(name)) {
      const r = redactEnvText(text);
      if (r.keys.length) {
        writeFileSync(p, r.text);
        redactions.push({ file: rel, keys: r.keys });
        text = r.text;
      }
    }
    const hits = findCredentials(text);
    if (hits.length && !allowed.has(rel)) found.push(`${rel} (${hits.join(", ")})`);
  }
  if (found.length) {
    rmSync(dest, { recursive: true, force: true });
    throw new Error(`snapshot refused: credential-looking content in ${found.join("; ")}. Review it and list the file in allowSecretsIn if it's a fixture.`);
  }

  safeGit(dest, ["init", "-q", "-b", "main"], { home });
  safeGit(dest, ["add", "-A"], { home });
  const fixed = { GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
  safeGit(dest, ["commit", "-q", "--allow-empty", "--no-verify", "-m", "snapshot"], { home, env: fixed });
  const commit = safeGit(dest, ["rev-parse", "HEAD"], { home }).toString().trim();
  if (safeGit(dest, ["remote"], { home }).toString().trim() !== "") throw new Error("snapshot must have no remotes");
  return { sourceRev, reverted, redactions, removedSymlinks, commit, createdAt: new Date().toISOString() };
}
