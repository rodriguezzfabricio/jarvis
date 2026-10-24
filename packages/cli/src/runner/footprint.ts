import { lstatSync, readdirSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DISK_FLOOR_BYTES, DISK_SINGLE_WRITER_BYTES } from "../config/pins.ts";
import type { AppendInput, LedgerEntry } from "../ledger/ledger.ts";
import { formatDuration, latestRunId } from "./usage-log.ts";

/**
 * Footprint log (decisions 26, 63): disk used by worktrees, caches and evidence, peak concurrent
 * sessions and wall time for one run, with flags against doctor's disk thresholds. Sampling never
 * throws: a failed measurement is unknown, and a footprint problem never stops a run.
 */

export interface FootprintRoots { worktrees: string; caches: readonly string[]; evidence: string }
export interface FootprintDeps {
  now?: () => number;
  /** Bytes on disk under a path; the default walks it without following symlinks. */
  diskUsage?: (path: string) => number;
  freeBytes?: (path: string) => number;
}
export interface FootprintSample {
  at: number;
  active: number;
  worktrees: number | null;
  caches: number | null;
  evidence: number | null;
  freeBytes: number | null;
}
type Bytes = { worktrees: number | null; caches: number | null; evidence: number | null };
export type FootprintFlagCode = "below_floor" | "concurrent_below_single_writer" | "below_single_writer" | "free_unknown";
export interface FootprintFlag { level: "fail" | "warn"; code: FootprintFlagCode; message: string }
export interface FootprintSummary {
  startedAt: number;
  endedAt: number;
  wallMs: number;
  peakConcurrent: number;
  samples: number;
  peakBytes: Bytes;
  lastBytes: Bytes;
  minFreeBytes: number | null;
  /** More than one session ran while free space was under the single-writer threshold (decision 63). */
  lowDiskConcurrent: boolean;
  flags: FootprintFlag[];
  problems: string[];
}

/** 1 PB: anything larger is a measurement fault. */
const MAX_BYTES = 1e15;
const MAX_PROBLEMS = 20;
const GB = 1024 ** 3;

/**
 * Allocated bytes under root, from lstat (symlinks are never followed; a hard-linked file counts
 * once). A missing root is 0. Past maxEntries the walk stops and the result is a lower bound.
 */
export function diskUsage(root: string, maxEntries = 2_000_000): number {
  const seen = new Set<string>();
  const stack = [root];
  let total = 0;
  let visited = 0;
  while (stack.length) {
    const path = stack.pop()!;
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (!st) continue;
    if (++visited > maxEntries) break;
    if (st.nlink > 1 && !st.isDirectory()) {
      const id = `${st.dev}:${st.ino}`;
      if (seen.has(id)) continue;
      seen.add(id);
    }
    total += st.blocks * 512;
    if (st.isDirectory()) for (const name of readdirSync(path)) stack.push(join(path, name));
  }
  return total;
}

function defaultFree(path: string): number {
  const s = statfsSync(path);
  return Number(s.bavail) * Number(s.bsize);
}

const plausible = (n: number) => Number.isFinite(n) && n >= 0 && n <= MAX_BYTES;

export function footprintFlags(s: Pick<FootprintSummary, "minFreeBytes" | "lowDiskConcurrent">): FootprintFlag[] {
  const flags: FootprintFlag[] = [];
  if (s.lowDiskConcurrent) flags.push({ level: "fail", code: "concurrent_below_single_writer", message: `More than one session ran with under ${DISK_SINGLE_WRITER_BYTES / GB} GB free; only one writing task is allowed there (decision 63).` });
  if (s.minFreeBytes === null) flags.push({ level: "warn", code: "free_unknown", message: "Free disk space was never measured." });
  else if (s.minFreeBytes < DISK_FLOOR_BYTES) flags.push({ level: "fail", code: "below_floor", message: `Free space fell to ${(s.minFreeBytes / GB).toFixed(1)} GB, under the ${DISK_FLOOR_BYTES / GB} GB floor: doctor refuses unattended runs there (decision 63).` });
  else if (s.minFreeBytes < DISK_SINGLE_WRITER_BYTES) flags.push({ level: "warn", code: "below_single_writer", message: `Free space fell to ${(s.minFreeBytes / GB).toFixed(1)} GB, under ${DISK_SINGLE_WRITER_BYTES / GB} GB: one writing task at a time (decision 63).` });
  return flags;
}

export interface FootprintLog {
  sessionStarted(): void;
  sessionEnded(): void;
  /** Measures now; call between tasks. Never throws. */
  sample(): FootprintSample;
  /** Takes a last sample and returns the run's summary. */
  finish(): FootprintSummary;
}

