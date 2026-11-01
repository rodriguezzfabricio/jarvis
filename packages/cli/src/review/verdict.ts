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
export const VerdictSchema = z.object({ findings: z.array(FindingSchema).max(1000), checked: z.array(z.enum(["spec-criteria", "data-flow", "error-paths", "unchanged-callers", "bug-brief-inputs"])).max(8) }).strict();
export type Finding = z.infer<typeof FindingSchema>;
export interface EvaluatedVerdict {
  verdict: "pass" | "fail" | "investigate";
  valid: boolean;
  findings: Finding[];
  investigate: Finding[];
  error?: string;
}
export const CONFIDENCE_CUTOFF = 0.8;

/** A reply that is exactly one Markdown-fenced JSON block (the live Claude reviewer's habit) yields the block; anything else is read as is. */
export function unfencedJson(raw: string): string {
  const m = /^\s*```(?:json)?\n([\s\S]*?)\n```\s*$/.exec(raw);
  return m && !m[1]!.includes("```") ? m[1]! : raw;
}

/** checked given as {name: what was read} (the live Claude reviewer's other habit) becomes its names, when every value is non-empty text; the schema then judges the names. */
function namedChecks(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("checked" in value)) return value;
  const checked = (value as { checked: unknown }).checked;
  if (typeof checked !== "object" || checked === null || Array.isArray(checked)) return value;
  const entries = Object.entries(checked);
  return entries.every(([, read]) => typeof read === "string" && read.trim().length > 0) ? { ...value, checked: entries.map(([name]) => name) } : value;
}

/** Normalize only representations with one meaning; the public output schema stays strict. */
function normalizedVerdict(value: unknown): unknown {
  const named = namedChecks(value);
  if (typeof named !== "object" || named === null || !("findings" in named) || !Array.isArray(named.findings)) return named;
  return { ...named, findings: named.findings.map((finding: unknown) => {
    if (typeof finding !== "object" || finding === null || Array.isArray(finding)) return finding;
    const fields = { ...finding } as Record<string, unknown>;
    if (typeof fields.line === "string" && /^[0-9]+$/.test(fields.line) && Number.isSafeInteger(Number(fields.line))) fields.line = Number(fields.line);
    if (typeof fields.confidence === "string" && /^(?:0(?:\.[0-9]+)?|1(?:\.0+)?)$/.test(fields.confidence)) fields.confidence = Number(fields.confidence);
    if (typeof fields.severity === "string") fields.severity = fields.severity.toLowerCase();
    return fields;
  }) };
}

/** Paths and codes are schema-owned; never include messages, unknown keys or received values. The plan verdict reads its misses the same way. */
export function schemaError(issues: readonly z.core.$ZodIssue[], prefix = "review output does not match the verdict schema: "): string {
  const shown: string[] = [];
  for (const [index, issue] of issues.entries()) {
    const detail = `${issue.path.join(".") || "$"}:${issue.code}`;
    // The loop's blocked reason preserves 160 characters. Reserve room for the omitted count.
    const suffix = index + 1 < issues.length ? `; +${issues.length - index - 1} more` : "";
    if (prefix.length + [...shown, detail].join("; ").length + suffix.length > 160) break;
    shown.push(detail);
  }
  const omitted = issues.length - shown.length;
  return prefix + shown.join("; ") + (omitted ? `; +${omitted} more` : "");
}

/** The runner computes the verdict; an agent cannot declare itself passed. */
export function evaluateVerdict(raw: string, options: { kind?: "bug" } = {}): EvaluatedVerdict {
  let value: unknown;
  try { value = JSON.parse(unfencedJson(raw)); } catch { return invalid("review output is not JSON"); }
  const parsed = VerdictSchema.safeParse(normalizedVerdict(value));
  if (!parsed.success) return invalid(schemaError(parsed.error.issues));
  const required = ["spec-criteria", "data-flow", "error-paths", "unchanged-callers", ...(options.kind === "bug" ? ["bug-brief-inputs"] : [])];
  const missing = required.filter((name) => !(parsed.data.checked as readonly string[]).includes(name));
  if (missing.length) return invalid(`review did not report its checks: ${missing.join(", ")}`);
  const findings = parsed.data.findings.filter((f) => f.confidence >= CONFIDENCE_CUTOFF);
  const investigate = parsed.data.findings.filter((f) => f.confidence < CONFIDENCE_CUTOFF && f.impact !== "other");
  const blocking = findings.some((f) => f.severity === "critical" || (f.severity === "high" && f.scenario.trim().length > 0));
  const needsInvestigation = investigate.some((f) => f.severity === "critical" || f.severity === "high");
  return { verdict: blocking ? "fail" : needsInvestigation ? "investigate" : "pass", valid: true, findings, investigate };
}
function invalid(error: string): EvaluatedVerdict {
  return { verdict: "fail", valid: false, findings: [], investigate: [], error };
}
