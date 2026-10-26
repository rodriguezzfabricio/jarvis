import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error standalone .mjs script, like mutation-classify.mjs
import { inspectReviews } from "../../scripts/review-status.mjs";
// @ts-expect-error standalone .mjs script
import { summarize } from "../../scripts/mutation-classify.mjs";

const root = mkdtempSync(join(tmpdir(), "review-status-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const revision = "a".repeat(40);
const checks = ["typecheck", "unit-tests", "live-probe", "doctor-live", "mutation-check"];
let count = 0;
const verdict = (extra: object = {}) => ({ verdict: "PASS", summary: "synthetic", findings: [], remaining_for_stage0: [], ...extra });

function fixture(lanes = false, roundName?: string) {
  const base = join(root, String(++count));
  const name = roundName ?? (lanes ? "stage0-16" : "stage0-15");
  const round = join(base, name);
  const workspace = join(base, `checkout-${revision}`);
  const evidence = join(workspace, ".review-evidence");
  mkdirSync(round, { recursive: true });
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(round, "workspace.txt"), `${workspace}\n`);
  writeFileSync(join(evidence, "README.txt"), `revision ${revision}\n`);
  for (const check of checks) writeFileSync(join(evidence, `${check}.log`), `${check === "mutation-check" ? "all 106 mutations caught\n" : ""}exit 0\n`);
  writeFileSync(join(evidence, "install.log"), "Done installing (no exit footer in the runner).\n");
  for (const lane of lanes ? ["A", "B", "C", "D"] : ["single"]) {
    writeFileSync(join(round, lane === "single" ? "verdict.json" : `verdict-${lane}.json`), JSON.stringify(verdict()));
  }
  writeFileSync(join(round, "status"), lanes ? "evidence-done\nlane B exit 0\nlane A exit 0\nlane D exit 0\nlane C exit 0\ncodex-done\n" : "codex-done-0\n");
  return { base, round, workspace, evidence };
}
const read = (base: string) => inspectReviews(base).rounds[0];

describe("review status is read-only, advisory and conservative", () => {
  it("reads the old overwritten single-lane completion marker", () => {
    const f = fixture();
    expect(read(f.base)).toMatchObject({ state: "finished", result: "PASS", revision, advisory: true });
    expect(read(f.base).evidence).toHaveLength(5);
    expect(read(f.base).mutations).toEqual({ caught: 106, notCaught: 0 });
  });

  it("requires every parallel lane, regardless of completion order", () => {
    const f = fixture(true);
    expect(read(f.base)).toMatchObject({ state: "finished", result: "PASS" });
    expect(read(f.base).lanes).toHaveLength(4);
    rmSync(join(f.round, "verdict-D.json"));
    expect(read(f.base)).toMatchObject({ state: "failed", result: "FAIL" });
  });

  it("requires a completion marker for every lane even when every verdict exists", () => {
    const f = fixture(true);
    writeFileSync(join(f.round, "status"), "evidence-done\nlane A exit 0\nlane B exit 0\nlane C exit 0\ncodex-done\n");
    expect(read(f.base)).toMatchObject({ state: "failed", result: "FAIL" });
    expect(read(f.base).problems).toContain("Lane D lacks a completion marker");
  });

  it("reports a queued round without inventing process liveness", () => {
    const f = fixture(true);
    rmSync(join(f.round, "status"));
    rmSync(join(f.round, "workspace.txt"));
    expect(read(f.base)).toMatchObject({ state: "queued", result: "PENDING", revision: null });
  });

  it("reports evidence collection when a workspace is known but checks are incomplete", () => {
    const f = fixture(true);
    rmSync(join(f.round, "status"));
    writeFileSync(join(f.evidence, "mutation-check.log"), "still collecting\n");
    expect(read(f.base)).toMatchObject({ state: "capturing evidence", result: "PENDING" });
  });

  it("keeps old-format evidence-done pending when its workspace pointer is not visible", () => {
    const f = fixture();
    writeFileSync(join(f.round, "status"), "evidence-done\n");
    rmSync(join(f.round, "workspace.txt"));
    expect(read(f.base)).toMatchObject({ state: "reviewing", result: "PENDING", revision: null });
  });

  it("keeps a partially written verdict pending until its lane exits", () => {
    const f = fixture(true);
    writeFileSync(join(f.round, "status"), "evidence-done\nlane A exit 0\n");
    writeFileSync(join(f.round, "verdict-B.json"), '{"verdict":');
    expect(read(f.base)).toMatchObject({ state: "reviewing", result: "PENDING" });
    expect(read(f.base).lanes.find((lane: { id: string }) => lane.id === "B").state).toBe("pending");
  });

  it("rejects nonzero lane exits even when the verdict says PASS", () => {
    const f = fixture(true);
    writeFileSync(join(f.round, "status"), "evidence-done\nlane A exit 1\n");
    expect(read(f.base)).toMatchObject({ state: "failed", result: "FAIL" });
  });

  it("rejects malformed completed verdicts and verdicts missing required fields", () => {
    const f = fixture();
    for (const data of ['{"verdict":', '{"verdict":"PASS"}', 'null', '[]', JSON.stringify(verdict({ unexpected: true }))]) {
      writeFileSync(join(f.round, "verdict.json"), data);
      expect(read(f.base)).toMatchObject({ state: "failed", result: "FAIL" });
    }
  });

  it("requires all evidence and a final successful exit footer", () => {
    for (const data of [null, "exit 1\n", "exit 0\nmore output\n"]) {
      const f = fixture();
      if (data === null) rmSync(join(f.evidence, "live-probe.log"));
      else writeFileSync(join(f.evidence, "live-probe.log"), data);
      expect(read(f.base)).toMatchObject({ state: "failed", result: "FAIL" });
    }
  });

  it("does not pass a mutation summary that contradicts exit zero", () => {
    const f = fixture();
    writeFileSync(join(f.evidence, "mutation-check.log"), "2 mutation(s) not caught\nexit 0\n");
    expect(read(f.base)).toMatchObject({ state: "failed", result: "FAIL", mutations: { caught: null, notCaught: 2 } });
  });

  // Round 18, lane D: a successful --confirm-stage summary was read as "missing positive summary".
  // Decision 94's line stays valid: historical rounds (stage0-18 and later) were written in that format and are never downgraded.
  it("still accepts decision 94's stage-scoped success line from historical rounds, and checks its counts and stage", () => {
    const f = fixture();
    writeFileSync(join(f.evidence, "mutation-check.log"), "caught   m0 (x)\n\nall 5 mutations caught; stage 0-1: 3 confirmed, 2 caught in fast mode (outside stage 0-1)\nexit 0\n");
    expect(read(f.base)).toMatchObject({ state: "finished", result: "PASS", mutations: { caught: 5, notCaught: 0, scope: { stage: "0-1", confirmed: 3, fast: 2 } } });
    for (const bad of [
      "all 5 mutations caught; stage 0-1: 3 confirmed, 3 caught in fast mode (outside stage 0-1)",
      "all 5 mutations caught; stage 9: 3 confirmed, 2 caught in fast mode (outside stage 9)",
      "all 5 mutations caught; stage 0-1: 3 confirmed, 2 caught in fast mode (outside stage 2)",
      "partial run: 5 of 9 mutations selected, all 5 caught (not a complete proof, not the gate); stage 0-1: 3 confirmed, 2 caught in fast mode (outside stage 0-1)",
    ]) {
      writeFileSync(join(f.evidence, "mutation-check.log"), `${bad}\nexit 0\n`);
      expect(read(f.base).result, bad).toBe("FAIL");
    }
  });

  // Decision 129: a stage review runs its own stage's mutations only, so the line names the stage and the count left out.
  it("accepts the summarizer's stage-scoped success line, and checks its counts and stage", () => {
    const f = fixture();
    const results = Array.from({ length: 5 }, (_, i) => `caught   m${i} (1 failing assertion(s): t)`);
    const s = summarize({ total: 5, selected: 5, filtered: false, results, unconfirmed: 0, scope: { stage: "0-1", confirmed: 5, notRun: 7 } });
    expect(s.exitCode).toBe(0);
    writeFileSync(join(f.evidence, "mutation-check.log"), `caught   m0 (x)\n\n${s.line}\nexit 0\n`);
    expect(read(f.base)).toMatchObject({ state: "finished", result: "PASS", mutations: { caught: 5, notCaught: 0, scope: { stage: "0-1", confirmed: 5, notRun: 7 } } });
    for (const bad of [
      "all 5 mutations caught; stage 0-1: 3 confirmed on the full suite; other stages' mutations not run (decision 129): 7",
      "all 5 mutations caught; stage 9: 5 confirmed on the full suite; other stages' mutations not run (decision 129): 7",
      "all 5 mutations caught; stage 0-1: 5 confirmed on the full suite; other stages' mutations not run (decision 129)",
      "partial run: 5 of 9 mutations selected, all 5 caught (not a complete proof, not the gate); stage 0-1: 5 confirmed on the full suite; other stages' mutations not run (decision 129): 7",
    ]) {
      writeFileSync(join(f.evidence, "mutation-check.log"), `${bad}\nexit 0\n`);
      expect(read(f.base).result, bad).toBe("FAIL");
    }
    // A miss reported after the success line wins, as for the plain line.
    writeFileSync(join(f.evidence, "mutation-check.log"), `${s.line}\n1 mutation(s) not caught\nexit 0\n`);
    expect(read(f.base)).toMatchObject({ result: "FAIL", mutations: { notCaught: 1 } });
  });

  it("requires a positive mutation summary and accepts non-blocking findings", () => {
    const f = fixture();
    writeFileSync(join(f.evidence, "mutation-check.log"), "exit 0\n");
    expect(read(f.base).result).toBe("FAIL");
    writeFileSync(join(f.evidence, "mutation-check.log"), "all 106 mutations caught\nexit 0\n");
    writeFileSync(join(f.round, "verdict.json"), JSON.stringify(verdict({ findings: [
      { severity: "medium", title: "synthetic", file: "sample.ts", line: 1, scenario: "synthetic", fix: "synthetic" },
    ] })));
    expect(read(f.base)).toMatchObject({ state: "finished", result: "PASS" });
  });

  it("enforces the round-16 lane rule even when only old-format artifacts exist", () => {
    const f = fixture(true);
    for (const lane of ["A", "B", "C", "D"]) rmSync(join(f.round, `verdict-${lane}.json`));
    writeFileSync(join(f.round, "status"), "codex-done-0\n");
    writeFileSync(join(f.round, "verdict.json"), JSON.stringify(verdict()));
    expect(read(f.base)).toMatchObject({ state: "failed", result: "FAIL" });
    expect(read(f.base).lanes).toHaveLength(4);
  });

  it("validates finding fields and remaining-stage items", () => {
    const f = fixture();
    const finding = { severity: "low", title: "synthetic", file: "sample.ts", line: 1, scenario: "synthetic", fix: "synthetic" };
    for (const extra of [{ unexpected: true }, { line: 1.5 }, { severity: "unknown" }, { fix: null }]) {
      writeFileSync(join(f.round, "verdict.json"), JSON.stringify(verdict({ findings: [{ ...finding, ...extra }] })));
      expect(read(f.base).result).toBe("FAIL");
    }
    writeFileSync(join(f.round, "verdict.json"), JSON.stringify(verdict({ remaining_for_stage0: [null] })));
    expect(read(f.base).result).toBe("FAIL");
  });

  it("rejects explicit install failures, zero mutations, and oversized artifacts", () => {
    for (const [location, file, text] of [
      ["evidence", "install.log", "exit 1\n"],
      ["evidence", "mutation-check.log", "all 0 mutations caught\nexit 0\n"],
      ["round", "status", " ".repeat(65537)],
      ["round", "verdict.json", " ".repeat(2 * 1024 * 1024 + 1)],
    ]) {
      const f = fixture();
      writeFileSync(join(location === "evidence" ? f.evidence : f.round, file!), text!);
      expect(read(f.base).result).toBe("FAIL");
    }
  });

  it("rejects repeated or out-of-order progress markers", () => {
    for (const status of ["evidence-done\nevidence-done\n", "codex-done\ncodex-done\n", "codex-done\nevidence-done\n", "lane A exit 0\nevidence-done\n"]) {
      const f = fixture(true);
      writeFileSync(join(f.round, "status"), status);
      expect(read(f.base).result).toBe("FAIL");
    }
  });

  it("runs through a symlink instead of silently returning success", () => {
    const f = fixture();
    writeFileSync(join(f.round, "status"), "codex-done-1\n");
    const link = join(f.base, "linked-status.mjs");
    symlinkSync(resolve("scripts/review-status.mjs"), link);
    const result = spawnSync(process.execPath, [link, f.base, "--json"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).rounds[0].result).toBe("FAIL");
  });

  it.skipIf(process.platform === "win32")("rejects a named pipe without blocking on open", () => {
    const f = fixture();
    rmSync(join(f.round, "status"));
    execFileSync("/usr/bin/mkfifo", [join(f.round, "status")]);
    const result = spawnSync(process.execPath, [resolve("scripts/review-status.mjs"), f.base, "--json"], { encoding: "utf8", timeout: 2000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).rounds[0].result).toBe("FAIL");
  });

  it("rejects invalid CLI arguments and explicit nonexistent roots, and supports help", () => {
    const script = resolve("scripts/review-status.mjs");
    for (const args of [["--bad"], ["-x"], ["--help", "--bad"], ["--help", "--json"], ["-h", root], [join(root, "missing-explicit-root")]]) {
      expect(spawnSync(process.execPath, [script, ...args], { encoding: "utf8" }).status).toBe(1);
    }
    for (const flag of ["--help", "-h"]) {
      const result = spawnSync(process.execPath, [script, flag], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage:");
    }
  });

  it("counts severities and refuses a PASS verdict containing a high finding", () => {
    const f = fixture();
    const finding = { severity: "high", title: "synthetic", file: "sample.ts", line: 1, scenario: "synthetic", fix: "synthetic" };
    writeFileSync(join(f.round, "verdict.json"), JSON.stringify(verdict({ findings: [finding] })));
    expect(read(f.base)).toMatchObject({ state: "failed", result: "FAIL" });
    expect(read(f.base).lanes[0].findings).toEqual({ critical: 0, high: 1, medium: 0, low: 0 });
  });

  // Round 18, lane D (low): decision 84 blocks on criticals, and on highs only with a concrete path to a
  // credential leak, an action outside the broker or a false pass. The verdict schema has no per-finding
  // flag; round 18's prompt makes the lane's verdict that mark ("PASS only if there are no blocking
  // findings under decision 84"), so from round 18 on a PASS lane's highs are recorded, not blocking.
  const abd = (name: string, laneA: object) => {
    const f = fixture(true, name);
    writeFileSync(join(f.round, "lanes"), "lanes A,B,D\n");
    writeFileSync(join(f.round, "status"), "evidence-done\nlane A exit 0\nlane B exit 0\nlane D exit 0\ncodex-done\n");
    writeFileSync(join(f.round, "verdict-A.json"), JSON.stringify(verdict(laneA)));
    return read(f.base);
  };
  const high = { severity: "high", title: "synthetic", file: "sample.ts", line: 1, scenario: "no leak path", fix: "synthetic" };
  it("applies decision 84 from round 18 on: a PASS lane's high is non-blocking, a critical or a FAIL blocks", () => {
    const pass = abd("stage0-18", { findings: [high] });
    expect(pass.problems).toEqual([]);
    expect(pass).toMatchObject({ state: "finished", result: "PASS", blockingRule: "decision 84" });
    expect(pass.lanes[0]).toMatchObject({ id: "A", state: "finished", findings: { critical: 0, high: 1, medium: 0, low: 0 } });
    expect(abd("stage0-18", { verdict: "FAIL", findings: [high] })).toMatchObject({ state: "failed", result: "FAIL" });
    const critical = abd("stage0-18", { findings: [{ ...high, severity: "critical" }] });
    expect(critical).toMatchObject({ state: "failed", result: "FAIL" });
    expect(critical.problems).toContain("Lane A reports a blocking result");
    for (const later of ["stage0-19", "stage2-1", "stage1-3"]) expect(abd(later, { findings: [high] }), later).toMatchObject({ result: "PASS", blockingRule: "decision 84" });
  });

  it("keeps decision 74's severity-only reading for rounds before 18", () => {
    for (const earlier of ["stage0-17", "stage0-16"]) {
      expect(abd(earlier, {}), earlier).toMatchObject({ result: "PASS", blockingRule: "decision 74" });
      const r = abd(earlier, { findings: [high] });
      expect(r, earlier).toMatchObject({ result: "FAIL", blockingRule: "decision 74" });
      expect(r.problems).toEqual(["Lane A reports a blocking result"]);
    }
  });

  it("reports a reviewer FAIL even without high findings", () => {
    const f = fixture();
    writeFileSync(join(f.round, "verdict.json"), JSON.stringify(verdict({ verdict: "FAIL" })));
    expect(read(f.base)).toMatchObject({ state: "failed", result: "FAIL" });
  });

  it("refuses inconsistent revision evidence and duplicate completion markers", () => {
    const f = fixture(true);
    writeFileSync(join(f.evidence, "README.txt"), `revision ${"b".repeat(40)}\n`);
    expect(read(f.base).result).toBe("FAIL");
    writeFileSync(join(f.evidence, "README.txt"), `revision ${revision}\n`);
    writeFileSync(join(f.round, "status"), "evidence-done\nlane A exit 1\nlane A exit 0\ncodex-done\n");
    expect(read(f.base).result).toBe("FAIL");
  });

  it("handles missing roots and unreadable file shapes without throwing", () => {
    expect(inspectReviews(join(root, "does-not-exist"))).toMatchObject({ advisory: true, rounds: [] });
    const f = fixture();
    rmSync(join(f.round, "verdict.json"));
    mkdirSync(join(f.round, "verdict.json"));
    expect(read(f.base).result).toBe("FAIL");
  });

  it("offers JSON and human CLI output without changing the input files", () => {
    const f = fixture(true);
    const before = readdirSync(f.round).map((name) => [name, readFileSync(join(f.round, name), "utf8")]);
    const script = resolve("scripts/review-status.mjs");
    const json = JSON.parse(spawnSync(process.execPath, [script, f.base, "--json"], { encoding: "utf8" }).stdout);
    expect(json).toMatchObject({ advisory: true, rounds: [{ result: "PASS" }] });
    expect(spawnSync(process.execPath, [script, f.base], { encoding: "utf8" }).stdout).toContain("Advisory");
    expect(readdirSync(f.round).map((name) => [name, readFileSync(join(f.round, name), "utf8")])).toEqual(before);
    writeFileSync(join(f.round, "status"), "evidence-done\n");
    expect(spawnSync(process.execPath, [script, f.base], { encoding: "utf8" }).status).toBe(2);
    writeFileSync(join(f.round, "status"), "evidence-done\nlane A exit 1\n");
    expect(spawnSync(process.execPath, [script, f.base], { encoding: "utf8" }).status).toBe(1);
  });
});

describe('decision 79 lane manifests preserve historical reviews', () => {
  it('uses an explicit A,B,D manifest without requiring C', () => {
    const f = fixture(true);
    writeFileSync(join(f.round, 'lanes'), 'lanes A,B,D\n');
    writeFileSync(join(f.round, 'status'), 'evidence-done\nlane A exit 0\nlane B exit 0\nlane D exit 0\ncodex-done\n');
    expect(read(f.base).result).toBe('PASS');
    expect(read(f.base).lanes.map((x: {id: string}) => x.id)).toEqual(['A', 'B', 'D']);
  });
  it('rejects missing required lanes, invalid manifests, and undeclared completions', () => {
    for (const manifest of ['lanes A,B\n', 'lanes A,B,B,D\n', 'lanes A,B,E\n', '', 'lanes A,B,D\nextra']) {
      const f = fixture(true); writeFileSync(join(f.round, 'lanes'), manifest);
      expect(read(f.base).result).toBe('FAIL');
    }
    const f = fixture(true); writeFileSync(join(f.round, 'lanes'), 'lanes A,B,D\n');
    expect(read(f.base).result).toBe('FAIL');
  });
  it('fails future parallel rounds without a manifest', () => {
    const f = fixture(true);
    const newer = join(f.base, 'stage0-17'); mkdirSync(newer);
    writeFileSync(join(newer, 'status'), 'evidence-done\n');
    expect(inspectReviews(f.base).rounds[1].problems).toContain('missing lane manifest');
  });
  it('never downgrades historical lane C high findings', () => {
    const f = fixture(true);
    writeFileSync(join(f.round, 'verdict-C.json'), JSON.stringify(verdict({ verdict: 'FAIL', findings: [{ severity: 'high', title: 'historical', file: 'x', line: 1, scenario: 'x', fix: 'x' }] })));
    expect(read(f.base).result).toBe('FAIL');
    expect(read(f.base).lanes.find((x: {id: string}) => x.id === 'C')?.findings.high).toBe(1);
  });
});

it('requires missing lanes even when every declared lane succeeded', () => {
  const f = fixture(true);
  writeFileSync(join(f.round, 'lanes'), 'lanes A,B\n');
  writeFileSync(join(f.round, 'status'), 'evidence-done\nlane A exit 0\nlane B exit 0\ncodex-done\n');
  expect(read(f.base).problems).toContain('lane set lacks required lanes D, decision 79');
  expect(read(f.base).result).toBe('FAIL');
});
it('rejects duplicate manifest letters even when the unique lane set is complete', () => {
  const f = fixture(true);
  writeFileSync(join(f.round, 'lanes'), 'lanes A,B,C,D,D\n');
  expect(read(f.base).problems).toContain('invalid lane manifest');
  expect(read(f.base).result).toBe('FAIL');
});
