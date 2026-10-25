// Classifies one Vitest run for the mutation check (Codex stage 0 reviews 2 and 3).
// "caught" needs: a normal process exit (no signal or spawn error), a JSON report, no file-level
// errors (collection or unhandled), the same test identities as the control run, and at least one
// failed test whose failure is an assertion, not a timeout or a runner error.
import { createHash } from "node:crypto";

const TIMEOUT = /test timed out|timed out in \d+ms/i;

/** Vitest's frame on every error raised in a .rejects/.resolves chain, whose stack it rewrites to "Error: <message>". */
export const VITEST_PROMISE_FRAME = /\bat _Assertion\.__VITEST_(REJECTS|RESOLVES)__/;

/** The run-end record's key for a failure message, exactly as the JSON report shows it (unhandled-reporter.mjs). */
export function promiseErrorKey(message) {
  return createHash("sha256").update(message).digest("hex");
}

/**
 * True only for a completed assertion: Chai/Vitest's AssertionError, or Vitest's own .rejects/.resolves
 * assertion (its message AND its _Assertion stack frame). No matcher-name substrings: a
 * "TypeError: expect(...).toBe is not a function" is a runtime error (Codex review 4).
 * Inside a .rejects/.resolves chain Vitest shows every error as "Error: <message>", a failed matcher and a
 * runtime error alike, so there only the reporter's record of the error's real name (`promiseErrors`,
 * from the run-end record) can make it an assertion.
 */
export function isAssertionFailure(message, promiseErrors) {
  const first = message.split("\n")[0] ?? "";
  if (/^AssertionError\b/.test(first)) return true;
  if (!VITEST_PROMISE_FRAME.test(message)) return false;
  if (/instead of (rejecting|resolving)$/.test(first)) return true;
  return promiseErrors?.[promiseErrorKey(message)] === "AssertionError";
}

/** An error thrown by Jarvis's own code under test (its stack runs through the source tree). */
export function isSourceError(message) {
  return /\/(packages\/cli\/src|plugin\/hooks)\//.test(message) && !TIMEOUT.test(message);
}

export function testIds(report) {
  return report.testResults.flatMap((f) => f.assertionResults.map((a) => `${f.name.split("/").slice(-2).join("/")} > ${a.fullName}`)).sort();
}

/** Statuses of a test that was deliberately not run (it.skipIf, it.todo): finished, not unfinished. */
const NOT_RUN = new Set(["skipped", "todo"]);

/** The ids (as testIds) of the tests a run skipped, sorted. */
export function skippedIds(report) {
  return report.testResults.flatMap((f) => f.assertionResults.filter((a) => NOT_RUN.has(a.status)).map((a) => `${f.name.split("/").slice(-2).join("/")} > ${a.fullName}`)).sort();
}

/**
 * `control` is the control run's { ids, skipped } (or, as before, a plain id list: no skip allowed).
 * A control may skip tests (an opt-in live test without its environment, round 18); a run judged
 * against it must skip exactly those tests.
 * @returns {{ kind: "clean" | "caught" | "survived" | "error", detail: string }}
 */
