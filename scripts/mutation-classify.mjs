// Classifies one Vitest run for the mutation check (Codex stage 0 reviews 2 and 3).
// "caught" needs: a normal process exit (no signal or spawn error), a JSON report, no file-level
// errors (collection or unhandled), the same test identities as the control run, and at least one
// failed test whose failure is an assertion, not a timeout or a runner error.

const TIMEOUT = /test timed out|timed out in \d+ms/i;

/**
 * True only for a completed assertion: Chai/Vitest's AssertionError, or Vitest's own .rejects/.resolves
 * assertion (its message AND its _Assertion stack frame). No matcher-name substrings: a
 * "TypeError: expect(...).toBe is not a function" is a runtime error (Codex review 4).
 */
export function isAssertionFailure(message) {
  const first = message.split("\n")[0] ?? "";
  if (/^AssertionError\b/.test(first)) return true;
  return /instead of (rejecting|resolving)$/.test(first) && /\bat _Assertion\.__VITEST_(REJECTS|RESOLVES)__/.test(message);
}

export function testIds(report) {
  return report.testResults.flatMap((f) => f.assertionResults.map((a) => `${f.name.split("/").slice(-2).join("/")} > ${a.fullName}`)).sort();
}

/** @returns {{ kind: "clean" | "caught" | "survived" | "error", detail: string }} */
export function classify(proc, report, controlIds) {
  if (proc.error) return { kind: "error", detail: `could not run the suite: ${proc.error.message ?? proc.error}` };
  if (proc.signal) return { kind: "error", detail: `suite killed by ${proc.signal}` };
  if (!report) return { kind: "error", detail: `no JSON report (exit ${proc.status})` };
  const fileErrors = report.testResults.filter((f) => typeof f.message === "string" && f.message.trim() !== "");
  if (fileErrors.length) return { kind: "error", detail: `file-level errors in ${fileErrors.map((f) => f.name.split("/").pop()).join(", ")}` };
  const ids = testIds(report);
  if (controlIds && (ids.length !== controlIds.length || ids.some((x, i) => x !== controlIds[i]))) {
    return { kind: "error", detail: `ran ${ids.length} tests, not the control's ${controlIds.length}` };
  }
  const all = report.testResults.flatMap((f) => f.assertionResults);
  const unfinished = all.filter((a) => a.status !== "passed" && a.status !== "failed");
  if (unfinished.length) return { kind: "error", detail: `${unfinished.length} test(s) did not finish (${[...new Set(unfinished.map((a) => a.status))].join(", ")})` };
  const failed = all.filter((a) => a.status === "failed");
  if (failed.length === 0) {
    if (proc.status !== 0 || report.success === false) return { kind: "error", detail: `suite failed (exit ${proc.status}) with no failed test: unhandled error?` };
    return controlIds ? { kind: "survived", detail: "all tests passed" } : { kind: "clean", detail: `${ids.length} tests passed` };
  }
  if (proc.status !== 1) return { kind: "error", detail: `tests failed but the suite exited ${proc.status}` };
  const timeouts = failed.filter((a) => a.failureMessages.some((m) => TIMEOUT.test(m)));
  if (timeouts.length) return { kind: "error", detail: `${timeouts.length} test(s) timed out` };
  // Every failure must be a completed assertion; a mix with runtime errors is not a clean catch.
  const nonAssertion = failed.filter((a) => a.failureMessages.length === 0 || !a.failureMessages.every(isAssertionFailure));
  if (nonAssertion.length) return { kind: "error", detail: `${nonAssertion.length} failure(s) not assertions: ${(nonAssertion[0].failureMessages[0] ?? "").split("\n")[0].slice(0, 80)}` };
  return { kind: "caught", detail: `${failed.length} failing assertion(s): ${failed.slice(0, 2).map((a) => a.title).join("; ")}` };
}
