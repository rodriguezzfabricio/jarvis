import { z } from "zod";

export const FindingSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  confidence: z.number().min(0).max(1),
  impact: z.enum(["security", "data_loss", "money", "messages", "other"]),
  file: z.string().trim().min(1),
  line: z.number().int().positive(),
  scenario: z.string(),
  fix: z.string().trim().min(1),
}).strict();
export const VerdictSchema = z.object({ findings: z.array(FindingSchema).max(1000) }).strict();
export type Finding = z.infer<typeof FindingSchema>;
export interface EvaluatedVerdict {
  verdict: "pass" | "fail" | "investigate";
  valid: boolean;
  findings: Finding[];
  investigate: Finding[];
  error?: string;
}
export const CONFIDENCE_CUTOFF = 0.8;

/** The runner computes the verdict; an agent cannot declare itself passed. */
export function evaluateVerdict(raw: string): EvaluatedVerdict {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return invalid("review output is not JSON"); }
  const parsed = VerdictSchema.safeParse(value);
  if (!parsed.success) return invalid("review output does not match the verdict schema");
  const findings = parsed.data.findings.filter((f) => f.confidence >= CONFIDENCE_CUTOFF);
  const investigate = parsed.data.findings.filter((f) => f.confidence < CONFIDENCE_CUTOFF && f.impact !== "other");
  const blocking = findings.some((f) => f.severity === "critical" || (f.severity === "high" && f.scenario.trim().length > 0));
  const needsInvestigation = investigate.some((f) => f.severity === "critical" || f.severity === "high");
  return { verdict: blocking ? "fail" : needsInvestigation ? "investigate" : "pass", valid: true, findings, investigate };
}
function invalid(error: string): EvaluatedVerdict {
  return { verdict: "fail", valid: false, findings: [], investigate: [], error };
}
