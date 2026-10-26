import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { pinnedSecurityScanners } from "../../packages/cli/src/config/pins.ts";
import { runScanner } from "../../packages/cli/src/security/scanners.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "security-coverage-")); roots.push(root);
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
  return root;
}
async function scan(root: string, paths: unknown = { scanned: [] }, extra = {}) {
  const pin = pinnedSecurityScanners().semgrep!;
  return runScanner("semgrep", pin, root, { spawn: async (spec) => ({ code: 0, timedOut: false, overflowed: false, durationMs: 0, stderr: "", stdout: spec.args.includes("--version") ? pin.version : JSON.stringify({ results: [], errors: [], paths, ...extra }) }) });
}

it.each(["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "py", "pyi", "go"])("rejects an unreported covered .%s file", async (ext) => {
  const root = setup({ [`nested/source.${ext}`]: "eval(input)" });
  expect(await scan(root)).toMatchObject({ status: "error", detail: `semgrep coverage missing: ["nested/source.${ext}"]` });
});
it.each(["#!/usr/bin/env node", "#!/usr/bin/node", "#!/usr/bin/env -S node --no-warnings", "#!/usr/bin/env python3", "#!/usr/bin/python", "#!/usr/bin/env ts-node", "#!/usr/bin/env nodejs"])("detects extensionless covered shebang %s regardless of execute bit", async (shebang) => {
  for (const mode of [0o600, 0o700]) {
    const root = setup({ script: `${shebang}\neval(input);\n` }); chmodSync(join(root, "script"), mode);
    expect(await scan(root)).toMatchObject({ status: "error", detail: 'semgrep coverage missing: ["script"]' });
  }
});
it("accepts complete coverage with relative, dot-relative and absolute reported paths", async () => {
  const root = setup({ "a.mts": "", "nested/b.cts": "", script: "#!/usr/bin/env -S node --no-warnings\n" });
  expect(await scan(root, { scanned: ["./a.mts", "nested/b.cts", join(root, "script")] })).toMatchObject({ status: "pass" });
});
it("does not let an unrelated scanned file cover another file", async () => {
  const root = setup({ "a.ts": "", "b.ts": "" });
  expect(await scan(root, { scanned: ["a.ts", "a.ts", "../b.ts"] })).toMatchObject({ status: "error", detail: 'semgrep coverage missing: ["b.ts"]' });
});
it.each([undefined, null, {}, { scanned: null }, { scanned: "a.ts" }, { scanned: [7] }, { scanned: [""] }])("rejects missing or malformed scan coverage %j even for an empty checkout", async (paths) => {
  const root = setup();
  const result = await scan(root, paths === undefined ? {} : paths);
  expect(result.status).toBe("error");
});
it("names at most twenty missing paths in stable order", async () => {
  const paths = Array.from({ length: 25 }, (_, i) => `source-${String(i).padStart(2, "0")}.mts`);
  const result = await scan(setup(Object.fromEntries(paths.map((path) => [path, "eval(input)"]))));
  expect(result.status).toBe("error");
  expect(result.detail).toBe(`semgrep coverage missing: ${JSON.stringify(paths.slice(0, 20))} (+5 more)`);
});
it("does not inspect Git metadata, unsupported extensions or later shebang lines", async () => {
  const root = setup({ ".git/hidden.ts": "", "README.md": "#!/usr/bin/env node\n", text: "ordinary text\n#!/usr/bin/env node\n", shell: "#!/bin/sh\n", near: "#!/usr/bin/env node-other\n" });
  expect(await scan(root)).toMatchObject({ status: "pass" });
});
it("fails closed on an overlong extensionless shebang and bounds the first-line read", async () => {
  const root = setup({ script: `#!${" ".repeat(4096)}node\n` });
  expect(await scan(root)).toMatchObject({ status: "error", detail: "semgrep coverage unavailable" });
  const ordinary = setup({ data: "x".repeat(1024 * 1024) });
  expect(await scan(ordinary)).toMatchObject({ status: "pass" });
});
it("does not follow candidate symlinks while collecting coverage", async () => {
  const root = setup(); symlinkSync("/missing-security-canary", join(root, "script"));
  expect(await scan(root)).toMatchObject({ status: "error", detail: "semgrep coverage unavailable" });
});
it.each([{ skipped: ["a.ts"] }, { skipped: null }])("still rejects reported skipped paths with complete coverage: %j", async (skip) => {
  expect((await scan(setup({ "a.ts": "" }), { scanned: ["a.ts"], ...skip })).status).toBe("error");
});
it("still rejects skipped_targets with complete coverage", async () => {
  expect((await scan(setup({ "a.ts": "" }), { scanned: ["a.ts"] }, { skipped_targets: ["a.ts"] })).status).toBe("error");
});
it("requires coverage even when the scanner reported a finding", async () => {
  const root = setup({ "visible.js": "", "hidden.mts": "" });
  expect(await scan(root, { scanned: ["visible.js"] }, { results: [{ check_id: "eval", path: "visible.js", start: { line: 1 }, extra: { severity: "ERROR" } }] })).toMatchObject({ status: "error", detail: 'semgrep coverage missing: ["hidden.mts"]' });
});
