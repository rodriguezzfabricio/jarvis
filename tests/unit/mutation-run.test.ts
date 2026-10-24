import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without types
import { active, jobPlan, runAndRead, runGroup, runPool, stopAll, suiteEnv } from "../../scripts/mutation-run.mjs";

// The mutation check's suites run as process groups it can always stop, so a timeout or a signal never
// leaves a suite running or waits forever on a pipe (Codex review of the subset mutation check, 2 and 3).

const dir = mkdtempSync(join(tmpdir(), "jarvis-mutrun-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const fast = { timeoutMs: 400, graceMs: 200 };
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const gone = async (pid: number) => {
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  return !alive(pid);
};
const pidIn = async (file: string) => {
  for (let i = 0; i < 50 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 20));
  return Number(readFileSync(file, "utf8").trim());
};

describe("suite processes", () => {
  it("reports a normal exit like spawnSync did", async () => {
    expect(await runGroup(process.execPath, ["-e", "process.exit(3)"])).toEqual({ status: 3, signal: null });
  });

  it("reports a binary that can't start as an error", async () => {
    const proc = await runGroup(join(dir, "missing-binary"), []);
    expect(proc.error?.code).toBe("ENOENT");
  });

  it("kills a whole TERM-ignoring group on timeout, descendants included", async () => {
    const pidFile = join(dir, "group.pid");
    const proc = await runGroup("/bin/sh", ["-c", `trap '' TERM; sleep 30 & echo $! > ${pidFile}; wait`], fast);
    expect(proc.error?.message).toMatch(/ETIMEDOUT/);
    expect(proc.signal).toBe("SIGKILL");
    expect(await gone(await pidIn(pidFile))).toBe(true);
    expect(active.size).toBe(0);
  });

  it("doesn't wait forever on a pipe held by a descendant that left the group", async () => {
    const pidFile = join(dir, "daemon.pid");
    const daemon = `use POSIX qw(setsid); exit if fork; setsid(); open my $f, ">", "${pidFile}"; print $f "$$\\n"; close $f; sleep 30`;
    const started = Date.now();
    const proc = await runGroup("/usr/bin/perl", ["-e", daemon], fast);
    const pid = await pidIn(pidFile);
    try {
      expect(proc.error?.message).toMatch(/ETIMEDOUT/);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      process.kill(pid, "SIGKILL");
    }
  });

  it("stops output past spawnSync's 1 MB buffer", async () => {
    const proc = await runGroup(process.execPath, ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024)); setTimeout(() => {}, 30000)"], { graceMs: 200 });
    expect(proc.error?.message).toMatch(/ENOBUFS/);
  });

  it("stops every running group on request and resolves their runs", async () => {
    const runs = [runGroup("/bin/sleep", ["30"]), runGroup("/bin/sleep", ["30"])];
    await new Promise((r) => setTimeout(r, 100));
    expect(active.size).toBe(2);
    await stopAll();
    // Every run has ended by the time stopAll resolves.
    expect(active.size).toBe(0);
    expect((await Promise.all(runs)).map((p: { signal: string }) => p.signal)).toEqual(["SIGTERM", "SIGTERM"]);
  });

  it("rejects, rather than throwing out of a callback, when a report is malformed", async () => {
    const report = join(dir, "bad.json");
    const end = join(dir, "bad.end.json");
    const writes = `require('fs').writeFileSync(${JSON.stringify(report)}, '{"testResults": [');require('fs').writeFileSync(${JSON.stringify(end)}, '{}')`;
    await expect(runAndRead(process.execPath, ["-e", writes], {}, { report, end })).rejects.toThrow(SyntaxError);
    writeFileSync(report, "{}");
    const good = await runAndRead(process.execPath, ["-e", "1"], {}, { report, end: join(dir, "none.json") });
    expect(good).toEqual({ proc: { status: 0, signal: null }, report: {}, runEnd: undefined });
  });
});

describe("job pool", () => {
  const later = <T>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));

  it("runs every item once across the workers, keeping the order of results", async () => {
    const seen: string[] = [];
    const out = await runPool([1, 2, 3, 4, 5], ["a", "b"], async (w: string, n: number) => (seen.push(`${w}${n}`), later(5 * n, n * 10)));
    expect(out).toEqual([10, 20, 30, 40, 50]);
    expect(seen.length).toBe(5);
  });

  it("on a failure stops taking items, lets running ones finish, then rejects", async () => {
    const events: string[] = [];
    const run = runPool([1, 2, 3, 4], ["a", "b"], async (_w: string, n: number) => {
      events.push(`start ${n}`);
      if (n === 2) throw new Error("job broke");
      await later(100, 0);
      events.push(`end ${n}`);
    }, { onError: async () => events.push("abort") });
    await expect(run).rejects.toThrow("job broke");
    // Item 1 was running when item 2 failed: it finished before the pool rejected, and nothing new started.
    expect(events).toEqual(["start 1", "start 2", "abort", "end 1"]);
  });

  it("stops taking items once asked to", async () => {
    let stop = false;
    const out = await runPool([1, 2, 3], ["a"], async (_w: string, n: number) => ((stop = true), n), { stopped: () => stop });
    expect(out).toEqual([1, undefined, undefined]);
  });
});

// Main f4661fd: a filtered run's control failed, because the suite it ran inherited JARVIS_MUTATIONS.
describe("suite environment", () => {
  it("keeps the caller's environment but never the mutation check's own settings", () => {
    const env = suiteEnv({ PATH: "/bin", HOME: "/h", JARVIS_MUTATIONS: "^x", JARVIS_MUTATION_CONFIRM: "1", JARVIS_MUTATION_JOBS: "3", JARVIS_OTHER: "kept" }, { JARVIS_TEST_TMP: "/t" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", JARVIS_OTHER: "kept", JARVIS_TEST_TMP: "/t" });
  });
  it("lets a filtered run's control pass a suite that refuses JARVIS_MUTATIONS", async () => {
    const check = "if ('JARVIS_MUTATIONS' in process.env || 'JARVIS_MUTATION_CONFIRM' in process.env) process.exit(1)";
    const filtered = { ...process.env, JARVIS_MUTATIONS: "^review Claude", JARVIS_MUTATION_CONFIRM: "1" };
    expect((await runGroup(process.execPath, ["-e", check], { env: filtered })).status).toBe(1);
    expect((await runGroup(process.execPath, ["-e", check], { env: suiteEnv(filtered) })).status).toBe(0);
  });
});

describe("job plan", () => {
  it("keeps one job's default workers, and splits one full run's worker budget between jobs", () => {
    expect(jobPlan(1, 8)).toEqual({ jobs: 1, flags: [] });
    expect(jobPlan(3, 8)).toEqual({ jobs: 3, flags: ["--maxWorkers=2"] });
  });
  it("caps the jobs at the worker budget (cpus - 1)", () => {
    expect(jobPlan(8, 8)).toEqual({ jobs: 7, flags: ["--maxWorkers=1"] });
    expect(jobPlan(20, 4)).toEqual({ jobs: 3, flags: ["--maxWorkers=1"] });
    expect(jobPlan(2, 1)).toEqual({ jobs: 1, flags: [] });
  });
});
