import { homedir } from "node:os";
import { join } from "node:path";
import { projectId } from "../config/project.ts";
import { Ledger, type LedgerEntry } from "../ledger/ledger.ts";
import { roundSchema } from "../intake/round.ts";

type Data = Record<string, unknown>;
const data = (entry: LedgerEntry | undefined): Data => entry && entry.data !== null && typeof entry.data === "object" ? entry.data as Data : {};

/** A reference cannot authorize different words or a supersession that its question never raised. */
export function verifyUserAnswer(repo: string, reference: string | undefined, decision: string, options: { home?: string; supersedes?: number } = {}): void {
  const match = reference && /^([1-9]\d*):(.+)$/.exec(reference);
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error("--by user requires --answer <answerSeq>:<questionId> from a recorded user answer");
  const seq = Number(match[1]); const id = match[2]!;
  const entries = Ledger.open(join(options.home ?? homedir(), ".jarvis", "projects", projectId(repo))).entries();
  const intent = entries.find((entry) => entry.seq === seq);
  const recorded = entries.find((entry) => entry.kind === "decision" && data(entry).source === "intake" && data(entry).answerSeq === seq && data(entry).questionId === id);
  const value = data(recorded); const supplied = data(intent).intakeAnswers;
  if (!recorded || value.by !== "user" || value.confirmed !== true || !intent || intent.kind !== "notify"
    || data(intent).source !== "notify" || data(intent).phase !== "answer" || data(intent).intakeOwned !== true || data(intent).intakeBy !== "session"
    || value.requestId !== data(intent).requestId || !supplied || typeof supplied !== "object" || !Object.hasOwn(supplied, id)
    || (supplied as Data)[id] !== value.answer) throw new Error("Reference does not identify a recorded explicit user answer");
  const round = entries.find((entry) => entry.kind === "notify" && data(entry).source === "intake" && data(entry).phase === "round" && data(entry).requestId === value.requestId && data(entry).round === value.round);
  const snapshot = roundSchema.parse(data(round).snapshot);
  const question = snapshot.questions.find((question) => question.id === id);
  if (!question || decision !== value.answer) throw new Error("User decisions must quote the exact recorded answer");
  if (options.supersedes !== undefined && !new RegExp(`\\bD${options.supersedes}\\b`, "i").test(`${question.question}\n${decision}`)) {
    throw new Error(`Recorded answer does not identify superseded decision D${options.supersedes}`);
  }
}
