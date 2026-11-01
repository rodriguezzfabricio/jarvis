import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { z } from "zod";
import { canonical, type Ledger, type LedgerEntry } from "../ledger/ledger.ts";
import { readPlanningFile } from "../runner/checks-author.ts";

/**
 * How plan-review findings are resolved (decision 172, EGM's resolve protocol): the runner validates the
 * architect session's resolution file with no model. A contest needs evidence the reviewer could have read;
 * a fix needs a changed plan; an escalation waits for the user; a decline is for nits only.
 */
export const RESOLUTION_FILE = ".jarvis/plan-review/resolution.json";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
/** The hash the review, the resolution and the gate all name: sha256 of the parsed plan's canonical JSON. */
export function planHashOf(planText: string): string { return sha(canonical(JSON.parse(planText))); }
export function canonicalPlan(planText: string): string { return canonical(JSON.parse(planText)); }

const findingId = z.string().regex(/^(zoom-out|critic|readiness)-[1-9]\d{0,3}$/);
const ResolutionSchema = z.discriminatedUnion("action", [
  z.object({ id: findingId, action: z.literal("contest"), evidence: z.string().trim().min(1).max(600) }).strict(),
  z.object({ id: findingId, action: z.literal("fix") }).strict(),
  z.object({ id: findingId, action: z.literal("escalate"), question: z.string().trim().min(1).max(300) }).strict(),
  z.object({ id: findingId, action: z.literal("decline") }).strict(),
]);
export const ResolutionFileSchema = z.object({ planHash: z.string().regex(/^[a-f0-9]{64}$/), resolutions: z.array(ResolutionSchema).max(500) }).strict();
export type PlanResolution = z.infer<typeof ResolutionSchema>;
type Data = Record<string, unknown>;
const dataOf = (entry: LedgerEntry): Data => entry.data as Data;
interface RecordedFinding { id: string; lens: string; severity: "blocker" | "major" | "nit"; scope: string }
export interface ActiveDecision { id: number; status: { kind: string } }

/** The runner's latest overall record of a review at this plan hash (purpose review), or undefined. */
export function latestPlanReview(entries: readonly LedgerEntry[], planHash: string): LedgerEntry | undefined {
  return entries.filter((e) => e.kind === "plan_review" && e.actor === "runner" && dataOf(e).lens === "overall" && dataOf(e).purpose === "review" && dataOf(e).planHash === planHash).at(-1);
}
function reviewedFindings(entry: LedgerEntry): RecordedFinding[] {
  const findings = dataOf(entry).findings;
  return Array.isArray(findings) ? findings.filter((f): f is RecordedFinding => typeof f === "object" && f !== null && typeof (f as Data).id === "string" && ["blocker", "major", "nit"].includes((f as Data).severity as string)) : [];
}
function after(entries: readonly LedgerEntry[], review: LedgerEntry, purpose: string, planHash: string): LedgerEntry[] {
  return entries.filter((e) => e.seq > review.seq && e.kind === "plan_review" && e.actor === "runner" && dataOf(e).purpose === purpose && dataOf(e).planHash === planHash);
}

/** Evidence a contest may cite: an active decision id, or an existing repo-relative file, optionally with a line the file has. */
export function contestEvidence(repoPath: string, evidence: string, register: readonly ActiveDecision[]): "decision" | "file" {
  const decision = /^D([1-9]\d*)$/.exec(evidence.trim());
  if (decision) {
    if (!register.some((d) => d.id === Number(decision[1]) && d.status.kind === "active")) throw new Error(`contest evidence ${evidence} is not an active decision`);
    return "decision";
  }
  const match = /^([^:\u0000]+?)(?::([1-9]\d*))?$/.exec(evidence.trim());
  if (!match) throw new Error(`contest evidence must be a repo-relative file, file:line or D<n>: ${evidence}`);
  const file = match[1]!, line = match[2] === undefined ? undefined : Number(match[2]);
  if (isAbsolute(file) || normalize(file) !== file || file.split("/").some((s) => s === "" || s === "." || s === ".." || s === ".git" || s === ".jarvis")) throw new Error(`contest evidence must be a plain repo-relative path: ${evidence}`);
  const root = realpathSync(repoPath), path = resolve(root, file);
  if (!path.startsWith(`${root}/`) || !existsSync(path) || !lstatSync(path).isFile()) throw new Error(`contest evidence names no file in the repo: ${evidence}`);
  if (line !== undefined && line > readFileSync(path, "utf8").split("\n").length) throw new Error(`contest evidence names a line the file does not have: ${evidence}`);
  return "file";
}

/**
 * Validates `.jarvis/plan-review/resolution.json` against the latest review at its plan hash and records it.
 * Every blocker and major has exactly one resolution; a nit may only be fixed or declined; a blocker is
 * contested only with a decision; a fix needs the plan to have changed; an escalation records its question.
 * Any violation throws and appends nothing.
 */
