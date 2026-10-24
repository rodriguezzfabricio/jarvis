import { lstatSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, GENESIS, type LedgerEntry } from "../ledger/ledger.ts";
import type { ModelTier, RoutingTable } from "./routing.ts";
import { parseSessionUsage } from "./usage-log.ts";

/**
 * Routing tuning (decision 24: "the table gets tuned from measured use"). Reads the ledger and
 * proposes changes; it never applies one. Fabricio accepts a proposal by copying its override into
 * `.jarvis-routing.json`, which the runner reads at the next run start. Only a builder role's start
 * tier can move, and only up, so the reviewer, the strong tier and escalate_on stay at routing.ts's floors.
 */

export type TunableRole = "build" | "debug";
const TUNABLE: readonly TunableRole[] = ["build", "debug"];
const STRENGTH: Record<ModelTier, number> = { cheap: 0, fast: 1, strong: 2 };
const STRONGER: Record<ModelTier, ModelTier | undefined> = { cheap: "fast", fast: "strong", strong: undefined };
const TIERS: readonly ModelTier[] = ["cheap", "fast", "strong"];

export interface TierStats {
  role: TunableRole;
  modelTier: ModelTier;
  /** A task's first attempt, not escalated. */
  firstAttempts: number;
  firstPasses: number;
  firstPassRate: number | null;
  /** Later or escalated attempts on this tier. */
  repairAttempts: number;
  repairPasses: number;
  gateFails: number;
  reviewFails: number;
}

export interface RoutingProposal {
  id: string;
  path: `roles.${TunableRole}.start`;
  from: ModelTier;
  to: ModelTier;
  reason: string;
}
export interface RoutingOverrideFragment { roles?: Partial<Record<TunableRole, { start: ModelTier }>> }
export interface ProposalFile {
  version: 1;
  generatedAt: string;
  ledgerHead: string;
  threshold: number;
  minSamples: number;
  stats: TierStats[];
  proposals: RoutingProposal[];
  /** Merge into `.jarvis-routing.json` to accept every proposal; nothing reads this file. */
  override: RoutingOverrideFragment;
  accept: string;
}
export interface TuningOptions {
  /** Propose escalation when the start tier's first-attempt pass rate is strictly below this. */
  threshold?: number;
  minSamples?: number;
  now?: () => number;
}

type Verdict = "pass" | "gate_fail" | "review_fail" | "excluded";
interface Attempt { task: string; id: string; role?: TunableRole; modelTier?: ModelTier; escalated: boolean; gateFail: boolean; reviewFail: boolean; passed: boolean; tampered: boolean }

function verdict(a: Attempt): Verdict {
  if (a.tampered) return "excluded";
  if (a.gateFail) return "gate_fail";
  if (a.reviewFail) return "review_fail";
  return a.passed ? "pass" : "excluded";
}

/** Runner-authored history only; an attempt without a builder session or a verdict is left out. */
export function routingStats(entries: readonly LedgerEntry[]): TierStats[] {
  const attempts = new Map<string, Attempt>();
  const firstOf = new Map<string, string>();
  const get = (task: string, id: string): Attempt => {
    const key = `${task}\u0000${id}`;
    let a = attempts.get(key);
    if (!a) attempts.set(key, a = { task, id, escalated: false, gateFail: false, reviewFail: false, passed: false, tampered: false });
    return a;
  };
  for (const e of entries) {
    if (e.actor !== "runner" || e.task_id === null || e.attempt_id === null) continue;
    const status = (e.data as { status?: unknown; state?: unknown } | null)?.status;
    if (e.kind === "attempt_started") {
      if (!firstOf.has(e.task_id)) firstOf.set(e.task_id, e.attempt_id);
      get(e.task_id, e.attempt_id);
    } else if (e.kind === "session_usage") {
      const d = parseSessionUsage(e.data);
      if (!d || (d.role !== "build" && d.role !== "debug")) continue;
      if (!firstOf.has(e.task_id)) firstOf.set(e.task_id, e.attempt_id);
      const a = get(e.task_id, e.attempt_id);
      a.role = d.role;
      a.modelTier = d.modelTier;
      a.escalated = d.failure !== null;
    } else if (e.kind === "gate_result") {
      if (status === "fail") get(e.task_id, e.attempt_id).gateFail = true;
      if (status === "tampered") get(e.task_id, e.attempt_id).tampered = true;
    } else if (e.kind === "review_result") {
      if (status === "fail") get(e.task_id, e.attempt_id).reviewFail = true;
    } else if (e.kind === "state_reached" && (e.data as { state?: unknown } | null)?.state === "passed") {
      get(e.task_id, e.attempt_id).passed = true;
    }
  }
  const stats = new Map<string, TierStats>();
  for (const a of attempts.values()) {
    const v = verdict(a);
    if (!a.role || !a.modelTier || v === "excluded") continue;
    const key = `${a.role}:${a.modelTier}`;
    let s = stats.get(key);
    if (!s) stats.set(key, s = { role: a.role, modelTier: a.modelTier, firstAttempts: 0, firstPasses: 0, firstPassRate: null, repairAttempts: 0, repairPasses: 0, gateFails: 0, reviewFails: 0 });
    const first = firstOf.get(a.task) === a.id && !a.escalated;
    if (first) { s.firstAttempts++; if (v === "pass") s.firstPasses++; }
    else { s.repairAttempts++; if (v === "pass") s.repairPasses++; }
    if (v === "gate_fail") s.gateFails++;
    if (v === "review_fail") s.reviewFails++;
  }
  for (const s of stats.values()) s.firstPassRate = s.firstAttempts ? s.firstPasses / s.firstAttempts : null;
  return [...stats.values()].sort((a, b) => TUNABLE.indexOf(a.role) - TUNABLE.indexOf(b.role) || TIERS.indexOf(a.modelTier) - TIERS.indexOf(b.modelTier));
}

