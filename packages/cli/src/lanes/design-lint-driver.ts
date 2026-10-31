import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { lintDesign, lintTokens } from "./design.ts";
import { detectAiTells } from "./tells.ts";
import type { Finding } from "./source.ts";

export const DESIGN_LINT_CHECKS = ["ai-tells", "token-lint", "design-md-lint"] as const;
export type DesignLintCheck = typeof DESIGN_LINT_CHECKS[number];
export interface DesignLintConfig { files: string[]; design: string }
export function designLintPath(file: string): boolean {
  return file.length > 0 && file.length <= 1000 && !/[\\:\x00-\x1f]/.test(file) && file.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

/** Read source as bounded text only: no candidate imports, configuration, suppressions or symlinks. */
function sourceText(repo: string, file: string): string {
  if (!designLintPath(file)) throw new Error("invalid design lint source path");
  let path = resolve(repo);
  for (const part of file.split("/")) {
    path = join(path, part);
    if (lstatSync(path).isSymbolicLink()) throw new Error("design lint sources may not be symlinks");
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("design lint source must be bounded text");
  const bytes = readFileSync(path), text = bytes.toString("utf8");
  if (bytes.length > 1024 * 1024 || !Buffer.from(text).equals(bytes)) throw new Error("design lint source must be bounded UTF-8 text");
  return text;
}

/** Gate case: emits observations; the separate verifier decides whether any finding blocks. */
export function observeDesignLint(check: DesignLintCheck, config: DesignLintConfig, repo: string): {check: DesignLintCheck; complete: true; findings: Finding[]} {
  if (!DESIGN_LINT_CHECKS.includes(check) || !Array.isArray(config.files) || !config.files.length || config.files.length > 256) throw new Error("invalid design lint scope");
  let findings: Finding[];
  if (check === "design-md-lint") findings = lintDesign(sourceText(repo, "DESIGN.md")).findings;
  else {
    const sources = config.files.map(path => ({path, content: sourceText(repo, path)}));
    if (check === "ai-tells") findings = detectAiTells(sources);
    else {
      const design = lintDesign(config.design);
      if (!design.tokens) throw new Error("invalid approved design tokens");
      findings = lintTokens(sources, design.tokens);
    }
  }
  return {check, complete:true, findings};
}

function main(): void {
  const [check, config] = process.argv.slice(2);
  if (!DESIGN_LINT_CHECKS.includes(check as DesignLintCheck) || !config) throw new Error("missing protected design lint inputs");
  console.log(JSON.stringify(observeDesignLint(check as DesignLintCheck, JSON.parse(readFileSync(config,"utf8")) as DesignLintConfig, process.cwd())));
}
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try { main(); } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
