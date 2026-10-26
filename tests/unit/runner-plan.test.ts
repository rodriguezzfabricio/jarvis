import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PlanSchema, planEntries, readPlan, readSessionPlan, singleTaskPlan } from "../../packages/cli/src/runner/plan.ts";
import { checkSpec } from "../../packages/cli/src/spec/index.ts";
import { triage } from "../../packages/cli/src/triage/triage.ts";

const roots: string[] = [];
const specText = `---\nspec: 1\ndate: 2026-10-24\nstatus: confirmed\nsupersedes: none\n---\n## Goals\n- Deliver.\n## Non-goals\nNone.\n## User stories\n- **S1 (P1):** As a user I want a result.\n## Acceptance criteria\n- **AC1 (S1):** WHEN asked THE SYSTEM SHALL return a result.\n## Assumptions\nNone.\n## Open questions\nNone.\n`;
const spec = checkSpec(specText, "docs/spec/v1.md").spec;
const task = (id = "T1") => ({ id, title: "Deliver result", goal: "Return the requested result", exitCondition: "The output matches AC1", acceptanceCriteria: ["AC1"], storyIds: ["S1"], dependencies: [] as string[], priority: 1, requiredChecks: ["ac1"], requiredReviews: ["code"], mayTouch: ["src/result.ts"] });
function workspace(tasks: unknown[] = [task()]) {
  const root = mkdtempSync("/private/tmp/j-plan-"); roots.push(root);
  mkdirSync(join(root, ".jarvis"));
  writeFileSync(join(root, ".jarvis/plan.json"), JSON.stringify({ tasks }));
  return root;
}
const context = { spec, checks: [{ name: "ac1", criteria: ["AC1"] }] };
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });

describe("planner plans", () => {
  it("parses the spec's ACs and emits runner task_created definitions without losing prompt fields", () => {
    expect(checkSpec(specText, "docs/spec/v1.md").ok).toBe(true);
    const plan = readPlan(workspace(), context);
    const { id, ...definition } = task();
    expect(planEntries(plan)).toEqual([{ kind: "task_created", actor: "runner", task_id: id, data: definition }]);
  });
  it("never judges coverage against the workspace's own spec or checks", () => {
    const root = workspace(); mkdirSync(join(root, "docs/spec"), { recursive: true });
    writeFileSync(join(root, "docs/spec/v1.md"), specText);
    mkdirSync(join(root, ".jarvis/checks"));
    writeFileSync(join(root, ".jarvis/checks/ac1.check.json"), JSON.stringify({ name: "ac1", criteria: ["AC1"], cases: [{ id: "main", command: "node src/cli.mjs" }], verify: 'test "$(cat "$JARVIS_OUT/main/code")" = 0 || exit 1\necho "JARVIS-CHECK-COMPLETE $(cat "$JARVIS_COMPLETION_FILE")"', timeoutMs: 1000 }));
    expect(() => (readPlan as (w: string) => unknown)(root)).toThrow(/approved spec/);
  });
  it.each([
    ["duplicate task", [task(), task()]],
    ["missing AC coverage", [{ ...task(), acceptanceCriteria: [] }]],
    ["unknown AC", [{ ...task(), acceptanceCriteria: ["AC2"] }]],
    ["unknown story", [{ ...task(), storyIds: ["S2"] }]],
    ["missing story link", [{ ...task(), storyIds: [] }]],
    ["unknown dependency", [{ ...task(), dependencies: ["T2"] }]],
    ["cycle", [{ ...task(), dependencies: ["T2"] }, { ...task("T2"), dependencies: ["T1"] }]],
    ["self cycle", [{ ...task(), dependencies: ["T1"] }]],
    ["unknown check", [{ ...task(), requiredChecks: ["absent"] }]],
    ["no checks", [{ ...task(), requiredChecks: [] }]],
    ["no review", [{ ...task(), requiredReviews: [] }]],
    ["escape boundary", [{ ...task(), mayTouch: ["../outside"] }]],
    ["absolute boundary", [{ ...task(), mayTouch: ["/tmp/file"] }]],
    ["metadata boundary", [{ ...task(), mayTouch: [".jarvis/notes"] }]],
    ["git boundary", [{ ...task(), mayTouch: [".git/config"] }]],
    ["metadata boundary in another case", [{ ...task(), mayTouch: [".JARVIS/inbox.md"] }]],
    ["git boundary in another case", [{ ...task(), mayTouch: [".Git/hooks/pre-commit"] }]],
    ["invalid task id", [task("T0")]],
    ["task id beyond workspace limit", [task("T" + "1".repeat(64))]],
    ["unknown field", [{ ...task(), passed: true }]],
  ])("rejects %s", (_name, tasks) => { expect(() => readPlan(workspace(tasks), context)).toThrow(); });
  it("rejects an unknown required check even on a task without ACs", () => {
    const tasks = [{ ...task(), requiredChecks: ["absent"], acceptanceCriteria: [], storyIds: [] }, task("T2")];
    expect(() => readPlan(workspace(tasks), context)).toThrow(/unknown required check/);
  });
  it("requires each task's checks to cover its criteria", () => {
    expect(() => readPlan(workspace(), { spec, checks: [{ name: "ac1", criteria: [] }] })).toThrow(/cover/i);
  });
  it.each(["plan", "directory", "workspace"])("rejects a symlinked %s", (where) => {
    const root = workspace(); const other = workspace();
    if (where === "plan") { rmSync(join(root, ".jarvis/plan.json")); symlinkSync(join(other, ".jarvis/plan.json"), join(root, ".jarvis/plan.json")); }
    if (where === "directory") { rmSync(join(root, ".jarvis"), { recursive: true }); symlinkSync(join(other, ".jarvis"), join(root, ".jarvis")); }
    if (where === "workspace") { const link = `${root}-link`; roots.push(link); symlinkSync(root, link); expect(() => readPlan(link, context)).toThrow(); return; }
    expect(() => readPlan(root, context)).toThrow();
  });
  it("rejects oversized and malformed JSON before accepting a plan", () => {
    const root = workspace();
    writeFileSync(join(root, ".jarvis/plan.json"), " ".repeat(262145));
    expect(() => readPlan(root, context)).toThrow(/bound|large|limit/i);
    writeFileSync(join(root, ".jarvis/plan.json"), "{"); expect(() => readPlan(root, context)).toThrow();
  });
  describe("top-level planner notes (decision 113)", () => {
    function planWith(plan: Record<string, unknown>) {
      const root = workspace(); writeFileSync(join(root, ".jarvis/plan.json"), JSON.stringify(plan)); return root;
    }
    const twoTasks = () => [task(), { ...task("T2"), dependencies: ["T1"] }];
    it.each([
      ["a feature title", { feature: "Recruiter outreach" }],
      ["a summary", { summary: "two tasks" }],
      ["a singular note", { note: "keep it small" }],
    ])("still refuses any other top-level key: %s", (_name, extra) => {
      expect(() => readPlan(planWith({ notes: ["fine"], tasks: [task()], ...extra }), context)).toThrow(/Unrecognized key/);
      expect(PlanSchema.safeParse({ tasks: [task()], ...extra }).success).toBe(false);
    });
    it("accepts trimmed notes and gives every task's ledger definition the same notes", () => {
      const plan = readPlan(planWith({ notes: ["  No new dependencies.  ", "Keep the store behind an interface."], tasks: twoTasks() }), context);
      expect(plan.notes).toEqual(["No new dependencies.", "Keep the store behind an interface."]);
      expect(planEntries(plan).map((e) => [e.task_id, (e.data as { planNotes?: unknown }).planNotes])).toEqual([
        ["T1", ["No new dependencies.", "Keep the store behind an interface."]],
        ["T2", ["No new dependencies.", "Keep the store behind an interface."]],
      ]);
    });
    it.each([["no notes", {}], ["an empty notes list", { notes: [] }]])("adds no planNotes for %s", (_name, extra) => {
      const plan = readPlan(planWith({ tasks: twoTasks(), ...extra }), context);
      for (const e of planEntries(plan)) expect(e.data).not.toHaveProperty("planNotes");
    });
    it("accepts notes at the bounds: 32 notes, 2000 characters each after trimming, 16000 in all", () => {
      expect(readPlan(planWith({ notes: Array.from({ length: 32 }, (_, i) => `note ${i}`), tasks: [task()] }), context).notes).toHaveLength(32);
      expect(readPlan(planWith({ notes: [`  ${"x".repeat(2000)}  `], tasks: [task()] }), context).notes).toEqual(["x".repeat(2000)]);
      expect(readPlan(planWith({ notes: Array.from({ length: 8 }, () => "x".repeat(2000)), tasks: [task()] }), context).notes).toHaveLength(8);
    });
    it.each([
      ["33 notes", Array.from({ length: 33 }, (_, i) => `note ${i}`)],
      ["a note over 2000 characters", ["x".repeat(2001)]],
      ["a blank note", ["   "]],
      ["an empty note", [""]],
      ["a non-string note", [42]],
      ["notes over 16000 characters in all", Array.from({ length: 9 }, () => "x".repeat(2000))],
      ["notes as one string", "keep it small"],
    ])("refuses %s", (_name, notes) => {
      expect(() => readPlan(planWith({ notes, tasks: [task()] }), context)).toThrow();
    });
    it("revalidates the notes in planEntries", () => {
      expect(() => planEntries({ notes: ["x".repeat(2001)], tasks: [task()] })).toThrow();
    });
  });
  it("revalidates planEntries instead of trusting typed caller input", () => {
    expect(() => planEntries({ tasks: [{ ...task(), requiredReviews: [] }] })).toThrow();
    expect(PlanSchema.safeParse({ tasks: [] }).success).toBe(false);
    expect(PlanSchema.safeParse({ tasks: [{ ...task(), acceptanceCriteria: [], storyIds: [], requiredChecks: [] }] }).success).toBe(false);
  });
  it.each(["bug", "refactor"] as const)("makes a spec-free %s task with unit checks and the explicit boundary", (type) => {
    const result = triage({ request: type === "bug" ? "fix: citizenship filter is broken" : "Refactor the filter", folder: { empty: false, designMd: false } });
    const plan = singleTaskPlan({ ...result, touches: ["src/filter.ts"] }, "Fix the filter", [{ name: "unit" }]);
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]).toMatchObject({ id: "T1", goal: "Fix the filter", acceptanceCriteria: [], storyIds: [], requiredChecks: ["unit"], requiredReviews: ["code"], mayTouch: ["src/filter.ts"] });
    expect(plan.tasks[0]!.exitCondition).not.toBe("");
  });
  it("requires the installed unit check before constructing a single task", () => {
    expect(() => singleTaskPlan({ type: "bug" }, "Fix", [])).toThrow(/installed.*unit|unit.*installed/i);
    expect(() => singleTaskPlan({ type: "refactor" }, "Fix", [{ name: "ac1" }])).toThrow(/installed.*unit|unit.*installed/i);
    expect(() => (singleTaskPlan as (t: { type: "bug" }, r: string) => unknown)({ type: "bug" }, "Fix")).toThrow(/installed.*unit|unit.*installed/i);
  });
  it("trims and deterministically bounds long requests before validation", () => {
    const request = "  " + "abcd".repeat(5000) + "  ";
    const plan = singleTaskPlan({ type: "bug" }, request, [{ name: "unit" }]);
    expect(plan.tasks[0]!.title).toBe(request.trim().slice(0, 120));
    expect(plan.tasks[0]!.goal).toBe(request.trim().slice(0, 16_000));
    expect(singleTaskPlan({ type: "bug" }, request, [{ name: "unit" }])).toEqual(plan);
  });
  it.each(["", "  ", "\t\n"])("refuses an empty request %j with a clear message", (request) => {
    expect(() => singleTaskPlan({ type: "bug" }, request, [{ name: "unit" }])).toThrow("singleTaskPlan requires a nonempty request");
  });
  it("keeps an explicit empty boundary and rejects non-build triage and unsafe touches", () => {
    expect(singleTaskPlan({ type: "bug", touches: [] }, "Fix", [{ name: "unit" }]).tasks[0]!.mayTouch).toEqual([]);
    expect(singleTaskPlan({ type: "refactor" }, "Refactor", [{ name: "unit" }]).tasks[0]!.mayTouch).toBeUndefined();
    expect(() => singleTaskPlan({ type: "feature" }, "Build", [{ name: "unit" }])).toThrow();
    expect(() => singleTaskPlan({ type: "bug", touches: ["../file"] }, "Fix", [{ name: "unit" }])).toThrow();
  });
});

