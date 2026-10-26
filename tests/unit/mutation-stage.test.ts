import { globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without types
import { DEFINITION_GLOBS, STAGES, confirmFor, isScoped, parseMode, stageOf, tally } from "../../scripts/mutation-stage.mjs";

// Decision 94: a stage review confirms its own stage's mutations on the full suite and runs every other
// mutation in fast mode. A mutation's stage comes from where it is defined; unmapped means confirm always.

const repo = fileURLToPath(new URL("../../", import.meta.url));

describe("mutation stage map", () => {
  it("maps the inline list and the probe file to stages 0-1, lane files by folder", () => {
    expect(stageOf("inline")).toBe("0-1");
    expect(stageOf("packages/cli/src/harness/claude/mutations-probe.json")).toBe("0-1");
    for (const lane of ["decisions", "notify", "spec", "triage", "intake"]) expect(stageOf(`packages/cli/src/${lane}/mutations.json`)).toBe("2");
    expect(stageOf("tests/unit/skills-mutations.json")).toBe("2");
    expect(stageOf("packages/cli/src/runner/mutations-runner-core.json")).toBe("3");
    expect(stageOf("packages/cli/src/runner/mutations-planning.json")).toBe("3");
    expect(stageOf("tests/unit/skills-build-mutations.json")).toBe("3");
    expect(stageOf("packages/cli/src/eval/mutations-jarvis.json")).toBe("3"); // the Jarvis arm proves stage 3 (tasks 2, 4, 5)
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

  it("decides confirm per mutation from the mode", () => {
    expect(confirmFor({ mode: "confirm" }, "packages/cli/src/decisions/mutations.json")).toBe(true);
    expect(confirmFor({ mode: "fast" }, "inline")).toBe(false);
    expect(confirmFor({ mode: "fast" }, "packages/cli/src/broker/mutations.json")).toBe(false);
    expect(confirmFor({ mode: "stage", stage: "2" }, "packages/cli/src/spec/mutations.json")).toBe(true);
    expect(confirmFor({ mode: "stage", stage: "2" }, "inline")).toBe(false);
    expect(confirmFor({ mode: "stage", stage: "2" }, "packages/cli/src/broker/mutations.json")).toBe(true);
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
  const v = (kind: string, confirmed: boolean, scoped: boolean) => ({ kind, confirmed, scoped });

  it("in stage mode, blocks on a scoped catch that wasn't confirmed and counts the rest", () => {
    expect(tally([v("caught", true, true), v("caught", false, false), v("caught", true, false)], { mode: "stage", stage: "2" })).toEqual({ unconfirmed: 0, fast: 1, confirmed: 2 });
    expect(tally([v("caught", false, true)], { mode: "stage", stage: "2" })).toEqual({ unconfirmed: 1, fast: 0, confirmed: 0 });
  });

  it("in fast mode every unconfirmed catch blocks; in confirm mode none can exist", () => {
    expect(tally([v("caught", false, false), v("caught", false, true)], { mode: "fast" })).toEqual({ unconfirmed: 2, fast: 0, confirmed: 0 });
    expect(tally([v("caught", true, true), v("survived", true, true)], { mode: "confirm" })).toEqual({ unconfirmed: 0, fast: 0, confirmed: 1 });
  });
});
