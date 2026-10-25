import { execFileSync } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { createHash, createPrivateKey } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { parse as parseToml } from "smol-toml";
import { type Document, isAlias, isMap, isScalar, isSeq, parseAllDocuments, type YAMLMap } from "yaml";
import { safeGit } from "./git.ts";
import { containerMembers, credentialContainer } from "./snapshot-containers.ts";
import { mediaText } from "./snapshot-media.ts";
import { argumentFields, commandFields, literalFields, readsAsWords, sourcePrivateJwk } from "./snapshot-literals.ts";

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

/** Credential URLs keep their host and lose user:password, unless they are a local service's placeholder login. */
function redactCredUrls(v: string): string {
  return v.replace(CRED_URL, (m, scheme: string, user: string, pw: string, host: string) => (isPlaceholderCredential(pw, user, host) ? m : `${scheme}REDACTED:REDACTED@${host}`));
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

/**
 * A credential URL's password, or a URL query value, that is a placeholder (Codex review: localhost
 * suppressed "svc:e7Kq2mVx9PzR4tLw"; a real value is refused whatever the host). Anywhere: a placeholder
 * word or template, or one character repeated ("00000000"). For a local or documentation host, also local
 * defaults: the username again ("hire:hire"), 1 to 3 characters ("u:p"), a value that reads as words
 * ("dev_password", "pool_max_conns=99") or placeholder words in leetspeak ("sup3rsecret"). "admin:hunter2"
 * at a real host stays a credential, and random characters or letters are one at any host.
 */
export function isPlaceholderCredential(raw: string, user: string, host: string): boolean {
  if (isPlaceholderPassword(raw) || /^(.)\1{2,}$/.test(raw)) return true;
  if (!LOCAL_HOSTS.test(host)) return false;
  let pw = raw;
  try {
    pw = decodeURIComponent(raw);
  } catch {
    // classify the raw text
  }
  if ((user !== "" && pw === user) || pw.length <= 3) return true;
  const plain = pw.toLowerCase().replace(/[-_.]/g, "").replace(/[0134578$@]/g, (c) => ({ "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", $: "s", "@": "a" })[c]!);
  return readsAsWords(pw) || LEET_WORDS.test(plain);
}

/** Placeholder vocabulary, once leetspeak is undone: "s3cr3t", "sup3rsecret", "p4ssw0rd". */
const LEET_WORDS = /^(?:super|secret|pass|password|passwd|admin|test|dev|changeme|example|dummy|hunter|root|my|your|app|db|local)+$/;

/** Standard or URL-safe base64 runs. Most are words or identifiers: see isPlausibleBase64. */
const BASE64_RUN = /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_-]{4,}={0,2}(?![A-Za-z0-9+/_=-])/g;
/** Shortest run decoded as a login: 8 bytes, "svc:8k2Z". */
const MIN_LOGIN_RUN = 11;
/** Shortest canonical padded run decoded as a login on a credential line: 4 bytes, "u:pw" (Codex review). */
const MIN_PADDED_LOGIN_RUN = 6;
/** A line that names a login: "registryLogin", "auth", "Basic", "password", npm and Docker settings. */
const LOGIN_CONTEXT = /auth|login|cred|passw|pwd|secret|token|basic|registry|docker|npm/i;
/** Shortest standalone run decoded and inspected recursively (wrapped lines are joined first). */
const MIN_PAYLOAD_RUN = 16;

/**
 * True if a run is plausibly encoded rather than a word or identifier (decision 79: "Only" decodes to
 * ":yr"): at least min characters, mixing at least two of lowercase, uppercase past the first character,
 * and digits. Encoded bytes of any length worth inspecting practically always do.
 */
export function isPlausibleBase64(run: string, min: number): boolean {
  const raw = run.replace(/=+$/, "");
  return raw.length >= min && [/[a-z]/.test(raw), /[A-Z]/.test(raw.slice(1)), /\d/.test(raw)].filter(Boolean).length >= 2;
}

/**
 * True if a base64 string decodes to printable user:password text: HTTP Basic credentials, as in
 * npm's _auth, Docker's auths.*.auth and "Authorization: Basic …", wherever they appear (Codex review 10).
 */
