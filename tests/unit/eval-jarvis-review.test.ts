import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pinnedCodexBin } from "../../packages/cli/src/config/pins.ts";
import { loadTask } from "../../packages/cli/src/eval/baseline.ts";
import { runJarvis, type RunLoopOptions } from "../../packages/cli/src/eval/jarvis.ts";
import { runSession, type SessionSpec } from "../../packages/cli/src/harness/claude/session.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { sessionCalls, writeFakeClaudeShim } from "../integration/e2e-helpers.ts";
import { createEvalFixture, GRADE_CANARY, HIDDEN_MARKER, realGateLoop, type EvalFixture } from "./eval-jarvis-fixture.ts";

const fixtures: EvalFixture[] = [];
afterEach(() => fixtures.splice(0).forEach((f) => f.cleanup()));

const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])) : []);
const contains = (files: string[], marker: string) => files.filter((f) => readFileSync(f).includes(marker));

/**
 * The default review wiring in evals (no reviewer injected): the production review service with the
 * production Claude reviewer, whose one session is a fake reviewer process (the fake claude acting out a
 * scenario that returns an empty findings list). A fake Codex sits at the pinned path as a canary.
 */
function setup(preflight: () => Promise<{ ok: boolean }>) {
  const fx = createEvalFixture();
  fixtures.push(fx);
  const scenarioPath = join(fx.root, "review-scenario", "scenario.json");
  mkdirSync(dirname(scenarioPath));
  writeFileSync(scenarioPath, JSON.stringify({ sessions: [{ name: "review", match: "Independently review", repeat: true, steps: [{ result: { subtype: "success", text: "{\"findings\":[]}" } }] }] }));
  const shim = join(fx.root, "bin", "claude");
  writeFakeClaudeShim(shim, scenarioPath);
  // Codex canary: if the eval wiring ever ran the pinned Codex, it would read a hidden file and leave a marker.
  const codexMarker = join(fx.root, "codex-ran");
  const codex = pinnedCodexBin(fx.home);
  mkdirSync(dirname(codex), { recursive: true });
  writeFileSync(codex, `#!/bin/sh\ntouch '${codexMarker}'\ncat '${join(fx.evalsRepo, "hidden", "05-citizenship", "checks", "fixtures", "hidden.test.mjs")}'\necho codex-cli 0.164.0\n`);
  chmodSync(codex, 0o755);
  const reviewerSpecs: SessionSpec[] = [];
  const reviewerInputs: { canary: string[]; hidden: string[] }[] = [];
  const calls: RunLoopOptions[] = [];
  const run = () => runJarvis(loadTask(fx.evalsRepo, "05-citizenship"), {
    preflight, evalsRepo: fx.evalsRepo, runLoop: realGateLoop(undefined, calls),
    harness: { runTask: async () => { throw new Error("no build session in this loop"); } },
    jarvisHome: fx.jarvisHome, workRoot: fx.workRoot, home: fx.home, runId: "jarvis-rv",
    reviewerSeams: {
      binaryRealpath: () => "/usr/bin/true",
      session: async (spec) => {
        reviewerSpecs.push(spec);
        const files = walk(spec.cwd); // the checkout the reviewer can read, as it stands during the session
        reviewerInputs.push({ canary: contains(files, GRADE_CANARY), hidden: contains(files, HIDDEN_MARKER) });
        return runSession({ ...spec, bin: shim });
      },
    },
  });
  return { fx, run, reviewerSpecs, reviewerInputs, calls, codexMarker, scenarioPath };
}

const reviewResults = (projectDir: string) => Ledger.open(projectDir).entries().filter((e) => e.kind === "review_result").map((e) => e.data as { status: string; reviews: { reviewer: string }[]; error?: string });

describe("eval jarvis: the production review wiring", { timeout: 180_000 }, () => {
  it("reviews with Claude only, from the gate's evidence, and no grading output reaches any reviewer input", async () => {
    let n = 0;
    const s = setup(async () => { n++; return { ok: true }; });
    const r = await s.run();
    expect(r).toMatchObject({ outcome: "complete", claimedDone: true, grade: { pass: true } });
    expect(n).toBe(2); // the run's own preflight, then the reviewer's, before its session

    // One fresh Claude review session (the fake reviewer process), with the safety envelope, and its verdict recorded.
    expect(s.reviewerSpecs).toHaveLength(1);
    expect(sessionCalls({ scenarioPath: s.scenarioPath }).map((c) => [c.session, c.envelope, c.tools])).toEqual([["review", [], "Read,Glob,Grep"]]);
    const results = reviewResults(s.calls[0]!.projectDir);
    expect(results.map((d) => [d.status, d.reviews.map((x) => x.reviewer)])).toEqual([["pass", ["claude"]]]);

    // Codex is never used in evals: its read-only sandbox doesn't confine reads (the canary would have read a hidden file).
    expect(existsSync(s.codexMarker)).toBe(false);

    // The canary is live: the grading verifier printed it into the grade's evidence ...
    expect(contains(walk(r.grade!.projectDir), GRADE_CANARY).length).toBeGreaterThan(0);
    // ... and it is in no reviewer prompt, argument or environment, no file the reviewer could read, and nothing the loop owns.
    const spec = JSON.stringify(s.reviewerSpecs);
    expect(spec).not.toContain(GRADE_CANARY);
    expect(spec).not.toContain(HIDDEN_MARKER);
    expect(spec).toContain("JARVIS-CHECK-COMPLETE"); // verifier output does reach reviewers: the gate's, never grading's
    expect(s.reviewerInputs).toEqual([{ canary: [], hidden: [] }]);
    expect(contains(walk(s.calls[0]!.projectDir), GRADE_CANARY)).toEqual([]);
    expect(contains(walk(s.calls[0]!.projectDir), HIDDEN_MARKER)).toEqual([]);
  });

  it("starts no reviewer session when the reviewer's live preflight fails, and the task is not done", async () => {
    let n = 0;
    const s = setup(async () => ({ ok: n++ === 0 })); // only the run's own preflight passes
    const r = await s.run();
    expect(s.reviewerSpecs).toHaveLength(0);
    expect(r).toMatchObject({ outcome: "blocked", claimedDone: false });
    const results = reviewResults(s.calls[0]!.projectDir);
    expect(results.map((d) => d.status)).toEqual(["error"]);
    expect(results[0]!.reviews.map((x) => x.reviewer)).toEqual(["claude"]);
    expect(JSON.stringify(results[0])).toMatch(/live preflight failed/);
    expect(existsSync(s.codexMarker)).toBe(false);
  });
});
