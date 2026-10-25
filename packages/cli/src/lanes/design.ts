import { parseTokenDocument, type TokenDocument } from "./design-format.ts";
import { finding, ordered, uiSource, withoutComments, type Finding, type LineRange, type SourceFile } from "./source.ts";

export interface DesignTokens { colors: string[]; spacing: number[]; radii: number[]; typeScale: number[]; fonts: string[] }
export interface DesignLint { findings: Finding[]; tokens?: DesignTokens }
export interface TokenLintOptions { tokenFiles?: readonly string[]; changedLines?: Readonly<Record<string, readonly LineRange[]>> }
export const DESIGN_SECTIONS = ["Overview", "Colors", "Typography", "Layout", "Elevation & Depth", "Shapes", "Components", "Do's and Don'ts"] as const;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const px = (v: string) => /^(?:0|\d+(?:\.\d+)?)px$/.test(v) ? Number.parseFloat(v) : NaN;
const numbers = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);

/** Validation is deliberately independent of generated theme code and never imports a project's config. */
export function lintDesign(content: string, file = "DESIGN.md"): DesignLint {
  const findings: Finding[] = [];
  const add = (line: number, rule: string, message: string) => findings.push({ file, line, column: 1, rule, message });
  let doc: TokenDocument;
  try { doc = parseTokenDocument(content); }
  catch (error) { add(1, "design-format", String(error instanceof Error ? error.message : error)); return { findings }; }
  for (const section of DESIGN_SECTIONS) {
    if (!doc.body.split("\n").some(l => l.trim() === `## ${section}`)) add(1, "design-section", `Missing section: ${section}`);
  }
  if (!doc.values.get("name")?.value.trim()) add(1, "design-name", "Missing product name");
  const visible = withoutComments(content);
  const placeholder = /<[^<>\n]+>/.exec(visible);
  if (placeholder) findings.push(finding(file, content, placeholder.index, "design-placeholder", "Replace the template placeholder"));
  for (const group of ["colors", "typography", "rounded", "spacing", "components"]) {
    if (!doc.groups.has(group) || ![...doc.values.keys()].some(k => k.startsWith(`${group}.`))) add(1, "design-group", `Missing or empty token group: ${group}`);
  }
  const tokens: DesignTokens = { colors: [], spacing: [0], radii: [0], typeScale: [], fonts: [] };
  readTokens(doc, tokens, add);
  checkComponents(doc, add);
  tokens.spacing = numbers(tokens.spacing); tokens.radii = numbers(tokens.radii); tokens.typeScale = numbers(tokens.typeScale);
  tokens.fonts = [...new Set(tokens.fonts)].sort();
  return findings.length ? { findings: ordered(findings) } : { findings: [], tokens };
}

type Add = (line: number, rule: string, message: string) => void;

function readTokens(doc: TokenDocument, tokens: DesignTokens, add: Add): void {
  for (const [key, line] of doc.groups) {
    if (/^(?:colors|spacing|rounded)\./.test(key)) add(line, "design-format", `${key} must be a scalar token`);
  }
  for (const [key, token] of doc.values) {
    const { value, line } = token;
    if (key.startsWith("colors.")) {
      if (!/^colors\.[^.]+$/.test(key) || !HEX.test(value)) add(line, "design-color", `${key} must be an opaque hex color`);
      else tokens.colors.push(value.toLowerCase());
    } else if (key.startsWith("spacing.") || key.startsWith("rounded.")) {
      if (key.split(".").length !== 2 || !Number.isFinite(px(value))) add(line, "design-size", `${key} must be a nonnegative px size`);
      else (key.startsWith("spacing.") ? tokens.spacing : tokens.radii).push(px(value));
    }
  }
  const roles = [...doc.groups.keys()].filter(k => /^typography\.[^.]+$/.test(k));
  for (const role of roles) {
    for (const field of ["fontFamily", "fontSize", "fontWeight", "lineHeight"]) {
      const token = doc.values.get(`${role}.${field}`);
      const value = token?.value ?? "";
      const valid = field === "fontFamily" ? value.trim().length > 0 : field === "fontSize" ? px(value) > 0 : field === "fontWeight" ? /^(?:[1-9]00|normal|bold)$/.test(value) : /^\d+(?:\.\d+)?$/.test(value) && Number(value) > 0;
      if (!valid) add(token?.line ?? doc.groups.get(role)!, "design-type", `Invalid ${role}.${field}`);
      else if (field === "fontFamily") tokens.fonts.push(value);
      else if (field === "fontSize") tokens.typeScale.push(px(value));
    }
  }
  if (!roles.length) add(1, "design-type", "Typography needs at least one complete role");
}

