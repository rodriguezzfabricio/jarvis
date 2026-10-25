#!/usr/bin/env node
import { Command } from "commander";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Broker, type Op } from "./broker/broker.ts";
import { ACT_EXIT, requestBroker } from "./broker/client.ts";
import { outboxAdapters } from "./broker/outbox.ts";
import { envFileSecrets } from "./broker/secrets.ts";
import { brokerSocketPath, startBrokerServer } from "./broker/server.ts";
import { Ledger } from "./ledger/ledger.ts";
import { allowsUnattended, doctorExitCode, runDoctor } from "./doctor/doctor.ts";
import { loadTask, runBaseline, type GoldenTask } from "./eval/baseline.ts";
import { formatCompare, readRuns, writeRating } from "./eval/compare.ts";
import { gradeRecordedRun, hiddenDir, loadHiddenChecks } from "./eval/hidden.ts";
import { runJarvis, type RunLoop } from "./eval/jarvis.ts";
import { runSchedule, type PreflightResult } from "./eval/schedule.ts";
import * as decisionWrite from "./decisions/decide.ts";
import * as decisionWhy from "./decisions/why.ts";
import * as spec from "./spec/index.ts";
import { register as registerTriage } from "./triage/command.ts";
import { register as registerSteer } from "./commands/steer.ts";
import { register as registerStatus } from "./commands/status.ts";
import { register as registerReport } from "./commands/report.ts";
import { register as registerGate } from "./commands/gate.ts";
import { register as registerMode } from "./commands/mode.ts";
import { register as registerMemory } from "./commands/memory.ts";
import * as intake from "./intake/index.ts";
import { register as registerSetup } from "./setup/command.ts";
import * as lanes from "./lanes/index.ts";

const projectDir = (id: string) => join(homedir(), ".jarvis", "projects", id);
const defaultSocket = () => process.env.JARVIS_BROKER_SOCKET;

const program = new Command().name("jarvis").description("Jarvis: research, ask once, build autonomously, prove it with evidence.");

program
  .command("doctor")
  .description("Preflight checks: pinned binaries, clean environment, disk, iCloud, and (with --live) the canary probe")
  .option("--live", "run the live canary probe with the pinned Claude Code (uses a little plan usage)")
  .option("--json", "print JSON")
  .option("--socket <path>", "broker run socket (or JARVIS_BROKER_SOCKET)", defaultSocket())
  .action(async (opts: { live?: boolean; json?: boolean; socket?: string }) => {
    const checks = await runDoctor({
      live: opts.live === true,
      foundation: { jarvisHome: join(homedir(), ".jarvis"), pluginDir: fileURLToPath(new URL("../../../plugin", import.meta.url)), socketPath: opts.socket ?? "" },
    });
    if (opts.json) console.log(JSON.stringify(checks, null, 2));
    else {
      const mark = { pass: "ok  ", warn: "warn", fail: "FAIL" } as const;
      for (const c of checks) console.log(`${mark[c.level]}  ${c.name.padEnd(36)} ${c.detail}`);
    }
    process.exitCode = doctorExitCode(checks);
  });

const evalCmd = program.command("eval").description("Golden-task evals (decisions 35, 47)");
const EVALS_REPO = `${homedir()}/Desktop/jarvis-evals`;
const evalLog = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
const evalsHome = () => join(homedir(), ".jarvis", "evals");
const evalWorkRoot = () => join(homedir(), ".jarvis-work");

/** A fresh live doctor before every session: the binary, settings and sandbox must hold now (decision 59). */
async function livePreflight(): Promise<PreflightResult> {
  const checks = await runDoctor({ live: true });
  const ok = allowsUnattended(checks);
  if (!ok) for (const c of checks.filter((x) => x.level === "fail")) evalLog(`preflight FAIL ${c.name}: ${c.detail}`);
  const waitUntil = checks.find((c) => c.name === "canary_probe")?.waitUntil;
  return { ok, ...(waitUntil !== undefined ? { waitUntil } : {}) };
}
const sleepUntil = (t: number) => new Promise<void>((res) => setTimeout(res, Math.max(0, t * 1000 - Date.now())));

