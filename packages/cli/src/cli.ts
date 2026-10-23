#!/usr/bin/env node
import { Command } from "commander";
import { doctorExitCode, runDoctor } from "./doctor/doctor.ts";

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

await program.parseAsync();
