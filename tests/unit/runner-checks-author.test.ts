import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync, linkSync } from "node:fs";
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installChecks, readAuthoredChecks, readInstalledChecks, buildChecksReviewPrompt, readPlanningFile } from "../../packages/cli/src/runner/checks-author.ts";
import { ChecksStore } from "../../packages/cli/src/checks/store.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";

vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>() }));
const roots: string[] = [];
const root = () => { const p = mkdtempSync("/private/tmp/j-author-"); roots.push(p); return p; };
const complete = 'echo "JARVIS-CHECK-COMPLETE $(cat "$JARVIS_COMPLETION_FILE")"\n';
const check = () => ({ name: "ac1", criteria: ["AC1"], cases: [{ id: "main", command: 'node "$JARVIS_FIXTURES/drive.mjs"' }], verify: 'sh "$JARVIS_CHECKS/verify.sh"', timeoutMs: 1000 });
const spec = { criteria: [{ id: "AC1", storyId: "S1", text: "WHEN asked THE SYSTEM SHALL return the result.", details: "", line: 1 }] };
function workspace() {
  const p = root(); const dir = join(p, ".jarvis/checks"); mkdirSync(join(dir, "fixtures"), { recursive: true }); mkdirSync(join(dir, "expected"));
  writeFileSync(join(dir, "ac1.check.json"), JSON.stringify(check()));
  writeFileSync(join(dir, "fixtures/drive.mjs"), 'import { execFileSync } from "node:child_process";\nconsole.log(execFileSync(process.execPath, ["src/cli.mjs", "input"], { encoding: "utf8" }));\n');
  writeFileSync(join(dir, "expected/result.txt"), "result\n");
  writeFileSync(join(dir, "verify.sh"), 'set -eu\ntest "$(cat "$JARVIS_OUT/main/code")" = 0\ndiff "$JARVIS_CHECKS/expected/result.txt" "$JARVIS_OUT/main/stdout"\n' + complete);
  return { p, dir };
}
function project() { const p = root(); return { p, store: new ChecksStore(p), ledger: Ledger.open(p) }; }
afterEach(() => { vi.restoreAllMocks(); for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
describe("authored protected checks", () => {
  it("captures check definitions, black-box drivers, expectations and separate verify files", () => {
    const w = workspace(); const files = readAuthoredChecks(w.p);
    expect(files.checks).toEqual([check()]); expect(Object.keys(files.files).sort()).toEqual(["ac1.check.json", "expected/result.txt", "fixtures/drive.mjs", "verify.sh"]);
  });
  it.each([
    ["empty cases", { cases: [] }], ["missing verify", { verify: "" }], ["duplicate cases", { cases: [{ id: "main", command: "node src/cli.mjs" }, { id: "main", command: "node src/cli.mjs" }] }],
    ["escaping case id", { cases: [{ id: "../out", command: "node src/cli.mjs" }] }], ["invalid timeout", { timeoutMs: 0 }],
    ["expectations in case", { cases: [{ id: "main", command: 'diff "$JARVIS_CHECKS/expected/result.txt" result' }] }],
    ["missing verifier", { verify: 'sh "$JARVIS_CHECKS/missing.sh"' }], ["escaping verifier", { verify: 'sh "$JARVIS_CHECKS/../outside.sh"' }],
    ["unit test as acceptance", { cases: [{ id: "main", command: "node --test" }] }],
  ])("rejects %s", (_name, change) => {
    const w = workspace(); writeFileSync(join(w.dir, "ac1.check.json"), JSON.stringify({ ...check(), ...change }));
    expect(() => readAuthoredChecks(w.p)).toThrow();
  });
  it.each([
    'import { result } from "../../src/result.mjs"; console.log(result());',
    'const candidate = await import(process.cwd() + "/src/result.mjs");',
    'import assert from "node:assert/strict"; assert.equal(value, 42);',
    'const expectation = "$JARVIS_CHECKS/expected/result.txt";',
    'const expected = 42; if (observed !== expected) process.exit(1);',
    'import { spawnSync } from "node:child_process"; spawnSync("node", ["src/server.mjs"], { stdio: "inherit" });',
  ])("rejects candidate imports or expectations in fixtures: %s", (source) => {
    const w = workspace(); writeFileSync(join(w.dir, "fixtures/drive.mjs"), source); expect(() => readAuthoredChecks(w.p)).toThrow();
  });
  it.each([
    ["fixtures/expected.txt", "42"],
    ["fixtures/input.json", '{"cases":[{"input":2,"expected":4}]}'],
  ])("rejects expectation files or keys in %s", (path, content) => {
    const w = workspace(); writeFileSync(join(w.dir, path), content);
    expect(() => readAuthoredChecks(w.p)).toThrow(/expectation/i);
  });
  it("allows a separate child process to adapt a library API to stdout", () => {
    const w = workspace();
    writeFileSync(join(w.dir, "fixtures/drive.mjs"), `import { execFileSync } from "node:child_process";
const childCode = 'const { result } = await import("./src/result.mjs"); console.log(result());';
console.log(execFileSync(process.execPath, ["--input-type=module", "-e", childCode], { encoding: "utf8" }));
`);
    expect(readAuthoredChecks(w.p).checks).toHaveLength(1);
  });
  it("requires a reachable completion nonce and distinct driver/verify phases", () => {
    const w = workspace(); writeFileSync(join(w.dir, "verify.sh"), "exit 0\n"); expect(() => readAuthoredChecks(w.p)).toThrow(/completion|nonce/i);
    writeFileSync(join(w.dir, "ac1.check.json"), JSON.stringify({ ...check(), verify: 'sh "$JARVIS_CHECKS/fixtures/drive.mjs"' })); expect(() => readAuthoredChecks(w.p)).toThrow();
  });
  it.each(["file", "fixtures", "checks", "jarvis"])("refuses symlinked %s", (where) => {
    const w = workspace(); const other = workspace();
    const part = { file: "checks/fixtures/drive.mjs", fixtures: "checks/fixtures", checks: "checks", jarvis: "" }[where]!;
    const dest = join(w.p, ".jarvis", part); const source = join(other.p, ".jarvis", part);
    rmSync(dest, { recursive: true, force: true }); symlinkSync(source, dest); expect(() => readAuthoredChecks(w.p)).toThrow();
  });
  it("bounds individual files, total bytes and file count", () => {
    const w = workspace(); writeFileSync(join(w.dir, "expected/big"), "x".repeat(262145)); expect(() => readAuthoredChecks(w.p)).toThrow();
    rmSync(join(w.dir, "expected/big"));
    for (let i = 0; i < 17; i++) writeFileSync(join(w.dir, `expected/f${i}`), "x".repeat(262144));
    expect(() => readAuthoredChecks(w.p)).toThrow();
    for (let i = 0; i < 17; i++) rmSync(join(w.dir, `expected/f${i}`));
    for (let i = 0; i < 257; i++) writeFileSync(join(w.dir, `expected/f${i}`), "");
    expect(() => readAuthoredChecks(w.p)).toThrow();
  });
  it("rejects hardlinked files and unexpected top-level artifacts", () => {
    const w = workspace(); linkSync(join(w.dir, "expected/result.txt"), join(w.dir, "expected/alias.txt"));
    expect(() => readAuthoredChecks(w.p)).toThrow();
    rmSync(join(w.dir, "expected/alias.txt")); writeFileSync(join(w.dir, "planner-notes.md"), "planner account");
    expect(() => readAuthoredChecks(w.p)).toThrow();
  });
  it("does not run an in-process candidate from the verifier", () => {
    const w = workspace(); writeFileSync(join(w.dir, "verify.sh"), 'node src/cli.mjs\n' + complete);
    expect(() => readAuthoredChecks(w.p)).toThrow();
  });
  it("keeps generic project unit checks separate from AC checks", () => {
    const w = workspace(); writeFileSync(join(w.dir, "unit.check.json"), JSON.stringify({ ...check(), name: "unit", criteria: [], cases: [{ id: "unit", command: "node --test" }] }));
    expect(readAuthoredChecks(w.p).checks.map((c) => c.name)).toEqual(["ac1", "unit"]);
  });
  it("rejects duplicate check names", () => { const w = workspace(); writeFileSync(join(w.dir, "other.check.json"), JSON.stringify(check())); expect(() => readAuthoredChecks(w.p)).toThrow(); });
  it("builds the fresh reviewer's input from ACs and files only", () => {
    const w = workspace(); writeFileSync(join(w.p, ".jarvis/notes.md"), "PLANNER-NOTES-DO-NOT-INCLUDE");
    const prompt = buildChecksReviewPrompt(spec, readAuthoredChecks(w.p));
    expect(prompt).toContain(spec.criteria[0]!.text); expect(prompt).toContain("fixtures/drive.mjs"); expect(prompt).toContain("node:child_process"); expect(prompt).toContain("black box"); expect(prompt).not.toContain("PLANNER-NOTES-DO-NOT-INCLUDE");
  });
  it("reviews the snapshot and approves its exact hashes with ChecksStore", async () => {
    const w = workspace(); const p = project(); const files = readAuthoredChecks(w.p);
    const reviewVerdict = vi.fn(async () => { writeFileSync(join(w.dir, "expected/result.txt"), "changed\n"); return { status: "pass" }; });
    await installChecks(p.store, files, p.ledger, { spec, reviewVerdict });
    expect(reviewVerdict).toHaveBeenCalledOnce(); expect(p.store.verify(p.ledger).ok).toBe(true);
    expect(readFileSync(join(p.store.checksDir, "expected/result.txt"), "utf8")).toBe("result\n");
  });
  it.each([{ status: "fail" }, { status: "PASS" }, {}, { status: "pass", extra: "unknown" }])("never copies or approves a non-pass verdict %j", async (verdict) => {
    const w = workspace(); const p = project();
    await expect(installChecks(p.store, readAuthoredChecks(w.p), p.ledger, { spec, reviewVerdict: async () => verdict })).rejects.toThrow();
    expect(p.ledger.entries()).toHaveLength(0); expect(existsSync(p.store.checksDir)).toBe(false);
  });
  it("does not install caller mutations made while the reviewer is running", async () => {
    const w = workspace(); const p = project(); const files = readAuthoredChecks(w.p);
    await installChecks(p.store, files, p.ledger, { spec, reviewVerdict: async () => {
      files.files["expected/result.txt"] = "UNREVIEWED";
      return { status: "pass" };
    } });
    expect(readFileSync(join(p.store.checksDir, "expected/result.txt"), "utf8")).toBe("result\n");
  });
  it("does not install after reviewer failure", async () => {
    const w = workspace(); const p = project(); await expect(installChecks(p.store, readAuthoredChecks(w.p), p.ledger, { spec, reviewVerdict: async () => { throw new Error("review crashed"); } })).rejects.toThrow("review crashed");
    expect(p.ledger.entries()).toHaveLength(0);
  });
  it("reviews changes again and includes retained files instead of silently approving them", async () => {
    const w = workspace(); const p = project(); const reviewVerdict = vi.fn(async () => ({ status: "pass" }));
    await installChecks(p.store, readAuthoredChecks(w.p), p.ledger, { spec, reviewVerdict });
    writeFileSync(join(p.store.checksDir, "expected/retained.txt"), "RETAINED-FILE");
    p.store.approve(p.ledger, "retained file approved");
    writeFileSync(join(w.dir, "expected/result.txt"), "new\n");
    let rejectedPrompt = "";
    await expect(installChecks(p.store, readAuthoredChecks(w.p), p.ledger, { spec, reviewVerdict: async (prompt) => { rejectedPrompt = prompt; return { status: "fail" }; } })).rejects.toThrow();
    expect(rejectedPrompt).toContain("RETAINED-FILE");
    expect(JSON.parse(rejectedPrompt.split("\n").at(-1)!).files["expected/retained.txt"]).toBe("RETAINED-FILE");
    expect(readFileSync(join(p.store.checksDir, "expected/result.txt"), "utf8")).toBe("result\n");
    await installChecks(p.store, readAuthoredChecks(w.p), p.ledger, { spec, reviewVerdict });
    expect(reviewVerdict).toHaveBeenCalledTimes(2); expect(p.ledger.entries().filter((e) => e.kind === "checks_approved")).toHaveLength(3);
  });
  it("requires another review if protected files change while review is pending", async () => {
    const w = workspace(); const p = project(); const files = readAuthoredChecks(w.p);
    await installChecks(p.store, files, p.ledger, { spec, reviewVerdict: async () => ({ status: "pass" }) });
    await expect(installChecks(p.store, files, p.ledger, { spec, reviewVerdict: async () => {
      writeFileSync(join(p.store.checksDir, "expected/raced.txt"), "unreviewed concurrent change");
      return { status: "pass" };
    } })).rejects.toThrow(/changed during review/);
    expect(p.ledger.entries().filter((e) => e.kind === "checks_approved")).toHaveLength(1);
  });
  it("fails closed if installation or approval cannot finish", async () => {
    const w = workspace(); const p = project();
    vi.spyOn(p.store, "approve").mockImplementation(() => { throw new Error("disk failure"); });
    await expect(installChecks(p.store, readAuthoredChecks(w.p), p.ledger, { spec, reviewVerdict: async () => ({ status: "pass" }) })).rejects.toThrow("disk failure");
    expect(p.ledger.entries()).toHaveLength(0); expect(p.store.verify(p.ledger).ok).toBe(false);
  });
  it("requires authored checks to cover the spec and rejects invented AC ids", async () => {
    const w = workspace(); const p = project(); const files = readAuthoredChecks(w.p);
    const reviewVerdict = vi.fn(async () => ({ status: "pass" }));
    await expect(installChecks(p.store, files, p.ledger, { spec: { criteria: [{ ...spec.criteria[0]!, id: "AC2" }] }, reviewVerdict })).rejects.toThrow();
    expect(reviewVerdict).not.toHaveBeenCalled();
  });
  it("revalidates caller bundles and destination symlinks before reviewing or writing", async () => {
    const w = workspace(); const p = project(); const files = readAuthoredChecks(w.p); const reviewVerdict = vi.fn(async () => ({ status: "pass" }));
    await expect(installChecks(p.store, { ...files, files: { ...files.files, "fixtures/../escape": "bad" } }, p.ledger, { spec, reviewVerdict })).rejects.toThrow();
    symlinkSync(w.dir, p.store.checksDir);
    await expect(installChecks(p.store, files, p.ledger, { spec, reviewVerdict })).rejects.toThrow(); expect(reviewVerdict).not.toHaveBeenCalled();
  });
  it.each([
    'import { createRequire } from "node:module"; createRequire(import.meta.url)("../../src/x.cjs");',
    'import { spawnSync } from "node:child_process"; spawnSync("node", ["src/server.mjs"], { stdio: ["ignore", "inherit", "inherit"] });',
  ])("rejects createRequire and inherited stdio arrays: %s", (source) => {
    const w = workspace(); writeFileSync(join(w.dir, "fixtures/drive.mjs"), source);
    expect(() => readAuthoredChecks(w.p)).toThrow(/black box/);
  });
  it.each([["attack.py", "assert result == expected"], ["answers.txt", "42"], ["input.csv", "one,two"]])("rejects non-driver, non-JSON fixture %s", (file, content) => {
    const w = workspace(); writeFileSync(join(w.dir, "fixtures", file), content);
    expect(() => readAuthoredChecks(w.p)).toThrow(/driver scripts or JSON/);
  });
  it("accepts JSON input and drivers with captured stdio", () => {
    const w = workspace(); writeFileSync(join(w.dir, "fixtures/input.json"), '{"value":42}');
    writeFileSync(join(w.dir, "fixtures/drive.mjs"), 'import { spawnSync } from "node:child_process"; console.log(spawnSync("node", ["src/cli.mjs"], { stdio: ["ignore", "pipe", "pipe"] }).stdout.toString());');
    expect(readAuthoredChecks(w.p).checks).toHaveLength(1);
  });
  it.each([`node -e 'import("./src/app.mjs")'`, `node -e 'require("./src/app.cjs")'`])("rejects in-process acceptance command %s", (command) => {
    const w = workspace(); writeFileSync(join(w.dir, "ac1.check.json"), JSON.stringify({ ...check(), cases: [{ id: "main", command }] }));
    expect(() => readAuthoredChecks(w.p)).toThrow(/black box/);
  });
  it.each(['import("./src/app.mjs")', 'require("./src/app.cjs")'])("rejects verifier source loading candidate code: %s", (source) => {
    const w = workspace(); writeFileSync(join(w.dir, "verify.sh"), source + "\n" + complete);
    expect(() => readAuthoredChecks(w.p)).toThrow(/may not run candidate/);
  });
  it.each([
    ['echo "JARVIS-CHECK-COMPLETE hardcoded"', "completion file"],
    ['cat "$JARVIS_COMPLETION_FILE"', "completion prefix"],
  ])("requires each nonce protocol half independently: %s", (source) => {
    const w = workspace(); writeFileSync(join(w.dir, "verify.sh"), source);
    expect(() => readAuthoredChecks(w.p)).toThrow(/completion nonce/);
  });
  it.each(["root", "ancestor"])("rejects a replaced planning %s during a file read", (target) => {
    const w = workspace(); const dir = target === "root" ? w.p : join(w.dir, "fixtures");
    const actual = fs.lstatSync; let reads = 0;
    vi.spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike, options?: unknown) => {
      const st = actual(path, options as never);
      return String(path) === dir && ++reads === 2 ? Object.assign(st, { ino: st.ino + 1 }) : st;
    }) as typeof fs.lstatSync);
    expect(() => readPlanningFile(w.p, ".jarvis/checks/fixtures/drive.mjs")).toThrow(/directory changed/);
  });
  it("rejects an empty directory replaced during the tree read", () => {
    const w = workspace(); const dir = join(w.dir, "empty"); mkdirSync(dir);
    const actual = fs.lstatSync; let reads = 0;
    vi.spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike, options?: unknown) => {
      const st = actual(path, options as never);
      return String(path) === dir && ++reads === 3 ? Object.assign(st, { dev: st.dev + 1 }) : st;
    }) as typeof fs.lstatSync);
    expect(() => readAuthoredChecks(w.p)).toThrow(/directory changed/);
  });
  it.each(["mtimeMs", "ctimeMs"] as const)("rejects same-size file races detected only by %s", (field) => {
    const w = workspace(); const actual = fs.fstatSync; let reads = 0;
    vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number) => {
      const st = actual(fd);
      return ++reads === 2 ? { ...st, [field]: st[field] + 1 } : st;
    }) as typeof fs.fstatSync);
    expect(() => readPlanningFile(w.p, ".jarvis/checks/fixtures/drive.mjs")).toThrow(/file changed during read/);
  });
  it("restores approved checks when the second install rename fails", async () => {
    const w = workspace(); const p = project(); const files = readAuthoredChecks(w.p);
    await installChecks(p.store, files, p.ledger, { spec, reviewVerdict: async () => ({ status: "pass" }) });
    const previous = p.store.hashAll(); const actual = fs.renameSync; let renames = 0;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (++renames === 2) throw new Error("second rename failed");
      return actual(from, to);
    });
    await expect(installChecks(p.store, files, p.ledger, { spec, reviewVerdict: async () => ({ status: "pass" }) })).rejects.toThrow("second rename failed");
    expect(p.store.hashAll()).toEqual(previous); expect(p.store.verify(p.ledger).ok).toBe(true);
    expect(p.ledger.entries().filter((e) => e.kind === "checks_approved")).toHaveLength(1);
  });
  it("preserves the backup if restoring after a rename failure also fails", async () => {
    const w = workspace(); const p = project(); const files = readAuthoredChecks(w.p);
    await installChecks(p.store, files, p.ledger, { spec, reviewVerdict: async () => ({ status: "pass" }) });
    const actual = fs.renameSync; let renames = 0;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (++renames >= 2) throw new Error("rename unavailable");
      return actual(from, to);
    });
    await expect(installChecks(p.store, files, p.ledger, { spec, reviewVerdict: async () => ({ status: "pass" }) })).rejects.toThrow();
    const backup = fs.readdirSync(p.p).find((file) => file.endsWith("-previous"));
    expect(backup).toBeDefined();
    expect(readFileSync(join(p.p, backup!, "verify.sh"), "utf8")).toBe(files.files["verify.sh"]);
  });
  it("includes every bypass probe in reviewer instructions, architect guidance and a distinct eval", () => {
    const prompt = buildChecksReviewPrompt(spec, readAuthoredChecks(workspace().p)).split("\n").slice(0, -1).join("\n");
    const skill = readFileSync(new URL("../../skills/architect/SKILL.md", import.meta.url), "utf8");
    const evals = JSON.parse(readFileSync(new URL("../../skills/architect/evals/evals.json", import.meta.url), "utf8")).evals as { prompt: string }[];
    for (const probe of ["createRequire(import.meta.url)", 'new Function("return imp"+"ort(p)")', ".py", "fixtures/answers.txt", 'stdio: ["ignore","inherit","inherit"]', "node src/server.mjs &", "from src.app import f", "only echoes the nonce"]) {
      expect(prompt).toContain(probe); expect(skill).toContain(probe);
      expect(evals.some((e) => e.prompt.includes(probe))).toBe(true);
    }
    expect(prompt).toContain("advisory"); expect(prompt).toContain("fresh review");
  });
  it("provides approved lock hashes, unified added/removed/changed diffs and named removed cases", async () => {
    const w = workspace(); const p = project(); const original = readAuthoredChecks(w.p);
    original.files["obsolete.sh"] = "old helper\n";
    await installChecks(p.store, original, p.ledger, { spec, reviewVerdict: async () => ({ status: "pass" }) });
    const hashes = p.store.hashAll(); const lockHash = p.store.verify(p.ledger).lockHash;
    const files = { ...readAuthoredChecks(w.p).files, "ac1.check.json": JSON.stringify({ ...check(), cases: [{ id: "replacement", command: "node src/cli.mjs" }] }), "verify.sh": "# revised\n" + original.files["verify.sh"], "added.sh": "new helper\n" };
    let captured = "";
    await expect(installChecks(p.store, { checks: [], files }, p.ledger, { spec, removeFiles: ["obsolete.sh"], reviewVerdict: async (prompt) => { captured = prompt; return { status: "fail" }; } })).rejects.toThrow();
    const data = JSON.parse(captured.split("\n").at(-1)!);
    expect(data.previous).toEqual({ lockHash, files: hashes });
    expect(data.diffs).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: "added.sh", diff: expect.stringContaining("--- /dev/null\n+++ b/added.sh\n@@ -0,0 +1,1 @@\n+new helper\n") }),
      expect.objectContaining({ file: "obsolete.sh", diff: expect.stringContaining("--- a/obsolete.sh\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-old helper\n") }),
      expect.objectContaining({ file: "verify.sh", diff: expect.stringContaining("--- a/verify.sh\n+++ b/verify.sh\n@@") }),
    ]));
    expect(data.removedCases).toEqual([{ check: "ac1", caseId: "main" }]);
    expect(data.changedVerifyFiles).toEqual(["obsolete.sh", "verify.sh"]);
    expect(captured).toContain("justify");
  });
  it("makes valid unified diffs for files lacking final newlines and empty files", async () => {
    const w = workspace(); const p = project(); const original = readAuthoredChecks(w.p);
    original.files["helper.sh"] = "old"; original.files["empty.sh"] = "";
    await installChecks(p.store, original, p.ledger, { spec, reviewVerdict: async () => ({ status: "pass" }) });
    const files = { ...original.files, "helper.sh": "new\n", "empty.sh": "line" };
    let captured = "";
    await expect(installChecks(p.store, { checks: [], files }, p.ledger, { spec, reviewVerdict: async (prompt) => { captured = prompt; return { status: "fail" }; } })).rejects.toThrow();
    const data = JSON.parse(captured.split("\n").at(-1)!);
    expect(data.diffs).toEqual([
      { file: "empty.sh", diff: "--- a/empty.sh\n+++ b/empty.sh\n@@ -0,0 +1,1 @@\n+line\n\\ No newline at end of file\n" },
      { file: "helper.sh", diff: "--- a/helper.sh\n+++ b/helper.sh\n@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new\n" },
    ]);
  });
  it.each([{}, { removedCases: [{ check: "ac1", caseId: "other", reason: "wrong case" }] }, { removedCases: [{ check: "ac1", caseId: "main", reason: " " }] }])("fails a pass lacking a specific removed-case justification: %j", async (justifications) => {
    const w = workspace(); const p = project(); const original = readAuthoredChecks(w.p);
    await installChecks(p.store, original, p.ledger, { spec, reviewVerdict: async () => ({ status: "pass" }) });
    const files = { ...original.files, "ac1.check.json": JSON.stringify({ ...check(), cases: [{ id: "other", command: "node src/cli.mjs" }] }) };
    await expect(installChecks(p.store, { checks: [], files }, p.ledger, { spec, reviewVerdict: async () => ({ status: "pass", ...justifications }) })).rejects.toThrow();
    expect(p.store.verify(p.ledger).ok).toBe(true); expect(p.ledger.entries().filter((e) => e.kind === "checks_approved")).toHaveLength(1);
  });
  it("accepts specifically justified case removals and verifier command changes", async () => {
    const w = workspace(); const p = project(); const original = readAuthoredChecks(w.p);
    await installChecks(p.store, original, p.ledger, { spec, reviewVerdict: async () => ({ status: "pass" }) });
    const files = { ...original.files, "ac1.check.json": JSON.stringify({ ...check(), cases: [{ id: "replacement", command: "node src/cli.mjs" }], verify: 'sh "$JARVIS_CHECKS/verify.sh" main' }) };
    await expect(installChecks(p.store, { checks: [], files }, p.ledger, { spec, reviewVerdict: async () => ({ status: "pass", removedCases: [{ check: "ac1", caseId: "main", reason: "Replacement covers the same behavior." }] }) })).rejects.toThrow(/justify.*ac1.check.json/);
    await installChecks(p.store, { checks: [], files }, p.ledger, { spec, reviewVerdict: async () => ({ status: "pass", removedCases: [{ check: "ac1", caseId: "main", reason: "Replacement covers the same behavior." }], changedVerifyFiles: [{ file: "ac1.check.json", reason: "The original verifier remains required before completion." }] }) });
    expect(p.store.verify(p.ledger).ok).toBe(true);
  });
  it("removes an explicitly named file only after a justified review", async () => {
    const w = workspace(); const p = project(); const original = readAuthoredChecks(w.p);
    original.files["obsolete.sh"] = "# unused helper\n";
    await installChecks(p.store, original, p.ledger, { spec, reviewVerdict: async () => ({ status: "pass" }) });
    await installChecks(p.store, readAuthoredChecks(w.p), p.ledger, { spec, removeFiles: ["obsolete.sh"], reviewVerdict: async () => ({ status: "pass", changedVerifyFiles: [{ file: "obsolete.sh", reason: "Unused helper; no observation coverage lost." }] }) });
    expect(existsSync(join(p.store.checksDir, "obsolete.sh"))).toBe(false); expect(p.store.verify(p.ledger).ok).toBe(true);
  });
  it.each([{ removeFiles: ["../outside"] }, { removeFiles: ["missing.sh"] }, { removeFiles: ["verify.sh"] }])("refuses invalid, missing or simultaneously proposed removals %j", async ({ removeFiles }) => {
    const w = workspace(); const p = project(); const files = readAuthoredChecks(w.p);
    await installChecks(p.store, files, p.ledger, { spec, reviewVerdict: async () => ({ status: "pass" }) });
    const reviewVerdict = vi.fn(async () => ({ status: "pass" }));
    await expect(installChecks(p.store, files, p.ledger, { spec, removeFiles, reviewVerdict })).rejects.toThrow(/removal/);
    expect(reviewVerdict).not.toHaveBeenCalled(); expect(p.store.verify(p.ledger).ok).toBe(true);
  });
  it("refuses an unapproved baseline instead of representing it as an approved diff", async () => {
    const w = workspace(); const p = project(); const files = readAuthoredChecks(w.p);
    await installChecks(p.store, files, p.ledger, { spec, reviewVerdict: async () => ({ status: "pass" }) });
    writeFileSync(join(p.store.checksDir, "verify.sh"), "# tampered\n" + files.files["verify.sh"]);
    const reviewVerdict = vi.fn(async () => ({ status: "pass" }));
    await expect(installChecks(p.store, files, p.ledger, { spec, reviewVerdict })).rejects.toThrow(/approved/);
    expect(reviewVerdict).not.toHaveBeenCalled();
  });
  it("refuses malformed JSON fixture data", () => {
    const w = workspace(); writeFileSync(join(w.dir, "fixtures/input.json"), "this is not JSON");
    expect(() => readAuthoredChecks(w.p)).toThrow(/JSON/);
  });
  it.each(["direct verifier", "script helper"])("requires a reason for a changed nested %s", async (kind) => {
    const w = workspace(); const p = project(); const original = readAuthoredChecks(w.p);
    const file = kind === "direct verifier" ? "expected/verify.txt" : "expected/helper.sh";
    if (kind === "direct verifier") {
      original.files[file] = original.files["verify.sh"]!;
      original.files["ac1.check.json"] = JSON.stringify({ ...check(), verify: `sh "$JARVIS_CHECKS/${file}"` });
    } else {
      original.files[file] = "# verifier helper\n";
      original.files["verify.sh"] = `sh "$JARVIS_CHECKS/${file}"\n` + original.files["verify.sh"];
    }
    await installChecks(p.store, original, p.ledger, { spec, reviewVerdict: async () => ({ status: "pass" }) });
    const files = { ...original.files, [file]: "# changed\n" + original.files[file] };
    await expect(installChecks(p.store, { checks: [], files }, p.ledger, { spec, reviewVerdict: async () => ({ status: "pass" }) })).rejects.toThrow(/justify.*expected/);
    await installChecks(p.store, { checks: [], files }, p.ledger, { spec, reviewVerdict: async () => ({ status: "pass", changedVerifyFiles: [{ file, reason: "Preserves every observation assertion." }] }) });
    expect(p.store.verify(p.ledger).ok).toBe(true);
  });
  it("requires a justification for every changed verifier file and accepts complete reasons", async () => {
    const w = workspace(); const p = project(); const original = readAuthoredChecks(w.p);
    await installChecks(p.store, original, p.ledger, { spec, reviewVerdict: async () => ({ status: "pass" }) });
    const files = { ...original.files, "verify.sh": "# revised\n" + original.files["verify.sh"] };
    for (const changedVerifyFiles of [undefined, [{ file: "other.sh", reason: "wrong file" }], [{ file: "verify.sh", reason: " " }]]) {
      await expect(installChecks(p.store, { checks: [], files }, p.ledger, { spec, reviewVerdict: async () => ({ status: "pass", ...(changedVerifyFiles ? { changedVerifyFiles } : {}) }) })).rejects.toThrow();
    }
    await installChecks(p.store, { checks: [], files }, p.ledger, { spec, reviewVerdict: async () => ({ status: "pass", changedVerifyFiles: [{ file: "verify.sh", reason: "Retains all observations; adds explanatory comment." }] }) });
    expect(p.store.verify(p.ledger).ok).toBe(true);
    expect((p.ledger.entries().at(-1)!.data as { reason: string }).reason).toContain("Retains all observations");
  });

});

describe("installed checks for the runner", () => {
  it("reads the approved installed checks exactly as installChecks approved them", async () => {
    const w = workspace(); const p = project(); const files = readAuthoredChecks(w.p);
    const installed = await installChecks(p.store, files, p.ledger, { spec, reviewVerdict: async () => ({ status: "pass" }) });
    expect(readInstalledChecks(p.store, p.ledger)).toEqual(installed.checks);
  });
  it("refuses installed checks that no longer match the approved lock", async () => {
    const w = workspace(); const p = project();
    await installChecks(p.store, readAuthoredChecks(w.p), p.ledger, { spec, reviewVerdict: async () => ({ status: "pass" }) });
    writeFileSync(join(p.store.checksDir, "expected/result.txt"), "tampered\n");
    expect(() => readInstalledChecks(p.store, p.ledger)).toThrow(/approved|changed/);
  });
});
