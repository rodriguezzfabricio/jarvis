import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionUsage } from "../harness/claude/usage.ts";
import { parseStreamJson } from "../harness/claude/streamjson.ts";
import { formatDuration, formatTokens } from "../runner/usage-log.ts";

/**
 * `jarvis eval compare <task>`: both arms of a golden task, run for run, from the per-run folders in
 * ~/.jarvis/evals/<task>/<run>/ (decisions 35, 47). Nothing here is estimated: a figure a run didn't
 * record shows as "-", an ungraded run as "ungraded", and an unrated one as "-".
 *
 * "Beats the baseline" (decision 47: "on your rating and the false-done rate") is decided only from
 * counted runs, and only under the definition proposed with this arm (see BEATS_RULE).
 */

export type Arm = "baseline" | "jarvis";
export interface RunRow {
  arm: Arm;
  runId: string;
  /** Counted toward the comparison: a started run that finished (usage-limited and crashed-before-start runs are retried, not counted). */
  counted: boolean;
  /** Why a run isn't counted, or the arm's outcome. */
  outcome: string;
  hidden: "pass" | "fail" | "ungraded";
  /** The grading suite's fingerprint (hidden.ts suiteFingerprint); null when ungraded. */
  suite: string | null;
  claimedDone: boolean | null;
  falseDone: boolean | null;
  wallMs: number | null;
  /** Time spent waiting out usage limits inside the run (the loop's usage_wait entries). */
  waitMs: number;
  sessions: number | null;
  repairs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  /** Some sessions reported no figures: the totals are lower bounds. */
  usagePartial: boolean;
  rating: number | null;
  vetoes: number | null;
}

const readJson = (p: string): Record<string, unknown> | undefined => {
  try { return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>; } catch { return undefined; }
};
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function armOf(runId: string, manifest: Record<string, unknown> | undefined): Arm | undefined {
  const variant = manifest?.variant;
  if (variant === "baseline-plain-claude-code") return "baseline";
  if (variant === "jarvis") return "jarvis";
  if (runId.startsWith("baseline-")) return "baseline";
  if (runId.startsWith("jarvis-")) return "jarvis";
  return undefined;
}

/** A grade counts only with its suite's fingerprint: an older grade without one is ungraded. */
function hiddenOf(dir: string): Pick<RunRow, "hidden" | "suite"> {
  const g = readJson(join(dir, "grade.json"));
  if (g === undefined || typeof g.pass !== "boolean" || typeof g.suite !== "string" || !/^[0-9a-f]{64}$/.test(g.suite)) return { hidden: "ungraded", suite: null };
  return { hidden: g.pass ? "pass" : "fail", suite: g.suite };
}

function ratingOf(dir: string): { rating: number | null; vetoes: number | null } {
  const r = readJson(join(dir, "rating.json"));
  return { rating: num(r?.rating), vetoes: num(r?.vetoes) };
}

const empty = { suite: null, claimedDone: null, falseDone: null, wallMs: null, waitMs: 0, sessions: null, repairs: null, inputTokens: null, outputTokens: null, costUsd: null, usagePartial: false };

/** Plain Claude Code's own claim of done: a finished session with a success result (it can't say more headless). */
function baselineRow(dir: string, runId: string, s: Record<string, unknown>): Omit<RunRow, "hidden" | "rating" | "vetoes"> {
  const started = s.started === true;
  const limited = s.usageLimited === true;
  const claimedDone = started && !limited && s.exitCode === 0 && s.timedOut !== true && s.resultSubtype === "success";
  let usage: ReturnType<typeof sessionUsage> | undefined;
  try { usage = sessionUsage(parseStreamJson(readFileSync(join(dir, "stream.jsonl"), "utf8"))); } catch { usage = undefined; }
  return {
    ...empty, arm: "baseline", runId,
    counted: started && !limited,
    outcome: !started ? "not started" : limited ? "usage-limited" : s.timedOut === true ? "timed out" : String(s.resultSubtype ?? "no result"),
    claimedDone, wallMs: num(s.durationMs), sessions: started ? 1 : 0, repairs: null,
    inputTokens: num(usage?.inputTokens), outputTokens: num(usage?.outputTokens), costUsd: num(usage?.costUsd), usagePartial: usage !== undefined && !usage.complete,
  };
}