export function classify(proc, report, control, runEnd) {
  const controlIds = Array.isArray(control) ? control : control?.ids;
  const controlSkipped = Array.isArray(control) ? [] : control?.skipped ?? [];
  if (proc.error) return { kind: "error", detail: `could not run the suite: ${proc.error.message ?? proc.error}` };
  if (proc.signal) return { kind: "error", detail: `suite killed by ${proc.signal}` };
  if (!report) return { kind: "error", detail: `no JSON report (exit ${proc.status})` };
  // Standalone unhandled errors and interrupted runs never count as a clean catch (backlog #11).
  if (!runEnd) return { kind: "error", detail: "no run-end record (unhandled-reporter missing)" };
  if (runEnd.unhandled > 0) return { kind: "error", detail: `${runEnd.unhandled} unhandled error(s): ${runEnd.messages?.[0] ?? ""}` };
  if (runEnd.reason !== "passed" && runEnd.reason !== "failed") return { kind: "error", detail: `run ended as ${runEnd.reason}` };
  const fileErrors = report.testResults.filter((f) => typeof f.message === "string" && f.message.trim() !== "");
  if (fileErrors.length) return { kind: "error", detail: `file-level errors in ${fileErrors.map((f) => f.name.split("/").pop()).join(", ")}` };
  const ids = testIds(report);
  if (controlIds && (ids.length !== controlIds.length || ids.some((x, i) => x !== controlIds[i]))) {
    return { kind: "error", detail: `ran ${ids.length} tests, not the control's ${controlIds.length}` };
  }
  const skipped = skippedIds(report);
  if (controlIds) {
    const differ = [...skipped.filter((x) => !controlSkipped.includes(x)), ...controlSkipped.filter((x) => !skipped.includes(x))];
    if (differ.length) return { kind: "error", detail: `skipped tests differ from the control's: ${differ.slice(0, 3).join("; ")}` };
  }
  const all = report.testResults.flatMap((f) => f.assertionResults);
  const unfinished = all.filter((a) => a.status !== "passed" && a.status !== "failed" && !NOT_RUN.has(a.status));
  if (unfinished.length) return { kind: "error", detail: `${unfinished.length} test(s) did not finish (${[...new Set(unfinished.map((a) => a.status))].join(", ")})` };
  const failed = all.filter((a) => a.status === "failed");
  if (failed.length === 0) {
    if (proc.status !== 0 || report.success === false) return { kind: "error", detail: `suite failed (exit ${proc.status}) with no failed test: unhandled error?` };
    return controlIds ? { kind: "survived", detail: "all tests passed" } : { kind: "clean", detail: `${ids.length - skipped.length} tests passed${skipped.length ? `, ${skipped.length} skipped` : ""}` };
  }
  if (proc.status !== 1) return { kind: "error", detail: `tests failed but the suite exited ${proc.status}` };
  const timeouts = failed.filter((a) => a.failureMessages.some((m) => TIMEOUT.test(m)));
  if (timeouts.length) return { kind: "error", detail: `${timeouts.length} test(s) timed out` };
  // At least one completed assertion must fail. Other failures are allowed only if they were thrown
  // by Jarvis's own code under test (a safety guard refusing the mutated code); errors from tests,
  // the runner or infrastructure make the run an error (decision 74; Codex review 4).
  const assertion = (m) => isAssertionFailure(m, runEnd.promiseErrors);
  const assertions = failed.filter((a) => a.failureMessages.length > 0 && a.failureMessages.every(assertion));
  const others = failed.filter((a) => !assertions.includes(a));
  const unattributed = others.filter((a) => a.failureMessages.length === 0 || !a.failureMessages.every((m) => assertion(m) || isSourceError(m)));
  if (assertions.length === 0) return { kind: "error", detail: `${failed.length} failure(s), none an assertion: ${(failed[0].failureMessages[0] ?? "").split("\n")[0].slice(0, 80)}` };
  if (unattributed.length) return { kind: "error", detail: `${unattributed.length} failure(s) neither assertions nor thrown by Jarvis code: ${(unattributed[0].failureMessages[0] ?? "").split("\n")[0].slice(0, 80)}` };
  return { kind: "caught", detail: `${assertions.length} failing assertion(s)${others.length ? ` + ${others.length} refused by Jarvis guards` : ""}: ${assertions.slice(0, 2).map((a) => a.title).join("; ")}` };
}

/**
 * The run's last line and exit code. "all N mutations caught" only when no filter was set and every
 * declared mutation ran and was caught; a filtered or incomplete run says it's partial (Codex stage 0
 * review 16) and exits 4, never 0.
 * `unconfirmed` counts catches seen on related tests only, never on the full suite, that the run needed
 * confirmed: such a run is not the gate and exits 3 (Codex review of the subset mutation check). With
 * `scope` (--confirm-stage, decision 94), catches outside the stage may stay in fast mode, and the line
 * says how many were confirmed and how many weren't.
 */
export function summarize({ total, selected, filtered, results, unconfirmed = 0, scope }) {
  if (selected === 0) return { line: "no mutation matches the filter", exitCode: 2 };
  const bad = results.filter((l) => !l.startsWith("caught")).length;
  if (bad) return { line: `${bad} mutation(s) not caught`, exitCode: 1 };
  const partial = filtered || selected !== total;
  if (unconfirmed) {
    const ran = partial ? `partial run: ${selected} of ${total} mutations selected` : `all ${total} ran`;
    if (scope) return { line: `${ran}, ${unconfirmed} of stage ${scope.stage}'s mutations caught on related tests only; not confirmed on the full suite`, exitCode: 3 };
    return { line: `${ran}, ${unconfirmed} caught on related tests only; not confirmed on the full suite (not the gate: JARVIS_MUTATION_CONFIRM=1)`, exitCode: 3 };
  }
  // A filtered or incomplete run never passes, in any mode: the mutations it skipped were never
  // checked, let alone confirmed (Codex review of decision 94). Exit 4: partial run, not the gate.
  const line = partial ? `partial run: ${selected} of ${total} mutations selected, all ${selected} caught (not a complete proof, not the gate)` : `all ${total} mutations caught`;
  const exitCode = partial ? 4 : 0;
  if (scope) return { line: `${line}; stage ${scope.stage}: ${scope.confirmed} confirmed, ${scope.fast} caught in fast mode (outside stage ${scope.stage})`, exitCode };
  return { line, exitCode };
}
