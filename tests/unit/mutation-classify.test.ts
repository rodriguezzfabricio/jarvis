import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without types
import { classify, isAssertionFailure, testIds } from "../../scripts/mutation-classify.mjs";

const file = (assertions: object[], message = "") => ({ name: "/r/tests/unit/x.test.ts", message, status: "failed", assertionResults: assertions });
const t = (title: string, status: string, failureMessages: string[] = []) => ({ title, fullName: `s ${title}`, status, failureMessages });
const report = (assertions: object[], extra: object = {}) => ({ success: false, testResults: [file(assertions)], ...extra });
const ok = { status: 0, signal: null };
const fail = { status: 1, signal: null };
const control = testIds(report([t("a", "passed"), t("b", "passed")]));

describe("mutation classification (Codex reviews 2, 3)", () => {
  it("counts a real assertion failure as caught", () => {
    const r = report([t("a", "failed", ["AssertionError: expected false to be true"]), t("b", "passed")]);
    expect(classify(fail, r, control).kind).toBe("caught");
  });

  it("counts a failed .rejects expectation as caught", () => {
    const r = report([t("a", "failed", ['Error: promise resolved "{ x: 1 }" instead of rejecting\n    at _Assertion.__VITEST_REJECTS__ (file:///x)']), t("b", "passed")]);
    expect(classify(fail, r, control).kind).toBe("caught");
  });

  it("treats timeouts as errors, not catches", () => {
    const r = report([t("a", "failed", ["Error: Test timed out in 20000ms."]), t("b", "failed", ["Error: Test timed out in 20000ms."])]);
    expect(classify(fail, r, control).kind).toBe("error");
  });

  it("treats a killed suite, a spawn error and a missing report as errors", () => {
    expect(classify({ status: null, signal: "SIGKILL" }, report([t("a", "passed"), t("b", "passed")], { success: true }), control).kind).toBe("error");
    expect(classify({ status: null, signal: null, error: new Error("ENOENT") }, undefined, control).kind).toBe("error");
    expect(classify(fail, undefined, control).kind).toBe("error");
  });

  it("treats collection and file-level errors as errors", () => {
    const r = { success: false, testResults: [file([], "SyntaxError: Unexpected token")] };
    expect(classify(fail, r, control).kind).toBe("error");
  });

  it("treats a failed suite with no failed test (unhandled error) as an error", () => {
    expect(classify(fail, report([t("a", "passed"), t("b", "passed")]), control).kind).toBe("error");
  });

  it("treats different test identities as an error", () => {
    const r = report([t("a", "failed", ["AssertionError: x"]), t("c", "passed")]);
    expect(classify(fail, r, control).kind).toBe("error");
  });

  it("treats non-assertion failures as errors", () => {
    expect(classify(fail, report([t("a", "failed", ["TypeError: cannot read properties of undefined"]), t("b", "passed")]), control).kind).toBe("error");
  });

  // Codex review 4, medium.
  it("does not count a matcher-named runtime error as an assertion", () => {
    expect(isAssertionFailure("TypeError: expect(...).toBe is not a function")).toBe(false);
    expect(classify(fail, report([t("a", "failed", ["TypeError: expect(...).toBe is not a function"]), t("b", "passed")]), control).kind).toBe("error");
  });

  it("does not accept a run that mixes an assertion with a runtime error", () => {
    const r = report([t("a", "failed", ["AssertionError: expected 1 to be 2"]), t("b", "failed", ["ReferenceError: x is not defined"])]);
    expect(classify(fail, r, control).kind).toBe("error");
  });

  it("does not accept unfinished tests or a mismatched exit status", () => {
    expect(classify(fail, report([t("a", "failed", ["AssertionError: x"]), t("b", "pending")]), control).kind).toBe("error");
    expect(classify(ok, report([t("a", "failed", ["AssertionError: x"]), t("b", "passed")]), control).kind).toBe("error");
  });

  it("requires the .rejects message and Vitest's assertion frame together", () => {
    expect(isAssertionFailure('Error: promise resolved "x" instead of rejecting\n    at _Assertion.__VITEST_REJECTS__ (file:///x)')).toBe(true);
    expect(isAssertionFailure('Error: promise resolved "x" instead of rejecting\n    at somewhere (file:///x)')).toBe(false);
  });

  it("reports survivors and clean control runs", () => {
    const r = report([t("a", "passed"), t("b", "passed")], { success: true });
    expect(classify(ok, r, control).kind).toBe("survived");
    expect(classify(ok, r, undefined).kind).toBe("clean");
  });
});