function checkComponents(doc: TokenDocument, add: Add): void {
  for (const [key, { value, line }] of doc.values) {
    if (!key.startsWith("components.")) continue;
    const refs = [...value.matchAll(/\{([A-Za-z0-9_.-]+)\}/g)];
    if (!refs.length || value.replace(/\{[A-Za-z0-9_.-]+\}/g, "").trim()) add(line, "design-component-literal", `${key} must refer to tokens`);
    const field = key.split(".").at(-1)!;
    const expected = /color$/i.test(field) ? "colors" : /typography/i.test(field) ? "typography" : /round|radius/i.test(field) ? "rounded" : /padding|margin|gap|spacing/i.test(field) ? "spacing" : undefined;
    for (const ref of refs) {
      const target = ref[1]!;
      if (!doc.values.has(target) && !doc.groups.has(target)) add(line, "design-reference", `Unknown token: ${target}`);
      if (expected && (target.split(".")[0] !== expected || target.split(".").length !== 2)) add(line, "design-reference-type", `${key} needs a ${expected} token`);
    }
  }
  for (const component of [...doc.groups.keys()].filter(k => /^components\.[^.]+$/.test(k))) {
    const color = (field: string) => {
      const ref = /^\{([^}]+)\}$/.exec(doc.values.get(`${component}.${field}`)?.value ?? "");
      return ref ? doc.values.get(ref[1]!)?.value : undefined;
    };
    const foreground = color("textColor"); const background = color("backgroundColor");
    if (foreground && background && HEX.test(foreground) && HEX.test(background) && contrast(foreground, background) < 4.5) add(doc.groups.get(component)!, "design-contrast", `${component} text contrast must be at least 4.5:1`);
  }
}

