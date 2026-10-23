#!/usr/bin/env node
import { Command } from "commander";
import { homedir } from "node:os";
import { allowsUnattended, doctorExitCode, runDoctor } from "./doctor/doctor.ts";
import { loadTask, runBaseline } from "./eval/baseline.ts";

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
    const repeat = Number.parseInt(opts.repeat, 10);
    const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
    // A fresh live doctor before every session: the binary, settings and sandbox must hold now (decision 59).
    const preflight = async () => {
      const checks = await runDoctor({ live: true });
      const ok = allowsUnattended(checks);
      if (!ok) for (const c of checks.filter((x) => x.level === "fail")) log(`preflight FAIL ${c.name}: ${c.detail}`);
      return ok;
    };
    for (let i = 1; i <= repeat; i++) {
      for (const id of ids) {
        const task = loadTask(opts.evals, id);
        for (let attempt = 1; attempt <= 3; attempt++) {
          const runId = `baseline-${new Date().toISOString().replace(/[:.]/g, "-")}${opts.label ? `-${opts.label}` : ""}-r${i}-a${attempt}`;
          log(`start ${id} ${runId}`);
          const r = await runBaseline(task, { preflight, runId });
          log(`end ${id}: exit ${r.exitCode}${r.timedOut ? " (timed out)" : ""}, ${r.resultSubtype}, ${r.numTurns} turns, ${Math.round(r.durationMs / 60000)} min, ${r.diffStat || "no changes"}; ${r.resultsDir}`);
          if (r.usageWaitUntil) {
            const ms = r.usageWaitUntil * 1000 + 120_000 - Date.now();
            if (ms > 12 * 3600_000) {
              log(`usage window resets in ${Math.round(ms / 3600_000)} h: stopping the chain`);
              return;
            }
            log(`usage ${r.usageLimited ? "limit hit" : "high"}: waiting ${Math.round(ms / 60000)} min for the reset`);
            if (ms > 0) await new Promise((res) => setTimeout(res, ms));
          }
          if (!r.usageLimited) break; // a limited run is retried; waiting is not a failure (decision 3)
          log(`retrying ${id} after the usage wait`);
        }
      }
    }
  });

await program.parseAsync();
