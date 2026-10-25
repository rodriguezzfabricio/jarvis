export interface FieldPolicy {
  secret: (name: string) => boolean;
  inert: (value: string) => boolean;
  untyped: (value: string) => boolean;
}

const LITERAL = /"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|`(?:[^`\\]|\\[\s\S])*`/g;
const body = (s: string) => s.slice(1, -1);

/** Shannon entropy in bits per character. */
function entropy(v: string): number {
  const counts = new Map<string, number>();
  for (const c of v) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / v.length) * Math.log2(n / v.length);
  return bits;
}

/**
 * A segment that reads as a word, not as random characters: short, all digits, or letters in word case
 * (lower, Capitalized, UPPER, camelCase, ABBRCase) with an optional short numeric suffix (password123).
 */
const WORD_SEGMENT = /^(?:.{1,3}|\d+|[A-Z]*[a-z]*(?:[A-Z]+[a-z]{2,})*[A-Z]*\d{0,4})$/;

/**
 * True if a source literal could be a credential (decision 79: the scanner must not refuse ordinary
 * files): at least 8 characters, no whitespace, 3 or more bits of entropy per character, and at least one
 * segment that isn't a word. Words, storage keys, prose, SQL, numbers, short or repeated fixtures
 * ("test-secret", "gaSession", "hunter2hunter2", "AQV") are not; "Synthetic9qvM2" or a UUID is.
 */
export function isCredentialShaped(raw: string): boolean {
  const v = raw.trim();
  if (v.length < 8 || /\s/.test(v) || entropy(v) < 3) return false;
  // A URL's credentials are judged by the credential URL and URL query rules, not by its shape.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return false;
  return !v.split(/[^A-Za-z0-9]+/).filter(Boolean).every((s) => WORD_SEGMENT.test(s));
}

/** An unquoted code expression naming another value: cfg.S3SecretKey, &cfg.SigningKey, rec.URL. */
const REFERENCE = /^[&*]?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;

/** Explicit string-valued assignments, documentation examples and HTTP fields; never arbitrary expressions. */
export function literalFields(text: string, policy: FieldPolicy, shellBackticks = false): string[] {
  const hits = new Set<string>();
  const key = '[A-Za-z_][\\w.-]*';
  const name = `(?:"${key}"|'${key}'|\x60${key}\x60|${key})`;
  const assigned = new RegExp(`(?<![\\w"'\x60])(${name})\\s*[:=]\\s*(${LITERAL.source})`, "g");
  for (const m of text.matchAll(assigned)) {
    const name = m[1]!.replace(/["'`]/g, "");
    const value = shellBackticks && m[2]!.startsWith("`") ? m[2]! : body(m[2]!);
    if (policy.secret(name) && !value.includes("${") && !policy.inert(value) && isCredentialShaped(value)) hits.add(name);
  }
  // Unquoted examples are restricted to complete assignment lines, including retained config comments.
  for (const line of text.split("\n")) {
    const m = /^\s*(?:#|;|\/\/|\/\*|\*)?\s*([A-Za-z_][\w.-]*)\s*[:=]\s*([^\s"'`{}()[\];]+)\s*(?:\*\/)?\s*$/.exec(line);
    // A trailing comma ends a struct or object member; a dotted name is a reference, not a value.
    if (!m) continue;
    const value = m[2]!.replace(/,$/, "");
    if (policy.secret(m[1]!) && !policy.untyped(value) && !REFERENCE.test(value) && isCredentialShaped(value)) hits.add(m[1]!);
  }
  return [...hits].map((k) => `credential literal "${k}"`);
}

/** Object members are associated with their own braces, with no distance or quote-style limit. */
export function sourcePrivateJwk(text: string): boolean {
  const tokens = new RegExp(`${LITERAL.source}|[A-Za-z_$][\\w$]*|[{}:]`, "g");
  const stack: Map<string, string>[] = [];
  let previous = "";
  let field: string | undefined;
  for (const m of text.matchAll(tokens)) {
    const token = m[0];
    if (token === "{") stack.push(new Map());
    else if (token === "}") {
      const fields = stack.pop();
      if (fields?.has("kty") && ["d", "k", "p", "q", "dp", "dq", "qi"].some((k) => fields.get(k))) return true;
    } else if (token === ":") field = /^["'`]/.test(previous) ? body(previous) : previous;
    else if (field !== undefined) {
      if (/^["'`]/.test(token) && !token.includes("${")) stack.at(-1)?.set(field, body(token));
      field = undefined;
    }
    if (token === "{" || token === "}") field = undefined;
    previous = token;
  }
  return false;
}

/** Shell assignments and credential flags, only called for command-valued configuration. */
export function commandFields(command: string, policy: FieldPolicy): string[] {
  const hits = new Set<string>();
  const word = `(?:\\$\\([^()]*\\)|${LITERAL.source}|[^\\s;&|]+)`;
  const assignments = new RegExp(`(?:^|[\\s;&|])([A-Za-z_][\\w]*)=(${word})`, "g");
  const flags = new RegExp(`(?:^|\\s)--([A-Za-z][\\w-]*)(?:=|\\s+)(${word})`, "g");
  for (const re of [assignments, flags]) for (const m of command.matchAll(re)) {
    const value = /^["']/.test(m[2]!) ? body(m[2]!) : m[2]!;
    if (policy.secret(m[1]!) && !policy.inert(value)) hits.add(`credential command "${m[1]}"`);
  }
  return [...hits];
}

export function argumentFields(args: unknown[], policy: FieldPolicy): string[] {
  const hits: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (typeof flag !== "string") continue;
    const m = /^--([A-Za-z][\w-]*)(?:=(.*))?$/.exec(flag);
    const value = m?.[2] ?? args[i + 1];
    if (m && policy.secret(m[1]!) && typeof value === "string" && !policy.inert(value)) hits.push(`credential argument "${m[1]}"`);
  }
  return hits;
}