export function createFootprintLog(roots: FootprintRoots, deps: FootprintDeps = {}): FootprintLog {
  const now = deps.now ?? Date.now;
  const measure = deps.diskUsage ?? ((p: string) => diskUsage(p));
  const free = deps.freeBytes ?? defaultFree;
  const startedAt = now();
  const problems: string[] = [];
  const peak: Bytes = { worktrees: null, caches: null, evidence: null };
  let last: Bytes = { worktrees: null, caches: null, evidence: null };
  let active = 0;
  let peakConcurrent = 0;
  let minFree: number | null = null;
  let lastFree: number | null = null;
  let lowDiskConcurrent = false;
  let samples = 0;

  const problem = (p: string) => { if (!problems.includes(p) && problems.length < MAX_PROBLEMS) problems.push(p); };
  const checkConcurrency = () => {
    if (active > 1 && lastFree !== null && lastFree < DISK_SINGLE_WRITER_BYTES) lowDiskConcurrent = true;
  };
  const read = (label: string, fn: () => number): number | null => {
    try {
      const v = fn();
      if (plausible(v)) return v;
      problem(`${label}: implausible size`);
    } catch (e) {
      problem(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return null;
  };
  const sumOf = (paths: readonly string[]) => () => paths.reduce((total, p) => {
    const v = measure(p);
    if (!plausible(v)) return Number.NaN;
    return total + v;
  }, 0);

  const sample = (): FootprintSample => {
    const at = now();
    const bytes: Bytes = {
      worktrees: read("worktrees", () => measure(roots.worktrees)),
      caches: read("caches", sumOf(roots.caches)),
      evidence: read("evidence", () => measure(roots.evidence)),
    };
    const freeBytes = read("free space", () => free(roots.worktrees));
    samples++;
    for (const key of ["worktrees", "caches", "evidence"] as const) {
      const v = bytes[key];
      if (v !== null && (peak[key] === null || v > peak[key])) peak[key] = v;
    }
    last = bytes;
    if (freeBytes !== null) {
      lastFree = freeBytes;
      if (minFree === null || freeBytes < minFree) minFree = freeBytes;
    }
    checkConcurrency();
    return { at, active, ...bytes, freeBytes };
  };

  return {
    sessionStarted() {
      active++;
      if (active > peakConcurrent) peakConcurrent = active;
      checkConcurrency();
    },
    sessionEnded() {
      if (active > 0) active--;
    },
    sample,
    finish() {
      sample();
      const endedAt = now();
      const summary = { minFreeBytes: minFree, lowDiskConcurrent };
      return {
        startedAt, endedAt, wallMs: Math.max(0, endedAt - startedAt), peakConcurrent, samples,
        peakBytes: { ...peak }, lastBytes: { ...last }, ...summary, flags: footprintFlags(summary), problems: [...problems],
      };
    },
  };
}

const bytes = z.number().min(0).max(MAX_BYTES).nullable();
const bytesSet = z.object({ worktrees: bytes, caches: bytes, evidence: bytes }).strict();
const footprintData = z.object({
  runId: z.string().min(1).max(256),
  startedAt: z.number().finite(),
  endedAt: z.number().finite(),
  wallMs: z.number().min(0).max(366 * 24 * 3_600_000),
  peakConcurrent: z.number().int().min(0).max(1_000),
  samples: z.number().int().min(0),
  peakBytes: bytesSet,
  lastBytes: bytesSet,
  minFreeBytes: bytes,
  lowDiskConcurrent: z.boolean(),
  flags: z.array(z.object({ level: z.enum(["fail", "warn"]), code: z.enum(["below_floor", "concurrent_below_single_writer", "below_single_writer", "free_unknown"]), message: z.string().max(300) }).strict()).max(8),
  problems: z.array(z.string().max(300)).max(MAX_PROBLEMS),
}).strict();

/** Append at run end. */
export function buildFootprintEntry(runId: string, summary: FootprintSummary): AppendInput {
  return { kind: "footprint", actor: "runner", data: footprintData.parse({ runId, ...summary }) };
}

const size = (n: number | null) => (n === null ? "unknown" : n >= GB ? `${(n / GB).toFixed(1)} GB` : `${(n / 1024 ** 2).toFixed(0)} MB`);
const esc = (value: string): string => value.replace(/[\r\n\u0000-\u001f\u007f]/g, " ").replace(/[<>`*_[\]\\|#]/g, "\\$&");

/** The REPORT.md section for the latest (or named) run's footprint entry. */
export function footprintReportLines(entries: readonly LedgerEntry[], options: { runId?: string | null } = {}): string[] {
  const runId = options.runId === undefined ? latestRunId(entries) : options.runId;
  const found = entries.filter((e) => e.kind === "footprint" && e.actor === "runner")
    .map((e) => footprintData.safeParse(e.data)).filter((p) => p.success).map((p) => p.data)
    .filter((d) => runId === null || d.runId === runId).at(-1);
  const lines = ["## Footprint", ""];
  if (!found) return [...lines, "- Not recorded."];
  lines.push(
    `- Wall time: ${formatDuration(found.wallMs)}. Peak concurrent sessions: ${found.peakConcurrent}.`,
    `- Peak disk use: worktrees ${size(found.peakBytes.worktrees)}, caches ${size(found.peakBytes.caches)}, evidence ${size(found.peakBytes.evidence)} (at the end: ${size(found.lastBytes.worktrees)}, ${size(found.lastBytes.caches)}, ${size(found.lastBytes.evidence)}).`,
    `- Lowest free space: ${size(found.minFreeBytes)}.`,
    ...found.flags.map((f) => `- ${f.level === "fail" ? "Fail" : "Warning"}: ${esc(f.message)}`),
  );
  if (found.problems.length) lines.push(`- Measurement problems: ${found.problems.map(esc).join("; ")}.`);
  return lines;
}
