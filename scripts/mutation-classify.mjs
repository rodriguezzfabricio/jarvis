// Classifies one Vitest run for the mutation check (Codex stage 0 reviews 2 and 3).
// "caught" needs: a normal process exit (no signal or spawn error), a JSON report, no file-level
// errors (collection or unhandled), the same test identities as the control run, and at least one
// failed test whose failure is an assertion, not a timeout or a runner error.

const TIMEOUT = /test timed out|timed out in \d+ms/i;
// Vitest reports .rejects/.resolves failures as "promise resolved … instead of rejecting" from its _Assertion code.
const ASSERTION = /AssertionError|expected .+ to |toThrow|toEqual|toBe|toContain|toMatch|instead of (rejecting|resolving)|_Assertion\./;

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
  const failed = report.testResults.flatMap((f) => f.assertionResults).filter((a) => a.status === "failed");
  if (failed.length === 0) {
    if (proc.status !== 0 || report.success === false) return { kind: "error", detail: `suite failed (exit ${proc.status}) with no failed test: unhandled error?` };
    return controlIds ? { kind: "survived", detail: "all tests passed" } : { kind: "clean", detail: `${ids.length} tests passed` };
  }
  const timeouts = failed.filter((a) => a.failureMessages.some((m) => TIMEOUT.test(m)));
  const assertions = failed.filter((a) => !timeouts.includes(a) && a.failureMessages.some((m) => ASSERTION.test(m)));
  const other = failed.filter((a) => !timeouts.includes(a) && !assertions.includes(a));
  if (timeouts.length) return { kind: "error", detail: `${timeouts.length} test(s) timed out` };
  if (assertions.length === 0) return { kind: "error", detail: `${other.length} failure(s), none an assertion` };
  return { kind: "caught", detail: `${assertions.length} failing assertion(s): ${assertions.slice(0, 2).map((a) => a.title).join("; ")}` };
}
