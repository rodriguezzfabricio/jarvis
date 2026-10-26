import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

export const nativeGitApis = ["execFileSync", "spawnSync", "spawn", "execFile", "promisified"];
export type Captured = { value?: string | { stdout: string }; error?: unknown };
type Pair = { native: Captured; configured: Captured };
const probe = fileURLToPath(new URL("./native-git-probe.mjs", import.meta.url));

export function runNativeGitProbe(api: string, root: string, mode = "comparisons") {
  const child = spawnSync(process.execPath, [probe, api, root, mode], {
    cwd: root, env: { HOME: root, PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 10_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout) as { identities: Record<string, boolean>; cases: Record<string, Pair>; controls: Record<string, Pair> };
}
