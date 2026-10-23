import { FULL_MODEL_ID } from "../../config/pins.ts";

/** Command-line arguments for a task session (architecture §5; decisions 3, 59, 60, 61). */
export interface TaskArgsInput {
  prompt: string;
  settingsPath: string;
  mcpConfigPath: string;
  model: string;
  maxTurns: number;
  pluginDir?: string;
  runHeaderPath?: string;
}

const FORBIDDEN_FLAGS = [
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--bare",
  "--add-dir",
  "--continue",
  "--resume",
  "--safe-mode",
];

export function buildTaskArgs(input: TaskArgsInput): string[] {
  if (!FULL_MODEL_ID.test(input.model)) {
    throw new Error(`model must be a full model ID, not an alias: ${input.model}`);
  }
  if (!Number.isInteger(input.maxTurns) || input.maxTurns < 1) {
    throw new Error(`maxTurns must be a positive integer, got ${input.maxTurns}`);
  }
  const args = [
    "-p",
    input.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--settings",
    input.settingsPath,
    "--setting-sources",
    "project",
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--mcp-config",
    input.mcpConfigPath,
    "--strict-mcp-config",
    "--no-session-persistence",
    "--model",
    input.model,
    "--max-turns",
    String(input.maxTurns),
  ];
  if (input.pluginDir) args.push("--plugin-dir", input.pluginDir);
  if (input.runHeaderPath) args.push("--append-system-prompt-file", input.runHeaderPath);
  return assertSafeTaskArgs(args);
}

function valuesOf(args: readonly string[], flag: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === flag) out.push(args[i + 1] ?? "");
    else if (a.startsWith(`${flag}=`)) out.push(a.slice(flag.length + 1));
  });
  return out;
}

/** Throws unless the argument list carries every permanent requirement exactly once. */
export function assertSafeTaskArgs(args: readonly string[]): string[] {
  const require = (flag: string, value: string) => {
    const v = valuesOf(args, flag);
    if (v.length !== 1 || v[0] !== value) {
      throw new Error(`task args must contain exactly one ${flag} ${value}; found ${JSON.stringify(v)}`);
    }
  };
  require("--setting-sources", "project");
  require("--permission-mode", "dontAsk");
  require("--permission-prompts", "none");
  require("--output-format", "stream-json");
  for (const flag of ["--strict-mcp-config", "--no-session-persistence", "--settings", "--mcp-config"]) {
    if (!args.includes(flag)) throw new Error(`task args must contain ${flag}`);
  }
  for (const flag of FORBIDDEN_FLAGS) {
    if (args.some((a) => a === flag || a.startsWith(`${flag}=`))) throw new Error(`task args must not contain ${flag}`);
  }
  return [...args];
}