/** Applies the hidden checks to a finished run when the evals repo has them; a grading problem never fails the run. */
async function gradeAfter(evals: string, task: GoldenTask, run: { resultsDir: string; started: boolean; usageLimited: boolean }): Promise<void> {
  const dir = hiddenDir(evals, task.id);
  if (!run.started || run.usageLimited || !existsSync(dir)) return;
  try {
    const g = await gradeRecordedRun(run.resultsDir, loadHiddenChecks(dir), { jarvisHome: join(homedir(), ".jarvis"), workRoot: evalWorkRoot() });
    evalLog(`${task.id}: hidden checks ${g.pass ? "pass" : "FAIL"} (${g.checks.map((c) => `${c.name} ${c.status}`).join(", ")})`);
  } catch (e) {
    evalLog(`${task.id}: grading failed: ${e instanceof Error ? e.message : String(e)}; run jarvis eval grade ${task.id}`);
  }
}

evalCmd
  .command("baseline")
  .description("Run plain Claude Code on golden tasks, one at a time, after a live preflight; waits out usage limits and retries; grades each run on the task's hidden checks")
  .argument("<tasks...>", "task ids, e.g. 01-intake-recruiter 11-habit-tracker")
  .option("--evals <path>", "the private jarvis-evals repo", EVALS_REPO)
  .option("--repeat <n>", "runs per task", "1")
  .option("--label <s>", "added to run ids", "")
  .action(async (ids: string[], opts: { evals: string; repeat: string; label: string }) => {
    // Hidden material is loaded (and refused if malformed) before any session, so each run's snapshot gets the same leak check as the Jarvis arm.
    const hidden = new Map<string, string[]>();
    for (const id of ids) {
      if (!existsSync(join(opts.evals, "hidden", id))) continue;
      const gate = hiddenDir(opts.evals, id, "gate");
      hidden.set(id, [loadHiddenChecks(hiddenDir(opts.evals, id)).dir, ...(existsSync(gate) ? [loadHiddenChecks(gate).dir] : [])]);
    }
    const out = await runSchedule(ids, Number.parseInt(opts.repeat, 10), opts.label, {
      loadTask: (id) => loadTask(opts.evals, id),
      runOne: async (task, runId) => {
        const r = await runBaseline(task, { preflight: livePreflight, runId, hiddenDirs: hidden.get(task.id) ?? [] });
        await gradeAfter(opts.evals, task, r);
        return r;
      },
      sleepUntil,
      nowMs: () => Date.now(),
      log: evalLog,
    });
    evalLog(`done: ${out.completed.length} run(s) completed${out.stopped ? `; STOPPED at ${out.stopped.task}: ${out.stopped.reason}` : ""}`);
    process.exitCode = out.stopped ? 1 : 0;
  });

