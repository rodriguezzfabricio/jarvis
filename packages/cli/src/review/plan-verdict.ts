import { z } from "zod";
import { schemaError, unfencedJson } from "./verdict.ts";

/**
 * The Goldfish plan review (decision 170): three fresh-context lenses read the plan before the build loop.
 * The runner computes each lens's verdict from its JSON; a lens that did not report every required check is
 * invalid, never clean.
 */
export const PLAN_LENSES = ["zoom-out", "critic", "readiness"] as const;
export type PlanLens = (typeof PLAN_LENSES)[number];
export const REQUIRED_CHECKS: Record<PlanLens, readonly string[]> = {
  "zoom-out": ["reuse-search", "yagni", "altitude", "dead-ends"],
  critic: ["alternatives", "assumptions", "risks", "standard-sections"],
  readiness: ["zero-decision", "target-scope", "phasing", "test-plan"],
};
export const PlanFindingSchema = z.object({
  severity: z.enum(["blocker", "major", "nit"]),
  /** T3, AC2, D12, or a path or path:line. */
  scope: z.string().trim().min(1).max(300),
  finding: z.string().trim().min(1).max(2000),
  /** What the reviewer read: path, path:line, D<n>, or "none found". */
  evidence: z.string().trim().min(1).max(600),
  recommendation: z.string().trim().min(1).max(2000),
}).strict();
export const PlanVerdictSchema = z.object({
  findings: z.array(PlanFindingSchema).max(500),
  checked: z.array(z.string().max(40)).max(16),
}).strict();
export type PlanFinding = z.infer<typeof PlanFindingSchema>;
export type PlanLensVerdictKind = "pass" | "resolve" | "fail";
export interface PlanLensVerdict { verdict: PlanLensVerdictKind; valid: boolean; findings: PlanFinding[]; checked: string[]; error?: string }

/** checked given as {name: what was read} (the live Claude reviewer's habit) becomes its names, when every value is non-empty text. */
function namedChecks(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("checked" in value)) return value;
  const checked = (value as { checked: unknown }).checked;
  if (typeof checked !== "object" || checked === null || Array.isArray(checked)) return value;
  const entries = Object.entries(checked);
  return entries.every(([, read]) => typeof read === "string" && read.trim().length > 0) ? { ...value, checked: entries.map(([name]) => name) } : value;
}

/** The runner computes the verdict; a blocker fails, a major needs resolution, a nit is advisory. An unread lens is invalid, never clean. */
export function evaluatePlanVerdict(raw: string, lens: PlanLens): PlanLensVerdict {
  if (!(PLAN_LENSES as readonly string[]).includes(lens)) return invalid(`unknown plan lens: ${String(lens)}`);
  let value: unknown;
  try { value = JSON.parse(unfencedJson(raw)); } catch { return invalid("plan review output is not JSON"); }
  const parsed = PlanVerdictSchema.safeParse(namedChecks(value));
  if (!parsed.success) return invalid(schemaError(parsed.error.issues, "plan review output does not match the verdict schema: "));
  const missing = REQUIRED_CHECKS[lens].filter((c) => !parsed.data.checked.includes(c));
  if (missing.length) return invalid(`plan review did not report checks: ${missing.join(", ")}`);
  const findings = parsed.data.findings;
  const verdict: PlanLensVerdictKind = findings.some((f) => f.severity === "blocker") ? "fail" : findings.some((f) => f.severity === "major") ? "resolve" : "pass";
  return { verdict, valid: true, findings, checked: parsed.data.checked };
}
function invalid(error: string): PlanLensVerdict { return { verdict: "fail", valid: false, findings: [], checked: [], error }; }
