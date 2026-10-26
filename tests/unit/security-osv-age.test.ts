import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { pinnedSecurityScanners } from "../../packages/cli/src/config/pins.ts";
import { hashOsvDatabase } from "../../packages/cli/src/security/osv-database.ts";
import { evaluateSecurity } from "../../packages/cli/src/security/protected.ts";
import { runScanner } from "../../packages/cli/src/security/scanners.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const now = "2026-10-26T12:00:00.000Z";
async function scan(fetchedAt: unknown, clock = now) {
  const root = mkdtempSync(join(tmpdir(), "security-osv-age-")); roots.push(root);
  const checkout = join(root, "checkout"); const fixtures = join(root, "fixtures"); const db = join(fixtures, "security/osv-db");
  mkdirSync(checkout); mkdirSync(db, { recursive: true });
  writeFileSync(join(checkout, "package.json"), "{}"); writeFileSync(join(db, "cache.zip"), "fake database");
  writeFileSync(join(db, "manifest.json"), JSON.stringify({ schema: 1, scannerVersion: "2.7.0", fetchedAt, ecosystems: ["npm"], files: hashOsvDatabase(db) }));
  let calls = 0;
  const result = await runScanner("osv-scanner", pinnedSecurityScanners()["osv-scanner"], checkout, { fixturesDir: fixtures, now: () => new Date(clock), spawn: async (spec) => {
    calls++; return { code: 0, timedOut: false, overflowed: false, durationMs: 0, stderr: "", stdout: spec.args.includes("--version") ? "osv-scanner version: 2.7.0" : '{"results":[]}' };
  } });
  return { result, calls };
}

it("uses a named fourteen-day maximum age", async () => {
  const { OSV_MAX_SNAPSHOT_AGE_MS } = await import("../../packages/cli/src/security/osv-database.ts");
  expect(OSV_MAX_SNAPSHOT_AGE_MS).toBe(14 * 24 * 60 * 60 * 1000);
});
it.each([now, "2026-10-20T12:00:00.000Z", "2026-10-12T12:00:00.000Z"])("accepts a fresh or exact-boundary snapshot: %s", async (date) => {
  const { result, calls } = await scan(date); expect(result.status).toBe("pass"); expect(calls).toBe(2);
});
it.each(["2026-10-12T11:59:59.999Z", "2025-10-26T12:00:00.000Z"])("rejects stale snapshot %s before spawning, with date and refresh instructions", async (date) => {
  const { result, calls } = await scan(date);
  expect(result.status).toBe("error"); expect(result.detail).toContain(date);
  expect(result.detail).toContain("node scripts/osv-db-fetch.mjs <project> <new-folder>");
  expect(result.detail).toContain("reinstall"); expect(calls).toBe(0);
  expect(evaluateSecurity([{ tool: "gitleaks", status: "pass", findings: [] }, { tool: "semgrep", status: "pass", findings: [] }, result], { complete: true, required: false }, { status: "not_run" }, { "osv-scanner": "exempt" })).toBe("not_passed");
});
it.each([undefined, null, 0, "invalid", "2026-02-30T12:00:00.000Z", "2026-10-26", "2026-10-26T12:00:00.001Z"])("rejects missing, invalid or future snapshot dates: %s", async (date) => {
  const { result, calls } = await scan(date); expect(result.status).toBe("error"); expect(calls).toBe(0);
});
it("fails closed on an invalid clock", async () => {
  const { result, calls } = await scan(now, "invalid"); expect(result.status).toBe("error"); expect(calls).toBe(0);
});
