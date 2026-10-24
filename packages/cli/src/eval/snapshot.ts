import { execFileSync } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { type Document, isAlias, isMap, isScalar, isSeq, parseAllDocuments, type YAMLMap } from "yaml";
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
  // npm access tokens: registry.npmjs.org is the one write-capable host on the eval allowlist (decision 79).
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["OpenAI/Anthropic-style key", /\bsk-(ant-)?[A-Za-z0-9_-]{32,}\b/],
  // Long-term (AKIA) and temporary STS (ASIA) access key ids (Codex review 15).
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Stripe live key", /\b[rs]k_live_[0-9A-Za-z]{20,}\b/],
  // A JSON Web Key with private or symmetric material (d, p, q, dp, dq, qi; k for oct), keys in either
  // order, in any file (Codex review 14). Public keys (x, y, n, e only) don't match.
  ["private JWK", /["']?\bkty["']?\s*:[\s\S]{0,1000}?["']?\b(?:d|k|p|q|dp|dq|qi)["']?\s*:\s*["'][A-Za-z0-9_-]{16,}["']/],
  ["private JWK", /["']?\b(?:d|k|p|q|dp|dq|qi)["']?\s*:\s*["'][A-Za-z0-9_-]{16,}["'][\s\S]{0,1000}?["']?\bkty["']?\s*:/],
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

/** A base64 run, not part of a longer one. Credentials are short; longer runs (images, hashes) are skipped. */
const BASE64_RUN = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{12,512}={0,2}(?![A-Za-z0-9+/=])/g;

/**
 * True if a base64 string decodes to printable user:password text: HTTP Basic credentials, as in
 * npm's _auth, Docker's auths.*.auth and "Authorization: Basic …", wherever they appear (Codex review 10).
 */
export function isBase64UserPassword(b64: string): boolean {
  // The user part looks like a user name, so base64-encoded JSON ({"c":1,…}) and other data don't match.
  const m = /^([\w.@+~!$%&*=#|-]*):([\x21-\x7e]+)$/.exec(Buffer.from(b64, "base64").toString("latin1"));
  return m !== null && !isPlaceholderPassword(m[2]!);
}

/**
 * A literal Authorization or Proxy-Authorization credential, in any file, by header and scheme, whatever
 * the credential's length or characters (Codex review 13). Interpolations ("Bearer ${token}", "Bearer " +
 * key) and placeholders ("<token>") can't match the value's characters.
 */
const AUTH_HEADER = /\b(?:Proxy-)?Authorization["']?\s*[:=,]\s*["'`]?\s*(?:Bearer|Basic|Token|Bot|Digest|ApiKey)\s+([^\s"'`<>${}]+)(?=["'`\s,;)}\]]|$)/gim;

/**
 * An Authorization credential that is a documentation placeholder, in complete narrow forms only: a short
 * prefix elided ("fhk_…", "sk_...") or an HTML-escaped placeholder ("&lt;key&gt;"). No character-class
 * exemptions (Codex review 14): a lowercase token is as real as any other. Fake test values need review.
 */
export function isPlaceholderAuth(v: string): boolean {
  return /^[\w-]{0,8}(…|\.\.\.)$/.test(v) || /^&lt;[\w -]+&gt;?;?$/.test(v);
}

export function findCredentials(text: string): string[] {
  const hits = CREDENTIAL_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
  for (const m of text.matchAll(AUTH_HEADER)) {
    if (!isInertString(m[1]!) && !isPlaceholderAuth(m[1]!)) {
      hits.push("Authorization header");
      break;
    }
  }
  for (const m of text.matchAll(CRED_URL)) {
    if (!isPlaceholderPassword(m[3] ?? "") && !LOCAL_HOSTS.test(m[4] ?? "")) {
      hits.push("credential URL");
      break;
    }
  }
  for (const m of text.matchAll(BASE64_RUN)) {
    if (isBase64UserPassword(m[0])) {
      hits.push("base64 user:password");
      break;
    }
  }
  return hits;
}