/** runner/loop.ts is integrated on another branch; until it lands, the Jarvis arm says so instead of running. */
async function loadRunLoop(): Promise<RunLoop> {
  let mod: { runLoop?: unknown };
  try {
    // @ts-ignore runner/loop.ts may not be on this branch yet. A plain literal keeps the mutation selector's import graph exact (decision 92).
    mod = (await import("./runner/loop.ts")) as { runLoop?: unknown };
  } catch (e) {
    throw new Error(`the build loop (packages/cli/src/runner/loop.ts) is not available: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof mod.runLoop !== "function") throw new Error("packages/cli/src/runner/loop.ts does not export runLoop");
  return mod.runLoop as RunLoop;
}

evalCmd
  .command("jarvis")
  .description("Run golden tasks through Jarvis (triage, plan, build loop) on fresh sanitized snapshots, after the same live preflight as the baseline; grades each run on the task's hidden checks")
  .argument("<tasks...>", "task ids, e.g. 04-debug-chromium 05-citizenship-filter 02-build-recruiter")
  .option("--evals <path>", "the private jarvis-evals repo", EVALS_REPO)
  .option("--repeat <n>", "runs per task", "1")
  .option("--label <s>", "added to run ids", "")
  .action(async (ids: string[], opts: { evals: string; repeat: string; label: string }) => {
    const runLoop = await loadRunLoop();
    const out = await runSchedule(ids, Number.parseInt(opts.repeat, 10), opts.label, {
      prefix: "jarvis",
      loadTask: (id) => loadTask(opts.evals, id),
      runOne: async (task, runId) => {
        const r = await runJarvis(task, { preflight: livePreflight, evalsRepo: opts.evals, runLoop, runId, log: evalLog });
        evalLog(`${task.id} ${runId}: ${r.outcome}${r.error ? ` (${r.error})` : ""}; hidden checks ${r.grade ? (r.grade.pass ? "pass" : "FAIL") : `not graded${r.gradeError ? `: ${r.gradeError}` : ""}`}`);
        return r;
      },
      sleepUntil,
      nowMs: () => Date.now(),
      log: evalLog,
    });
    evalLog(`done: ${out.completed.length} run(s) completed${out.stopped ? `; STOPPED at ${out.stopped.task}: ${out.stopped.reason}` : ""}`);
    process.exitCode = out.stopped ? 1 : 0;
  });

evalCmd
  .command("grade")
  .description("Apply a golden task's hidden checks to recorded runs of either arm (default: every counted run without a grade)")
  .argument("<task>", "task id")
  .argument("[runs...]", "run ids under ~/.jarvis/evals/<task>/")
  .option("--evals <path>", "the private jarvis-evals repo", EVALS_REPO)
  .action(async (taskId: string, runs: string[], opts: { evals: string }) => {
    const hidden = loadHiddenChecks(hiddenDir(opts.evals, taskId));
    const targets = runs.length ? runs : readRuns(evalsHome(), taskId).filter((r) => r.counted && r.hidden === "ungraded").map((r) => r.runId);
    let failed = 0;
    for (const runId of targets) {
      try {
        const g = await gradeRecordedRun(join(evalsHome(), taskId, runId), hidden, { jarvisHome: join(homedir(), ".jarvis"), workRoot: evalWorkRoot() });
        console.log(`${runId}: ${g.pass ? "pass" : "FAIL"} (${g.checks.map((c) => `${c.name} ${c.status}`).join(", ")})`);
      } catch (e) {
        failed++;
        console.error(`${runId}: not graded: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!targets.length) console.log("Nothing to grade.");
    process.exitCode = failed ? 1 : 0;
  });

evalCmd
  .command("compare")
  .description("Both arms of a golden task, run for run: hidden checks, claimed and false done, wall time, sessions, repairs, usage, ratings")
  .argument("<task>", "task id")
  .option("--json", "print JSON")
  .action((taskId: string, opts: { json?: boolean }) => {
    const rows = readRuns(evalsHome(), taskId);
    console.log(opts.json ? JSON.stringify(rows, null, 2) : formatCompare(taskId, rows));
  });

evalCmd
  .command("rate")
  .description("Record your 1-5 rating (\"would I use this?\") and veto count for one run (decision 35)")
  .argument("<task>", "task id")
  .argument("<run>", "run id")
  .argument("<rating>", "1-5")
  .option("--vetoes <n>", "your veto count", "0")
  .option("--note <text>", "a short note")
  .action((taskId: string, runId: string, rating: string, opts: { vetoes: string; note?: string }) => {
    if (!/^\d+$/.test(rating) || !/^\d+$/.test(opts.vetoes)) throw new Error("rating and --vetoes take whole numbers");
    const path = writeRating(evalsHome(), taskId, runId, { rating: Number(rating), vetoes: Number(opts.vetoes), ...(opts.note ? { note: opts.note } : {}) });
    console.log(`Recorded in ${path}.`);
  });


