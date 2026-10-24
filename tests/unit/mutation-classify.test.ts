import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without types
import { classify, isAssertionFailure, summarize, testIds } from "../../scripts/mutation-classify.mjs";

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
    expect(s.line).toBe("partial run: 3 of 10 mutations selected, all 3 caught (not a complete proof)");
    expect(s.exitCode).toBe(0);
  });
  it("refuses a filter that selects nothing", () => {
    expect(summarize({ total: 10, selected: 0, filtered: true, results: [] })).toEqual({ line: "no mutation matches the filter", exitCode: 2 });
  });
  it("counts errors and survivors as not caught", () => {
    const s = summarize({ total: 3, selected: 3, filtered: false, results: [...caught(1), "SURVIVED m1 (all tests passed)", "ERROR    m2: anchor not found in f"] });
    expect(s).toEqual({ line: "2 mutation(s) not caught", exitCode: 1 });
  });
});
