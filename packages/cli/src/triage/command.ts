import { resolve } from "node:path";
import type { Command } from "commander";
import { readFolder } from "./folder.ts";
import { leadingOverride, triage, type Judgment, type TriageInput } from "./triage.ts";

interface Opts {
  json?: boolean;
  repo: string;
  literal?: boolean;
  override?: string;
  attachedError?: boolean;
  touches: string[];
  judgment?: string;
  judgmentTier?: string;
  missingBehavior?: boolean;
  newScreen?: boolean;
  onboarding?: boolean;
  questions?: string;
  reason?: string;
}

const integer = (flag: string, v: string): number => {
  if (!/^\d+$/.test(v)) throw new Error(`${flag} takes a whole number, not "${v}"`);
  return Number(v);
};

/** `jarvis triage`: the /jarvis command's first step (architecture §2). Exit 0 classified, 2 invalid input. */
export function register(program: Command): void {
  program
    .command("triage")
    .description("Classify a request (architecture §2, decision 37): type, tier, the pipeline steps that run and the ones that never do")
    .argument("<request...>", "the request as typed after /jarvis; a leading fix, build, feature or ask is your override")
    .option("--json", "print JSON")
    .option("--repo <dir>", "the project folder", ".")
    .option("--literal", "the first word is part of the sentence, not an override (\"feature flags are broken\")")
    .option("--override <word>", "fix | build | feature | ask (always wins)")
    .option("--attached-error", "an error, stack trace or issue is attached")
    .option("--touches <path>", "a file the change will likely touch, from a quick search (repeatable)", (v: string, prev: string[]) => [...prev, v], [] as string[])
    .option("--judgment <type>", "the model's read: new-product | feature | bug | refactor | question | release")
    .option("--judgment-tier <n>", "the model's read of the tier (0-2); only raises the tier code reads")
    .option("--missing-behavior", "the model's read: a \"bug\" whose right behavior was never specified")
    .option("--new-screen", "the model's read: the change needs a kind of screen the product doesn't have")
    .option("--onboarding", "the model's read: a question about the whole repo")
    .option("--questions <n>", "product questions the model expects intake to ask (0-7)")
    .option("--reason <text>", "one line on the model's judgment")
    .action((words: string[], opts: Opts) => {
      try {
        const request = words.join(" ").trim();
        const judgment: Judgment = {
          ...(opts.judgment !== undefined ? { type: opts.judgment as NonNullable<Judgment["type"]> } : {}),
          ...(opts.judgmentTier !== undefined ? { tier: integer("--judgment-tier", opts.judgmentTier) as NonNullable<Judgment["tier"]> } : {}),
          ...(opts.missingBehavior ? { missingBehavior: true } : {}),
          ...(opts.newScreen ? { newScreen: true } : {}),
          ...(opts.onboarding ? { onboarding: true } : {}),
          ...(opts.questions !== undefined ? { questions: integer("--questions", opts.questions) } : {}),
          ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
        };
        const override = opts.override ?? (opts.literal ? undefined : leadingOverride(request));
        const folder = readFolder(resolve(opts.repo));
        const input: TriageInput = {
          request,
          folder,
          ...(opts.attachedError ? { attachedError: true } : {}),
          ...(opts.touches.length ? { touches: opts.touches } : {}),
          ...(override !== undefined ? { override: override as NonNullable<TriageInput["override"]> } : {}),
          ...(Object.keys(judgment).length ? { judgment } : {}),
        };
        const t = triage(input);
        if (opts.json) console.log(JSON.stringify({ request, folder, ...t }, null, 2));
        else {
          console.log(t.headline);
          for (const s of t.signals) console.log(`  ${s.name.padEnd(20)} ${s.detail}`);
        }
      } catch (error) {
        const issues = (error as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
        console.error(issues ? `Invalid triage input: ${issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`).join("; ")}` : String(error instanceof Error ? error.message : error));
        process.exitCode = 2;
      }
    });
}
