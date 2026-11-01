import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import { checkTrustedDir, readNoFollow, writePrivateAtomic } from "../config/private-file.ts";
import { safeGit } from "../eval/git.ts";
import type { Ledger, LedgerEntry } from "../ledger/ledger.ts";
import type { TaskTier } from "../runner/harness.ts";
import { routeTask } from "../runner/routing.ts";
import { calibrationEntries } from "./design-calibration.ts";
import { buildPlanPrompt, COMMON, LENS_TEXT, PLAN_LENS_VERSION, STANDARDS } from "./plan-lenses.ts";
import { evaluatePlanVerdict, PLAN_LENSES, type PlanFinding, type PlanLens, type PlanLensVerdict } from "./plan-verdict.ts";
import { redactReviewText } from "./redaction.ts";
import { validateReviewRouting, type ReviewRouting } from "./routing.ts";
import type { Reviewer, ReviewerOutput } from "./types.ts";
import { checkoutHash, type ReviewGit } from "./workspace.ts";

const sha = (raw: string | Buffer) => createHash("sha256").update(raw).digest("hex");
/** A calibration counts only for this exact policy text and model (decision 56's rule, decision 170): any change needs a new negative control. */
export const PLAN_POLICY_HASH = sha(JSON.stringify({ version: PLAN_LENS_VERSION, common: COMMON, lenses: LENS_TEXT, standards: STANDARDS }));
/** The scopes the bad fixture plants (tests/fixtures/plan-review/bad): a counting bad-fixture control must name all three. */
export const PLANTED_SCOPES = ["T2", "T3", "D3"] as const;
export type PlanFixture = "bad" | "good";
/** What the reviewer must not see: the author's reasoning (decision 170; harness-assumptions: context and tool isolation, not filesystem isolation). */
export const AUTHOR_ONLY_PATHS = ["docs/intake", "docs/research", ".jarvis/notes", ".jarvis/intake", ".jarvis/mockups"] as const;
export const PLAN_FINDINGS_FILE = ".jarvis/plan-review/findings.json";
const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

export interface PlanReviewMaterial {
  repoPath: string;
  /** The run branch head: the committed code the plan is judged against. */
  revision: string;
  /** Canonical JSON of the parsed plan and its sha256. */
  plan: string; planHash: string;
  /** Runner-owned snapshots from the run branch, never the workspace. */
  spec: string; decisions: string;
  /** The approved protected checks (the runner's store), copied into the checkout at `checksRoot`. */
  checksSource: string;
  checksRoot: string;
  tier: TaskTier;
}
export interface PlanReviewServiceOptions {
  ledger: Ledger; projectDir: string; workRoot: string; routing: ReviewRouting;
  claude: Reviewer; home?: string; git?: ReviewGit; timeoutMs?: number; maxTurns?: number;
  /** Hashes of this policy's calibration entries (bad-plan fail, good-plan pass); none means verdicts are errors. */
  calibration?: PlanCalibration;
  /** Runner home holding the shared control record, never a project checkout. */
  jarvisHome?: string;
}
export type PlanReviewVerdict = "pass" | "resolve" | "fail" | "error";
export type ReviewedPlanFinding = PlanFinding & { lens: PlanLens; id: string };
export interface PlanReviewResult { verdict: PlanReviewVerdict; counts: boolean; entries: LedgerEntry[]; findings: ReviewedPlanFinding[]; error?: string }
export interface PlanReviewService { review(material: PlanReviewMaterial, calibration?: { fixture: PlanFixture }): Promise<PlanReviewResult> }

export interface PlanCalibration { bad: string; good: string }
const hash64 = z.string().regex(/^[a-f0-9]{64}$/);
const RecordSchema = z.object({ version: z.literal(1), model: z.string(), policyHash: hash64, ledgerFile: z.string(), bad: hash64, good: hash64 }).strict();
export type PlanCalibrationRecord = z.infer<typeof RecordSchema>;
const RECORD_FILE = "plan-calibration.json";

