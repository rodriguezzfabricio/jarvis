import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { SessionSpec } from "../../packages/cli/src/proc/session.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "security-db-fetch-")); roots.push(root);
  const projectDir = join(root, "project"); const outputDir = join(root, "db"); mkdirSync(projectDir);
  return { root, projectDir, outputDir };
}
const outcome = (code: number) => ({ code, stdout: "", stderr: "dummy diagnostic", timedOut: false, overflowed: false, durationMs: 0 });

it("detects supported ecosystems in nested projects without following symlinks or dependencies", async () => {
  const { detectOsvEcosystems } = await import("../../packages/cli/src/security/osv-database.ts");
  const { root, projectDir } = setup(); mkdirSync(join(projectDir, "api")); mkdirSync(join(projectDir, "node_modules"));
  writeFileSync(join(projectDir, "package.json"), "{}"); writeFileSync(join(projectDir, "api/go.mod"), "module jarvis.invalid/canary");
  writeFileSync(join(projectDir, "node_modules/requirements.txt"), "fake==1");
  writeFileSync(join(root, "requirements.txt"), "fake==1"); symlinkSync(root, join(projectDir, "outside"));
  expect(detectOsvEcosystems(projectDir)).toEqual(["npm", "Go"]);
  writeFileSync(join(projectDir, "pyproject.toml"), "[project]"); expect(detectOsvEcosystems(projectDir)).toEqual(["npm", "Go", "PyPI"]);
});

it("fetches only detected ecosystems through pinned OSV into a staging cache and records every hash", async () => {
  const { fetchOsvDatabase } = await import("../../packages/cli/src/security/osv-db-fetch.ts");
  const { projectDir, outputDir } = setup(); writeFileSync(join(projectDir, "go.mod"), "module jarvis.invalid/canary"); writeFileSync(join(projectDir, "package.json"), "{}");
  const calls: SessionSpec[] = []; const stamp = "2026-10-24T00:00:00.000Z";
  const manifest = await fetchOsvDatabase({ projectDir, outputDir }, { now: () => new Date(stamp), spawn: async (spec) => {
    calls.push(spec);
    if (spec.args.includes("--version")) return { ...outcome(0), stdout: "osv-scanner version: 2.7.0\nosv-scalibr version: 0.5.3\n" };
    const cache = spec.env.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY!; mkdirSync(join(cache, "nested"), { recursive: true }); writeFileSync(join(cache, "nested/cache.zip"), "fake downloaded database");
    return outcome(1);
  } });
  expect(calls[0]!.bin).toBe("/opt/homebrew/bin/osv-scanner");
  expect(calls[1]!.args).toEqual(expect.arrayContaining(["--offline", "--offline-vulnerabilities", "--download-offline-databases", "--x-plugins=vulnmatch/osvlocal"]));
  expect(calls[1]!.cwd).not.toBe(projectDir);
  const inputs = calls[1]!.args.filter((arg, i, args) => args[i - 1] === "--lockfile");
  expect(inputs.map((p) => p.split("/").at(-1)).sort()).toEqual(["go.mod", "package-lock.json"]);
  expect(manifest).toMatchObject({ schema: 1, scannerVersion: "2.7.0", fetchedAt: stamp, ecosystems: ["npm", "Go"], files: [{ path: "nested/cache.zip", sha256: createHash("sha256").update("fake downloaded database").digest("hex") }] });
  expect(JSON.parse(readFileSync(join(outputDir, "manifest.json"), "utf8"))).toEqual(manifest);
  expect(existsSync(calls[1]!.env.HOME!)).toBe(false);
});

it.each(["exit", "timeout", "overflow", "empty", "symlink", "version"])("does not publish a cache after %s failure", async (fault) => {
  const { fetchOsvDatabase } = await import("../../packages/cli/src/security/osv-db-fetch.ts");
  const { root, projectDir, outputDir } = setup(); writeFileSync(join(projectDir, "requirements.txt"), "fake==1");
  await expect(fetchOsvDatabase({ projectDir, outputDir }, { spawn: async (spec) => {
    if (spec.args.includes("--version")) return { ...outcome(0), stdout: `osv-scanner version: ${fault === "version" ? "2.8.0" : "2.7.0"}\nosv-scalibr version: 0.5.3\n` };
    const cache = spec.env.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY!;
    if (fault === "symlink") symlinkSync(root, join(cache, "outside"));
    else if (fault !== "empty") writeFileSync(join(cache, "cache.zip"), "fake database");
    return { ...outcome(fault === "exit" ? 127 : 0), timedOut: fault === "timeout", overflowed: fault === "overflow" };
  } })).rejects.toThrow();
  expect(existsSync(outputDir)).toBe(false);
});

it("refuses replacing a database, output inside the project, and projects without supported ecosystems", async () => {
  const { fetchOsvDatabase } = await import("../../packages/cli/src/security/osv-db-fetch.ts");
  const { projectDir, outputDir } = setup(); let spawns = 0; const deps = { spawn: async () => { spawns++; return outcome(0); } };
  await expect(fetchOsvDatabase({ projectDir, outputDir }, deps)).rejects.toThrow(/ecosystem/);
  writeFileSync(join(projectDir, "package.json"), "{}");
  await expect(fetchOsvDatabase({ projectDir, outputDir: join(projectDir, "db") }, deps)).rejects.toThrow(/outside/);
  mkdirSync(outputDir); writeFileSync(join(outputDir, "keep"), "existing");
  await expect(fetchOsvDatabase({ projectDir, outputDir }, deps)).rejects.toThrow(/exists/);
  expect(readFileSync(join(outputDir, "keep"), "utf8")).toBe("existing"); expect(spawns).toBe(0);
});