function overrideFor(proposals: readonly RoutingProposal[]): RoutingOverrideFragment {
  const roles: Partial<Record<TunableRole, { start: ModelTier }>> = {};
  for (const p of proposals) roles[p.path.split(".")[1] as TunableRole] = { start: p.to };
  return proposals.length ? { roles } : {};
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function proposeRouting(entries: readonly LedgerEntry[], routing: RoutingTable, options: TuningOptions = {}): ProposalFile {
  const threshold = options.threshold ?? 0.6;
  const minSamples = options.minSamples ?? 5;
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) throw new Error("threshold must be in (0, 1]");
  if (!Number.isInteger(minSamples) || minSamples < 1) throw new Error("minSamples must be a whole number of at least 1");
  const stats = routingStats(entries);
  const proposals: RoutingProposal[] = [];
  for (const role of TUNABLE) {
    const from = routing.roles[role].start;
    const to = STRONGER[from];
    const s = stats.find((x) => x.role === role && x.modelTier === from);
    if (!to || !s || s.firstPassRate === null || s.firstAttempts < minSamples || s.firstPassRate >= threshold) continue;
    proposals.push({
      id: `${role}-start-${from}-to-${to}`, path: `roles.${role}.start`, from, to,
      reason: `${role} first attempts on ${from} passed ${pct(s.firstPassRate)} of ${s.firstAttempts} tasks, under the ${pct(threshold)} threshold (${s.gateFails} gate and ${s.reviewFails} review failures on ${from}).`,
    });
  }
  assertWithinFloors(proposals, routing);
  return {
    version: 1,
    generatedAt: new Date((options.now ?? Date.now)()).toISOString(),
    ledgerHead: entries.at(-1)?.hash ?? GENESIS,
    threshold, minSamples, stats, proposals,
    override: overrideFor(proposals),
    accept: "Copy override into .jarvis-routing.json in the main checkout (merging with what is there); the runner reads it at the next run start.",
  };
}

/** Only a builder start tier, only from the tier in effect now, only stronger. */
export function assertWithinFloors(proposals: readonly RoutingProposal[], routing: RoutingTable): void {
  for (const p of proposals) {
    const m = /^roles\.(build|debug)\.start$/.exec(p.path);
    if (!m) throw new Error(`routing proposal outside the tunable floor: ${String(p.path)}`);
    const role = m[1] as TunableRole;
    if (p.from !== routing.roles[role].start) throw new Error(`routing proposal ${p.id} starts from a tier not in effect`);
    if (!(p.to in STRENGTH) || STRENGTH[p.to] <= STRENGTH[p.from]) throw new Error(`routing proposal ${p.id} is not an escalation`);
  }
}

const PROPOSALS_FILE = "routing-proposals.json";

/** Writes runnerDir/routing-proposals.json (the runner-owned project folder). Never the routing override. */
export function writeRoutingProposals(runnerDir: string, file: ProposalFile, routing: RoutingTable): string {
  assertWithinFloors(file.proposals, routing);
  if (JSON.stringify(file.override) !== JSON.stringify(overrideFor(file.proposals))) throw new Error("override does not match the proposals");
  const dir = lstatSync(runnerDir, { throwIfNoEntry: false });
  if (!dir?.isDirectory() || dir.isSymbolicLink()) throw new Error("proposal folder must be a real directory");
  const path = join(runnerDir, PROPOSALS_FILE);
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("refusing to write through a symlink");
  const staging = mkdtempSync(join(runnerDir, ".proposals-"));
  try {
    const staged = join(staging, PROPOSALS_FILE);
    atomicWrite(staged, `${JSON.stringify(file, null, 2)}\n`);
    renameSync(staged, path);
  } finally { rmSync(staging, { recursive: true, force: true }); }
  return path;
}

/** A REPORT.md section pointing at the proposal file. */
export function routingProposalLines(file: ProposalFile, path: string): string[] {
  const lines = ["## Routing proposals", ""];
  if (!file.proposals.length) return [...lines, "- None."];
  const clean = (s: string) => s.replace(/[\r\n\u0000-\u001f\u007f]/g, " ").replace(/[<>`*_[\]\\|#]/g, "\\$&");
  lines.push(...file.proposals.map((p) => `- ${p.path.split(".")[1]} start ${p.from} → ${p.to}: ${clean(p.reason)}`));
  lines.push(`- Not applied. To accept, copy the override in ${clean(path)} into .jarvis-routing.json.`);
  return lines;
}
