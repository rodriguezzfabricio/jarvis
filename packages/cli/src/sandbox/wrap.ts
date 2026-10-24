import { readFileSync } from "node:fs";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

/**
 * Builds one sandbox wrapper and prints it. Run by `runSandboxed` as a child process whose environment
 * holds only PATH, HOME and the run's TMPDIR: the library reads its own process environment while
 * wrapping (JAVA_TOOL_OPTIONS, proxy settings, CLAUDE_CODE_TMPDIR, GIT_CONFIG_*) and copies values into
 * the command, so the runner's environment must never be the one it sees (Codex stage 0 review 16).
 * Input on stdin: {"config": <SandboxRuntimeConfig>, "command": "<shell command>"}.
 */
const { config, command } = JSON.parse(readFileSync(0, "utf8")) as { config: Parameters<typeof SandboxManager.initialize>[0]; command: string };
await SandboxManager.initialize(config);
try {
  process.stdout.write(await SandboxManager.wrapWithSandbox(command));
} finally {
  await SandboxManager.reset();
}
