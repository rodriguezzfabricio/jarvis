import type { Command } from "commander";
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProject } from "../config/project.ts";
import { runnerProjectDir } from "../runner/inbox.ts";

/** Teach-me mode (decision 32): explain adds short "why" notes; quiet is the default. */
export const MODES = ["explain", "quiet"] as const;
export type Mode = (typeof MODES)[number];
const FILE = "mode.json";

/** The project's mode. Anything but a regular file holding a known mode reads as quiet. */
export function readMode(projectDir: string): Mode {
  let fd: number;
  try { fd = openSync(join(projectDir, FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return "quiet"; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 1024) return "quiet";
    const mode = (JSON.parse(readFileSync(fd, "utf8")) as { mode?: unknown } | null)?.mode;
    return MODES.find((m) => m === mode) ?? "quiet";
  } catch { return "quiet"; } finally { closeSync(fd); }
}

/** Temp file, fsync, rename: the runner folder only ever holds a complete, owner-only mode file. */
export function writeMode(projectDir: string, mode: Mode): string {
  if (!MODES.includes(mode)) throw new Error(`Unknown mode "${String(mode)}". Modes: ${MODES.join(", ")}`);
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  const path = join(projectDir, FILE);
  const temp = join(projectDir, `.${FILE}.${randomBytes(8).toString("hex")}`);
  try {
    writeFileSync(temp, `${JSON.stringify({ mode })}\n`, { flag: "wx", mode: 0o600 });
    const fd = openSync(temp, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
  return path;
}

export interface ModeCommandOptions {
  jarvisHome?: string;
  env?: Partial<Pick<NodeJS.ProcessEnv, "JARVIS_PROJECT">>;
  /** The checkout whose derived project id is used without --project or JARVIS_PROJECT (decision 90). */
  cwd?: string;
  output?: (text: string) => void;
}

export function register(program: Command, seams: ModeCommandOptions = {}): void {
  program.command("mode").description("Teach-me mode: explain adds short \"why I did this\" notes, quiet turns them off; no argument prints the mode")
    .argument("[mode]", MODES.join("|")).option("--project <id>", "project id (default: JARVIS_PROJECT, then derived from this repo)")
    .action((mode: string | undefined, options: { project?: string }) => {
      if (mode !== undefined && !MODES.some((m) => m === mode)) throw new Error(`Unknown mode "${mode}". Modes: ${MODES.join(", ")}`);
      const project = resolveProject({ ...(options.project !== undefined ? { option: options.project } : {}), env: seams.env ?? process.env, cwd: seams.cwd ?? process.cwd() });
      const dir = runnerProjectDir(project, seams.jarvisHome);
      const out = seams.output ?? console.log;
      if (mode === undefined) { out(`Mode: ${readMode(dir)}`); return; }
      writeMode(dir, mode as Mode);
      out(`Mode set to ${mode}${mode === "explain" ? ": sessions add short \"why\" notes" : ""}.`);
    });
}
