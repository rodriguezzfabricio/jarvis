import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync, linkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installChecks, readAuthoredChecks, buildChecksReviewPrompt } from "../../packages/cli/src/runner/checks-author.ts";
import { ChecksStore } from "../../packages/cli/src/checks/store.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";

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
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
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
    writeFileSync(join(w.dir, "expected/result.txt"), "new\n");
    let rejectedPrompt = "";
    await expect(installChecks(p.store, readAuthoredChecks(w.p), p.ledger, { spec, reviewVerdict: async (prompt) => { rejectedPrompt = prompt; return { status: "fail" }; } })).rejects.toThrow();
    expect(rejectedPrompt).toContain("RETAINED-FILE");
    expect(readFileSync(join(p.store.checksDir, "expected/result.txt"), "utf8")).toBe("result\n");
    await installChecks(p.store, readAuthoredChecks(w.p), p.ledger, { spec, reviewVerdict });
    expect(reviewVerdict).toHaveBeenCalledTimes(2); expect(p.ledger.entries().filter((e) => e.kind === "checks_approved")).toHaveLength(2);
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
});
