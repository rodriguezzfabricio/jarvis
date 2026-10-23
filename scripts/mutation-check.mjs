// Breaks each safeguard in turn and checks that the unit suite fails ("caught").
// Evidence for "tests test what they claim" (AGENTS.md rules; Codex stage 0 review 1).
// Usage: node scripts/mutation-check.mjs   (restores every file, even on failure)
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const S = "packages/cli/src/harness/claude/settings.ts";
const A = "packages/cli/src/harness/claude/args.ts";
const P = "packages/cli/src/harness/claude/probe.ts";
const J = "packages/cli/src/harness/claude/streamjson.ts";
const B = "packages/cli/src/eval/baseline.ts";
const G = "packages/cli/src/eval/git.ts";
const N = "packages/cli/src/eval/snapshot.ts";

const mutations = [
  ["failIfUnavailable off", S, "      failIfUnavailable: true,\n      allowUnsandboxedCommands: false,\n      autoAllowBashIfSandboxed: true,\n      network: {\n        allowedDomains: [...input", "      failIfUnavailable: false,\n      allowUnsandboxedCommands: false,\n      autoAllowBashIfSandboxed: true,\n      network: {\n        allowedDomains: [...input"],
  ["auto-memory on", S, "  const settings: TaskSettings = {\n    autoMemoryEnabled: false,", "  const settings: TaskSettings = {\n    autoMemoryEnabled: true,"],
  ["reads outside worktree allowed", S, "      blockReadsOutsideWorkingDirectories: true,\n    },\n  };", "      blockReadsOutsideWorkingDirectories: false,\n    },\n  };"],
  ["git hooks writable", S, '          join(input.worktree, ".git", "hooks"),\n', ""],
  ["no --restricted", A, '    "--restricted",\n    "--tools",', '    "--tools",'],
  ["web tool allowed", A, 'export const BUILD_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"] as const;', 'export const BUILD_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch"] as const;'],
  ["probe accepts 4xx as blocked", P, 'const blocked = allowedReached && f === "000";', 'const blocked = allowedReached && f !== "200";'],
  ["probe ignores project hooks", P, 'add("project_hooks_not_run", !existsSync(hookMarker),', 'add("project_hooks_not_run", true,'],
  ["probe ignores outside reads", P, 'add("outside_worktree_not_readable", !all.includes(outsideToken),', 'add("outside_worktree_not_readable", true,'],
  ["baseline skips preflight", B, '  if (!(await opts.preflight())) throw new Error', '  if (false) throw new Error'],
  ["runner git runs hooks", G, '  "-c", "core.hooksPath=/dev/null",\n', ""],
  ["runner git runs fsmonitor", G, '  "-c", "core.fsmonitor=false",\n', ""],
  ["snapshot ignores credentials", N, "  if (found.length) {", "  if (false) {"],
  ["usage wait ignores windows", J, "  const over = Object.values(last.windows).filter((w) => w.utilization >= threshold);", "  const over: RateLimitWindow[] = [];"],
];

const results = [];
for (const [name, file, from, to] of mutations) {
  const orig = readFileSync(file, "utf8");
  if (!orig.includes(from)) { results.push(`MISSING  ${name}: anchor not found in ${file}`); continue; }
  try {
    writeFileSync(file, orig.replace(from, to));
    const r = spawnSync("pnpm", ["-s", "vitest", "run", "tests/unit"], { encoding: "utf8" });
    const failed = /(\d+) failed/.exec(r.stdout.replace(/\x1b\[[0-9;]*m/g, ""))?.[1] ?? (r.status ? "?" : "0");
    results.push(`${r.status !== 0 ? "caught  " : "SURVIVED"} ${name} (${failed} failing tests)`);
  } finally {
    writeFileSync(file, orig);
  }
}
console.log(results.join("\n"));
const bad = results.filter((l) => !l.startsWith("caught"));
console.log(bad.length ? `\n${bad.length} mutation(s) not caught` : `\nall ${results.length} mutations caught`);
process.exitCode = bad.length ? 1 : 0;
