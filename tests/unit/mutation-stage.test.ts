import { spawnSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without types
import { DEFINITION_GLOBS, STAGES, confirmFor, definedLine, estimateLine, isScoped, parseMode, planLine, planRun, runSummary, stageCounts, stageOf, tally } from "../../scripts/mutation-stage.mjs";

// Decision 129 (supersedes decision 94's cross-stage fast pass): a stage review runs its own stage's
// mutations on the full suite and nothing else; the v1 close (--confirm) runs all. A mutation's stage
// comes from where it is defined; a definition file that isn't mapped runs in every stage review.

const repo = fileURLToPath(new URL("../../", import.meta.url));

describe("mutation stage map", () => {
  it("maps the inline list and the probe file to stages 0-1, lane files by folder", () => {
    expect(stageOf("inline")).toBe("0-1");
    expect(stageOf("packages/cli/src/harness/claude/mutations-probe.json")).toBe("0-1");
    for (const lane of ["decisions", "notify", "spec", "triage", "intake"]) expect(stageOf(`packages/cli/src/${lane}/mutations.json`)).toBe("2");
    expect(stageOf("tests/unit/skills-mutations.json")).toBe("2");
    // The stage2-fixes lane's follow-up definitions (decisions 119, 120).
    expect(stageOf("packages/cli/src/intake/mutations-followup.json")).toBe("2");
    expect(stageOf("packages/cli/src/decisions/mutations-followup.json")).toBe("2");
    expect(stageOf("packages/cli/src/runner/mutations-runner-core.json")).toBe("3");
    expect(stageOf("packages/cli/src/runner/mutations-planning.json")).toBe("3");
    expect(stageOf("tests/unit/skills-build-mutations.json")).toBe("3");
    expect(stageOf("packages/cli/src/eval/mutations-jarvis.json")).toBe("3"); // the Jarvis arm proves stage 3 (tasks 2, 4, 5)
    expect(stageOf("packages/cli/src/eval/mutations-hidden.json")).toBe("4"); // hidden-check install found by task 06, the stage 4 proof
    expect(stageOf("packages/cli/src/review/mutations-design.json")).toBe("4"); // the design reviewer (decision 124)
    expect(stageOf("packages/cli/src/lanes/mutations-impeccable.json")).toBe("4"); // the Impeccable checks (decision 124)
    expect(stageOf("packages/cli/src/doctor/mutations-doctor.json")).toBe("0-1"); // jarvis doctor is stage 0-1 (backlog 91, 95)
  });

  // The integrator's mapping for the lanes landing now and next (stages 0-1 to 6).
  it("maps the lanes of stages 3 to 6, including files that haven't landed yet", () => {
    expect(STAGES).toEqual(["0-1", "2", "3", "4", "5", "6"]);
    expect(stageOf("packages/cli/src/harness/claude/mutations-settings.json")).toBe("0-1");
    expect(stageOf("packages/cli/src/commands/mutations-commands.json")).toBe("3");
    expect(stageOf("packages/cli/src/commands/mutations-run.json")).toBe("3");
    expect(stageOf("packages/cli/src/runner/mutations-loop.json")).toBe("3");
    expect(stageOf("packages/cli/src/toolchain/mutations.json")).toBe("3"); // the sessions' pinned Go (decision 123)
    for (const lane of ["review", "security", "lanes"]) expect(stageOf(`packages/cli/src/${lane}/mutations.json`)).toBe("4");
    for (const lane of ["release", "setup"]) expect(stageOf(`packages/cli/src/${lane}/mutations.json`)).toBe("5");
    expect(stageOf("packages/cli/src/broker/adapters/mutations.json")).toBe("5");
    expect(stageOf("packages/cli/src/broker/adapters/email/mutations-smtp.json")).toBe("5");
    expect(stageOf("tests/unit/skills-stage6-mutations.json")).toBe("6");
  });

  it("lets an exact path beat a folder rule", () => {
    expect(stageOf("packages/cli/src/runner/mutations-usage.json")).toBe("6");
    expect(stageOf("packages/cli/src/runner/mutations-usage-extra.json")).toBe("3");
    expect(stageOf("packages/cli/src/broker/mutations.json")).toBeUndefined();
    expect(stageOf("packages/cli/src/broker/mutations-secrets.json")).toBe("0-1"); // the secrets reader (backlog 103)
    expect(stageOf("packages/cli/src/notify/mutations-approvals.json")).toBe("2");
    // The approvals UI lane (backlog 114-116): the terminal answer and the broker's pending list are the
    // stage 1 broker surface; its phone parts stay with notify (2) and the run poller (3).
    expect(stageOf("packages/cli/src/commands/mutations-approvals-ui.json")).toBe("0-1");
    expect(stageOf("packages/cli/src/broker/mutations-approvals-ui.json")).toBe("0-1");
    expect(stageOf("packages/cli/src/notify/mutations-approvals-ui.json")).toBe("2");
  });

  it("leaves anything else unmapped, never guessing from a similar path", () => {
    expect(stageOf("packages/cli/src/broker/mutations.json")).toBeUndefined();
    expect(stageOf("packages/cli/src/runner/sub/mutations.json")).toBeUndefined();
    expect(stageOf("packages/cli/src/runner/mutations/extra.json")).toBeUndefined();
    expect(stageOf("tests/unit/skills-design-mutations.json")).toBeUndefined();
    expect(stageOf("packages/cli/src/harness/claude/mutations.json")).toBeUndefined();
    expect(stageOf("packages/cli/src/eval/mutations.json")).toBeUndefined();
  });

  it("maps every definition file the mutation check loads", () => {
    const files = globSync(DEFINITION_GLOBS, { cwd: repo }).sort();
    expect(files.length).toBeGreaterThanOrEqual(12);
    expect(files.filter((f) => stageOf(f) === undefined)).toEqual([]);
    for (const f of files) expect(STAGES).toContain(stageOf(f));
  });
});

describe("confirm scope", () => {
  it("confirms a stage's own mutations and every unmapped one, fail safe", () => {
    expect(isScoped("inline", "0-1")).toBe(true);
    expect(isScoped("packages/cli/src/harness/claude/mutations-probe.json", "0-1")).toBe(true);
    expect(isScoped("packages/cli/src/decisions/mutations.json", "0-1")).toBe(false);
    expect(isScoped("packages/cli/src/runner/mutations-runner-core.json", "3")).toBe(true);
    expect(isScoped("inline", "3")).toBe(false);
    for (const stage of STAGES) expect(isScoped("packages/cli/src/broker/mutations.json", stage)).toBe(true);
  });

  // Decision 129: every mutation a stage run takes gets its verdict from the full suite, never from related tests.
  it("takes the full suite's verdict in confirm and stage mode, and only in fast mode a subset's", () => {
    expect(confirmFor({ mode: "confirm" })).toBe(true);
    expect(confirmFor({ mode: "stage", stage: "2" })).toBe(true);
    expect(confirmFor({ mode: "stage", stage: "0-1" })).toBe(true);
    expect(confirmFor({ mode: "fast" })).toBe(false);
  });

  it("reads the mode from the arguments and the environment", () => {
    expect(parseMode([], {})).toEqual({ mode: "fast" });
    expect(parseMode(["--confirm"], {})).toEqual({ mode: "confirm" });
    expect(parseMode([], { JARVIS_MUTATION_CONFIRM: "1" })).toEqual({ mode: "confirm" });
    expect(parseMode(["--confirm-stage", "0-1"], {})).toEqual({ mode: "stage", stage: "0-1" });
    expect(parseMode(["--confirm-stage", "3"], {})).toEqual({ mode: "stage", stage: "3" });
  });

  // Codex review of decision 94, high: only the first exact flag was read and checked.
  it("parses every argument strictly: no repeated flag, no unknown option or stray value", () => {
    expect(() => parseMode(["--confirm-stage", "2", "--confirm-stage", "typo"], {})).toThrow(/once/);
    expect(() => parseMode(["--confirm-stage", "2", "--confirm-stage", "3"], {})).toThrow(/once/);
    expect(() => parseMode(["--confirm-stage", "2", "--confirm-stage", "2"], {})).toThrow(/once/);
    expect(() => parseMode(["--confirm", "--confirm"], {})).toThrow(/once/);
    expect(() => parseMode(["--confirm-stage=2", "--confirm-stage", "3"], {})).toThrow(/once/);
    expect(() => parseMode(["--confim"], {})).toThrow(/unknown/);
    expect(() => parseMode(["--confirm-stages", "2"], {})).toThrow(/unknown/);
    expect(() => parseMode(["-c"], {})).toThrow(/unknown/);
    expect(() => parseMode(["2"], {})).toThrow(/unknown/);
    expect(() => parseMode(["--confirm-stage", "2", "extra"], {})).toThrow(/unknown/);
  });

  it("validates the equals spelling exactly like the spaced one", () => {
    expect(parseMode(["--confirm-stage=0-1"], {})).toEqual({ mode: "stage", stage: "0-1" });
    expect(parseMode(["--confirm-stage=3"], {})).toEqual({ mode: "stage", stage: "3" });
    expect(() => parseMode(["--confirm-stage=typo"], {})).toThrow(/stage/);
    expect(() => parseMode(["--confirm-stage="], {})).toThrow(/stage/);
    expect(() => parseMode(["--confirm-stage=2", "--confirm"], {})).toThrow(/one of/);
    expect(() => parseMode(["--confirm=1"], {})).toThrow(/unknown/);
  });

  it("refuses an unknown or missing stage, and both modes at once", () => {
    expect(() => parseMode(["--confirm-stage", "7"], {})).toThrow(/stage/);
    expect(() => parseMode(["--confirm-stage"], {})).toThrow(/stage/);
    expect(() => parseMode(["--confirm-stage", "--confirm"], {})).toThrow();
    expect(() => parseMode(["--confirm", "--confirm-stage", "2"], {})).toThrow(/one of/);
    expect(() => parseMode(["--confirm-stage", "2"], { JARVIS_MUTATION_CONFIRM: "1" })).toThrow(/one of/);
  });
});

describe("verdict tally", () => {
  const v = (kind: string, confirmed: boolean) => ({ kind, confirmed });

  // Decision 129: nothing in a stage run may stay in fast mode, so a catch that wasn't confirmed blocks.
  it("blocks on any catch that wasn't confirmed on the full suite, in every mode", () => {
    expect(tally([v("caught", true), v("caught", false), v("caught", true)])).toEqual({ unconfirmed: 1, confirmed: 2 });
    expect(tally([v("caught", false), v("caught", false)])).toEqual({ unconfirmed: 2, confirmed: 0 });
    expect(tally([v("caught", true), v("survived", true), v("error", true)])).toEqual({ unconfirmed: 0, confirmed: 1 });
  });
});

// Decision 129: what a run takes. Mutations are [name, file, from, to, source].
describe("run plan", () => {
  const m = (name: string, source: string) => [name, "f.ts", "a", "b", source];
  const defined = [
    m("inline-1", "inline"),
    m("probe-1", "packages/cli/src/harness/claude/mutations-probe.json"),
    m("decisions-1", "packages/cli/src/decisions/mutations.json"),
    m("runner-1", "packages/cli/src/runner/mutations-runner-core.json"),
    m("runner-2", "packages/cli/src/runner/mutations-planning.json"),
    m("review-1", "packages/cli/src/review/mutations.json"),
    m("loose-1", "packages/cli/src/broker/mutations.json"), // not mapped to a stage
  ];
  const names = (plan: { selected: unknown[][] }) => plan.selected.map((x) => x[0]);
  const stage = (s: string) => ({ mode: "stage", stage: s });

  it("takes only the stage's own mutations and those of unmapped definition files", () => {
    expect(names(planRun(defined, stage("3")))).toEqual(["runner-1", "runner-2", "loose-1"]);
    expect(names(planRun(defined, stage("0-1")))).toEqual(["inline-1", "probe-1", "loose-1"]);
    expect(names(planRun(defined, stage("2")))).toEqual(["decisions-1", "loose-1"]);
    expect(names(planRun(defined, stage("4")))).toEqual(["review-1", "loose-1"]);
    expect(names(planRun(defined, stage("6")))).toEqual(["loose-1"]);
  });

  it("counts what it takes, what it leaves out and how much of it comes from unmapped files", () => {
    expect(planRun(defined, stage("3"))).toMatchObject({ scoped: 3, notRun: 4, unmapped: 1 });
    expect(planRun(defined, stage("0-1"))).toMatchObject({ scoped: 3, notRun: 4, unmapped: 1 });
    expect(planRun(defined, stage("6"))).toMatchObject({ scoped: 1, notRun: 6, unmapped: 1 });
  });

  it("gives every mapped mutation to exactly one stage and every unmapped one to all of them", () => {
    for (const [name, , , , source] of defined) {
      const taking = STAGES.filter((s: string) => names(planRun(defined, stage(s))).includes(name));
      expect(taking.length, String(name)).toBe(stageOf(source as string) === undefined ? STAGES.length : 1);
    }
  });

  it("takes every mutation in confirm and fast mode (the v1 close and the iterating run)", () => {
    for (const mode of [{ mode: "confirm" }, { mode: "fast" }]) {
      expect(names(planRun(defined, mode))).toEqual(defined.map((x) => x[0]));
      expect(planRun(defined, mode)).toMatchObject({ scoped: 7, notRun: 0 });
    }
  });

  it("narrows to a JARVIS_MUTATIONS subset inside the stage, never into another stage", () => {
    expect(names(planRun(defined, stage("3"), /^runner-2$/))).toEqual(["runner-2"]);
    expect(planRun(defined, stage("3"), /^runner-2$/)).toMatchObject({ scoped: 3, notRun: 4 });
    expect(planRun(defined, stage("3"), /^decisions-1$/).selected).toEqual([]);
    expect(planRun(defined, stage("3"), /^review-1$/).selected).toEqual([]);
  });

  it("counts the definitions per stage", () => {
    expect(stageCounts(defined)).toEqual({ "0-1": 2, "2": 1, "3": 2, "4": 1, "5": 0, "6": 0, unmapped: 1 });
    expect(definedLine(defined)).toBe("defined 7 mutations: 0-1 2, 2 1, 3 2, 4 1, 5 0, 6 0, not mapped to a stage 1");
  });

  it("describes the plan for the start of the run", () => {
    expect(planLine(planRun(defined, stage("3")), stage("3"))).toBe(
      "runs 3 mutations on the full suite: stage 3's, including 1 from definition files not mapped to a stage; other stages' mutations not run (decision 129): 4",
    );
    expect(planLine(planRun(defined, stage("6")), stage("6"))).toBe(
      "runs 1 mutation on the full suite: stage 6's, including 1 from definition files not mapped to a stage; other stages' mutations not run (decision 129): 6",
    );
    expect(planLine(planRun(defined.slice(0, 6), stage("3")), stage("3"))).toBe(
      "runs 2 mutations on the full suite: stage 3's; other stages' mutations not run (decision 129): 4",
    );
    expect(planLine(planRun(defined, { mode: "confirm" }), { mode: "confirm" })).toBe("runs 7 mutations on the full suite: all of them");
    expect(planLine(planRun(defined, { mode: "fast" }), { mode: "fast" })).toBe("runs 7 mutations, each first on the test files that can observe it");
  });

  it("estimates the wall time as the count times the control run's duration, shared among the jobs", () => {
    expect(estimateLine({ count: 120, controlMs: 120_000, jobs: 1 })).toBe("estimated wall time about 4h 0m: 120 mutations x 2m 0s control run; a mutated run can take longer");
    expect(estimateLine({ count: 120, controlMs: 120_000, jobs: 2 })).toBe("estimated wall time about 2h 0m: 120 mutations x 2m 0s control run / 2 jobs; a mutated run can take longer");
    expect(estimateLine({ count: 7, controlMs: 93_000, jobs: 1 })).toBe("estimated wall time about 11m: 7 mutations x 1m 33s control run; a mutated run can take longer");
    expect(estimateLine({ count: 1, controlMs: 53_000, jobs: 1 })).toBe("estimated wall time about 1m: 1 mutation x 0m 53s control run; a mutated run can take longer");
  });
});

// What the run reports from its plan and its verdicts: the exit code is the gate.
describe("run summary", () => {
  const m = (name: string, source: string) => [name, "f.ts", "a", "b", source];
  const defined = [m("a", "inline"), m("b", "inline"), m("c", "packages/cli/src/decisions/mutations.json"), m("d", "packages/cli/src/review/mutations.json"), m("e", "packages/cli/src/review/mutations.json")];
  const caught = (n: number) => Array.from({ length: n }, (_, i) => `caught   m${i} (1 failing assertion(s): t)`);
  const verdicts = (n: number, confirmed = true) => Array.from({ length: n }, () => ({ kind: "caught", confirmed }));
  const stage = (s: string) => ({ mode: "stage", stage: s });

  it("passes a stage run that caught and confirmed all of the stage's mutations, whatever the other stages hold", () => {
    const plan = planRun(defined, stage("4"));
    expect(runSummary({ mode: stage("4"), plan, filtered: false, results: caught(2), verdicts: verdicts(2) })).toEqual({
      line: "all 2 mutations caught; stage 4: 2 confirmed on the full suite; other stages' mutations not run (decision 129): 3",
      exitCode: 0,
    });
    const inline = planRun(defined, stage("0-1"));
    expect(runSummary({ mode: stage("0-1"), plan: inline, filtered: false, results: caught(2), verdicts: verdicts(2) }).exitCode).toBe(0);
  });

  it("fails a stage run on a survivor, and never passes one that confirmed less than it ran or ran less than the stage holds", () => {
    const plan = planRun(defined, stage("4"));
    const survived = ["caught   m0 (x)", "SURVIVED m1 (all tests passed) [full suite, confirm mode]"];
    expect(runSummary({ mode: stage("4"), plan, filtered: false, results: survived, verdicts: verdicts(1) })).toEqual({ line: "1 mutation(s) not caught", exitCode: 1 });
    expect(runSummary({ mode: stage("4"), plan, filtered: false, results: caught(2), verdicts: verdicts(2, false) }).exitCode).toBe(3);
    // JARVIS_MUTATIONS inside the stage: partial, not the gate.
    const subset = planRun(defined, stage("4"), /^d$/);
    expect(runSummary({ mode: stage("4"), plan: subset, filtered: true, results: caught(1), verdicts: verdicts(1) }).exitCode).toBe(4);
  });

  it("reports the plain lines for the v1 close and the fast default", () => {
    const all = planRun(defined, { mode: "confirm" });
    expect(runSummary({ mode: { mode: "confirm" }, plan: all, filtered: false, results: caught(5), verdicts: verdicts(5) })).toEqual({ line: "all 5 mutations caught", exitCode: 0 });
    const fast = planRun(defined, { mode: "fast" });
    expect(runSummary({ mode: { mode: "fast" }, plan: fast, filtered: false, results: caught(5), verdicts: verdicts(5, false) }).exitCode).toBe(3);
  });
});

// The script itself, up to the plan: no clone and no suite. JARVIS_MUTATION_PLAN=1 prints what a run would take
// and exits 5 (not the gate: a plan is no evidence).
describe("mutation check plan (decision 129)", () => {
  const plan = (args: string[], env: Record<string, string> = {}) => {
    // A plan takes well under a second. The timeout (SIGTERM, which the script answers by cleaning up) means a
    // script that ignored JARVIS_MUTATION_PLAN could never run a real mutation check from here.
    const r = spawnSync(process.execPath, ["scripts/mutation-check.mjs", ...args], { cwd: repo, encoding: "utf8", timeout: 20_000, killSignal: "SIGTERM", env: { PATH: process.env.PATH, JARVIS_MUTATION_PLAN: "1", ...env } });
    const runs = r.stdout.split("\n").filter((l: string) => l.startsWith("run ")).map((l: string) => l.slice(4));
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, runs };
  };
  // Names in the definition files, optionally those that a stage run takes (its own stage and unmapped files).
  const fileNames = (only?: (stageOfFile: string | undefined) => boolean) => {
    const out: string[] = [];
    for (const file of globSync(DEFINITION_GLOBS, { cwd: repo }).sort()) {
      if (only && !only(stageOf(file))) continue;
      for (const x of JSON.parse(readFileSync(`${repo}${file}`, "utf8"))) out.push(x.name);
    }
    return out;
  };
  const taken = (stage: string) => fileNames((s) => s === undefined || s === stage);
  const sorted = (xs: string[]) => [...xs].sort();

  it("lists exactly a stage's mutations for --confirm-stage, and exits 5", () => {
    for (const stage of ["2", "3", "4", "5", "6"]) {
      const r = plan(["--confirm-stage", stage]);
      expect(r.status, `${stage}: ${r.stderr}`).toBe(5);
      expect(sorted(r.runs), stage).toEqual(sorted(taken(stage)));
      expect(r.stdout, stage).toContain(`runs ${r.runs.length} mutation`);
      expect(r.stdout, stage).toContain("other stages' mutations not run (decision 129): ");
    }
  });

  it("runs the inline list and the stage 0-1 files for stage 0-1, and nothing of the other stages", () => {
    const r = plan(["--confirm-stage=0-1"]);
    expect(r.status).toBe(5);
    const files = taken("0-1");
    expect(r.runs.length).toBeGreaterThan(files.length); // the inline list is stage 0-1 too
    for (const n of files) expect(r.runs, n).toContain(n);
    expect(r.runs).toContain("failIfUnavailable off");
    const others = fileNames((s) => s !== undefined && s !== "0-1");
    expect(others.length).toBeGreaterThan(0);
    for (const n of others) expect(r.runs, n).not.toContain(n);
  });

  it("lists every mutation for --confirm and for the fast default", () => {
    const confirm = plan(["--confirm"]);
    expect(confirm.status).toBe(5);
    expect(plan([]).runs).toEqual(confirm.runs);
    expect(confirm.runs.length).toBeGreaterThan(fileNames().length); // plus the inline list
    for (const n of fileNames()) expect(confirm.runs, n).toContain(n);
    expect(confirm.stdout).not.toContain("other stages' mutations not run");
  });

  it("keeps a JARVIS_MUTATIONS subset inside the stage", () => {
    const own = taken("3")[0]!;
    const escaped = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(plan(["--confirm-stage", "3"], { JARVIS_MUTATIONS: `^${escaped(own)}$` }).runs).toEqual([own]);
    const foreign = fileNames((s) => s === "2")[0]!;
    expect(plan(["--confirm-stage", "3"], { JARVIS_MUTATIONS: `^${escaped(foreign)}$` }).runs).toEqual([]);
  });

  it("states how the definitions split across the stages", () => {
    expect(plan(["--confirm-stage", "2"]).stdout).toMatch(/^defined \d+ mutations: 0-1 \d+, 2 \d+, 3 \d+, 4 \d+, 5 \d+, 6 \d+, not mapped to a stage \d+$/m);
  });

  it("still refuses a bad stage before planning anything", () => {
    const r = plan(["--confirm-stage", "7"]);
    expect(r.status).toBe(2);
    expect(r.runs).toEqual([]);
  });
});
