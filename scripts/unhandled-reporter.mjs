// A Vitest reporter for the mutation check (backlog #11, Codex stage 0 review 5): the JSON reporter
// leaves out standalone unhandled errors and how the run ended, so this records both.
import { writeFileSync } from "node:fs";

export default class UnhandledReporter {
  onTestRunEnd(_modules, unhandledErrors, reason) {
    const out = process.env.JARVIS_RUN_END_OUT;
    if (!out) return;
    const errors = unhandledErrors ?? [];
    writeFileSync(out, JSON.stringify({ reason, unhandled: errors.length, messages: errors.map((e) => String(e?.message ?? e).slice(0, 200)) }));
  }
}