/** Base64 runs long enough to hide a key or token, wrapped lines included. */
const BASE64_BLOB = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/]{24,}(?:\r?\n[ \t]*[A-Za-z0-9+/]{4,})*={0,2}(?![A-Za-z0-9+/=_-])/g;

/**
 * Credentials hidden inside base64, wherever they are (Codex review 13: a kubeconfig's client-key-data):
 * every base64 run is decoded once, checked as a DER private key and scanned as text.
 */
export function findEncodedCredentials(text: string): string[] {
  const hits = new Set<string>();
  for (const m of text.matchAll(BASE64_BLOB)) {
    const buf = Buffer.from(m[0].replace(/\s+/g, ""), "base64");
    if (isDerPrivateKey(buf)) hits.add("base64-encoded private key");
    else for (const h of findCredentials(buf.toString("latin1"))) hits.add(`base64-encoded ${h}`);
  }
  return [...hits];
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
const CONFIG_FILE = /(\.(json|jsonc|json5|ya?ml|toml|ini|cfg|conf|properties|tfvars|plist|xml|config|npmrc|pypirc|netrc)|^\.?(npmrc|pypirc|netrc|pgpass|yarnrc))$/i;
/**
 * Field names that hold a credential, after camelCase is split (clientSecret → client_secret). Narrower
 * than the dotenv rule: "author" or "auth: true" are not credentials, but any *_token, *_secret,
 * password or api key holding a literal value is.
 */
const SECRET_FIELD = /(^|_)(secret|secrets|token|password|passwd|pwd|pass|apikey|api_key|private_key|secret_key|access_key|master_key|signing_key|encryption_key|session_key|jwt_key|hmac_key|client_secret|auth_token|authtoken|auth_ident|identitytoken|registrytoken|authorization|key_data|credentials?|connection_string|dsn)$/;

function fieldName(raw: string): string {
  const last = raw.split(/[/:.[\]]/).filter((x) => x !== "").at(-1) ?? raw;
  return last.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[-\s]+/g, "_").replace(/^_+/, "").toLowerCase();
}

/**
 * A string value that is clearly not a literal credential: empty, a template or reference, or a
 * placeholder word. Digits are not exempt: "9372165408" is a perfectly good password (Codex review 7).
 */
