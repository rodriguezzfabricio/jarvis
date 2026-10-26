// A review that asks for fixes (decision 126): the report path guard, the review session's output as the
// runner reads it (fault injection: no report, a symlink, a hard link, a path outside the checkout), the
// review step's prompt (evidence per finding, "not a problem" said explicitly), the fix plan (one bug task
// per finding, decision 114's exit condition), what the runner says happened to each finding, and the
// report-update task.
import { linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BUG_EXIT_CONDITION, PlanSchema } from "../../packages/cli/src/runner/plan.ts";
import {
  DEFAULT_REVIEW_REPORT, REVIEW_FINDINGS_FILE, ReviewOutputError, findingOutcomes, readReviewOutput, reportPathProblem,
  commitReportOnly, recordedFixYes, REVIEW_FIX_QUESTION, reportTargetProblem, reportUpdateTask, reviewFixPlan, reviewStepEvidence, reviewStepHeader, reviewStepPrompt, reviewStepSkills, runReviewFixes, writeReportFile, type ReviewOutput,
} from "../../packages/cli/src/runner/review-fix.ts";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { loadSkills } from "../../packages/cli/src/runner/session-skills.ts";
import type { RunState, TaskState } from "../../packages/cli/src/runner/state.ts";
import { shortTmp } from "../helpers.ts";

const root = shortTmp("jtrf-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const checkout = () => { const d = join(root, `c${++n}`); mkdirSync(d, { recursive: true }); return d; };
const put = (dir: string, rel: string, text: string) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };

const REQUEST = "Review the mailer before I ship it. Put what you find in REVIEW.md and fix the real problems.";
const finding = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: `problem ${id}`, severity: "high", confidence: "high", file: "src/mail.mjs", line: 12,
  evidence: `The handler at src/server.mjs:30 passes the request body to send(); ${id} is reachable from POST /send.`,
  fix: `Validate the input before send() (${id}).`, ...extra,
});
const findingsJson = (findings: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({
  request: REQUEST, report: "REVIEW.md", findings,
  cleared: [{ file: "src/template.mjs", line: 4, what: "string-built HTML", why: "every value goes through escapeHtml first" }], ...extra,
});
const reportFor = (findings: { id: string; file: string; line: number }[]) =>
  ["# Review", "", ...findings.map((f) => `## ${f.id}: ${f.file}:${f.line}\nSeverity: high.\n`), "## Not a problem", "- src/template.mjs:4: escaped"].join("\n");
/** A checkout where the review session wrote both files. */
function reviewed(findings = [finding("F1"), finding("F2", { file: "src/server.mjs", line: 30, severity: "medium", confidence: "low" })]): string {
  const dir = checkout();
  put(dir, "REVIEW.md", reportFor(findings as { id: string; file: string; line: number }[]));
  put(dir, REVIEW_FINDINGS_FILE, findingsJson(findings));
  return dir;
}

describe("review report path (decision 126)", () => {
  it("accepts plain repo-relative text files, REVIEW.md by default", () => {
    expect(DEFAULT_REVIEW_REPORT).toBe("REVIEW.md");
    for (const ok of ["REVIEW.md", "docs/review.md", "REVIEW-2.markdown", "notes/review.txt"]) expect(reportPathProblem(ok), ok).toBeUndefined();
  });
  it("refuses a path outside the checkout, inside runner or git metadata, or not a text report", () => {
    for (const bad of ["../REVIEW.md", "/tmp/REVIEW.md", "docs/../../x.md", "./REVIEW.md", ".git/REVIEW.md", ".jarvis/REVIEW.md", ".JARVIS/x.md", "a//b.md", "REVIEW", "review.sh", "src\\x.md", "x:y.md", "", `${"a/".repeat(120)}x.md`]) {
      expect(reportPathProblem(bad), bad).toBeDefined();
    }
  });

  // Codex security review, round 1 (highs 1 and 2): a report commit is never gated, so it may never be a file a build,
  // a tool, an agent or Jarvis itself reads, and its name must be one git can't read as a pattern.
  it("refuses build and config inputs, agent and Jarvis files, hidden folders and pattern characters", () => {
    for (const bad of [
      "CMakeLists.txt", "requirements.txt", "requirements-dev.txt", "dev-requirements.txt", "constraints.txt", "src/runtime.txt", "notes.txt", "VERSION.txt",
      "README.md", "docs/README.md", "CHANGELOG.md", "AGENTS.md", "CLAUDE.md", "src/CLAUDE.md", "GEMINI.md", "DESIGN.md", "PRODUCT.md", "SKILL.md", "SECURITY.md", "LICENSE.md", "CONTRIBUTING.md",
      "docs/spec/v2.md", "Docs/Spec/v1.md", ".github/review.md", ".claude/review.md", "docs/.hidden.md", ".review.md",
      "[C]MakeLists.md", "review[1].md", "review*.md", "{a,b}.md", "!review.md",
    ]) {
      expect(reportPathProblem(bad), bad).toBeDefined();
    }
    for (const ok of ["REVIEW.md", "docs/review-security.md", "review.txt", "notes/audit-findings.txt", "reports/2026-10-26.md", "outreach-review.markdown"]) expect(reportPathProblem(ok), ok).toBeUndefined();
  });

  // Round 2 (high 4): a reserved stem with any suffix, in any case, is still the file an agent or tool reads.
  it("refuses every name that starts with a reserved stem, with any suffix and in any case", () => {
    for (const bad of [
      "CLAUDE.local.md", "AGENTS.override.md", "claude.MD", "Agents-notes.md", "agent.md", "GEMINI.local.md", "copilot.md", "Codex.md", "cursor-notes.md", "windsurf.md", "cline.md",
      "SKILL-x.md", "skills.md", "MEMORY.md", "README-old.md", "readme.txt", "CHANGELOG.1.md", "LICENSE-review.md", "SECURITY-REVIEW.markdown", "docs/security-review.md", "DESIGN.v2.md", "product-review.md",
      "team-instructions.md", "my-rules.md", "RULES.md", "review-rules.md", "system-prompt.md", "prompts.md",
    ]) expect(reportPathProblem(bad), bad).toBeDefined();
  });
});

describe("the review session's output, as the runner reads it", () => {
  it("reads the report and the findings, and checks that they agree", () => {
    const out = readReviewOutput(reviewed(), "REVIEW.md");
    expect(out.report).toBe("REVIEW.md");
    expect(out.reportText).toContain("## F1: src/mail.mjs:12");
    expect(out.findings.map((f) => [f.id, f.confidence])).toEqual([["F1", "high"], ["F2", "low"]]);
    expect(out.cleared).toHaveLength(1);
    expect(out.request).toBe(REQUEST);
    expect(out.skipped).toEqual([]);
  });

  it("says so when the review session wrote no report, and starts nothing from its findings", () => {
    const dir = checkout();
    put(dir, REVIEW_FINDINGS_FILE, findingsJson([finding("F1")]));
    const e = (() => { try { readReviewOutput(dir, "REVIEW.md"); } catch (x) { return x; } })();
    expect(e).toBeInstanceOf(ReviewOutputError);
    expect((e as ReviewOutputError).code).toBe("no-report");
    expect((e as Error).message).toMatch(/wrote no report at REVIEW\.md/);
  });

  it("refuses an empty report", () => {
    const dir = reviewed();
    writeFileSync(join(dir, "REVIEW.md"), "  \n");
    expect(() => readReviewOutput(dir, "REVIEW.md")).toThrow(/REVIEW\.md is empty/);
  });

  it("refuses a report that is a symlink, even to a file inside the checkout", () => {
    const dir = reviewed();
    put(dir, "real.md", readFileSync(join(dir, "REVIEW.md"), "utf8"));
    rmSync(join(dir, "REVIEW.md"));
    symlinkSync("real.md", join(dir, "REVIEW.md"));
    expect(() => readReviewOutput(dir, "REVIEW.md")).toThrow(ReviewOutputError);
    try { readReviewOutput(dir, "REVIEW.md"); } catch (e) { expect((e as ReviewOutputError).code).toBe("report-refused"); }
  });

  it("refuses a report reached through a symlinked folder that leads outside the checkout", () => {
    const outside = checkout();
    put(outside, "review.md", reportFor([finding("F1")] as never));
    const dir = checkout();
    symlinkSync(outside, join(dir, "docs"));
    put(dir, REVIEW_FINDINGS_FILE, findingsJson([finding("F1")], { report: "docs/review.md" }));
    expect(() => readReviewOutput(dir, "docs/review.md")).toThrow(/refused/);
  });

  it("refuses a hard-linked report and a report path outside the checkout", () => {
    const dir = reviewed();
    linkSync(join(dir, "REVIEW.md"), join(dir, "copy.md"));
    expect(() => readReviewOutput(dir, "REVIEW.md")).toThrow(/refused/);
    expect(() => readReviewOutput(reviewed(), "../REVIEW.md")).toThrow(/refused/);
  });

  it("refuses findings that are missing, not JSON, off-schema, or name another report", () => {
    const noFindings = reviewed();
    rmSync(join(noFindings, REVIEW_FINDINGS_FILE));
    expect(() => readReviewOutput(noFindings, "REVIEW.md")).toThrow(/findings\.json/);
    const notJson = reviewed();
    writeFileSync(join(notJson, REVIEW_FINDINGS_FILE), "{");
    expect(() => readReviewOutput(notJson, "REVIEW.md")).toThrow(/findings/);
    const extraKey = reviewed();
    writeFileSync(join(extraKey, REVIEW_FINDINGS_FILE), findingsJson([finding("F1", { verdict: "pass" })]));
    expect(() => readReviewOutput(extraKey, "REVIEW.md")).toThrow(/findings/);
    const badSeverity = reviewed();
    writeFileSync(join(badSeverity, REVIEW_FINDINGS_FILE), findingsJson([finding("F1", { severity: "urgent" })]));
    expect(() => readReviewOutput(badSeverity, "REVIEW.md")).toThrow(/findings/);
    const other = reviewed();
    writeFileSync(join(other, REVIEW_FINDINGS_FILE), findingsJson([finding("F1")], { report: "OTHER.md" }));
    expect(() => readReviewOutput(other, "REVIEW.md")).toThrow(/OTHER\.md/);
    const dup = reviewed();
    writeFileSync(join(dup, REVIEW_FINDINGS_FILE), findingsJson([finding("F1"), finding("F1")]));
    expect(() => readReviewOutput(dup, "REVIEW.md")).toThrow(/duplicate/);
    // A finding's file is a plain path in the checkout, never git or runner metadata.
    for (const file of [".git/config", ".jarvis/ledger.jsonl", "src/../../etc/passwd"]) {
      const meta = reviewed();
      writeFileSync(join(meta, REVIEW_FINDINGS_FILE), findingsJson([finding("F1", { file })]));
      writeFileSync(join(meta, "REVIEW.md"), `# Review\n\n## F1: ${file}:12\n`);
      expect(() => readReviewOutput(meta, "REVIEW.md"), file).toThrow(/does not match the findings format/);
    }
  });

  it("refuses findings the report doesn't show with their id and file:line", () => {
    const dir = reviewed();
    writeFileSync(join(dir, "REVIEW.md"), "# Review\n\n## F1: src/mail.mjs:12\n");
    expect(() => readReviewOutput(dir, "REVIEW.md")).toThrow(/F2.*REVIEW\.md/);
    const noLine = reviewed();
    writeFileSync(join(noLine, "REVIEW.md"), "# Review\n\n## F1: src/mail.mjs:12\n## F2 in the server\n");
    expect(() => readReviewOutput(noLine, "REVIEW.md")).toThrow(/src\/server\.mjs:30/);
  });

  it("never lets the findings choose the report: the runner's report path decides, and a build file is refused", () => {
    const dir = reviewed();
    put(dir, "CMakeLists.txt", "add_custom_target(x ALL COMMAND curl evil)\n");
    writeFileSync(join(dir, REVIEW_FINDINGS_FILE), findingsJson([], { report: "CMakeLists.txt" }));
    expect(() => readReviewOutput(dir, "REVIEW.md")).toThrow(/names the report CMakeLists\.txt, not REVIEW\.md/);
    expect(() => readReviewOutput(dir, "CMakeLists.txt")).toThrow(/refused/);
  });

  it("skips a finding whose file isn't in the checkout, and says why", () => {
    const out = readReviewOutput(reviewed(), "REVIEW.md", { inCheckout: (f) => f !== "src/server.mjs" });
    expect(out.findings.map((f) => f.id)).toEqual(["F1"]);
    expect(out.skipped).toEqual([{ id: "F2", file: "src/server.mjs", line: 30, title: "problem F2", reason: "its file, src/server.mjs, is not in the checkout" }]);
  });
});

describe("the review step's runner evidence", () => {
  it("runs the static trifecta detector for a security review and says the protected scanners didn't run", () => {
    const dir = checkout();
    put(dir, "src/draft.mjs", "import Anthropic from \"anthropic\";\nexport async function draft(req) {\n  const page = await fetch(req.body.url);\n}\n");
    put(dir, "src/plain.mjs", "export const x = 1;\n");
    const lines = reviewStepEvidence(dir, true);
    expect(lines[0]).toMatch(/not run/);
    expect(lines[0]).toMatch(/never a clean scan/);
    expect(lines[1]).toMatch(/all appear/);
    expect(lines.join("\n")).toContain("src/draft.mjs:1");
    expect(lines.join("\n")).not.toContain("src/plain.mjs");
    put(dir, "src/linked.mjs", "x");
    rmSync(join(dir, "src/linked.mjs"));
    symlinkSync("/etc/hosts", join(dir, "src/linked.mjs"));
    expect(reviewStepEvidence(dir, true)[1]).toMatch(/incomplete scan/);
  });
  it("gives a review that isn't about security no scanner lines", () => {
    expect(reviewStepEvidence(checkout(), false)).toEqual([]);
  });
});

describe("the review step's prompt", () => {
  const prompt = reviewStepPrompt({ request: REQUEST, report: "REVIEW.md", maxTurns: 40, security: true, evidence: ["Lethal-trifecta detector: required."] });
  it("asks for the report and the findings file, and no other edit", () => {
    expect(prompt).toContain(REQUEST);
    expect(prompt).toContain("REVIEW.md");
    expect(prompt).toContain(REVIEW_FINDINGS_FILE);
    expect(prompt).toMatch(/Change no other file/);
    expect(prompt).toMatch(/file:line/);
    expect(prompt).toMatch(/severity/);
    expect(prompt).toMatch(/proposed fix/i);
    expect(prompt).toContain("Stop after 40 turns");
  });
  it("asks for evidence per finding: the code path and why it is reachable", () => {
    expect(prompt).toMatch(/code path/);
    expect(prompt).toMatch(/reachable/);
    expect(prompt).toMatch(/no reachable path is not a finding/i);
  });
  it("asks to say \"Not a problem\" for suspicious code it checked and cleared", () => {
    expect(prompt).toContain("Not a problem");
    expect(prompt).toMatch(/cleared/);
    expect(prompt).toMatch(/low confidence/i);
  });
  it("shows the runner's evidence, and the security skill only for a security review", () => {
    expect(prompt).toContain("Lethal-trifecta detector: required.");
    expect(prompt).toMatch(/security skill/);
    expect(reviewStepPrompt({ request: REQUEST, report: "REVIEW.md", maxTurns: 40, security: false, evidence: [] })).not.toMatch(/security skill/);
  });
  it("puts the review (and security) skills in the run header as text, framed for a report", () => {
    const skills = [{ name: "review", text: "REVIEW-SKILL-BODY" }, { name: "security", text: "SECURITY-SKILL-BODY" }];
    const header = reviewStepHeader({ runId: "r1", label: "Golden task 03.", skills });
    expect(header).toContain("Jarvis run: r1");
    expect(header).toContain("<skill name=\"review\">\nREVIEW-SKILL-BODY\n</skill>");
    expect(header).toContain("SECURITY-SKILL-BODY");
    expect(header).toMatch(/claims, not evidence/);
    expect(header).toMatch(/no Skill tool/);
  });
});

describe("the fix plan: one bug task per finding (decisions 114, 126)", () => {
  const out = readReviewOutput(reviewed([finding("F1", { severity: "medium" }), finding("F2", { severity: "critical", file: "src/server.mjs", line: 30 }), finding("F3", { confidence: "low", line: 40 })]), "REVIEW.md");
  const fix = reviewFixPlan(out, [{ name: "unit" }, { name: "lint" }])!;

  it("makes one valid task per finding, the unit check and a code review each, highest severity first", () => {
    expect(() => PlanSchema.parse(fix.plan!)).not.toThrow();
    expect(fix.plan!.tasks.map((t) => t.id)).toEqual(["T1", "T2", "T3"]);
    expect(fix.taskOf).toEqual({ F1: "T1", F2: "T2", F3: "T3" });
    expect(fix.updateTaskId).toBe("T4");
    for (const t of fix.plan!.tasks) {
      expect(t).toMatchObject({ requiredChecks: ["unit"], requiredReviews: ["code"], dependencies: [], acceptanceCriteria: [], storyIds: [] });
      expect(t.mayTouch).toBeUndefined();
    }
    const priority = Object.fromEntries(fix.plan!.tasks.map((t) => [t.id, t.priority]));
    expect(priority.T2).toBeGreaterThan(priority.T1!);
    expect(priority.T1).toBeGreaterThan(-Infinity);
  });

  it("gives each task decision 114's bug exit condition for its one finding", () => {
    for (const [i, t] of fix.plan!.tasks.entries()) {
      const id = `F${i + 1}`;
      expect(t.exitCondition).toContain(BUG_EXIT_CONDITION);
      expect(t.exitCondition).toContain(id);
      expect(t.goal).toContain(id);
      for (const other of ["F1", "F2", "F3"].filter((x) => x !== id)) expect(t.goal).not.toContain(`${other}:`);
    }
  });

  it("hands the builder the finding as a claim to confirm first, with its evidence and proposed fix", () => {
    const t1 = fix.plan!.tasks[0]!;
    expect(t1.goal).toContain(REQUEST);
    expect(t1.goal).toContain("src/mail.mjs:12");
    expect(t1.goal).toContain(out.findings[0]!.evidence);
    expect(t1.goal).toContain(out.findings[0]!.fix);
    expect(t1.goal).toMatch(/claim/);
    expect(t1.goal).toMatch(/[Cc]onfirm/);
    expect(t1.goal).toMatch(/Don't edit REVIEW\.md/);
  });

  it("never lets the fix step change code for a low-confidence finding it hasn't confirmed", () => {
    const low = fix.plan!.tasks[2]!;
    expect(low.goal).toMatch(/low confidence/i);
    expect(low.goal).toMatch(/[Ii]f you can't confirm it, change nothing/);
    expect(low.exitCondition).toMatch(/low-confidence finding that can't be confirmed is left unchanged/);
    expect(fix.plan!.tasks[0]!.goal).not.toMatch(/low confidence/i);
  });

  it("carries the request's limits into every fix task's goal and exit condition (the reviewer checks it)", () => {
    const limited = reviewFixPlan(out, [{ name: "unit" }], [], ["make no changes to the public API"])!;
    for (const t of limited.plan!.tasks) {
      expect(t.goal).toContain("The request limits the fixes: \"make no changes to the public API\"");
      expect(t.exitCondition).toContain("keeps the request's limits: \"make no changes to the public API\"");
    }
    expect(fix.plan!.tasks[0]!.goal).not.toMatch(/limits the fixes/);
  });

  it("numbers its tasks after the ledger's own, and keeps the id of a task it already planned", () => {
    const again = reviewFixPlan(out, [{ name: "unit" }], [
      { id: "T1", goal: "an earlier feature", exitCondition: "done" }, { id: "T4" },
      { id: "T9", goal: fix.plan!.tasks[1]!.goal, exitCondition: fix.plan!.tasks[1]!.exitCondition },
    ])!;
    expect(again.plan!.tasks.map((t) => t.id)).toEqual(["T10", "T9", "T11"]);
    expect(again.taskOf).toEqual({ F1: "T10", F2: "T9", F3: "T11" });
    expect(again.updateTaskId).toBe("T12");
  });

  it("needs an installed unit check, and makes no plan when nothing is left to fix", () => {
    expect(() => reviewFixPlan(out, [{ name: "lint" }])).toThrow(/unit/);
    const none = readReviewOutput(reviewed([finding("F1")]), "REVIEW.md", { inCheckout: () => false });
    expect(reviewFixPlan(none, [{ name: "unit" }]).plan).toBeNull();
    const cleared = checkout();
    put(cleared, "REVIEW.md", "# Review\n\nNothing to fix.\n\n## Not a problem\n- src/template.mjs:4\n");
    put(cleared, REVIEW_FINDINGS_FILE, findingsJson([]));
    expect(reviewFixPlan(readReviewOutput(cleared, "REVIEW.md"), [{ name: "unit" }]).plan).toBeNull();
  });
});

const task = (id: string, extra: Partial<TaskState>): TaskState => ({
  id, definition: {} as TaskState["definition"], status: "pending", blockedReason: null, attemptCount: 1, attempts: [], completion: null,
  alternativeSwitches: [], attemptId: "a1", candidateRevision: null, evidence: [], usageWaitUntil: null, interruption: null, ...extra,
});
const stateOf = (tasks: TaskState[]): RunState => ({ tasks: Object.fromEntries(tasks.map((t) => [t.id, t])) } as unknown as RunState);

describe("what happened to each finding, from the runner's records", () => {
  const out = readReviewOutput(reviewed([finding("F1"), finding("F2", { line: 20 }), finding("F3", { line: 30 }), finding("F4", { file: "gone.mjs", line: 1 })]), "REVIEW.md", { inCheckout: (f) => f !== "gone.mjs" });
  const fix = reviewFixPlan(out, [{ name: "unit" }])!;
  const state = stateOf([
    task("T1", { status: "passed", candidateRevision: "a".repeat(40) }),
    task("T2", { status: "passed", candidateRevision: "b".repeat(40) }),
    task("T3", { status: "blocked", blockedReason: "review code needs investigation", candidateRevision: "c".repeat(40) }),
  ]);
  const changed = (rev: string) => (rev.startsWith("a") ? ["src/mail.mjs", "test/mail.test.mjs"] : []);
  const outcomes = findingOutcomes(out, fix, { done: ["T1", "T2"], state, changedFiles: changed });

  it("fixed only when the loop says the task is done and its change touched files", () => {
    expect(outcomes.map((o) => [o.id, o.status, o.task ?? null])).toEqual([
      ["F1", "fixed", "T1"], ["F2", "unchanged", "T2"], ["F3", "not-fixed", "T3"], ["F4", "not-attempted", null],
    ]);
    expect(outcomes[0]!.detail).toContain("src/mail.mjs");
    expect(outcomes[2]!.detail).toContain("review code needs investigation");
    expect(outcomes[3]!.detail).toContain("not in the checkout");
  });

  it("a passed status without the loop's done verdict is not fixed", () => {
    const o = findingOutcomes(out, fix, { done: [], state, changedFiles: changed });
    expect(o.filter((x) => x.status === "fixed")).toEqual([]);
  });

  it("the update task carries the runner's facts and may touch only the report", () => {
    const t = reportUpdateTask(out, outcomes, fix.updateTaskId);
    expect(t.id).toBe("T4");
    expect(t.mayTouch).toEqual(["REVIEW.md"]);
    expect(t).toMatchObject({ requiredChecks: ["unit"], requiredReviews: ["code"], dependencies: [] });
    for (const o of outcomes) expect(t.goal).toContain(o.detail);
    expect(t.goal).toMatch(/runner's facts/);
    expect(t.exitCondition).toContain("F1, F2, F3, F4");
    expect(() => PlanSchema.parse({ tasks: [t] })).not.toThrow();
  });
});

describe("running the fixes, then the report update", () => {
  const out = readReviewOutput(reviewed([finding("F1"), finding("F2", { line: 20 })]), "REVIEW.md");
  const fix = reviewFixPlan(out, [{ name: "unit" }])!;
  const state = stateOf([task("T1", { status: "passed", candidateRevision: "a".repeat(40) }), task("T2", { status: "blocked", blockedReason: "3 failed attempts" })]);

  it("runs the update after the fixes, with the outcomes the fix loop produced", async () => {
    const order: string[] = [];
    const r = await runReviewFixes({
      output: out, fix, state: () => state, changedFiles: () => ["src/mail.mjs"],
      runFixes: async () => { order.push("fixes"); return { status: "blocked", done: ["T1"], blocked: ["T2"] }; },
      runUpdate: async (t) => { order.push(`update ${t.id}`); expect(t.goal).toContain("3 failed attempts"); return { status: "blocked", done: ["T1", "T3"], blocked: ["T2"] }; },
    });
    expect(order).toEqual(["fixes", "update T3"]);
    expect(r.outcomes.map((o) => o.status)).toEqual(["fixed", "not-fixed"]);
    expect(r.updated).toBe(true);
  });

  it("never runs the update when the fix loop throws", async () => {
    let updates = 0;
    await expect(runReviewFixes({
      output: out, fix, state: () => state, changedFiles: () => [],
      runFixes: async () => { throw new Error("worktree vanished"); }, runUpdate: async () => { updates++; return { status: "complete", done: [], blocked: [] }; },
    })).rejects.toThrow(/worktree vanished/);
    expect(updates).toBe(0);
  });
});

describe("writing the report into a checkout", () => {
  it("writes a new report, overwrites a plain one, and refuses symlinks and outside paths", () => {
    const dir = checkout();
    writeReportFile(dir, "docs/review.md", "one\n");
    expect(readFileSync(join(dir, "docs/review.md"), "utf8")).toBe("one\n");
    writeReportFile(dir, "docs/review.md", "two\n");
    expect(readFileSync(join(dir, "docs/review.md"), "utf8")).toBe("two\n");
    const outside = checkout();
    symlinkSync(outside, join(dir, "linked"));
    expect(() => writeReportFile(dir, "linked/review.md", "x")).toThrow(/symlink|plain/);
    symlinkSync(join(outside, "target.md"), join(dir, "REVIEW.md"));
    expect(() => writeReportFile(dir, "REVIEW.md", "x")).toThrow();
    expect(() => readFileSync(join(outside, "target.md"))).toThrow();
    expect(() => writeReportFile(dir, "../REVIEW.md", "x")).toThrow(/refused/);
    const plain = checkout();
    put(plain, "elsewhere.md", "keep\n");
    linkSync(join(plain, "elsewhere.md"), join(plain, "REVIEW.md"));
    expect(() => writeReportFile(plain, "REVIEW.md", "x")).toThrow(/plain file/);
    expect(readFileSync(join(plain, "elsewhere.md"), "utf8")).toBe("keep\n");
  });
});

// Codex security review, round 1 (high 2): git reads a pathspec's [ ] * ? as a pattern unless it is literal, so a report
// named "[C]MakeLists.md" could also commit CMakeLists.md. The commit names the report literally, and is checked to change only it.
describe("committing the report alone", () => {
  const home = () => { const h = join(root, `home${++n}`); mkdirSync(h); return h; };
  function repo(): { dir: string; git: (args: readonly string[]) => string } {
    const dir = checkout();
    const h = home();
    const git = (args: readonly string[]) => safeGit(dir, args, { home: h }).toString().trim();
    put(dir, "CMakeLists.md", "the build's own file\n");
    git(["init", "-q", "-b", "main"]);
    git(["add", "-A"]);
    git(["commit", "-q", "--no-verify", "-m", "start"]);
    return { dir, git };
  }

  it("commits only the literal report path, never a file its name would match as a pattern", () => {
    const { dir, git } = repo();
    put(dir, "CMakeLists.md", "the session's edit\n");
    put(dir, "[C]MakeLists.md", "# Review\n");
    const before = git(["rev-parse", "HEAD"]);
    let rev: string | undefined;
    expect(() => { rev = commitReportOnly(git, "[C]MakeLists.md", "review report"); }).not.toThrow();
    expect(rev).toBeDefined();
    expect(git(["rev-parse", "HEAD^"])).toBe(before);
    expect(git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])).toBe("[C]MakeLists.md");
    expect(git(["show", "HEAD:CMakeLists.md"])).toBe("the build's own file");
    expect(git(["status", "--porcelain"])).toBe("M CMakeLists.md");
  });

  it("undoes a commit that changed anything besides the report, and says so", () => {
    const { dir, git } = repo();
    put(dir, "REVIEW.md", "# Review\n");
    const before = git(["rev-parse", "HEAD"]);
    const sneaky = (args: readonly string[]) => {
      if (args[0] === "commit") { put(dir, "CMakeLists.md", "smuggled\n"); git(["add", "--", "CMakeLists.md"]); return git(["commit", "-q", "--no-verify", "-m", "sneak"]); }
      return git(args);
    };
    expect(() => commitReportOnly(sneaky, "REVIEW.md", "review report")).toThrow(/changed CMakeLists\.md, REVIEW\.md, not only REVIEW\.md/);
    expect(git(["rev-parse", "HEAD"])).toBe(before);
  });

  it("commits nothing when the report is already committed as it stands", () => {
    const { dir, git } = repo();
    put(dir, "REVIEW.md", "# Review\n");
    expect(commitReportOnly(git, "REVIEW.md", "review report")).toBeDefined();
    const head = git(["rev-parse", "HEAD"]);
    expect(commitReportOnly(git, "REVIEW.md", "review report")).toBeUndefined();
    expect(git(["rev-parse", "HEAD"])).toBe(head);
  });
});

describe("the report's target and the opt-in answer (round 3)", () => {
  it("never lets a report replace a file the base revision has, whoever wrote it", () => {
    expect(reportTargetProblem("REVIEW.md", true)).toMatch(/REVIEW\.md already exists in the base revision/);
    expect(reportTargetProblem("REVIEW.md", false)).toBeUndefined();
  });

  it("accepts only the user's confirmed, session-typed yes to the review-fix question", () => {
    const entries = (answer: string, by = "user", confirmed = true, questionId = REVIEW_FIX_QUESTION) => [
      { seq: 5, kind: "notify", actor: "runner", data: { source: "notify", phase: "answer", intakeOwned: true, intakeBy: "session", intakeAnswers: { [questionId]: answer } } },
      { seq: 6, kind: "decision", actor: "runner", data: { source: "intake", answerSeq: 5, questionId, answer, by, confirmed } },
    ] as unknown as Parameters<typeof recordedFixYes>[0];
    expect(recordedFixYes(entries("yes"), "5:review-fix")).toBe(true);
    expect(recordedFixYes(entries("Yes"), "5:review-fix")).toBe(true);
    for (const [label, e, ref] of [
      ["no", entries("no"), "5:review-fix"], ["yes, but…", entries("yes, but only the API"), "5:review-fix"], ["a default", entries("yes", "default-accepted"), "5:review-fix"],
      ["unconfirmed", entries("yes", "user", false), "5:review-fix"], ["another question", entries("yes", "user", true, "Q1"), "5:Q1"], ["a ref to another question", entries("yes"), "5:Q1"], ["a wrong seq", entries("yes"), "6:review-fix"], ["a bad ref", entries("yes"), "five"],
    ] as const) expect(recordedFixYes(e, ref), label).toBe(false);
  });
});

describe("the review step's skills", () => {
  it("are review, plus security for a security review, loaded as text from the Jarvis install", () => {
    expect(reviewStepSkills(false)).toEqual(["review"]);
    expect(reviewStepSkills(true)).toEqual(["review", "security"]);
    const skills = loadSkills(reviewStepSkills(true));
    expect(skills.map((s) => s.name)).toEqual(["review", "security"]);
    expect(skills[0]!.text).toContain("## Report mode");
    expect(skills[0]!.text.startsWith("---")).toBe(false);
  });
  it("refuses a skill name that isn't a plain name", () => {
    for (const bad of ["../build", "review/../x", "Review", ""]) expect(() => loadSkills([bad]), bad).toThrow(/invalid session skill name/);
  });
});

export type { ReviewOutput };
