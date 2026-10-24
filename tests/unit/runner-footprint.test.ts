import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DISK_FLOOR_BYTES, DISK_SINGLE_WRITER_BYTES } from "../../packages/cli/src/config/pins.ts";
import { Ledger, type LedgerEntry } from "../../packages/cli/src/ledger/ledger.ts";
import {
  buildFootprintEntry, createFootprintLog, diskUsage, footprintFlags, footprintReportLines, type FootprintSummary,
} from "../../packages/cli/src/runner/footprint.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));
const fresh = () => { const root = mkdtempSync(join(realpathSync("/tmp"), "jarvis-foot-")); roots.push(root); return root; };
const GB = 1024 ** 3;
const paths = { worktrees: "/w", caches: ["/c1", "/c2"], evidence: "/e" };

function fake(sizes: Record<string, number>, free: number[] = [100 * GB]) {
  let time = 1_000;
  const frees = [...free];
  return {
    advance: (ms: number) => { time += ms; },
    deps: {
      now: () => time,
      diskUsage: (p: string) => { const v = sizes[p]; if (v === undefined) throw new Error(`EACCES ${p}`); return v; },
      freeBytes: () => (frees.length > 1 ? frees.shift()! : frees[0]!),
    },
  };
}

const summary = (extra: Partial<FootprintSummary> = {}): FootprintSummary => ({
  startedAt: 0, endedAt: 1, wallMs: 1, peakConcurrent: 1, samples: 1,
  peakBytes: { worktrees: 1, caches: 1, evidence: 1 }, lastBytes: { worktrees: 1, caches: 1, evidence: 1 },
  minFreeBytes: 100 * GB, lowDiskConcurrent: false, flags: [], problems: [], ...extra,
});

