// Live canary probe tests against a fake claude, part 2 of 3 (hardlinks, notes). The tests are split over three files so they run in parallel;
// the shared fixture is tests/unit/helpers/probe-fixture.ts.

import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { dir, failed, home, probe } from "./helpers/probe-fixture.ts";

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("live canary probe (decisions 59, 68, 69), against a fake claude", () => {
  // Stage 3 runner loop dependencies: hardlinks, session-owned .jarvis files, shell composition.
  describe("hardlinks out of the worktree", () => {
    it("fails when a link to a write-denied outside file exists although the step reported a refusal", async () => {
      expect(failed(await probe("link-leak"))).toEqual(["hardlinks_out_refused"]);
    });

    it("fails when a read-denied runner-folder file can be linked into the worktree", async () => {
      expect(failed(await probe("link-runner"))).toEqual(["hardlinks_out_refused"]);
    });

    it("fails when .git/config can be linked into the worktree (a write path around denyWrite)", async () => {
      expect(failed(await probe("link-gitconfig"))).toEqual(["hardlinks_out_refused"]);
    });

    it("fails as inconclusive when the link steps printed nothing", async () => {
      const r = await probe("link-silent");
      expect(failed(r)).toEqual(["hardlinks_out_refused"]);
      expect(r.checks.find((c) => c.name === "hardlinks_out_refused")?.detail ?? "<missing check>").toMatch(/no output/);
    });

    it("fails when the step reports a cache link the disk doesn't show", async () => {
      expect(failed(await probe("cache-link-lies"))).toEqual(["hardlinks_out_refused"]);
    });

    it("passes whether the session's own cache can be linked or not (readable and writable by policy, decision 69)", async () => {
      expect(failed(await probe("cache-link-refused"))).toEqual([]);
      const r = await probe("safe");
      expect(r.checks.find((c) => c.name === "hardlinks_out_refused")?.detail ?? "<missing check>").toMatch(/Lc linked/);
    });
  });

  describe("session-owned .jarvis files through the file tools", () => {
    it("fails when the notes write is refused", async () => {
      expect(failed(await probe("notes-refused"))).toEqual(["positive_session_notes_writable"]);
    });

    it("fails when the Write tool reports success but the notes file isn't there", async () => {
      expect(failed(await probe("notes-claims"))).toEqual(["positive_session_notes_writable"]);
    });

    it("fails when .jarvis/anything-else is writable (tripwire not in force)", async () => {
      expect(failed(await probe("pretool-hooks-off"))).toEqual(["jarvis_folder_other_not_writable"]);
    });

    it("runs its session as a Jarvis session, so the tripwire refuses .jarvis/anything-else before .jarvis/ exists", async () => {
      const r = await probe("other-first");
      expect(failed(r)).toEqual([]);
      expect(r.ok).toBe(true);
    });

    it("fails as inconclusive, not as refused, when the .jarvis/anything-else write wasn't attempted", async () => {
      expect(failed(await probe("other-skip"))).toEqual(["all_steps_attempted", "jarvis_folder_other_not_writable"]);
    });
  });
});
