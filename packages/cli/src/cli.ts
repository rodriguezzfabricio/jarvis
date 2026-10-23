#!/usr/bin/env node
import { Command } from "commander";
import { homedir } from "node:os";
import { doctorExitCode, runDoctor } from "./doctor/doctor.ts";
import { loadTask, runBaseline, usageWaitUntil } from "./eval/baseline.ts";

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
  .description("Run plain Claude Code on golden tasks, one at a time, waiting out usage limits")
  .argument("<tasks...>", "task ids, e.g. 01-intake-recruiter 11-habit-tracker")
  .option("--evals <path>", "the private jarvis-evals repo", `${homedir()}/Desktop/jarvis-evals`)
  .option("--repeat <n>", "runs per task", "1")
  .action(async (ids: string[], opts: { evals: string; repeat: string }) => {
    const repeat = Number.parseInt(opts.repeat, 10);
    for (let i = 1; i <= repeat; i++) {
      for (const id of ids) {
        const task = loadTask(opts.evals, id);
        const runId = `baseline-${new Date().toISOString().replace(/[:.]/g, "-")}-r${i}`;
        console.log(`${new Date().toISOString()} start ${id} ${runId}`);
        const r = await runBaseline(task, { runId });
        console.log(`${new Date().toISOString()} end ${id}: exit ${r.exitCode}${r.timedOut ? " (timed out)" : ""}, ${r.resultSubtype}, ${r.numTurns} turns, ${Math.round(r.durationMs / 60000)} min, ${r.diffStat || "no changes"}; ${r.resultsDir}`);
        const until = usageWaitUntil(r.rateLimits);
        if (until) {
          const ms = Math.min(until * 1000 + 120_000 - Date.now(), 6 * 3600_000);
          console.log(`${new Date().toISOString()} usage high or rejected: waiting ${Math.round(ms / 60000)} min for the reset`);
          if (ms > 0) await new Promise((res) => setTimeout(res, ms));
        }
      }
    }
  });

await program.parseAsync();
