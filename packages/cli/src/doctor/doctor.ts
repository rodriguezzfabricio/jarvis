import { execFileSync } from "node:child_process";
import { existsSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import {
  CLAUDE_CODE_VERSION,
  CODEX_VERSION,
  DISK_FLOOR_BYTES,
  DISK_SINGLE_WRITER_BYTES,
  pinnedClaudeBin,
  pinnedCodexBin,
} from "../config/pins.ts";
import { buildChildEnv, findForbiddenEnv, runCanaryProbe, type ProbeOptions } from "../harness/claude/index.ts";
import { foundationChecks, type FoundationDeps } from "./foundation.ts";

/** jarvis doctor, first version (decision 46; tightened by 57–60, 63, 64). */

export type Level = "pass" | "warn" | "fail";
export interface DoctorCheck {
  name: string;
  level: Level;
  detail: string;
  /** On canary_probe: the probe hit a usage limit; retry after this Unix time. */
  waitUntil?: number;
}

export interface DoctorDeps {
  home?: string;
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  repoPath?: string;
  /** Returns stdout, or throws. */
  exec?: (bin: string, args: string[]) => string;
  exists?: (p: string) => boolean;
  freeBytes?: (p: string) => number;
  live?: boolean;
  probe?: (opts: ProbeOptions) => ReturnType<typeof runCanaryProbe>;
  /** Stage 1 foundation checks; omitted in unit tests of the stage 0 checks. */
  foundation?: FoundationDeps;
}

/** Binaries doctor runs get the allowlisted child environment, never this shell's (decision 58). */
const execWithEnv = (env: Record<string, string>) => (bin: string, args: string[]) =>
  execFileSync(bin, args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"], env });
const defaultFree = (p: string) => {
  const s = statfsSync(p);
  return Number(s.bavail) * Number(s.bsize);
};

const GB = 1024 ** 3;

/** Pinned Claude Code, by absolute path (decision 57). Shared with jarvis setup. */
export function checkClaudePinned(home: string, exec: (bin: string, args: string[]) => string = execWithEnv(buildChildEnv({ ...process.env, HOME: process.env.HOME ?? home })), exists: (p: string) => boolean = existsSync): DoctorCheck {
  const claude = pinnedClaudeBin(home);
  if (!exists(claude)) return { name: "claude_pinned", level: "fail", detail: `missing ${claude} (install with: claude install ${CLAUDE_CODE_VERSION})` };
  try {
    const v = exec(claude, ["--version"]).trim();
    return { name: "claude_pinned", level: v.startsWith(`${CLAUDE_CODE_VERSION} `) ? "pass" : "fail", detail: `${claude} reports "${v}"` };
  } catch (e) {
    return { name: "claude_pinned", level: "fail", detail: `could not run ${claude}: ${String(e)}` };
  }
}

export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorCheck[]> {
  const home = deps.home ?? homedir();
  const env = deps.env ?? process.env;
  const exec = deps.exec ?? execWithEnv(buildChildEnv({ ...env, HOME: env.HOME ?? home }));
  const exists = deps.exists ?? existsSync;
  const platform = deps.platform ?? process.platform;
  const checks: DoctorCheck[] = [];
  const add = (name: string, level: Level, detail: string) => checks.push({ name, level, detail });

  const claude = pinnedClaudeBin(home);
  checks.push(checkClaudePinned(home, exec, exists));

  // Pinned Codex for cross-model review; the Claude reviewer is the fallback (decision 66).
  const codex = pinnedCodexBin(home);
  if (!exists(codex)) add("codex_pinned", "warn", `missing ${codex}; reviews fall back to the strong Claude reviewer`);
  else {
    try {
      const v = exec(codex, ["--version"]).trim();
      add("codex_pinned", v.includes(CODEX_VERSION) ? "pass" : "warn", `${codex} reports "${v}", pinned ${CODEX_VERSION}`);
    } catch (e) {
      add("codex_pinned", "warn", `could not run ${codex}: ${String(e)}`);
    }
  }

  // Clean environment (decision 58).
  const childForbidden = findForbiddenEnv(buildChildEnv({ ...env, HOME: env.HOME ?? home }));
  add("child_env_clean", childForbidden.length === 0 ? "pass" : "fail", childForbidden.length ? `would leak: ${childForbidden.join(", ")}` : "task sessions get an allowlisted environment");
  const parentForbidden = findForbiddenEnv(env);
  if (parentForbidden.length) add("parent_env", "warn", `present in this shell (kept out of task sessions): ${parentForbidden.join(", ")}`);

  // Disk floor (decision 63).
  try {
    const free = (deps.freeBytes ?? defaultFree)(home);
    const level: Level = free < DISK_FLOOR_BYTES ? "fail" : free < DISK_SINGLE_WRITER_BYTES ? "warn" : "pass";
    const note = level === "fail" ? "below the 20 GB floor: no unattended runs" : level === "warn" ? "below 40 GB: one writing task at a time" : "ok";
    add("disk_free", level, `${(free / GB).toFixed(1)} GB free; ${note}`);
  } catch (e) {
    add("disk_free", "fail", `could not read free space: ${String(e)}`);
  }

  // iCloud Desktop & Documents sync (decision 64).
  if (platform === "darwin") {
    const repo = deps.repoPath ?? process.cwd();
    const synced = repo.startsWith(`${home}/Desktop`) || repo.startsWith(`${home}/Documents`);
    let flag = "0";
    try {
      flag = exec("/usr/bin/defaults", ["read", "com.apple.finder", "FXICloudDriveDesktop"]).trim();
    } catch {
      flag = "0"; // key absent means sync was never turned on
    }
    if (flag === "1" && synced) add("icloud_sync", "fail", `iCloud Desktop & Documents sync is on and ${repo} is inside it`);
    else add("icloud_sync", "pass", flag === "1" ? "sync is on, but the repo is outside synced folders" : "Desktop & Documents sync is off");
  }

  if (deps.foundation) for (const c of await foundationChecks(deps.foundation)) checks.push(c);

  // Live canary probe (decision 59): permanent; required before unattended runs.
  if (deps.live) {
    const probe = deps.probe ?? runCanaryProbe;
    const r = await probe({ claudeBin: claude, parentEnv: env, home });
    for (const c of r.checks) add(`probe.${c.name}`, c.ok ? "pass" : "fail", c.detail);
    add("canary_probe", r.ok ? "pass" : "fail", r.ok ? "the generated settings took effect and held" : r.usageWaitUntil ? "the probe hit a usage limit; retry after the reset" : "the live probe failed: no unattended runs");
    if (r.usageWaitUntil !== undefined) (checks.at(-1) as DoctorCheck).waitUntil = r.usageWaitUntil;
  } else {
    add("canary_probe", "warn", "not run (use --live; required before any unattended run)");
  }

  return checks;
}

export function doctorExitCode(checks: readonly DoctorCheck[]): number {
  return checks.some((c) => c.level === "fail") ? 1 : 0;
}

/** Unattended runs need a clean doctor including a passing live probe. */
export function allowsUnattended(checks: readonly DoctorCheck[]): boolean {
  return doctorExitCode(checks) === 0 && checks.some((c) => c.name === "canary_probe" && c.level === "pass");
}
