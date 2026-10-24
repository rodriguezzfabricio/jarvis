import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { register as registerStatus } from "../../packages/cli/src/commands/status.ts";
import { Ledger, LedgerTamperError } from "../../packages/cli/src/ledger/ledger.ts";

const commanderPath = createRequire(new URL("../../packages/cli/package.json", import.meta.url)).resolve("commander");
const { Command } = await import(pathToFileURL(commanderPath).href) as typeof import("../../packages/cli/node_modules/commander/typings/index.js");
/** The error a command threw, so a wrong error fails an assertion (the mutation check counts only those). */
const failure = (p: Promise<unknown>): Promise<unknown> => p.then(() => "resolved without an error", (e: unknown) => e);
const roots: string[] = [];
const fresh = () => { const root = realpathSync(mkdtempSync(join(tmpdir(), "jarvis-status-json-"))); roots.push(root); return root; };
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const revision = "b".repeat(40);

function snapshot(dir: string): [string, string][] {
  const out: [string, string][] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else out.push([relative(dir, p), readFileSync(p, "utf8")]); } };
  walk(dir);
  return out.sort();
}

function setup() {
  const jarvisHome = fresh(); const dir = join(jarvisHome, "projects", "demo"); const ledger = Ledger.open(dir);
  ledger.append({ kind: "task_created", actor: "runner", task_id: "T1", data: { title: "Login", requiredChecks: ["unit"] } });
  ledger.append({ kind: "run_started", actor: "runner", data: { runId: "run", pid: 9 } });
  ledger.append({ kind: "steer", actor: "runner", data: { note: "Use blue" } });
  ledger.append({ kind: "attempt_started", actor: "runner", task_id: "T1", attempt_id: "a1", data: { runId: "run" } });
  ledger.append({ kind: "attempt_ended", actor: "runner", task_id: "T1", attempt_id: "a1", data: { status: "completed", candidateRevision: revision } });
  const ev = join(dir, "evidence", "a1-unit"); mkdirSync(join(ev, "cases", "main"), { recursive: true });
  const files: Record<string, string> = {};
  for (const [name, text] of [["cases/main/stdout", "expected 42, got 41\n"], ["cases/main/stderr", "trace\n"], ["cases/main/code", "1\n"]] as const) { writeFileSync(join(ev, name), text); files[name] = sha(text); }
  ledger.append({ kind: "gate_result", actor: "runner", task_id: "T1", attempt_id: "a1", data: { check: "unit", revision, status: "fail", caseResults: [{ id: "main", code: 1, timedOut: false, durationMs: 5 }], verifyExitCode: 1, verifyTimedOut: false, completed: true, evidence: { dir: ev, files } } });
  ledger.append({ kind: "review_result", actor: "runner", task_id: "T1", attempt_id: "a1", data: { reviewer: "code", revision, status: "fail", summary: "missing test" } });
  ledger.append({ kind: "blocked", actor: "runner", task_id: "T1", data: { reason: "protected check changed" } });
  ledger.append({ kind: "reconciled", actor: "runner", data: { type: "inbox_skipped", id: "x", reason: "too long" } });
  ledger.append({ kind: "usage_wait", actor: "runner", data: { until: 1, waitMs: 1 } });
  return { jarvisHome, dir, ledger };
}
async function status(jarvisHome: string, args: string[], seams: Record<string, unknown> = {}) {
  const output: string[] = []; const codes: number[] = []; const cli = new Command().exitOverride().configureOutput({ writeErr: () => undefined });
  registerStatus(cli, { jarvisHome, env: {}, now: () => 0, output: (t) => output.push(t), exit: (c: number) => codes.push(c), ...seams });
  await cli.parseAsync(["status", "--project", "demo", ...args], { from: "user" });
  return { output: output.join("\n"), codes };
}
type StatusJson = { status: string; state: { tasks: Record<string, { status: string }> }; entries: { seq: number; kind: string; hash: string }[]; failures: Record<string, { check: string; verified: boolean; cases: { id: string; code: number; stdout: string; stderr: string }[] }> };

describe("jarvis status --json (for compound)", () => {
  it("prints the verified entries compound needs, the rebuilt state and the repair failure output, read-only", async () => {
    const s = setup(); const before = snapshot(s.dir);
    const { output, codes } = await status(s.jarvisHome, ["--json"]);
    const parsed = JSON.parse(output) as StatusJson;
    expect(parsed.status).toBe("ready");
    expect(parsed.entries.map((e) => e.kind)).toEqual(["steer", "gate_result", "review_result", "blocked", "reconciled"]);
    const all = s.ledger.entries();
    for (const e of parsed.entries) expect(e).toEqual(all.find((x) => x.seq === e.seq));
    expect(parsed.state.tasks.T1?.status).toBe("blocked");
    expect(parsed.failures.T1).toMatchObject({ check: "unit", verified: true, cases: [{ id: "main", code: 1 }] });
    expect(parsed.failures.T1!.cases[0]!.stdout).toContain("expected 42, got 41");
    expect(codes).toEqual([]);
    expect(snapshot(s.dir)).toEqual(before);
  });

  it("marks edited failure output unverified instead of showing it", async () => {
    const s = setup(); writeFileSync(join(s.dir, "evidence", "a1-unit", "cases", "main", "stdout"), "FORGED\n");
    const parsed = JSON.parse((await status(s.jarvisHome, ["--json"])).output) as StatusJson;
    expect(parsed.failures.T1).toMatchObject({ verified: false, cases: [] });
    expect(JSON.stringify(parsed.failures)).not.toContain("FORGED");
  });

  it("prints contention as JSON with a non-zero exit, and refuses a tampered ledger", async () => {
    const s = setup();
    const verify = () => ({ ok: false, contended: true, entries: [], repairable: [], problems: ["moving"] });
    const r = await status(s.jarvisHome, ["--json"], { verify });
    expect(JSON.parse(r.output)).toMatchObject({ status: "contended" }); expect(r.codes).toEqual([1]);
    writeFileSync(join(s.dir, "head.hash"), "f".repeat(64));
    expect(await failure(status(s.jarvisHome, ["--json"]))).toBeInstanceOf(LedgerTamperError);
  });

  it("keeps the plain status output without --json", async () => {
    const s = setup();
    expect((await status(s.jarvisHome, [])).output).toMatch(/^# Jarvis report/);
  });
});
