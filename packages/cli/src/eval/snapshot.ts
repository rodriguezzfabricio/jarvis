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
/** Hosts whose credentials are local dev defaults or documentation placeholders, not real secrets. */
const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|db|postgres|redis|minio|mailhog|host\.docker\.internal|([a-z0-9-]+\.)*(example|test|invalid|localhost)|example\.(com|org|net))$/i;
const CRED_URL = /([a-z][a-z0-9+.-]*:\/\/)([^\s/:@'"]+):([^\s/@'"]+)@([^\s/:'"?#]+)/gi;

/** Credential URLs pointing anywhere but local dev services keep their host and lose user:password. */
function redactCredUrls(v: string): string {
  return v.replace(CRED_URL, (m, scheme: string, _u: string, _p: string, host: string) => (LOCAL_HOSTS.test(host) ? m : `${scheme}REDACTED:REDACTED@${host}`));
}

export class SnapshotRefused extends Error {}

/** Index just past the closing quote q in s (starting after the opening quote), honoring backslash escapes in "…". */
function closingQuote(s: string, q: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (q === '"' && s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === q) return i + 1;
  }
  return -1;
}

/**
 * Blank the values of secret-looking keys in a dotenv file and strip user:password from
 * non-local credential URLs. Handles single, double and back-quoted values (multi-line allowed),
 * escapes and inline comments. An unterminated quote makes the file uninspectable: refused.
 */
export function redactEnvText(text: string): { text: string; keys: string[] } {
  const keys: string[] = [];
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const nl = text.indexOf("\n", i);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(i, lineEnd);
    const m = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)/.exec(line);
    if (!m) {
      out.push(line);
      i = lineEnd + 1;
      continue;
    }
    const [head, , key = ""] = m;
    const valueStart = i + head.length;
    const q = text[valueStart];
    let valueEnd: number; // end of the value itself
    let restEnd: number; // end of the line holding the value's end (comments etc.)
    if (q === '"' || q === "'" || q === "`") {
      const close = closingQuote(text, q, valueStart + 1);
      if (close === -1) throw new SnapshotRefused(`unterminated ${q} value for ${key}`);
      valueEnd = close;
      const e = text.indexOf("\n", close);
      restEnd = e === -1 ? text.length : e;
    } else {
      // Unquoted: the value ends at an inline comment (" #") or the end of the line.
      const c = line.slice(head.length).search(/\s#/);
      valueEnd = c === -1 ? lineEnd : valueStart + c;
      restEnd = lineEnd;
    }
    const value = text.slice(valueStart, valueEnd);
    const rest = text.slice(valueEnd, restEnd);
    const empty = value.trim() === "" || value === '""' || value === "''";
    if (SECRET_KEY.test(key) && !empty) {
      keys.push(key);
      out.push(`${head.trimEnd().replace(/\s*=\s*$/, "")}=${rest.trimStart().startsWith("#") ? ` ${rest.trimStart()}` : ""}`);
    } else {
      const red = redactCredUrls(value);
      if (red !== value) keys.push(key);
      out.push(`${head}${red}${rest}`);
    }
    i = restEnd + 1;
  }
  if (text.endsWith("\n")) out.push("");
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

/** Documentation and test placeholders ("user:pass", "%s", "<pass>", "u:p") are not credentials. */
export function isPlaceholderPassword(pw: string): boolean {
  return pw.length <= 4 || /[<>{}%$*]/.test(pw) || /^(pass(word)?|secret|changeme|example|test(ing)?|dummy|placeholder|x{3,}|redacted)$/i.test(pw);
}

export function findCredentials(text: string): string[] {
  const hits = CREDENTIAL_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
  for (const m of text.matchAll(CRED_URL)) {
    if (!isPlaceholderPassword(m[3] ?? "") && !LOCAL_HOSTS.test(m[4] ?? "")) {
      hits.push("credential URL");
      break;
    }
  }
  return hits;
}

/** Text views of a file for scanning: UTF-8, UTF-16 (BOM or NUL-interleaved ASCII), and raw bytes for binaries. */
export function scanViews(buf: Buffer): string[] {
  const views = [buf.toString("utf8")];
  if (buf.includes(0)) {
    const le = buf[0] === 0xff && buf[1] === 0xfe;
    const be = buf[0] === 0xfe && buf[1] === 0xff;
    if (be) {
      const swapped = Buffer.from(buf.subarray(2));
      swapped.swap16();
      views.push(swapped.toString("utf16le"));
    } else views.push(buf.subarray(le ? 2 : 0).toString("utf16le"), buf.subarray(1).toString("utf16le"));
    views.push(buf.toString("latin1").replace(/\u0000/g, ""));
  }
  return views;
}

/** Files larger than this are refused unless a person allowlisted them. */
export const MAX_SCAN_BYTES = 64 * 1024 * 1024;

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
    if (!st.isFile()) continue;
    if (allowed.has(rel)) continue; // a person reviewed this file
    if (st.size > MAX_SCAN_BYTES) {
      found.push(`${rel} (too large to scan)`);
      continue;
    }
    const name = rel.split("/").at(-1) ?? "";
    const buf = readFileSync(p);
    if (/^\.env(\..+)?$/.test(name)) {
      if (buf.includes(0)) {
        found.push(`${rel} (non-UTF-8 env file)`);
        continue;
      }
      try {
        const r = redactEnvText(buf.toString("utf8"));
        if (r.keys.length) {
          writeFileSync(p, r.text);
          redactions.push({ file: rel, keys: r.keys });
        }
      } catch (e) {
        if (e instanceof SnapshotRefused) {
          found.push(`${rel} (${e.message})`);
          continue;
        }
        throw e;
      }
    }
    const hits = new Set(scanViews(readFileSync(p)).flatMap(findCredentials));
    if (hits.size) found.push(`${rel} (${[...hits].join(", ")})`);
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