export function isInertString(raw: string): boolean {
  const v = raw.trim();
  if (v === "") return true;
  // A reference with a default (${DB_PASSWORD:-hunter2}) is only as inert as its default.
  const ref = /^\$\{[A-Za-z_\d][\w.]*(?::?[-=](.*))?\}$/.exec(v);
  if (ref) return ref[1] === undefined || isInertString(ref[1]);
  // Shell arguments and command substitutions in scripts: "$1", "$@", $(cat /run/secrets/db), `…`.
  if (/^\$(\d+|[@*#?])$/.test(v) || /^\$\(.*\)$/.test(v) || /^`.*`$/.test(v)) return true;
  // An Authorization value is as inert as its credential: "Bearer ${API_TOKEN}".
  const scheme = /^(?:Bearer|Basic|Token|Bot|Digest|ApiKey)\s+(.+)$/i.exec(v);
  if (scheme) return isInertString(scheme[1]!) || isPlaceholderAuth(scheme[1]!);
  if (/^\$\{\{.*\}\}$/.test(v) || /^\{\{.*\}\}$/.test(v) || /^%\([A-Za-z_]\w*\)s$/.test(v)) return true;
  if (/^(env|ENV)\(|^process\.env\.|^os\.environ|^!(env|Ref|Sub|GetAtt|ImportValue)\b|^(secretref|vault|op|aws-sm|gcp-sm):/.test(v)) return true;
  if (/^(password|passwd|pass|secret|token|api[ _-]?key|changeme|example|test|testing|dummy|placeholder|redacted|your[_-][\w-]*|x{3,})$/i.test(v)) return true;
  return isPlaceholderPassword(v);
}

/** For untyped formats (INI, properties): an unquoted value that is a switch, not a secret. */
function isInertUntyped(raw: string): boolean {
  return /^(null|nil|none|~|true|false|yes|no|on|off)$/i.test(raw.trim()) || isInertString(raw);
}

/** Strips line and block comments and trailing commas from JSONC, leaving strings untouched. */
export function stripJsonc(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      const close = closingQuote(text, '"', i + 1);
      const end = close === -1 ? text.length : close;
      out += text.slice(i, end);
      i = end - 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      i = e === -1 ? text.length : e + 1;
      out += " ";
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * True if a JSON object repeats a key. JSON.parse keeps only the last one, so an earlier password
 * would be exported unseen (Codex review 8). Such files are walked as YAML, which keeps every pair.
 */
export function hasDuplicateJsonKeys(text: string): boolean {
  const stack: (Set<string> | undefined)[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") stack.push(new Set());
    else if (c === "[") stack.push(undefined);
    else if (c === "}" || c === "]") stack.pop();
    else if (c === '"') {
      const close = closingQuote(text, '"', i + 1);
      if (close === -1) return false;
      let j = close;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      const keys = stack.at(-1);
      if (keys && text[j] === ":") {
        const k = JSON.parse(text.slice(i, close)) as string;
        if (keys.has(k)) return true;
        keys.add(k);
      }
      i = close - 1;
    }
  }
  return false;
}

/** A parsed structured config: plain values (JSON, TOML) or YAML documents walked node by node. */
type Parsed = { plain: unknown[] } | { yaml: Document.Parsed[] };

/** A structured config, parsed, or undefined if it doesn't parse. */
function parseStructured(name: string, text: string): Parsed | undefined {
  const tryJson = (t: string): Parsed | undefined => {
    try {
      const v: unknown = JSON.parse(t);
      return hasDuplicateJsonKeys(t) ? undefined : { plain: [v] };
    } catch {
      return undefined;
    }
  };
  const tryYaml = (t: string): Parsed | undefined => {
    try {
      // Nodes, not toJS(): duplicate keys keep every pair and tagged scalars keep their key (Codex review 8).
      const docs = parseAllDocuments(t, { uniqueKeys: false });
      const list = Array.isArray(docs) ? docs : [docs];
      if (list.some((d) => d.errors.length > 0)) return undefined;
      return { yaml: list };
    } catch {
      return undefined;
    }
  };
  if (/\.(json|jsonc|json5|tfvars\.json)$/i.test(name)) return tryJson(text) ?? tryJson(stripJsonc(text)) ?? tryYaml(stripJsonc(text));
  if (/\.ya?ml$/i.test(name)) return tryYaml(text);
  if (/\.toml$/i.test(name)) {
    try {
      return { plain: [parseToml(text)] }; // TOML refuses duplicate keys itself
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const decodeXml = (v: string) =>
  v.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, e: string) => {
    const l = e.toLowerCase();
    if (l.startsWith("#x")) return String.fromCodePoint(Number.parseInt(l.slice(2), 16));
    if (l.startsWith("#")) return String.fromCodePoint(Number.parseInt(l.slice(1), 10));
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[l] ?? "";
  });

// npm's _auth (scoped or not) is base64 user:password, though "auth" alone names no credential (Codex review 9).
const isSecretName = (k: string) => SECRET_FIELD.test(fieldName(k)) || /(^|[/:])_auth$/.test(k);

/** NAME=value inside a string value: Compose and task-definition environment lists, scripts. */
const ENV_ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)=(.*)$/;
const unquote = (s: string) => /^(["'])([\s\S]*)\1$/.exec(s.trim())?.[2] ?? s;
/** Alias resolutions allowed per file before it counts as uninspectable (alias bombs, cycles). */
const MAX_YAML_ALIASES = 1000;

/**
 * Credential-named fields with literal values in a configuration file (Codex stage 0 reviews 6–9).
 * JSON, JSONC, YAML (block and flow values, anchors, duplicate keys, tags) and TOML are parsed and walked;
 * NAME=value strings and {name, value} entries are checked by NAME. plist and XML elements and attributes are read by structure; INI-like formats line
 * by line (Yarn 1's .yarnrc as "key value"). A structured file that doesn't parse but names credential fields can't be inspected: refused.
 */
export function findSecretFields(name: string, text: string): string[] {
  // A text file with no extension (.aws/credentials, .s3cfg, Dockerfile, scripts) is read as key=value
  // lines too: credential stores are conventionally extensionless (Codex review 15).
  const extensionless = !name.replace(/^\./, "").includes(".");
  if (!CONFIG_FILE.test(name) && !extensionless) return [];
  const hits = new Set<string>();
  const structured = /\.(json|jsonc|json5|ya?ml|toml)$/i.test(name);
  if (structured) {
    const docs = parseStructured(name, text);
    if (!docs) {
      const named = [...text.matchAll(/[A-Za-z_][A-Za-z0-9_-]*/g)].some((m) => isSecretName(m[0]));
      return named ? ["unparseable configuration with credential-named fields"] : [];
    }
    // secret: the value's own key names a credential (a list keeps its key for its items). Nested maps
    // start afresh: under "password: {type: string, example: …}" in an OpenAPI schema, nothing is a credential.
    const leaf = (v: unknown, key: string, secret: boolean) => {
      if (typeof v === "string") {
        if (secret && !isInertString(v)) hits.add(key);
        for (const line of v.split("\n")) {
          const m = ENV_ASSIGNMENT.exec(line);
          if (m && isSecretName(m[1]!) && !isInertString(unquote(m[2]!))) hits.add(m[1]!);
        }
      } else if (!secret || v === null || v === undefined || typeof v === "boolean") return;
      // A long number under a credential name is a PIN or numeric secret, not a setting.
      else if (typeof v === "number" || typeof v === "bigint") {
        if (String(v).replace(/\D/g, "").length >= 4) hits.add(key);
      }
      // !!binary, dates and other typed values under a credential name can't be inspected as text.
      else hits.add(key);
    };
    // Kubernetes and ECS environment entries ({name: DB_PASSWORD, value: …}): the entry's name is the key
    // of every one of its value pairs, so an aliased, repeated or typed value is judged as DB_PASSWORD's.
    const keyFor = (k: string, envName: string | undefined) => (k === "value" && envName ? envName : k);
    // Docker and Podman registry logins (auths.<registry>.auth): a literal is a credential by structure,
    // whatever its length or characters (Codex review 11). "auth" alone names no credential elsewhere.
    const DOCKER_AUTH = "auths.*.auth";
    // JSON Web Keys (and JWKS entries) holding private or symmetric material, by structure (Codex review 14).
    const PRIVATE_JWK = "private JWK";
    const JWK_PRIVATE = ["d", "p", "q", "dp", "dq", "qi", "k"];
    const isEmptyNode = (v: unknown) => v === undefined || (isScalar(v) && (v.value === null || v.value === ""));
    const dockerAuth = (v: unknown) => {
      if (v !== null && v !== undefined && (typeof v !== "string" || !isInertString(v))) hits.add(DOCKER_AUTH);
    };
    const walkPlain = (v: unknown, key: string): void => {
      if (Array.isArray(v)) for (const x of v) walkPlain(x, key);
      else if (v && typeof v === "object" && !(v instanceof Date)) {
        const o = v as Record<string, unknown>;
        const envName = [o.name, o.key].find((x): x is string => typeof x === "string" && isSecretName(x));
        if (typeof o.kty === "string" && JWK_PRIVATE.some((k) => o[k] !== undefined && o[k] !== "")) hits.add(PRIVATE_JWK);
        if (key === "auths") for (const r of Object.values(o)) if (r && typeof r === "object") dockerAuth((r as Record<string, unknown>).auth);
        for (const [k, x] of Object.entries(o)) walkPlain(x, keyFor(k, envName));
      } else leaf(v, key, isSecretName(key));
    };
    let aliases = 0;
    /** The node an alias stands for, within the per-file alias budget (undefined once it's spent). */
    const deref = (doc: Document.Parsed, n: unknown): unknown => {
      while (isAlias(n)) {
        if (++aliases > MAX_YAML_ALIASES) {
          hits.add("too many YAML aliases to inspect");
          return undefined;
        }
        n = n.resolve(doc);
      }
      return n;
    };
    /**
     * A map's pairs, keys resolved (keys may be aliases: "*k : value") and YAML merges (<<: *base, or a
     * list of them) expanded in place, so a merged name or value belongs to the entry (Codex review 10).
     * Every duplicate is kept.
     */
    const pairsOf = (doc: Document.Parsed, m: YAMLMap): { key: string; value: unknown }[] =>
      m.items.flatMap((p) => {
        const k = deref(doc, p.key);
        const key = isScalar(k) ? String(k.value) : "";
        if (key !== "<<") return [{ key, value: p.value }];
        const v = deref(doc, p.value);
        return (isSeq(v) ? v.items.map((x) => deref(doc, x)) : [v]).flatMap((x) => (isMap(x) ? pairsOf(doc, x) : [{ key, value: x }]));
      });
    const walkYaml = (doc: Document.Parsed, node: unknown, key: string): void => {
      const n = deref(doc, node);
      if (isMap(n)) {
        const pairs = pairsOf(doc, n);
        if (pairs.some((p) => p.key === "kty") && pairs.some((p) => JWK_PRIVATE.includes(p.key) && !isEmptyNode(deref(doc, p.value)))) hits.add(PRIVATE_JWK);
        const envName = pairs
          .filter((p) => p.key === "name" || p.key === "key")
          .map((p) => deref(doc, p.value))
          .map((v) => (isScalar(v) ? String(v.value) : ""))
          .find(isSecretName);
        if (key === "auths")
          for (const r of pairs) {
            const m = deref(doc, r.value);
            if (isMap(m)) for (const a of pairsOf(doc, m)) if (a.key === "auth") {
              const v = deref(doc, a.value);
              dockerAuth(isScalar(v) ? v.value : v);
            }
          }
        for (const p of pairs) walkYaml(doc, p.value, keyFor(p.key, envName));
      } else if (isSeq(n)) for (const x of n.items) walkYaml(doc, x, key);
      else if (isScalar(n)) leaf(n.value, key, isSecretName(key));
    };
    if ("plain" in docs) for (const d of docs.plain) walkPlain(d, "");
    else for (const d of docs.yaml) walkYaml(d, d.contents, "");
    return [...hits].map((k) => (k.startsWith("too many") ? k : `credential field "${k}"`));
  }
  if (/\.(plist|xml|config)$/i.test(name)) {
    for (const m of text.matchAll(/<key>\s*([^<]+?)\s*<\/key>\s*<(string|data)>([\s\S]*?)<\/\2>/gi)) if (isSecretName(m[1]!) && !isInertString(decodeXml(m[3]!))) hits.add(m[1]!);
    for (const m of text.matchAll(/<([A-Za-z_][\w.:-]*)(\s[^>]*)?>([^<]*)<\/\1\s*>/g)) if (isSecretName(m[1]!) && !isInertString(decodeXml(m[3]!))) hits.add(m[1]!);
    for (const m of text.matchAll(/<([A-Za-z_][\w.:-]*)(\s[^>]*)?>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/\1\s*>/g)) if (isSecretName(m[1]!) && !isInertString(m[3]!)) hits.add(m[1]!);
    for (const m of text.matchAll(/\s([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) if (isSecretName(m[1]!) && !isInertString(decodeXml(m[2] ?? m[3] ?? ""))) hits.add(m[1]!);
    // Name/value structures carry the credential name to the value (Codex review 12): <property name="password"
    // value="…"/>, <entry key="db.password">…</entry>, .NET <add key="ApiKey" value="…"/>, and Spring's
    // <property name="password"><value>…</value></property>. A ref="…" attribute is a reference, not a value.
    for (const m of text.matchAll(/<([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g)) {
      const attrs = new Map<string, string>();
      for (const a of m[2]!.matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs.set(a[1]!.toLowerCase(), decodeXml(a[2] ?? a[3] ?? ""));
      const label = attrs.get("name") ?? attrs.get("key");
      if (label === undefined || !isSecretName(label)) continue;
      let value = attrs.get("value");
      if (value === undefined && m[3] !== "/") {
        const start = m.index + m[0].length;
        const close = text.indexOf(`</${m[1]}`, start);
        // Element text, child elements' text included; CDATA kept literally.
        const inner = text.slice(start, close === -1 ? text.length : close);
        value = inner.split(/(<!\[CDATA\[[\s\S]*?\]\]>)/).map((part) => (part.startsWith("<![CDATA[") ? part.slice(9, -3) : decodeXml(part.replace(/<[^>]*>/g, "")))).join("");
      }
      if (value !== undefined && !isInertString(value)) hits.add(label);
    }
    // A plist key whose value isn't a string or data element (e.g. an array of strings) still needs review.
    for (const m of text.matchAll(/<key>\s*([^<]+?)\s*<\/key>\s*<(array|dict)>/gi)) if (isSecretName(m[1]!)) hits.add(m[1]!);
    return [...hits].map((k) => `credential field "${k}"`);
  }
  const yarn = /^\.?yarnrc$/.test(name);
  const lines = text.split("\n");
  const indent = (l: string) => /^[ \t]*/.exec(l)![0].length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = yarn ? /^\s*"?([^\s"#][^\s"]*)"?\s+(.*?)\s*$/.exec(line) : /^\s*["']?([^"'=:#;\s[][^"'=]*?)["']?\s*(?:=|:(?=\s|$|["']))\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2] ?? "";
    if (/^[#;]/.test(value)) continue;
    // INI continuation (Python ConfigParser): following lines indented deeper than the key belong to its
    // value, even after an empty first line ("password =\n    hunter2") (Codex review 15).
    while (!yarn && i + 1 < lines.length && lines[i + 1]!.trim() !== "" && indent(lines[i + 1]!) > indent(line) && !/^\s*[#;]/.test(lines[i + 1]!)) value += `\n${lines[++i]!.trim()}`;
    // Unquoted only when the quotes enclose the whole value (an inline comment may follow). Text after a
    // closing quote stays part of the value: '"${TOKEN}"hunter2' is not a reference (review 16 B7).
    const quoted = /^(["'])([\s\S]*?)\1(\s+[#;].*)?$/.exec(value);
    if (quoted) value = quoted[1] === '"' ? decodeEscapes(quoted[2]!) : quoted[2]!;
    else value = value.replace(/\s+[#;].*$/, "");
    if (isSecretName(m[1] ?? "") && !isInertUntyped(value)) hits.add(m[1] ?? "");
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
    const all = [...views, ...views.flatMap(decodedViews)];
    const hits = new Set([...all.flatMap(findCredentials), ...all.flatMap(findEncodedCredentials)]);
    if (!/^\.env(\..+)?$/.test(name)) {
      // Every text view (UTF-8, UTF-16), and the percent-decoded text, is inspected as configuration.
      const texts = [...views, ...views.filter((t) => /%(3a|2f|40)/i.test(t)).map((t) => t.replace(/%([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16))))];
      for (const [i, t] of texts.entries()) {
        if (i > 0 && t.includes("\u0000")) continue;
        for (const h of findSecretFields(name, t)) if (i === 0 || !h.startsWith("unparseable")) hits.add(h);
      }
    }
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