export function resolvePlanReview(repoPath: string, ledger: Ledger, register: readonly ActiveDecision[]): { entries: LedgerEntry[]; escalations: string[] } {
  const file = ResolutionFileSchema.parse(JSON.parse(readPlanningFile(repoPath, RESOLUTION_FILE)));
  const entries = ledger.entries();
  const review = latestPlanReview(entries, file.planHash);
  if (!review) throw new Error(`no plan review at hash ${file.planHash}: run jarvis plan review`);
  if (dataOf(review).counts !== true) throw new Error("the plan review at this hash does not count (no passing negative control); nothing to resolve");
  const findings = new Map(reviewedFindings(review).map((f) => [f.id, f]));
  const seen = new Set<string>();
  for (const r of file.resolutions) {
    const finding = findings.get(r.id);
    if (!finding) throw new Error(`resolution names no finding of this review: ${r.id}`);
    if (seen.has(r.id)) throw new Error(`finding ${r.id} has more than one resolution`);
    seen.add(r.id);
    if (finding.severity === "nit" && r.action !== "decline" && r.action !== "fix") throw new Error(`a nit (${r.id}) may only be fixed or declined`);
    if (finding.severity !== "nit" && r.action === "decline") throw new Error(`${r.id} is a ${finding.severity}: decline is for nits only; contest it with evidence, fix the plan, or escalate`);
    if (r.action === "contest") {
      if (/intentional|on purpose|by design/i.test(r.evidence) && !/^D[1-9]\d*$/.test(r.evidence.trim())) throw new Error(`${r.id}: "this was intentional" is not evidence; cite a file, file:line or D<n>`);
      const kind = contestEvidence(repoPath, r.evidence, register);
      if (finding.severity === "blocker" && kind !== "decision") throw new Error(`${r.id} is a blocker: it may be contested only with an active decision id`);
    }
  }
  const unresolved = [...findings.values()].filter((f) => f.severity !== "nit" && !seen.has(f.id)).map((f) => f.id);
  if (unresolved.length) throw new Error(`every blocker and major needs a resolution; missing: ${unresolved.join(", ")}`);
  if (file.resolutions.some((r) => r.action === "fix")) {
    const current = planHashOf(readPlanningFile(repoPath, ".jarvis/plan.json"));
    if (current === file.planHash) throw new Error("a fix resolution needs a changed .jarvis/plan.json; revise the plan, then run jarvis plan review again");
  }
  const appended: LedgerEntry[] = [], escalations: string[] = [];
  appended.push(ledger.append({ kind: "plan_review", actor: "runner", task_id: null, data: { purpose: "resolution", planHash: file.planHash, reviewSeq: review.seq, resolutions: file.resolutions } }));
  for (const r of file.resolutions) if (r.action === "escalate") {
    appended.push(ledger.append({ kind: "plan_review", actor: "runner", task_id: null, data: { purpose: "escalation", planHash: file.planHash, id: r.id, question: r.question } }));
    escalations.push(r.id);
  }
  return { entries: appended, escalations };
}

/** The user's answer to an open escalation, typed in the terminal: user authority, recorded once. */
export function acceptEscalation(ledger: Ledger, id: string, answer: string): LedgerEntry {
  const text = answer.trim();
  if (!text || text.length > 2000) throw new Error("--answer needs 1 to 2000 characters");
  const entries = ledger.entries();
  const open = entries.filter((e) => e.kind === "plan_review" && dataOf(e).purpose === "escalation" && dataOf(e).id === id).at(-1);
  if (!open) throw new Error(`no escalation ${id}`);
  if (entries.some((e) => e.seq > open.seq && e.kind === "plan_review" && dataOf(e).purpose === "escalation_answer" && dataOf(e).id === id)) throw new Error(`escalation ${id} is already answered`);
  return ledger.append({ kind: "plan_review", actor: "runner", task_id: null, data: { purpose: "escalation_answer", planHash: dataOf(open).planHash, id, question: dataOf(open).question, answer: text, by: "user", source: "terminal" } });
}

/**
 * Whether `jarvis run` may build this plan (decision 170's gate): the latest counted review at its hash passed,
 * or every blocker and major it found has a later resolution and no escalation is still open.
 */
export function planReviewStatus(entries: readonly LedgerEntry[], planHash: string): { ok: true } | { ok: false; reason: string } {
  const review = latestPlanReview(entries, planHash);
  if (!review) return { ok: false, reason: `the plan has no Goldfish review at hash ${planHash}: run jarvis plan review` };
  const data = dataOf(review);
  if (data.counts !== true) return { ok: false, reason: "the plan review does not count: its reviewer has no passing negative control for this policy" };
  if (data.verdict === "pass") return { ok: true };
  if (data.verdict !== "resolve" && data.verdict !== "fail") return { ok: false, reason: `the plan review ended in ${String(data.verdict)}: run jarvis plan review again` };
  const resolutions = after(entries, review, "resolution", planHash);
  const resolved = new Set(resolutions.flatMap((e) => (dataOf(e).resolutions as PlanResolution[] | undefined ?? []).map((r) => r.id)));
  const open = reviewedFindings(review).filter((f) => f.severity !== "nit" && !resolved.has(f.id)).map((f) => f.id);
  if (open.length) return { ok: false, reason: `the plan review found blockers or majors without a resolution: ${open.join(", ")}; run jarvis plan resolve` };
  const answered = new Set(after(entries, review, "escalation_answer", planHash).map((e) => dataOf(e).id));
  const waiting = after(entries, review, "escalation", planHash).map((e) => dataOf(e).id as string).filter((id) => !answered.has(id));
  if (waiting.length) return { ok: false, reason: `escalations wait for the user: ${waiting.join(", ")}; answer each with jarvis plan accept <id> --answer "<text>"` };
  return { ok: true };
}

export function planFileHash(repoPath: string): string { return planHashOf(readPlanningFile(repoPath, join(".jarvis", "plan.json"))); }
