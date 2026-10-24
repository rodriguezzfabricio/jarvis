import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without types
import { classify, isAssertionFailure, summarize, testIds } from "../../scripts/mutation-classify.mjs";
// @ts-expect-error plain .mjs script without types
import { parseMode, tally } from "../../scripts/mutation-stage.mjs";

const file = (assertions: object[], message = "") => ({ name: "/r/tests/unit/x.test.ts", message, status: "failed", assertionResults: assertions });
const t = (title: string, status: string, failureMessages: string[] = []) => ({ title, fullName: `s ${title}`, status, failureMessages });
const report = (assertions: object[], extra: object = {}) => ({ success: false, testResults: [file(assertions)], ...extra });
const ok = { status: 0, signal: null };
const ended = (reason = "failed") => ({ reason, unhandled: 0, messages: [] });
const fail = { status: 1, signal: null };
const control = testIds(report([t("a", "passed"), t("b", "passed")]));

describe("mutation classification (Codex reviews 2, 3)", () => {
  it("counts a real assertion failure as caught", () => {
    const r = report([t("a", "failed", ["AssertionError: expected false to be true"]), t("b", "passed")]);
    expect(classify(fail, r, control, ended()).kind).toBe("caught");
  });

  it("counts a failed .rejects expectation as caught", () => {
    const r = report([t("a", "failed", ['Error: promise resolved "{ x: 1 }" instead of rejecting\n    at _Assertion.__VITEST_REJECTS__ (file:///x)']), t("b", "passed")]);
    expect(classify(fail, r, control, ended()).kind).toBe("caught");
  });

  it("treats timeouts as errors, not catches", () => {
    const r = report([t("a", "failed", ["Error: Test timed out in 20000ms."]), t("b", "failed", ["Error: Test timed out in 20000ms."])]);
    expect(classify(fail, r, control, ended()).kind).toBe("error");
  });

  it("treats a killed suite, a spawn error and a missing report as errors", () => {
    expect(classify({ status: null, signal: "SIGKILL" }, report([t("a", "passed"), t("b", "passed")], { success: true }), control).kind).toBe("error");
    expect(classify({ status: null, signal: null, error: new Error("ENOENT") }, undefined, control, ended()).kind).toBe("error");
    expect(classify(fail, undefined, control, ended()).kind).toBe("error");
  });

  it("treats collection and file-level errors as errors", () => {
    const r = { success: false, testResults: [file([], "SyntaxError: Unexpected token")] };
    expect(classify(fail, r, control, ended()).kind).toBe("error");
  });

  it("treats a failed suite with no failed test (unhandled error) as an error", () => {
    expect(classify(fail, report([t("a", "passed"), t("b", "passed")]), control, ended()).kind).toBe("error");
  });

  it("treats different test identities as an error", () => {
    const r = report([t("a", "failed", ["AssertionError: x"]), t("c", "passed")]);
    expect(classify(fail, r, control, ended()).kind).toBe("error");
  });

  it("treats non-assertion failures as errors", () => {
    expect(classify(fail, report([t("a", "failed", ["TypeError: cannot read properties of undefined"]), t("b", "passed")]), control, ended()).kind).toBe("error");
  });

  // Codex review 4, medium.
  it("does not count a matcher-named runtime error as an assertion", () => {
    expect(isAssertionFailure("TypeError: expect(...).toBe is not a function")).toBe(false);
    expect(classify(fail, report([t("a", "failed", ["TypeError: expect(...).toBe is not a function"]), t("b", "passed")]), control, ended()).kind).toBe("error");
  });

  it("does not accept a run that mixes an assertion with an unattributed runtime error", () => {
    const r = report([t("a", "failed", ["AssertionError: expected 1 to be 2"]), t("b", "failed", ["ReferenceError: x is not defined\n    at tests/unit/x.test.ts:3:1"])]);
    expect(classify(fail, r, control, ended()).kind).toBe("error");
  });

  it("accepts an assertion plus errors thrown by Jarvis's own guards, but not guard errors alone", () => {
    const guard = "ZodError: [ invalid literal ]\n    at buildTaskSettings (/r/packages/cli/src/harness/claude/settings.ts:99:5)";
    expect(classify(fail, report([t("a", "failed", ["AssertionError: expected [Function] to not throw"]), t("b", "failed", [guard])]), control, ended()).kind).toBe("caught");
    expect(classify(fail, report([t("a", "failed", [guard]), t("b", "failed", [guard])]), control, ended()).kind).toBe("error");
  });

  it("does not accept unfinished tests or a mismatched exit status", () => {
    expect(classify(fail, report([t("a", "failed", ["AssertionError: x"]), t("b", "pending")]), control, ended()).kind).toBe("error");
    expect(classify(ok, report([t("a", "failed", ["AssertionError: x"]), t("b", "passed")]), control, ended()).kind).toBe("error");
  });

  it("requires the .rejects message and Vitest's assertion frame together", () => {
    expect(isAssertionFailure('Error: promise resolved "x" instead of rejecting\n    at _Assertion.__VITEST_REJECTS__ (file:///x)')).toBe(true);
    expect(isAssertionFailure('Error: promise resolved "x" instead of rejecting\n    at somewhere (file:///x)')).toBe(false);
  });

  // Backlog #11 (Codex review 5, medium): standalone unhandled errors.
  it("treats a missing run-end record, unhandled errors or an interrupted run as errors", () => {
    const r = report([t("a", "failed", ["AssertionError: x"]), t("b", "passed")]);
    expect(classify(fail, r, control, undefined).kind).toBe("error");
    expect(classify(fail, r, control, { reason: "failed", unhandled: 1, messages: ["boom"] }).kind).toBe("error");
    expect(classify(fail, r, control, { reason: "interrupted", unhandled: 0, messages: [] }).kind).toBe("error");
    expect(classify(fail, r, control, ended()).kind).toBe("caught");
  });

  it("sees an unhandled rejection next to a real assertion failure in an actual Vitest run", async () => {
    const { spawnSync } = await import("node:child_process");
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const d = mkdtempSync(join(tmpdir(), "jarvis-unhandled-"));
    const proc = spawnSync("./node_modules/.bin/vitest", ["run", "--config", "scripts/fixtures/unhandled/vitest.config.mjs", "--reporter=json", `--outputFile=${join(d, "r.json")}`, "--reporter=./scripts/unhandled-reporter.mjs"], {
      encoding: "utf8",
      env: { ...process.env, JARVIS_RUN_END_OUT: join(d, "end.json") },
      timeout: 60_000,
    });
    const rep = JSON.parse(readFileSync(join(d, "r.json"), "utf8"));
    const end = JSON.parse(readFileSync(join(d, "end.json"), "utf8"));
    expect(end.unhandled).toBeGreaterThan(0);
    expect(classify(proc, rep, testIds(rep), end).kind).toBe("error");
  }, 60_000);

  it("reports survivors and clean control runs", () => {
    const r = report([t("a", "passed"), t("b", "passed")], { success: true });
    expect(classify(ok, r, control, ended("passed")).kind).toBe("survived");
    expect(classify(ok, r, undefined, ended("passed")).kind).toBe("clean");
  });
});

