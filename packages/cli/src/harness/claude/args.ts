import { FULL_MODEL_ID } from "../../config/pins.ts";

/**
 * Command-line arguments for a task session (architecture §5; decisions 3, 59, 60, 61, 68).
 *
 * --restricted ignores user, project and local settings files (only --settings and
 * managed settings apply), confines the file tools to the working directories, refuses
 * bypassPermissions, and leaves writes to settings, git and tool-config files to a person,
 * which in dontAsk mode means they are refused. It also removes command-running tools
 * unless --tools names them, so the tool list is explicit.
 */
export const BUILD_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"] as const;
export type BuildTool = (typeof BUILD_TOOLS)[number];

export interface TaskArgsInput {
  prompt: string;
  settingsPath: string;
  mcpConfigPath: string;
  model: string;
  maxTurns: number;
  tools?: readonly BuildTool[];
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
  "--setting-sources",
  "--allowedTools",
  "--allowed-tools",
  "--agents",
  "--chrome",
];

export function buildTaskArgs(input: TaskArgsInput): string[] {
  if (!FULL_MODEL_ID.test(input.model)) throw new Error(`model must be a full model ID, not an alias: ${input.model}`);
  if (!Number.isInteger(input.maxTurns) || input.maxTurns < 1) throw new Error(`maxTurns must be a positive integer, got ${input.maxTurns}`);
  const tools = input.tools ?? BUILD_TOOLS;
  const args = [
    "-p",
    input.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--restricted",
    "--tools",
    tools.join(","),
    "--settings",
    input.settingsPath,
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
    if (v.length !== 1 || v[0] !== value) throw new Error(`task args must contain exactly one ${flag} ${value}; found ${JSON.stringify(v)}`);
  };
  require("--permission-mode", "dontAsk");
  require("--permission-prompts", "none");
  require("--output-format", "stream-json");
  if (args.filter((a) => a === "--restricted").length !== 1) throw new Error("task args must contain --restricted exactly once");
  const tools = valuesOf(args, "--tools");
  if (tools.length !== 1) throw new Error("task args must contain exactly one --tools list");
  const list = (tools[0] ?? "").split(",");
  if (list.length === 0 || list.some((t) => !(BUILD_TOOLS as readonly string[]).includes(t))) {
    throw new Error(`--tools may only name ${BUILD_TOOLS.join(", ")}; got ${tools[0]}`);
  }
  for (const flag of ["--strict-mcp-config", "--no-session-persistence", "--settings", "--mcp-config"]) {
    if (!args.includes(flag)) throw new Error(`task args must contain ${flag}`);
  }
  for (const flag of FORBIDDEN_FLAGS) {
    if (args.some((a) => a === flag || a.startsWith(`${flag}=`))) throw new Error(`task args must not contain ${flag}`);
  }
  return [...args];
}
