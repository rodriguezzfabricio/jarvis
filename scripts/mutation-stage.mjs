// Which stage each mutation belongs to, and which ones a run takes (decisions 94 and 129).
// A stage review runs its own stage's mutations, all on the full suite, and nothing else (decision 129
// superseded 94's fast pass over the other stages); the v1 close runs everything. A mutation's stage comes
// from where it is defined. This is the only map.
import { summarize } from "./mutation-classify.mjs";

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
  [/^packages\/cli\/src\/eval\/mutations-hidden\.json$/, "4"], // how hidden checks are installed; found building task 06, the stage 4 proof
  [/^packages\/cli\/src\/checks\/mutations-gate-cleanup\.json$/, "0-1"],
  [/^tests\/unit\/skills-build-mutations\.json$/, "3"],
  [/^packages\/cli\/src\/commands\/mutations-commands\.json$/, "3"],
  [/^packages\/cli\/src\/commands\/mutations-run\.json$/, "3"],
  [/^packages\/cli\/src\/runner\/mutations-usage\.json$/, "6"],
  [/^packages\/cli\/src\/runner\/mutations-review-fix\.json$/, "4"], // a review that asks for fixes (decision 126): golden task 3, the stage 4 proof
  [/^tests\/unit\/skills-stage6-mutations\.json$/, "6"],
  [/^tests\/unit\/snapshot-scanner-backlog-mutations\.json$/, "0-1"],
  [/^packages\/cli\/src\/broker\/mutations-secrets\.json$/, "0-1"], // the secrets reader, with the inline broker mutations (backlog 103)
  // jarvis approvals/approve/reject and the broker's pending list: the stage 1 terminal approval surface (backlog 115).
  [/^packages\/cli\/src\/commands\/mutations-approvals-ui\.json$/, "0-1"],
  [/^packages\/cli\/src\/broker\/mutations-approvals-ui\.json$/, "0-1"],
  // Folder rules.
  [/^packages\/cli\/src\/doctor\/mutations[^/]*\.json$/, "0-1"],
  [/^packages\/cli\/src\/(decisions|notify|spec|triage|intake)\/mutations[^/]*\.json$/, "2"],
  [/^packages\/cli\/src\/runner\/mutations[^/]*\.json$/, "3"],
  [/^packages\/cli\/src\/(review|security|lanes)\/mutations[^/]*\.json$/, "4"],
  [/^packages\/cli\/src\/(release|setup)\/mutations[^/]*\.json$/, "5"],
  [/^packages\/cli\/src\/broker\/adapters\/(?:[^/]+\/)*mutations[^/]*\.json$/, "5"],
];

/** The stage a definition source belongs to, or undefined if it isn't mapped. */
export function stageOf(source) {
  return MAP.find(([re]) => re.test(source))?.[1];
}

/** True if a stage run takes this source's mutations: its own stage's, and anything unmapped (fail safe). */
export function isScoped(source, stage) {
  const s = stageOf(source);
  return s === undefined || s === stage;
}

/** Whether a mutation gets its verdict from the full suite under `mode`. Every mode but the fast default does. */
export function confirmFor(mode) {
  return mode.mode !== "fast";
}

/**
 * The mutations a run takes (decision 129). `mutations` are [name, file, from, to, source]. Fast and confirm
 * runs take all of them. A stage run takes its own stage's and those from definition files not mapped to a
 * stage (so a new, unmapped file still runs in every stage review); the other stages' are not run. `only`
 * (JARVIS_MUTATIONS) narrows further, inside that set. Returns the selection, `scoped` (what the run is
 * meant to cover: a smaller selection is a partial run), `notRun` (other stages' mutations) and `unmapped`
 * (how many of the scoped ones come from unmapped files).
 */
export function planRun(mutations, mode, only) {
  const scoped = mode.mode === "stage" ? mutations.filter((m) => isScoped(m.at(-1), mode.stage)) : mutations;
  const selected = only ? scoped.filter(([name]) => only.test(name)) : scoped;
  return { selected, scoped: scoped.length, notRun: mutations.length - scoped.length, unmapped: scoped.filter((m) => stageOf(m.at(-1)) === undefined).length };
}

/** How many mutations each stage's definitions hold, and how many are in files not mapped to a stage. */
export function stageCounts(mutations) {
  const counts = Object.fromEntries(STAGES.map((stage) => [stage, 0]));
  counts.unmapped = 0;
  for (const m of mutations) counts[stageOf(m.at(-1)) ?? "unmapped"]++;
  return counts;
}

/** "defined 7 mutations: 0-1 2, 2 1, ..., not mapped to a stage 1": the split, in stage order. */
export function definedLine(mutations) {
  const c = stageCounts(mutations);
  return `defined ${mutations.length} mutations: ${STAGES.map((stage) => `${stage} ${c[stage]}`).join(", ")}, not mapped to a stage ${c.unmapped}`;
}

const mutationsOf = (n) =>`${n} mutation${n === 1 ? "" : "s"}`;

/** The start-of-run line: how many mutations the run takes, and (stage run) how many it leaves to other stages' reviews. */
export function planLine(plan, mode) {
  const n = mutationsOf(plan.selected.length);
  if (mode.mode === "stage") {
    const unmapped = plan.unmapped ? `, including ${plan.unmapped} from definition files not mapped to a stage` : "";
    return `runs ${n} on the full suite: stage ${mode.stage}'s${unmapped}; other stages' mutations not run (decision 129): ${plan.notRun}`;
  }
  if (mode.mode === "confirm") return `runs ${n} on the full suite: all of them`;
  return `runs ${n}, each first on the test files that can observe it`;
}

/** "2m 0s": a duration in minutes and seconds. */
export const minutes = (ms) => `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;

/** The estimate printed once the control run has timed the suite: the count times the control's duration, over the jobs. */
export function estimateLine({ count, controlMs, jobs }) {
  const total = Math.round((count * controlMs) / jobs / 60_000);
  const text = total >= 60 ? `${Math.floor(total / 60)}h ${total % 60}m` : `${total}m`;
  return `estimated wall time about ${text}: ${mutationsOf(count)} x ${minutes(controlMs)} control run${jobs > 1 ? ` / ${jobs} jobs` : ""}; a mutated run can take longer`;
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
 * The run's last line and exit code (summarize, mutation-classify.mjs) from what the run planned and found:
 * `results` are the result lines, `verdicts` each mutation's { kind, confirmed }, `filtered` whether
 * JARVIS_MUTATIONS narrowed the run. A stage run's total is the stage's own count, so it can exit 0.
 */
export function runSummary({ mode, plan, filtered, results, verdicts }) {
  const t = tally(verdicts);
  const scope = mode.mode === "stage" ? { stage: mode.stage, confirmed: t.confirmed, notRun: plan.notRun } : undefined;
  return summarize({ total: plan.scoped, selected: plan.selected.length, filtered, results, unconfirmed: t.unconfirmed, scope });
}

/**
 * Counts a run's catches: `unconfirmed` (seen on related tests only; it blocks the run in every mode, and
 * only the fast default can produce one) and `confirmed`. Each verdict is { kind, confirmed }.
 */
export function tally(verdicts) {
  const caught = verdicts.filter((v) => v.kind === "caught");
  const open = caught.filter((v) => !v.confirmed);
  return { unconfirmed: open.length, confirmed: caught.length - open.length };
}
