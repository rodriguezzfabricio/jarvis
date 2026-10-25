import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { GATES, register as registerGate } from "../../packages/cli/src/commands/gate.ts";
import { runFeedbackGate, runGate } from "../../packages/cli/src/checks/gate.ts";
import { ChecksStore } from "../../packages/cli/src/checks/store.ts";
import { readInstalledChecks } from "../../packages/cli/src/runner/checks-author.ts";
import { Ledger, LedgerTamperError } from "../../packages/cli/src/ledger/ledger.ts";
import { shortTmp } from "../helpers.ts";

const commanderPath = createRequire(new URL("../../packages/cli/package.json", import.meta.url)).resolve("commander");
const { Command } = await import(pathToFileURL(commanderPath).href) as typeof import("../../packages/cli/node_modules/commander/typings/index.js");
/** The error a command threw, so a wrong error fails an assertion (the mutation check counts only those). */
const failure = (p: Promise<unknown>): Promise<unknown> => p.then(() => "resolved without an error", (e: unknown) => e);
const root = shortTmp("jgc-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
const COMPLETE = 'echo "JARVIS-CHECK-COMPLETE $(cat "$JARVIS_COMPLETION_FILE")"\n';
const EXIT0 = `test "$(cat main/code)" = 0 || exit 1\n${COMPLETE}`;
let n = 0;

/** Every file under dir with its bytes: what "feedback only" is checked against. */
function snapshot(dir: string): [string, string][] {
  const out: [string, string][] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else out.push([relative(dir, p), readFileSync(p, "utf8")]); } };
  walk(dir);
  return out.sort();
}

function project() {
  const i = ++n;
  const jarvisHome = join(root, `jh${i}`); const projectDir = join(jarvisHome, "projects", "demo");
  mkdirSync(join(projectDir, "checks", "fixtures"), { recursive: true });
  const ledger = Ledger.open(projectDir);
  // A runner gate_result already on record, so "nothing appended" is checked against a real ledger.
  ledger.append({ kind: "task_created", actor: "runner", task_id: "T1", data: { title: "Value" } });
  const repo = join(root, `repo${i}`); mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main"); git(repo, "config", "user.email", "t@t"); git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "value.txt"), "41\n"); writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
  git(repo, "add", "-A"); git(repo, "commit", "-qm", "c1");
  return { jarvisHome, projectDir, ledger, store: new ChecksStore(projectDir), repo, workRoot: join(root, `work${i}`) };
}
type Project = ReturnType<typeof project>;
function install(p: Project, name: string, script: string, verify = EXIT0) {
  writeFileSync(join(p.projectDir, "checks", "fixtures", `${name}.sh`), script);
  writeFileSync(join(p.projectDir, "checks", `${name}.verify.sh`), verify);
  writeFileSync(join(p.projectDir, "checks", `${name}.check.json`), JSON.stringify({ name, cases: [{ id: "main", command: `sh "$JARVIS_FIXTURES/${name}.sh"` }], verify: `sh "$JARVIS_CHECKS/${name}.verify.sh"`, timeoutMs: 30_000 }));
}
async function gate(p: Project, args: string[]) {
  const output: string[] = []; const codes: number[] = []; const cli = new Command().exitOverride().configureOutput({ writeErr: () => undefined });
  registerGate(cli, { jarvisHome: p.jarvisHome, workRoot: p.workRoot, env: { JARVIS_PROJECT: "demo" }, cwd: p.repo, output: (t) => output.push(t), exit: (c) => codes.push(c) });
  await cli.parseAsync(["gate", ...args], { from: "user" });
  return { output: output.join("\n"), codes };
}
const VALUE = [
  "test -e ignored.txt && echo SAW-IGNORED",
  "test -e .jarvis/notes/T1.md && echo SAW-JARVIS",
  "test -L link && echo LINK-KEPT",
  "echo to-stderr >&2",
  'test "$(cat value.txt)" = 42 && test -f untracked.txt && echo "value ok"',
].join("\n") + "\n";

