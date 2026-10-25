import { z } from "zod";
import type { AppendInput } from "../ledger/ledger.ts";
import type { Spec } from "../spec/index.ts";
import type { Triage } from "../triage/triage.ts";
import { readPlanningFile } from "./checks-author.ts";

const text = z.string().trim().min(1).max(16_000);
const taskId = z.string().max(64).regex(/^T[1-9]\d*$/);
const acId = z.string().regex(/^AC[1-9]\d*$/);
const storyId = z.string().regex(/^S[1-9]\d*$/);
const checkName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const boundary = z.string().min(1).max(1000).refine((p) => !/[\\\x00-\x1f\x7f:*?\[\]{}]/.test(p)
  && p.split("/").every((s) => s !== "" && s !== "." && s !== ".." && s.toLowerCase() !== ".git" && s.toLowerCase() !== ".jarvis"), "mayTouch must contain plain repo-relative paths outside runner metadata");
const unique = <T extends z.ZodType<string>>(schema: T) => z.array(schema).max(1000).refine((items) => new Set(items).size === items.length, "duplicate references");
const Task = z.object({
  id: taskId, title: text, goal: text, exitCondition: text,
  acceptanceCriteria: unique(acId), storyIds: unique(storyId), dependencies: unique(taskId), priority: z.number().finite(),
  requiredChecks: z.array(checkName).min(1).max(256), requiredReviews: z.array(checkName).min(1).max(32),
  mayTouch: z.array(boundary).max(1000).optional(),
}).strict();

export const PlanSchema = z.object({ tasks: z.array(Task).min(1).max(1000) }).strict().superRefine((plan, ctx) => {
  const tasks = new Map(plan.tasks.map((task) => [task.id, task]));
  if (tasks.size !== plan.tasks.length) ctx.addIssue({ code: "custom", message: "duplicate task ids" });
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) { ctx.addIssue({ code: "custom", message: "dependency cycle" }); return; }
    if (visited.has(id)) return;
    const task = tasks.get(id);
    if (!task) { ctx.addIssue({ code: "custom", message: `unknown dependency: ${id}` }); return; }
    visiting.add(id);
    for (const dep of task.dependencies) visit(dep);
    visiting.delete(id); visited.add(id);
  };
  for (const id of tasks.keys()) visit(id);
});
export type PlanTask = z.infer<typeof Task>;
export type Plan = z.infer<typeof PlanSchema>;
export interface PlanContext {
  spec: Pick<Spec, "criteria" | "stories">;
  checks: readonly { name: string; criteria: readonly string[] }[];
}
export type SingleTaskTriage = Pick<Triage, "type"> & { touches?: readonly string[] };

function validateCoverage(plan: Plan, context: PlanContext): void {
  const criteria = new Map(context.spec.criteria.map((c) => [c.id, c]));
  const stories = new Set(context.spec.stories.map((s) => s.id));
  const checks = new Map(context.checks.map((c) => [c.name, c]));
  if (checks.size !== context.checks.length) throw new Error("duplicate available check names");
  const covered = new Set<string>();
  for (const task of plan.tasks) {
    for (const id of task.storyIds) if (!stories.has(id)) throw new Error(`unknown story: ${id}`);
    for (const name of task.requiredChecks) if (!checks.has(name)) throw new Error(`unknown required check: ${name}`);
    for (const id of task.acceptanceCriteria) {
      const criterion = criteria.get(id);
      if (!criterion) throw new Error(`unknown acceptance criterion: ${id}`);
      if (!task.storyIds.includes(criterion.storyId)) throw new Error(`missing story link for ${id}`);
      if (!task.requiredChecks.some((name) => checks.get(name)!.criteria.includes(id))) throw new Error(`task checks do not cover ${id}`);
      covered.add(id);
    }
  }
  for (const id of criteria.keys()) if (!covered.has(id)) throw new Error(`plan does not cover ${id}`);
}

/**
 * Reads planner output after its session ends. Coverage is judged only against the runner's copy of the
 * approved spec and the installed checks: the workspace's own spec and checks are session-writable.
 */
export function readPlan(workspace: string, context: PlanContext): Plan {
  if (!context) throw new Error("readPlan needs the runner's approved spec and installed checks");
  const plan = PlanSchema.parse(JSON.parse(readPlanningFile(workspace, ".jarvis/plan.json")));
  validateCoverage(plan, context);
  return plan;
}

/** Session-owned plans the runner reads only when `jarvis run --plan <kind>` names them. */
export const SESSION_PLAN_KINDS = ["onboard", "sweep"] as const;
export type SessionPlanKind = (typeof SESSION_PLAN_KINDS)[number];

/**
 * `.jarvis/onboard/plan.json` (onboarding archaeology) or `.jarvis/sweep/plan.json`: written by an
 * interactive session, so read only on an explicit request, with the same no-follow bounded reader.
 * No approved spec backs them, so their tasks carry no criteria or stories, and every check they
 * require must be installed (the runner's copy, never the workspace's).
 */
export function readSessionPlan(repo: string, kind: SessionPlanKind, checks: readonly { name: string }[]): Plan {
  if (!(SESSION_PLAN_KINDS as readonly string[]).includes(kind)) throw new Error(`unknown plan kind: ${String(kind)}`);
  const plan = PlanSchema.parse(JSON.parse(readPlanningFile(repo, `.jarvis/${kind}/plan.json`)));
  const installed = new Set(checks.map((c) => c.name));
  for (const task of plan.tasks) {
    if (task.acceptanceCriteria.length || task.storyIds.length) throw new Error(`${task.id}: a ${kind} plan has no acceptance criteria or stories`);
    for (const name of task.requiredChecks) if (!installed.has(name)) throw new Error(`${task.id}: unknown required check: ${name}`);
  }
  return plan;
}

export function planEntries(plan: Plan): AppendInput[] {
  return PlanSchema.parse(plan).tasks.map(({ id, ...definition }) => ({ kind: "task_created", actor: "runner", task_id: id, data: definition }));
}

/**
 * A bug's exit condition, which the builder reads and the reviewer checks as its criterion (decision 114):
 * one cause usually has several triggers, and a fix for the first one found leaves the report open.
 */
export const BUG_EXIT_CONDITION = "The reported symptom is reproduced and its root cause is fixed on every path that produces it (every caller, input form, configuration or entrypoint the report covers), and the unit check and code review pass.";

/** Risk tier never changes a bug/refactor into a spec or architecture pipeline (decision 89). */
export function singleTaskPlan(triage: SingleTaskTriage, request: string, checks: readonly { name: string }[]): Plan {
  if (triage.type !== "bug" && triage.type !== "refactor") throw new Error("singleTaskPlan requires bug or refactor triage");
  if (!checks?.some((check) => check.name === "unit")) throw new Error("singleTaskPlan requires an installed unit check");
  const goal = request.trim().slice(0, 16_000);
  if (!goal) throw new Error("singleTaskPlan requires a nonempty request");
  return PlanSchema.parse({ tasks: [{
    id: "T1", title: goal.slice(0, 120), goal,
    exitCondition: triage.type === "bug" ? BUG_EXIT_CONDITION : "Pinned behavior remains unchanged and the unit check and code review pass.",
    acceptanceCriteria: [], storyIds: [], dependencies: [], priority: 0, requiredChecks: ["unit"], requiredReviews: ["code"],
    ...(triage.touches !== undefined ? { mayTouch: [...triage.touches] } : {}),
  }] });
}