export function isBase64UserPassword(b64: string, min = MIN_LOGIN_RUN): boolean {
  if (!isPlausibleBase64(b64, min)) return false;
  const buf = Buffer.from(b64, "base64");
  if (!isUtf8(buf)) return false;
  const decoded = buf.toString("utf8");
  // Public URI data has a scheme and authority, not a Basic-auth username and password.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(decoded)) return false;
  // A username, then printable password text: letters, digits, punctuation and symbols only.
  const m = /^([\w.@+~!$%&*=#|-]+):([\p{L}\p{N}\p{P}\p{S}]+)$/u.exec(decoded);
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
  // Placeholder values are exempt, not hosts: a real password is as real at localhost (Codex review).
  for (const m of text.matchAll(CRED_URL)) {
    if (!isPlaceholderCredential(m[3] ?? "", m[2] ?? "", m[4] ?? "")) {
      hits.push("credential URL");
      break;
    }
  }
  for (const m of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]+/gi)) {
    try {
      const url = new URL(m[0]);
      // Placeholders, whatever the host; an all-digit value is an id (Greenhouse's token=7826765).
      for (const [key, value] of url.searchParams) if (isSecretName(key) && !isInertString(value) && !isPlaceholderCredential(value, "", url.hostname) && !/^\d+$/.test(value)) hits.push("credential URL query");
    } catch {
      // Not a complete literal URL.
    }
  }
  // A short login counts when it is canonical padded base64 on a line that names a login: "dTpxOFpyMg==".
  // Only the 80 characters around it on its line are read, so minified files stay linear.
  const paddedLogin = (run: string, at: number) => {
    if (!run.endsWith("=") || run.replace(/=+$/, "").length >= MIN_LOGIN_RUN || Buffer.from(run, "base64").toString("base64") !== run) return false;
    const before = text.slice(Math.max(0, at - 80), at);
    const after = text.slice(at + run.length, at + run.length + 80);
    const line = `${before.slice(before.lastIndexOf("\n") + 1)}${after.split("\n", 1)[0]}`;
    return LOGIN_CONTEXT.test(line) && isBase64UserPassword(run, MIN_PADDED_LOGIN_RUN);
  };
  for (const m of text.matchAll(BASE64_RUN)) {
    if (isBase64UserPassword(m[0]) || paddedLogin(m[0], m.index)) {
      hits.push("base64 user:password");
      break;
    }
  }
  return hits;
}

/** Largest DER value looked for across wrapped lines: isDerPrivateKey's own limit. */
const MAX_WRAPPED_DER = 64 * 1024;

/** The total length a DER SEQUENCE header announces, if the bytes start with one. */
function derLength(head: Buffer): number | undefined {
  if (head[0] !== 0x30 || head[1] === undefined) return undefined;
  if (head[1] < 0x80) return 2 + head[1];
  const n = head[1] & 0x7f;
  if (n === 0 || n > 3 || head.length < 2 + n) return undefined;
  return 2 + n + head.readUIntBE(2, n);
}

/**
 * The lines from `start` that encode exactly one DER SEQUENCE, by the length its header announces: a key
 * wrapped at any width, between other words in the same column (Codex review: uneven and 8-character
 * wrapping hid keys). ends[j] is the unpadded length of lines[0..j].
 */
