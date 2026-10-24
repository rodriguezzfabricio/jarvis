import { z } from "zod";
import type { Decision } from "./format.ts";

export interface Firmness {
  level: "firm" | "revisitable" | "confirm-once" | "challenge";
  jarvisMayRevisit: boolean;
  confirmationRequired: boolean;
}
export function firmness(entry: Decision): Firmness {
  if (entry.madeBy === "fabricio" || entry.madeBy === "accepted-default") {
    return { level: "firm", jarvisMayRevisit: false, confirmationRequired: false };
  }
  if (entry.madeBy === "inferred" || entry.madeBy === "unconfirmed-default") return { level: "confirm-once", jarvisMayRevisit: false, confirmationRequired: true };
  if (entry.class === "Challenge") return { level: "challenge", jarvisMayRevisit: false, confirmationRequired: true };
  return { level: "revisitable", jarvisMayRevisit: true, confirmationRequired: false };
}
export function assertMaySupersede(old: Decision, madeBy: Decision["madeBy"], reason: string): void {
  if (!firmness(old).jarvisMayRevisit && madeBy !== "fabricio") throw new Error(`Only the user (fabricio) can supersede D${old.id}`);
  if (!reason.trim()) throw new Error("Supersession reason must not be blank");
}

const choiceSchema = z.object({
  decisionId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  choice: z.string().refine((value) => value.trim().length > 0), by: z.enum(["fabricio", "jarvis"]), intent: z.enum(["explicit", "implied"]),
  reason: z.string().optional(), note: z.string().optional(),
}).strict();
export type StatedChoice = z.infer<typeof choiceSchema>;
export interface SettledChoice {
  decisionId: number;
  outcome: "keep" | "supersede" | "revisit";
  reason: string;
  choice?: string;
  date?: string;
}
export interface IntakeQuestion {
  decisionId: number;
  question: string;
  source: string;
  default: "keep";
  alternatives: { id: "keep" | "switch" | "feature-only"; label: string; choice: string }[];
}
export interface ConflictResult { settled: SettledChoice[]; questions: IntakeQuestion[] }

/** Choices target IDs explicitly. Semantic extraction belongs to intake, not this policy layer. */
export function checkConflicts(entries: readonly Decision[], choices: readonly StatedChoice[], on: string): ConflictResult {
  z.iso.date().parse(on);
  const active = entries.filter((entry) => entry.status.kind === "active");
  const activeIds = new Set(active.map((entry) => entry.id));
  if (activeIds.size !== active.length) throw new Error("Duplicate active decision IDs");
  const byId = new Map<number, StatedChoice>();
  for (const raw of choices) {
    const choice = choiceSchema.parse(raw);
    if (!activeIds.has(choice.decisionId)) throw new Error(`No active decision D${choice.decisionId}`);
    if (byId.has(choice.decisionId)) throw new Error(`Duplicate choice for D${choice.decisionId}`);
    byId.set(choice.decisionId, choice);
  }
  const result: ConflictResult = { settled: [], questions: [] };
  for (const entry of active) {
    const choice = byId.get(entry.id);
    if (!choice) {
      result.settled.push({ decisionId: entry.id, outcome: "keep", reason: "not-mentioned" });
      continue;
    }
    if (on < entry.date) throw new Error(`Request date predates decision D${entry.id}`);
    if (choice.choice === entry.decision) {
      result.settled.push({ decisionId: entry.id, outcome: "keep", reason: "unchanged" });
    } else if (choice.by === "jarvis" && (entry.madeBy === "fabricio" || entry.madeBy === "accepted-default")) {
      result.settled.push({ decisionId: entry.id, outcome: "keep", reason: "jarvis-cannot-override-fabricio" });
    } else if (choice.by === "fabricio" && choice.intent === "explicit" && choice.reason?.trim()) {
      result.settled.push({ decisionId: entry.id, outcome: "supersede", choice: choice.choice, date: on, reason: choice.reason });
    } else if (choice.by === "jarvis" && choice.intent === "explicit" && firmness(entry).jarvisMayRevisit && choice.note?.trim()) {
      result.settled.push({ decisionId: entry.id, outcome: "revisit", choice: choice.choice, date: on, reason: choice.note });
    } else {
      result.questions.push({
        decisionId: entry.id,
        question: `On ${entry.date}, ${entry.madeBy} decided "${entry.decision}" (${entry.source}). This request proposes "${choice.choice}". Keep the old decision, switch, or allow it for this feature only?`,
        source: entry.source,
        default: "keep",
        alternatives: [
          { id: "keep", label: "Keep the old decision", choice: entry.decision },
          { id: "switch", label: "Switch to the new choice", choice: choice.choice },
          { id: "feature-only", label: "Allow for this feature only", choice: choice.choice },
        ],
      });
    }
  }
  return result;
}
