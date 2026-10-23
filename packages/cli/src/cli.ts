#!/usr/bin/env node
import { Command } from "commander";
import { homedir } from "node:os";
import { allowsUnattended, doctorExitCode, runDoctor } from "./doctor/doctor.ts";
import { loadTask, runBaseline } from "./eval/baseline.ts";
import { runSchedule } from "./eval/schedule.ts";

const program = new Command().name("jarvis").description("Jarvis: research, ask once, build autonomously, prove it with evidence.");

program
  .command("doctor")
  .description("Preflight checks: pinned binaries, clean environment, disk, iCloud, and (with --live) the canary probe")
  .option("--live", "run the live canary probe with the pinned Claude Code (uses a little plan usage)")
  .option("--json", "print JSON")
  .action(async (opts: { live?: boolean; json?: boolean }) => {
    const checks = await runDoctor({ live: opts.live === true });
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

await program.parseAsync();
