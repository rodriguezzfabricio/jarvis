import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as coverage from "../../packages/cli/src/security/coverage.ts";
import { ChecksStore } from "../../packages/cli/src/checks/store.ts";
import { pinnedSecurityScanners } from "../../packages/cli/src/config/pins.ts";
import type { SessionOutcome, SessionSpec } from "../../packages/cli/src/proc/session.ts";
import { installSecurityChecks } from "../../packages/cli/src/security/protected.ts";
import { parseFindings, runScanner } from "../../packages/cli/src/security/scanners.ts";

vi.mock("node:fs", async (original) => ({ ...await original<typeof fs>() }));

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "security-mapped-")); roots.push(root);
  const checkout = join(root, "checkout"); mkdirSync(checkout);
  for (const [name, text] of Object.entries(files)) { mkdirSync(dirname(join(checkout, name)), { recursive: true }); writeFileSync(join(checkout, name), text); }
  return { root, checkout };
}
const ok = (stdout: string): SessionOutcome => ({ code: 0, stdout, stderr: "", timedOut: false, overflowed: false, durationMs: 0 });
const row = (path: string) => ({ check_id: "jarvis.js.eval", path, start: { line: 2 }, extra: { severity: "ERROR", lines: "private snippet" } });
const report = (scanned: string[], findings: unknown[] = []) => JSON.stringify({ results: findings, errors: [], paths: { scanned } });
async function scan(checkout: string, second: (spec: SessionSpec, names: string[]) => SessionOutcome = (_spec, names) => ok(report(names))) {
  const pin = pinnedSecurityScanners().semgrep!; const calls: SessionSpec[] = [];
  const result = await runScanner("semgrep", pin, checkout, { homeDir: join(dirname(checkout), "home"), tmpDir: join(dirname(checkout), "tmp"), spawn: async (spec) => {
    calls.push(spec);
    if (spec.args.includes("--version")) return ok(pin.version);
    if (spec.cwd === checkout) return ok(report(readdirSync(checkout).filter((name) => name.endsWith(".js"))));
    return second(spec, readdirSync(spec.cwd));
  } });
  return { result, calls };
}

it.each([
  ["nested/app.mts", "", ".ts"], ["app.cts", "", ".ts"], ["app.MTS", "", ".ts"],
  ["app.TSX", "", ".tsx"], ["app.JS", "", ".js"], ["app.PY", "", ".py"], ["app.GO", "", ".go"],
  ["script", "#!/usr/bin/env node\n", ".js"], ["script", "#!/usr/bin/env tsx\n", ".ts"],
  ["script", "#!/usr/bin/env -S npx tsx\n", ".ts"], ["script", "#!/usr/bin/env ts-node-esm\n", ".ts"],
  ["script", "#!/usr/bin/env bun\n", ".ts"], ["script", "#!/usr/bin/env deno run\n", ".ts"],
  ["script", "#!/usr/bin/env python3\n", ".py"],
])("maps %s (%s) into %s with the same pinned invocation and exact bytes", async (name, prefix, extension) => {
  const text = `${prefix}eval(input);\n`; const { checkout } = setup({ [name!]: text });
  const { result, calls } = await scan(checkout, (spec, names) => {
    expect(names).toHaveLength(1); expect(extname(names[0]!)).toBe(extension);
    expect(readFileSync(join(spec.cwd, names[0]!), "utf8")).toBe(text);
    expect(statSync(spec.cwd).mode & 0o777).toBe(0o700);
    expect(statSync(join(spec.cwd, names[0]!)).mode & 0o777).toBe(0o600);
    return ok(report(names));
  });
  expect(result.status).toBe("pass"); expect(calls).toHaveLength(3);
  expect(calls[2]).toMatchObject({ bin: calls[1]!.bin, args: calls[1]!.args, env: calls[1]!.env });
  expect(existsSync(calls[2]!.cwd)).toBe(false);
});

it.each(["relative", "dot-relative", "absolute"])("maps %s findings back before fingerprinting, and combines both passes", async (form) => {
  const { checkout } = setup({ "nested/app.mts": "eval(input);", "visible.js": "" });
  const { result } = await scan(checkout, (spec, names) => {
    const path = form === "absolute" ? join(spec.cwd, names[0]!) : form === "dot-relative" ? `./${names[0]}` : names[0]!;
    return { ...ok(report([path], [row(path)])), code: 1 };
  });
  expect(result.status).toBe("fail");
  expect(result.findings).toEqual(parseFindings("semgrep", report(["nested/app.mts"], [row("nested/app.mts")])));
  expect(JSON.stringify(result)).not.toContain("private snippet");
});

