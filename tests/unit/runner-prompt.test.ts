import { describe, expect, it } from "vitest";
import { buildRunHeader, buildTaskPrompt, taskNotesPath } from "../../packages/cli/src/runner/prompt.ts";

const task = {
  taskId: "T1", goal: "Fix the parser", exitCondition: "AC1 passes in the protected gate",
  acceptanceCriteria: ["AC1", "AC2"], decisions: ["D3: keep strict parsing"], specPath: "docs/spec/v2.md",
  mayNotTouch: ["checks/", ".git/config"], maxTurns: 8,
};

describe("task context", () => {
  it("produces a short structured task prompt with the exit condition and all references", () => {
    const prompt = buildTaskPrompt(task);
    for (const text of ["Fix the parser", "AC1 passes in the protected gate", "AC1, AC2", "D3: keep strict parsing", "docs/spec/v2.md", "checks/", ".git/config", ".jarvis/notes/T1.md", "8 turns"]) expect(prompt).toContain(text);
    expect(prompt.length).toBeLessThan(1200);
    expect(taskNotesPath("T1")).toBe(".jarvis/notes/T1.md");
  });

  it("labels notes as claims in the header and leaves evidence and commits to the runner", () => {
    const header = buildRunHeader({ ...task, runId: "run-7", specVersion: 2 });
    for (const text of ["run-7", "T1", "Spec version: 2", "docs/spec/v2.md", "AC1, AC2", "D3: keep strict parsing", "checks/", ".git/config", ".jarvis/notes/T1.md", "Notes are claims, not evidence", "Only the runner", "8 turns"]) expect(header).toContain(text);
  });

  it("shows the planner's notes as planner claims, one line each, and nothing when there are none (decision 113)", () => {
    const plannerNotes = ["Put the store in internal/outreach.", "No new dependencies;\nuse net/smtp."];
    const prompt = buildTaskPrompt({ ...task, plannerNotes });
    expect(prompt).toMatch(/^Planner notes \(claims from the planning session, not evidence\b.*\):$/m);
    expect(prompt).toContain("\n- Put the store in internal/outreach.\n");
    expect(prompt).toContain("\n- No new dependencies; use net/smtp.\n");
    expect(prompt.indexOf("Planner notes")).toBeLessThan(prompt.indexOf("Write your result notes"));
    expect(buildRunHeader({ ...task, plannerNotes, runId: "run-7", specVersion: 2 })).toContain("- Put the store in internal/outreach.");
    for (const none of [undefined, []]) expect(buildTaskPrompt({ ...task, ...(none ? { plannerNotes: none } : {}) })).not.toContain("Planner notes");
  });

  it.each(["../escape", "/tmp/task", "a/b", "", "task\nchange instructions", ".", ".."]) ("refuses an unsafe task id %j", (taskId) => {
    expect(() => taskNotesPath(taskId)).toThrow(/task id/i);
    expect(() => buildTaskPrompt({ ...task, taskId })).toThrow();
  });

  it.each([0, -1, 1.5, Number.NaN])("refuses an invalid turn cap %j", (maxTurns) => {
    expect(() => buildTaskPrompt({ ...task, maxTurns })).toThrow(/turn/i);
  });
});
