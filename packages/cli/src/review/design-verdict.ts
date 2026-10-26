import { z } from "zod";

export const DESIGN_RUBRIC = { weights: { quality: .35, originality: .35, craft: .15, functionality: .15 }, minimumAxis: 3, minimumWeighted: 3.5 } as const;
const text = z.string().trim().min(1).max(2048);
const score = z.number().int().min(1).max(5);
export const DesignVerdictSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  scores: z.object({ quality: score, originality: score, craft: score, functionality: score }).strict(),
  findings: z.array(z.object({ screen: text, element: text, principle: text, severity: z.enum(["high", "medium", "low"]), explanation: text, fix: text }).strict()).max(100),
}).strict();
export type DesignVerdict = z.infer<typeof DesignVerdictSchema>;
export interface DesignEvaluation {
  verdict: "pass" | "fail" | "error";
  scores?: DesignVerdict["scores"];
  weightedScore?: number;
  findings: DesignVerdict["findings"];
  error?: string;
}

export function evaluateDesignVerdict(raw: string): DesignEvaluation {
  try {
    if (Buffer.byteLength(raw) > 64 * 1024) throw new Error("design verdict exceeds 64 KiB");
    const value = DesignVerdictSchema.parse(JSON.parse(raw));
    const axes = Object.keys(DESIGN_RUBRIC.weights) as (keyof typeof DESIGN_RUBRIC.weights)[];
    const weightedScore = axes.reduce((sum, axis) => sum + value.scores[axis] * DESIGN_RUBRIC.weights[axis], 0);
    const failed = value.verdict === "fail" || value.findings.some(f => f.severity === "high") || axes.some(axis => value.scores[axis] < DESIGN_RUBRIC.minimumAxis) || weightedScore < DESIGN_RUBRIC.minimumWeighted;
    return { verdict: failed ? "fail" : "pass", scores: value.scores, weightedScore, findings: value.findings };
  } catch { return { verdict: "error", findings: [], error: "invalid or oversized design verdict" }; }
}
