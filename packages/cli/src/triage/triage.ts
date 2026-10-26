import { z } from "zod";
import { reportPathProblem } from "../runner/review-path.ts";
import { forbidsEdits, mentionsFixes } from "./fix-words.ts";

/**
 * Triage, the deterministic half (architecture §2, decisions 2, 5, 37, 89): classify a request into a
 * type and a tier, and pick the pipeline that runs, so a bug fix never triggers the design workflow.
 * It reads only what code can read (the folder, an attached error, words in the request, the files a
 * quick search says the change touches). The model's judgment on the request is an input, never
 * invented here. Precedence: the user's override, then an empty folder, then the model's judgment,
 * then the request's words, then "feature". An upgrade from bug to feature is always announced.
 * The type fixes which steps never run; the tier comes from risk (decision 89).
 */

export const TASK_TYPES = ["new-product", "feature", "bug", "refactor", "question", "review", "release"] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export type Tier = 0 | 1 | 2;
/** The pipelines a question's requested edits can take (decision 89, mixed requests). */
export const EDIT_TYPES = ["feature", "refactor", "bug"] as const;
export type EditType = (typeof EDIT_TYPES)[number];

/** `/jarvis fix: …`, `/jarvis build: …`, `/jarvis feature: …`, `/jarvis ask: …`. Always wins. */
export const OVERRIDES = { fix: "bug", build: "new-product", feature: "feature", ask: "question" } as const satisfies Record<string, TaskType>;
export type Override = keyof typeof OVERRIDES;

/** The lowest tier per type (decision 37); risk and the model raise it, nothing caps it. Null: no tier (read-only). */
const MIN_TIER: Record<TaskType, Tier | null> = {
  "new-product": 2, feature: 1, bug: 0, refactor: 1, review: 1, release: 1, question: null,
};

/** The stage that brings each skill a step runs (decision 30; architecture §8). */
export const SKILL_STAGES: Record<string, number> = {
  research: 2, intake: 2, spec: 2, design: 2,
  architect: 3, build: 3, debug: 3,
  review: 4,
  ship: 5,
  onboard: 6,
};

export interface StepDef {
  label: string;
  /** The skill that runs the step, or null when no skill does (the runner or the session itself). */
  skill: string | null;
  /** The stage that brings the step (architecture §8). */
  stage: number;
  /** "session": the interactive /jarvis session runs it. "runner": it runs after `jarvis run --detach`. */
  by: "session" | "runner";
  /**
   * /jarvis starts this step itself. Otherwise the step's skill was already started by an earlier step
   * (the spike runs inside research) or is chained to by the previous skill (research → intake → spec),
   * so the dispatcher never starts it again (decision 89).
   */
  dispatch: boolean;
}

