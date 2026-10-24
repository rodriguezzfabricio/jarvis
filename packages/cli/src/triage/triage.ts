import { z } from "zod";

/**
 * Triage, the deterministic half (architecture §2, decisions 2, 5, 37): classify a request into a
 * type and a tier, and pick the pipeline that runs, so a bug fix never triggers the design workflow.
 * It reads only what code can read (the folder, an attached error, words in the request, the files a
 * quick search says the change touches). The model's judgment on the request is an input, never
 * invented here. Precedence: the user's override, then an empty folder, then the model's judgment,
 * then the request's words, then "feature". An upgrade from bug to feature is always announced.
 */

export const TASK_TYPES = ["new-product", "feature", "bug", "refactor", "question", "release"] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export type Tier = 0 | 1 | 2;

/** `/jarvis fix …`, `/jarvis build …`, `/jarvis feature …`, `/jarvis ask …`. Always wins. */
export const OVERRIDES = { fix: "bug", build: "new-product", feature: "feature", ask: "question" } as const satisfies Record<string, TaskType>;
export type Override = keyof typeof OVERRIDES;

/** Decision 37's tiers per type (§2's "typical tier"); null where tiers don't apply. */
const TIERS: Record<TaskType, readonly [Tier, Tier] | null> = {
  "new-product": [2, 2],
  feature: [1, 2],
  bug: [0, 1],
  refactor: [1, 1],
  question: null,
  release: null,
};

/** The stage that brings each skill a step runs (decision 30; architecture §8). */
export const SKILL_STAGES: Record<string, number> = {
  research: 2, intake: 2, spec: 2, design: 2,
  architect: 3, build: 3, debug: 3,
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
}

/** Every step of §2's table. Session steps come first in every pipeline; then the hand-off; then the runner's. */
export const STEPS = {
  "register-check": { label: "decision-register check", skill: "research", stage: 2, by: "session" },
  spike: { label: "spike if needed", skill: "research", stage: 2, by: "session" },
  research: { label: "research (product + build-vs-buy)", skill: "research", stage: 2, by: "session" },
  intake: { label: "intake", skill: "intake", stage: 2, by: "session" },
  spec: { label: "spec", skill: "spec", stage: 2, by: "session" },
  design: { label: "design", skill: "design", stage: 2, by: "session" },
  "read-only-research": { label: "read-only research", skill: null, stage: 2, by: "session" },
  answer: { label: "answer with file citations", skill: null, stage: 2, by: "session" },
  "decision-archaeology": { label: "decision archaeology", skill: "onboard", stage: 6, by: "session" },
  architecture: { label: "architecture", skill: "architect", stage: 3, by: "runner" },
  "build-loop": { label: "build loop", skill: "build", stage: 3, by: "runner" },
  reproduce: { label: "reproduce", skill: "debug", stage: 3, by: "runner" },
  "failing-test": { label: "failing test", skill: "debug", stage: 3, by: "runner" },
  fix: { label: "fix", skill: "debug", stage: 3, by: "runner" },
  checks: { label: "checks", skill: null, stage: 3, by: "runner" },
  "pin-behavior": { label: "pin current behavior with tests", skill: "build", stage: 3, by: "runner" },
  "small-steps": { label: "small steps", skill: "build", stage: 3, by: "runner" },
  "same-tests-pass": { label: "same tests pass", skill: null, stage: 3, by: "runner" },
  lanes: { label: "lanes the change touches", skill: null, stage: 4, by: "runner" },
  "architecture-lane": { label: "architecture lane", skill: null, stage: 4, by: "runner" },
  "release-manifest": { label: "release manifest", skill: "ship", stage: 5, by: "runner" },
  rehearsals: { label: "rehearsals", skill: "ship", stage: 5, by: "runner" },
  "broker-deploy": { label: "broker-gated deploy", skill: "ship", stage: 5, by: "runner" },
  "smoke-test": { label: "smoke test", skill: "ship", stage: 5, by: "runner" },
  "preview-deploy": { label: "preview deploy", skill: "ship", stage: 5, by: "runner" },
  report: { label: "report", skill: null, stage: 3, by: "runner" },
} as const satisfies Record<string, StepDef>;
export type StepId = keyof typeof STEPS;
export interface Step extends StepDef { id: StepId }

