import type { Command } from "commander";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runFeedbackGate, type FeedbackResult } from "../checks/gate.ts";
import { ChecksStore } from "../checks/store.ts";
import { projectRoot, resolveProject } from "../config/project.ts";
import { LedgerTamperError, verifyLedger, type VerifyResult } from "../ledger/ledger.ts";
import { readInstalledChecks } from "../runner/checks-author.ts";
import { runnerProjectDir } from "../runner/inbox.ts";

/** The gate names of architecture §3.2. `done` is every installed check. */
export const GATES = ["quick", "test", "lint", "security", "qa", "design", "done"] as const;
export type GateName = (typeof GATES)[number];
/** Installed check names each gate runs, first one installed wins. Plans default to a check named unit. */
const ALIASES: Record<Exclude<GateName, "done">, readonly string[]> = {
  quick: ["quick"], test: ["test", "unit"], lint: ["lint"], security: ["security"], qa: ["qa"], design: ["design"],
};

export interface GateCommandOptions {
  jarvisHome?: string;
  /** Scratch space for the feedback run (~/.jarvis-work), outside the runner folder. */
  workRoot?: string;
  env?: Partial<Pick<NodeJS.ProcessEnv, "JARVIS_PROJECT">>;
  /** The working tree to judge, and the checkout whose derived project id is the default (decision 90). */
  cwd?: string;
  output?: (text: string) => void;
  exit?: (code: number) => void;
  verify?: (dir: string) => VerifyResult;
}

function render(name: string, results: readonly FeedbackResult[]): string {
  const lines = [`jarvis gate ${name}: feedback only (decision 49). Not evidence: the runner reruns its checks on the committed revision after the session.`];
  for (const r of results) {
    lines.push(`${r.check}: ${r.status}`, ...r.problems.map((p) => `  ${p}`));
    for (const c of r.cases) {
      lines.push(`  case ${c.id}: ${c.timedOut ? "timed out" : c.code === null ? "killed by a signal" : `exit ${c.code}`}`);
      for (const [label, text] of [["stdout", c.stdoutTail], ["stderr", c.stderrTail]] as const) if (text.trim() !== "") lines.push(`    ${label} (tail):`, ...text.trimEnd().split("\n").map((l) => `      ${l}`));
    }
    if (r.status === "fail" && r.cases.length > 0 && r.cases.every((c) => c.code === 0 && !c.timedOut)) lines.push("  The assertions did not pass; they aren't shown (decision 76).");
  }
  return lines.join("\n");
}

export function register(program: Command, seams: GateCommandOptions = {}): void {
  program.command("gate").description(`Run a protected check on the working tree as feedback only, never evidence (decision 49): ${GATES.join(", ")}. Exit: 0 pass, 1 fail, 2 tampered or error`)
    .argument("<name>", GATES.join("|")).option("--project <id>", "project id (default: JARVIS_PROJECT, then derived from this repo)").option("--json", "print JSON")
    .action(async (name: string, options: { project?: string; json?: boolean }) => {
      if (!GATES.some((g) => g === name)) throw new Error(`Unknown gate "${name}". Gates: ${GATES.join(", ")}`);
      const cwd = seams.cwd ?? process.cwd();
      const project = resolveProject({ ...(options.project !== undefined ? { option: options.project } : {}), env: seams.env ?? process.env, cwd });
      const jarvisHome = seams.jarvisHome ?? join(homedir(), ".jarvis");
      const dir = runnerProjectDir(project, jarvisHome);
      // Read-only: the chain is verified without a writer, and no ledger object exists here to append to.
      if (!existsSync(join(dir, "ledger.jsonl"))) throw new Error("No run ledger for this project");
      const verified = (seams.verify ?? verifyLedger)(dir);
      if (verified.contended) throw new Error("Ledger writers are active; try jarvis gate again shortly.");
      if (!verified.ok) throw new LedgerTamperError(`Cannot run a gate: ${verified.problems.join("; ")}`);
      const store = new ChecksStore(dir);
      const lock = store.verify({ entries: () => verified.entries });
      let results: FeedbackResult[];
      if (!lock.ok) results = [{ check: name, status: "tampered", problems: lock.problems, cases: [] }];
      else {
        const installed = readInstalledChecks(store);
        const wanted = name === "done" ? installed : [ALIASES[name as Exclude<GateName, "done">].map((alias) => installed.find((c) => c.name === alias)).find((c) => c !== undefined)].filter((c) => c !== undefined);
        if (wanted.length === 0) throw new Error(`No installed check for gate "${name}" (looked for ${ALIASES[name as Exclude<GateName, "done">].join(", ")}); installed: ${installed.map((c) => c.name).sort().join(", ")}`);
        const workTree = projectRoot(cwd);
        results = [];
        for (const check of wanted) results.push(await runFeedbackGate({ store, entries: verified.entries, jarvisHome, workRoot: seams.workRoot ?? join(homedir(), ".jarvis-work"), workTree, check }));
      }
      (seams.output ?? console.log)(options.json ? JSON.stringify({ feedbackOnly: true, gate: name, results }, null, 2) : render(name, results));
      const code = results.every((r) => r.status === "pass") ? 0 : results.some((r) => r.status === "tampered" || r.status === "error") ? 2 : 1;
      (seams.exit ?? ((c) => { process.exitCode = c; }))(code);
    });
}
