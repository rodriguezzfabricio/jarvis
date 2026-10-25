import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export interface SourceFile { path: string; text: string }
export interface TrifectaSignal { kind: "llm" | "untrusted" | "capability"; file: string; line: number }
export interface TrifectaResult { required: boolean; complete: boolean; signals: TrifectaSignal[] }

const PATTERNS: Record<TrifectaSignal["kind"], RegExp> = {
  llm: /\b(?:openai|anthropic|langchain|litellm|ollama|generateText|streamText|invoke_agent|run_agent|agent\.(?:run|invoke|execute)|llm\.(?:invoke|generate|complete)|chat\.completions\.create|responses\.create|messages\.create)\b/i,
  untrusted: /\b(?:req(?:uest)?\.(?:body|query|params|json|formData|form|args|get_json|POST)\b|r\.(?:Body|FormValue)\b|stdin\b|argv\b|user_input\b|userInput\b|scrape\b|crawl\b|webhook\b|document\.body\b|page\.content\b|response\.(?:text|json)\b|fetch\s*\(|readFile(?:Sync)?\b)/i,
  capability: /\b(?:fetch\s*\(|https?\.(?:request|get|post)\b|requests\.(?:get|post)\b|axios\b|smtplib\b|sendMail\b|send_mail\b|sendMessage\b|readFile(?:Sync)?\b|read_file\b|read_text\b|db\.(?:query|execute)\b|process\.env\b|exec\s*\(|spawn\s*\(|subprocess\b)/i,
};

/** Whole-candidate heuristic: co-occurrence is a trial trigger, not a claim of exploitable data flow. */
export function detectTrifecta(files: readonly SourceFile[]): TrifectaResult {
  const signals: TrifectaSignal[] = [];
  for (const file of files) {
    for (const kind of Object.keys(PATTERNS) as TrifectaSignal["kind"][]) {
      const match = PATTERNS[kind].exec(file.text);
      if (match) signals.push({ kind, file: file.path, line: file.text.slice(0, match.index).split("\n").length });
    }
  }
  const kinds = new Set(signals.map((s) => s.kind));
  return { required: kinds.size === 3, complete: true, signals };
}

/** Reads only regular files; limits and read failures demand investigation rather than a clean scan. */
export function scanTrifecta(root: string, limits: { maxBytes?: number; maxFiles?: number } = {}): TrifectaResult {
  const files: SourceFile[] = [];
  let complete = true; let bytes = 0; let count = 0;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (dir === root && name === ".git") continue;
      const path = join(dir, name); const st = lstatSync(path);
      if (st.isSymbolicLink()) { complete = false; continue; }
      if (st.isDirectory()) { walk(path); continue; }
      if (!st.isFile()) { complete = false; continue; }
      count++; bytes += st.size;
      if (bytes > (limits.maxBytes ?? 16 * 1024 * 1024) || count > (limits.maxFiles ?? 10_000)) { complete = false; return; }
      const content = readFileSync(path);
      if (content.includes(0)) { complete = false; continue; }
      files.push({ path: relative(root, path), text: content.toString("utf8") });
    }
  };
  try { walk(root); } catch { complete = false; }
  const result = detectTrifecta(files);
  return { ...result, complete, required: result.required || !complete };
}