// Codex stage 0 review 16, lane D: a filtered run printed "all N mutations caught" for N it never ran.
describe("mutation run summary", () => {
  const caught = (n: number) => Array.from({ length: n }, (_, i) => `caught   m${i} (1 failing assertion(s): t)`);
  it("claims complete coverage only when every declared mutation ran and was caught", () => {
    expect(summarize({ total: 3, selected: 3, filtered: false, results: caught(3) })).toEqual({ line: "all 3 mutations caught", exitCode: 0 });
  });
  it("marks a filtered run as partial, never as complete", () => {
    const s = summarize({ total: 10, selected: 3, filtered: true, results: caught(3) });
    expect(s.line).not.toMatch(/^all \d+ mutations caught/);
    expect(s.line).toBe("partial run: 3 of 10 mutations selected, all 3 caught (not a complete proof, not the gate)");
    // Codex review of decision 94, critical: a filtered run never exits 0, in any mode.
    expect(s.exitCode).toBe(4);
  });
  it("refuses a filter that selects nothing", () => {
    expect(summarize({ total: 10, selected: 0, filtered: true, results: [] })).toEqual({ line: "no mutation matches the filter", exitCode: 2 });
  });
  it("counts errors and survivors as not caught", () => {
    const s = summarize({ total: 3, selected: 3, filtered: false, results: [...caught(1), "SURVIVED m1 (all tests passed)", "ERROR    m2: anchor not found in f"] });
    expect(s).toEqual({ line: "2 mutation(s) not caught", exitCode: 1 });
  });

  // Codex review of the subset mutation check, critical: a catch on related tests only is not the gate.
  it("never passes a run whose catches weren't confirmed on the full suite", () => {
    const s = summarize({ total: 3, selected: 3, filtered: false, results: caught(3), unconfirmed: 2 });
    expect(s).toEqual({ line: "all 3 ran, 2 caught on related tests only; not confirmed on the full suite (not the gate: JARVIS_MUTATION_CONFIRM=1)", exitCode: 3 });
    expect(s.line).not.toMatch(/^all \d+ mutations caught/);
    const p = summarize({ total: 10, selected: 3, filtered: true, results: caught(3), unconfirmed: 3 });
    expect(p).toEqual({ line: "partial run: 3 of 10 mutations selected, 3 caught on related tests only; not confirmed on the full suite (not the gate: JARVIS_MUTATION_CONFIRM=1)", exitCode: 3 });
  });
  it("still reports misses first when some catches are unconfirmed", () => {
    expect(summarize({ total: 3, selected: 3, filtered: false, results: [...caught(2), "SURVIVED m2 (all tests passed)"], unconfirmed: 2 })).toEqual({ line: "1 mutation(s) not caught", exitCode: 1 });
  });
  // Decision 94: --confirm-stage confirms one stage's mutations and runs the rest in fast mode.
  it("passes a stage-scoped run only when everything was caught, and says what was confirmed", () => {
    expect(summarize({ total: 5, selected: 5, filtered: false, results: caught(5), unconfirmed: 0, scope: { stage: "0-1", confirmed: 3, fast: 2 } })).toEqual({ line: "all 5 mutations caught; stage 0-1: 3 confirmed, 2 caught in fast mode (outside stage 0-1)", exitCode: 0 });
  });
  // Codex review of decision 94, critical: JARVIS_MUTATIONS left the stage's other mutations unconfirmed, yet exited 0.
  it("never passes a filtered or incomplete run, whichever mode selected the confirmation", () => {
    const partial = "partial run: 3 of 10 mutations selected, all 3 caught (not a complete proof, not the gate)";
    expect(summarize({ total: 10, selected: 3, filtered: true, results: caught(3), unconfirmed: 0, scope: { stage: "2", confirmed: 1, fast: 2 } })).toEqual({ line: `${partial}; stage 2: 1 confirmed, 2 caught in fast mode (outside stage 2)`, exitCode: 4 });
    // --confirm and JARVIS_MUTATION_CONFIRM=1 select the same mode, and a filtered run under it is partial too.
    for (const mode of [parseMode(["--confirm"], {}), parseMode([], { JARVIS_MUTATION_CONFIRM: "1" })]) {
      const t = tally([{ kind: "caught", confirmed: true, scoped: true }, { kind: "caught", confirmed: true, scoped: true }, { kind: "caught", confirmed: true, scoped: true }], mode);
      expect(summarize({ total: 10, selected: 3, filtered: true, results: caught(3), unconfirmed: t.unconfirmed })).toEqual({ line: partial, exitCode: 4 });
    }
    // Incomplete without a filter (fewer ran than were declared) is partial as well.
    expect(summarize({ total: 10, selected: 9, filtered: false, results: caught(9) }).exitCode).toBe(4);
  });
  it("fails a stage-scoped run on a survivor outside the stage", () => {
    expect(summarize({ total: 3, selected: 3, filtered: false, results: [...caught(2), "SURVIVED m2 (all tests passed) [full suite, after 2 test files survived]"], unconfirmed: 0, scope: { stage: "3", confirmed: 1, fast: 1 } })).toEqual({ line: "1 mutation(s) not caught", exitCode: 1 });
  });
  it("never passes a stage-scoped run with a scoped catch on related tests only", () => {
    const s = summarize({ total: 3, selected: 3, filtered: false, results: caught(3), unconfirmed: 1, scope: { stage: "2", confirmed: 1, fast: 1 } });
    expect(s).toEqual({ line: "all 3 ran, 1 of stage 2's mutations caught on related tests only; not confirmed on the full suite", exitCode: 3 });
  });
  it("passes only when every catch is confirmed", () => {
    expect(summarize({ total: 3, selected: 3, filtered: false, results: caught(3), unconfirmed: 0 })).toEqual({ line: "all 3 mutations caught", exitCode: 0 });
  });
});