/** Every step of §2's table. Session steps come first in every pipeline; then the hand-off; then the runner's. */
export const STEPS = {
  "register-check": { label: "decision-register check", skill: "research", stage: 2, by: "session", dispatch: true },
  spike: { label: "spike if needed", skill: "research", stage: 2, by: "session", dispatch: false },
  research: { label: "research (product + build-vs-buy)", skill: "research", stage: 2, by: "session", dispatch: true },
  intake: { label: "intake", skill: "intake", stage: 2, by: "session", dispatch: false },
  spec: { label: "spec", skill: "spec", stage: 2, by: "session", dispatch: false },
  design: { label: "design", skill: "design", stage: 2, by: "session", dispatch: true },
  "read-only-research": { label: "read-only research", skill: null, stage: 2, by: "session", dispatch: true },
  answer: { label: "answer with file citations", skill: null, stage: 2, by: "session", dispatch: true },
  "decision-archaeology": { label: "decision archaeology", skill: "onboard", stage: 6, by: "session", dispatch: true },
  review: { label: "read-only review (findings with file references and fixes)", skill: "review", stage: 4, by: "session", dispatch: true },
  "review-report": { label: "review written to the report (each finding with file:line, severity, evidence and a proposed fix)", skill: "review", stage: 4, by: "session", dispatch: true },
  architecture: { label: "architecture", skill: "architect", stage: 3, by: "runner", dispatch: false },
  "build-loop": { label: "build loop", skill: "build", stage: 3, by: "runner", dispatch: false },
  reproduce: { label: "reproduce", skill: "debug", stage: 3, by: "runner", dispatch: false },
  "failing-test": { label: "failing test", skill: "debug", stage: 3, by: "runner", dispatch: false },
  fix: { label: "fix", skill: "debug", stage: 3, by: "runner", dispatch: false },
  checks: { label: "checks", skill: null, stage: 3, by: "runner", dispatch: false },
  "pin-behavior": { label: "pin current behavior with tests", skill: "build", stage: 3, by: "runner", dispatch: false },
  "small-steps": { label: "small steps", skill: "build", stage: 3, by: "runner", dispatch: false },
  "same-tests-pass": { label: "same tests pass", skill: null, stage: 3, by: "runner", dispatch: false },
  lanes: { label: "lanes the change touches", skill: null, stage: 4, by: "runner", dispatch: false },
  "architecture-lane": { label: "architecture lane", skill: null, stage: 4, by: "runner", dispatch: false },
  "release-manifest": { label: "release manifest", skill: "ship", stage: 5, by: "runner", dispatch: false },
  rehearsals: { label: "rehearsals", skill: "ship", stage: 5, by: "runner", dispatch: false },
  "broker-deploy": { label: "broker-gated deploy", skill: "ship", stage: 5, by: "runner", dispatch: false },
  "smoke-test": { label: "smoke test", skill: "ship", stage: 5, by: "runner", dispatch: false },
  "preview-deploy": { label: "preview deploy", skill: "ship", stage: 5, by: "runner", dispatch: false },
  report: { label: "report", skill: null, stage: 3, by: "runner", dispatch: false },
} as const satisfies Record<string, StepDef>;
export type StepId = keyof typeof STEPS;
export interface Step extends StepDef { id: StepId }

const Judgment = z.object({
  /** The model's read of the request's type. */
  type: z.enum(TASK_TYPES).optional(),
  /** The model's read of the risk. It only raises the tier code reads. */
  tier: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  /** A "bug" whose right behavior was never specified: it needs product decisions (§2's upgrade). */
  missingBehavior: z.boolean().optional(),
  /** The change needs a kind of screen the product doesn't have yet. */
  newScreen: z.boolean().optional(),
  /** The change targets a platform or client the repo has no UI for (a phone app beside a web app). */
  newPlatform: z.boolean().optional(),
  /** The platform or client the change targets (web, ios, android, macos, windows, cli …), for the record. */
  platform: z.string().trim().min(1).max(40).optional(),
  /** A question about the whole repo: map it and reconstruct its decisions. */
  onboarding: z.boolean().optional(),
  /** The pipeline for edits a question also asks for, or "none" when it asks for none. A review's fixes are always bug work. */
  then: z.enum([...EDIT_TYPES, "none"]).optional(),
  /** The file a review writes its findings to, when the request names one in words code doesn't read (decision 126). */
  report: z.string().refine((p) => reportPathProblem(p) === undefined, "the report must be a plain repo-relative .md or .txt path outside .git and .jarvis").optional(),
  /** Product questions the model expects intake to ask (decision 8's cap: 7). Used in the upgrade sentence. */
  questions: z.number().int().min(0).max(7).optional(),
  /** One line on why, shown with the signals. */
  reason: z.string().max(500).optional(),
}).strict();
export type Judgment = z.infer<typeof Judgment>;

const Folder = z.object({ empty: z.boolean(), designMd: z.boolean() }).strict();
export type FolderState = z.infer<typeof Folder>;

