// Which stage each mutation belongs to, and which ones a run confirms on the full suite (decision 94).
// A stage review confirms its own stage's mutations and runs every other one in fast mode; the v1 close
// confirms everything. A mutation's stage comes from where it is defined. This is the only map.

/** The definition files the mutation check loads, besides its inline list. */
export const DEFINITION_GLOBS = ["packages/cli/src/**/mutations*.json", "tests/unit/*mutations*.json"];

export const STAGES = ["0-1", "2", "3"];

/** Definition source ("inline" or a repo path) -> stage. Exact paths or one folder level, nothing looser. */
const MAP = [
  [/^inline$/, "0-1"],
  [/^packages\/cli\/src\/harness\/claude\/mutations-probe\.json$/, "0-1"],
  [/^packages\/cli\/src\/(decisions|notify|spec|triage|intake)\/mutations[^/]*\.json$/, "2"],
  [/^tests\/unit\/skills-mutations\.json$/, "2"],
  [/^packages\/cli\/src\/runner\/mutations[^/]*\.json$/, "3"],
  [/^tests\/unit\/skills-build-mutations\.json$/, "3"],
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
 * { mode: "stage", stage } (--confirm-stage <stage>). Throws on an unknown stage or on both at once.
 */
export function parseMode(argv, env) {
  const confirm = argv.includes("--confirm") || env.JARVIS_MUTATION_CONFIRM === "1";
  const i = argv.indexOf("--confirm-stage");
  if (i === -1) return confirm ? { mode: "confirm" } : { mode: "fast" };
  const stage = argv[i + 1];
  if (!STAGES.includes(stage)) throw new Error(`--confirm-stage needs a stage: ${STAGES.join(", ")} (got ${stage === undefined ? "nothing" : `"${stage}"`})`);
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
