import { z } from "zod";
import { FULL_MODEL_ID } from "../config/pins.ts";
import type { AppendInput, Ledger, LedgerEntry } from "../ledger/ledger.ts";
import type { EscalationReason, SessionUsage, TaskOutcome, TaskRole, TaskTier } from "./harness.ts";
import type { ModelTier, TaskRoute } from "./routing.ts";

/**
 * Cost and usage log (decisions 26, 42, 62): one runner `session_usage` entry per session, and a
 * per-run summary for REPORT.md. Figures are as the harness reported them, range-checked here and
 * again on every read, so a bad value is shown as unknown, never as a number.
 */

/** Beyond these a figure is a parsing fault, not a measurement. */
export const USAGE_LIMITS = { tokens: 10_000_000_000, costUsd: 10_000, turns: 1_000_000, durationMs: 7 * 24 * 3_600_000, utilization: 10 } as const;
/** Decision 42: the report says so when a run used at least this share of a usage window. */
export const MOST_OF_A_WINDOW = 0.5;

export type RoleGroup = "builder" | "reviewer" | "planner" | "explorer";
export const ROLE_GROUPS: Record<TaskRole, RoleGroup> = {
  build: "builder", debug: "builder", review: "reviewer", intake: "planner", spec: "planner", architect: "planner", explore: "explorer",
};
const GROUP_ORDER: readonly RoleGroup[] = ["builder", "reviewer", "planner", "explorer"];
const ROLES = ["intake", "spec", "architect", "review", "build", "debug", "explore"] as const;
const STATUSES = ["finished", "refused", "error", "timeout", "usage-limited"] as const;

const text = z.string().min(1).max(256);
const count = z.number().int().min(0).max(USAGE_LIMITS.tokens).nullable();
const utilization = z.number().min(0).max(USAGE_LIMITS.utilization);
const windowName = /^[a-z0-9_]{1,32}$/;
const sessionData = z.object({
  runId: text,
  role: z.enum(ROLES),
  tier: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  modelTier: z.enum(["strong", "fast", "cheap"]),
  model: z.string().regex(FULL_MODEL_ID),
  reportedModel: z.string().regex(FULL_MODEL_ID).nullable(),
  failure: z.enum(["gate_fail", "review_fail"]).nullable(),
  status: z.enum(STATUSES),
  tokens: z.object({ input: count, output: count, cacheRead: count, cacheWrite: count }).strict(),
  costUsd: z.number().min(0).max(USAGE_LIMITS.costUsd).nullable(),
  durationMs: z.number().min(0).max(USAGE_LIMITS.durationMs).nullable(),
  turns: z.number().int().min(0).max(USAGE_LIMITS.turns).nullable(),
  complete: z.boolean(),
  windows: z.record(z.string().regex(windowName), z.object({ before: utilization, after: utilization, resetsAt: z.number().finite().nullable() }).strict()),
  problems: z.array(z.string().max(200)).max(32),
}).strict();
export type SessionUsageData = z.infer<typeof sessionData>;

/** Validated session_usage data, or undefined; ledger data is re-checked on every read. */
export function parseSessionUsage(data: unknown): SessionUsageData | undefined {
  const parsed = sessionData.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}

export interface SessionUsageInput {
  runId: string;
  taskId: string;
  attemptId: string;
  role: TaskRole;
  tier: TaskTier;
  route: Pick<TaskRoute, "model" | "modelTier">;
  failure?: EscalationReason;
  outcome: TaskOutcome;
}

function measured(name: string, value: number | undefined, max: number, integer: boolean, problems: string[]): number | null {
  if (value === undefined) { problems.push(`missing ${name}`); return null; }
  if (!Number.isFinite(value) || value < 0 || value > max || (integer && !Number.isInteger(value))) { problems.push(`implausible ${name}`); return null; }
  return value;
}

