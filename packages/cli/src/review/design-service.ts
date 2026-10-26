import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { verifyEvidence } from "../checks/gate.ts";
import type { Ledger, LedgerEntry } from "../ledger/ledger.ts";
import { verifyDesignObservation, type DesignBrowserPlan } from "./design-browser.ts";
import { createCodexDesignReviewer, DESIGN_REVIEW_MODEL, type DesignReviewer } from "./design-codex.ts";
import { buildDesignPrompt, designEvidence, DESIGN_INSTRUCTIONS } from "./design-evidence.ts";
import { DESIGN_RUBRIC, evaluateDesignVerdict, type DesignEvaluation } from "./design-verdict.ts";
import type { VerifiedGate } from "./evidence.ts";
import { redactReviewText } from "./redaction.ts";
import type { ReviewRequest } from "./types.ts";
import { checkoutHash, prepareCheckout, type ReviewGit } from "./workspace.ts";

const sha = (raw: string | Buffer) => createHash("sha256").update(raw).digest("hex");
/** A calibration counts only for this exact model, rubric and instruction text (decision 56): any change needs a new negative control. */
export const DESIGN_POLICY_HASH = sha(JSON.stringify({version: 2, rubric: DESIGN_RUBRIC, model: DESIGN_REVIEW_MODEL, instructions: DESIGN_INSTRUCTIONS}));
/** The friction choices the generic fixture plants (docs/02-golden-tasks.md); its calibration must name all three. */
const FRICTION_RULES = ["launch-tour", "multiple-primary", "apologetic-error"] as const;
type DesignFinding = DesignEvaluation["findings"][number];
/** Reviewer-written text is redacted before the ledger or a caller sees it (decision 110: the jail can read the auth file). */
const redactFinding = (f: DesignFinding): DesignFinding => ({...f, screen: redactReviewText(f.screen), element: redactReviewText(f.element), principle: redactReviewText(f.principle), explanation: redactReviewText(f.explanation), fix: redactReviewText(f.fix)});
const REQUIRED_CHECKS = ["impeccable-source", "impeccable-url", "ai-tells", "token-lint", "design-md-lint", "design-browser"];
const under = (root: string, path: string) => root === path || path.startsWith(`${root}/`);
export interface DesignReviewMaterial {
  repoPath: string; baseRevision: string;
  /** Runner-owned approved snapshots, never a candidate's summary or instructions. */
  principles: string; design: string; product: string;
  plan: DesignBrowserPlan; axeVersion: string;
  /** Evidence-relative stdout file of the protected design-browser gate. */
  captureFile: string;
}
export interface DesignReviewServiceOptions {
  ledger: Ledger; projectDir: string; workRoot: string;
  resolveMaterial(request: ReviewRequest): Promise<DesignReviewMaterial>;
  reviewer?: DesignReviewer;
  home?: string; git?: ReviewGit; timeoutMs?: number;
  /** Hashes of this model/policy's runner-owned calibration review entries. */
  calibration?: {generic: string; good: string};
}
export interface DesignReviewResult extends DesignEvaluation { counts: boolean; entry: LedgerEntry; designVerdict: DesignEvaluation["verdict"] }
export interface DesignReviewService { reviewDetailed(request: ReviewRequest, calibration?: {fixture: "generic" | "good"}): Promise<DesignReviewResult> }

function calibrated(options: DesignReviewServiceOptions): boolean {
  if (!options.calibration) return false;
  const entries = options.ledger.entries();
  return (["generic", "good"] as const).every(fixture => {
    const entry = entries.find(e => e.hash === options.calibration![fixture]);
    const data = entry?.data as Record<string, unknown> | undefined;
    if (entry?.kind !== "review_result" || entry.actor !== "runner" || data?.reviewer !== "design" || data.model !== DESIGN_REVIEW_MODEL || data.policyHash !== DESIGN_POLICY_HASH || data.purpose !== "calibration" || data.fixture !== fixture || data.designVerdict !== (fixture === "generic" ? "fail" : "pass")) return false;
    if (fixture === "good") return data.verdict === "pass";
    // The runner's own record of the rules the findings named, taken before redaction.
    const friction = data.friction;
    return Array.isArray(friction) && FRICTION_RULES.every(rule => friction.includes(rule));
  });
}

