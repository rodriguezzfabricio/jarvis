import type { Command } from "commander";
import { z } from "zod";
import type { DecisionInput } from "./format.ts";
import { DecisionRegister } from "./store.ts";
import { verifyUserAnswer } from "./answer.ts";

const makers: Record<string, DecisionInput["madeBy"]> = {
  user: "fabricio", "default-accepted": "accepted-default", "default-unconfirmed": "unconfirmed-default", jarvis: "jarvis",
};
const classes: Record<string, DecisionInput["class"]> = { mechanical: "Mechanical", taste: "Taste", challenge: "Challenge" };
function mapped<T>(values: Record<string, T>, value: string, flag: string): T {
  if (!Object.hasOwn(values, value)) throw new Error(`Invalid ${flag}: ${value}; choose ${Object.keys(values).join("|")}`);
  return values[value]!;
}
function list(value: string, flag: string): string[] {
  if (value === "-") return [];
  try { return z.array(z.string().refine((item) => item.trim().length > 0)).parse(JSON.parse(value)); }
  catch { throw new Error(`${flag} must be '-' or a JSON array of nonblank strings`); }
}
function decisionId(value: string): number {
  if (!/^D?[1-9]\d*$/i.test(value)) throw new Error("Invalid --supersedes ID; use D1 or 1");
  const id = Number(value.replace(/^d/i, ""));
  if (!Number.isSafeInteger(id)) throw new Error("Invalid --supersedes ID; outside the safe integer range");
  return id;
}
interface Options {
  by: string; class: string; source: string; why: string; repo: string;
  reversibility: string; alternatives: string; dependsOn: string; supersedes?: string; reason?: string; answer?: string; recordedAnswer?: string;
}

/** With --recorded-answer the entry states the decision, led by the answered question's ID, so the register line names the answer it rests on (decision 168). */
function requireStatement(decision: string, reference: string): void {
  const id = reference.slice(reference.indexOf(":") + 1);
  if (!decision.startsWith(`${id}: `) || !decision.slice(id.length + 2).trim()) {
    throw new Error(`With --recorded-answer the decision text states the decision and starts with "${id}: "`);
  }
}

export interface DecideDeps { home?: string }

/** Reversibility levels whose decisions must name what they rejected (decision 171, EGM's Alternatives Rule). */
export const ALTERNATIVES_REQUIRED = ["moderate", "hard", "irreversible"] as const;
const ALTERNATIVE_FORM = /^.{3,}: rejected because .{10,}$/s;
export const ALTERNATIVES_ERROR = "a decision of this reversibility needs at least one alternative, each as '<option>: rejected because <reason>'";
/** A user's answer is its own reason, so `--by user` decisions are exempt. */
export function requireAlternatives(reversibility: string, by: string, alternatives: readonly string[]): void {
  if (by === "user" || !(ALTERNATIVES_REQUIRED as readonly string[]).includes(reversibility)) return;
  if (!alternatives.length || !alternatives.every((item) => ALTERNATIVE_FORM.test(item))) throw new Error(ALTERNATIVES_ERROR);
}

export function register(program: Command, deps: DecideDeps = {}): void {
  program.command("decide")
    .description("Add or supersede a project decision with its provenance")
    .argument("<decision>", "the choice to record")
    .requiredOption("--by <maker>", "user|default-accepted|default-unconfirmed|jarvis")
    .requiredOption("--class <class>", "mechanical|taste|challenge")
    .requiredOption("--source <path>", "existing repo-relative evidence path, optionally with #anchor")
    .requiredOption("--why <reason>", "why this choice was made")
    .option("--repo <dir>", "project directory", process.cwd())
    .option("--reversibility <level>", "reversible|easy|moderate|hard|irreversible", "reversible")
    .option("--alternatives <json>", "JSON array of alternatives, or '-' for none", "-")
    .option("--depends-on <json>", "JSON array of dependent tasks or criteria, or '-' for none", "-")
    .option("--supersedes <id>", "old decision ID (D1 or 1)")
    .option("--reason <reason>", "reason for superseding; required with --supersedes")
    .option("--answer <reference>", "verified explicit intake answer: <answerSeq>:<questionId>; required with --by user")
    .option("--recorded-answer <text>", "the user's exact recorded answer, verified with --answer; the decision text then states the decision, starting with \"<questionId>: \"")
    .action((decision: string, options: Options, command: Command) => {
      try {
        if (options.supersedes !== undefined && !options.reason?.trim()) throw new Error("--reason is required with --supersedes");
        if (options.reason !== undefined && options.supersedes === undefined) throw new Error("--reason requires --supersedes");
        if (!options.why.trim()) throw new Error("--why must not be blank");
        const oldId = options.supersedes === undefined ? undefined : decisionId(options.supersedes);
        if (options.by === "user") verifyUserAnswer(options.repo, options.answer, options.recordedAnswer ?? decision, { ...deps, ...(oldId === undefined ? {} : { supersedes: oldId }) });
        else if (options.answer !== undefined || options.recordedAnswer !== undefined) throw new Error("--answer and --recorded-answer require --by user");
        if (options.recordedAnswer !== undefined) requireStatement(decision, options.answer!);
        requireAlternatives(options.reversibility, options.by, list(options.alternatives, "--alternatives"));
        const exact = options.recordedAnswer === undefined ? "" : `\nExact answer: ${JSON.stringify(options.recordedAnswer)}`;
        const input: DecisionInput = {
          date: new Date().toISOString().slice(0, 10), decision,
          madeBy: mapped(makers, options.by, "--by"), class: mapped(classes, options.class, "--class"),
          source: options.source, why: options.by === "user" ? `${options.why}\nRecorded user answer: ${options.answer}` + exact : options.why, reversibility: options.reversibility as DecisionInput["reversibility"],
          alternatives: list(options.alternatives, "--alternatives"), dependsOn: list(options.dependsOn, "--depends-on"),
        };
        const register = DecisionRegister.open(options.repo);
        const entry = oldId === undefined ? register.add(input) : register.supersede(oldId, input, input.date, options.reason!);
        command.configureOutput().writeOut?.(`D${entry.id}\n`);
      } catch (error) {
        command.error(error instanceof Error ? error.message : String(error));
      }
    });
}
