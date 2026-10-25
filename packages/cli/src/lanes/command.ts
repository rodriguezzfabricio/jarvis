import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { lintDesign, lintTokens } from "./design.ts";
import { selectLanes, type SelectionInput } from "./selection.ts";
import { detectAiTells } from "./tells.ts";

/** Read-only feedback commands; evidence is made exclusively through the runner's gates. */
export function register(program: Command): void {
  const lanes = program.command("lanes").description("Select scoped standards checks and lint changed UI");
  lanes.command("select")
    .requiredOption("--input <file>", "JSON: type, changes (path, added, deleted), facts")
    .action((options: { input: string }) => {
      console.log(JSON.stringify(selectLanes(JSON.parse(readFileSync(options.input, "utf8")) as SelectionInput), null, 2));
    });
  lanes.command("lint")
    .requiredOption("--design <file>", "DESIGN.md")
    .option("--source <file>", "changed UI source (repeatable)", (p: string, previous: string[]) => [...previous, p], [] as string[])
    .action((options: { design: string; source: string[] }) => {
      const design = lintDesign(readFileSync(options.design, "utf8"), options.design);
      const sources = options.source.map(path => ({ path, content: readFileSync(path, "utf8") }));
      const findings = [...design.findings, ...(design.tokens ? lintTokens(sources, design.tokens) : []), ...detectAiTells(sources)];
      console.log(JSON.stringify({ verified: false, findings }, null, 2));
      process.exitCode = findings.length ? 1 : 0;
    });
}
