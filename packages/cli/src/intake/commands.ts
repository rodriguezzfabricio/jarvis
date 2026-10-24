/** Intake runs in the user's interactive Claude Code session (architecture §3.3, decision 86),
 * outside sandboxed build task sessions. These commands may access the runner-owned home;
 * no IPC bridge is needed. */
import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { Ledger } from "../ledger/ledger.ts";
import { projectRoot, resolveProject } from "../config/project.ts";
import { Broker } from "../broker/broker.ts";
import type { Clock } from "../notify/intake.ts";
import type { Notifier } from "../notify/notifier.ts";
import { NtfyNotifier, type NtfyOptions } from "../notify/ntfy.ts";
import { answerRound, getRoundAnswers, readReplyCursor, sendRound, type IntakeDeps } from "./round.ts";
import { saveTaste } from "./taste.ts";

export interface CommandDeps {
  home?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  print?: (text: string) => void;
  warn?: (text: string) => void;
  clock?: Clock;
  createNotifier?: (config: NtfyOptions) => Notifier;
  setExitCode?: (code: number) => void;
}
/** ~/.jarvis/notify.json, as jarvis setup writes it. */
export const notifyConfigSchema = z.object({ baseUrl: z.string().url(), topic: z.string().min(1), replyTopic: z.string().min(1),
  since: z.string().optional(), timeoutMs: z.number().int().positive().optional() }).strict();
// A broken notifier config never blocks a round (decision 90): the round is recorded and answered in the session.
function loadNotifier(home: string, factory: (config: NtfyOptions) => Notifier, ledger: Ledger, now: number, warn: (text: string) => void): Notifier | undefined {
  const off = () => { warn("Invalid notifier configuration; notifications are off for this round"); return undefined; };
  let raw: string;
  try { raw = readFileSync(join(home, ".jarvis", "notify.json"), "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    return off();
  }
  try {
    const config = notifyConfigSchema.parse(JSON.parse(raw));
    const rounds = ledger.entries().filter((e) => e.kind === "notify" && (e.data as { source?: string }).source === "intake");
    const sent = rounds.map((e) => (e.data as { sentAt?: number }).sentAt).filter((time): time is number => typeof time === "number");
    const since = readReplyCursor(ledger) ?? config.since ?? String(Math.floor(Math.min(now, ...sent) / 1000));
    return factory({ baseUrl: config.baseUrl, topic: config.topic, replyTopic: config.replyTopic,
      since, ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}) });
  } catch { return off(); }
}
function integer(value: string, name: string, min = 0): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < min) throw new Error(`Invalid ${name}`);
  return n;
}
interface ProjectOptions { project?: string; projectDir?: string; timeout?: string }
function projectDeps(options: ProjectOptions, deps: CommandDeps, notify = false): IntakeDeps {
  const home = deps.home ?? homedir();
  const cwd = resolve(deps.cwd ?? process.cwd(), options.projectDir ?? ".");
  const project = resolveProject({ ...(options.project !== undefined ? { option: options.project } : {}), env: deps.env ?? process.env, cwd });
  const repoDir = projectRoot(cwd);
  const timeoutMs = integer(options.timeout ?? "900", "timeout") * 1000;
  if (!Number.isSafeInteger(timeoutMs)) throw new Error("Invalid timeout");
  const ledger = Ledger.open(join(home, ".jarvis", "projects", project));
  const notifier = notify ? loadNotifier(home, deps.createNotifier ?? ((config) => new NtfyNotifier(config)), ledger, deps.clock?.now() ?? Date.now(), deps.warn ?? console.error) : undefined;
  return { ledger, repoDir, broker: new Broker({ ledger, project, adapters: [], secrets: { get: () => undefined } }),
    timeoutMs, ...(deps.clock ? { clock: deps.clock } : {}), ...(notifier ? { notifier } : {}) };
}
function projectOptions(command: Command): Command {
  return command.option("--project <id>", "runner project id (or JARVIS_PROJECT)")
    .option("--project-dir <path>", "project checkout directory", ".");
}

/** Register once before program.parseAsync(). Dependencies keep CLI tests offline and isolated. */
export function register(program: Command, deps: CommandDeps = {}): void {
  const print = deps.print ?? console.log;
  const intake = program.command("intake").description("Send intake rounds and record or read their answers");
  projectOptions(intake.command("send").argument("<file>"))
    .option("--timeout <seconds>", "intake deadline in seconds", "900")
    .action(async (file: string, options: ProjectOptions) => {
      const context = projectDeps(options, deps, true);
      const result = await sendRound(resolve(context.repoDir, file), context);
      print(result.state === "closed" ? `Intake round ${result.round} already closed (${result.status}).`
        : result.deliveryFailed ? `Intake round ${result.round} recorded; notification not delivered; answer in the session`
        : result.delivered ? `Intake round ${result.round} sent.` : `Intake round ${result.round} recorded; answers must be typed in the session.`);
    });
  projectOptions(intake.command("answer").description("Submit a complete response; omitted questions accept their defaults").argument("<round>").argument("<file>"))
    .action((n: string, file: string, options: ProjectOptions) => {
      const result = answerRound(integer(n, "round", 1), file, projectDeps(options, deps));
      if (!result.counted) {
        print(`Not counted: round ${result.round} already closed (${result.status}, by ${result.by})`);
        (deps.setExitCode ?? ((code) => { process.exitCode = code; }))(1);
      } else print(JSON.stringify(result));
    });
  projectOptions(intake.command("answers").argument("<round>"))
    .option("--wait <seconds>", "wait up to this many seconds, checking phone replies and the ledger", "0")
    .action(async (n: string, options: ProjectOptions & { wait: string }) => {
      const waitMs = integer(options.wait, "wait") * 1000;
      print(JSON.stringify(await getRoundAnswers(integer(n, "round", 1), projectDeps(options, deps, waitMs > 0), { waitMs })));
    });
  program.command("taste").description("Global design preferences").command("save").argument("<file>")
    .action((file: string) => {
      const target = saveTaste(resolve(projectRoot(deps.cwd ?? process.cwd()), file), { home: deps.home ?? homedir() });
      print(`Taste profile saved to ${target}.`);
    });
}