function wrappedDer(lines: string[], ends: number[], start: number): string | undefined {
  let head = "";
  for (let j = start; j < lines.length && head.length < 8; j++) head += lines[j];
  const total = derLength(Buffer.from(head.slice(0, 8), "base64"));
  if (total === undefined || total > MAX_WRAPPED_DER) return undefined;
  const target = (start ? ends[start - 1]! : 0) + Math.ceil((total * 4) / 3);
  // ends is increasing: binary search for the line that ends exactly where the DER value does.
  let lo = start;
  let hi = lines.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ends[mid]! === target) return lines.slice(start, mid + 1).join("");
    if (ends[mid]! < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

/**
 * Whitespace-wrapped base64 is joined across lines. Equal-width lines (the last may be shorter, 16 or more
 * characters wide) are wrapped encodings; any other column is joined too, but its decoded bytes count only
 * if they are complete structures (Codex review: widths alone hid keys; a column of words is not one).
 */
function* encodedPayloads(text: string): Generator<Buffer> {
  const matches = [...text.matchAll(BASE64_RUN)];
  /** Each candidate run, and whether its decoded bytes must be a complete structure. */
  const runs = new Map<string, boolean>();
  const add = (run: string, strict: boolean) => runs.set(run, strict && (runs.get(run) ?? true));
  for (const m of matches) if (isPlausibleBase64(m[0], MIN_PAYLOAD_RUN)) add(m[0], false);
  let wrapped: string[] = [];
  const flush = () => {
    if (wrapped.length > 1) {
      const width = wrapped[0]!.length;
      const even = width >= MIN_PAYLOAD_RUN && wrapped.every((w, i) => (i < wrapped.length - 1 ? w.length === width : w.length <= width));
      add(wrapped.join(""), !even);
      let sum = 0;
      const ends = wrapped.map((w) => (sum += w.replace(/=+$/, "").length));
      for (let i = 0; i < wrapped.length; i++) {
        const der = wrappedDer(wrapped, ends, i);
        if (der !== undefined) add(der, true);
      }
    }
    wrapped = [];
  };
  let end = 0;
  for (const m of matches) {
    if (wrapped.length && !/^[ \t]*\r?\n[ \t\r\n]*$/.test(text.slice(end, m.index))) flush();
    wrapped.push(m[0]);
    end = m.index + m[0].length;
  }
  flush();
  for (const [run, strict] of runs) {
    const raw = run.replace(/=+$/, "");
    if (raw.length % 4 === 1) continue;
    const data = Buffer.from(raw, "base64url");
    if (data.toString("base64url") !== raw.replaceAll("+", "-").replaceAll("/", "_")) continue;
    if (isPlausiblePayload(data, strict)) yield data;
  }
}

/** True if bounded decompression of `data` succeeds with some output, or exceeds the probe's limit. */
function decompresses(data: Buffer, decompress: (b: Buffer, o: { maxOutputLength: number }) => Buffer): boolean {
  try {
    return decompress(data, { maxOutputLength: 1024 * 1024 }).length > 0;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE";
  }
}

/**
 * Decoded bytes worth inspecting: DER, a recognized compressed or archive format, text (UTF-8, or UTF-16
 * with its NULs dropped, mostly printable), or a Brotli stream, which has no magic bytes and so is probed
 * (Codex review: an npm token in base64 Brotli). Bytes decoded from an identifier are none of these.
 * strict: only complete structures count, a DER value of exactly its announced length and compressed data
 * that decompresses, not a header alone.
 */
export function isPlausiblePayload(data: Buffer, strict = false): boolean {
  if (data[0] === 0x30) return !strict || derLength(data) === data.length;
  if (data[0] === 0x1f && data[1] === 0x8b) return !strict || decompresses(data, gunzipSync);
  if (data.length > 2 && data[0] === 0x78 && ((data[0] << 8) + data[1]!) % 31 === 0) return !strict || decompresses(data, inflateSync);
  if ((data.length >= 4 && data.readUInt32LE(0) === 0x04034b50) || (data.length >= 262 && data.toString("ascii", 257, 262) === "ustar")) return true;
  const utf8 = isUtf8(data);
  if (utf8 || data.includes(0)) {
    const bytes = data.filter((b) => b !== 0);
    const printable = bytes.filter((b) => (b >= 0x20 && b < 0x7f) || b === 9 || b === 10 || b === 13 || (utf8 && b >= 0x80)).length;
    if (bytes.length > 0 && printable >= 0.9 * bytes.length) return true;
  }
  return !utf8 && decompresses(data, brotliDecompressSync);
}

/**
 * Images and fonts by their magic bytes, unless the bytes are UTF-8 text (text in disguise). Their pixel
 * and glyph payload is scanned only for literal credential patterns; the rest goes through the bounded
 * decoding pipeline as text (mediaText).
 */
export function isMediaData(buf: Buffer): boolean {
  if (isUtf8(buf)) return false;
  const head = buf.toString("latin1", 0, 12);
  return (
    head.startsWith("\x89PNG\r\n\x1a\n") ||
    head.startsWith("\xff\xd8\xff") ||
    /^GIF8[79]a/.test(head) ||
    (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") ||
    /^(\x00\x01\x00\x00|OTTO|true|ttcf|wOFF|wOF2)/.test(head)
  );
}

/** The same bounded pipeline applies to every decoded wrapper, not only to its raw text. */
export function findEncodedCredentials(text: string): string[] {
  return findSnapshotCredentials("decoded.txt", Buffer.from(text), { encodedOnly: true });
}

/** Text views of a file for scanning: UTF-8, UTF-16 (BOM or NUL-interleaved ASCII), and raw bytes for binaries. */
export function scanViews(buf: Buffer): string[] {
  const views = [buf.toString("utf8")];
  if (buf.includes(0)) {
    const le = buf[0] === 0xff && buf[1] === 0xfe;
    const be = buf[0] === 0xfe && buf[1] === 0xff;
    if (be) {
      const swapped = Buffer.from(buf.subarray(2, buf.length - (buf.length % 2)));
      swapped.swap16();
      views.push(swapped.toString("utf16le"));
    } else views.push(buf.subarray(le ? 2 : 0).toString("utf16le"), buf.subarray(1).toString("utf16le"));
    views.push(buf.toString("latin1").replace(/\u0000/g, ""));
  }
  // cp037 PEM envelopes are identifiable; arbitrary non-UTF-8 assets are not treated as secrets.
  if (buf.includes(Buffer.from([0x60, 0x60, 0x60, 0x60, 0x60, 0xc2, 0xc5, 0xc7, 0xc9, 0xd5]))) {
    const table = new Map<number, string>([[0x60, "-"], [0x40, " "], [0x25, "\n"], [0x15, "\n"], [0x61, "/"], [0x4e, "+"], [0x7e, "="]]);
    for (const [start, letters] of [[0xc1, "ABCDEFGHI"], [0xd1, "JKLMNOPQR"], [0xe2, "STUVWXYZ"], [0x81, "abcdefghi"], [0x91, "jklmnopqr"], [0xa2, "stuvwxyz"], [0xf0, "0123456789"]] as const) {
      [...letters].forEach((c, i) => table.set(start + i, c));
    }
    views.push([...buf].map((b) => table.get(b) ?? "\ufffd").join(""));
  }
  const utf7 = views[0]!.replace(/\+([A-Za-z0-9+/]{8,})-/g, (raw, encoded: string) => {
    const bytes = Buffer.from(encoded, "base64");
    return bytes.length % 2 === 0 ? bytes.swap16().toString("utf16le") : raw;
  });
  if (utf7 !== views[0]) views.push(utf7);
  return views;
}

/** Decodes one quoted literal's escapes (JSON, YAML double-quoted, TOML basic, JS): \/ \uXXXX \u{…} \UXXXXXXXX \xXX \n … */
export function decodeEscapes(body: string): string {
  return body.replace(/\\(?:\r?\n|([0-7]{1,3})|u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|x([0-9a-fA-F]{2})|([\s\S]))/g, (_m, oct: string, cp: string, u4: string, u8: string, x2: string, ch: string) => {
    if (oct !== undefined) return String.fromCodePoint(Number.parseInt(oct, 8));
    const hex = cp ?? u4 ?? u8 ?? x2;
    if (hex !== undefined) {
      const n = Number.parseInt(hex, 16);
      return n <= 0x10ffff ? String.fromCodePoint(n) : "";
    }
    if (ch === undefined) return ""; // source line continuation
    return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" } as Record<string, string>)[ch] ?? ch;
  });
}

/**
 * Text views with the containing format's encoding undone (Codex stage 0 review 6): every quoted
 * literal that has escapes, decoded with its field context, plus independently decoded percent runs.
 */
export function decodedViews(text: string): string[] {
  const views: string[] = [];
  const literals: string[] = [];
  const context = text.replace(/"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'|`((?:[^`\\]|\\[\s\S])*)`/g, (raw, double: string, single: string, template: string) => {
    const value = double ?? single ?? template ?? "";
    if (!value.includes("\\")) return raw;
    const decoded = decodeEscapes(value);
    literals.push(decoded);
    return `${raw[0]}${decoded}${raw[0]}`;
  });
  if (context !== text) views.push(context, ...literals);
  if (/%[0-9a-f]{2}/i.test(text)) views.push(text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try { return decodeURIComponent(run); } catch { return run; }
  }));
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
  // A bracketed elision marks a documentation example, not a complete credential: "ExponentPushToken[...]".
  if (/[[<({](?:\.\.\.|…)[\]>)}]/.test(v)) return true;
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
const FIELD_POLICY = { secret: isSecretName, inert: isInertString, untyped: isInertUntyped };

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
        if (/^(run|command|script|args|entrypoint)$/.test(key)) for (const h of commandFields(v, FIELD_POLICY)) hits.add(h);
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
      if (Array.isArray(v)) {
        if (/^(args|command|entrypoint)$/.test(key)) for (const h of argumentFields(v, FIELD_POLICY)) hits.add(h);
        for (const x of v) walkPlain(x, key);
      } else if (v && typeof v === "object" && !(v instanceof Date)) {
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
      } else if (isSeq(n)) {
        if (/^(args|command|entrypoint)$/.test(key)) {
          const values = n.items.map((x) => deref(doc, x)).map((x) => isScalar(x) ? x.value : undefined);
          for (const h of argumentFields(values, FIELD_POLICY)) hits.add(h);
        }
        for (const x of n.items) walkYaml(doc, x, key);
      } else if (isScalar(n)) leaf(n.value, key, isSecretName(key));
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

