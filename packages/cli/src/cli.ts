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
import { loadTask, runBaseline } from "./eval/baseline.ts";
import { runSchedule } from "./eval/schedule.ts";
import * as decisionWrite from "./decisions/decide.ts";
import * as decisionWhy from "./decisions/why.ts";
import * as spec from "./spec/index.ts";
import { register as registerTriage } from "./triage/command.ts";
import { register as registerSteer } from "./commands/steer.ts";
import { register as registerStatus } from "./commands/status.ts";
import { register as registerReport } from "./commands/report.ts";
import { register as registerGate } from "./commands/gate.ts";
import { register as registerMode } from "./commands/mode.ts";
import * as intake from "./intake/index.ts";

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
evalCmd
  .command("baseline")
  .description("Run plain Claude Code on golden tasks, one at a time, after a live preflight; waits out usage limits and retries")
  .argument("<tasks...>", "task ids, e.g. 01-intake-recruiter 11-habit-tracker")
  .option("--evals <path>", "the private jarvis-evals repo", `${homedir()}/Desktop/jarvis-evals`)
  .option("--repeat <n>", "runs per task", "1")
  .option("--label <s>", "added to run ids", "")
  .action(async (ids: string[], opts: { evals: string; repeat: string; label: string }) => {
    const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
    // A fresh live doctor before every session: the binary, settings and sandbox must hold now (decision 59).
    const preflight = async () => {
      const checks = await runDoctor({ live: true });
      const ok = allowsUnattended(checks);
      if (!ok) for (const c of checks.filter((x) => x.level === "fail")) log(`preflight FAIL ${c.name}: ${c.detail}`);
      const waitUntil = checks.find((c) => c.name === "canary_probe")?.waitUntil;
      return { ok, ...(waitUntil !== undefined ? { waitUntil } : {}) };
    };
    const out = await runSchedule(ids, Number.parseInt(opts.repeat, 10), opts.label, {
      loadTask: (id) => loadTask(opts.evals, id),
      runOne: (task, runId) => runBaseline(task, { preflight, runId }),
      sleepUntil: (t) => new Promise((res) => setTimeout(res, Math.max(0, t * 1000 - Date.now()))),
      nowMs: () => Date.now(),
      log,
    });
    log(`done: ${out.completed.length} run(s) completed${out.stopped ? `; STOPPED at ${out.stopped.task}: ${out.stopped.reason}` : ""}`);
    process.exitCode = out.stopped ? 1 : 0;
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
intake.register(program);

await program.parseAsync();