const Judgment = z.object({
  /** The model's read of the request's type. */
  type: z.enum(TASK_TYPES).optional(),
  /** The model's read of the size. It only raises the tier code reads, within the type's range. */
  tier: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  /** A "bug" whose right behavior was never specified: it needs product decisions (§2's upgrade). */
  missingBehavior: z.boolean().optional(),
  /** The change needs a kind of screen the product doesn't have yet. */
  newScreen: z.boolean().optional(),
  /** A question about the whole repo: map it and reconstruct its decisions. */
  onboarding: z.boolean().optional(),
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
  | "bug-words" | "question-words" | "onboarding-words" | "refactor-words" | "release-words"
  | "tier2-area" | "several-modules" | "one-sentence" | "no-type-words"
  | "judgment" | "judgment-overruled" | "missing-behavior" | "new-screen" | "tier-raised" | "tier-clamped";
export interface Signal { name: SignalName; detail: string }

export interface Triage {
  type: TaskType;
  label: string;
  tier: Tier | null;
  decidedBy: "override" | "empty-folder" | "judgment" | "text" | "default";
  onboarding: boolean;
  /** Intake makes design-direction mockups (through the design skill). */
  mockups: boolean;
  steps: Step[];
  /** §2's "steps that never run" for this pipeline. */
  never: string[];
  /** "after-spec": once the spec is confirmed or defaulted. "now": right after triage. "none": nothing to build. */
  handoff: "after-spec" | "now" | "none";
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
const REFACTOR = /\b(refactor\w*|clean ?up|restructur\w*|reorganiz\w*|simplif(?:y|ies)|extract|rename|dedupe|deduplicate)\b/i;
const RELEASE = /\b(deploy\w*|release|ship it|publish|roll ?back|promote (?:it |the \w+ )?to (?:prod\w*|staging)|go live)\b/i;

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

/** `/jarvis fix the login` → fix. The word counts only when more request follows it. The request stays as typed. */
export function leadingOverride(text: string): Override | undefined {
  return /^\s*(fix|build|feature|ask)(?::\s*|\s+)\S/i.exec(text)?.[1]!.toLowerCase() as Override | undefined;
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
  const words = { bug: hit(BUG), question: hit(QUESTION), onboarding: hit(ONBOARDING), refactor: hit(REFACTOR), release: hit(RELEASE) };
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

  // The request's words alone.
  const reading: TaskType | undefined =
    (words.onboarding || words.question) && !input.attachedError && errorLine === undefined ? "question"
      : words.bug || input.attachedError || errorLine !== undefined ? "bug"
        : words.refactor ? "refactor"
          : words.release ? "release"
            : undefined;

  let type: TaskType;
  let decidedBy: Triage["decidedBy"];
  if (j.type !== undefined || j.reason !== undefined) add("judgment", [j.type, j.reason].filter((x) => x !== undefined).join(": "));
  if (input.override !== undefined) {
    type = OVERRIDES[input.override];
    decidedBy = "override";
    add("override", `you said ${input.override}`);
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
    if (decidedBy === "override") add("missing-behavior", `the model read missing behavior, but your override (${input.override}) wins; the fix records the behavior it picks as an assumption`);
    else if (type === "bug" || (type === "feature" && decidedBy === "judgment" && reading === "bug")) {
      upgraded = true;
      type = "feature";
      add("missing-behavior", "the right behavior was never specified: it needs product decisions");
    }
  }

  const onboarding = type === "question" && (words.onboarding !== undefined || j.onboarding === true);
  const designStep = type === "new-product" || (type === "feature" && j.newScreen === true && !input.folder.designMd);
  if (type === "feature" && j.newScreen === true) add("new-screen", input.folder.designMd ? "a new kind of screen, inside the existing DESIGN.md" : "a new kind of screen and no DESIGN.md: design direction and mockups");

  // Decision 37's tier: code reads a floor, the model may raise it, the type bounds it.
  const range = TIERS[type];
  let tier: Tier | null = null;
  if (range) {
    const risky = areas.length > 0 || several !== undefined;
    let t: Tier = type === "new-product" ? 2 : type === "feature" ? (risky ? 2 : 1) : type === "bug" ? (risky || sentences > 1 ? 1 : 0) : 1;
    if (j.tier !== undefined && j.tier > t) {
      if (j.tier > range[1]) add("tier-clamped", `the model read tier ${j.tier}; a ${type} is at most tier ${range[1]}`);
      else add("tier-raised", `the model raised tier ${t} to ${j.tier}`);
      t = Math.min(j.tier, range[1]) as Tier;
    }
    tier = Math.max(range[0], Math.min(range[1], t)) as Tier;
  }

  const pipeline = pipelineFor(type, { designStep, onboarding });
  const label = type === "question" && onboarding ? "Onboarding" : LABELS[type];
  const upgrade = upgraded ? { from: "bug" as const, to: "feature" as const, announcement: upgradeSentence(tier === 2, j.questions) } : null;
  const runs = pipeline.steps.map((s) => (s.id === "intake" ? `intake ${designStep ? "with" : "(no"} mockups${designStep ? "" : ")"}` : s.label)).join(" → ");
  const headline = [
    upgrade?.announcement,
    `${label}${tier === null ? "" : `, tier ${tier}`}${decidedBy === "override" ? ` (your override: ${input.override})` : ""}.`,
    `Runs: ${runs}.`,
    pipeline.never.length ? `Never: ${pipeline.never.join(", ")}.` : undefined,
  ].filter((x) => x !== undefined).join(" ");

  return { type, label, tier, decidedBy, onboarding, mockups: designStep, ...pipeline, signals, upgrade, headline };
}

const LABELS: Record<TaskType, string> = {
  "new-product": "New product", feature: "Feature", bug: "Bug", refactor: "Refactor", question: "Question", release: "Release / ops",
};

function upgradeSentence(big: boolean, questions: number | undefined): string {
  const count = questions === undefined ? "" : questions === 0 ? ": no questions" : `: ${questions} question${questions === 1 ? "" : "s"}`;
  return `This looks like missing behavior, not a bug. Treating it as ${big ? "a feature" : "a small feature"}${count}.`;
}

/** §2's table: the steps each pipeline runs, the ones it never runs, and when the runner takes over. */
function pipelineFor(type: TaskType, o: { designStep: boolean; onboarding: boolean }): Pick<Triage, "steps" | "never" | "handoff"> {
  const steps = (...ids: StepId[]): Step[] => ids.map((id) => ({ id, ...STEPS[id] }));
  switch (type) {
    case "new-product":
      return { steps: steps("research", "intake", "spec", "design", "architecture", "build-loop", "lanes", "preview-deploy", "report"), never: [], handoff: "after-spec" };
    case "feature":
      return o.designStep
        ? { steps: steps("register-check", "spike", "intake", "spec", "design", "build-loop", "lanes", "report"), never: [], handoff: "after-spec" }
        : { steps: steps("register-check", "spike", "intake", "spec", "build-loop", "lanes", "report"), never: ["mockups", "design direction"], handoff: "after-spec" };
    case "bug":
      return { steps: steps("reproduce", "failing-test", "fix", "checks", "lanes", "report"), never: ["intake", "mockups", "design", "architecture"], handoff: "now" };
    case "refactor":
      return { steps: steps("pin-behavior", "small-steps", "same-tests-pass", "architecture-lane"), never: ["intake", "design"], handoff: "now" };
    case "question":
      return { steps: o.onboarding ? steps("read-only-research", "answer", "decision-archaeology") : steps("read-only-research", "answer"), never: ["any edit"], handoff: "none" };
    case "release":
      return { steps: steps("release-manifest", "rehearsals", "broker-deploy", "smoke-test"), never: ["building"], handoff: "now" };
  }
}