it("keeps colliding basenames distinct and never copies already scanned files", async () => {
  const { checkout } = setup({ "a.mts": "first", "a.cts": "second", "dir/a.mts": "third", "a.js": "original" });
  const { result, calls } = await scan(checkout, (spec, names) => {
    expect(names).toHaveLength(3);
    expect(names.map((name) => readFileSync(join(spec.cwd, name), "utf8")).sort()).toEqual(["first", "second", "third"]);
    return ok(report(names, names.map(row)));
  });
  expect(result.status).toBe("fail"); expect(result.findings.map((finding) => finding.file).sort()).toEqual(["a.cts", "a.mts", "dir/a.mts"]);
  expect(calls).toHaveLength(3);
});

it("requires every mapped file in the second scanned list even when a finding names it", async () => {
  const { checkout } = setup({ "a.mts": "", "b.cts": "" });
  const { result, calls } = await scan(checkout, (_spec, names) => ok(report(names.slice(0, 1), names.map(row))));
  expect(calls).toHaveLength(3); expect(result).toMatchObject({ status: "error", detail: 'semgrep coverage missing: ["b.cts"]' });
});

it("does not accept original paths as evidence for mapped files", async () => {
  const { checkout } = setup({ "a.mts": "" });
  const { result, calls } = await scan(checkout, () => ok(report(["a.mts"])));
  expect(calls).toHaveLength(3); expect(result.status).toBe("error");
});

it("still requires mapped coverage if an original disappears during the second pass", async () => {
  const { checkout } = setup({ "a.mts": "", "b.cts": "" });
  const { result, calls } = await scan(checkout, (_spec, names) => {
    rmSync(join(checkout, "b.cts")); return ok(report(names.slice(0, 1)));
  });
  expect(calls).toHaveLength(3); expect(result.status).toBe("error");
});

it("does not manufacture coverage for ordinary files the first pass missed", async () => {
  const { checkout } = setup({ "a.ts": "", "b.mts": "" });
  const { result } = await scan(checkout);
  expect(result).toMatchObject({ status: "error", detail: 'semgrep coverage missing: ["a.ts"]' });
});

it("runs no second pass when nothing needs mapping", async () => {
  const { checkout } = setup({ "a.js": "", "notes.txt": "" });
  const { result, calls } = await scan(checkout); expect(result.status).toBe("pass"); expect(calls).toHaveLength(2);
});

it.each(["timeout", "overflow", "exit", "empty-exit-one", "malformed", "parse-error", "skipped", "outside-finding", "throw"])("fails closed and cleans up after second-pass %s", async (fault) => {
  const { checkout } = setup({ "a.mts": "" });
  const { result, calls } = await scan(checkout, (spec, names) => {
    if (fault === "throw") throw Error("private diagnostic");
    if (fault === "malformed") return ok("{}");
    if (fault === "parse-error") return ok(JSON.stringify({ results: [], errors: ["private diagnostic"], paths: { scanned: names } }));
    if (fault === "skipped") return ok(JSON.stringify({ results: [], errors: [], paths: { scanned: names, skipped: [names[0]] } }));
    if (fault === "outside-finding") return ok(report(names, [row(join(spec.cwd, "../outside.ts"))]));
    return { ...ok(report(names)), timedOut: fault === "timeout", overflowed: fault === "overflow", code: fault === "exit" ? 2 : fault === "empty-exit-one" ? 1 : 0 };
  });
  expect(calls).toHaveLength(3); expect(result.status).toBe("error"); expect(JSON.stringify(result)).not.toContain("private diagnostic");
  expect(existsSync(calls[2]!.cwd)).toBe(false);
});