describe("footprint log", () => {
  it("tracks peak bytes per category, peak concurrent sessions, minimum free space and wall time", () => {
    const sizes: Record<string, number> = { "/w": 10, "/c1": 5, "/c2": 6, "/e": 1 };
    const f = fake(sizes, [90 * GB, 80 * GB, 85 * GB]);
    const log = createFootprintLog(paths, f.deps);
    log.sessionStarted(); log.sessionStarted();
    expect(log.sample()).toMatchObject({ at: 1_000, active: 2, worktrees: 10, caches: 11, evidence: 1, freeBytes: 90 * GB });
    sizes["/w"] = 50; sizes["/e"] = 3;
    log.sessionEnded(); log.sessionStarted(); log.sessionEnded(); log.sessionEnded(); log.sessionEnded();
    f.advance(3_600_000);
    log.sample();
    sizes["/w"] = 0;
    const s = log.finish();
    expect(s).toMatchObject({
      startedAt: 1_000, endedAt: 3_601_000, wallMs: 3_600_000, peakConcurrent: 2, samples: 3,
      peakBytes: { worktrees: 50, caches: 11, evidence: 3 }, lastBytes: { worktrees: 0, caches: 11, evidence: 3 },
      minFreeBytes: 80 * GB, lowDiskConcurrent: false, flags: [], problems: [],
    });
  });

  it("counts concurrency without going negative on an extra end, and keeps the peak", () => {
    const log = createFootprintLog(paths, fake({ "/w": 1, "/c1": 1, "/c2": 1, "/e": 1 }).deps);
    log.sessionStarted(); log.sessionStarted(); log.sessionEnded(); log.sessionEnded(); log.sessionEnded(); log.sessionStarted();
    expect(log.sample().active).toBe(1);
    expect(log.finish().peakConcurrent).toBe(2);
  });

  it("never throws when a measurement fails, and records the problem once", () => {
    const f = fake({ "/w": 10, "/c1": 1, "/e": 1 });
    const failingFree = { ...f.deps, freeBytes: () => { throw new Error("statfs failed"); } };
    const log = createFootprintLog(paths, failingFree);
    expect(log.sample()).toMatchObject({ worktrees: 10, caches: null, evidence: 1, freeBytes: null });
    log.sample();
    const s = log.finish();
    expect(s.problems).toEqual(["caches: EACCES /c2", "free space: statfs failed"]);
    expect(s.peakBytes.caches).toBeNull();
    expect(s.minFreeBytes).toBeNull();
    expect(s.flags.map((x) => x.code)).toEqual(["free_unknown"]);
  });

  it("rejects absurd measurements instead of reporting them", () => {
    const f = fake({ "/w": -5, "/c1": Number.NaN, "/c2": 1, "/e": 1e300 }, [Number.POSITIVE_INFINITY]);
    const log = createFootprintLog(paths, f.deps);
    expect(log.sample()).toMatchObject({ worktrees: null, caches: null, evidence: null, freeBytes: null });
    expect(log.finish().problems).toEqual(expect.arrayContaining(["worktrees: implausible size", "evidence: implausible size", "free space: implausible size"]));
  });

  it("flags concurrency while free space was under the single-writer threshold", () => {
    const f = fake({ "/w": 1, "/c1": 1, "/c2": 1, "/e": 1 }, [DISK_SINGLE_WRITER_BYTES - 1]);
    const log = createFootprintLog(paths, f.deps);
    log.sample();
    log.sessionStarted(); log.sessionStarted();
    const s = log.finish();
    expect(s.lowDiskConcurrent).toBe(true);
    expect(s.flags.map((x) => [x.level, x.code])).toEqual([["fail", "concurrent_below_single_writer"], ["warn", "below_single_writer"]]);
  });

  it("does not flag one writer at a time under 40 GB as a concurrency problem", () => {
    const f = fake({ "/w": 1, "/c1": 1, "/c2": 1, "/e": 1 }, [DISK_SINGLE_WRITER_BYTES - 1]);
    const log = createFootprintLog(paths, f.deps);
    log.sessionStarted(); log.sample(); log.sessionEnded(); log.sessionStarted(); log.sample();
    expect(log.finish().flags.map((x) => x.code)).toEqual(["below_single_writer"]);
  });

  it.each([
    [DISK_FLOOR_BYTES - 1, ["below_floor"]],
    [DISK_FLOOR_BYTES, ["below_single_writer"]],
    [DISK_SINGLE_WRITER_BYTES - 1, ["below_single_writer"]],
    [DISK_SINGLE_WRITER_BYTES, []],
  ] as const)("uses doctor's thresholds: %s bytes free flags %j", (free, codes) => {
    expect(footprintFlags(summary({ minFreeBytes: free })).map((x) => x.code)).toEqual(codes);
  });

  it("measures real disk use without following symlinks and counts hard links once", () => {
    const root = fresh();
    const outside = fresh();
    writeFileSync(join(outside, "big"), Buffer.alloc(1024 * 1024));
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(join(root, "a", "b", "f"), Buffer.alloc(1024 * 1024));
    linkSync(join(root, "a", "b", "f"), join(root, "a", "hard"));
    symlinkSync(join(outside, "big"), join(root, "a", "link"));
    symlinkSync(outside, join(root, "dirlink"));
    const bytes = diskUsage(root);
    const file = statSync(join(root, "a", "b", "f")).blocks * 512;
    expect(bytes).toBeGreaterThanOrEqual(file);
    expect(bytes).toBeLessThan(file + 512 * 1024);
    expect(diskUsage(join(root, "missing"))).toBe(0);
  });

  it("stops at its entry cap with a lower bound instead of walking forever", () => {
    const root = fresh();
    for (let i = 0; i < 20; i++) writeFileSync(join(root, `f${i}`), "x");
    expect(diskUsage(root, 5)).toBeLessThan(diskUsage(root));
  });

  it("writes a runner footprint entry and renders it with its flags", () => {
    const ledger = Ledger.open(fresh());
    ledger.append({ kind: "run_started", actor: "runner", data: { runId: "r1", pid: 42 } });
    ledger.append(buildFootprintEntry("r1", summary({ minFreeBytes: DISK_FLOOR_BYTES - 1, peakConcurrent: 2, wallMs: 3_720_000, flags: footprintFlags(summary({ minFreeBytes: DISK_FLOOR_BYTES - 1 })) })));
    const list: LedgerEntry[] = ledger.entries();
    expect(list.at(-1)).toMatchObject({ kind: "footprint", actor: "runner", data: { runId: "r1", peakConcurrent: 2 } });
    const text = footprintReportLines(list).join("\n");
    expect(text).toContain("## Footprint");
    expect(text).toContain("Peak concurrent sessions: 2");
    expect(text).toContain("1h 02m");
    expect(text).toMatch(/Fail: .*20 GB/);
  });

  it("ignores footprint entries from other runs, the broker or with absurd data", () => {
    const entry = buildFootprintEntry("r0", summary());
    const list = [
      { kind: "run_started", actor: "runner", data: { runId: "r1", pid: 1 } },
      entry,
      { ...entry, data: { ...(entry.data as object), runId: "r1" }, actor: "broker" },
      { ...entry, data: { ...(entry.data as object), runId: "r1", wallMs: -1 } },
    ].map((e, i) => ({ task_id: null, attempt_id: null, ...e, seq: i + 1, ts: "", prev_hash: "", hash: String(i) })) as LedgerEntry[];
    expect(footprintReportLines(list)).toEqual(["## Footprint", "", "- Not recorded."]);
  });

  it("refuses a summary with impossible values when building the entry", () => {
    expect(() => buildFootprintEntry("r1", summary({ wallMs: -1 }))).toThrow();
    expect(() => buildFootprintEntry("", summary())).toThrow();
  });
});
