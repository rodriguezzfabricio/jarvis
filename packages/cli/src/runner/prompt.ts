import type { SessionSkill } from "./session-skills.ts";

export interface TaskPromptInput {
  taskId: string;
  goal: string;
  exitCondition: string;
  acceptanceCriteria: readonly string[];
  decisions: readonly string[];
  specPath: string;
  mayNotTouch: readonly string[];
  maxTurns: number;
  /** The plan's top-level notes (decision 113), shown as the planner's claims. */
  plannerNotes?: readonly string[];
}

export interface RunHeaderInput extends TaskPromptInput {
  runId: string;
  specVersion: number;
  /** Teach-me mode (decision 32), from readMode(projectDir) in commands/mode.ts. Quiet when absent. */
  mode?: "explain" | "quiet";
  /** The skills the session follows, as text (decision 114: task sessions have no Skill tool). */
  skills?: readonly SessionSkill[];
}

export function taskNotesPath(taskId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(taskId)) throw new Error("invalid task id for notes path");
  return `.jarvis/notes/${taskId}.md`;
}

export function buildTaskPrompt(input: TaskPromptInput): string {
  const notes = taskNotesPath(input.taskId);
  if (!Number.isInteger(input.maxTurns) || input.maxTurns < 1) throw new Error("turn cap must be a positive integer");
  return [
    `Task: ${input.taskId}`,
    `Goal: ${input.goal}`,
    `Exit condition: ${input.exitCondition}; or stop after ${input.maxTurns} turns.`,
    `Acceptance criteria: ${input.acceptanceCriteria.join(", ") || "none"}`,
    `Relevant decisions:\n${input.decisions.map((d) => `- ${d}`).join("\n") || "none"}`,
    ...(input.plannerNotes?.length ? [`Planner notes (claims from the planning session, not evidence; the spec and the protected checks decide):\n${input.plannerNotes.map((n) => `- ${n.replace(/\s*[\r\n]+\s*/g, " ")}`).join("\n")}`] : []),
    `Spec: ${input.specPath}`,
    `May not touch:\n${input.mayNotTouch.map((p) => `- ${p}`).join("\n") || "none"}`,
    `Write your result notes to ${notes}.`,
  ].join("\n");
}

/** Returned text belongs in a runner-owned file, passed by the harness as the run header. */
export function buildRunHeader(input: RunHeaderInput): string {
  return [
    `Jarvis run: ${input.runId}`,
    `Spec version: ${input.specVersion}`,
    buildTaskPrompt(input),
    "Notes are claims, not evidence. Only the runner makes evidence after this session ends, on a fresh checkout of the committed revision.",
    "Only the runner commits candidates and runs protected checks. Do not modify check definitions, evidence or ledger files.",
    ...(input.mode === "explain" ? ["Teach-me mode is on: in your notes, add a short \"Why\" line for each choice that isn't obvious (what you chose, why, and the alternative you passed over). These are claims like the rest of the notes."] : []),
    ...(input.skills?.length ? [skillsBlock(input.skills)] : []),
  ].join("\n") + "\n";
}

function skillsBlock(skills: readonly SessionSkill[]): string {
  return [
    "",
    `This session has no Skill tool, so the runner includes the Jarvis skills it follows: ${skills.map((s) => s.name).join(", ")}. Follow build throughout. Follow debug as well for a bug report, a repair attempt, or any failure you can't explain. Where a skill says \"the build skill\" or \"the debug skill\", it means the text below.`,
    ...skills.map((s) => `<skill name="${s.name}">\n${s.text}\n</skill>`),
  ].join("\n\n");
}