export function planModel(routing: ReviewRouting): string { return validateReviewRouting(routing).tiers.strong.model; }

function controlOf(entry: LedgerEntry | undefined, fixture: PlanFixture, model: string): boolean {
  const data = entry?.data as Record<string, unknown> | undefined;
  return entry?.kind === "plan_review" && entry.actor === "runner" && data?.purpose === "calibration" && data.fixture === fixture && data.policyHash === PLAN_POLICY_HASH && data.model === model && data.lens === "overall";
}
/** The bad fixture's control must fail naming every planted scope; the good fixture's must pass. */
function calibrationEntry(entry: LedgerEntry | undefined, fixture: PlanFixture, model: string): boolean {
  const data = entry?.data as Record<string, unknown> | undefined;
  if (!controlOf(entry, fixture, model)) return false;
  if (fixture === "good") return data!.verdict === "pass";
  const planted = data!.planted;
  return data!.verdict === "fail" && Array.isArray(planted) && PLANTED_SCOPES.every((scope) => planted.includes(scope));
}
/** The latest control of each fixture decides (a later failed control withdraws an earlier pass); named hashes must also pass. */
function matchingCalibration(entries: LedgerEntry[], model: string, calibration?: PlanCalibration): boolean {
  return (["bad", "good"] as const).every((fixture) => calibrationEntry(entries.filter((e) => controlOf(e, fixture, model)).at(-1), fixture, model)
    && (!calibration || calibrationEntry(entries.find((e) => e.hash === calibration[fixture]), fixture, model)));
}
export function readPlanCalibration(jarvisHome: string): { record: PlanCalibrationRecord; entries: LedgerEntry[] } | undefined {
  try {
    checkTrustedDir(jarvisHome);
    const record = RecordSchema.parse(JSON.parse(readNoFollow(join(realpathSync(jarvisHome), RECORD_FILE))));
    return { record, entries: calibrationEntries(jarvisHome, record.ledgerFile) };
  } catch { return undefined; }
}
function calibrated(options: PlanReviewServiceOptions, model: string): boolean {
  if (matchingCalibration(options.ledger.entries(), model, options.calibration)) return true;
  if (!options.jarvisHome) return false;
  const shared = readPlanCalibration(options.jarvisHome);
  return Boolean(shared && shared.record.model === model && shared.record.policyHash === PLAN_POLICY_HASH && matchingCalibration(shared.entries, model, shared.record));
}
/** Publish only a verified pair after runner control runs; never a caller's assertion of success. */
export function savePlanCalibration(input: { jarvisHome: string; ledger: Ledger; routing: ReviewRouting; calibration: PlanCalibration }): void {
  const ledgerFile = join(realpathSync(input.ledger.dir), "ledger.jsonl"), model = planModel(input.routing);
  const entries = calibrationEntries(input.jarvisHome, ledgerFile);
  if (!matchingCalibration(entries, model, input.calibration)) throw new Error("plan calibration does not satisfy the current model and policy");
  writePrivateAtomic(join(input.jarvisHome, RECORD_FILE), JSON.stringify(RecordSchema.parse({ version: 1, ledgerFile, model, policyHash: PLAN_POLICY_HASH, ...input.calibration })) + "\n");
}

/**
 * A fresh clone at the run branch head, without history or the author's reasoning, plus the plan and the
 * runner's approved checks the lenses read. Unlike the code review's checkout it keeps `.jarvis/`: the plan
 * and the checks are what is reviewed.
 */
