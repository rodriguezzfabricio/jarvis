import type { Command } from "commander";
import { checkSpecRepository as checkRepository } from "../decisions/spec-check.ts";

export function register(program: Command): Command {
  const spec = program.command("spec").description("Check versioned project specifications (decision 9)");
  spec.command("check")
    .description("Check structure and references in every docs/spec/vN.md; confirmation is not an approval check")
    .option("--repo <dir>", "project repository (default: current directory)")
    .action((opts: { repo?: string }, command: Command) => {
      const result = checkRepository(opts.repo ?? process.cwd());
      const output = command.configureOutput();
      for (const problem of result.problems) output.writeErr?.(`${problem.file}:${problem.line}: ${problem.message}\n`);
      if (result.ok) output.writeOut?.(`Spec valid: ${result.versions.length} version(s) checked.\n`);
      process.exitCode = result.ok ? 0 : 1;
    });
  return program;
}