function evidenceFor(options: DesignReviewServiceOptions, request: ReviewRequest): VerifiedGate[] {
  const latest = new Map<string, LedgerEntry>();
  for (const entry of options.ledger.entries()) {
    const data = entry.data as Record<string, unknown>;
    if (entry.kind === "gate_result" && entry.actor === "runner" && entry.task_id === request.taskId && entry.attempt_id === request.attemptId && data.revision === request.revision && typeof data.check === "string") latest.set(data.check, entry);
  }
  if (REQUIRED_CHECKS.some(check => !latest.has(check))) throw new Error("missing design code checks for this attempt and revision");
  return [...latest.values()].map(entry => {
    const data = entry.data as Record<string, unknown>;
    if (data.status !== "pass" && data.status !== "fail") throw new Error("design code checks did not complete");
    const evidence = data.evidence as {dir:string; files:Record<string,string>};
    const root = realpathSync(join(options.projectDir, "evidence"));
    if (!evidence || !under(root, realpathSync(evidence.dir))) throw new Error("design evidence must be runner-owned");
    const files: VerifiedGate["files"] = {};
    for (const [name, hash] of Object.entries(evidence.files)) {
      const path = resolve(realpathSync(evidence.dir), name), stat = lstatSync(path);
      if (isAbsolute(name) || !under(realpathSync(evidence.dir), path) || !under(realpathSync(evidence.dir), realpathSync(path)) || !stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid design evidence path");
      const raw = readFileSync(path);
      if (sha(raw) !== hash) throw new Error("design evidence changed after capture");
      files[name] = {raw, sha256:hash};
    }
    if (!verifyEvidence(entry).ok) throw new Error("design evidence hash verification failed");
    return {data, files};
  });
}

/** No pass/fail-only wrapper: the loop must retain infrastructure errors (decision 111). */
export function createDesignReviewService(options: DesignReviewServiceOptions): DesignReviewService {
  const reviewer = options.reviewer ?? createCodexDesignReviewer({home: options.home ?? homedir()});
  return { reviewDetailed: async (request, calibration) => {
    let evaluation: DesignEvaluation = {verdict:"error", findings:[], error:"design review did not run"};
    let designVerdict: DesignEvaluation["verdict"] = "error", directory: string | undefined, outputDir: string | undefined;
    let raw = "", counts = false;
    try {
      if (!calibration && !calibrated(options)) throw new Error("design reviewer has no passing negative control for this model and policy");
      const project = realpathSync(options.projectDir), work = realpathSync(options.workRoot);
      if (under(project, work) || under(work, project)) throw new Error("design review checkout root overlaps runner-owned data");
      const gates = evidenceFor(options, request), material = await options.resolveMaterial(request);
      const captured = gates.find(g => g.data.check === "design-browser")?.files[material.captureFile];
      if (!captured) throw new Error("missing runner browser capture");
      const capture = verifyDesignObservation(JSON.parse(captured.raw.toString("utf8")), material.plan, material.axeVersion, {calibration:gates.some(g => g.data.check === "design-browser" && g.data.status === "fail")});
      const evidence = designEvidence(capture, material.plan.flows.map(f => f.id));
      directory = mkdtempSync(join(work, "design-"));
      const {workspace} = prepareCheckout(material.repoPath, request.revision, material.baseRevision, directory, options.home ?? homedir(), options.git);
      const evidenceRoot = join(project, "evidence");
      outputDir = mkdtempSync(join(evidenceRoot, "design-review-"));
      const images = evidence.images.map((bytes, index) => { const path = join(outputDir!, `screen-${index}.png`); writeFileSync(path, bytes, {flag:"wx",mode:0o600}); return path; });
      const sessionDir = join(outputDir, "session"); mkdirSync(sessionDir, {mode:0o700});
      const prompt = buildDesignPrompt({designId:capture.designId, principles:material.principles, design:material.design, product:material.product, evidence, gates});
      const before = checkoutHash(workspace);
      const result = await reviewer({workspace,outputDir:sessionDir,images,prompt,timeoutMs:options.timeoutMs??600_000});
      raw = JSON.stringify(result);
      if (checkoutHash(workspace) !== before) throw new Error("read-only design checkout changed");
      if (result.error || result.reviewer !== "codex" || result.model !== DESIGN_REVIEW_MODEL) throw new Error(result.error ?? "unexpected design reviewer identity");
      evaluation = evaluateDesignVerdict(result.rawVerdict); designVerdict = evaluation.verdict;
      if (evaluation.verdict !== "error" && gates.some(g => g.data.status === "fail")) evaluation = {...evaluation,verdict:"fail"};
      counts = !calibration && evaluation.verdict !== "error";
    } catch (error) { evaluation = {verdict:"error",findings:[],error:redactReviewText(error instanceof Error ? error.message : String(error))}; }
    finally { if (directory) rmSync(directory,{recursive:true,force:true}); }
    const friction = FRICTION_RULES.filter(rule => evaluation.findings.some(f => f.principle.includes(rule)));
    evaluation = {...evaluation, findings: evaluation.findings.map(redactFinding)};
    const files: Record<string,string> = {};
    if (outputDir) {
      writeFileSync(join(outputDir,"raw.json"),raw,{flag:"wx",mode:0o600}); files["raw.json"] = sha(raw);
      // Images are retained across rounds; the ledger binds exactly what was shown.
      for (let i=0; ; i++) { try { const image=readFileSync(join(outputDir,`screen-${i}.png`)); files[`screen-${i}.png`]=sha(image); } catch { break; } }
    }
    const entry = options.ledger.append({kind:"review_result",actor:"runner",task_id:request.taskId,attempt_id:request.attemptId,data:{reviewer:"design",model:DESIGN_REVIEW_MODEL,policyHash:DESIGN_POLICY_HASH,revision:request.revision,status:evaluation.verdict,...evaluation,friction,designVerdict,counts,purpose:calibration?"calibration":"gate",...(calibration?{fixture:calibration.fixture}:{}),...(outputDir?{evidence:{dir:outputDir,files}}:{})}});
    return {...evaluation,designVerdict,counts,entry};
  }};
}
