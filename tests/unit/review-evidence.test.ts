import { createHash } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { DEFAULT_REVIEW_ROUTING } from "../../packages/cli/src/review/routing.ts";
import { createReviewService } from "../../packages/cli/src/review/service.ts";
import type { ReviewerInput, ReviewerOutput } from "../../packages/cli/src/review/types.ts";

/**
 * The reviewer's material from gate evidence is bounded, never an error for size: the live run of Oct 25
 * (`jarvis eval jarvis 05-citizenship-filter`) blocked a task whose Go gate passed three times, because a
 * 5 MB `go test -json` log was refused as "invalid or oversized review evidence" and no reviewer ran.
 */
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const MiB = 1024 * 1024;

interface FileMaterial { bytes: number; sha256: string; format: string; excerpt: string; cut?: string }
interface GateMaterial { check: string; status: string; caseResults?: unknown[]; files: Record<string, FileMaterial> }
interface Data { diff: string; diffNote?: string; evidence: GateMaterial[]; evidenceNote: string }
/** The prompt's last paragraph is the JSON data block (review/service.ts buildPrompt). */
const dataOf = (prompt: string) => JSON.parse(prompt.split("\n\n").at(-1)!) as Data;

/** Writes `total` bytes to `path`, built from `head`, repeated `filler` lines and `tail`, without holding them all in a string. */
function writeLog(path: string, head: string, filler: (i: number) => string, total: number, tail: string): Buffer {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "w");
  let written = Buffer.byteLength(head), i = 0, chunk = head;
  try {
    while (written < total - Buffer.byteLength(tail)) {
      const line = filler(i++); chunk += line; written += Buffer.byteLength(line);
      if (chunk.length > 64 * 1024) { writeSync(fd, chunk); chunk = ""; }
    }
    writeSync(fd, chunk + tail);
  } finally { closeSync(fd); }
  return readFileSync(path);
}

/**
 * A repo with a candidate commit, a runner ledger whose passing gate_result records `files` (written by
 * `make`, hashed as the gate hashes them), and a fake Claude reviewer that captures its prompt.
 */
function setup(make: (dir: string) => void, candidate: Record<string, string> = { "app.txt": "candidate\n" }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "review-evidence-"))); roots.push(root);
  const repoPath = join(root, "repo"), workRoot = join(root, "work"), projectDir = join(root, "runner");
  for (const d of [repoPath, workRoot, projectDir]) mkdirSync(d);
  const git = (args: string[]) => safeGit(repoPath, args, { home: root }).toString().trim();
  git(["init", "--quiet"]); writeFileSync(join(repoPath, "app.txt"), "before\n"); git(["add", "."]); git(["commit", "--quiet", "-m", "base"]);
  const baseRevision = git(["rev-parse", "HEAD"]);
  for (const [path, text] of Object.entries(candidate)) { mkdirSync(dirname(join(repoPath, path)), { recursive: true }); writeFileSync(join(repoPath, path), text); }
  git(["add", "."]); git(["commit", "--quiet", "-m", "candidate"]);
  const revision = git(["rev-parse", "HEAD"]);
  const ledger = Ledger.open(projectDir);
  const evidenceDir = join(projectDir, "evidence", "A1-unit-1"); mkdirSync(evidenceDir, { recursive: true });
  make(evidenceDir);
  const files: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(path).isDirectory()) walk(path, rel); else files[rel] = sha(readFileSync(path));
    }
  };
  walk(evidenceDir, "");
  const cases = Object.keys(files).filter((f) => f.endsWith("/code")).map((f) => f.split("/")[1]!);
  ledger.append({ kind: "gate_result", actor: "runner", task_id: "T1", attempt_id: "A1", data: {
    check: "unit", revision, status: "pass", cases: cases.map((id) => ({ id, command: "SECRET-CHECK-COMMAND" })), verify: "SECRET-VERIFY-COMMAND",
    caseResults: cases.map((id) => ({ id, code: 0, timedOut: false, durationMs: 5 })), verifyExitCode: 0, verifyTimedOut: false, completed: true,
    evidence: { dir: evidenceDir, files },
  } });
  const prompts: string[] = [];
  let reply = (input: ReviewerInput): ReviewerOutput => ({ reviewer: "claude", model: input.model, rawOutput: "raw", rawVerdict: '{"findings":[]}' });
  const claude = async (input: ReviewerInput): Promise<ReviewerOutput> => { prompts.push(input.prompt); return reply(input); };
  const service = createReviewService({ ledger, projectDir, workRoot, home: root, routing: DEFAULT_REVIEW_ROUTING, codex: null, claude,
    resolveMaterial: async () => ({ repoPath, baseRevision, tier: 1, spec: "Approved spec", acceptanceCriteria: ["AC1: filters by visible text"] }) });
  return { root, ledger, evidenceDir, prompts, service, request: { taskId: "T1", attemptId: "A1", revision }, setReply: (fn: typeof reply) => { reply = fn; } };
}

