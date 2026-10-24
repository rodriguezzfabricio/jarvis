import { finding, ordered, uiSource, withoutComments, type Finding, type LineRange, type SourceFile } from "./source.ts";

export type TellRule = "purple-gradient" | "emoji-icon" | "generic-copy" | "default-font" | "eyebrow" | "meta-line" |
  "button-arrows" | "flat-black" | "bouncy-easing" | "aurora" | "submit-copy" | "apologetic-error" | "multiple-primary" | "launch-tour";
export interface TellException { rule: TellRule; reason: string; source: string }
export interface TellOptions {
  /** New lines only; omitted means all supplied source is new. The runner supplies these from the diff. */
  changedLines?: Readonly<Record<string, readonly LineRange[]>>;
  /** Reviewed manifest data, never read from source comments. */
  exceptions?: readonly TellException[];
}

const RULES: { rule: TellRule; pattern: RegExp; message: string }[] = [
  { rule: "generic-copy", pattern: /Welcome to your dashboard|Scale without limits/gi, message: "Use the product's own words" },
  { rule: "default-font", pattern: /(?:font-family|fontFamily)\s*:\s*["']?(?:Inter|Roboto|Arial|system-ui|system-font|-apple-system)\b/gi, message: "Choose a deliberate typeface for new design" },
  { rule: "eyebrow", pattern: /<(?:p|span|div)\b[^>]*class(?:Name)?=["'][^"']*\beyebrow\b[^"']*["'][^>]*>\s*[A-Z][A-Z\s\d!]+</g, message: "Template eyebrow: keep only meaningful structure" },
  { rule: "meta-line", pattern: /\bA\s+·\s+B\s+·\s+C\b/g, message: "Template meta line: give these words a clear job" },
  { rule: "flat-black", pattern: /#(?:000000|111111|000|111)\b/gi, message: "Use the direction's tinted neutrals" },
  { rule: "bouncy-easing", pattern: /cubic-bezier\(\s*[\d.]+\s*,\s*-?[\d.]+\s*,\s*[\d.]+\s*,\s*(?:1\.[1-9]\d*|[2-9][\d.]*)\s*\)/gi, message: "Avoid bouncy fallback motion" },
  { rule: "aurora", pattern: /\b(?:class(?:Name)?=["'][^"']*\baurora\b|animation\s*:\s*aurora\b)/gi, message: "Aurora decoration needs a brief-grounded reason" },
  { rule: "submit-copy", pattern: /<(?:button|Button)\b[^>]*>\s*Submit\s*</gi, message: "Name the action on the button" },
  { rule: "apologetic-error", pattern: /<[^>]*(?:role=["']alert["']|(?:class(?:Name)?|data-state)=["'][^"']*error[^"']*["'])[^>]*>\s*(?:Sorry|We(?:'|’)?re sorry|Oops)\b/gi, message: "Explain the error and recovery without apologetic validation" },
  { rule: "launch-tour", pattern: /\bdata-tour=["']launch["']|<(?:[\w.]*Tour|[\w.]*Joyride)\b[^>]*\b(?:autoStart|run)=\{?true\}?/g, message: "Teach through the empty state instead of a launch tour" },
];

/** Cheap source/DOM checks only. Layout, hierarchy and context-dependent tells stay with the reviewer. */
export function detectAiTells(sources: readonly SourceFile[], options: TellOptions = {}): Finding[] {
  for (const exception of options.exceptions ?? []) {
    if (!exception.reason.trim() || !exception.source.trim()) throw new Error("a tell exception needs the brief's words and a source reference");
  }
  const findings: Finding[] = [];
  for (const source of sources) {
    if (!uiSource(source.path)) continue;
    const text = withoutComments(source.content, source.path);
    const add = (offset: number, rule: TellRule, message: string) => {
      const f = finding(source.path, source.content, offset, rule, message);
      if (options.changedLines && !(options.changedLines[source.path] ?? []).some(r => f.line >= r.start && f.line <= r.end)) return;
      if (options.exceptions?.some(e => e.rule === rule)) return;
      findings.push(f);
    };
    for (const { rule, pattern, message } of RULES) {
      for (const match of text.matchAll(pattern)) add(match.index, rule, message);
    }
    structuralTells(text, add);
  }
  return ordered(findings);
}

function structuralTells(text: string, add: (offset: number, rule: TellRule, message: string) => void): void {
  for (const match of text.matchAll(/(?:linear|radial|conic)-gradient\([^;{}]+\)|(?:bg-)?gradient[^\n<]+/gi)) {
    if (purpleGradient(match[0])) add(match.index, "purple-gradient", "Use a functional accent instead of a purple/indigo gradient");
  }
  for (const match of text.matchAll(/<(button|span|i)\b([^>]*)>\s*(?:\{\s*["'])?((?:\p{Extended_Pictographic}|\uFE0F|\u200D|\p{Emoji_Modifier})+)(?:["']\s*\})?\s*<\/\1>/gu)) {
    if (match[1] === "button" || /icon|aria-hidden|role=["']img["']/.test(match[2]!)) add(match.index, "emoji-icon", "Use an icon from the project's icon set");
  }
  const buttons = [...text.matchAll(/<(?:button|Button)\b[^>]*>[\s\S]*?<\/(?:button|Button)>/g)];
  const primary = buttons.filter(m => /(?:class(?:Name)?|variant|data-variant)=["'][^"']*\bprimary\b/.test(m[0].split(">")[0]!));
  for (const match of primary.slice(1)) add(match.index, "multiple-primary", "Keep one primary action on this screen");
  const arrows = buttons.filter(m => /(?:→|&rarr;|&#8594;)/.test(m[0]));
  if (arrows.length > 1) for (const match of arrows) add(match.index, "button-arrows", "An arrow on every button is template chrome");
}

function purpleHex(hex: string): boolean {
  const r = Number.parseInt(hex.slice(0, 2), 16); const g = Number.parseInt(hex.slice(2, 4), 16); const b = Number.parseInt(hex.slice(4, 6), 16);
  return purpleRgb(r, g, b);
}

function purpleRgb(r: number, g: number, b: number): boolean {
  return b > 100 && r > g * 0.9 && b > r * 1.05;
}

function purpleGradient(value: string): boolean {
  if (/purple|indigo|violet/i.test(value) || [...value.matchAll(/#([a-f\d]{6})\b/gi)].some(m => purpleHex(m[1]!))) return true;
  for (const m of value.matchAll(/rgb[a]?\(\s*([\d.]+)(%?)\s*[, ]\s*([\d.]+)(%?)\s*[, ]\s*([\d.]+)(%?)/gi)) {
    if (purpleRgb(Number(m[1]) * (m[2] ? 2.55 : 1), Number(m[3]) * (m[4] ? 2.55 : 1), Number(m[5]) * (m[6] ? 2.55 : 1))) return true;
  }
  for (const m of value.matchAll(/oklch\(\s*[\d.]+%?\s+([\d.]+)(%?)\s+([\d.]+)/gi)) {
    const chroma = Number(m[1]) * (m[2] ? 0.004 : 1); const hue = Number(m[3]) % 360;
    if (chroma >= 0.08 && hue >= 255 && hue <= 325) return true;
  }
  return false;
}