function luminance(hex: string): number {
  const raw = hex.length === 4 ? [...hex.slice(1)].map(c => c + c).join("") : hex.slice(1);
  const channels = [0, 2, 4].map(i => Number.parseInt(raw.slice(i, i + 2), 16) / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}
function contrast(a: string, b: string): number {
  const x = luminance(a); const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Generated token files may be excluded only by the runner's approved check configuration. */
export function lintTokens(sources: readonly SourceFile[], tokens: DesignTokens, input: TokenLintOptions | readonly string[] = {}): Finding[] {
  const options: TokenLintOptions = Array.isArray(input) ? { tokenFiles: input } : input as TokenLintOptions;
  const findings: Finding[] = [];
  for (const source of sources) {
    if (!uiSource(source.path) || options.tokenFiles?.includes(source.path)) continue;
    const text = withoutComments(source.content, source.path).replace(/@(?:media|container)[^{]+/g, s => s.replace(/[^\r\n]/g, " "));
    const add = (offset: number, rule: string, message: string) => {
      const f = finding(source.path, source.content, offset, rule, message);
      if (options.changedLines && !(options.changedLines[source.path] ?? []).some(r => f.line >= r.start && f.line <= r.end)) return;
      findings.push(f);
    };
    for (const match of text.matchAll(/#[\da-f]{3,8}\b|\bColor\s*\(\s*hex\s*:\s*["'][\da-f]{3,8}["']/gi)) {
      if (colorContext(text, match.index, match[0])) add(match.index, "raw-color", "Use a color token instead of a raw hex color");
    }
    for (const match of text.matchAll(/(-?\d+(?:\.\d+)?)px\b/g)) {
      const prefix = text.slice(Math.max(0, match.index - 100), match.index).split(/[;\n{}]/).at(-1)!;
      if (/\b(?:max-width|maxWidth)\s*:/.test(prefix) || (Number(match[1]) === 1 && /\bborder(?:-(?:top|bottom|left|right|width))?\s*:/.test(prefix))) continue;
      const property = [...prefix.matchAll(/fontSize|font-size|borderRadius|border-radius|(?:rounded|text|[pm][xytblr]?|gap|w|h)-\[/gi)].at(-1)?.[0] ?? "";
      const kind = /radius|rounded/i.test(property) ? "radius" : /font|text/i.test(property) ? "type" : "spacing";
      checkSize(Number(match[1]), kind, match.index, tokens, add);
    }
    for (const match of text.matchAll(/\b(padding\w*|margin\w*|gap|rowGap|columnGap|borderRadius|fontSize|(?:min)?[Ww]idth|(?:min|max)?[Hh]eight|top|bottom|left|right)\s*:\s*(-?\d+(?:\.\d+)?)(?![\w.])/g)) {
      checkSize(Number(match[2]), /Radius/.test(match[1]!) ? "radius" : match[1] === "fontSize" ? "type" : "spacing", match.index, tokens, add);
    }
    for (const match of text.matchAll(/\.(padding|cornerRadius)\(\s*(?:\.[A-Za-z]+\s*,\s*)?(-?\d+(?:\.\d+)?)\s*\)|\bsize:\s*(\d+(?:\.\d+)?)/g)) {
      if (match[3] && (!source.path.endsWith(".swift") || !/\.(?:font|custom|system)\([^;\n]*$/.test(text.slice(Math.max(0, match.index - 200), match.index)))) continue;
      checkSize(Number(match[2] ?? match[3]), match[1] === "cornerRadius" ? "radius" : match[3] ? "type" : "spacing", match.index, tokens, add);
    }
    checkFonts(text, tokens, add);
  }
  return ordered(findings);
}

function colorContext(text: string, offset: number, value: string): boolean {
  if (value.startsWith("Color")) return true;
  const prefix = text.slice(Math.max(0, offset - 200), offset).split(/[;{}\n]/).at(-1)!;
  return /\b(?:[\w-]*color|background(?:-image)?|fill|stroke|box-shadow|text-shadow|border(?:-[\w-]+)?|outline(?:-color)?|tintColor|shadowColor)\s*[:=]/i.test(prefix) || /--[\w-]+\s*:/.test(prefix) || /(?:bg|text|border|from|to|via|fill|stroke)-\[[^\]]*$/.test(prefix);
}

function checkSize(value: number, kind: "radius" | "type" | "spacing", offset: number, tokens: DesignTokens, add: (offset: number, rule: string, message: string) => void): void {
  const scale = kind === "radius" ? tokens.radii : kind === "type" ? tokens.typeScale : tokens.spacing;
  if (!scale.includes(kind === "spacing" ? Math.abs(value) : value)) add(offset, `off-scale-${kind}`, `${value}px is outside the ${kind} scale`);
}

function checkFonts(text: string, tokens: DesignTokens, add: (offset: number, rule: string, message: string) => void): void {
  const generic = /^(?:serif|sans-serif|monospace|cursive|fantasy|inherit|initial|unset)$/i;
  for (const match of text.matchAll(/(?:font-family|fontFamily)\s*:\s*([^;\n}]+)|\.custom\(\s*["']([^"']+)["']/g)) {
    const value = (match[2] ?? match[1]!).split(/,\s*[A-Za-z_$][\w$]*\s*:/)[0]!;
    if (/var\(|\{(?:typography|fonts)\.|(?:theme|tokens)\./.test(value)) continue;
    const fonts = value.split(",").map(v => v.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    if (fonts.some(font => !generic.test(font) && !tokens.fonts.includes(font))) add(match.index, "unknown-font", `Use a typeface from DESIGN.md: ${value.trim()}`);
  }
  for (const match of text.matchAll(/font-\[["']([^"']+)["']\]/g)) {
    if (!tokens.fonts.includes(match[1]!.replaceAll("_", " "))) add(match.index, "unknown-font", `Use a typeface from DESIGN.md: ${match[1]}`);
  }
  for (const match of text.matchAll(/\.font\(\s*\.system\b/g)) {
    if (!tokens.fonts.some(f => /^(?:system|system-ui|-apple-system)$/.test(f))) add(match.index, "unknown-font", "The system typeface is not declared in DESIGN.md");
  }
}