function jarvisRow(runId: string, s: Record<string, unknown>): Omit<RunRow, "hidden" | "rating" | "vetoes"> {
  const started = s.started === true;
  const outcome = String(s.outcome ?? "unknown");
  const m = (s.metrics ?? {}) as { sessions?: { total?: unknown }; repairs?: unknown; usageWaits?: { waitMs?: unknown }; usage?: { sessions?: unknown; inputTokens?: unknown; outputTokens?: unknown; costUsd?: unknown; unknown?: unknown; incomplete?: unknown } };
  const logged = num(m.usage?.sessions) ?? 0;
  const usageKnown = logged > 0;
  return {
    ...empty, arm: "jarvis", runId,
    counted: started && outcome !== "usage-limited",
    outcome: started ? outcome : "not started",
    claimedDone: s.claimedDone === true, wallMs: num(s.durationMs), waitMs: num(m.usageWaits?.waitMs) ?? 0,
    sessions: num(m.sessions?.total), repairs: num(m.repairs),
    inputTokens: usageKnown ? num(m.usage?.inputTokens) : null, outputTokens: usageKnown ? num(m.usage?.outputTokens) : null, costUsd: usageKnown ? num(m.usage?.costUsd) : null,
    usagePartial: usageKnown && ((num(m.usage?.unknown) ?? 1) > 0 || (num(m.usage?.incomplete) ?? 1) > 0 || logged < (num(m.sessions?.total) ?? 0)),
  };
}

/** Every run folder of a task, both arms, oldest first. A folder without summary.json is an incomplete run. */
export function readRuns(evalsHome: string, taskId: string): RunRow[] {
  const dir = join(evalsHome, taskId);
  if (!existsSync(dir)) return [];
  const rows: RunRow[] = [];
  for (const runId of readdirSync(dir).sort()) {
    const runDir = join(dir, runId);
    if (!lstatSync(runDir).isDirectory()) continue;
    const arm = armOf(runId, readJson(join(runDir, "manifest.json")));
    if (!arm) continue;
    const summary = readJson(join(runDir, "summary.json"));
    const base = summary === undefined
      ? { ...empty, arm, runId, counted: false, outcome: "incomplete (no summary)" }
      : arm === "baseline" ? baselineRow(runDir, runId, summary) : jarvisRow(runId, summary);
    const { hidden, suite } = hiddenOf(runDir);
    const falseDone = base.claimedDone === null || hidden === "ungraded" ? null : base.claimedDone && hidden === "fail";
    rows.push({ ...base, hidden, suite, falseDone, ...ratingOf(runDir) });
  }
  return rows;
}

export interface ArmStats {
  runs: number;
  graded: number;
  hiddenPass: number;
  claimedDone: number;
  falseDone: number;
  rated: number;
  meanRating: number | null;
  meanWallMs: number | null;
}

export function armStats(rows: readonly RunRow[], arm: Arm): ArmStats {
  const counted = rows.filter((r) => r.arm === arm && r.counted);
  const graded = counted.filter((r) => r.hidden !== "ungraded");
  const rated = counted.filter((r) => r.rating !== null);
  const walls = counted.map((r) => r.wallMs).filter((v): v is number => v !== null);
  return {
    runs: counted.length,
    graded: graded.length,
    hiddenPass: graded.filter((r) => r.hidden === "pass").length,
    claimedDone: counted.filter((r) => r.claimedDone === true).length,
    falseDone: graded.filter((r) => r.falseDone === true).length,
    rated: rated.length,
    meanRating: rated.length ? rated.reduce((n, r) => n + r.rating!, 0) / rated.length : null,
    meanWallMs: walls.length ? walls.reduce((a, b) => a + b, 0) / walls.length : null,
  };
}

/** Golden tasks run at least twice per variant (02-golden-tasks.md, "How every task runs", step 7). */
export const MIN_RUNS = 2;
export const BEATS_RULE = "proposed: Jarvis beats the baseline when both arms have at least 2 counted runs, every counted run is graded and rated, Jarvis's mean rating is higher, its false-done rate is not higher, and its hidden-check pass rate is not lower";

export interface Verdict { verdict: "beats" | "does not beat" | "undecided"; reasons: string[] }

