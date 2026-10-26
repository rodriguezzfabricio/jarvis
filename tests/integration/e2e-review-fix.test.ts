import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareProductionRun } from "../../packages/cli/src/commands/run-compose.ts";
import { register } from "../../packages/cli/src/commands/run.ts";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { runSession } from "../../packages/cli/src/proc/session.ts";
import { REVIEW_FINDINGS_FILE } from "../../packages/cli/src/runner/review-fix.ts";
import { createE2EProject, sessionCalls, type E2EProject } from "./e2e-helpers.ts";

// `jarvis run --plan review` end to end on the fake claude, through the production composition and the real
// loop, gate and promotion (decision 126): the interactive review's report is committed, the one finding's
// bug task fixes it, then a second loop run's report-update task writes the runner's facts into the report.
const { Command } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("commander") as { Command: new () => Parameters<typeof register>[0] };
const projects: E2EProject[] = [];
afterEach(() => projects.splice(0).forEach((p) => p.cleanup()));
const put = (root: string, rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };

const REQUEST = "Review the adder and fix the real problems.";
const HEADING = "## F1: src/add.mjs:2 (high)";
const SCENARIO = {
  description: "T1 fixes the review's one finding; T2 records its status in the report.",
  sessions: [
    { name: "T1-fix", task: "T1", steps: [
      { write: "src/add.mjs", lines: ["/** Returns the sum of two numbers, read as numbers. */", "export function add(a, b) {", "  return Number(a) + Number(b);", "}"] },
      { notes: "Confirmed F1 with string inputs; add() now reads its arguments as numbers." },
    ] },
    { name: "T2-report", task: "T2", steps: [
      { edit: "REVIEW.md", old: HEADING, new: `${HEADING}\nStatus: Fixed by T1.` },
      { notes: "Recorded the runner's facts in REVIEW.md." },
    ] },
  ],
};

describe("e2e: jarvis run --plan review", { timeout: 600_000 }, () => {
  it("commits the review's report, fixes its finding through the gate and review, then records what happened in the report", async () => {
    const p = createE2EProject({ scenario: SCENARIO }); projects.push(p);
    put(p.repoPath, "REVIEW.md", `# Review\n\n${HEADING}\nadd() concatenates strings. Fix: read both as numbers.\n\n## Not a problem\n- test/add.test.mjs:1: imports only node:test\n`);
    put(p.repoPath, REVIEW_FINDINGS_FILE, JSON.stringify({ request: REQUEST, report: "REVIEW.md", cleared: [],
      findings: [{ id: "F1", title: "add() concatenates strings", severity: "high", confidence: "high", file: "src/add.mjs", line: 2, evidence: "A CLI passes argv strings to add().", fix: "Read both arguments as numbers." }] }));
    const output: string[] = [];
    const program = new Command().exitOverride();
    register(program, {
      jarvisHome: p.jarvisHome, cwd: p.repoPath, env: { JARVIS_PROJECT: p.projectId }, output: (t) => output.push(t), keepAwake: () => {},
      probe: async () => ({ ok: true }),
      prepareRun: (context) => prepareProductionRun(context, {
        home: p.home, preflight: async () => true, reprobe: async () => true, createReview: () => async () => "pass", warn: () => {},
        harness: { binaryRealpath: () => p.claudeBin, session: (spec) => runSession({ ...spec, bin: p.claudeBin }), parentEnv: { HOME: p.home, USER: "e2e", LANG: "en_US.UTF-8" } },
      }),
    });
    await program.parseAsync(["run", "--plan", "review"], { from: "user" });

    expect(output).toEqual(["Run complete: 2 done, 0 blocked"]);
    expect(sessionCalls(p).map((c) => [c.session, c.task])).toEqual([["T1-fix", "T1"], ["T2-report", "T2"]]);
    // The fix session got the finding and decision 114's exit condition; the update session got the runner's facts.
    const [fix, update] = sessionCalls(p);
    expect(fix!.prompt).toContain("Fix finding F1 from the review in REVIEW.md");
    expect(fix!.prompt).toContain("on every path that produces it");
    expect(update!.prompt).toMatch(/F1 \(src\/add\.mjs:2, add\(\) concatenates strings\): fixed\. T1 passed the protected checks and the code review, and was merged; its change touched src\/add\.mjs\./);
    expect(update!.prompt).toContain("May touch only: REVIEW.md");

    // Done (decision 16): each task reached "passed" at a revision whose unit gate the runner recorded as a pass.
    const entries = p.ledger.entries();
    const data = (e: (typeof entries)[number]) => e.data as { state?: string; revision?: string; check?: string; status?: string };
    for (const id of ["T1", "T2"]) {
      const passed = entries.find((e) => e.kind === "state_reached" && e.task_id === id && data(e).state === "passed");
      expect(passed, id).toBeDefined();
      expect(entries.some((e) => e.kind === "gate_result" && e.task_id === id && data(e).check === "unit" && data(e).status === "pass" && data(e).revision === data(passed!).revision), id).toBe(true);
    }
    const show = (path: string) => safeGit(p.repoPath, ["show", `refs/heads/${p.runBranch}:${path}`], { home: p.gitHome }).toString();
    expect(show("src/add.mjs")).toContain("Number(a) + Number(b)");
    expect(show("REVIEW.md")).toContain(`${HEADING}\nStatus: Fixed by T1.`);
    // The report reached the branch as the review session wrote it, in the runner's own commit, before any fix.
    const log = safeGit(p.repoPath, ["log", "--format=%s", `refs/heads/${p.runBranch}`], { home: p.gitHome }).toString();
    expect(log).toContain("review report REVIEW.md (written by the review session)");
  });
});