const Input = z.object({
  request: z.string().trim().min(1).max(100_000),
  folder: Folder,
  /** An error, stack trace or issue is attached to the request. */
  attachedError: z.boolean().optional(),
  /** Files the change will likely touch, from a quick search. */
  touches: z.array(z.string().min(1).max(1000)).max(1000).optional(),
  override: z.enum(Object.keys(OVERRIDES) as [Override, ...Override[]]).optional(),
  judgment: Judgment.optional(),
}).strict();
export type TriageInput = z.input<typeof Input>;

export type SignalName =
  | "override" | "empty-folder" | "design-md" | "attached-error" | "error-text"
  | "bug-words" | "question-words" | "onboarding-words" | "review-words" | "refactor-words" | "release-words" | "edit-words"
  | "fixes-mentioned" | "report-file" | "report-refused" | "security-words" | "no-edit-words"
  | "tier2-area" | "several-modules" | "one-sentence" | "no-type-words"
  | "judgment" | "judgment-overruled" | "missing-behavior" | "new-screen" | "new-platform" | "tier-raised";
export interface Signal { name: SignalName; detail: string }

export interface Pipeline {
  type: TaskType;
  label: string;
  tier: Tier | null;
  /** Intake makes design-direction mockups (through the design skill). */
  mockups: boolean;
  steps: Step[];
  /** §2's "steps that never run" for this pipeline, fixed by its type. */
  never: string[];
  /** "after-spec": once the spec is confirmed or defaulted. "now": once the session steps are done. "none": nothing to build. */
  handoff: "after-spec" | "now" | "none";
}

export interface Triage extends Pipeline {
  decidedBy: "override" | "empty-folder" | "judgment" | "text" | "default";
  onboarding: boolean;
  /** A question that also asks for edits: this pipeline runs after the read-only one (decision 89). Never set for a review (decision 126). */
  then: Pipeline | null;
  /**
   * A review's report and lens (decision 126); null for every other type. `report`: the file the request names
   * for the findings, else null. `security`: the review also follows the security skill (security words, or a
   * tier-2 area). `fixesMentioned`: the request mentions fixes, a signal only: fixes start on an explicit opt-in.
   */
  review: { report: string | null; security: boolean; fixesMentioned: boolean } | null;
  signals: Signal[];
  upgrade: { from: "bug"; to: "feature"; announcement: string } | null;
  /** The classification in one line, for the first message (after the upgrade sentence, if any). */
  headline: string;
}

