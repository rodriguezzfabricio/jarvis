import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { register as registerReport } from "../../packages/cli/src/commands/report.ts";
import { projectId } from "../../packages/cli/src/config/project.ts";
import { Ledger, LedgerTamperError } from "../../packages/cli/src/ledger/ledger.ts";
import { renderReport } from "../../packages/cli/src/runner/report.ts";
import { rebuildState } from "../../packages/cli/src/runner/state.ts";

const commanderPath = createRequire(new URL("../../packages/cli/package.json", import.meta.url)).resolve("commander");
const { Command } = await import(pathToFileURL(commanderPath).href) as typeof import("../../packages/cli/node_modules/commander/typings/index.js");
/** The error a command threw, so a wrong error fails an assertion (the mutation check counts only those). */
const failure = (p: Promise<unknown>): Promise<unknown> => p.then(() => "resolved without an error", (e: unknown) => e);
const roots: string[] = [];
const fresh = () => { const root = realpathSync(mkdtempSync(join(tmpdir(), "jarvis-report-cmd-"))); roots.push(root); return root; };
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
const program = () => new Command().exitOverride().configureOutput({ writeErr: () => undefined });
const now = Date.parse("2026-10-24T12:00:00Z");
const revision = "a".repeat(40);

/** Every file under dir with its bytes: what "read-only" is checked against. */
function snapshot(dir: string): [string, string][] {
  const out: [string, string][] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else out.push([relative(dir, p), readFileSync(p, "utf8")]); } };
  walk(dir);
  return out.sort();
}

function setup() {
  const repo = fresh(); mkdirSync(join(repo, ".git"));
  const jarvisHome = fresh(); const id = projectId(repo); const dir = join(jarvisHome, "projects", id);
  const ledger = Ledger.open(dir);
  ledger.append({ kind: "task_created", actor: "runner", task_id: "T1", data: { title: "Login", requiredChecks: ["unit"], requiredReviews: ["code"] } });
  ledger.append({ kind: "run_started", actor: "runner", data: { runId: "run", pid: 333 } });
  ledger.append({ kind: "attempt_started", actor: "runner", task_id: "T1", attempt_id: "a1", data: { runId: "run" } });
  ledger.append({ kind: "attempt_ended", actor: "runner", task_id: "T1", attempt_id: "a1", data: { status: "completed", candidateRevision: revision } });
  const evidence = join(dir, "evidence", "a1-unit"); mkdirSync(evidence, { recursive: true }); writeFileSync(join(evidence, "stdout"), "PASS");
  ledger.append({ kind: "gate_result", actor: "runner", task_id: "T1", attempt_id: "a1", data: { revision, status: "pass", check: "unit", evidence: { dir: evidence, files: { stdout: createHash("sha256").update("PASS").digest("hex") } } } });
  ledger.append({ kind: "review_result", actor: "runner", task_id: "T1", attempt_id: "a1", data: { reviewer: "code", revision, status: "pass" } });
  ledger.append({ kind: "state_reached", actor: "runner", task_id: "T1", attempt_id: "a1", data: { state: "passed", revision } });
  return { repo, jarvisHome, id, dir, ledger, evidence };
}

async function report(s: { repo: string; jarvisHome: string }, args: string[] = [], seams: Record<string, unknown> = {}) {
  const output: string[] = []; const opened: string[] = []; const codes: number[] = []; const cli = program();
  registerReport(cli, { jarvisHome: s.jarvisHome, env: {}, cwd: s.repo, now: () => now, output: (t) => output.push(t), open: (p) => opened.push(p), exit: (c) => codes.push(c), ...seams });
  await cli.parseAsync(["report", ...args], { from: "user" });
  return { output: output.join("\n"), opened, codes };
}

describe("jarvis report [--open]", () => {
  it("rebuilds REPORT.md in the repo's .jarvis from the ledger and changes nothing in the runner folder", async () => {
    const s = setup(); const before = snapshot(s.dir);
    const r = await report(s);
    const path = join(s.repo, ".jarvis", "REPORT.md");
    const entries = s.ledger.entries();
    expect(readFileSync(path, "utf8")).toEqual(renderReport(rebuildState(entries, { now }), entries, [], { now: () => now }));
    expect(readFileSync(path, "utf8")).toMatch(/## Done[\s\S]*T1: Login/);
    expect(r.output).toContain(path);
    expect(r.opened).toEqual([]); expect(r.codes).toEqual([]);
    expect(snapshot(s.dir)).toEqual(before);
    expect(statSync(path).mode & 0o077).toBe(0);
  });

  it("--open opens the report it wrote", async () => {
    const s = setup();
    const r = await report(s, ["--open"]);
    expect(r.opened).toEqual([join(s.repo, ".jarvis", "REPORT.md")]);
  });

  it("re-verifies evidence: an edited evidence file makes the completion unverified", async () => {
    const s = setup(); writeFileSync(join(s.evidence, "stdout"), "FORGED");
    await report(s);
    const text = readFileSync(join(s.repo, ".jarvis", "REPORT.md"), "utf8");
    expect(text).toMatch(/Unverified completion: T1/); expect(text).not.toMatch(/## Done\n\n- T1/);
  });

  it("refuses a missing ledger and creates nothing", async () => {
    const repo = fresh(); mkdirSync(join(repo, ".git")); const jarvisHome = fresh();
    expect(String(await failure(report({ repo, jarvisHome })))).toMatch(/No run ledger/);
    expect(readdirSync(jarvisHome)).toEqual([]); expect(existsSync(join(repo, ".jarvis"))).toBe(false);
  });

  it("refuses a tampered ledger and leaves the previous report as it was", async () => {
    const s = setup(); mkdirSync(join(s.repo, ".jarvis")); writeFileSync(join(s.repo, ".jarvis", "REPORT.md"), "previous\n");
    writeFileSync(join(s.dir, "head.hash"), "f".repeat(64)); const before = snapshot(s.dir);
    expect(await failure(report(s))).toBeInstanceOf(LedgerTamperError);
    expect(readFileSync(join(s.repo, ".jarvis", "REPORT.md"), "utf8")).toBe("previous\n");
    expect(snapshot(s.dir)).toEqual(before);
  });

  it("says so and exits non-zero when ledger writers are active, without writing", async () => {
    const s = setup();
    const verify = () => ({ ok: false, contended: true, entries: [], repairable: [], problems: ["moving"] });
    const r = await report(s, ["--open"], { verify }).catch((e: unknown) => ({ output: String(e), opened: [] as string[], codes: [] as number[] }));
    expect(r.output).toMatch(/contended/i); expect(r.codes).toEqual([1]); expect(r.opened).toEqual([]);
    expect(existsSync(join(s.repo, ".jarvis", "REPORT.md"))).toBe(false);
  });

  it("refuses to write another project's report into this repo", async () => {
    const s = setup(); Ledger.open(join(s.jarvisHome, "projects", "other")).append({ kind: "steer", actor: "runner", data: { note: "x" } });
    expect(String(await failure(report(s, ["--project", "other"])))).toMatch(/not this repo/i);
    expect(existsSync(join(s.repo, ".jarvis"))).toBe(false);
  });
});