describe("session-owned plans (onboarding and sweeps)", () => {
  const unitTask = (id = "T1") => ({ id, title: "Split the module", goal: "Split src/big.ts", exitCondition: "Behavior unchanged; unit passes", acceptanceCriteria: [] as string[], storyIds: [] as string[], dependencies: [] as string[], priority: 0, requiredChecks: ["unit"], requiredReviews: ["code"], mayTouch: ["src/big.ts"] });
  function sessionPlan(kind: string, tasks: unknown[]) {
    const root = mkdtempSync("/private/tmp/j-plan-"); roots.push(root);
    mkdirSync(join(root, ".jarvis", kind), { recursive: true });
    writeFileSync(join(root, ".jarvis", kind, "plan.json"), JSON.stringify({ tasks }));
    return root;
  }
  it.each(["onboard", "sweep"] as const)("reads .jarvis/%s/plan.json when asked for it", (kind) => {
    expect(readSessionPlan(sessionPlan(kind, [unitTask()]), kind, [{ name: "unit" }]).tasks.map((t) => t.id)).toEqual(["T1"]);
  });
  it("accepts no other plan kind", () => {
    expect(() => readSessionPlan(sessionPlan("onboard", [unitTask()]), "../onboard" as "onboard", [{ name: "unit" }])).toThrow(/plan kind/);
  });
  it("refuses criteria and stories, which no approved spec backs", () => {
    expect(() => readSessionPlan(sessionPlan("onboard", [{ ...unitTask(), acceptanceCriteria: ["AC1"] }]), "onboard", [{ name: "unit" }])).toThrow(/criteria|stories/);
    expect(() => readSessionPlan(sessionPlan("onboard", [{ ...unitTask(), storyIds: ["S1"] }]), "onboard", [{ name: "unit" }])).toThrow(/criteria|stories/);
  });
  it("refuses checks that aren't installed", () => {
    expect(() => readSessionPlan(sessionPlan("sweep", [{ ...unitTask(), requiredChecks: ["lint"] }]), "sweep", [{ name: "unit" }])).toThrow(/lint/);
  });
  it("refuses an invalid plan file", () => {
    expect(() => readSessionPlan(sessionPlan("sweep", [{ ...unitTask(), id: "X" }]), "sweep", [{ name: "unit" }])).toThrow();
  });
});
