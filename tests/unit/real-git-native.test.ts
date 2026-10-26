import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { shortTmp } from "../helpers.ts";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const probe = fileURLToPath(new URL("./helpers/native-git-probe.mjs", import.meta.url));
it.each(["execFileSync", "spawnSync", "spawn", "execFile", "promisified"])("keeps native %s execution, including cwd/PATH changes and caller environment", api => {
  const root = shortTmp("jgn-"); roots.push(root);
  const child = spawnSync(process.execPath, [probe, api, root], {
    cwd: root, env: { HOME: root, PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 10_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout) as { identities: Record<string, boolean>; cases: Record<string, { native: unknown; configured: unknown }> };
  expect(Object.keys(result.cases)).toEqual(["absolute", "first PATH executable", "relative PATH", "empty PATH entry", "before earlier executable", "new earlier executable", "missing PATH", "no options", "shell", "absolute system git", "CPATH", "LIBRARY_PATH", "MANPATH", "SDKROOT", "failed git"]);
  for (const [name, value] of Object.entries(result.cases)) expect.soft(value.configured, name).toEqual(value.native);
  expect(result.identities).toEqual({ execFileSync: true, spawnSync: true, spawn: true, execFile: true, promisified: true });
});