/** First and last utilization each window reported during the session (decision 62: before and after). */
function windowsOf(outcome: TaskOutcome): SessionUsageData["windows"] {
  const windows: SessionUsageData["windows"] = {};
  for (const sample of outcome.usage) {
    for (const [name, w] of Object.entries(sample.windows)) {
      if (!windowName.test(name) || !utilization.safeParse(w.utilization).success) continue;
      const resetsAt = typeof w.resetsAt === "number" && Number.isFinite(w.resetsAt) ? w.resetsAt : null;
      const seen = windows[name];
      windows[name] = seen ? { ...seen, after: w.utilization, resetsAt } : { before: w.utilization, after: w.utilization, resetsAt };
    }
  }
  return windows;
}

/** Throws only on caller errors (ids, role, an alias model); bad reported figures become null. */
export function buildSessionUsageEntry(input: SessionUsageInput): AppendInput {
  text.parse(input.taskId);
  text.parse(input.attemptId);
  const problems: string[] = [];
  const reported: Partial<SessionUsage> = input.outcome.sessionUsage ?? {};
  if (!input.outcome.sessionUsage) problems.push("no usage reported");
  else if (!reported.complete) problems.push("no final result: figures are a lower bound");
  let reportedModel: string | null = null;
  if (typeof reported.reportedModel === "string") {
    if (FULL_MODEL_ID.test(reported.reportedModel)) reportedModel = reported.reportedModel;
    else problems.push("unrecognized reportedModel");
  }
  if (reportedModel !== null && reportedModel !== input.route.model) problems.push("reported model differs from the route");
  const data: SessionUsageData = {
    runId: input.runId,
    role: input.role,
    tier: input.tier,
    modelTier: input.route.modelTier,
    model: input.route.model,
    reportedModel,
    failure: input.failure ?? null,
    status: input.outcome.status,
    tokens: {
      input: measured("inputTokens", reported.inputTokens, USAGE_LIMITS.tokens, true, problems),
      output: measured("outputTokens", reported.outputTokens, USAGE_LIMITS.tokens, true, problems),
      cacheRead: measured("cacheReadTokens", reported.cacheReadTokens, USAGE_LIMITS.tokens, true, problems),
      cacheWrite: measured("cacheWriteTokens", reported.cacheWriteTokens, USAGE_LIMITS.tokens, true, problems),
    },
    costUsd: measured("costUsd", reported.costUsd, USAGE_LIMITS.costUsd, false, problems),
    durationMs: measured("durationMs", input.outcome.durationMs, USAGE_LIMITS.durationMs, false, problems),
    turns: measured("turns", reported.turns, USAGE_LIMITS.turns, true, problems),
    complete: reported.complete === true,
    windows: windowsOf(input.outcome),
    problems,
  };
  return { kind: "session_usage", actor: "runner", task_id: input.taskId, attempt_id: input.attemptId, data: sessionData.parse(data) };
}

export type RecordResult = { recorded: true } | { recorded: false; reason: string };

