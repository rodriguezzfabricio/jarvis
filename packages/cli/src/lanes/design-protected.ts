import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GateCheck } from "../checks/gate.ts";
import type { ChecksStore } from "../checks/store.ts";
import { DesignReviewConfig } from "../review/design-material.ts";
import type { DesignSource } from "../review/design-evidence.ts";
import { DESIGN_LINT_CHECKS, designLintPath, type DesignLintCheck, type DesignLintConfig } from "./design-lint-driver.ts";
import { lintDesign } from "./design.ts";

export interface DesignLintPlan extends DesignLintConfig { nodeBin: string; axeVersion: string; designSource?: DesignSource }
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/** Install once, then have the runner review and approve the store, exactly as for security checks. */
export function installDesignLintChecks(store: ChecksStore, input: DesignLintPlan): Record<DesignLintCheck, GateCheck> {
  const config = DesignReviewConfig.parse({axeVersion:input.axeVersion, ...(input.designSource ? {designSource:input.designSource} : {})});
  if (!isAbsolute(input.nodeBin)) throw new Error("Node binary must be absolute");
  if (!input.files.length || input.files.length > 256 || input.files.some(file => !designLintPath(file)) || new Set(input.files).size !== input.files.length) throw new Error("invalid design lint scope");
  if (!lintDesign(input.design).tokens) throw new Error("invalid approved DESIGN.md");
  const fixture = join(store.checksDir, "fixtures", "design-lint"), verify = join(store.checksDir, "design-lint");
  const reviewConfig = join(store.checksDir, "design-review.json");
  if ([fixture, verify, reviewConfig, ...DESIGN_LINT_CHECKS.map(name => join(store.checksDir, `${name}.check.json`))].some(existsSync)) throw new Error("design lint checks already installed; changes need review");
  for (const directory of [fixture, verify]) mkdirSync(directory, {recursive:true,mode:0o700});
  for (const module of ["design.ts", "design-format.ts", "source.ts", "tells.ts", "design-lint-driver.ts"]) copyFileSync(fileURLToPath(new URL(module, import.meta.url)), join(fixture, module));
  copyFileSync(fileURLToPath(new URL("design-lint-verify.ts", import.meta.url)), join(verify, "verify.ts"));
  for (const directory of [fixture, verify]) writeFileSync(join(directory, "package.json"), JSON.stringify({type:"module"}), {flag:"wx",mode:0o600});
  writeFileSync(join(fixture, "config.json"), JSON.stringify({files:input.files,design:input.design}), {flag:"wx",mode:0o600});
  writeFileSync(reviewConfig, JSON.stringify(config), {flag:"wx",mode:0o600});
  const definitions = {} as Record<DesignLintCheck, GateCheck>;
  for (const name of DESIGN_LINT_CHECKS) {
    const check: GateCheck = {
      name, timeoutMs:30_000,
      cases:[{id:"lint",command:`${quote(input.nodeBin)} "$JARVIS_FIXTURES/design-lint/design-lint-driver.ts" ${quote(name)} "$JARVIS_FIXTURES/design-lint/config.json"`}],
      verify:`${quote(input.nodeBin)} "$JARVIS_CHECKS/design-lint/verify.ts" ${quote(name)}`,
    };
    writeFileSync(join(store.checksDir, `${name}.check.json`), JSON.stringify(check), {flag:"wx",mode:0o600});
    definitions[name] = check;
  }
  return definitions;
}