export function preparePlanCheckout(material: PlanReviewMaterial, directory: string, home: string, git: ReviewGit = safeGit): string {
  if (!/^[a-f0-9]{40}$/.test(material.revision)) throw new Error("plan review revisions must be full commit hashes");
  const workspace = join(directory, "checkout");
  git(directory, ["-c", "protocol.file.allow=always", "-c", "transfer.fsckObjects=true", "clone", "--quiet", "--no-local", "--no-checkout", "--", material.repoPath, workspace], { home });
  git(workspace, ["checkout", "--quiet", "--detach", material.revision], { home });
  if (git(workspace, ["rev-parse", "HEAD"], { home }).toString().trim() !== material.revision) throw new Error("plan review checkout revision mismatch");
  rmSync(join(workspace, ".git"), { recursive: true, force: true });
  rmSync(join(workspace, ".jarvis"), { recursive: true, force: true });
  for (const path of AUTHOR_ONLY_PATHS) rmSync(join(workspace, path), { recursive: true, force: true });
  const root = realpathSync(workspace), checksRoot = resolve(root, material.checksRoot);
  if (!under(checksRoot, root) || relative(root, checksRoot).split("/").includes("..")) throw new Error("the checks root must be inside the checkout");
  mkdirSync(join(root, ".jarvis"), { recursive: true });
  writeFileSync(join(root, ".jarvis", "plan.json"), material.plan, { flag: "wx" });
  const source = realpathSync(material.checksSource);
  if (!lstatSync(source).isDirectory()) throw new Error("the checks source must be a folder");
  cpSync(source, checksRoot, { recursive: true, dereference: false, errorOnExist: true, force: false });
  return root;
}

function redactFinding(f: PlanFinding): PlanFinding {
  return { ...f, scope: redactReviewText(f.scope), finding: redactReviewText(f.finding), evidence: redactReviewText(f.evidence), recommendation: redactReviewText(f.recommendation) };
}

