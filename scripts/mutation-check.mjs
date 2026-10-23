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
import { classify, testIds } from "./mutation-classify.mjs";

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
  ["placeholder rule exempts short passwords", N, "export function isPlaceholderPassword(raw: string): boolean {\n", "export function isPlaceholderPassword(raw: string): boolean {\n  if (raw.length <= 4) return true;\n"],
  ["snapshot ignores DER private keys", N, "    if (isDerPrivateKey(buf)) {", "    if (false) {"],
  ["session kills only the parent", X, "      process.kill(-child.pid, sig);", "      child.kill(sig);"],
  ["session hides spawn failures", X, "  if (spawnError) {", "  if (false) {"],
  ["scheduler counts unstarted runs", C, "        if (!r.started) {", "        if (false) {"],
  ["scheduler waits right after each run (old bug)", C, "        if (r.usageWaitUntil !== undefined && dispatched < total) pendingWait = { until: r.usageWaitUntil, after: id };", "        if (r.usageWaitUntil !== undefined) { const stop = await wait(id, r.usageWaitUntil, \"usage is high\"); if (stop) return { completed, stopped: { task: id, reason: stop } }; }"],
  ["scheduler skips limited tasks", C, "          continue; // the same task again; waiting is not a failure", "          break;"],
];

const work = mkdtempSync(join(tmpdir(), "jarvis-mut-"));
function runSuite(tag) {
  const out = join(work, `${tag}.json`);
  const proc = spawnSync("pnpm", ["-s", "vitest", "run", "tests/unit", "--reporter=json", `--outputFile=${out}`], { encoding: "utf8", timeout: 300_000 });
  const report = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : undefined;
  return { proc, report };
}

const results = [];
let controlIds;
try {
  const control = runSuite("control");
  const c = classify(control.proc, control.report, undefined);
  if (c.kind !== "clean" || control.proc.status !== 0) {
    console.log(`control run is not clean: ${c.kind}: ${c.detail}`);
    process.exit(2);
  }
  controlIds = testIds(control.report);
  results.push(`control  ${c.detail}`);
  for (const [name, file, from, to] of mutations) {
    const orig = readFileSync(file, "utf8");
    if (!orig.includes(from)) { results.push(`ERROR    ${name}: anchor not found in ${file}`); continue; }
    try {
      writeFileSync(file, orig.replace(from, to));
      const m = runSuite(name.replace(/\W+/g, "-"));
      const k = classify(m.proc, m.report, controlIds);
      results.push(`${k.kind === "caught" ? "caught  " : k.kind === "survived" ? "SURVIVED" : "ERROR   "} ${name} (${k.detail})`);
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
