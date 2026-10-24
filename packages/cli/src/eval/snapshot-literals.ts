export interface FieldPolicy {
  secret: (name: string) => boolean;
  inert: (value: string) => boolean;
  untyped: (value: string) => boolean;
}

const LITERAL = /"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|`(?:[^`\\]|\\[\s\S])*`/g;
const body = (s: string) => s.slice(1, -1);

/** Explicit string-valued assignments, documentation examples and HTTP fields; never arbitrary expressions. */
export function literalFields(text: string, policy: FieldPolicy, shellBackticks = false): string[] {
  const hits = new Set<string>();
  const key = '[A-Za-z_][\\w.-]*';
  const name = `(?:"${key}"|'${key}'|\x60${key}\x60|${key})`;
  const assigned = new RegExp(`(?<![\\w"'\x60])(${name})\\s*[:=]\\s*(${LITERAL.source})`, "g");
  for (const m of text.matchAll(assigned)) {
    const name = m[1]!.replace(/["'`]/g, "");
    const value = shellBackticks && m[2]!.startsWith("`") ? m[2]! : body(m[2]!);
    if (policy.secret(name) && !value.includes("${") && !policy.inert(value)) hits.add(name);
  }
  // Unquoted examples are restricted to complete assignment lines, including retained config comments.
  for (const line of text.split("\n")) {
    const m = /^\s*(?:#|;|\/\/|\/\*|\*)?\s*([A-Za-z_][\w.-]*)\s*[:=]\s*([^\s"'`{}()[\];]+)\s*(?:\*\/)?\s*$/.exec(line);
    if (m && policy.secret(m[1]!) && !policy.untyped(m[2]!)) hits.add(m[1]!);
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