const goEvent = (o: Record<string, unknown>) => `${JSON.stringify({ Time: "2026-10-25T15:23:37.256444-04:00", ...o })}\n`;
const passingTest = (i: number) => goEvent({ Action: "run", Package: `example.com/app/p${i % 200}`, Test: `TestCase${i}` })
  + goEvent({ Action: "output", Package: `example.com/app/p${i % 200}`, Test: `TestCase${i}`, Output: `=== RUN   TestCase${i}\n` })
  + goEvent({ Action: "pass", Package: `example.com/app/p${i % 200}`, Test: `TestCase${i}`, Elapsed: 0 });
function caseFiles(dir: string, id: string, stdout: () => void): void {
  mkdirSync(join(dir, "cases", id), { recursive: true });
  stdout();
  writeFileSync(join(dir, "cases", id, "stderr"), "");
  writeFileSync(join(dir, "cases", id, "code"), "0\n");
}
const verifyLogs = (dir: string) => {
  writeFileSync(join(dir, "verify-stdout.log"), "gate unit: pass (244 packages passed)\nJARVIS-CHECK-COMPLETE c20c912d\n");
  writeFileSync(join(dir, "verify-stderr.log"), "");
};

describe("review material from gate evidence is bounded, never refused for size", { timeout: 60_000 }, () => {
  it("a multi-MB plain log reaches the reviewer as its last part, says what was cut, and the review runs", async () => {
    let size = 0;
    const s = setup((dir) => {
      verifyLogs(dir);
      caseFiles(dir, "unit", () => { size = writeLog(join(dir, "cases/unit/stdout"), "HEAD-MARKER first line\n", (i) => `ok line ${i} of the project's own suite\n`, 4 * MiB, "TAIL-MARKER last line\n").length; });
    });
    const result = await s.service.reviewDetailed(s.request);
    expect(result.verdict).toBe("pass");
    expect(s.prompts).toHaveLength(1);
    const prompt = s.prompts[0]!;
    expect(Buffer.byteLength(prompt)).toBeLessThan(256 * 1024);
    expect(prompt).toContain("TAIL-MARKER");
    expect(prompt).not.toContain("HEAD-MARKER");
    expect(prompt).toContain("JARVIS-CHECK-COMPLETE c20c912d"); // the gate's verdict line is always shown
    expect(prompt).not.toContain("SECRET-CHECK-COMMAND"); // the protected check's commands are not review material
    expect(prompt).not.toContain("SECRET-VERIFY-COMMAND");
    const gate = dataOf(prompt).evidence[0]!;
    expect(gate).toMatchObject({ check: "unit", status: "pass", caseResults: [{ id: "unit", code: 0, timedOut: false }] });
    const stdout = gate.files["cases/unit/stdout"]!;
    expect(stdout).toMatchObject({ bytes: size, sha256: sha(readFileSync(join(s.evidenceDir, "cases/unit/stdout"))), format: "text" });
    expect(stdout.cut).toMatch(/last \d+ of \d+ bytes/);
    expect(Buffer.byteLength(stdout.excerpt)).toBeLessThanOrEqual(16 * 1024);
    expect(gate.files["verify-stdout.log"]!.cut).toBeUndefined();
    expect(dataOf(prompt).evidenceNote).toMatch(/cut/i);
  });

  it("go test -json: failing tests are named with their output wherever they sit in the log, within the bound", async () => {
    const s = setup((dir) => {
      verifyLogs(dir);
      caseFiles(dir, "gotest", () => writeLog(join(dir, "cases/gotest/stdout"), "", (i) => i === 5000
        ? goEvent({ Action: "run", Package: "example.com/app/filter", Test: "TestCitizenshipBroken" })
          + goEvent({ Action: "output", Package: "example.com/app/filter", Test: "TestCitizenshipBroken", Output: "    filter_test.go:42: FAIL-DETAIL-9c1: want true, got false\n" })
          + goEvent({ Action: "fail", Package: "example.com/app/filter", Test: "TestCitizenshipBroken", Elapsed: 0.01 })
          + goEvent({ Action: "fail", Package: "example.com/app/filter", Elapsed: 0.2 })
        : passingTest(i), 3 * MiB, `${goEvent({ Action: "output", Package: "example.com/app/zz", Output: "ok  \texample.com/app/zz\t0.1s\n" })}{"Action":"go-exit","Code":1,"Signal":null}\n`));
    });
    expect((await s.service.reviewDetailed(s.request)).verdict).toBe("pass");
    const prompt = s.prompts[0]!;
    expect(Buffer.byteLength(prompt)).toBeLessThan(256 * 1024);
    const file = dataOf(prompt).evidence[0]!.files["cases/gotest/stdout"]!;
    expect(file.format).toBe("go-test-json");
    expect(file.excerpt).toContain("TestCitizenshipBroken");
    expect(file.excerpt).toContain("FAIL-DETAIL-9c1: want true, got false");
    expect(file.excerpt).toMatch(/example\.com\/app\/filter/);
    expect(file.excerpt).toContain('"Action":"go-exit","Code":1'); // events the summary doesn't model are kept
    expect(file.excerpt).toMatch(/1 failed/);
    expect(file.cut).toMatch(/summary/);
  });

  it("go test -json with everything passing: counts and the final package lines", async () => {
    const s = setup((dir) => {
      verifyLogs(dir);
      caseFiles(dir, "gotest", () => writeLog(join(dir, "cases/gotest/stdout"), "", passingTest, 3 * MiB,
        goEvent({ Action: "output", Package: "example.com/app/last", Output: "ok  \texample.com/app/last\t0.123s\n" }) + goEvent({ Action: "pass", Package: "example.com/app/last", Elapsed: 0.123 })));
    });
    await s.service.reviewDetailed(s.request);
    const file = dataOf(s.prompts[0]!).evidence[0]!.files["cases/gotest/stdout"]!;
    expect(file.format).toBe("go-test-json");
    expect(file.excerpt).toMatch(/\b0 failed\b/);
    expect(file.excerpt).toMatch(/\d+ passed/);
    expect(file.excerpt).toContain("ok  \texample.com/app/last\t0.123s");
    expect(Buffer.byteLength(file.excerpt)).toBeLessThanOrEqual(48 * 1024);
  });

  it("holds a hard total across every evidence file, and says which files were not shown", async () => {
    const s = setup((dir) => {
      verifyLogs(dir);
      for (let c = 0; c < 24; c++) caseFiles(dir, `case${String(c).padStart(2, "0")}`, () => writeLog(join(dir, `cases/case${String(c).padStart(2, "0")}/stdout`), "", (i) => `case ${c} line ${i}\n`, MiB, `CASE-${c}-END\n`));
    });
    expect((await s.service.reviewDetailed(s.request)).verdict).toBe("pass");
    const data = dataOf(s.prompts[0]!);
    expect(Buffer.byteLength(JSON.stringify(data.evidence))).toBeLessThanOrEqual(224 * 1024);
    const files = Object.values(data.evidence[0]!.files);
    expect(files).toHaveLength(2 + 24 * 3);
    expect(files.filter((f) => f.cut?.match(/not shown/))).not.toHaveLength(0);
    expect(data.evidence[0]!.files["verify-stdout.log"]!.excerpt).toContain("JARVIS-CHECK-COMPLETE");
  });

  it("cuts a diff larger than the review input at file boundaries and lists the files it left out", async () => {
    const rows = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} row ${i} ${"x".repeat(40)}`).join("\n");
    // One 2.4 MB generated file, and 30 files of about 40 KB: together far over the input limit.
    const medium = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`mid-${String(i).padStart(2, "0")}.txt`, `${rows(650, `mid${i}`)}\n`]));
    const s = setup((dir) => { verifyLogs(dir); caseFiles(dir, "unit", () => writeFileSync(join(dir, "cases/unit/stdout"), "ok\n")); },
      { "aaa-generated.txt": `${rows(40_000, "generated")}\n`, ...medium, "zzz.txt": "zzz-change\n" });
    expect((await s.service.reviewDetailed(s.request)).verdict).toBe("pass");
    const prompt = s.prompts[0]!;
    // At most 768 KiB of data, plus the instructions: below macOS's 1 MiB for arguments and environment.
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(776 * 1024);
    const data = dataOf(prompt);
    expect(data.diff).toContain("+zzz-change");
    expect(data.diff).toContain("+mid0 row 649");
    expect(data.diff).not.toContain("generated row 39999");
    expect(data.diffNote).toMatch(/aaa-generated\.txt/);
    expect(data.diffNote).toMatch(/mid-29\.txt/);
    expect(data.diffNote).toMatch(/checkout/);
  });

  it("still refuses evidence changed after capture, even outside the part a reviewer would see", async () => {
    const s = setup((dir) => {
      verifyLogs(dir);
      caseFiles(dir, "unit", () => writeLog(join(dir, "cases/unit/stdout"), "HEAD-MARKER\n", (i) => `line ${i}\n`, 2 * MiB, "TAIL\n"));
    });
    const path = join(s.evidenceDir, "cases/unit/stdout");
    const bytes = readFileSync(path); bytes.write("FORGED", 0); writeFileSync(path, bytes);
    const result = await s.service.reviewDetailed(s.request);
    expect(result.verdict).toBe("error");
    expect(s.prompts).toHaveLength(0);
    expect((result.entry.data as { error: string }).error).toMatch(/changed after capture/);
  });

  it("records what failed when a reviewer produced no verdict, so the loop can say why it blocked", async () => {
    const s = setup((dir) => { verifyLogs(dir); caseFiles(dir, "unit", () => writeFileSync(join(dir, "cases/unit/stdout"), "ok\n")); });
    s.setReply((input) => ({ reviewer: "claude", model: input.model, rawOutput: "{}", rawVerdict: "", error: "Claude review failed or timed out" }));
    const result = await s.service.reviewDetailed(s.request);
    expect(result.verdict).toBe("error");
    expect(result.entry.data).toMatchObject({ status: "error", reason: "review_error", model: "claude-sonnet-5-5", error: "Claude review failed or timed out" });
  });

  it("records no model, not an empty one, when no reviewer ran", async () => {
    const s = setup((dir) => { verifyLogs(dir); caseFiles(dir, "unit", () => writeFileSync(join(dir, "cases/unit/stdout"), "ok\n")); });
    writeFileSync(join(s.evidenceDir, "cases/unit/stdout"), "forged\n");
    const result = await s.service.reviewDetailed(s.request);
    expect(result.verdict).toBe("error");
    expect(result.reviews).toEqual([]);
    expect((result.entry.data as { model: unknown }).model).toBeNull();
  });
});
