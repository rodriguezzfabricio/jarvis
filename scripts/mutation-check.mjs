// Breaks each safeguard in turn and checks that the unit suite catches it with failing assertions.
// Evidence for "tests test what they claim" (AGENTS.md; Codex stage 0 reviews 1 and 2).
// A mutation counts as caught only if: the unmodified control run passed, the mutated run collected
// the same number of tests, and at least one assertion failed. Crashes and collection errors are
// errors, never "caught". Every file is restored, even on failure.
// Usage: node scripts/mutation-check.mjs
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const S = "packages/cli/src/harness/claude/settings.ts";
const A = "packages/cli/src/harness/claude/args.ts";
const P = "packages/cli/src/harness/claude/probe.ts";
const J = "packages/cli/src/harness/claude/streamjson.ts";
const X = "packages/cli/src/harness/claude/session.ts";
const B = "packages/cli/src/eval/baseline.ts";
const G = "packages/cli/src/eval/git.ts";
const N = "packages/cli/src/eval/snapshot.ts";
const C = "packages/cli/src/eval/schedule.ts";

const mutations = [
  ["failIfUnavailable off", S, "      failIfUnavailable: true,\n      allowUnsandboxedCommands: false,\n      autoAllowBashIfSandboxed: true,\n      network: {\n        allowedDomains: [...input", "      failIfUnavailable: false,\n      allowUnsandboxedCommands: false,\n      autoAllowBashIfSandboxed: true,\n      network: {\n        allowedDomains: [...input"],
  ["auto-memory on", S, "  const settings: TaskSettings = {\n    autoMemoryEnabled: false,", "  const settings: TaskSettings = {\n    autoMemoryEnabled: true,"],
  ["reads outside worktree allowed", S, "      blockReadsOutsideWorkingDirectories: true,\n    },\n  };", "      blockReadsOutsideWorkingDirectories: false,\n    },\n  };"],
  ["git hooks writable", S, '          join(input.worktree, ".git", "hooks"),\n', ""],
  ["no --restricted", A, '    "--restricted",\n    "--tools",', '    "--tools",'],
  ["web tool allowed", A, 'export const BUILD_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"] as const;', 'export const BUILD_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch"] as const;'],
  ["probe accepts 4xx as blocked", P, 'const blocked = allowedReached && f === "000" && denial;', 'const blocked = allowedReached && f !== "200" && denial;'],
  ["probe ignores sandbox denial record", P, 'const blocked = allowedReached && f === "000" && denial;', 'const blocked = allowedReached && f === "000";'],
  ["probe ignores project hooks", P, 'add("project_hooks_not_run", !existsSync(hookMarker),', 'add("project_hooks_not_run", true,'],
  ["probe ignores outside reads", P, 'add("outside_worktree_not_readable", !all.includes(outsideToken),', 'add("outside_worktree_not_readable", true,'],
  ["probe ignores plugin hooks", P, 'add("jarvis_plugin_hooks_run", existsSync(pluginMarker),', 'add("jarvis_plugin_hooks_run", true,'],
  ["session skips flush wait", X, "  await Promise.all(sinks);\n", ""],
  ["session ignores sink errors", X, '  if (sinkError) throw new EvidenceCaptureError', '  if (false) throw new EvidenceCaptureError'],
  ["baseline skips preflight", B, "  if (!pre.ok) throw new PreflightError", "  if (false) throw new PreflightError"],
  ["baseline shares one cache", B, 'const cacheRoot = join(workRoot, "cache-runs", task.id, runId);', 'const cacheRoot = join(workRoot, "cache-runs", "shared");'],
  ["runner git runs hooks", G, '  "-c", "core.hooksPath=/dev/null",\n', ""],
  ["runner git runs fsmonitor", G, '  "-c", "core.fsmonitor=false",\n', ""],
  ["snapshot ignores credentials", N, "  if (found.length) {", "  if (false) {"],
  ["snapshot ignores inline comments", N, '      const c = line.slice(head.length).search(/\\s#/);', '      const c = -1;'],
  ["snapshot skips binary files", N, "  if (buf.includes(0)) {\n    const le", "  if (false) {\n    const le"],
  ["usage wait ignores windows", J, "  const over = Object.values(last.windows).filter((w) => w.utilization >= threshold);", "  const over: RateLimitWindow[] = [];"],
  ["scheduler skips limited tasks", C, "          continue; // the same task again; waiting is not a failure", "          break;"],
];

const work = mkdtempSync(join(tmpdir(), "jarvis-mut-"));
function runSuite(tag) {
  const out = join(work, `${tag}.json`);
  const r = spawnSync("pnpm", ["-s", "vitest", "run", "tests/unit", "--reporter=json", `--outputFile=${out}`], { encoding: "utf8" });
  if (!existsSync(out)) return { error: `no report (exit ${r.status}): ${(r.stderr || r.stdout).slice(0, 200)}` };
  const j = JSON.parse(readFileSync(out, "utf8"));
  const failedAssertions = j.testResults.flatMap((f) => f.assertionResults).filter((a) => a.status === "failed").length;
  const crashedFiles = j.testResults.filter((f) => f.status === "failed" && !f.assertionResults.some((a) => a.status === "failed")).map((f) => f.name.split("/").pop());
  return { total: j.numTotalTests, failedAssertions, crashedFiles };
}

const results = [];
try {
  const control = runSuite("control");
  if (control.error || control.failedAssertions || control.crashedFiles.length) {
    console.log(`control run is not clean: ${JSON.stringify(control)}`);
    process.exit(2);
  }
  results.push(`control  ${control.total} tests, all passing`);
  for (const [name, file, from, to] of mutations) {
    const orig = readFileSync(file, "utf8");
    if (!orig.includes(from)) { results.push(`ERROR    ${name}: anchor not found in ${file}`); continue; }
    try {
      writeFileSync(file, orig.replace(from, to));
      const m = runSuite(name.replace(/\W+/g, "-"));
      if (m.error) results.push(`ERROR    ${name}: ${m.error}`);
      else if (m.crashedFiles.length) results.push(`ERROR    ${name}: suites crashed without assertions (${m.crashedFiles.join(", ")})`);
      else if (m.total !== control.total) results.push(`ERROR    ${name}: collected ${m.total} tests, control had ${control.total}`);
      else if (m.failedAssertions > 0) results.push(`caught   ${name} (${m.failedAssertions} failing assertions)`);
      else results.push(`SURVIVED ${name}`);
    } finally {
      writeFileSync(file, orig);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(results.join("\n"));
const bad = results.filter((l) => !l.startsWith("caught") && !l.startsWith("control"));
console.log(bad.length ? `\n${bad.length} mutation(s) not caught` : `\nall ${mutations.length} mutations caught`);
process.exitCode = bad.length ? 1 : 0;
