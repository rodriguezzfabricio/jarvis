export interface SourceFile { path: string; content: string }
export interface Finding { file: string; line: number; column: number; rule: string; message: string }
export interface LineRange { start: number; end: number }

export const uiSource = (path: string) => /\.(?:css|scss|sass|less|[cm]?[jt]sx?|svelte|vue|html?|swift|kt|dart|xml)$/i.test(path);

/** Keep offsets stable so every finding still points into the original file. */
export function withoutComments(source: string, path = "DESIGN.md"): string {
  const chars = source.split("");
  const mask = (start: number, end: number) => { for (let i = start; i < end; i++) if (!/[\r\n]/.test(chars[i]!)) chars[i] = " "; };
  if (/\.(?:[cm]?[jt]sx?|swift|kt|kts)$/i.test(path)) scriptComments(source, 0, source.length, mask);
  else {
    for (const m of source.matchAll(/<!--[\s\S]*?-->|\/\*[\s\S]*?\*\//g)) mask(m.index, m.index + m[0].length);
    if (/\.(?:html?|svelte|vue)$/i.test(path)) for (const m of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
      const start = m.index + m[0].indexOf(">") + 1;
      scriptComments(source, start, start + m[1]!.length, mask);
    }
  }
  return chars.join("");
}

function scriptComments(source: string, start: number, end: number, mask: (start: number, end: number) => void): void {
  let quote = "";
  for (let i = start; i < end; i++) {
    const c = source[i]!;
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c !== "/") continue;
    const line = source[i + 1] === "/"; const block = source[i + 1] === "*";
    if (!line && !block) continue;
    const stop = source.indexOf(line ? "\n" : "*/", i + 2);
    const last = stop < 0 ? end : Math.min(end, stop + (block ? 2 : 0));
    mask(i, last); i = last - 1;
  }
}

export function finding(file: string, content: string, offset: number, rule: string, message: string): Finding {
  const prefix = content.slice(0, offset);
  return { file, line: prefix.split("\n").length, column: offset - prefix.lastIndexOf("\n"), rule, message };
}

export function ordered(findings: Finding[]): Finding[] {
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return findings.sort((a, b) => compare(a.file, b.file) || a.line - b.line || a.column - b.column || compare(a.rule, b.rule));
}
