import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { FULL_MODEL_ID, MODELS } from "../config/pins.ts";
import type { EscalationReason, TaskRole, TaskTier } from "./harness.ts";

export type ModelTier = "strong" | "fast" | "cheap";
export type Effort = "low" | "medium" | "high" | "max";
export interface ModelRoute { model: string; effort: Effort }
export interface DecisionRoute { tier2: "strong"; default: ModelTier }
export interface WorkerRoute { start: ModelTier; escalate: "strong" }
export interface RoutingTable {
  tiers: Record<ModelTier, ModelRoute>;
  roles: {
    intake: DecisionRoute;
    spec: DecisionRoute;
    architect: DecisionRoute;
    review: DecisionRoute & { cross_model: "codex" };
    build: WorkerRoute;
    debug: WorkerRoute;
    explore: { start: ModelTier };
  };
  escalate_on: readonly EscalationReason[];
}

/** Architecture §3.9; tier-2 deciding and judging always use the strong tier (decision 24). */
export const DEFAULT_ROUTING = {
  tiers: {
    strong: { model: MODELS.strong, effort: "high" },
    fast: { model: MODELS.fast, effort: "medium" },
    cheap: { model: MODELS.cheap, effort: "low" },
  },
  roles: {
    intake: { tier2: "strong", default: "fast" },
    spec: { tier2: "strong", default: "fast" },
    architect: { tier2: "strong", default: "fast" },
    review: { tier2: "strong", default: "fast", cross_model: "codex" },
    build: { start: "fast", escalate: "strong" },
    debug: { start: "fast", escalate: "strong" },
    explore: { start: "cheap" },
  },
  escalate_on: ["gate_fail", "review_fail"],
} as const satisfies RoutingTable;

const Tier = z.enum(["strong", "fast", "cheap"]);
const Model = z.object({ model: z.string().regex(FULL_MODEL_ID), effort: z.enum(["low", "medium", "high", "max"]) }).strict();
const Decision = z.object({ tier2: z.literal("strong"), default: Tier }).strict();
const Worker = z.object({ start: Tier, escalate: z.literal("strong") }).strict();
const Explore = z.object({ start: Tier }).strict();
const Review = Decision.extend({ cross_model: z.literal("codex") });
const Escalations = z.array(z.enum(["gate_fail", "review_fail"]));
const Routing = z.object({
  tiers: z.object({ strong: Model, fast: Model, cheap: Model }).strict(),
  roles: z.object({ intake: Decision, spec: Decision, architect: Decision, review: Review, build: Worker, debug: Worker, explore: Explore }).strict(),
  escalate_on: Escalations,
}).strict();
const ModelOverride = Model.partial();
const DecisionOverride = Decision.partial();
const WorkerOverride = Worker.partial();
const RoutingOverride = z.object({
  tiers: z.object({ strong: ModelOverride.optional(), fast: ModelOverride.optional(), cheap: ModelOverride.optional() }).strict().optional(),
  roles: z.object({
    intake: DecisionOverride.optional(), spec: DecisionOverride.optional(), architect: DecisionOverride.optional(),
    review: Review.partial().optional(),
    build: WorkerOverride.optional(), debug: WorkerOverride.optional(),
    explore: z.object({ start: Tier.optional() }).strict().optional(),
  }).strict().optional(),
  escalate_on: z.array(z.enum(["gate_fail", "review_fail"])).optional(),
}).strict();

function withOverride<T extends object>(base: T, override: { [K in keyof T]?: T[K] | undefined } | undefined): T {
  const result = { ...base };
  for (const key in override) {
    const value = override[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** Validate and copy a run-start routing snapshot; the task adapter never reads project files. */
export function validateRouting(value: unknown): RoutingTable {
  const parsed = Routing.safeParse(value);
  if (!parsed.success) throw new Error("invalid routing snapshot");
  return parsed.data;
}

const MAX_ROUTING_BYTES = 65_536;

function readRouting(path: string): string | undefined {
  const before = lstatSync(path, { throwIfNoEntry: false });
  if (!before) return undefined;
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_ROUTING_BYTES) throw new Error("routing override must be a regular file of at most 64 KiB, without symlinks");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_ROUTING_BYTES) throw new Error("routing override changed while opening");
    const buffer = Buffer.alloc(MAX_ROUTING_BYTES + 1);
    let count = 0;
    for (;;) {
      const n = readSync(fd, buffer, count, buffer.length - count, null);
      if (n === 0) break;
      count += n;
      if (count > MAX_ROUTING_BYTES) throw new Error("routing override exceeds 64 KiB");
    }
    return buffer.subarray(0, count).toString("utf8");
  } finally { closeSync(fd); }
}

/** Call once at run start on the main checkout or a runner-owned copy, never on a task worktree. */
export function loadRouting(projectRoot: string): RoutingTable {
  const text = readRouting(join(projectRoot, ".jarvis-routing.json"));
  if (text === undefined) return validateRouting(DEFAULT_ROUTING);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("routing override must be valid JSON"); }
  const parsed = RoutingOverride.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid routing override at ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  const o = parsed.data;
  const defaults: RoutingTable = DEFAULT_ROUTING;
  return {
    tiers: {
      strong: withOverride(defaults.tiers.strong, o.tiers?.strong),
      fast: withOverride(defaults.tiers.fast, o.tiers?.fast),
      cheap: withOverride(defaults.tiers.cheap, o.tiers?.cheap),
    },
    roles: {
      intake: withOverride(defaults.roles.intake, o.roles?.intake),
      spec: withOverride(defaults.roles.spec, o.roles?.spec),
      architect: withOverride(defaults.roles.architect, o.roles?.architect),
      review: withOverride(defaults.roles.review, o.roles?.review),
      build: withOverride(defaults.roles.build, o.roles?.build),
      debug: withOverride(defaults.roles.debug, o.roles?.debug),
      explore: withOverride(defaults.roles.explore, o.roles?.explore),
    },
    escalate_on: o.escalate_on ?? [...DEFAULT_ROUTING.escalate_on],
  };
}

export interface TaskRoute extends ModelRoute {
  modelTier: ModelTier;
  /** Exposed for a later reviewer adapter; this module never starts another harness. */
  crossModel?: "codex";
}

export function routeTask(role: TaskRole, tier: TaskTier, failure?: EscalationReason, routing: RoutingTable = DEFAULT_ROUTING): TaskRoute {
  const rule = routing.roles[role];
  let modelTier: ModelTier = "start" in rule ? rule.start : tier === 2 ? rule.tier2 : rule.default;
  if (failure && routing.escalate_on.includes(failure)) {
    if ("escalate" in rule) modelTier = rule.escalate;
    else if ("tier2" in rule) modelTier = rule.tier2;
  }
  return { ...routing.tiers[modelTier], modelTier, ...(role === "review" ? { crossModel: routing.roles.review.cross_model } : {}) };
}