export interface SnapshotScanLimits {
  maxDepth?: number;
  maxExpandedBytes?: number;
  /** Used by the legacy encoded-content helper; normal snapshots inspect the original bytes too. */
  encodedOnly?: boolean;
}

/** Pure, bounded inspection shared by files, source escapes, encodings and archive members. */
export function findSnapshotCredentials(name: string, bytes: Buffer, limits: SnapshotScanLimits = {}): string[] {
  const hits = new Set<string>();
  const seen = new Set<string>();
  let remaining = limits.maxExpandedBytes ?? 16 * 1024 * 1024;
  const maxDepth = limits.maxDepth ?? 6;
  const visit = (file: string, buf: Buffer, depth: number): void => {
    const id = `${file}:${createHash("sha256").update(buf).digest("hex")}`;
    if (seen.has(id)) return;
    seen.add(id);
    if (depth > maxDepth) { hits.add("decoding depth limit; needs review"); return; }
    if (depth > 0) {
      remaining -= buf.length;
      if (remaining < 0) { hits.add("expanded byte limit; needs review"); return; }
    }
    const inspect = depth > 0 || !limits.encodedOnly;
    if (inspect && isDerPrivateKey(buf)) { hits.add("binary private key"); return; }
    if (inspect && credentialContainer(buf)) { hits.add("credential container; needs review"); return; }
    if (isMediaData(buf)) {
      // Literal patterns anywhere, pixels included; everything but pixel and glyph payload is decoded too.
      if (inspect) for (const h of findCredentials(buf.toString("latin1"))) hits.add(h);
      let text: string;
      try {
        text = mediaText(buf, remaining);
      } catch (e) {
        hits.add(`container cannot be inspected (limit or invalid format); needs review: ${(e as Error).message}`);
        return;
      }
      visit("media.txt", Buffer.from(text), depth + 1);
      return;
    }
    try {
      const members = containerMembers(file, buf, remaining);
      if (members) {
        for (const member of members) visit(basename(member.name), member.data, depth + 1);
        return;
      }
    } catch (e) {
      hits.add(`container cannot be inspected (limit or invalid format); needs review: ${(e as Error).message}`);
      return;
    }
    const shellBackticks = CONFIG_FILE.test(file) || /\.(sh|bash|zsh|fish)$/i.test(file) || !file.replace(/^\./, "").includes(".");
    const views = scanViews(buf);
    const texts = [...new Set([...views, ...views.flatMap(decodedViews)])];
    for (const [i, text] of texts.entries()) {
      if (inspect) {
        for (const h of findCredentials(text)) hits.add(h);
        if (depth !== 0 || !/^\.env(\..+)?$/.test(file)) {
          for (const h of literalFields(text, FIELD_POLICY, shellBackticks)) hits.add(h);
          if (sourcePrivateJwk(text)) hits.add("private JWK");
          if (!text.includes("\u0000")) for (const h of findSecretFields(file, text)) if (i === 0 || !h.startsWith("unparseable")) hits.add(h);
        }
      }
      for (const payload of encodedPayloads(text)) visit("decoded.txt", payload, depth + 1);
      // Hex, RFC 4648 base32 and byte arrays are inspected only as key material, not arbitrary fields.
      for (const payload of keyPayloads(text)) {
        if (isDerPrivateKey(payload) || credentialContainer(payload)) hits.add("encoded private key");
      }
    }
  };
  visit(name, bytes, 0);
  return [...hits];
}

function* keyPayloads(text: string): Generator<Buffer> {
  for (const m of text.matchAll(/(?<![\da-f])[\da-f]{64,}(?![\da-f])/gi)) if (m[0].length % 2 === 0) yield Buffer.from(m[0], "hex");
  for (const m of text.matchAll(/(?<![A-Z2-7])[A-Z2-7]{32,}={0,6}(?![A-Z2-7=])/g)) {
    let bits = 0;
    let value = 0;
    const bytes: number[] = [];
    for (const c of m[0].replace(/=+$/, "")) {
      value = (value << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c);
      bits += 5;
      if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); }
    }
    yield Buffer.from(bytes);
  }
  for (const m of text.matchAll(/(?:Buffer\.from|(?:new\s+)?Uint8Array)\s*\(\s*\[([\d\s,a-fx]+)\]/gi)) {
    const parts = m[1]!.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length && parts.every((s) => /^(?:0x[\da-f]{1,2}|\d{1,3})$/i.test(s) && Number(s) <= 255)) yield Buffer.from(parts.map(Number));
  }
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
    const hits = new Set(findSnapshotCredentials(name, readFileSync(p)));
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
