import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChecksStore } from "../../packages/cli/src/checks/store.ts";
import { projectId } from "../../packages/cli/src/config/project.ts";
import { allowsUnattended, runDoctor } from "../../packages/cli/src/doctor/doctor.ts";
import type { safeGit } from "../../packages/cli/src/eval/git.ts";
import { createClaudeReviewer } from "../../packages/cli/src/harness/claude/review.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import type { Reviewer, ReviewerInput, ReviewerOutput } from "../../packages/cli/src/review/types.ts";
import { runnerProjectDir } from "../../packages/cli/src/runner/inbox.ts";
import { DEFAULT_ROUTING } from "../../packages/cli/src/runner/routing.ts";

vi.mock("../../packages/cli/src/harness/claude/review.ts", async (original) => ({ ...await original<typeof import("../../packages/cli/src/harness/claude/review.ts")>(), createClaudeReviewer: vi.fn() }));
vi.mock("../../packages/cli/src/doctor/doctor.ts", async (original) => ({ ...await original<typeof import("../../packages/cli/src/doctor/doctor.ts")>(), runDoctor: vi.fn(), allowsUnattended: vi.fn() }));

const { Command } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("commander") as { Command: new () => Parameters<typeof import("../../packages/cli/src/commands/checks.ts").register>[0] };
const roots: string[] = [];
const originalExitCode = process.exitCode;
const spec = `---
spec: 1
date: 2026-10-28
status: confirmed
supersedes: none
---
## Goals
- Return the result.
## Non-goals
None.
## User stories
- **S1 (P1):** As a user, I want a result.
## Acceptance criteria
- **AC1 (S1):** WHEN asked THE SYSTEM SHALL return the result.
## Assumptions
None.
## Open questions
None.
`;
const check = (id = "main") => ({ name: "ac1", criteria: ["AC1"], cases: [{ id, command: "node src/cli.mjs input" }], verify: 'sh "$JARVIS_CHECKS/verify.sh"', timeoutMs: 1000 });
const output = (rawVerdict = '{"status":"pass"}', extra: Partial<ReviewerOutput> = {}): ReviewerOutput => ({ reviewer: "claude", model: DEFAULT_ROUTING.tiers.strong.model, rawOutput: "fake reviewer transcript", rawVerdict, ...extra });
function setup() {
  const root = mkdtempSync("/private/tmp/j-checks-command-"); roots.push(root);
  const home = join(root, "home"), repo = join(root, "repo"), proposals = join(repo, ".jarvis/checks");
  mkdirSync(home); mkdirSync(join(repo, ".git"), { recursive: true }); mkdirSync(join(proposals, "expected"), { recursive: true });
  writeFileSync(join(proposals, "ac1.check.json"), JSON.stringify(check()));
  writeFileSync(join(proposals, "expected/result.txt"), "result\n");
  writeFileSync(join(proposals, "verify.sh"), 'set -eu\ntest "$(cat "$JARVIS_OUT/main/code")" = 0\ndiff "$JARVIS_CHECKS/expected/result.txt" "$JARVIS_OUT/main/stdout"\necho "JARVIS-CHECK-COMPLETE $(cat "$JARVIS_COMPLETION_FILE")"\n');
  writeFileSync(join(repo, "PLANNER-NOTES.md"), "DO-NOT-SHOW-THE-REVIEWER");
  const project = runnerProjectDir(projectId(repo), join(home, ".jarvis"));
  const store = new ChecksStore(project), ledger = () => Ledger.open(project);
  const git = vi.fn<typeof safeGit>((cwd, args, options) => {
    expect(cwd).toBe(repo); expect(options.home).toBe(home);
    if (args[0] === "symbolic-ref") return Buffer.from("main\n");
    if (args[0] === "ls-tree") { expect(args).toContain("refs/heads/main:docs/spec"); return Buffer.from("v1.md\n"); }
    if (args[0] === "show") { expect(args).toEqual(["show", "refs/heads/main:docs/spec/v1.md"]); return Buffer.from(spec); }
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  });
  const reviewer = vi.fn<Reviewer>(async () => output());
  return { root, home, repo, proposals, project, store, ledger, git, reviewer };
}
type Fixture = ReturnType<typeof setup>;
async function invoke(s: Fixture, repo = s.repo, useDefault = false) {
  const { register } = await import("../../packages/cli/src/commands/checks.ts");
  const program = new Command().name("jarvis").exitOverride();
  register(program, { home: s.home, git: s.git, ...(!useDefault ? { reviewer: s.reviewer } : {}) });
  await program.parseAsync(["checks", "install", "--repo", repo], { from: "user" });
}
function untouched(s: Fixture) {
  expect(existsSync(s.store.checksDir)).toBe(false); expect(existsSync(s.store.lockPath)).toBe(false);
  expect(s.ledger().entries()).toEqual([]);
}
beforeEach(() => {
  process.exitCode = 0;
  vi.stubEnv("JARVIS_PROJECT", ""); delete process.env.JARVIS_PROJECT;
  vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.exitCode = originalExitCode; vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("jarvis checks install", () => {
  it("installs reviewed proposal bytes and records the exact lock approval in the project's ledger", async () => {
    const s = setup(); await invoke(s);
    const verified = s.store.verify(s.ledger()); expect(verified.ok).toBe(true);
    expect(s.ledger().entries()).toMatchObject([{ kind: "checks_approved", actor: "runner", data: { lockHash: verified.lockHash } }]);
    expect(readFileSync(join(s.store.checksDir, "expected/result.txt"), "utf8")).toBe("result\n");
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(verified.lockHash!));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("ac1")); expect(process.exitCode).toBe(0);
  });
  it("surfaces a fail verdict without installing anything", async () => {
    const s = setup(); s.reviewer.mockResolvedValue(output('{"status":"fail","reason":"vacuous check"}'));
    await invoke(s); expect(process.exitCode).toBe(1); expect(console.error).toHaveBeenCalledWith(expect.stringContaining("vacuous check")); untouched(s);
  });
  it("surfaces a thrown reviewer error and exits 1 without installing anything", async () => {
    const s = setup(); s.reviewer.mockRejectedValue(new Error("review crashed"));
    await invoke(s); expect(process.exitCode).toBe(1); expect(console.error).toHaveBeenCalledWith(expect.stringContaining("review crashed")); untouched(s);
  });
  it.each([
    { error: "review timed out" }, { fallbackReason: "usage_limit" as const }, { fallbackReason: "missing_binary" as const },
    { fallbackReason: "version_mismatch" as const }, { failureKind: "policy" as const },
  ])("refuses reviewer error or fallback metadata even alongside pass JSON: %j", async (extra) => {
    const s = setup(); s.reviewer.mockResolvedValue(output('{"status":"pass"}', extra));
    await invoke(s); expect(process.exitCode).toBe(1); expect(console.error).toHaveBeenCalled(); untouched(s);
  });
  it.each(["garbage", '```json\n{"status":"pass"}\n```', '{"status":"PASS"}', '{"status":"pass","extra":true}', '{"findings":[]}'])
  ("refuses malformed or wrong-schema verdicts: %s", async (raw) => {
    const s = setup(); s.reviewer.mockResolvedValue(output(raw));
    await invoke(s); expect(process.exitCode).toBe(1); untouched(s);
  });
  it("surfaces a removed case without a justification and preserves the approved baseline", async () => {
    const s = setup(); await invoke(s);
    const lock = readFileSync(s.store.lockPath, "utf8"), hashes = s.store.hashAll();
    writeFileSync(join(s.proposals, "ac1.check.json"), JSON.stringify(check("replacement")));
    await invoke(s); expect(process.exitCode).toBe(1); expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/justify.*ac1.*main/));
    expect(readFileSync(s.store.lockPath, "utf8")).toBe(lock); expect(s.store.hashAll()).toEqual(hashes); expect(s.ledger().entries()).toHaveLength(1);
    const data = JSON.parse(s.reviewer.mock.calls[1]![0].prompt.split("\n").at(-1)!);
    expect(data.previous).toEqual({ lockHash: s.store.verify(s.ledger()).lockHash, files: hashes });
    expect(data.removedCases).toEqual([{ check: "ac1", caseId: "main" }]);
  });
  it("retains an installed store unchanged when an update fails review", async () => {
    const s = setup(); await invoke(s); const hashes = s.store.hashAll(), lock = readFileSync(s.store.lockPath, "utf8");
    writeFileSync(join(s.proposals, "expected/result.txt"), "new result\n");
    s.reviewer.mockResolvedValue(output('{"status":"fail","reason":"coverage lost"}')); await invoke(s);
    expect(process.exitCode).toBe(1); expect(s.store.hashAll()).toEqual(hashes); expect(readFileSync(s.store.lockPath, "utf8")).toBe(lock); expect(s.ledger().entries()).toHaveLength(1);
  });
  it("uses a fresh captured-check workspace, strong routing and runner-owned evidence; cleans each workspace", async () => {
    const s = setup(); const inputs: ReviewerInput[] = [];
    s.reviewer.mockImplementation(async (input) => {
      inputs.push(input); expect(readdirSync(input.workspace)).toEqual(["checks"]);
      expect(readFileSync(join(input.workspace, "checks/ac1.check.json"), "utf8")).toBe(readFileSync(join(s.proposals, "ac1.check.json"), "utf8"));
      expect(input.prompt).toContain("strict JSON parsing and schema validation"); expect(input.workspace.startsWith(join(s.home, ".jarvis-work") + "/")).toBe(true);
      expect(input.outputDir.startsWith(join(s.project, "evidence") + "/")).toBe(true); expect(existsSync(input.outputDir)).toBe(true);
      expect(input).toMatchObject({ ...DEFAULT_ROUTING.tiers.strong, maxTurns: 20, timeoutMs: 600000 });
      expect(input.prompt).toContain("WHEN asked THE SYSTEM SHALL return the result."); expect(input.prompt).toContain('Return only JSON: {"status":"pass"');
      expect(input.prompt).not.toContain("DO-NOT-SHOW-THE-REVIEWER"); return output();
    });
    await invoke(s); await invoke(s);
    expect(s.reviewer).toHaveBeenCalledTimes(2); expect(new Set(inputs.map((i) => i.workspace)).size).toBe(2); expect(new Set(inputs.map((i) => i.outputDir)).size).toBe(2);
    for (const input of inputs) expect(existsSync(input.workspace)).toBe(false);
  });
  it("cleans the empty workspace when the reviewer throws", async () => {
    const s = setup(); let workspace = "";
    s.reviewer.mockImplementation(async (input) => { workspace = input.workspace; throw new Error("review crashed"); });
    await invoke(s); expect(process.exitCode).toBe(1); expect(workspace).not.toBe(""); expect(existsSync(workspace)).toBe(false); untouched(s);
  });
  it("resolves --repo subdirectories using the existing project resolver", async () => {
    const s = setup(); const subdir = join(s.repo, "nested"); mkdirSync(subdir); await invoke(s, subdir);
    expect(s.store.verify(s.ledger()).ok).toBe(true); expect(s.git).toHaveBeenCalled();
  });
  it("uses the same JARVIS_PROJECT override as jarvis run", async () => {
    const s = setup(); vi.stubEnv("JARVIS_PROJECT", "selected-project"); await invoke(s);
    const project = runnerProjectDir("selected-project", join(s.home, ".jarvis")); expect(new ChecksStore(project).verify(Ledger.open(project)).ok).toBe(true);
    expect(existsSync(s.project)).toBe(false);
  });
  it("refuses without a committed approved spec, even when the working tree has one", async () => {
    const s = setup(); mkdirSync(join(s.repo, "docs/spec"), { recursive: true }); writeFileSync(join(s.repo, "docs/spec/v1.md"), spec);
    s.git.mockImplementation((_cwd, args) => Buffer.from(args[0] === "symbolic-ref" ? "main\n" : ""));
    await invoke(s); expect(process.exitCode).toBe(1); expect(console.error).toHaveBeenCalledWith(expect.stringContaining("approved spec")); expect(s.reviewer).not.toHaveBeenCalled(); untouched(s);
  });
  it.each(["detached", "candidate", "invalid spec"])("refuses an invalid run source: %s", async (kind) => {
    const s = setup(); const actual = s.git.getMockImplementation()!;
    s.git.mockImplementation((cwd, args, options) => {
      if (kind === "detached" && args[0] === "symbolic-ref") throw new Error("detached HEAD");
      if (kind === "candidate" && args[0] === "symbolic-ref") return Buffer.from("jarvis/candidates/T1\n");
      if (kind === "invalid spec" && args[0] === "show") return Buffer.from("invalid spec");
      return actual(cwd, args, options);
    });
    await invoke(s); expect(process.exitCode).toBe(1); expect(s.reviewer).not.toHaveBeenCalled(); untouched(s);
  });
  it("composes the production read-only reviewer with the live preflight and private roots", async () => {
    const s = setup(); vi.mocked(createClaudeReviewer).mockReturnValue(s.reviewer); vi.mocked(runDoctor).mockResolvedValue([]); vi.mocked(allowsUnattended).mockReturnValue(false);
    await invoke(s, s.repo, true); expect(s.store.verify(s.ledger()).ok).toBe(true);
    expect(createClaudeReviewer).toHaveBeenCalledWith(expect.objectContaining({ jarvisHome: join(s.home, ".jarvis"), home: s.home, workRoot: join(s.home, ".jarvis-work"), cacheRoot: join(s.home, ".jarvis-work/caches", projectId(s.repo)) }));
    const opts = vi.mocked(createClaudeReviewer).mock.calls[0]![0]; const input = s.reviewer.mock.calls[0]![0];
    expect(await opts.preflight(input)).toEqual({ ok: false }); expect(runDoctor).toHaveBeenCalledWith({ home: s.home, repoPath: s.repo, live: true });
    vi.mocked(allowsUnattended).mockReturnValue(true); expect(await opts.preflight(input)).toEqual({ ok: true });
  });
});

it("gives the reviewer exact captured JSON bytes without reinterpreting escaped tab/newline content", async () => {
  const s = setup(); const proposal = check(); proposal.cases[0]!.command = "printf 'a\tb\nc'";
  const raw = JSON.stringify(proposal); writeFileSync(join(s.proposals, "ac1.check.json"), raw);
  s.reviewer.mockImplementation(async (input) => {
    const captured = readFileSync(join(input.workspace, "checks/ac1.check.json"), "utf8");
    expect(captured).toBe(raw); expect(JSON.parse(captured)).toEqual(proposal);
    writeFileSync(join(s.proposals, "ac1.check.json"), "changed after capture");
    return output();
  });
  await invoke(s); expect(process.exitCode).toBe(0);
  expect(readFileSync(join(s.store.checksDir, "ac1.check.json"), "utf8")).toBe(raw);
});
