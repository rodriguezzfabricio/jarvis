import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { ChecksStore } from "../checks/store.ts";
import { projectRoot, resolveProject } from "../config/project.ts";
import { allowsUnattended, runDoctor } from "../doctor/doctor.ts";
import { safeGit } from "../eval/git.ts";
import { createClaudeReviewer } from "../harness/claude/review.ts";
import { Ledger } from "../ledger/ledger.ts";
import type { Reviewer, ReviewerInput } from "../review/types.ts";
import { installChecks, readAuthoredChecks } from "../runner/checks-author.ts";
import { runnerProjectDir } from "../runner/inbox.ts";
import { DEFAULT_ROUTING } from "../runner/routing.ts";
import { approvedSpec, runBranchOf } from "./run-compose.ts";
import type { RunContext } from "./run.ts";

export interface ChecksCommandOptions {
  home?: string;
  reviewer?: Reviewer;
  git?: typeof safeGit;
}

function contextFor(repo: string | undefined, home: string): RunContext {
  const cwd = resolve(repo ?? process.cwd());
  const projectId = resolveProject({ env: process.env, cwd });
  const jarvisHome = join(home, ".jarvis");
  return { projectId, projectDir: runnerProjectDir(projectId, jarvisHome), jarvisHome, repoPath: projectRoot(cwd) };
}

function below(path: string, root: string): boolean { return path.startsWith(`${root}/`); }

/** The prompt already contains the captured bundle and its approved baseline; no repo files are needed. */
function reviewVerdict(context: RunContext, home: string, injected?: Reviewer): (prompt: string) => Promise<unknown> {
  const workRoot = join(home, ".jarvis-work"), cacheRoot = join(workRoot, "caches", context.projectId);
  for (const dir of [workRoot, cacheRoot]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const evidenceRoot = join(context.projectDir, "evidence");
  mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
  if (!below(realpathSync(evidenceRoot), realpathSync(context.projectDir))) throw new Error("review evidence root escapes runner-owned data");
  const reviewer = injected ?? createClaudeReviewer({
    jarvisHome: context.jarvisHome, home, workRoot, cacheRoot,
    preflight: async () => ({ ok: allowsUnattended(await runDoctor({ home, repoPath: context.repoPath, live: true })) }),
  });
  return async (prompt) => {
    const workspace = mkdtempSync(join(workRoot, "checks-review-"));
    try {
      const outputDir = mkdtempSync(join(evidenceRoot, "checks-review-"));
      const input: ReviewerInput = { workspace, outputDir, prompt, ...DEFAULT_ROUTING.tiers.strong, maxTurns: 20, timeoutMs: 600000 };
      const result = await reviewer(input);
      writeFileSync(join(outputDir, "raw.json"), JSON.stringify(result), { flag: "wx", mode: 0o600 });
      if (result.error !== undefined || result.fallbackReason !== undefined || result.failureKind !== undefined) {
        throw new Error(`protected checks reviewer failed: ${result.error ?? result.fallbackReason ?? result.failureKind}`);
      }
      // installChecks applies its own strict Verdict schema, including every required change justification.
      return JSON.parse(result.rawVerdict) as unknown;
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  };
}

async function install(repo: string | undefined, deps: ChecksCommandOptions): Promise<void> {
  const home = deps.home ?? homedir(), context = contextFor(repo, home);
  const runGit = deps.git ?? safeGit;
  const git = (args: readonly string[]) => runGit(context.repoPath, args, { home }).toString().trim();
  const spec = approvedSpec(git, runBranchOf(git));
  if (!spec) throw new Error("checks install needs an approved spec (docs/spec/vN.md) on the run branch");
  const authored = readAuthoredChecks(context.repoPath);
  const ledger = Ledger.open(context.projectDir), store = new ChecksStore(context.projectDir);
  const installed = await installChecks(store, authored, ledger, { spec: spec.spec, reviewVerdict: reviewVerdict(context, home, deps.reviewer) });
  console.log(`Checks lock ${installed.lockHash}; installed: ${installed.checks.map((check) => check.name).join(", ")}`);
}

export function register(program: Command, deps: ChecksCommandOptions = {}): void {
  program.command("checks").description("Review and install protected acceptance checks")
    .command("install").description("Install .jarvis/checks proposals after a fresh read-only review")
    .option("--repo <dir>", "project repository (default: current directory)")
    .action(async (options: { repo?: string }) => {
      try { await install(options.repo, deps); }
      catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
    });
}
