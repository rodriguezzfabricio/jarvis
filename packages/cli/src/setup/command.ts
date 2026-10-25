import type { Command } from "commander";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { runSetup, type SetupDeps } from "./setup.ts";
import { STEPS } from "./state.ts";
import { InterruptedError, streamTty, type Tty } from "./tty.ts";

export interface CommandDeps extends Partial<Omit<SetupDeps, "tty">> {
  tty?: Tty;
  /** Test seam for the terminal check; production reads process.stdin.isTTY. */
  stdinIsTTY?: boolean;
  setExitCode?: (code: number) => void;
}

const collect = (value: string, previous: string[]) => [...previous, value];

/** Register once before program.parseAsync(). Dependencies keep tests offline and away from the real ~/.jarvis. */
export function register(program: Command, deps: CommandDeps = {}): void {
  program
    .command("setup")
    .description("One-time, resumable setup: Claude Code check, secrets backend, house-stack accounts, ntfy topics, taste profile, plugin (decision 43)")
    .option("--redo <step>", `run a finished step again (repeatable): ${STEPS.join(", ")}, or accounts for every account`, collect, [] as string[])
    .option("--send-test", "send one test notification through the notifier after the ntfy step")
    .action(async (opts: { redo: string[]; sendTest?: boolean }) => {
      const print = deps.print ?? console.log;
      const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
      let tty = deps.tty;
      if (!tty) {
        if (!(deps.stdinIsTTY ?? process.stdin.isTTY === true)) throw new Error("jarvis setup is interactive: run it in a terminal (tokens are never read from a pipe, argv or the environment)");
        tty = streamTty(process.stdin, process.stdout);
      }
      try {
        const result = await runSetup({
          ...deps,
          home: deps.home ?? homedir(),
          tty,
          print,
          pluginSource: deps.pluginSource ?? fileURLToPath(new URL("../../../../plugin", import.meta.url)),
          repoRoot: deps.repoRoot ?? fileURLToPath(new URL("../../../..", import.meta.url)).replace(/\/$/, ""),
        }, { redo: opts.redo, sendTest: opts.sendTest === true });
        setExitCode(result.ok ? 0 : 1);
      } catch (error) {
        if (!(error instanceof InterruptedError)) throw error;
        print("\nInterrupted. Finished steps are saved; run jarvis setup again to continue where you stopped.");
        setExitCode(130);
      } finally {
        tty.close();
      }
    });
}
