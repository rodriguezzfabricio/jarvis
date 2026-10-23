import { execFileSync } from "node:child_process";

/**
 * Git as the runner uses it inside agent-writable folders. The agent can't write .git/hooks
 * or .git/config (sandbox denyWrite + --restricted), but the runner never trusts that alone:
 * hooks, fsmonitor and global/system config are switched off on every call.
 */
const SAFE_CONFIG = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "core.untrackedCache=false",
  "-c", "commit.gpgsign=false",
  "-c", "protocol.file.allow=never",
];

export function runnerGitEnv(home: string): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "jarvis-runner",
    GIT_AUTHOR_EMAIL: "runner@jarvis.invalid",
    GIT_COMMITTER_NAME: "jarvis-runner",
    GIT_COMMITTER_EMAIL: "runner@jarvis.invalid",
  };
}

export function safeGit(cwd: string, args: readonly string[], opts: { home: string; input?: Buffer; env?: Record<string, string> } ): Buffer {
  return execFileSync("git", [...SAFE_CONFIG, ...args], { cwd, input: opts.input, env: { ...runnerGitEnv(opts.home), ...(opts.env ?? {}) }, maxBuffer: 1024 ** 3 });
}
