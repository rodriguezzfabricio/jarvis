import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error standalone .mjs script, like mutation-classify.mjs
import { inspectReviews } from "../../scripts/review-status.mjs";

const root = mkdtempSync(join(tmpdir(), "review-status-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const revision = "a".repeat(40);
const checks = ["typecheck", "unit-tests", "live-probe", "doctor-live", "mutation-check"];
let count = 0;
const verdict = (extra: object = {}) => ({ verdict: "PASS", summary: "synthetic", findings: [], remaining_for_stage0: [], ...extra });

function fixture(lanes = false) {
  const base = join(root, String(++count));
  const name = lanes ? "stage0-16" : "stage0-15";
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
    const json = JSON.parse(execFileSync(process.execPath, [script, f.base, "--json"], { encoding: "utf8" }));
    expect(json).toMatchObject({ advisory: true, rounds: [{ result: "PASS" }] });
    expect(execFileSync(process.execPath, [script, f.base], { encoding: "utf8" })).toContain("Advisory");
    expect(readdirSync(f.round).map((name) => [name, readFileSync(join(f.round, name), "utf8")])).toEqual(before);
    writeFileSync(join(f.round, "status"), "evidence-done\n");
    expect(spawnSync(process.execPath, [script, f.base], { encoding: "utf8" }).status).toBe(2);
    writeFileSync(join(f.round, "status"), "evidence-done\nlane A exit 1\n");
    expect(spawnSync(process.execPath, [script, f.base], { encoding: "utf8" }).status).toBe(1);
  });
});
