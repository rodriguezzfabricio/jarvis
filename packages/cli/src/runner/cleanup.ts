import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { leaseExpired, type ProcessGroupRecord, type RunnerLease, type RunState } from "./state.ts";

export interface CleanupInput {
  state: RunState;
  pidFile: string;
  worktreeRoot: string;
  now?: () => number;
  pidAlive?: (pid: number) => boolean;
  readProcessStartTime?: ProcessStartTimeReader;
  /** Receives a negative group ID, as process.kill does. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}
export interface CleanupResult {
  deadRunIds: string[];
  workspaces: string[];
  processGroups: number[];
  removed: string[];
  killed: number[];
  skippedGroups: number[];
  refused: string[];
  errors: string[];
}


export type ProcessStartTimeReader = (pid: number) => string | null;

/** ps is called by absolute path and in a fixed locale; no candidate environment is inherited. */
export function readProcessStartTime(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error("invalid process identity PID");
  try {
    const value = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeout: 2000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value ? value.replace(/\s+/g, " ") : null;
  } catch (e) {
    if ((e as { status?: number }).status === 1) return null;
    throw e;
  }
}

/** Capture immediately after spawning a detached group, and persist in its creation checkpoint. */
export function captureProcessGroup(groupId: number, read: ProcessStartTimeReader = readProcessStartTime): ProcessGroupRecord | null {
  if (!Number.isSafeInteger(groupId) || groupId < 2) throw new Error("invalid process group");
  const startedAt = read(groupId)?.trim().replace(/\s+/g, " ");
  return startedAt ? { groupId, leaderPid: groupId, startedAt, exited: false } : null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((e as NodeJS.ErrnoException).code === "EPERM") return true;
    throw e;
  }
}

function beneath(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** No symlink component is followed, even when its destination happens to be inside the root. */
function removable(root: string, path: string): boolean {
  if (!isAbsolute(path) || !beneath(root, resolve(path))) return false;
  let cursor = root;
  for (const part of relative(root, resolve(path)).split(sep)) {
    cursor = join(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) return false;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw e;
    }
  }
  return beneath(root, realpathSync(path));
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const parent = dirname(absolute);
    if (parent === absolute) throw e;
    return join(canonicalPath(parent), basename(absolute));
  }
}

function ownsPath(path: string, lease: RunnerLease, state: RunState): boolean {
  const paths = lease.workspace ? [lease.workspace] : state.runs.find((r) => r.runId === lease.runId)?.workspaces ?? [];
  return paths.some((owned) => {
    const a = canonicalPath(path);
    const b = canonicalPath(owned);
    return a === b || beneath(a, b) || beneath(b, a);
  });
}

function previousPid(input: CleanupInput): number | null {
  if (!existsSync(input.pidFile)) return null;
  const content = readFileSync(input.pidFile, "utf8").trim();
  if (!/^[1-9][0-9]*$/.test(content) || !Number.isSafeInteger(Number(content)) || Number(content) < 2) throw new Error("invalid runner.pid");
  const pid = Number(content);
  if (!input.state.runs.some((r) => r.pid === pid)) throw new Error("runner.pid does not match a recorded run");
  return pid;
}

function cleanGroups(input: CleanupInput, result: CleanupResult, active: RunnerLease[]): void {
  const kill = input.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const protectedGroups = new Set(active.flatMap((l) => l.processGroup ? [l.processGroup] : input.state.runs.find((r) => r.runId === l.runId)?.processGroups ?? []));
  for (const group of result.processGroups) {
    if (protectedGroups.has(group)) continue;
    try {
      const records = input.state.runs.filter((run) => result.deadRunIds.includes(run.runId)).flatMap((run) => run.processGroupRecords).filter((record) => record.groupId === group);
      const identity = records.at(-1);
      if (!identity || records.some((record) => record.exited && record.startedAt === identity.startedAt)) {
        result.skippedGroups.push(group);
        continue;
      }
      const current = (input.readProcessStartTime ?? readProcessStartTime)(identity.leaderPid);
      if (current?.trim().replace(/\s+/g, " ") !== identity.startedAt.trim().replace(/\s+/g, " ")) {
        result.skippedGroups.push(group);
        continue;
      }
      kill(-group, "SIGKILL");
      result.killed.push(group);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") result.errors.push(`process group ${group}: ${String(e)}`);
    }
  }
}

/** Only runner-recorded leftovers of dead runs are eligible; unrecorded folders are left alone. */
export function cleanupLeftovers(input: CleanupInput): CleanupResult {
  const result: CleanupResult = { deadRunIds: [], workspaces: [], processGroups: [], removed: [], killed: [], skippedGroups: [], refused: [], errors: [] };
  const alive = input.pidAlive ?? pidAlive;
  const previous = previousPid(input);
  if (previous !== null && alive(previous)) return result;
  const dead = input.state.runs.filter((r) => !r.ended && !alive(r.pid));
  result.deadRunIds = dead.map((r) => r.runId);
  result.workspaces = [...new Set(dead.flatMap((r) => r.workspaces))];
  result.processGroups = [...new Set(dead.flatMap((r) => r.processGroups))];
  if (result.processGroups.some((g) => !Number.isSafeInteger(g) || g < 2 || g === process.pid)) throw new Error("invalid recorded process group");
  const active = input.state.activeLeases.filter((l) => !leaseExpired(l, { now: input.now ?? Date.now, pidAlive: alive }));
  cleanGroups(input, result, active);
  if (!existsSync(input.worktreeRoot)) return result;
  const root = realpathSync(input.worktreeRoot);
  if (lstatSync(input.worktreeRoot).isSymbolicLink()) throw new Error("worktree root may not be a symlink");
  for (const path of result.workspaces) {
    if (ownsPathInActive(path, active, input.state)) continue;
    if (!removable(root, path)) { result.refused.push(path); continue; }
    try {
      rmSync(path, { recursive: true, force: true });
      result.removed.push(path);
    } catch (e) {
      result.errors.push(`workspace ${path}: ${String(e)}`);
    }
  }
  return result;
}

function ownsPathInActive(path: string, active: RunnerLease[], state: RunState): boolean {
  return active.some((lease) => ownsPath(path, lease, state));
}
