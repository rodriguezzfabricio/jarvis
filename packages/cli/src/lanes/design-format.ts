import { withoutComments } from "./source.ts";

export interface TokenValue { value: string; line: number }
export interface TokenDocument { values: Map<string, TokenValue>; groups: Map<string, number>; body: string }

/** The template's two-space scalar maps, with duplicate keys and YAML execution features refused. */
export function parseTokenDocument(text: string): TokenDocument {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end < 1) throw new Error("DESIGN.md needs YAML front matter delimited by ---");
  const values = new Map<string, TokenValue>();
  const groups = new Map<string, number>();
  const stack: string[] = [];
  for (let i = 1; i < end; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^( *)([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(line);
    if (!match || match[1]!.length % 2) throw new Error(`line ${i + 1}: expected a two-space scalar map`);
    const depth = match[1]!.length / 2;
    if (depth > stack.length) throw new Error(`line ${i + 1}: indentation skips a map level`);
    stack.length = depth;
    const key = [...stack, match[2]!].join(".");
    if (values.has(key) || groups.has(key)) throw new Error(`line ${i + 1}: duplicate token ${key}`);
    const raw = match[3]?.trim();
    if (!raw || raw.startsWith("#")) {
      groups.set(key, i + 1);
      stack.push(match[2]!);
    } else values.set(key, { value: scalar(raw, i + 1), line: i + 1 });
  }
  return { values, groups, body: withoutComments(lines.slice(end + 1).join("\n")) };
}

function scalar(raw: string, line: number): string {
  if (raw.startsWith('"')) {
    const match = /^("(?:[^"\\]|\\.)*")(?:\s+#.*)?$/.exec(raw);
    if (match) return JSON.parse(match[1]!) as string;
  } else if (raw.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'(?:\s+#.*)?$/.exec(raw);
    if (match) return match[1]!.replaceAll("''", "'");
  } else if (!/^[&*!|>[\]{}?@`]|:\s/.test(raw)) return raw.replace(/\s+#.*$/, "").trim();
  throw new Error(`line ${line}: unsupported YAML value; use a quoted scalar, no aliases or collections`);
}