it.each(["count", "bytes", "aggregate"])("bounds mapped %s before invoking the second scanner", async (kind) => {
  const { MAX_MAPPED_FILES, MAX_MAPPED_BYTES } = await import("../../packages/cli/src/security/mapped.ts");
  expect(MAX_MAPPED_FILES).toBe(4096); expect(MAX_MAPPED_BYTES).toBe(64 * 1024 * 1024);
  const { checkout } = setup();
  if (kind === "count") for (let i = 0; i <= MAX_MAPPED_FILES; i++) writeFileSync(join(checkout, `${i}.mts`), "");
  else for (const name of kind === "aggregate" ? ["a.mts", "b.mts"] : ["a.mts"]) {
    writeFileSync(join(checkout, name), ""); truncateSync(join(checkout, name), kind === "aggregate" ? MAX_MAPPED_BYTES / 2 + 1 : MAX_MAPPED_BYTES + 1);
  }
  const { result, calls } = await scan(checkout); expect(result.status).toBe("error"); expect(calls).toHaveLength(2);
}, 60_000);

it.each(["link", "directory-link", "fifo"])("refuses a %s in the candidate before copying", async (kind) => {
  const { root, checkout } = setup({ "a.mts": "" });
  writeFileSync(join(root, "outside.mts"), "dummy canary");
  if (kind === "fifo") execFileSync("/usr/bin/mkfifo", [join(checkout, "pipe.mts")]);
  else symlinkSync(kind === "link" ? join(root, "outside.mts") : root, join(checkout, "link.mts"));
  const { result, calls } = await scan(checkout); expect(result.status).toBe("error"); expect(calls).toHaveLength(2);
});

it("installs the mapped driver in the protected fixtures", () => {
  const { root } = setup(); const store = new ChecksStore(join(root, "project"));
  installSecurityChecks(store, { nodeBin: process.execPath, scanners: {} });
  expect(Object.keys(store.hashAll())).toContain("fixtures/security/security/mapped.ts");
});

it.each(["link", "directory-link", "fifo"])("rechecks a %s at copy time even after a successful inventory", async (kind) => {
  const { withMappedSemgrep } = await import("../../packages/cli/src/security/mapped.ts");
  const { root, checkout } = setup(); const scratch = join(root, "scratch"); mkdirSync(scratch);
  writeFileSync(join(root, "canary.mts"), "dummy canary");
  const path = kind === "directory-link" ? "nested/canary.mts" : "canary.mts";
  if (kind === "fifo") execFileSync("/usr/bin/mkfifo", [join(checkout, path)]);
  else symlinkSync(kind === "link" ? join(root, "canary.mts") : root, join(checkout, kind === "link" ? path : "nested"));
  vi.spyOn(coverage, "coveredFiles").mockReturnValue([path]);
  let called = false;
  const rejected = await withMappedSemgrep(checkout, [], scratch, async () => { called = true; }).then(() => false, () => true);
  expect(rejected).toBe(true);
  expect(called).toBe(false); expect(readdirSync(scratch)).toEqual([]);
});

it.each(["link", "fifo"])("refuses a source replaced by a %s between lstat and open", async (kind) => {
  const { withMappedSemgrep } = await import("../../packages/cli/src/security/mapped.ts");
  const { root, checkout } = setup({ "app.mts": "original" }); const scratch = join(root, "scratch"); mkdirSync(scratch);
  const source = join(checkout, "app.mts"); const canary = join(root, "outside"); writeFileSync(canary, "dummy canary");
  const open = fs.openSync;
  vi.spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
    if (path === source) { rmSync(source); if (kind === "link") symlinkSync(canary, source); else execFileSync("/usr/bin/mkfifo", [source]); }
    return open(path, flags, mode);
  });
  let called = false;
  const rejected = await withMappedSemgrep(checkout, [], scratch, async () => { called = true; }).then(() => false, () => true);
  expect(rejected).toBe(true);
  expect(called).toBe(false); expect(readdirSync(scratch)).toEqual([]);
});

it("retains findings from both passes", async () => {
  const { checkout } = setup({ "a.js": "eval(input);", "b.mts": "eval(input);" });
  const pin = pinnedSecurityScanners().semgrep!;
  const result = await runScanner("semgrep", pin, checkout, { spawn: async (spec) => {
    if (spec.args.includes("--version")) return ok(pin.version);
    const names = spec.cwd === checkout ? ["a.js"] : readdirSync(spec.cwd);
    return { ...ok(report(names, names.map(row))), code: 1 };
  } });
  expect(result.status).toBe("fail"); expect(result.findings.map((finding) => finding.file)).toEqual(["a.js", "b.mts"]);
});