program
  .command("act")
  .description("Ask the broker to perform an outside action (decision 12). Exit: 0 done, 2 pending approval or already executing, 3 rejected, 4 failed, 5 unknown, 6 duplicate, 7 invalid, 8 error")
  .argument("<operation>", "e.g. email.send, deploy.preview, deploy.promote")
  .option("--json <payload>", "the payload as JSON")
  .option("--payload-file <path>", "read the payload from a JSON file")
  .option("--socket <path>", "broker socket", defaultSocket())
  .action(async (op: string, opts: { json?: string; payloadFile?: string; socket?: string }) => {
    if (!opts.socket) throw new Error("Specify a run socket with --socket or JARVIS_BROKER_SOCKET; use the path printed by jarvis broker.");
    const raw = opts.payloadFile ? readFileSync(opts.payloadFile, "utf8") : (opts.json ?? "{}");
    const res = await requestBroker(opts.socket, { op: op as Op, payload: JSON.parse(raw) as unknown });
    console.log(JSON.stringify(res, null, 2));
    process.exitCode = ACT_EXIT[res.status] ?? 8;
  });

for (const decision of ["approve", "reject"] as const) {
  program
    .command(decision)
    .description(`${decision === "approve" ? "Approve" : "Reject"} a pending outside action by its approval id`)
    .argument("<approval-id>")
    .requiredOption("--project <id>", "project id")
    .action((id: string, opts: { project: string }) => {
      const broker = new Broker({ ledger: Ledger.open(projectDir(opts.project)), project: opts.project, adapters: [], secrets: { get: () => undefined } });
      broker.decide(id, decision, `${process.env.USER ?? "user"} (terminal)`);
      console.log(`${decision === "approve" ? "Approved" : "Rejected"} ${id}.`);
    });
}

program
  .command("broker")
  .description("Run the broker in the foreground (the runner hosts it during runs). Stage 1 uses local outbox adapters: nothing leaves the machine")
  .requiredOption("--project <id>", "project id")
  .option("--socket <path>", "socket path (default: unique per project and run)")
  .action(async (opts: { project: string; socket?: string }) => {
    const socket = opts.socket ?? process.env.JARVIS_BROKER_SOCKET ?? brokerSocketPath(opts.project);
    if (socket === "") throw new Error("Broker socket path is empty: unset JARVIS_BROKER_SOCKET or pass a path with --socket (backlog #19).");
    const dir = projectDir(opts.project);
    const secretsPath = join(homedir(), ".jarvis", "secrets", `${opts.project}.env`);
    const broker = new Broker({
      ledger: Ledger.open(dir),
      project: opts.project,
      adapters: outboxAdapters(join(dir, "outbox")),
      secrets: existsSync(secretsPath) ? envFileSecrets(secretsPath) : { get: () => undefined },
    });
    const reconciled = broker.reconcile();
    if (reconciled) console.log(`Marked ${reconciled} interrupted action(s) as unknown; they need a person (decision 41).`);
    mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
    const server = await startBrokerServer(broker, socket);
    const shutdown = () => {
      // A stuck connection must not make a foreground stop hang forever. close unlinks our names.
      const deadline = setTimeout(() => process.exit(1), 5000);
      deadline.unref();
      void server.close().then(() => process.exit(0), error => { console.error(String(error)); process.exit(1); });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    process.once("SIGHUP", shutdown);
    console.log(`Broker listening on ${server.socketPath} for project ${opts.project}. Public alias: ${socket}. Use the bound socket with --socket or JARVIS_BROKER_SOCKET.`);
  });

spec.register(program);
decisionWhy.register(program);
decisionWrite.register(program);
registerTriage(program);
registerSteer(program);
registerStatus(program);
registerReport(program);
registerGate(program);
registerMode(program);
registerMemory(program);
intake.register(program);
registerSetup(program);
lanes.register(program);

await program.parseAsync();
