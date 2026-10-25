import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadTask, runBaseline, type GoldenTask } from "../../packages/cli/src/eval/baseline.ts";
import { fakeClaudeBin, shortTmp } from "../helpers.ts";

const root = shortTmp("jtb-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const bin = fakeClaudeBin(root);
const jarvisHome = join(root, "jhome");
mkdirSync(jarvisHome);

const task: GoldenTask = {
  id: "11-habit-tracker",
  title: "Brand-new web product",
  prompt: "Build me a habit tracker.",
  model: "claude-opus-5-5",
  maxTurns: 200,
  timeoutMinutes: 1,
  allowedDomains: ["registry.npmjs.org"],
};
const pass = async () => ({ ok: true });
const run = (mode: string, runId: string, extraEnv: Record<string, string> = {}, preflight = pass) =>
  runBaseline(task, { preflight, claudeBin: bin, jarvisHome, workRoot: join(root, "work"), runId, parentEnv: { HOME: root, USER: "t" }, extraEnv: { FAKE_CLAUDE_MODE: mode, ...extraEnv } });

describe("baseline runs (decision 47)", () => {
  it("runs on a fresh snapshot and records evidence outside the workspace", async () => {
    const r = await run("baseline", "r1");
    expect(r.exitCode).toBe(0);
    expect(r.workspace.startsWith(r.resultsDir)).toBe(false);
    expect(r.resultSubtype).toBe("success");
    expect(r.usageLimited).toBe(false);
    expect(r.diffStat).toContain("1 file changed");
    for (const f of ["manifest.json", "stream.jsonl", "stderr.txt", "summary.json", "settings.json"]) expect(existsSync(join(r.resultsDir, f))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(r.resultsDir, "manifest.json"), "utf8"));
    expect(manifest.args).toContain("--restricted");
    expect(manifest.args).not.toContain("--plugin-dir");
    const summary = JSON.parse(readFileSync(join(r.resultsDir, "summary.json"), "utf8"));
    expect(summary.rateLimits.at(-1).windows.five_hour.utilization).toBe(0.42);
  });

  // Codex review 1, high: no session without a passing live preflight.
  it("starts no session when the preflight fails", async () => {
    const marker = join(root, "started-anyway");
    await expect(run("baseline", "r2", { FAKE_CLAUDE_MARKER: marker }, async () => ({ ok: false }))).rejects.toThrow(/preflight/);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(root, "work", "evals", task.id, "r2"))).toBe(false);
  });

  // Codex review 1, critical (runner side): agent-planted git hooks and config never run.
  it("commits the result without running hooks or fsmonitor the session planted", async () => {
    const evil = join(root, "evil-ran");
    const r = await run("baseline-evil", "r3", { FAKE_CLAUDE_EVIL_MARKER: evil });
    expect(r.finalCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(evil)).toBe(false);
  });

  // Codex review 2, high: nothing passes between runs through the toolchain cache.
  it("gives each run a private cache and deletes it afterwards", async () => {
    const a = await run("cache-spy", "c1");
    const b2 = await run("cache-spy", "c2");
    expect(readFileSync(join(a.workspace, "app.txt"), "utf8")).toBe("saw-note: no\n");
    expect(readFileSync(join(b2.workspace, "app.txt"), "utf8")).toBe("saw-note: no\n");
    expect(existsSync(join(root, "work", "cache-runs", task.id, "c1"))).toBe(false);
    // Private per run, so concurrent runs can't share either.
    const cacheOf = (dir: string) => JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).cacheDir as string;
    expect(cacheOf(a.resultsDir)).not.toBe(cacheOf(b2.resultsDir));
    expect(cacheOf(a.resultsDir)).toContain("c1");
  });

  // Codex review 1, medium: a limited run says so, with when to retry.
  it("reports a usage-limited run with its reset time", async () => {
    const r = await run("rejected", "r4");
    expect(r.resultSubtype).toBe("success"); // the result alone looks fine
    expect(r.usageLimited).toBe(true);
    expect(r.usageWaitUntil).toBe(1792790000);
  });

  it("refuses task files that still ask for live web research", () => {
    const evals = join(root, "evals");
    mkdirSync(join(evals, "tasks", "x"), { recursive: true });
    writeFileSync(join(evals, "tasks", "x", "prompt.md"), "p");
    writeFileSync(join(evals, "tasks", "x", "task.json"), JSON.stringify({ ...task, id: "x", webResearch: true }));
    expect(() => loadTask(evals, "x")).toThrow(/decision 70/);
  });

  // Decision 79: the eval allowlist is a compensating control for the best-effort scanner, so a task
  // file can't widen it. A new host needs its credential forms covered first, then a code change here.
  const evalDomains = ["registry.npmjs.org", "proxy.golang.org", "sum.golang.org", "fonts.googleapis.com", "fonts.gstatic.com"];
  const writeTask = (id: string, allowedDomains: string[]) => {
    const evals = join(root, "evals-79");
    mkdirSync(join(evals, "tasks", id), { recursive: true });
    writeFileSync(join(evals, "tasks", id, "prompt.md"), "p");
    writeFileSync(join(evals, "tasks", id, "task.json"), JSON.stringify({ ...task, id, allowedDomains }));
    return evals;
  };

  it("accepts the decision 79 eval allowlist", () => {
    expect(loadTask(writeTask("ok", evalDomains), "ok").allowedDomains).toEqual(evalDomains);
  });

  it("refuses task files whose allowlist adds a host", () => {
    for (const extra of ["api.github.com", "*.npmjs.org", "registry.npmjs.org:8443", "REGISTRY.NPMJS.ORG.evil.example"]) {
      expect(() => loadTask(writeTask("wide", [...evalDomains, extra]), "wide")).toThrow(/decision 79/);
    }
  });

  it("starts no session when the task's allowlist adds a host", async () => {
    const marker = join(root, "started-wide");
    await expect(runBaseline({ ...task, allowedDomains: ["registry.npmjs.org", "api.github.com"] }, {
      preflight: pass, claudeBin: bin, jarvisHome, workRoot: join(root, "work"), runId: "w1",
      parentEnv: { HOME: root, USER: "t" }, extraEnv: { FAKE_CLAUDE_MODE: "baseline", FAKE_CLAUDE_MARKER: marker },
    })).rejects.toThrow(/decision 79/);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(root, "work", "evals", task.id, "w1"))).toBe(false);
  });
});
