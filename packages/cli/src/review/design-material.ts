import { z } from "zod";
import type { GateCheck } from "../checks/gate.ts";
import type { ChecksStore } from "../checks/store.ts";
import type { Ledger } from "../ledger/ledger.ts";
import { readPlanningFile } from "../runner/checks-author.ts";
import { DesignBrowserPlanSchema } from "./design-browser.ts";
import type { DesignReviewMaterial } from "./design-service.ts";

export interface ApprovedDesign { revision: string; design: string; product: string }
export const DesignReviewConfig = z.object({
  axeVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  /** Recorded by onboarding in the protected store; absence never excuses inherited choices. */
  designSource: z.enum(["existing", "new"]).default("new"),
}).strict();
/** The installers' own definition files: `design-checks.json` (Impeccable, browser) and `design-lint/checks.json`. */
const DefinitionsSchema = z.record(z.string(), z.object({
  name: z.string().min(1),
  cases: z.array(z.object({ id: z.string().min(1), command: z.string().min(1), timeoutMs: z.number().int().positive().optional() }).strict()).min(1),
  verify: z.string().min(1), timeoutMs: z.number().int().positive(), allowLocalBinding: z.boolean().optional(),
}).strict());
const DEFINITION_FILES = ["design-checks.json", "design-lint/checks.json"] as const;

const head = (git: (args: readonly string[]) => string, branch: string) => {
  const revision = git(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]).trim();
  if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new Error("invalid approved design revision");
  return revision;
};
const entryOf = (git: (args: readonly string[]) => string, revision: string, file: string) => git(["ls-tree", revision, "--", file]).trim();
function regularFile(git: (args: readonly string[]) => string, revision: string, file: "DESIGN.md" | "PRODUCT.md"): string {
  const entry = entryOf(git, revision, file);
  if (!new RegExp(`^100(?:644|755) blob [a-f0-9]+\\t${file.replace(".", "\\.")}$`).test(entry)) throw new Error(`approved ${file} must be a regular committed file`);
  return git(["show", `${revision}:${file}`]);
}

/** Whether the run branch has any DESIGN.md entry: the service is composed then, and a bad entry errors each design review. */
export function designOnBranch(git: (args: readonly string[]) => string, branch: string): boolean {
  return entryOf(git, head(git, branch), "DESIGN.md") !== "";
}

/** Resolve the branch once, then read only those committed objects through the runner's safe git seam. */
export function approvedDesign(git: (args: readonly string[]) => string, branch: string): ApprovedDesign | undefined {
  const revision = head(git, branch);
  if (!entryOf(git, revision, "DESIGN.md")) return undefined;
  return {revision, design: regularFile(git, revision, "DESIGN.md"), product: regularFile(git, revision, "PRODUCT.md")};
}

function principlesOf(design: string): string {
  const visible = design.replace(/<!--[\s\S]*?-->/g, "");
  const overview = /^## Overview\s*\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(visible)?.[1] ?? "";
  const lines = overview.split(/\r?\n/);
  const start = lines.findIndex(line => /^\s*(?:-\s*)?Principles:\s*\S/i.test(line));
  if (start < 0) throw new Error("approved DESIGN.md Overview needs principles");
  const principles = [lines[start]!.replace(/^\s*(?:-\s*)?Principles:\s*/i, "")];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*-\s*[\w ]+:|^#{1,6} /.test(line)) break;
    if (line.trim()) principles.push(line.trim());
  }
  return principles.join("\n").trim();
}

/** The protected design definitions, keyed by their own names; a name defined twice is refused. */
function protectedChecks(store: ChecksStore): Record<string, Pick<GateCheck, "cases" | "verify">> {
  const checks: Record<string, Pick<GateCheck, "cases" | "verify">> = Object.create(null) as Record<string, Pick<GateCheck, "cases" | "verify">>;
  for (const file of DEFINITION_FILES) {
    for (const [name, check] of Object.entries(DefinitionsSchema.parse(JSON.parse(readPlanningFile(store.checksDir, file))))) {
      if (check.name !== name || Object.hasOwn(checks, name)) throw new Error(`protected design definition ${name} is renamed or defined twice`);
      checks[name] = { cases: check.cases.map(({ timeoutMs, ...c }) => (timeoutMs === undefined ? c : { ...c, timeoutMs })), verify: check.verify };
    }
  }
  return checks;
}

/** Protected plan, pins and definitions are verified on each review; candidate paths are never consulted. */
export function designMaterialFor(input: { repoPath: string; snapshot: ApprovedDesign; store: ChecksStore; ledger: Ledger }): DesignReviewMaterial {
  if (!input.store.verify(input.ledger).ok) throw new Error("design material checks are not the approved set");
  const config = DesignReviewConfig.parse(JSON.parse(readPlanningFile(input.store.checksDir, "design-review.json")));
  const plan = DesignBrowserPlanSchema.parse(JSON.parse(readPlanningFile(input.store.checksDir, "design-plan.json")));
  return {
    repoPath: input.repoPath, baseRevision: input.snapshot.revision, design: input.snapshot.design, product: input.snapshot.product,
    principles: principlesOf(input.snapshot.design), designSource: config.designSource, plan, axeVersion: config.axeVersion,
    captureFile: "cases/capture/stdout", checks: protectedChecks(input.store),
  };
}