export function verdict(rows: readonly RunRow[]): Verdict {
  const b = armStats(rows, "baseline");
  const j = armStats(rows, "jarvis");
  const missing: string[] = [];
  // Grades compare only on one suite: a relaxed or changed check must not decide the comparison.
  const suites = [...new Set(rows.filter((r) => r.counted && r.suite !== null).map((r) => r.suite!))];
  if (suites.length > 1) missing.push(`graded with different suites: ${suites.map((x) => x.slice(0, 12)).join(", ")} (regrade every run with jarvis eval grade)`);
  for (const [name, s] of [["baseline", b], ["jarvis", j]] as const) {
    if (s.runs < MIN_RUNS) missing.push(`${name} has ${s.runs} counted run(s); needs ${MIN_RUNS}`);
    else {
      if (s.graded < s.runs) missing.push(`${name} has ${s.runs - s.graded} ungraded run(s) (jarvis eval grade)`);
      if (s.rated < s.runs) missing.push(`${name} has ${s.runs - s.rated} unrated run(s) (jarvis eval rate)`);
    }
  }
  if (missing.length) return { verdict: "undecided", reasons: missing };
  const rate = (n: number, d: number) => n / d;
  const reasons: string[] = [];
  const ratingBetter = j.meanRating! > b.meanRating!;
  const falseDoneOk = rate(j.falseDone, j.graded) <= rate(b.falseDone, b.graded);
  const hiddenOk = rate(j.hiddenPass, j.graded) >= rate(b.hiddenPass, b.graded);
  reasons.push(`rating ${j.meanRating!.toFixed(2)} vs ${b.meanRating!.toFixed(2)}${ratingBetter ? "" : " (not higher)"}`);
  reasons.push(`false done ${j.falseDone}/${j.graded} vs ${b.falseDone}/${b.graded}${falseDoneOk ? "" : " (higher)"}`);
  reasons.push(`hidden checks ${j.hiddenPass}/${j.graded} vs ${b.hiddenPass}/${b.graded}${hiddenOk ? "" : " (lower)"}`);
  return { verdict: ratingBetter && falseDoneOk && hiddenOk ? "beats" : "does not beat", reasons };
}

const yes = (v: boolean | null) => (v === null ? "-" : v ? "yes" : "no");
const dur = (v: number | null) => (v === null ? "-" : formatDuration(v));
const atLeast = (r: RunRow) => (r.usagePartial ? ">=" : "");
const tok = (r: RunRow) => (r.inputTokens === null || r.outputTokens === null ? "-" : `${atLeast(r)}${formatTokens(r.inputTokens)}/${formatTokens(r.outputTokens)}`);

export function formatCompare(taskId: string, rows: readonly RunRow[]): string {
  const header = ["arm", "run", "counted", "outcome", "hidden", "suite", "claimed done", "false done", "wall", "waited", "sessions", "repairs", "tokens in/out", "cost", "rating", "vetoes"];
  const body = rows.map((r) => [
    r.arm, r.runId, r.counted ? "yes" : "no", r.outcome, r.hidden, r.suite === null ? "-" : r.suite.slice(0, 8), yes(r.claimedDone), yes(r.falseDone), dur(r.wallMs), r.waitMs ? dur(r.waitMs) : "-",
    r.sessions === null ? "-" : String(r.sessions), r.repairs === null ? "-" : String(r.repairs), tok(r), r.costUsd === null ? "-" : `${atLeast(r)}$${r.costUsd.toFixed(2)}`,
    r.rating === null ? "-" : String(r.rating), r.vetoes === null ? "-" : String(r.vetoes),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  const out = [`Golden task ${taskId}: both arms, run for run`, "", line(header), line(widths.map((w) => "-".repeat(w))), ...body.map(line), ""];
  if (!rows.length) out.splice(2, 2, "No runs recorded.");
  for (const arm of ["baseline", "jarvis"] as const) {
    const s = armStats(rows, arm);
    out.push(`${arm.padEnd(8)}  ${s.runs} counted; hidden pass ${s.hiddenPass}/${s.graded} graded; claimed done ${s.claimedDone}; false done ${s.falseDone}/${s.graded}; mean wall ${dur(s.meanWallMs)}; mean rating ${s.meanRating === null ? "-" : s.meanRating.toFixed(2)} (${s.rated}/${s.runs} rated)`);
  }
  const v = verdict(rows);
  out.push("", `Beats the baseline: ${v.verdict.toUpperCase()} (${v.reasons.join("; ")})`, `Rule: ${BEATS_RULE}.`);
  return `${out.join("\n")}\n`;
}

/** Fabricio's 1–5 rating ("would I use this?") and veto count for one run (decision 35). */
export function writeRating(evalsHome: string, taskId: string, runId: string, r: { rating: number; vetoes?: number; note?: string }): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) throw new Error("invalid task or run id");
  if (!Number.isInteger(r.rating) || r.rating < 1 || r.rating > 5) throw new Error("rating must be a whole number from 1 to 5");
  if (r.vetoes !== undefined && (!Number.isInteger(r.vetoes) || r.vetoes < 0)) throw new Error("vetoes must be a whole number, 0 or more");
  const dir = join(evalsHome, taskId, runId);
  if (!existsSync(join(dir, "manifest.json"))) throw new Error(`no recorded run ${taskId}/${runId}`);
  const path = join(dir, "rating.json");
  const tmp = `${path}.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ rating: r.rating, vetoes: r.vetoes ?? 0, ...(r.note ? { note: r.note.slice(0, 2000) } : {}), ratedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}
