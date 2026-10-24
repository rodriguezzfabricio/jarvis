import type { Command } from "commander";
import { queryDecisions, type Decision } from "./format.ts";
import { DecisionRegister } from "./store.ts";

function describe(entry: Decision): string {
  const status = entry.status.kind === "active" ? "active"
    : `superseded by D${entry.status.by} on ${entry.status.date}: ${entry.status.reason}`;
  return `D${entry.id} (${entry.date}; ${entry.madeBy}; ${entry.class}; ${status})\n${entry.decision}\nWhy: ${entry.why}\nSource: ${entry.source}`;
}

export function register(program: Command): void {
  program.command("why")
    .description("Explain project decisions with their sources")
    .argument("<query>", "keyword or decision ID (D1 or 1)")
    .option("--repo <dir>", "project directory", process.cwd())
    .option("--history", "include matching decisions and their supersession history")
    .action((query: string, options: { repo: string; history?: boolean }, command: Command) => {
      try {
        const document = DecisionRegister.open(options.repo).read();
        const matches = queryDecisions(document, query, { history: options.history === true });
        const output = matches.length ? matches.map(describe).join("\n\n")
          : `No matching ${options.history ? "" : "active "}decisions for ${JSON.stringify(query)}.`;
        command.configureOutput().writeOut?.(`${output}\n`);
      } catch (error) {
        command.error(error instanceof Error ? error.message : String(error));
      }
    });
}
