import { execFileSync } from "node:child_process";
import { createPrivateKey } from "node:crypto";
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
  /** Test seam: the size above which a file is refused as uninspectable. */
  maxScanBytes?: number;
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
// userinfo may have an empty username (redis://:password@host) (Codex review 4).
// Apostrophes are valid in userinfo (Codex review 5); only the host part ends at quotes.
const CRED_URL = /([a-z][a-z0-9+.-]*:\/\/)([^\s/:@"<>`]*):([^\s/@"<>`]+)@([^\s/:'"?#<>`]+)/gi;

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
  // Any private-key envelope, whatever its body length or headers: short Ed25519/X25519 keys and
  // encrypted (Proc-Type/DEK-Info) RSA keys included. Dummy fixtures need explicit review (Codex review 4).
  ["private key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["OpenAI/Anthropic-style key", /\bsk-(ant-)?[A-Za-z0-9_-]{32,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Stripe live key", /\b[rs]k_live_[0-9A-Za-z]{20,}\b/],
];

/**
 * Documentation and test placeholders are not credentials, but only in narrow, complete forms:
 * a whole-value template (%s, <pass>, {password}, ${DB_PASSWORD}, $DB_PASSWORD) or a whole-value
 * placeholder word. No length or punctuation exemptions (Codex review 3): anything else, including
 * short or percent-encoded passwords, counts as real. Ambiguous fixtures go through allowSecretsIn.
 */
export function isPlaceholderPassword(raw: string): boolean {
  let pw = raw;
  try {
    pw = decodeURIComponent(raw);
  } catch {
    // not valid percent-encoding (e.g. "%s"): classify the raw text
  }
  const template = /^(%s|<[A-Za-z_][\w-]*>|\{[A-Za-z_][\w-]*\}|\$\{[A-Za-z_][\w]*\}|\$[A-Z_][A-Z0-9_]*|\*{3,}|x{3,}|X{3,})$/;
  const word = /^(pass|password|passwd|secret|changeme|example|test|testing|dummy|placeholder|redacted|REDACTED)$/;
  return template.test(raw) || template.test(pw) || word.test(pw);
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

/** Decodes one quoted literal's escapes (JSON, YAML double-quoted, TOML basic, JS): \/ \uXXXX \u{…} \UXXXXXXXX \xXX \n … */
export function decodeEscapes(body: string): string {
  return body.replace(/\\(u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|x([0-9a-fA-F]{2})|([\s\S]))/g, (_m, _all, cp: string, u4: string, u8: string, x2: string, ch: string) => {
    const hex = cp ?? u4 ?? u8 ?? x2;
    if (hex !== undefined) {
      const n = Number.parseInt(hex, 16);
      return n <= 0x10ffff ? String.fromCodePoint(n) : "";
    }
    return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "0": "\0" } as Record<string, string>)[ch] ?? ch;
  });
}

/**
 * Text views with the containing format's encoding undone (Codex stage 0 review 6): every quoted
 * literal that has escapes, decoded (so "postgres:\/\/u:p@host" or / reads as a URL), and the
 * whole text percent-decoded when it holds percent-encoded URL syntax.
 */
export function decodedViews(text: string): string[] {
  const views: string[] = [];
  const lits: string[] = [];
  for (const m of text.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g)) {
    const body = m[1] ?? m[2] ?? "";
    if (body.includes("\\")) lits.push(decodeEscapes(body));
  }
  if (lits.length) views.push(lits.join("\n"));
  if (/%(3a|2f|40)/i.test(text)) views.push(text.replace(/%([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16))));
  return views;
}

/** Configuration files whose fields are inspected by name, not only by pattern. */
const CONFIG_FILE = /(\.(json|jsonc|json5|ya?ml|toml|ini|cfg|conf|properties|tfvars|plist|xml|npmrc|pypirc|netrc)|^\.?(npmrc|pypirc|netrc|pgpass))$/i;
/**
 * Field names that hold a credential, after camelCase is split (clientSecret → client_secret). Narrower
 * than the dotenv rule: "author" or "auth: true" are not credentials, but any *_token, *_secret,
 * password or api key holding a literal value is.
 */
const SECRET_FIELD = /(^|_)(secret|secrets|token|password|passwd|pwd|pass|apikey|api_key|private_key|secret_key|access_key|master_key|signing_key|encryption_key|session_key|jwt_key|hmac_key|client_secret|auth_token|authtoken|credentials?|connection_string|dsn)$/;

function fieldName(raw: string): string {
  const last = raw.split(/[/:.[\]]/).filter((x) => x !== "").at(-1) ?? raw;
  return last.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[-\s]+/g, "_").replace(/^_+/, "").toLowerCase();
}

