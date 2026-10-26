// Which stage each mutation belongs to, and which ones a run confirms on the full suite (decision 94).
// A stage review confirms its own stage's mutations and runs every other one in fast mode; the v1 close
// confirms everything. A mutation's stage comes from where it is defined. This is the only map.

/** The definition files the mutation check loads, besides its inline list. */
export const DEFINITION_GLOBS = ["packages/cli/src/**/mutations*.json", "tests/unit/*mutations*.json"];

export const STAGES = ["0-1", "2", "3", "4", "5", "6"];

/**
 * Definition source ("inline" or a repo path) -> stage, first match wins: exact paths first, then
 * folder rules (one folder level, or broker/adapters at any depth). Paths of lanes that haven't
 * landed yet are mapped ahead too: the alarm test only checks files that are loaded.
 */
const MAP = [
  // Exact paths, ahead of any folder rule they would also match.
  [/^inline$/, "0-1"],
  [/^packages\/cli\/src\/harness\/claude\/mutations-probe\.json$/, "0-1"],
  [/^packages\/cli\/src\/harness\/claude\/mutations-settings\.json$/, "0-1"],
  [/^tests\/unit\/skills-mutations\.json$/, "2"],
  [/^packages\/cli\/src\/eval\/mutations-jarvis\.json$/, "3"],
  [/^packages\/cli\/src\/eval\/mutations-network\.json$/, "0-1"],
  [/^packages\/cli\/src\/checks\/mutations-gate-cleanup\.json$/, "0-1"],
  [/^tests\/unit\/skills-build-mutations\.json$/, "3"],
  [/^packages\/cli\/src\/commands\/mutations-commands\.json$/, "3"],
  [/^packages\/cli\/src\/commands\/mutations-run\.json$/, "3"],
  [/^packages\/cli\/src\/runner\/mutations-usage\.json$/, "6"],
  [/^tests\/unit\/skills-stage6-mutations\.json$/, "6"],
  [/^tests\/unit\/snapshot-scanner-backlog-mutations\.json$/, "0-1"],
  [/^packages\/cli\/src\/broker\/mutations-secrets\.json$/, "0-1"], // the secrets reader, with the inline broker mutations (backlog 103)
  // Folder rules.
  [/^packages\/cli\/src\/doctor\/mutations[^/]*\.json$/, "0-1"],
  [/^packages\/cli\/src\/(decisions|notify|spec|triage|intake)\/mutations[^/]*\.json$/, "2"],
  [/^packages\/cli\/src\/runner\/mutations[^/]*\.json$/, "3"],
  [/^packages\/cli\/src\/toolchain\/mutations[^/]*\.json$/, "3"], // the sessions' pinned Go, found by the stage 3 evals (decision 123)
  [/^packages\/cli\/src\/(review|security|lanes)\/mutations[^/]*\.json$/, "4"],
  [/^packages\/cli\/src\/(release|setup)\/mutations[^/]*\.json$/, "5"],
  [/^packages\/cli\/src\/broker\/adapters\/(?:[^/]+\/)*mutations[^/]*\.json$/, "5"],
];

/** The stage a definition source belongs to, or undefined if it isn't mapped. */
export function stageOf(source) {
  return MAP.find(([re]) => re.test(source))?.[1];
}

/** True if a stage-scoped run confirms this source's mutations: its own stage, and anything unmapped (fail safe). */
export function isScoped(source, stage) {
  const s = stageOf(source);
  return s === undefined || s === stage;
}

/** Whether a mutation from `source` gets its verdict from the full suite under `mode`. */
export function confirmFor(mode, source) {
  if (mode.mode === "confirm") return true;
  if (mode.mode === "stage") return isScoped(source, mode.stage);
  return false;
}

/**
 * The run's mode: { mode: "fast" }, { mode: "confirm" } (--confirm or JARVIS_MUTATION_CONFIRM=1) or
 * { mode: "stage", stage } (--confirm-stage <stage> or --confirm-stage=<stage>). Every argument is
 * parsed: an unknown option, a stray value, a repeated flag, an unknown stage or both modes at once
 * throw (Codex review of decision 94).
 */
export function parseMode(argv, env) {
  let confirm = false;
  let stage;
  const seen = new Set();
  const once = (flag) => {
    if (seen.has(flag)) throw new Error(`${flag} may be given only once`);
    seen.add(flag);
  };
  const checkStage = (value) => {
    if (!STAGES.includes(value)) throw new Error(`--confirm-stage needs a stage: ${STAGES.join(", ")} (got ${value === undefined ? "nothing" : `"${value}"`})`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--confirm") {
      once("--confirm");
      confirm = true;
    } else if (arg === "--confirm-stage") {
      once("--confirm-stage");
      stage = checkStage(argv[++i]);
    } else if (arg.startsWith("--confirm-stage=")) {
      once("--confirm-stage");
      stage = checkStage(arg.slice("--confirm-stage=".length));
    } else {
      throw new Error(`unknown argument "${arg}": use --confirm or --confirm-stage <${STAGES.join("|")}>`);
    }
  }
  if (env.JARVIS_MUTATION_CONFIRM === "1") confirm = true;
  if (stage === undefined) return confirm ? { mode: "confirm" } : { mode: "fast" };
  if (confirm) throw new Error("use one of --confirm (everything) and --confirm-stage <stage>");
  return { mode: "stage", stage };
}

/**
 * Counts a run's catches: `unconfirmed` (catches seen on related tests only that block the run: any in
 * fast mode, the scoped ones in stage mode), `fast` (unconfirmed catches outside the stage, allowed) and
 * `confirmed`. Each verdict is { kind, confirmed, scoped }.
 */
export function tally(verdicts, mode) {
  const caught = verdicts.filter((v) => v.kind === "caught");
  const open = caught.filter((v) => !v.confirmed);
  const blocking = mode.mode === "stage" ? open.filter((v) => v.scoped) : open;
  return { unconfirmed: blocking.length, fast: open.length - blocking.length, confirmed: caught.length - open.length };
}
