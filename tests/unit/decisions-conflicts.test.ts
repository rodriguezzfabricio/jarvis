import { describe, expect, it } from "vitest";
import { checkConflicts, firmness, type StatedChoice } from "../../packages/cli/src/decisions/conflicts.ts";
import type { Decision } from "../../packages/cli/src/decisions/format.ts";

const old: Decision = {
  id: 1, date: "2026-10-20", decision: "No follow-ups", madeBy: "fabricio", status: { kind: "active" },
  source: "docs/intake.md#one", class: "Taste", reversibility: "hard", why: "Avoid spam",
  alternatives: ["One reminder"], dependsOn: ["outreach"], supersedes: null,
};
const on = "2026-10-24";
const explicit: StatedChoice = { decisionId: 1, choice: "Allow a reminder", by: "fabricio", intent: "explicit", reason: "My new workflow needs it" };

describe("decision firmness and intake conflicts (decision 48)", () => {
  it.each(["fabricio", "accepted-default"] as const)("treats %s choices as firm and changeable only by Fabricio", (madeBy) => {
    expect(firmness({ ...old, madeBy })).toEqual({ level: "firm", jarvisMayRevisit: false, confirmationRequired: false });
  });
  it.each(["Mechanical", "Taste"] as const)("allows revisiting Jarvis %s calls with a note", (kind) => {
    expect(firmness({ ...old, madeBy: "jarvis", class: kind })).toEqual({ level: "revisitable", jarvisMayRevisit: true, confirmationRequired: false });
  });
  it("requires confirmation once for inferred choices and never delegates Challenge decisions", () => {
    expect(firmness({ ...old, madeBy: "inferred" })).toEqual({ level: "confirm-once", jarvisMayRevisit: false, confirmationRequired: true });
    expect(firmness({ ...old, madeBy: "jarvis", class: "Challenge" })).toEqual({ level: "challenge", jarvisMayRevisit: false, confirmationRequired: true });
  });

  it("settles an explicit newer Fabricio request with a supersession instruction, date and reason", () => {
    const snapshot = structuredClone(old);
    expect(checkConflicts([old], [explicit], on)).toEqual({
      settled: [{ decisionId: 1, outcome: "supersede", choice: explicit.choice, date: on, reason: explicit.reason }], questions: [],
    });
    expect(old).toEqual(snapshot);
  });

  it("silence retains every active decision and ignores superseded entries", () => {
    const result = checkConflicts([old, { ...old, id: 2, status: { kind: "superseded", by: 3, date: on, reason: "Changed" } }], [], on);
    expect(result).toEqual({ settled: [{ decisionId: 1, outcome: "keep", reason: "not-mentioned" }], questions: [] });
  });

  it.each(["fabricio", "accepted-default"] as const)("never lets Jarvis override %s, even with explicit intent and a note", (madeBy) => {
    const result = checkConflicts([{ ...old, madeBy }], [{ ...explicit, by: "jarvis", note: "A generic best practice" }], on);
    expect(result).toEqual({ settled: [{ decisionId: 1, outcome: "keep", reason: "jarvis-cannot-override-fabricio" }], questions: [] });
  });

  it("returns an implied conflict as an intake question with source, default keep and three alternatives", () => {
    const result = checkConflicts([old], [{ ...explicit, intent: "implied" }], on);
    expect(result.settled).toEqual([]);
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]).toMatchObject({
      decisionId: 1, default: "keep", source: old.source,
      alternatives: [
        { id: "keep", label: "Keep the old decision", choice: old.decision },
        { id: "switch", label: "Switch to the new choice", choice: explicit.choice },
        { id: "feature-only", label: "Allow for this feature only", choice: explicit.choice },
      ],
    });
    expect(result.questions[0]?.question).toContain(old.date);
    expect(result.questions[0]?.question).toContain(old.decision);
    expect(result.questions[0]?.question).toContain(explicit.choice);
    expect(result.questions[0]?.question).toContain(old.source);
  });

  it("returns a question when an explicit override omits the user's reason", () => {
    const { reason: _reason, ...choice } = explicit;
    expect(checkConflicts([old], [choice], on).questions).toHaveLength(1);
  });

  it("requires a note before Jarvis may revisit its own Mechanical or Taste call", () => {
    const entry = { ...old, madeBy: "jarvis" as const };
    const choice = { ...explicit, by: "jarvis" as const };
    expect(checkConflicts([entry], [choice], on).questions).toHaveLength(1);
    expect(checkConflicts([entry], [{ ...choice, note: "New evidence: smaller footprint" }], on)).toEqual({
      settled: [{ decisionId: 1, outcome: "revisit", choice: explicit.choice, date: on, reason: "New evidence: smaller footprint" }], questions: [],
    });
  });

  it.each(["inferred", "jarvis"] as const)("never silently resolves an unresolved %s Challenge", (madeBy) => {
    const result = checkConflicts([{ ...old, madeBy, class: "Challenge" }], [{ ...explicit, by: "jarvis", note: "Change it" }], on);
    expect(result.settled).toEqual([]);
    expect(result.questions).toHaveLength(1);
  });

  it("does not invent conflicts for the same stated choice", () => {
    expect(checkConflicts([old], [{ ...explicit, choice: old.decision }], on)).toEqual({ settled: [{ decisionId: 1, outcome: "keep", reason: "unchanged" }], questions: [] });
  });

  it("preserves the exact stated choice rather than trimming it into a different decision", () => {
    const entry = { ...old, decision: "  No follow-ups  " };
    const result = checkConflicts([entry], [{ ...explicit, choice: entry.decision }], on);
    expect(result).toEqual({ settled: [{ decisionId: 1, outcome: "keep", reason: "unchanged" }], questions: [] });
  });

  it("rejects unknown targets, duplicate choices, invalid actors or intent, and older request dates", () => {
    expect(() => checkConflicts([old], [{ ...explicit, decisionId: 99 }], on)).toThrow(/active decision/i);
    expect(() => checkConflicts([old], [explicit, explicit], on)).toThrow(/duplicate/i);
    expect(() => checkConflicts([old], [{ ...explicit, by: "agent" } as never], on)).toThrow(/by/i);
    expect(() => checkConflicts([old], [{ ...explicit, intent: "guess" } as never], on)).toThrow(/intent/i);
    expect(() => checkConflicts([old], [explicit], "2026-10-19")).toThrow(/date/i);
  });
});
