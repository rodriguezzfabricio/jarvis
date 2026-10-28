// Live canary probe tests against a fake claude, part 3 of 3 (shell composition, temp folders, plugins, cleanup). The tests are split over three files so they run in parallel;
// the shared fixture is tests/unit/helpers/probe-fixture.ts.

import { existsSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import { isAllowedPlugin, isBuiltinPlugin, runCanaryProbe } from "../../packages/cli/src/harness/claude/probe.ts";
import { bin, dir, failed, home, probe } from "./helpers/probe-fixture.ts";

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("live canary probe (decisions 59, 68, 69), against a fake claude", () => {
  describe("shell composition", () => {
    it("records which compound forms run and which are refused", async () => {
      const r = await probe("safe");
      expect(r.checks.find((c) => c.name === "shell_composition_recorded")?.detail ?? "<missing check>").toMatch(/pipe runs.*redirect runs.*and runs.*for refused/);
    });

    it("fails when a compound command reports success but nothing ran", async () => {
      expect(failed(await probe("compose-lies"))).toEqual(["shell_composition_recorded"]);
    });

    it("fails when a compound command reports a refusal but ran anyway", async () => {
      expect(failed(await probe("compose-ran-refused"))).toEqual(["shell_composition_recorded"]);
    });

    it("fails when a compound step has no output", async () => {
      expect(failed(await probe("compose-skip"))).toEqual(["all_steps_attempted", "shell_composition_recorded"]);
    });

    it("fails when the scratch-script workaround is refused", async () => {
      expect(failed(await probe("scratch-refused"))).toEqual(["positive_scratch_script_runs"]);
    });
  });

  // Decision 93: system temp folders are read-denied; the session's TMPDIR is a private cache folder.
  describe("system temp folders", () => {
    it("fails when a file planted in the system temp folder is readable", async () => {
      expect(failed(await probe("tmp-leak"))).toEqual(["system_temp_not_readable"]);
    });

    it("fails as inconclusive when the temp-read lines didn't run", async () => {
      const r = await probe("tmp-silent");
      expect(failed(r)).toEqual(["system_temp_not_readable"]);
      expect(r.checks.find((c) => c.name === "system_temp_not_readable")?.detail).toMatch(/did not run/);
    });

    it("judges from the copy on disk, not the exit status the session reports", async () => {
      expect(failed(await probe("tmp-lies"))).toEqual(["system_temp_not_readable"]);
    });

    it("covers /private/tmp, /private/var/tmp and the runner's own $TMPDIR", async () => {
      const detail = (await probe("safe")).checks.find((c) => c.name === "system_temp_not_readable")?.detail ?? "";
      expect(detail).toMatch(/\/private\/tmp\/jarvis-probe-tmp-\w+\.txt unreadable/);
      expect(detail).toMatch(/\/private\/var\/tmp\/jarvis-probe-tmp-\w+\.txt unreadable/);
      const host = realpathSync(tmpdir());
      if (host !== "/private/tmp") expect(detail).toContain(`${host}/jarvis-probe-tmp-`);
    });

    it("negative control: with the temp denials stripped from the settings, exactly the temp check fails", async () => {
      const r = await runCanaryProbe({
        claudeBin: bin, tmpRoot: dir, home, parentEnv: { HOME: home, USER: "t" }, extraEnv: { FAKE_CLAUDE_MODE: "safe" },
        negativeControlSettings: (s) => ({ ...s, sandbox: { ...s.sandbox, filesystem: { ...s.sandbox.filesystem, denyRead: s.sandbox.filesystem.denyRead.slice(0, 1) } } }),
      });
      expect(failed(r)).toEqual(["system_temp_not_readable"]);
    });

    it("fails when cat reports success but copied nothing (the probe can't trust what it saw)", async () => {
      expect(failed(await probe("tmp-exit0"))).toEqual(["system_temp_not_readable"]);
    });

    it("fails when the session's TMPDIR is the system temp, even a usable one, not its private cache folder", async () => {
      expect(failed(await probe("tmpdir-system"))).toEqual(["positive_session_tmpdir_usable"]);
    });

    it("fails when the session's private TMPDIR isn't usable", async () => {
      expect(failed(await probe("tmpdir-broken"))).toEqual(["positive_session_tmpdir_usable"]);
    });
  });

  it("accepts Claude Code's built-in plugins but not look-alikes", () => {
    expect(isBuiltinPlugin({ name: "cc-plugin-telemetry", path: "builtin", source: "cc-plugin-telemetry@builtin" })).toBe(true);
    expect(isBuiltinPlugin({ name: "x", path: "/Users/f/.claude/plugins/x", source: "x@builtin" })).toBe(false);
    expect(isBuiltinPlugin({ name: "x", path: "builtin", source: "x@market" })).toBe(false);
    expect(isBuiltinPlugin(null)).toBe(false);
    expect(isAllowedPlugin({ name: "jarvis", path: "/j/plugin", source: "jarvis@inline" }, "/j/plugin")).toBe(true);
    expect(isAllowedPlugin({ name: "jarvis", path: "/elsewhere", source: "jarvis@inline" }, "/j/plugin")).toBe(false);
  });

  it("cleans up after itself", async () => {
    await probe("escape-write");
    expect(readdirSync(dir).filter((n) => n.startsWith("jarvis-probe-"))).toEqual([]);
    expect(readdirSync(home).filter((n) => n.startsWith(".jarvis-probe"))).toEqual([]);
    expect(existsSync(bin)).toBe(true);
  });
});