/** A usage-log failure never fails a run; a refused session started nothing and isn't logged. */
export function recordSessionUsage(ledger: Pick<Ledger, "append">, input: SessionUsageInput): RecordResult {
  if (input.outcome.status === "refused") return { recorded: false, reason: "session not started" };
  try {
    ledger.append(buildSessionUsageEntry(input));
    return { recorded: true };
  } catch (e) {
    return { recorded: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export interface UsageTotals {
  sessions: number;
  /** Sessions without a final result: their figures are lower bounds. */
  incomplete: number;
  /** Sessions with at least one unknown figure. */
  unknown: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  durationMs: number;
  turns: number;
}
export interface UsageRow { key: string; totals: UsageTotals }
export interface WindowUse { key: string; consumed: number; peak: number; first: number; last: number }
export interface UsageSummary {
  runId: string | null;
  total: UsageTotals;
  byTask: UsageRow[];
  byModel: UsageRow[];
  byRole: UsageRow[];
  windows: WindowUse[];
  acceptedTasks: number;
  /** Reported cost over accepted tasks; complete is false when any session's cost is unknown. */
  costPerAccepted: { usd: number; complete: boolean } | null;
  /** Session entries that failed validation. */
  skipped: number;
}

const zero = (): UsageTotals => ({ sessions: 0, incomplete: 0, unknown: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, durationMs: 0, turns: 0 });

function add(t: UsageTotals, d: SessionUsageData): void {
  t.sessions++;
  if (!d.complete) t.incomplete++;
  const figures = [d.tokens.input, d.tokens.output, d.tokens.cacheRead, d.tokens.cacheWrite, d.costUsd, d.durationMs, d.turns];
  if (figures.some((v) => v === null)) t.unknown++;
  t.inputTokens += d.tokens.input ?? 0;
  t.outputTokens += d.tokens.output ?? 0;
  t.cacheReadTokens += d.tokens.cacheRead ?? 0;
  t.cacheWriteTokens += d.tokens.cacheWrite ?? 0;
  t.costUsd += d.costUsd ?? 0;
  t.durationMs += d.durationMs ?? 0;
  t.turns += d.turns ?? 0;
}

function rows(map: Map<string, UsageTotals>, order?: readonly string[]): UsageRow[] {
  const keys = [...map.keys()].sort((a, b) => (order ? order.indexOf(a) - order.indexOf(b) : a < b ? -1 : a > b ? 1 : 0));
  return keys.map((key) => ({ key, totals: map.get(key)! }));
}

function bump(map: Map<string, UsageTotals>, key: string, d: SessionUsageData): void {
  let t = map.get(key);
  if (!t) map.set(key, t = zero());
  add(t, d);
}

/** The latest runner run_started's id, or null when the ledger has none. */
export function latestRunId(entries: readonly LedgerEntry[]): string | null {
  const run = entries.filter((e) => e.actor === "runner" && e.kind === "run_started").at(-1);
  const id = (run?.data as { runId?: unknown } | null | undefined)?.runId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Window use across concurrent sessions: within one reset period the window only grows, so its use
 * is the highest reading minus the lowest. Periods are told apart by their reset time.
 */
function windowUse(sessions: readonly SessionUsageData[]): WindowUse[] {
  const periods = new Map<string, Map<string, number[]>>();
  for (const d of sessions) {
    for (const [name, w] of Object.entries(d.windows)) {
      let byReset = periods.get(name);
      if (!byReset) periods.set(name, byReset = new Map());
      const key = String(w.resetsAt);
      byReset.set(key, [...(byReset.get(key) ?? []), w.before, w.after]);
    }
  }
  return [...periods.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, byReset]) => {
    const all = [...byReset.values()];
    const consumed = all.reduce((sum, points) => sum + Math.max(...points) - Math.min(...points), 0);
    return { key, consumed, peak: Math.max(...all.flat()), first: all[0]![0]!, last: all.at(-1)!.at(-1)! };
  });
}

export interface SummaryOptions {
  /** The run to summarize; omitted means the latest run, null means the whole ledger. */
  runId?: string | null;
}

export function summarizeUsage(entries: readonly LedgerEntry[], options: SummaryOptions = {}): UsageSummary {
  const runId = options.runId === undefined ? latestRunId(entries) : options.runId;
  const total = zero();
  const byTask = new Map<string, UsageTotals>();
  const byModel = new Map<string, UsageTotals>();
  const byRole = new Map<string, UsageTotals>();
  const sessions: SessionUsageData[] = [];
  const tasks = new Set<string>();
  let skipped = 0;
  for (const e of entries) {
    if (e.kind !== "session_usage" || e.actor !== "runner" || e.task_id === null) continue;
    const d = parseSessionUsage(e.data);
    if (!d) { skipped++; continue; }
    if (runId !== null && d.runId !== runId) continue;
    sessions.push(d);
    tasks.add(e.task_id);
    add(total, d);
    bump(byTask, e.task_id, d);
    bump(byModel, d.model, d);
    bump(byRole, ROLE_GROUPS[d.role], d);
  }
  const accepted = new Set(entries.filter((e) => e.actor === "runner" && e.kind === "state_reached" && e.task_id !== null && tasks.has(e.task_id)
    && (e.data as { state?: unknown } | null)?.state === "passed").map((e) => e.task_id));
  const costKnown = sessions.every((d) => d.costUsd !== null);
  return {
    runId,
    total,
    byTask: rows(byTask),
    byModel: rows(byModel),
    byRole: rows(byRole, GROUP_ORDER),
    windows: windowUse(sessions),
    acceptedTasks: accepted.size,
    costPerAccepted: accepted.size ? { usd: total.costUsd / accepted.size, complete: costKnown } : null,
    skipped,
  };
}

const esc = (value: unknown): string => String(value ?? "").replace(/[\r\n\u0000-\u001f\u007f]/g, " ").replace(/[<>`*_[\]\\|#]/g, "\\$&");

export function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
}
const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;

function table(title: string, list: readonly UsageRow[], label: (key: string) => string): string[] {
  if (!list.length) return [];
  return [
    "", `### ${title}`, "",
    "| | Sessions | Input | Output | Cache read | Cache write | Reported cost | Time |",
    "|---|---|---|---|---|---|---|---|",
    ...list.map(({ key, totals: t }) => `| ${esc(label(key))} | ${t.sessions} | ${formatTokens(t.inputTokens)} | ${formatTokens(t.outputTokens)} | ${formatTokens(t.cacheReadTokens)} | ${formatTokens(t.cacheWriteTokens)} | ${usd(t.costUsd)}${t.unknown ? " (some unknown)" : ""} | ${formatDuration(t.durationMs)} |`),
  ];
}

/** The REPORT.md section for report.ts. Window names are already limited to [a-z0-9_]. */
export function usageReportLines(entries: readonly LedgerEntry[], options: SummaryOptions = {}): string[] {
  const s = summarizeUsage(entries, options);
  const lines = ["## Usage", ""];
  if (!s.total.sessions) return [...lines, "- No sessions recorded."];
  const t = s.total;
  lines.push(`- ${s.runId === null ? "All runs" : `Run ${esc(s.runId)}`}: ${t.sessions} sessions, ${formatDuration(t.durationMs)} of session time, ${t.turns} turns.`);
  lines.push(`- Tokens: ${formatTokens(t.inputTokens)} input, ${formatTokens(t.outputTokens)} output, ${formatTokens(t.cacheReadTokens)} cache read, ${formatTokens(t.cacheWriteTokens)} cache write.`);
  lines.push(`- Reported cost ${usd(t.costUsd)} (API-equivalent, as Claude Code reports it; not billed on a subscription).`);
  if (s.costPerAccepted) lines.push(`- Accepted tasks: ${s.acceptedTasks}; reported cost per accepted task ${s.costPerAccepted.complete ? "" : "at least "}${usd(s.costPerAccepted.usd)}.`);
  if (t.unknown || t.incomplete) lines.push(`- ${t.unknown} sessions have unknown figures and ${t.incomplete} ended without a final result; totals are lower bounds.`);
  if (s.skipped) lines.push(`- ${s.skipped} usage entries failed validation and are left out.`);
  if (s.windows.length) lines.push(`- Windows: ${s.windows.map((w) => `${w.key} ${pct(w.first)} → ${pct(w.last)} (peak ${pct(w.peak)}, used ${pct(w.consumed)})`).join("; ")}.`);
  for (const w of s.windows) if (w.consumed >= MOST_OF_A_WINDOW) lines.push(`- Warning: ${w.key} used ${pct(w.consumed)} in this run, most of a window (decision 42).`);
  const groupLabel = (k: string) => k.charAt(0).toUpperCase() + k.slice(1);
  lines.push(...table("By role", s.byRole, groupLabel), ...table("By model", s.byModel, (k) => k), ...table("By task", s.byTask, (k) => k));
  return lines;
}