/** No pass/fail-only wrapper: errors stay errors (decision 111); the gate reads the recorded entries, not this result. */
export function createPlanReviewService(options: PlanReviewServiceOptions): PlanReviewService {
  const routing = validateReviewRouting(options.routing), model = routing.tiers.strong.model, effort = routing.tiers.strong.effort;
  return { review: async (material, calibration) => {
    const entries: LedgerEntry[] = [], findings: ReviewedPlanFinding[] = [];
    let directory: string | undefined, outputDir: string | undefined, error: string | undefined, planted: string[] = [];
    const verdicts: PlanReviewVerdict[] = [];
    const counts = calibration ? false : calibrated(options, model);
    try {
      const project = realpathSync(options.projectDir), work = realpathSync(options.workRoot);
      if (under(project, work) || under(work, project)) throw new Error("plan review checkout root overlaps runner-owned data");
      if (!/^[a-f0-9]{64}$/.test(material.planHash) || sha(material.plan) !== material.planHash) throw new Error("the plan hash does not match the plan");
      const evidenceRoot = join(project, "evidence"); mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
      outputDir = mkdtempSync(join(evidenceRoot, "plan-review-"));
      directory = mkdtempSync(join(work, "plan-"));
      const workspace = preparePlanCheckout(material, directory, options.home ?? homedir(), options.git);
      for (const lens of PLAN_LENSES) {
        const before = checkoutHash(workspace), dir = mkdtempSync(join(outputDir, `${lens}-`));
        const prompt = buildPlanPrompt(lens, { plan: material.plan, spec: material.spec, decisions: material.decisions, checksRoot: material.checksRoot, planHash: material.planHash });
        // Always the strong tier, whatever the plan's tier: the plan is judged once, before any code (decision 24's rule for judging).
        const route = routeTask("review", 2, undefined, routing);
        let output: ReviewerOutput;
        try { output = await options.claude({ workspace, outputDir: dir, prompt, model: route.model, effort: route.effort, maxTurns: options.maxTurns ?? 40, timeoutMs: options.timeoutMs ?? 900_000 }); }
        catch (caught) { output = { reviewer: "claude", model: route.model, rawOutput: JSON.stringify({ error: String(caught) }), rawVerdict: "", error: String(caught) }; }
        const raw = JSON.stringify(output);
        writeFileSync(join(dir, "raw.json"), raw, { flag: "wx", mode: 0o600 });
        if (checkoutHash(workspace) !== before) throw new Error("read-only plan review checkout changed");
        const evaluated: PlanLensVerdict = output.error || output.usageLimit ? { verdict: "fail", valid: false, findings: [], checked: [], error: output.error ?? "plan reviewer hit the plan's usage limit" }
          : evaluatePlanVerdict(output.rawVerdict, lens);
        const lensFindings = evaluated.findings.map((f, index) => ({ ...redactFinding(f), lens, id: `${lens}-${index + 1}` }));
        findings.push(...lensFindings);
        planted.push(...PLANTED_SCOPES.filter((scope) => evaluated.findings.some((f) => f.scope.includes(scope))));
        verdicts.push(evaluated.valid ? evaluated.verdict : "error");
        entries.push(options.ledger.append({ kind: "plan_review", actor: "runner", task_id: null, data: {
          lens, revision: material.revision, planHash: material.planHash, policyHash: PLAN_POLICY_HASH, model: output.model, verdict: evaluated.valid ? evaluated.verdict : "error", valid: evaluated.valid,
          findings: lensFindings, checked: evaluated.checked, rawOutputHash: sha(raw), evidence: { dir, files: { "raw.json": sha(raw) } }, counts,
          purpose: calibration ? "calibration" : "review", ...(calibration ? { fixture: calibration.fixture } : {}), ...(evaluated.error ? { error: redactReviewText(evaluated.error) } : {}),
        } }));
      }
    } catch (caught) { error = redactReviewText(caught instanceof Error ? caught.message : String(caught)); }
    finally { if (directory) rmSync(directory, { recursive: true, force: true }); }
    const verdict: PlanReviewVerdict = error || verdicts.length !== PLAN_LENSES.length || verdicts.includes("error") ? "error"
      : verdicts.includes("fail") ? "fail" : verdicts.includes("resolve") ? "resolve" : "pass";
    const notCalibrated = !calibration && !counts && verdict !== "error" ? "plan reviewer has no passing negative control for this policy" : undefined;
    planted = PLANTED_SCOPES.filter((scope) => planted.includes(scope));
    // The overall record: what the gate and the calibration bookkeeping read (one per review).
    entries.push(options.ledger.append({ kind: "plan_review", actor: "runner", task_id: null, data: {
      lens: "overall", revision: material.revision, planHash: material.planHash, policyHash: PLAN_POLICY_HASH, model, verdict, counts, planted,
      findings: findings.map((f) => ({ id: f.id, lens: f.lens, severity: f.severity, scope: f.scope })),
      purpose: calibration ? "calibration" : "review", ...(calibration ? { fixture: calibration.fixture } : {}), ...(error ? { error } : notCalibrated ? { error: notCalibrated } : {}),
    } }));
    if (!calibration && !error && verdict !== "error") {
      try {
        const dir = join(material.repoPath, ".jarvis", "plan-review"); mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "findings.json"), JSON.stringify({ planHash: material.planHash, verdict: notCalibrated ? "error" : verdict, counts, ...(notCalibrated ? { error: notCalibrated } : {}), findings }, null, 2) + "\n");
      } catch (caught) { error = redactReviewText(caught instanceof Error ? caught.message : String(caught)); }
    }
    const result: PlanReviewResult = { verdict: notCalibrated || error ? "error" : verdict, counts, entries, findings };
    const message = error ?? notCalibrated;
    return message ? { ...result, error: message } : result;
  } };
}

/** The repo's own copy of the latest findings, for the architect session; the ledger is the truth. */
export function readPlanFindings(repoPath: string): unknown {
  const path = join(repoPath, PLAN_FINDINGS_FILE);
  if (!existsSync(path)) throw new Error(`no ${PLAN_FINDINGS_FILE}: run jarvis plan review first`);
  return JSON.parse(readFileSync(path, "utf8"));
}