/** A field value that is clearly not a literal credential: empty, a template or reference, a placeholder word, or a non-string scalar. */
export function isInertValue(raw: string): boolean {
  const v = raw.trim();
  if (v === "" || /^(null|nil|none|~|true|false|yes|no|on|off)$/i.test(v) || /^-?\d+(\.\d+)?$/.test(v)) return true;
  // A reference with a default (${DB_PASSWORD:-hunter2}) is only as inert as its default.
  const ref = /^\$\{[A-Za-z_]\w*(?::?[-=](.*))?\}$/.exec(v);
  if (ref) return ref[1] === undefined || isInertValue(ref[1]);
  if (/^\$\{\{.*\}\}$/.test(v) || /^\{\{.*\}\}$/.test(v) || /^%\([A-Za-z_]\w*\)s$/.test(v)) return true;
  if (/^(env|ENV)\(|^process\.env\.|^os\.environ|^!(env|Ref|Sub|GetAtt|ImportValue)\b|^(secretref|vault|op|aws-sm|gcp-sm):/.test(v)) return true;
  if (/^(password|passwd|pass|secret|token|api[ _-]?key|changeme|example|test|testing|dummy|placeholder|redacted|your[_-][\w-]*|x{3,})$/i.test(v)) return true;
  return isPlaceholderPassword(v);
}

/** Credential-named fields with literal values in a configuration file (JSON parsed; other formats line by line). */
export function findSecretFields(name: string, text: string): string[] {
  if (!CONFIG_FILE.test(name)) return [];
  const hits = new Set<string>();
  const consider = (key: string, value: unknown) => {
    if (typeof value === "string" && SECRET_FIELD.test(fieldName(key)) && !isInertValue(value)) hits.add(key);
  };
  if (/\.json$/i.test(name)) {
    try {
      const walk = (v: unknown, key = "") => {
        if (Array.isArray(v)) v.forEach((x) => walk(x, key));
        else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
        else consider(key, v);
      };
      walk(JSON.parse(text));
      return [...hits].map((k) => `credential field "${k}"`);
    } catch {
      // not strict JSON (comments, trailing commas): read it line by line like the other formats
    }
  }
  for (const line of text.split("\n")) {
    const m = /^\s*(?:-\s+)?["']?([^"'=:#;\s][^"'=]*?)["']?\s*(?:=|:(?=\s|$|["']))\s*(.*?)\s*,?\s*$/.exec(line);
    if (!m) continue;
    let value = m[2] ?? "";
    if (/^\s*[#;]/.test(value) || value === "|" || value === ">" || value === "{" || value === "[") continue;
    const q = value[0];
    if ((q === '"' || q === "'") && value.lastIndexOf(q) > 0) value = q === '"' ? decodeEscapes(value.slice(1, value.lastIndexOf(q))) : value.slice(1, value.lastIndexOf(q));
    else value = value.replace(/\s+[#;].*$/, "");
    consider(m[1] ?? "", value);
  }
  return [...hits].map((k) => `credential field "${k}"`);
}

/** Files larger than this are refused unless a person allowlisted them. */
export const MAX_SCAN_BYTES = 64 * 1024 * 1024;

/** Credential containers that can't be inspected as text: refused unless a person reviewed them. */
const CREDENTIAL_CONTAINERS = /\.(p12|pfx|jks|jceks|keystore|bks|kdbx|ppk|gpg|pgp|key|der|p8|pk8)$/i;

/** True if the bytes parse as a DER private key (PKCS#8, PKCS#1 RSA or SEC1 EC). */
export function isDerPrivateKey(buf: Buffer): boolean {
  if (buf.length > 64 * 1024 || buf[0] !== 0x30) return false;
  for (const type of ["pkcs8", "pkcs1", "sec1"] as const) {
    try {
      createPrivateKey({ key: buf, format: "der", type });
      return true;
    } catch {
      // not this format
    }
  }
  return false;
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
    if (!st.isFile()) continue;
    if (allowed.has(rel)) continue; // a person reviewed this file
    if (st.size > (input.maxScanBytes ?? MAX_SCAN_BYTES)) {
      found.push(`${rel} (too large to scan)`);
      continue;
    }
    const name = rel.split("/").at(-1) ?? "";
    const buf = readFileSync(p);
    if (isDerPrivateKey(buf)) {
      found.push(`${rel} (binary private key)`);
      continue;
    }
    if (/^(\.|_)?(netrc|pgpass)$/.test(name)) {
      found.push(`${rel} (credential file; needs review)`);
      continue;
    }
    if (CREDENTIAL_CONTAINERS.test(name) && (buf.includes(0) || !/^-----BEGIN /.test(buf.toString("latin1", 0, 11)))) {
      found.push(`${rel} (credential container; needs review)`);
      continue;
    }
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
    const views = scanViews(readFileSync(p));
    const hits = new Set([...views, ...views.flatMap(decodedViews)].flatMap(findCredentials));
    if (!/^\.env(\..+)?$/.test(name)) for (const h of findSecretFields(name, views[0] ?? "")) hits.add(h);
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
