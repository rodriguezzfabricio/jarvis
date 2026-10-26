import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

export const nativeGitApis = ["execFileSync", "spawnSync", "spawn", "execFile", "promisified"];
export const comparisonBatches = [
  ["absolute", "first PATH executable", "relative PATH"],
  ["empty PATH entry", "before earlier executable", "new earlier executable"],
  ["missing PATH", "no options", "shell"],
  ["absolute system git", "CPATH", "LIBRARY_PATH"],
  ["MANPATH", "SDKROOT", "failed git"],
];
export const faultBatches = [
  ["unchanged", "redirect", "argv"],
  ["cwd", "CPATH", "LIBRARY_PATH"],
  ["MANPATH", "SDKROOT", "relative PATH"],
  ["cached PATH", "failed git"],
];
export type Captured = { value?: string | { stdout: string }; error?: unknown };
type Pair = { native: Captured; configured: Captured };
type ProbeResult = {
  identities: Record<string, boolean>; cases: Record<string, Pair>; controls: Record<string, Pair>;
  executions: { name: string; native: boolean }[];
};
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const probe = fileURLToPath(new URL("./native-git-probe.mjs", import.meta.url));

export function runNativeGitProbe(api: string, root: string, mode: "comparisons" | "faults", selected: readonly string[]) {
  expect(selected.length).toBeGreaterThan(0);
  expect(selected.length).toBeLessThanOrEqual(3);
  expect(new Set(selected).size).toBe(selected.length);
  const child = spawnSync(process.execPath, [probe, api, root, mode, JSON.stringify(selected)], {
    cwd: root, env: { HOME: root, PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 10_000,
  });
  // Worker infrastructure must never become an assertion the mutation classifier accepts as caught.
  const infrastructure = (detail: string, cause?: unknown) => new Error(
    `native git probe ${api} ${mode} ${JSON.stringify(selected)} cwd=${root}: ${detail}; status=${child.status} signal=${child.signal}\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`,
    { cause },
  );
  if (child.error) throw infrastructure(`spawn failed (${(child.error as NodeJS.ErrnoException).code ?? child.error.name}): ${child.error.message}`, child.error);
  if (child.signal !== null) throw infrastructure("worker terminated by signal");
  if (child.status !== 0) throw infrastructure("worker exited unsuccessfully");
  let result: ProbeResult;
  try {
    const parsed: unknown = JSON.parse(child.stdout);
    if (!record(parsed) || !record(parsed.identities) || !record(parsed.cases) || !record(parsed.controls) || !Array.isArray(parsed.executions)) {
      throw new Error("invalid worker result envelope");
    }
    result = parsed as ProbeResult;
  } catch (cause) {
    throw infrastructure("malformed worker output", cause);
  }
  expect(Object.keys(result.cases)).toEqual(mode === "comparisons" ? selected : []);
  expect(Object.keys(result.controls)).toEqual(mode === "faults" ? selected : []);
  // A record alone would silently overwrite repeated case names.
  expect(result.executions).toEqual(selected.flatMap(name => [{ name, native: true }, { name, native: false }]));
  expect(result.identities).toEqual({ execFileSync: true, spawnSync: true, spawn: true, execFile: true, promisified: true });
  return result;
}
