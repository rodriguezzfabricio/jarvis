import { z } from "zod";
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

/** Resolve the branch once, then read only those committed objects through the runner's safe git seam. */
export function approvedDesign(git: (args: readonly string[]) => string, branch: string): ApprovedDesign | undefined {
  const revision = git(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]).trim();
  if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new Error("invalid approved design revision");
  const object = git(["ls-tree", revision, "--", "DESIGN.md"]).trim();
  if (!object) return undefined;
  if (!/^100(?:644|755) blob [a-f0-9]+\tDESIGN\.md$/.test(object)) throw new Error("approved DESIGN.md must be a regular file");
  return {revision, design: git(["show", `${revision}:DESIGN.md`]), product: git(["show", `${revision}:PRODUCT.md`])};
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

/** Protected plan and pins are verified on each review; candidate paths are never consulted. */
export function designMaterialFor(input: { repoPath: string; snapshot: ApprovedDesign; store: ChecksStore; ledger: Ledger }): DesignReviewMaterial {
  if (!input.store.verify(input.ledger).ok) throw new Error("design material checks are not the approved set");
  const config = DesignReviewConfig.parse(JSON.parse(readPlanningFile(input.store.checksDir, "design-review.json")));
  const plan = DesignBrowserPlanSchema.parse(JSON.parse(readPlanningFile(input.store.checksDir, "design-plan.json")));
  return {
    repoPath: input.repoPath, baseRevision: input.snapshot.revision, design: input.snapshot.design, product: input.snapshot.product,
    principles: principlesOf(input.snapshot.design), designSource: config.designSource, plan, axeVersion: config.axeVersion,
    captureFile: "cases/capture/stdout",
  };
}