// Words in the request. Weak signals: the model's judgment beats them.
const BUG = /\b(fix(?:es|ed|ing)?|broken|breaks|bug(?:gy|s)?|doesn'?t|does not|won'?t|isn'?t working|not working|stopped working|fails?|failing|failed|crash(?:es|ed|ing)?|wrong|regression|missing)\b/i;
// Not "do" or "when": "Do P5.2 from the backlog" and "When a user signs up, send …" are requests.
const QUESTION = /^\s*(?:how|what|why|where|which|who|is|are|does|explain|walk me through|tell me)\b/i;
const ONBOARDING = /\b(get familiar|onboard(?:ing)?|walk me through (?:this|the) (?:repo|codebase|project)|map (?:this|the) (?:repo|codebase|project)|explain (?:this|the) (?:repo|codebase|project))\b/i;
// A review asked for up front, before any subordinate "before I ship it" (golden task 3).
const REVIEW = /^\s*(?:please\s+|(?:can|could|would) you\s+)?(?:do an? (?:security |code )?review of|(?:security[- ]|code[- ])?review|audit)\b/i;
const REFACTOR = /\b(refactor\w*|clean ?up|restructur\w*|reorganiz\w*|simplif(?:y|ies)|extract|rename|dedupe|deduplicate)\b/i;
const RELEASE = /\b(deploy\w*|release|ship it|publish|roll ?back|promote (?:it |the \w+ )?to (?:prod\w*|staging)|go live)\b/i;
// A file the request says to put the findings in: "Put what you find in REVIEW.md", "write them to docs/x.md".
const REPORT_FILE = /\b(?:put|write|save|record|list|document|keep|log|leave)\b[^.!?\n]{0,80}?\b(?:in|into|to|as)\s+(?:a\s+file\s+(?:called|named)\s+)?[`'"]?([^\s`'"]+?\.(?:md|markdown|txt))(?![\w/])/i;
const SECURITY = /\b(secur\w*|vulnerab\w*|exploit\w*|injection|ssrf|xss|csrf|owasp|pen-?test\w*|threat model\w*)\b/i;
// Edits a question asks for after it: "… and make it easier for agents to work in" (golden task 7).
const EDITS = /\b(?:and|also)\s+(?:then\s+)?(?:please\s+)?(make|clean|tidy|simplify|improve|refactor|reorganiz\w*|restructur\w*|fix|add|update|create|build|write|set up|remove)\b/i;
const EDIT_KIND: Record<string, EditType> = { fix: "bug", make: "refactor", clean: "refactor", tidy: "refactor", simplify: "refactor", improve: "refactor", refactor: "refactor" };

/** Decision 37's tier-2 areas and decision 5's spike triggers. */
const TIER2_AREAS: readonly (readonly [string, RegExp])[] = [
  ["auth", /\b(auth\w*|log ?in|sign[- ]?in|sign[- ]?up|passwords?|oauth|sso)\b/i],
  ["payments", /\b(payments?|billing|checkout|subscriptions?|stripe|invoices?|refunds?)\b/i],
  ["acts on other people", /\b(e-?mails?|sms|reach(?:es|ing)? out|outreach|invites?|send (?:a |an )?messages?)\b/i],
  ["data", /\b(database|schema|migrations?|migrate|data model)\b/i],
  ["public API", /\b(public api|api endpoints?|webhooks?|rest api|graphql)\b/i],
  ["new dependency", /\b(new dependency|add (?:a |the )?(?:library|package|sdk)|integrat(?:e|ion) with)\b/i],
  ["outside data", /\b(scrap(?:e|es|ing)|crawl\w*|third[- ]party|external api|enrich\w*)\b/i],
  ["hard to reverse", /\b(delet(?:e|es|ing)|drop (?:the |a )?(?:table|column|database)|purge|irreversibl\w*|production)\b/i],
];
const SEVERAL_MODULES = /\b(across the (?:app|codebase|repo|project)|everywhere|every (?:page|screen|module|service))\b/i;

/** An error or a stack trace pasted into the request. Line-wise, so trace lines can be left out of the sentence count. */
const ERROR_LINES: readonly RegExp[] = [
  /Traceback \(most recent call last\)/,
  /^\s+at \S.*:\d+(?::\d+)?\)?\s*$/,
  /^\s*File ".*", line \d+/,
  /^panic: /,
  /^goroutine \d+ \[/,
  /\b(?:[A-Z]\w*)?(?:Error|Exception):\s/,
  /\bexit (?:code|status) [1-9]\d*/i,
  /\bSegmentation fault\b/,
];

/**
 * `/jarvis fix: the login` → fix (decision 89). Only the first word followed by a colon, with more
 * request after it, is an override: "Build fails on CI" is prose. The request stays as typed.
 */
export function leadingOverride(text: string): Override | undefined {
  return /^\s*(fix|build|feature|ask):\s*\S/i.exec(text)?.[1]!.toLowerCase() as Override | undefined;
}

export function triage(raw: TriageInput): Triage {
  const input = Input.parse(raw);
  const text = input.request;
  const j = input.judgment ?? {};
  const signals: Signal[] = [];
  const add = (name: SignalName, detail: string) => void signals.push({ name, detail });
  const hit = (re: RegExp) => re.exec(text)?.[0];

  // What code can read.
  if (input.folder.empty) add("empty-folder", "the folder has no files besides .git and tool folders");
  if (input.folder.designMd) add("design-md", "DESIGN.md exists");
  if (input.attachedError) add("attached-error", "an error, stack trace or issue is attached");
  const lines = text.split("\n");
  const errorLine = lines.find((l) => ERROR_LINES.some((re) => re.test(l)));
  if (errorLine !== undefined) add("error-text", `the request contains an error or stack trace ("${errorLine.trim().slice(0, 80)}")`);
  const words = { review: hit(REVIEW), bug: hit(BUG), question: hit(QUESTION), onboarding: hit(ONBOARDING), refactor: hit(REFACTOR), release: hit(RELEASE) };
  if (words.review) add("review-words", `starts with "${words.review.trim()}"`);
  if (words.onboarding) add("onboarding-words", `"${words.onboarding}"`);
  else if (words.question) add("question-words", `starts with "${words.question.trim()}"`);
  if (words.bug) add("bug-words", `"${words.bug}"`);
  if (words.refactor) add("refactor-words", `"${words.refactor}"`);
  if (words.release) add("release-words", `"${words.release}"`);
  const areas = TIER2_AREAS.flatMap(([area, re]) => {
    const w = re.exec(text)?.[0];
    return w ? [`${area} ("${w}")`] : [];
  });
  if (areas.length) add("tier2-area", areas.join(", "));
  const dirs = new Set((input.touches ?? []).map((p) => p.replace(/\\/g, "/").split("/").slice(0, -1).join("/")));
  const several = dirs.size >= 3 ? `${dirs.size} folders in the files the change touches` : hit(SEVERAL_MODULES) ? `"${hit(SEVERAL_MODULES)}"` : undefined;
  if (several) add("several-modules", several);
  const prose = text.replace(/```[\s\S]*?```/g, " ").split("\n").filter((l) => !ERROR_LINES.some((re) => re.test(l))).join(" ");
  // A short tail like "Fix it." isn't a second sentence: only sentences of 3 or more words count.
  const sentences = prose.split(/[.!?]+(?:\s+|$)/).filter((s) => s.trim().split(/\s+/).length >= 3).length;
  if (sentences <= 1) add("one-sentence", "the request is one sentence");

  // The request's words alone. A review asked for up front beats "ship" later in the sentence.
  const pasted = input.attachedError === true || errorLine !== undefined;
  const reading: TaskType | undefined =
    words.review ? "review"
      : (words.onboarding || words.question) && !pasted ? "question"
        : words.bug || pasted ? "bug"
          : words.refactor ? "refactor"
            : words.release ? "release"
              : undefined;

  let type: TaskType;
  let decidedBy: Triage["decidedBy"];
  if (j.type !== undefined || j.reason !== undefined) add("judgment", [j.type, j.reason].filter((x) => x !== undefined).join(": "));
  if (input.override !== undefined) {
    type = OVERRIDES[input.override];
    decidedBy = "override";
    add("override", `you said ${input.override}:`);
  } else if (input.folder.empty && j.type !== "question") {
    type = "new-product";
    decidedBy = "empty-folder";
    if (j.type !== undefined && j.type !== "new-product") add("judgment-overruled", `the model read ${j.type}, but the folder is empty: there is nothing to fix or extend`);
  } else if (j.type !== undefined) {
    type = j.type;
    decidedBy = "judgment";
  } else if (reading !== undefined) {
    type = reading;
    decidedBy = "text";
  } else {
    type = "feature";
    decidedBy = "default";
    add("no-type-words", "no override, judgment or type words: a request in an existing project is a feature");
  }

  // §2's upgrade: a "bug" that needs product decisions is a feature, and the first message says so.
  let upgraded = false;
  if (j.missingBehavior === true) {
    if (decidedBy === "override") add("missing-behavior", `the model read missing behavior, but your override (${input.override}:) wins; the fix records the behavior it picks as an assumption`);
    else if (type === "bug" || (type === "feature" && decidedBy === "judgment" && reading === "bug")) {
      upgraded = true;
      type = "feature";
      add("missing-behavior", "the right behavior was never specified: it needs product decisions");
    }
  }

  const onboarding = type === "question" && (words.onboarding !== undefined || j.onboarding === true);
  // A new screen needs the design stage when no DESIGN.md exists; a new platform needs it even when one does (decision 89).
  const designFor = (t: TaskType) => t === "new-product" || (t === "feature" && (j.newPlatform === true || (j.newScreen === true && !input.folder.designMd)));
  if (j.newPlatform === true) add("new-platform", `${j.platform ?? "a platform"} has no UI yet: design direction and mockups${input.folder.designMd ? ", although DESIGN.md covers another platform" : ""}`);
  else if (j.newScreen === true) add("new-screen", input.folder.designMd ? `a new kind of screen${j.platform ? ` on ${j.platform}` : ""}, inside the existing DESIGN.md` : "a new kind of screen and no DESIGN.md: design direction and mockups");

  // Decision 37's tier, from risk (decision 89): code reads a floor, the model may raise it, the type never caps it.
  const risky = areas.length > 0 || several !== undefined;
  const tierFor = (t: TaskType): Tier | null => {
    const min = MIN_TIER[t];
    if (min === null) return null;
    let tier: Tier = risky ? 2 : t === "bug" && sentences > 1 ? 1 : min;
    if (tier < min) tier = min;
    if (j.tier !== undefined && j.tier > tier) {
      add("tier-raised", `the model raised a ${t} from tier ${tier} to ${j.tier}`);
      tier = j.tier;
    }
    return tier;
  };
  const pipeline = (t: TaskType, label: string): Pipeline => {
    const design = designFor(t);
    return { type: t, label, tier: tierFor(t), mockups: design, ...stepsFor(t, { design, onboarding: t === "question" && onboarding }) };
  };

  let first = pipeline(type, type === "question" && onboarding ? "Onboarding" : LABELS[type]);
  // Mixed requests (decision 89): a question that also asks for edits keeps both parts. The override (ask:) means only the question.
  let then: Pipeline | null = null;
  if (type === "question" && decidedBy !== "override" && j.then !== "none") {
    const verb = hit(EDITS);
    if (verb) add("edit-words", `"${verb}"`);
    const kind = j.then ?? (verb ? EDIT_KIND[EDITS.exec(text)![1]!.toLowerCase()] ?? (words.refactor ? "refactor" : "feature") : undefined);
    if (kind) then = pipeline(kind, LABELS[kind]);
  }

  // A prohibition on editing vetoes the edits triage reads from words: a question's, and a review's report (fail closed).
  const noEdit = forbidsEdits(text);
  if (noEdit) add("no-edit-words", `"${noEdit}": no edits`);
  if (type === "question" && noEdit && then) then = null;

  // A review is always a review, and triage never starts its fixes (decision 126, round 3): not from the request's
  // words and not from the model's judgment. Fixes start only on an explicit, structured opt-in outside triage (the
  // user's recorded answer to the intake question review-fix, `jarvis run --plan review --fix`, or an eval task's
  // runner-owned reviewFix). The request mentioning fixes is a signal that prompts that question, nothing more.
  let review: Triage["review"] = null;
  if (type === "review") {
    const fixesMentioned = mentionsFixes(text);
    if (fixesMentioned) add("fixes-mentioned", "the request mentions fixes: they start only on an explicit opt-in (the review-fix question, or jarvis run --plan review --fix)");
    let named = noEdit ? undefined : j.report;
    const typed = noEdit ? undefined : REPORT_FILE.exec(text)?.[1];
    if (named === undefined && typed !== undefined) {
      const problem = reportPathProblem(typed);
      if (problem) add("report-refused", `"${typed}": ${problem}`);
      else named = typed;
    }
    const report = named ?? null;
    if (report !== null) add("report-file", `the findings go to ${report}`);
    const security = hit(SECURITY);
    if (security) add("security-words", `"${security}"`);
    review = { report, security: security !== undefined || areas.length > 0, fixesMentioned };
    if (report !== null) first = { ...first, ...stepsFor("review", { design: false, onboarding: false, report: true }) };
  }

  const upgrade = upgraded ? { from: "bug" as const, to: "feature" as const, announcement: upgradeSentence(first.tier === 2, j.questions) } : null;
  const describe = (p: Pipeline) => [
    `Runs: ${p.steps.map((s) => (s.id === "intake" ? `intake ${p.mockups ? "with mockups" : "(no mockups)"}` : s.label)).join(" → ")}.`,
    p.never.length ? `Never: ${p.never.join(", ")}.` : undefined,
  ];
  const headline = [
    upgrade?.announcement,
    `${first.label}${first.tier === null ? "" : `, tier ${first.tier}`}${decidedBy === "override" ? ` (your override: ${input.override})` : ""}.`,
    ...describe(first),
    review?.report ? `Report: ${review.report}.` : undefined,
    review?.fixesMentioned ? "The request mentions fixes: they start only on an explicit opt-in." : undefined,
    then ? `Then: ${then.label}, tier ${then.tier}.` : undefined,
    ...(then ? describe(then) : []),
  ].filter((x) => x !== undefined).join(" ");

  return { ...first, decidedBy, onboarding, then, review, signals, upgrade, headline };
}

const LABELS: Record<TaskType, string> = {
  "new-product": "New product", feature: "Feature", bug: "Bug", refactor: "Refactor", question: "Question", review: "Review", release: "Release / ops",
};

function upgradeSentence(big: boolean, questions: number | undefined): string {
  const count = questions === undefined ? "" : questions === 0 ? ": no questions" : `: ${questions} question${questions === 1 ? "" : "s"}`;
  return `This looks like missing behavior, not a bug. Treating it as ${big ? "a feature" : "a small feature"}${count}.`;
}

/** §2's table: the steps each pipeline runs, the ones it never runs, and when the runner takes over. */
function stepsFor(type: TaskType, o: { design: boolean; onboarding: boolean; report?: boolean }): Pick<Pipeline, "steps" | "never" | "handoff"> {
  const steps = (...ids: StepId[]): Step[] => ids.map((id) => ({ id, ...STEPS[id] }));
  switch (type) {
    case "new-product":
      return { steps: steps("research", "intake", "spec", "design", "architecture", "build-loop", "lanes", "preview-deploy", "report"), never: [], handoff: "after-spec" };
    case "feature":
      return o.design
        ? { steps: steps("register-check", "spike", "intake", "spec", "design", "build-loop", "lanes", "report"), never: [], handoff: "after-spec" }
        : { steps: steps("register-check", "spike", "intake", "spec", "build-loop", "lanes", "report"), never: ["mockups", "design direction"], handoff: "after-spec" };
    case "bug":
      return { steps: steps("reproduce", "failing-test", "fix", "checks", "lanes", "report"), never: ["intake", "mockups", "design", "architecture"], handoff: "now" };
    case "refactor":
      return { steps: steps("pin-behavior", "small-steps", "same-tests-pass", "architecture-lane"), never: ["intake", "design"], handoff: "now" };
    case "question":
      return { steps: o.onboarding ? steps("read-only-research", "answer", "decision-archaeology") : steps("read-only-research", "answer"), never: ["any edit"], handoff: "none" };
    case "review":
      // A review that writes a report (decision 126): the report is its one edit; any fixes are the `then` pipeline's.
      if (o.report) return { steps: steps("review-report"), never: ["edits besides the report"], handoff: "none" };
      return { steps: steps("review"), never: ["any edit"], handoff: "none" };
    case "release":
      return { steps: steps("release-manifest", "rehearsals", "broker-deploy", "smoke-test"), never: ["building"], handoff: "now" };
  }
}