describe("jarvis gate <name>: feedback only (decision 49)", { timeout: 120_000 }, () => {
  it("runs the check on the working tree as it is now and records nothing", async () => {
    const p = project(); install(p, "unit", VALUE, `${EXIT0.replace(COMPLETE, "")}echo SECRET-STDOUT-42\necho SECRET-STDERR-43 >&2\n${COMPLETE}`);
    p.store.approve(p.ledger, "v1");
    writeFileSync(join(p.repo, "value.txt"), "42\n"); writeFileSync(join(p.repo, "untracked.txt"), "x");
    writeFileSync(join(p.repo, "ignored.txt"), "x"); mkdirSync(join(p.repo, ".jarvis", "notes"), { recursive: true });
    writeFileSync(join(p.repo, ".jarvis", "notes", "T1.md"), "claim"); symlinkSync("value.txt", join(p.repo, "link"));
    const before = snapshot(p.projectDir);
    const r = await gate(p, ["test"]);
    expect(r.output).toMatch(/feedback only/i); expect(r.output).toMatch(/unit: pass/);
    expect(r.output).toContain("value ok"); expect(r.output).toContain("LINK-KEPT"); expect(r.output).toContain("to-stderr");
    expect(r.output).not.toMatch(/SAW-IGNORED|SAW-JARVIS/);
    expect(r.output).not.toMatch(/SECRET-STD(?:OUT|ERR)/);
    const json = await gate(p, ["test", "--json"]);
    expect(json.output).toContain("value ok"); expect(json.output).not.toMatch(/SECRET-STD(?:OUT|ERR)/);
    expect(r.codes).toEqual([0]); expect(json.codes).toEqual([0]);
    expect(snapshot(p.projectDir)).toEqual(before);
    expect(existsSync(join(p.projectDir, "evidence"))).toBe(false);
    expect(readdirSync(join(p.workRoot, "feedback"))).toEqual([]); expect(readdirSync(join(p.workRoot, "checks"))).toEqual([]);
  });

  it("fails with the case output when the working tree fails, and prints JSON on request", async () => {
    const p = project(); install(p, "unit", 'echo "value is $(cat value.txt)"\ntest "$(cat value.txt)" = 42\n'); p.store.approve(p.ledger, "v1");
    const r = await gate(p, ["test", "--json"]);
    const parsed = JSON.parse(r.output) as { feedbackOnly: boolean; results: { check: string; status: string; cases: { code: number; stdoutTail: string }[] }[] };
    expect(parsed.feedbackOnly).toBe(true);
    expect(parsed.results).toMatchObject([{ check: "unit", status: "fail", cases: [{ code: 1 }] }]);
    expect(parsed.results[0]!.cases[0]!.stdoutTail).toContain("value is 41");
    expect(r.codes).toEqual([1]);
  });

  it("test runs the installed unit check when no check is named test", async () => {
    const p = project(); install(p, "unit", "exit 0\n"); p.store.approve(p.ledger, "v1");
    const result = await gate(p, ["test"]).then((r) => r.output, (e: unknown) => String(e));
    expect(result).toMatch(/unit: pass/);
  });

  it("done runs every installed check", async () => {
    const p = project(); install(p, "unit", "exit 0\n"); install(p, "lint", "exit 1\n"); p.store.approve(p.ledger, "v1");
    const r = await gate(p, ["done"]);
    expect(r.output).toMatch(/lint: fail/); expect(r.output).toMatch(/unit: pass/); expect(r.codes).toEqual([1]);
  });

  it("refuses a tampered check without running it, and records nothing", async () => {
    const p = project(); const marker = join(root, `ran-${n}`);
    install(p, "unit", `touch ${marker}\nexit 1\n`); p.store.approve(p.ledger, "v1");
    writeFileSync(join(p.projectDir, "checks", "fixtures", "unit.sh"), `touch ${marker}\nexit 0\n`);
    const before = snapshot(p.projectDir);
    const r = await gate(p, ["test"]);
    expect(r.output).toMatch(/test: tampered/); expect(r.output).toMatch(/check changed: fixtures\/unit.sh/); expect(r.codes).toEqual([2]);
    expect(existsSync(marker)).toBe(false);
    expect(snapshot(p.projectDir)).toEqual(before);
  });

  it.skipIf(process.platform !== "darwin")("a check that tries to write evidence or the ledger can't, and nothing is recorded", async () => {
    const p = project();
    install(p, "unit", [
      `echo forged >> "${join(p.projectDir, "ledger.jsonl")}" 2>/dev/null && echo WROTE-LEDGER`,
      `mkdir -p "${join(p.projectDir, "evidence", "forged")}" 2>/dev/null && echo WROTE-EVIDENCE`,
      "exit 0",
    ].join("\n") + "\n");
    p.store.approve(p.ledger, "v1"); const before = snapshot(p.projectDir);
    const r = await gate(p, ["test"]);
    expect(r.output).not.toMatch(/WROTE-/);
    expect(snapshot(p.projectDir)).toEqual(before);
    expect(existsSync(join(p.projectDir, "evidence"))).toBe(false);
  });

  it("refuses a working-tree symlink that leaves the tree", async () => {
    const p = project(); mkdirSync(join(p.repo, "sub")); writeFileSync(join(p.repo, "sub", "file.txt"), "in repo\n");
    git(p.repo, "add", "-A"); git(p.repo, "commit", "-qm", "sub");
    const outside = join(root, `outside-${n}`); mkdirSync(outside); writeFileSync(join(outside, "file.txt"), "OUTSIDE-SECRET\n");
    rmSync(join(p.repo, "sub"), { recursive: true }); symlinkSync(outside, join(p.repo, "sub"));
    install(p, "unit", "cat sub/file.txt\n"); p.store.approve(p.ledger, "v1");
    const r = await gate(p, ["test"]);
    // git refuses to stage the tracked path that now sits beyond a symlink.
    expect(r.output).toMatch(/unit: error/); expect(r.output).toMatch(/beyond a symbolic link/);
    expect(r.output).not.toContain("OUTSIDE-SECRET");
    expect(readFileSync(join(outside, "file.txt"), "utf8")).toBe("OUTSIDE-SECRET\n");
  });

  it.each([["absolute", (o: string) => o], ["escaping", () => "../../.."]] as const)("refuses an %s untracked symlink out of the tree", async (_kind, target) => {
    const p = project(); const outside = join(root, `outside-${n}`); mkdirSync(outside); writeFileSync(join(outside, "file.txt"), "OUTSIDE-SECRET\n");
    symlinkSync(target(outside), join(p.repo, "escape"));
    install(p, "unit", "cat escape/file.txt\nexit 0\n"); p.store.approve(p.ledger, "v1");
    const r = await gate(p, ["test"]);
    expect(r.output).toMatch(/unit: error/); expect(r.output).toMatch(/symlink leaves the working tree: escape/);
    expect(r.output).not.toContain("OUTSIDE-SECRET");
  });

  it("an unknown gate name exits non-zero with the list of gates", async () => {
    const p = project(); install(p, "unit", "exit 0\n"); p.store.approve(p.ledger, "v1");
    expect(String(await failure(gate(p, ["unit"])))).toMatch(new RegExp(GATES.join(", ")));
    expect(GATES).toEqual(["quick", "test", "lint", "security", "qa", "design", "done"]);
  });

  it("a gate with no installed check names what is installed", async () => {
    const p = project(); install(p, "unit", "exit 0\n"); p.store.approve(p.ledger, "v1");
    expect(String(await failure(gate(p, ["security"])))).toMatch(/no installed check.*installed: unit/i);
  });

  it("materializes the staged tree: a parent swapped for a symlink after staging changes nothing (Codex review, high 1)", async () => {
    const p = project(); mkdirSync(join(p.repo, "sub")); writeFileSync(join(p.repo, "sub", "file.txt"), "in repo\n");
    const outside = join(root, `outside-${n}`); mkdirSync(outside); writeFileSync(join(outside, "file.txt"), "OUTSIDE-SECRET\n");
    install(p, "unit", "cat sub/file.txt\ntest -L sub && echo SUB-IS-LINK\nexit 0\n"); p.store.approve(p.ledger, "v1");
    const [check] = readInstalledChecks(p.store);
    const swap = () => { rmSync(join(p.repo, "sub"), { recursive: true }); symlinkSync(outside, join(p.repo, "sub")); };
    const r = await runFeedbackGate({ store: p.store, entries: p.ledger.entries(), jarvisHome: p.jarvisHome, workRoot: p.workRoot, workTree: p.repo, check: check!, afterStage: swap });
    expect(r.status).toBe("pass");
    expect(r.cases[0]!.stdoutTail).toContain("in repo");
    expect(JSON.stringify(r)).not.toMatch(/OUTSIDE-SECRET|SUB-IS-LINK/);
  });

  it("runGate records its result before cleanup, so a cleanup fault loses nothing (Codex review, medium 4)", async () => {
    const p = project(); install(p, "unit", "exit 0\n"); p.store.approve(p.ledger, "v1");
    const [check] = readInstalledChecks(p.store); const revision = git(p.repo, "rev-parse", "HEAD");
    const error = await failure(runGate({ ledger: p.ledger, store: p.store, projectDir: p.projectDir, jarvisHome: p.jarvisHome, workRoot: p.workRoot, repoPath: p.repo, revision, check: check!, taskId: "T1", attemptId: "a1", cleanup: () => { throw new Error("cleanup fault"); } }));
    expect(String(error)).toMatch(/cleanup fault/);
    expect(p.ledger.entries().at(-1)).toMatchObject({ kind: "gate_result", data: { check: "unit", status: "pass" } });
  });

  it("runFeedbackGate refuses a tampered store on its own, before any case runs", async () => {
    const p = project(); const marker = join(root, `ran-${n}`); install(p, "unit", `touch ${marker}\nexit 1\n`); p.store.approve(p.ledger, "v1");
    const [check] = readInstalledChecks(p.store);
    writeFileSync(join(p.projectDir, "checks", "fixtures", "unit.sh"), `touch ${marker}\nexit 0\n`);
    const r = await runFeedbackGate({ store: p.store, entries: p.ledger.entries(), jarvisHome: p.jarvisHome, workRoot: p.workRoot, workTree: p.repo, check: check! });
    expect(r).toMatchObject({ check: "unit", status: "tampered", cases: [] });
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses a hard-linked working-tree file instead of copying what it points at", async () => {
    const p = project(); const outside = join(root, `hl-${n}`); writeFileSync(outside, "HARDLINK-SECRET\n");
    linkSync(outside, join(p.repo, "linked.txt"));
    install(p, "unit", "cat linked.txt\n"); p.store.approve(p.ledger, "v1");
    const r = await gate(p, ["test"]);
    expect(r.output).toMatch(/unit: error/); expect(r.output).toMatch(/hard-linked/);
    expect(r.output).not.toContain("HARDLINK-SECRET"); expect(r.codes).toEqual([2]);
  });

  it("refuses a missing ledger and a tampered ledger before running anything", async () => {
    const p = project(); const marker = join(root, `ran-${n}`); install(p, "unit", `touch ${marker}\n`); p.store.approve(p.ledger, "v1");
    writeFileSync(join(p.projectDir, "head.hash"), "f".repeat(64));
    expect(await failure(gate(p, ["test"]))).toBeInstanceOf(LedgerTamperError);
    expect(existsSync(marker)).toBe(false);
    rmSync(join(p.projectDir, "ledger.jsonl"));
    expect(String(await failure(gate(p, ["test"])))).toMatch(/No run ledger/);
    expect(existsSync(marker)).toBe(false);
  });
});
