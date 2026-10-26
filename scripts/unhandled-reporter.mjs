// A Vitest reporter for the mutation check (backlog #11, Codex stage 0 review 5): the JSON reporter
// leaves out standalone unhandled errors and how the run ended, so this records both. It also records
// the real name of every failure raised inside a .rejects/.resolves chain: Vitest rewrites those stacks
// to "Error: <message>", so the JSON report alone can't tell a failed matcher from a runtime error.
import { writeFileSync } from "node:fs";
import { VITEST_PROMISE_FRAME, promiseErrorKey } from "./mutation-classify.mjs";

/** Failure-message key (as the JSON report shows it) -> error name, for errors under Vitest's promise frame. */
function promiseErrorNames(modules) {
  const names = {};
  for (const m of modules ?? []) {
    for (const test of m.children.allTests()) {
      for (const e of test.result().errors ?? []) {
        const message = e?.stack || e?.message;
        if (typeof message !== "string" || !VITEST_PROMISE_FRAME.test(message)) continue;
        const key = promiseErrorKey(message);
        const name = typeof e.name === "string" ? e.name : "unknown";
        // Two errors with one message but different names: neither is trusted as an assertion.
        names[key] = key in names && names[key] !== name ? "conflicting names" : name;
      }
    }
  }
  return names;
}

export default class UnhandledReporter {
  onTestRunEnd(modules, unhandledErrors, reason) {
    const out = process.env.JARVIS_RUN_END_OUT;
    if (!out) return;
    const errors = unhandledErrors ?? [];
    writeFileSync(out, JSON.stringify({ reason, unhandled: errors.length, messages: errors.map((e) => String(e?.message ?? e).slice(0, 200)), promiseErrors: promiseErrorNames(modules) }));
  }
}
